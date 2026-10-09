const { createDigitalHumanProvider, remoteUrl, fail, cleanMessage, SAFE_ID } = require('./digital-human-provider.cjs');

// Official Beijing protocol. Prices are supplied by the task's pricing snapshot,
// not inferred from a successful request or usage.video_duration.
const MODEL = 'wan2.6-i2v-flash';
const TTS_MODEL = 'qwen3-tts-flash';
const ASYNC_HEADERS = Object.freeze({ 'X-DashScope-Async': 'enable' });
const ROUTES = Object.freeze({
  video: '/bailian/api/v1/services/aigc/video-generation/video-synthesis',
  tts: '/bailian/api/v1/services/aigc/multimodal-generation/generation',
  task(id) {
    if (!SAFE_ID.test(String(id || ''))) throw fail('bailian_task_id_invalid', '云端任务编号无效。');
    return `/bailian/api/v1/tasks/${id}`;
  },
});

function mediaReference(value, { image = false } = {}) {
  const input = String(value || '').trim();
  if (image && input.startsWith('data:')) {
    const match = /^data:image\/(?:jpeg|jpg|png|bmp|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(input);
    if (!match || match[1].length % 4 !== 0 || Buffer.byteLength(match[1], 'base64') > 20 * 1024 * 1024) {
      throw fail('bailian_image_invalid', '首帧必须是完整的图片数据，且不超过20MB。');
    }
    return input;
  }
  if (/^oss:\/\/dashscope-instant\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(input)) return input;
  return remoteUrl(input);
}

function videoPayload({ imageUrl, audioUrl, prompt, seconds, durationSeconds, resolution = '720P', audio = true, negativePrompt } = {}) {
  const duration = seconds ?? durationSeconds;
  const quality = String(resolution).toUpperCase();
  if (!Number.isInteger(duration) || duration < 2 || duration > 15) throw fail('bailian_duration_invalid', '单个视频镜头必须为2至15秒的整数时长。');
  if (!['720P', '1080P'].includes(quality)) throw fail('bailian_resolution_invalid', '当前万相路线仅支持720P或1080P。');
  if (typeof audio !== 'boolean') throw fail('bailian_audio_invalid', '请明确指定视频是否带声音，以便核对费用。');
  if (audioUrl && !audio) throw fail('bailian_audio_conflict', '音频驱动必须启用有声视频，不能按无声视频提交。');
  const text = String(prompt || '').trim();
  if (!text || [...text].length > 1500) throw fail('bailian_prompt_invalid', '视频提示词须为1至1500字，不能截断导演要求。');
  const negative = String(negativePrompt || '').trim();
  if ([...negative].length > 500) throw fail('bailian_negative_prompt_invalid', '视频负面约束不能超过500字。');
  return {
    model: MODEL,
    input: { img_url: mediaReference(imageUrl, { image: true }), prompt: text,
      ...(audioUrl ? { audio_url: mediaReference(audioUrl) } : {}),
      ...(negative ? { negative_prompt: negative } : {}) },
    // shot_type only takes effect when prompt_extend is true. Keep extension
    // disabled and express the continuous single shot in the actual prompt.
    parameters: { resolution: quality, duration, audio, prompt_extend: false },
  };
}

function videoRequest(input) {
  const body = videoPayload(input);
  const temporary = [body.input.img_url, body.input.audio_url].some((value) => value?.startsWith('oss://'));
  return { route: ROUTES.video, body, headers: { ...ASYNC_HEADERS,
    ...(temporary ? { 'X-DashScope-OssResourceResolve': 'enable' } : {}) } };
}
function pollRequest(id) { return { route: ROUTES.task(id) }; }
function nodeOf(payload) { return payload?.output && typeof payload.output === 'object' ? payload.output : {}; }
function taskIdOf(payload) {
  const id = nodeOf(payload).task_id;
  if (!SAFE_ID.test(String(id || ''))) throw fail('bailian_submission_unknown', '请求已发出，但没有收到有效任务编号；已保留回执，请核对原请求。', { outcomeUnknown: true });
  return id;
}
function statusOf(payload) {
  return ({ PENDING: 'pending', RUNNING: 'running', SUCCEEDED: 'completed', FAILED: 'failed', CANCELED: 'failed' })[nodeOf(payload).task_status] || 'unknown';
}
function resultVideoUrl(payload) { return remoteUrl(nodeOf(payload).video_url); }
function normalizePoll(payload) {
  const status = statusOf(payload), node = nodeOf(payload);
  return { status, videoUrl: status === 'completed' ? resultVideoUrl(payload) : '',
    error: status === 'failed' ? cleanMessage(node.message || node.code || payload?.message || '视频生成未完成。') : '' };
}

function ttsPayload({ text, voice = 'Cherry' } = {}) {
  const script = String(text || '').trim();
  if (!script || [...script].length > 600) throw fail('bailian_tts_text_invalid', '单段配音文案须为1至600字，不能截断口播。');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(String(voice))) throw fail('bailian_tts_voice_invalid', '配音音色无效。');
  return { model: TTS_MODEL, input: { text: script, voice, language_type: 'Chinese' } };
}
function ttsAudioUrl(payload) {
  const source = String(nodeOf(payload).audio?.url || '');
  let url;
  try { url = new URL(source); } catch { throw fail('bailian_tts_audio_invalid', '配音服务未返回完整音轨地址。'); }
  // Same narrow compatibility rule as content_engine.creative_analysis:
  // official TTS examples return HTTP for an HTTPS-capable signed OSS object.
  if (url.protocol === 'http:' && !url.port && /^dashscope-result-[a-z0-9-]+\.oss-cn-[a-z0-9-]+\.aliyuncs\.com$/u.test(url.hostname)) url.protocol = 'https:';
  return remoteUrl(url.href);
}

function createBailianVideoProvider(options = {}) {
  const shared = createDigitalHumanProvider(options);
  async function capabilities() {
    if (!options.gatewayClient?.isEnabled?.()) return { ready: false, code: 'bailian_gateway_unavailable', message: '阿里官方视频服务未连接，可以先保存草稿。' };
    const state = await options.gatewayClient.initialize({ verify: true });
    if (!state.ready) return { ready: false, code: 'bailian_gateway_unavailable', message: '阿里官方视频服务尚未就绪，可以先保存草稿。' };
    const missing = ['bailian', 'bailian_video'].filter((key) => !state.capabilities?.[key]);
    return missing.length ? { ready: false, code: 'bailian_video_protocol_missing', message: '服务尚未支持阿里视频异步协议，请先更新服务组件；没有提交付费生成。', missing }
      : { ready: true, code: '', message: '' };
  }
  return { capabilities, request: shared.request, download: shared.download, videoPayload, videoRequest, pollRequest,
    nodeOf, taskIdOf, statusOf, resultVideoUrl, normalizePoll, ttsPayload, ttsAudioUrl };
}

module.exports = { MODEL, TTS_MODEL, ROUTES, ASYNC_HEADERS, createBailianVideoProvider,
  videoPayload, videoRequest, pollRequest, nodeOf, taskIdOf, statusOf, resultVideoUrl, normalizePoll, ttsPayload, ttsAudioUrl };
