const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fail } = require('./digital-human-provider.cjs');
const run = promisify(execFile);
const SPEAKER = /^S_[A-Za-z0-9_-]{1,128}$/u;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function normalizeVoice(value = {}) {
  return {
    speakerId: value.speaker_id, name: '我的专属声音', status: value.status,
    usable: [2, 4].includes(value.status),
    trainable: value.trainable === true, slotType: value.billing,
    operationId: value.operation_id || '', availableTrainingTimes: value.available_training_times,
    demoUrl: value.speaker_status?.find((item) => item.model_type === 5)?.demo_audio || '',
  };
}

function createVoiceCloneClient({ gatewayClient, rootDir, ffmpegPath, execFileImpl = run }) {
  const base = path.resolve(rootDir);
  async function request(route, payload, operationId) {
    const response = await gatewayClient.fetch(gatewayClient.url(route), {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(operationId ? { 'X-Xiaoxi-Operation-Id': operationId } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), timeoutMs: 180_000, maxBytes: 4 * 1024 * 1024,
    });
    const text = await response.text();
    if (route.startsWith('/operations/') && response.status === 202) throw fail('voice_clone_operation_pending', '原声音任务仍在处理中，请继续查询。', { outcomeUnknown: true });
    if (!response.ok) {
      let code = 'voice_clone_provider_unavailable';
      try { code = JSON.parse(text).error || code; } catch {}
      throw fail(code, '专属声音请求未完成，请保留原任务并查询状态。', { outcomeUnknown: response.status >= 500 || response.status === 409 });
    }
    return { text, status: response.status };
  }
  async function jsonRequest(action, payload) {
    const response = await request(`/volcengine/voice-clone/${action}`, payload);
    return JSON.parse(response.text);
  }
  async function list() {
    const result = await jsonRequest('list', {});
    return { items: (result.items || []).map(normalizeVoice), inventoryConfigured: result.inventory_configured === true, reason: result.reason || '' };
  }
  async function capabilities() {
    await gatewayClient.initialize();
    const enabled = gatewayClient.status().capabilities?.volcengine_voice_clone === true;
    if (!enabled) return { enabled: false, inventoryConfigured: false, reason: '专属音色服务未连接。' };
    const inventory = await list();
    return { enabled: true, inventoryConfigured: inventory.inventoryConfigured, reason: inventory.reason, trainableSlots: inventory.items.filter((item) => item.trainable).length };
  }
  async function status({ speakerId }) {
    if (!SPEAKER.test(speakerId)) throw fail('voice_clone_speaker_invalid', '请选择已有专属声音槽位。');
    return normalizeVoice(await jsonRequest('status', { speaker_id: speakerId }));
  }
  async function operation(action, speakerId, payload, operationId) {
    if (!SPEAKER.test(speakerId) || !OPERATION.test(operationId)) throw fail('voice_clone_operation_invalid', '专属声音任务信息无效。');
    await fs.mkdir(base, { recursive: true });
    const file = path.join(base, `${action}-${digest(operationId)}.json`);
    const fingerprint = digest(JSON.stringify([action, speakerId, payload]));
    let receipt;
    try { receipt = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw fail('voice_clone_operation_conflict', '此任务已绑定另一份文案或录音，请创建独立任务。');
      if (receipt.result) return receipt.result;
      // A prior submission, even without a reply, is queried instead of retrained.
      const recovered = await request(`/operations/${operationId}`);
      receipt.result = recovered;
    } else {
      receipt = { operationId, speakerId, action, fingerprint, submittedAt: new Date().toISOString() };
      await fs.writeFile(file, JSON.stringify(receipt), { flag: 'wx' });
      try { receipt.result = await request(`/volcengine/voice-clone/${action}`, payload, operationId); }
      catch (error) {
        error.operationId = operationId;
        error.outcomeUnknown = error.outcomeUnknown !== false;
        receipt.errorCode = error.code || 'voice_clone_outcome_unknown';
        await fs.writeFile(file, JSON.stringify(receipt));
        throw error;
      }
    }
    await fs.writeFile(file, JSON.stringify(receipt));
    return receipt.result;
  }
  async function train({ speakerId, audioFile, customerConsent, operationId }) {
    if (customerConsent !== true) throw fail('voice_clone_consent_required', '请确认录音来自本人或已获授权。');
    // One existing slot is trained at most once. A second click recovers its
    // first operation even if the renderer was restarted and lost the ID.
    if (!operationId) {
      let files = [];
      try { files = await fs.readdir(base); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const file of files.filter((name) => /^train-[a-f0-9]{64}\.json$/u.test(name))) {
        const prior = JSON.parse(await fs.readFile(path.join(base, file), 'utf8'));
        if (prior.action === 'train' && prior.speakerId === speakerId) { operationId = prior.operationId; break; }
      }
      operationId ||= crypto.randomUUID();
    }
    if (!['.wav', '.mp3', '.m4a'].includes(path.extname(audioFile || '').toLowerCase())) throw fail('voice_clone_audio_format', '请上传WAV、MP3或M4A录音。');
    const info = await fs.stat(audioFile);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw fail('voice_clone_audio_size', '声音样本需为不超过10MB的录音文件。');
    const { stdout, stderr } = await execFileImpl(ffmpegPath, ['-hide_banner', '-nostdin', '-i', audioFile, '-map', '0:a:0', '-vn', '-af', 'volumedetect', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { windowsHide: true, encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 60_000 });
    const wav = Buffer.from(stdout);
    const diagnostic = Buffer.from(stderr).toString('utf8');
    // ffmpeg pipe WAV uses unknown sizes: finalize a canonical PCM WAV header.
    let data = -1;
    for (let cursor = 12; cursor + 8 <= wav.length;) {
      if (wav.toString('ascii', cursor, cursor + 4) === 'data') { data = cursor; break; }
      const size = wav.readUInt32LE(cursor + 4);
      cursor += 8 + size + (size % 2);
    }
    if (data < 0) throw fail('voice_clone_sample_invalid', '录音无法解码。');
    const seconds = (wav.length - data - 8) / 48000;
    if (seconds < 14 || seconds > 30) throw fail('voice_clone_sample_duration', '请选择14—30秒清晰的单人录音；系统不会自动截取。');
    if (/max_volume:\s*-inf\s*dB/u.test(diagnostic) || wav.subarray(data + 8).every((byte) => byte === 0)) throw fail('voice_clone_sample_silent', '录音没有可用声音，请更换样本。');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.writeUInt32LE(wav.length - data - 8, data + 4);
    const inventory = await list();
    const slot = inventory.items.find((item) => item.speakerId === speakerId);
    if (!slot) throw fail('voice_clone_slot_not_owned', '此专属声音不属于当前客户。');
    if (!slot?.trainable) {
      // Recover an earlier training operation when the caller supplies its ID.
      const prior = path.join(base, `train-${digest(operationId)}.json`);
      try { await fs.access(prior); } catch { throw fail('voice_clone_slot_unavailable', '没有已核实且未使用的免费或已购槽位，请先核对槽位。'); }
    }
    const result = await operation('train', speakerId, { speaker_id: speakerId, audio: { data: wav.toString('base64'), format: 'wav' }, consent: true }, operationId);
    return { ...normalizeVoice(JSON.parse(result.text)), operationId };
  }
  async function synthesize({ speakerId, text, operationId }) {
    const voice = await status({ speakerId });
    if (!voice.usable) throw fail('voice_clone_not_ready', '此专属声音尚未就绪或不属于当前客户。');
    const result = await operation('synthesize', speakerId, { speaker_id: speakerId, text }, operationId);
    const chunks = [];
    let finished = false;
    for (const line of result.text.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      const item = JSON.parse(raw);
      if (item.code === 0) {
        if (item.data !== undefined && item.data !== null && item.data !== '') {
          if (typeof item.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.data)) throw fail('voice_clone_audio_invalid', '专属声音返回无效音频。');
          chunks.push(Buffer.from(item.data, 'base64'));
        }
      } else if (item.code === 20000000) finished = true;
      else throw fail('voice_clone_synthesis_failed', '专属声音合成未完成，请查询原任务。');
    }
    const audio = Buffer.concat(chunks);
    if (!finished || !audio.length) throw fail('voice_clone_audio_incomplete', '专属声音音轨不完整，未提交数字人视频。');
    const file = path.join(base, `${digest(operationId)}.mp3`);
    await fs.writeFile(file, audio);
    await execFileImpl(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'null', '-'], { windowsHide: true, timeout: 60_000 });
    return { file, audio_digest: digest(audio), voice_persona_id: speakerId, voice_name: '我的专属声音', resource_id: 'seed-icl-2.0', operationId };
  }
  return { capabilities, list, train, status, synthesize };
}

module.exports = { createVoiceCloneClient, normalizeVoice };
