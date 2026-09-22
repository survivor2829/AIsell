const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MODEL = 'seedance-2.5';
const SAFE_ID = /^[A-Za-z0-9._-]{1,255}$/u;
const SCENES = Object.freeze([
  { id: 'studio', name: '简洁演播室', description: '干净简洁的专业演播室，中性色背景，柔和均匀灯光，留出与产品体量相符的空间，人物面部和产品清晰', action: '面向镜头讲解，按产品真实体量安排自然的展示动作' },
  { id: 'store', name: '门店陈列', description: '整洁真实的门店陈列区，货架有层次但不抢主体，自然灯光，宽敞的产品演示位置', action: '在适合产品体量的陈列位置介绍，指向清晰可见的细节' },
  { id: 'display', name: '产品展示台', description: '简约高质感的产品展示区，小件使用展示台，大件使用同风格地面展示区，人物和产品同画面，背景干净', action: '在产品旁介绍，按真实体量展示其正面或清晰可见的操作区域' },
]);
const PRODUCT_INTERACTION = '依据参考产品的类别、结构和文案中的尺寸信息，保持人物与产品的真实比例。只有适合拿取的小件才可自然手持；大型、重型或落地设备保持落地，人物站在旁边指向细节，或轻触图片中可辨认的操作区域。体量不明确时采用站旁讲解，不强行拿起。不得把大型产品缩成手持模型、抬离地面或放在普通桌上；不新增图片中不存在的按钮、零件或操作功能。';
const VOICES = Object.freeze([
  { id: 'natural_female', name: '自然女声', prompt: '自然亲切的成年女性普通话，吐字清楚，节奏从容' },
  { id: 'steady_male', name: '沉稳男声', prompt: '沉稳自然的成年男性普通话，吐字清楚，不夸张播报' },
  { id: 'lively', name: '轻快讲解', prompt: '轻快有亲和力的普通话讲解，语气自然，语速适中' },
]);

function fail(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function cleanMessage(value) {
  return String(value || '').replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/giu, '[已隐藏]')
    .replace(/https?:\/\/\S+/giu, '[服务地址]').replace(/[A-Za-z]:[\\/][^\s"<>]+/gu, '[本地文件]').slice(0, 500);
}
function remoteUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw fail('digital_human_media_url_invalid', '服务未返回有效的素材地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443'
    || url.hostname === 'localhost' || url.hostname.endsWith('.local') || net.isIP(url.hostname.replace(/^\[|\]$/gu, ''))) {
    throw fail('digital_human_media_url_invalid', '服务返回的素材地址不受支持。');
  }
  return url.href;
}
function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0))
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
  }
  // Public unicast IPv6 only; excludes loopback, link-local and mapped IPv4.
  return net.isIPv6(address) && /^[23]/u.test(address);
}
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, records) => {
    if (error) return callback(error);
    const safe = records.filter(({ address }) => isPublicAddress(address));
    if (!safe.length || safe.length !== records.length) return callback(fail('digital_human_media_host_invalid', '素材下载地址无法安全连接。'));
    if (options?.all) callback(null, safe);
    else callback(null, safe[0].address, safe[0].family);
  });
}
async function downloadMedia(rawUrl, destination, { maxBytes = 160 * 1024 * 1024, redirects = 0 } = {}) {
  const url = remoteUrl(rawUrl);
  if (redirects > 3) throw fail('digital_human_download_redirects', '素材下载跳转过多。');
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: safeLookup, timeout: 60000, headers: { 'User-Agent': 'Xiaoxi-Digital-Human/1' } }, resolve);
    request.on('error', reject);
    request.on('timeout', () => request.destroy(fail('digital_human_download_timeout', '素材下载超时，已保留云端任务。')));
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    const next = new URL(response.headers.location || '', url).href;
    response.resume();
    return downloadMedia(next, destination, { maxBytes, redirects: redirects + 1 });
  }
  if (response.statusCode !== 200 || Number(response.headers['content-length'] || 0) > maxBytes) {
    response.resume(); throw fail('digital_human_download_failed', '素材下载失败或文件过大，已保留云端任务。');
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.part`;
  let received = 0;
  try {
    await pipeline(response, new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length;
      done(received > maxBytes ? fail('digital_human_download_too_large', '生成文件超出样片大小限制。') : null, chunk);
    } }), fs.createWriteStream(temporary, { flags: 'wx' }));
    if (!received) throw fail('digital_human_download_empty', '服务返回了空文件。');
    await fsp.rename(temporary, destination);
  } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
  return destination;
}
function nodeOf(payload) { return Array.isArray(payload?.data) ? payload.data[0] || {} : payload?.data || payload || {}; }
function taskIdOf(payload) {
  const node = nodeOf(payload), id = node.task_id || node.id;
  if (!SAFE_ID.test(String(id || ''))) throw fail('digital_human_submission_unknown', '请求已发送，但未收到有效任务编号；请核对服务记录。', { outcomeUnknown: true });
  return id;
}
function resultUrl(payload, kind) {
  const node = nodeOf(payload), item = node.result?.[kind]?.[0];
  const url = Array.isArray(item?.url) ? item.url[0] : item?.url;
  return remoteUrl(url);
}
function previewPrompt(task) {
  const scene = SCENES.find((item) => item.id === task.sceneId);
  return `制作一张竖屏9:16真实商业摄影定妆图。参考图1是本人形象，保持脸部特征、年龄和发型；参考图2是实际产品，准确保留形状、颜色、品牌和包装，不增加不存在的零件或功效。场景：${scene.description}。人物与产品必须同画面。${PRODUCT_INTERACTION} 产品介绍仅作为产品信息参考：${JSON.stringify(task.script)}。手指自然，面部及产品正面清楚，画面下方保留字幕空间。不要字幕、水印、装饰文字。`;
}
function videoPayload(task) {
  const scene = SCENES.find((item) => item.id === task.sceneId);
  const voice = VOICES.find((item) => item.id === task.voiceStyle);
  if (!task.libraryAssets?.person || !task.libraryAssets?.preview) throw fail('digital_human_avatar_approval_required', '人物及预览形象尚未通过素材审核。');
  const references = [task.libraryAssets.preview, task.libraryAssets.person, task.productUrl];
  if (references.slice(0, 2).some((item) => !/^asset:\/\/[A-Za-z0-9._-]+$/u.test(item))) throw fail('digital_human_avatar_approval_required', '人物素材尚未取得已审核编号。');
  return {
    model: MODEL, duration: task.durationSeconds, resolution: '1080p', size: '9:16', output_format: 'mp4',
    omni_reference_task_type: 'reference', generate_audio: true,
    image_urls: references,
    prompt: `竖屏真实产品介绍视频，时长${task.durationSeconds}秒。@图片1是已确认的本人和产品同框场景，保持构图、服装、脸、产品外观及相对尺度、背景一致；@图片2校准本人脸部；@图片3校准实际产品外形及包装。人物始终在${scene.description}里，${scene.action}。人物和产品同画面，动作自然克制。${PRODUCT_INTERACTION} 本人面对镜头以${voice.prompt}说出以下完整文案，口型与话语同步，不添加额外台词：${JSON.stringify(task.script)}。无背景音乐、无字幕、无画面文字。`,
  };
}
function createDigitalHumanProvider({ gatewayClient, download = downloadMedia } = {}) {
  async function capabilities() {
    const message = '数字人服务未连接，暂时无法生成人物与产品预览，可以先保存草稿。';
    if (!gatewayClient?.isEnabled?.()) return { ready: false, code: 'digital_human_gateway_unavailable', message };
    const state = await gatewayClient.initialize({ verify: true });
    if (!state.ready) return { ready: false, code: 'digital_human_gateway_unavailable', message };
    const missing = ['apimart', 'apimart_video', 'apimart_avatar_assets'].filter((key) => !state.capabilities?.[key]);
    return missing.length ? { ready: false, code: 'digital_human_gateway_routes_missing', message: '数字人生成接口尚未接通，暂时无法生成人物与产品预览，可以先保存草稿。', missing }
      : { ready: true, code: '', message: '' };
  }
  async function request(route, { method = 'GET', body, operationId, headers = {} } = {}) {
    let response;
    try {
      response = await gatewayClient.fetch(gatewayClient.url(route), { method, body: body instanceof Buffer ? body : body == null ? undefined : JSON.stringify(body),
        headers: { Accept: 'application/json', ...(body instanceof Buffer ? {} : { 'Content-Type': 'application/json' }), ...headers,
          ...(operationId ? { 'X-Xiaoxi-Operation-Id': operationId } : {}) }, timeoutMs: 180000 });
    } catch (error) {
      throw fail('digital_human_request_unconfirmed', '服务连接中断，请刷新核对进度，当前请求不会自动重复提交。', { outcomeUnknown: method === 'POST' });
    }
    let payload;
    try { payload = await response.json(); } catch { throw fail('digital_human_response_invalid', '服务返回的数据无法识别。', { outcomeUnknown: method === 'POST' }); }
    if (!response.ok) {
      const detail = cleanMessage(payload?.error?.message || payload?.error || payload?.message);
      throw fail(response.status === 404 ? 'digital_human_route_unavailable' : 'digital_human_provider_error',
        response.status === 404 ? '数字人接口尚未部署或当前不可用，请在开发者工具检查服务版本。' : `服务未完成请求${detail ? `：${detail}` : `（${response.status}）`}`,
        { outcomeUnknown: method === 'POST' && (response.status >= 500 || response.status === 409), status: response.status });
    }
    return payload;
  }
  function imageUploadBody(filePath) {
    const bytes = fs.readFileSync(filePath);
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw fail('digital_human_image_size', '请选择不超过20MB的图片。');
    const ext = path.extname(filePath).toLowerCase(), mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext];
    if (!mime) throw fail('digital_human_image_type', '请选择 JPG、PNG 或 WebP 图片。');
    const boundary = '----xiaoxi-digital-human-upload';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference${ext}"\r\nContent-Type: ${mime}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
  }
  return { capabilities, request, imageUploadBody, download, taskIdOf, resultUrl, nodeOf,
    previewPayload: (task) => ({ model: 'gpt-image-2', prompt: previewPrompt(task), image_urls: [task.personUrl, task.productUrl], n: 1, size: '9:16', resolution: '1k' }),
    videoPayload,
  };
}
module.exports = { createDigitalHumanProvider, downloadMedia, isPublicAddress, remoteUrl, fail, cleanMessage, nodeOf, taskIdOf, resultUrl, videoPayload, SCENES, VOICES, MODEL, SAFE_ID };
