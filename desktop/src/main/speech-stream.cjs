// Preserve every audio chunk from one synthesis and its original receipt.
function parseSpeechStream(source) {
  const chunks = []; let last, requestId;
  for (const event of source.split(/\r?\n\r?\n/u)) {
    const data = event.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let value;
    try { value = JSON.parse(data); } catch { throw Object.assign(Error('语音流响应不完整，请查询原请求；不会重新购买。'), { code: 'reference_speech_stream_unknown', outcomeUnknown: true }); }
    if (value.code || value.error) throw Object.assign(Error('语音合成未完成，请核对原请求。'), { code: 'reference_speech_stream_rejected' });
    requestId ||= value.request_id;
    const encoded = value.output?.audio?.data;
    if (encoded) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4) throw Object.assign(Error('语音流音频无法校验，请查询原请求。'), { code: 'reference_speech_stream_unknown', outcomeUnknown: true });
      chunks.push(Buffer.from(encoded, 'base64'));
    }
    last = value;
  }
  if (last?.output?.finish_reason !== 'stop' || !chunks.length) throw Object.assign(Error('完整语音流尚未结束，请查询原请求；未购买人物视频。'), { code: 'reference_speech_stream_unknown', outcomeUnknown: true });
  const audio = Buffer.concat(chunks);
  if (audio.length > 8 * 1024 * 1024) throw Object.assign(Error('语音流超出当前长度限制，原回执已保留。'), { code: 'reference_speech_stream_large' });
  return { request_id: requestId, usage: last.usage, output: { finish_reason: 'stop', audio: { data: audio.toString('base64') } } };
}
module.exports = { parseSpeechStream };
