const assert = require('node:assert/strict');
const { createBailianVideoProvider, videoRequest, directVideoRequest, taskIdOf, normalizePoll, ttsPayload, ttsAudioUrl } = require('./bailian-video-provider.cjs');

async function main() {
  const direct = directVideoRequest({ imageUrl: 'data:image/png;base64,aW1hZ2U=', prompt: '原产品图直接生成清洁效果。', seconds: 10 });
  assert.equal(direct.body.model, 'wan3.0-video');
  assert.deepEqual(direct.body.input.media, [{ type: 'reference_image', url: 'data:image/png;base64,aW1hZ2U=' }]);
  assert.equal(direct.body.input.img_url, undefined);
  assert.deepEqual(direct.body.parameters, { resolution: '480P', ratio: '9:16', duration: 10, audio: false, prompt_extend: false, watermark: false });
  assert.throws(() => directVideoRequest({ imageUrl: 'https://cdn.example.com/product.png', prompt: '演示', seconds: 31 }), { code: 'bailian_duration_invalid' });
  const request = videoRequest({ imageUrl: 'data:image/png;base64,aW1hZ2U=', audioUrl: 'https://cdn.example.com/speech.wav',
    prompt: '按照固定口播音轨自然讲解。', durationSeconds: 15, resolution: '720p', audio: true });
  assert.equal(request.body.input.audio_url, 'https://cdn.example.com/speech.wav');
  assert.deepEqual(request.body.parameters, { resolution: '720P', duration: 15, audio: true, prompt_extend: false });
  assert.equal(request.headers['X-DashScope-Async'], 'enable');
  assert.throws(() => videoRequest({ ...request.body, imageUrl: 'https://cdn.example.com/first.png', prompt: '介绍', seconds: 15,
    audio: false, audioUrl: 'https://cdn.example.com/speech.wav' }), { code: 'bailian_audio_conflict' });
  assert.throws(() => videoRequest({ imageUrl: 'https://cdn.example.com/first.png', prompt: '介绍', seconds: 16 }), { code: 'bailian_duration_invalid' });
  assert.throws(() => taskIdOf({ output: {} }), { outcomeUnknown: true });
  assert.equal(taskIdOf({ output: { task_id: 'wan-task-1' } }), 'wan-task-1');
  assert.equal(normalizePoll({ output: { task_status: 'UNKNOWN' } }).status, 'unknown');
  assert.deepEqual(normalizePoll({ output: { task_status: 'SUCCEEDED', video_url: 'https://cdn.example.com/clip.mp4' } }),
    { status: 'completed', videoUrl: 'https://cdn.example.com/clip.mp4', error: '' });
  assert.equal(normalizePoll({ output: { task_status: 'SUCCEEDED', video_url: 'http://dashscope-7c2c.oss-cn-shanghai.aliyuncs.com/clip.mp4?Signature=fixture' } }).videoUrl,
    'https://dashscope-7c2c.oss-cn-shanghai.aliyuncs.com/clip.mp4?Signature=fixture');
  assert.throws(() => normalizePoll({ output: { task_status: 'SUCCEEDED', video_url: 'http://dashscope-7c2c.oss-cn-shanghai.aliyuncs.com.evil.test/clip.mp4' } }));
  assert.equal(ttsPayload({ text: '完整句子。' }).input.text, '完整句子。');
  assert.throws(() => ttsPayload({ text: '字'.repeat(601) }), { code: 'bailian_tts_text_invalid' });
  assert.equal(ttsAudioUrl({ output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.wav?Signature=fixture' } } }),
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.wav?Signature=fixture');
  assert.throws(() => ttsAudioUrl({ output: { audio: { url: 'http://untrusted.example.com/voice.wav' } } }));
  let calls = 0;
  const gatewayClient = { isEnabled: () => true, url: (route) => route,
    initialize: async () => ({ ready: true, capabilities: { bailian: true } }),
    fetch: async () => { calls += 1; throw new Error('socket closed'); } };
  const provider = createBailianVideoProvider({ gatewayClient });
  assert.equal((await provider.capabilities()).ready, false, 'old gateways must fail before any paid request');
  await assert.rejects(provider.request(request.route, { method: 'POST', ...request, operationId: 'one-attempt' }), { outcomeUnknown: true });
  assert.equal(calls, 1, 'ambiguous paid request must never be automatically retried');
  console.log('bailian video provider checks passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
