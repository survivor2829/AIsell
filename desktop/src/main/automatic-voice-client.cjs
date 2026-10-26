const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { contained, fail } = require('./digital-human-provider.cjs');
const { sha256, uploadReferenceMedia } = require('./reference-human-media.cjs');
const { ttsAudioUrl } = require('./bailian-video-provider.cjs');
const policy = require('../shared/reference-human.json').automaticVoice;

// One enrollment journal per managed person, independent of how many scripts
// they produce. The UI never supplies or selects the provider's voice ID.
function createAutomaticVoiceClient({ provider, rootDir, uploadSample = (source, hash) => uploadReferenceMedia(provider, source, hash, policy.enrollmentModel) }) {
  const active = new Map();
  async function awaitReady(record, file) {
    if (record.voice.usable) return record.voice;
    for (let attempt = 0; attempt < 10; attempt++) {
      let result;
      try { result = await provider.request(policy.enrollRoute, { method: 'POST', body: {
        model: policy.enrollmentModel, input: { action: 'query_voice', voice_id: record.voice.voiceId } } }); }
      catch { throw fail('reference_voice_status_unknown', '本人声音已登记，但审核状态暂未查到，请查询原任务；不会重新建立或购买配音。', { outcomeUnknown: true }); }
      const state = result.output;
      if (state?.target_model !== policy.model) throw fail('reference_voice_model_unknown', '本人声音的配音模型尚未核对，未购买配音。', { outcomeUnknown: true });
      record.voice.status = state.status;
      record.voice.usable = state.status === 'OK';
      writeJsonAtomic(file, record);
      if (record.voice.usable) return record.voice;
      if (state.status === 'UNDEPLOYED') throw fail('reference_voice_rejected', '本人声音审核未通过，请换一段清晰自然的本人视频；原记录已保留，没有购买配音。');
      if (state.status !== 'DEPLOYING') break;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw fail('reference_voice_pending', '本人声音仍在审核，请稍后查询原任务；不会重复建立声音或购买配音。', { outcomeUnknown: true });
  }
  async function enroll(input) {
    if (!/^rha_[a-f0-9-]{36}$/u.test(input.assetId)) throw fail('reference_not_found', '请重新选择本人视频。');
    if (active.has(input.assetId)) return active.get(input.assetId);
    const job = ensure(input).finally(() => active.delete(input.assetId));
    active.set(input.assetId, job); return job;
  }
  async function ensure({ assetId, audioFile, audioSha256, operationId }) {
    const file = contained(rootDir, `${assetId}-${policy.model}.json`), bytes = fs.readFileSync(audioFile);
    if (sha256(bytes) !== audioSha256 || bytes.length > 10 * 1024 * 1024) throw fail('reference_audio_changed', '本人声音样本无法核对，请重新导入；没有创建新声音。');
    let record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (record && (record.audioSha256 !== audioSha256 || record.model !== policy.model)) throw fail('reference_voice_changed', '本人声音记录与样本不一致，原声音已保留。');
    if (record?.voice) return awaitReady(record, file);
    let response;
    if (record && !record.rejected) {
      try { response = await provider.request(`/operations/${record.operationId}`); }
      catch (error) {
        if (error.originalRequestRejected) { record.rejected = true; writeJsonAtomic(file, record); }
        else error.outcomeUnknown = true;
        throw error;
      }
      if (!response || response.status === 'pending') throw fail('reference_submission_unknown', '正在核对原声音建立请求，不会重复创建。', { outcomeUnknown: true });
    } else {
      if (record?.operationId === operationId) throw fail('reference_voice_rejected', '原声音建立请求已被拒绝，请处理原因后重新确认制作。');
      let sample;
      try { sample = await uploadSample(audioFile, audioSha256); }
      catch { throw fail('reference_sample_upload_failed', '声音样本暂未上传，请继续当前步骤；没有创建声音或购买配音。', { retrySafe: true }); }
      if (!/^oss:\/\/dashscope-instant\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(sample?.url || '') || !Number.isFinite(Date.parse(sample.expiresAt)) || Date.parse(sample.expiresAt) < Date.now() + 60000) throw fail('reference_sample_unavailable', '声音样本临时地址不可用，没有创建声音。', { retrySafe: true });
      record = { assetId, audioSha256, model: policy.model, operationId, submittedAt: new Date().toISOString() };
      writeJsonAtomic(file, record);
      try {
        response = await provider.request(policy.enrollRoute, { method: 'POST', operationId, headers: { 'X-DashScope-OssResourceResolve': 'enable' },
          body: { model: policy.enrollmentModel, input: { action: 'create_voice', target_model: policy.model,
            prefix: 'myvoice', url: sample.url, language_hints: ['zh'] } } });
      } catch (error) { if (!error.outcomeUnknown) { record.rejected = true; writeJsonAtomic(file, record); } throw error; }
    }
    const voiceId = response.output?.voice_id;
    if (typeof voiceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,255}$/u.test(voiceId)) throw fail('reference_voice_response_unknown', '声音建立结果尚未核对完整，请查询原请求；不会重复创建。', { outcomeUnknown: true });
    record.voice = { provider: 'bailian', voiceId, model: policy.model, usable: false, createdAt: new Date().toISOString() };
    writeJsonAtomic(file, record); return awaitReady(record, file);
  }
  function synthesize({ voice, text, operationId, delivery }) {
    if (!voice?.usable || voice.model !== policy.model || !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,255}$/u.test(voice.voiceId || '')) throw fail('reference_voice_invalid', '本人声音记录不可用，请重新选择人物。');
    return provider.request(policy.ttsRoute, { method: 'POST', operationId, headers: { 'X-DashScope-SSE': 'enable' },
      body: { model: voice.model, input: { text, voice: voice.voiceId, format: 'wav', sample_rate: delivery?.sampleRate || 24000,
        ...(delivery?.instruction ? { instruction: delivery.instruction } : {}),
        ...(delivery ? { rate: delivery.rate, pitch: delivery.pitch } : {}) } } });
  }
  async function materialize(response, destination) {
    if (response.output?.finish_reason !== 'stop') throw fail('reference_audio_incomplete', '本人配音尚未完整结束，请查询原任务；未购买人物视频。');
    const encoded = response.output?.audio?.data;
    if (encoded) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 || Buffer.byteLength(encoded, 'base64') > 8 * 1024 * 1024) throw fail('reference_audio_invalid', '完整配音数据无法校验，原回执已保留。');
      fs.writeFileSync(destination, Buffer.from(encoded, 'base64'));
    } else await provider.download(ttsAudioUrl(response), destination, { maxBytes: 20 * 1024 * 1024 });
    return { file: destination, audio_digest: sha256(fs.readFileSync(destination)) };
  }
  return { enroll, synthesize, materialize };
}
module.exports = { createAutomaticVoiceClient };
