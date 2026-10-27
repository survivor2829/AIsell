const https = require('node:https');
const { createHash } = require('node:crypto');
const { fail } = require('./digital-human-provider.cjs');
const { MODEL, DIRECT_MODEL, TTS_MODEL } = require('./bailian-video-provider.cjs');
const PRICE_ORIGIN = 'https://apimart.ai/api/pricing/model?model=';
const MAX_AGE = 24 * 60 * 60 * 1000;
const PRICE_TIMEOUT_MS = 15000, MAX_PRICE_BYTES = 1000000;
const BAILIAN_PRICE_SOURCE = 'https://help.aliyun.com/zh/model-studio/wan2-6-i2v-flash';
const DIRECT_PRICE_SOURCE = 'https://help.aliyun.com/zh/model-studio/wan3-0-video';
const TTS_PRICE_SOURCE = 'https://help.aliyun.com/zh/model-studio/qwen3-tts-flash';
function createReferencePriceReader({ fetch: fetchImpl } = {}) {
  const configured = require('../shared/reference-human.json').price;
  let cached;
  return async () => {
    if (cached && Date.now() - Date.parse(cached.checkedAt) < MAX_AGE) return cached;
    const html = await (fetchImpl ? readFetchText(configured.source, fetchImpl) : readText(configured.source));
    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map((row) => row[1].replace(/<[^>]*>/gu, ' ').replace(/&nbsp;|&#160;/gu, ' '));
    const row = rows.find((text) => /videoretalk/iu.test(text) && /元\s*\/\s*秒/u.test(text));
    const rate = Number(row?.match(/(\d+(?:\.\d+)?)\s*元\s*\/\s*秒/u)?.[1]);
    if (!(rate > 0)) throw fail('reference_price_unavailable', '无法核实当前人物驱动价格，未提交付费制作。');
    cached = { ...configured, videoCnyPerSecond: rate, checkedAt: new Date().toISOString() }; return cached;
  };
}
// Published reference for the same speech service. It is an estimate, not the
// gateway account's actual bill; the larger allowance below stays pending.
const ASR_REFERENCE = Object.freeze({ resourceId: 'volc.bigasr.auc_turbo', cnyPerHour: 4.5,
  source: 'https://docs.coze.cn/coze_pro_internal_integrations_fee', verifiedOn: '2026-10-07' });
const round = (n) => Math.ceil((n - 1e-9) * 100) / 100;
function readText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: PRICE_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > MAX_PRICE_BYTES) res.destroy(new Error('price_response_too_large')); });
      res.on('error', reject);
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('price_unavailable'); resolve(body); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('price_timeout')));
  });
}
async function readFetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_TIMEOUT_MS);
  let reader;
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal: controller.signal });
    if (response.status !== 200) throw new Error('price_unavailable');
    if (Number(response.headers.get('content-length')) > MAX_PRICE_BYTES) throw new Error('price_response_too_large');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PRICE_BYTES) throw new Error('price_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('price_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    reader?.releaseLock();
  }
}
const readJson = async (url) => JSON.parse(await readText(url));
const readFetchJson = async (url, fetchImpl) => JSON.parse(await readFetchText(url, fetchImpl));
function beijingPriceRows(document, model) {
  if (typeof document !== 'string' || !document.includes(model)) throw fail('product_video_price_unavailable', '阿里官方型号报价无法核实，暂不提交付费请求。');
  const pricingStart = document.indexOf('模型价格');
  const beijingStart = document.indexOf('北京', pricingStart);
  const tableStart = document.indexOf('<table', beijingStart), tableEnd = document.indexOf('</table>', tableStart);
  if (pricingStart < 0 || beijingStart < 0 || tableStart < 0 || tableEnd < 0) throw fail('product_video_price_unavailable', '阿里官方北京区域报价表无法读取，暂不提交付费请求。');
  return [...document.slice(tableStart, tableEnd).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map((row) =>
    [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((cell) => cell[1].replace(/<[^>]*>/gu, '').replace(/&nbsp;|&#160;|\s+/gu, '').trim()));
}
function parseBailianPrices(videoDocument, ttsDocument, now = Date.now()) {
  const rows = beijingPriceRows(videoDocument, MODEL);
  const rate = (label) => {
    const row = rows.find((cells) => cells[0] === label && cells[2] === '每秒'), value = Number(row?.[1]);
    if (!Number.isFinite(value) || value <= 0) throw fail('product_video_price_unavailable', '阿里官方视频计费项不完整，暂不提交付费请求。');
    return value;
  };
  const ttsRows = beijingPriceRows(ttsDocument, TTS_MODEL);
  const ttsRow = ttsRows.find((cells) => cells[0] === '语音合成' && /每万字符/u.test(cells[2] || ''));
  const ttsCnyPer10kChars = Number(ttsRow?.[1]);
  if (!Number.isFinite(ttsCnyPer10kChars) || ttsCnyPer10kChars <= 0) throw fail('product_video_price_unavailable', '阿里官方语音计费项无法核实，暂不提交付费请求。');
  const checkedAt = new Date(now).toISOString();
  return { ready: true, provider: 'bailian', model: MODEL, region: 'cn-beijing',
    rates: { '720p': { silent: rate('视频生成（720P无声）'), audio: rate('视频生成（720P）') },
      '1080p': { silent: rate('视频生成（1080P无声）'), audio: rate('视频生成（1080P）') } },
    ttsModel: TTS_MODEL, ttsCnyPer10kChars, checkedAt, ttsCheckedAt: checkedAt,
    source: [BAILIAN_PRICE_SOURCE, TTS_PRICE_SOURCE], priceEvidenceHash: createHash('sha256').update(videoDocument).update(ttsDocument).digest('hex') };
}
function parseDirectPrices(videoDocument, ttsDocument, now = Date.now()) {
  const rows = beijingPriceRows(videoDocument, DIRECT_MODEL);
  const rates = {};
  for (const resolution of ['480p', '720p', '1080p']) {
    const row = rows.find(cells => cells[0] === `视频生成（${resolution.toUpperCase()}）` && cells[2] === '每秒');
    const value = Number(row?.[1]);
    if (!(value > 0) || !Number.isFinite(value)) throw fail('product_video_price_unavailable', 'Wan3对应清晰度的北京区域报价无法核实，未提交付费请求。');
    rates[resolution] = { silent: value, audio: value };
  }
  const tts = beijingPriceRows(ttsDocument, TTS_MODEL).find(cells => cells[0] === '语音合成' && /每万字符/u.test(cells[2] || ''));
  const ttsCnyPer10kChars = Number(tts?.[1]);
  if (!(ttsCnyPer10kChars > 0) || !Number.isFinite(ttsCnyPer10kChars)) throw fail('product_video_price_unavailable', '配音计费项无法核实，未提交付费请求。');
  const checkedAt = new Date(now).toISOString();
  return { ready: true, provider: 'bailian', model: DIRECT_MODEL, region: 'cn-beijing', rates,
    ttsModel: TTS_MODEL, ttsCnyPer10kChars, checkedAt, ttsCheckedAt: checkedAt,
    source: [DIRECT_PRICE_SOURCE, TTS_PRICE_SOURCE], priceEvidenceHash: createHash('sha256').update(videoDocument).update(ttsDocument).digest('hex') };
}
function recentPrices(prices, now) {
  return Number.isFinite(Date.parse(prices?.checkedAt)) && now - Date.parse(prices.checkedAt) >= 0 && now - Date.parse(prices.checkedAt) < MAX_AGE;
}
function validBailianPrices(prices, now = Date.now()) {
  return prices?.ready === true && prices.provider === 'bailian' && prices.model === MODEL && prices.region === 'cn-beijing'
    && [prices.rates?.['720p']?.silent, prices.rates?.['720p']?.audio, prices.rates?.['1080p']?.silent, prices.rates?.['1080p']?.audio, prices.ttsCnyPer10kChars].every((n) => Number.isFinite(n) && n > 0)
    && recentPrices(prices, now);
}
function createBailianPriceReader({ fetchText, fetch: fetchImpl } = {}) {
  const read = fetchText || (fetchImpl ? (url) => readFetchText(url, fetchImpl) : readText);
  let cached, pending;
  return async () => {
    if (validBailianPrices(cached)) return cached;
    if (!pending) pending = Promise.all([read(BAILIAN_PRICE_SOURCE), read(TTS_PRICE_SOURCE)])
      .then(([video, tts]) => { cached = parseBailianPrices(video, tts); return cached; }).finally(() => { pending = null; });
    return pending;
  };
}
function parsePrices(video, image, now = Date.now()) {
  const v = video?.data, i = image?.data;
  const videoUsdPerSecond = Number(v?.resolution_prices?.['480P']);
  const imageUsd = Number(i?.resolution_prices?.['1K']);
  if (!video?.success || !image?.success || !(videoUsdPerSecond > 0) || !(imageUsd > 0)) throw fail('product_video_price_unavailable', '未取得完整生成报价，暂不提交付费请求。');
  const advertised = (value, maximum) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : maximum;
  return { ready: true, videoUsdPerSecond, imageUsd,
    estimatedVideoUsdPerSecond: advertised(v.resolution_paid_prices?.['480P'], videoUsdPerSecond),
    estimatedImageUsd: advertised(i.resolution_paid_prices?.['1K'], imageUsd),
    fxCnyPerUsd: 8, fxNote: '预算折算汇率，非实时外汇或人民币账单',
    // ASR provider does not return a per-request bill. Retain this whole conservative
    // allowance until the operator checks their account; never report it as a charge.
    asrReserveCny: 1, asrCnyPerMinute: ASR_REFERENCE.cnyPerHour / 60, asrReference: ASR_REFERENCE,
    asrNote: '同型号公开参考价4.5元/小时；每次最多60秒保守预留1元，当前供应商实际账单待核对',
    source: [PRICE_ORIGIN + 'seedance-2.5', PRICE_ORIGIN + 'gpt-image-2', ASR_REFERENCE.source],
    checkedAt: new Date(now).toISOString() };
}
function validPrices(prices, now = Date.now()) {
  if (prices?.provider === 'bailian' && prices.model === DIRECT_MODEL) return prices.ready === true && prices.region === 'cn-beijing'
    && prices.resolution === '480p' && prices.audio === false && prices.videoCnyPerSecond === prices.rates?.['480p']?.silent
    && [prices.videoCnyPerSecond, prices.ttsCnyPer10kChars, prices.asrReserveCny, prices.audioReserveCny].every(n => Number.isFinite(n) && n > 0)
    && recentPrices(prices, now);
  if (prices?.provider === 'bailian') return validBailianPrices(prices, now) && prices.resolution === '720p' && prices.audio === false
    && prices.videoCnyPerSecond === prices.rates['720p'].silent
    && [prices.imageUsd, prices.fxCnyPerUsd, prices.asrReserveCny, prices.audioReserveCny].every((n) => Number.isFinite(n) && n > 0);
  return prices?.ready === true && [prices.videoUsdPerSecond, prices.imageUsd, prices.fxCnyPerUsd, prices.asrReserveCny].every((n) => Number.isFinite(n) && n > 0)
    && recentPrices(prices, now);
}
function createPriceReader({ fetchJson, fetchText, fetch: fetchImpl, gatewayClient } = {}) {
  const read = fetchJson || (fetchImpl ? (url) => readFetchJson(url, fetchImpl) : readJson);
  const text = fetchText || (fetchImpl ? (url) => readFetchText(url, fetchImpl) : readText);
  const bailianPrices = createBailianPriceReader({ fetchText, fetch: fetchImpl });
  async function readImagePrice() {
    const source = PRICE_ORIGIN + 'gpt-image-2';
    if (!gatewayClient?.isEnabled?.()) return read(source);
    const response = await gatewayClient.fetch(gatewayClient.url('/capabilities?price_model=gpt-image-2'),
      { method: 'GET', timeoutMs: 20000, maxBytes: MAX_PRICE_BYTES });
    if (!response.ok) throw fail('product_video_price_unavailable', '场景首帧报价暂不可用，未提交付费请求。');
    const result = await response.json(), price = result?.apimart_pricing;
    const age = Date.now() - Number(price?.checked_at) * 1000;
    if (result?.ok !== true || price?.source !== source || price?.payload?.data?.model_name !== 'gpt-image-2'
      || !Number.isFinite(age) || age < -300000 || age >= MAX_AGE) {
      throw fail('product_video_price_unavailable', '场景首帧报价来源或有效期无法核实，未提交付费请求。');
    }
    return price.payload;
  }
  const cache = new Map(), pending = new Map();
  // No-argument callers include digital-human preview/cover pricing. Product
  // creation always supplies its saved plan, so keep their legacy image quote.
  return async function prices(plan = { pipelineVersion: 3 }) {
    const direct = plan.pipelineVersion === 4, official = plan.pipelineVersion >= 3, key = direct ? DIRECT_MODEL : official ? MODEL : 'legacy';
    if (validPrices(cache.get(key))) return cache.get(key);
    if (!pending.has(key)) pending.set(key, (direct
      ? Promise.all([text(DIRECT_PRICE_SOURCE), text(TTS_PRICE_SOURCE)]).then(([videoDocument, ttsDocument]) => {
        const video = parseDirectPrices(videoDocument, ttsDocument);
        return { ...video, resolution: '480p', audio: false, videoCnyPerSecond: video.rates['480p'].silent,
          imageUsd: 0, estimatedImageUsd: 0, fxCnyPerUsd: 8,
          audioReserveCny: 2, asrReserveCny: 1, asrCnyPerMinute: ASR_REFERENCE.cnyPerHour / 60, asrReference: ASR_REFERENCE,
          fxNote: '视频人民币标价；汇率仅用于其他供应商明确返回的美元费用',
          source: [DIRECT_PRICE_SOURCE, TTS_PRICE_SOURCE, ASR_REFERENCE.source] };
      })
      : official
      ? Promise.all([bailianPrices(), readImagePrice()]).then(([video, image]) => {
        const imageUsd = Number(image?.data?.resolution_prices?.['1K']);
        if (!image?.success || !(imageUsd > 0)) throw fail('product_video_price_unavailable', '场景首帧报价无法核实，暂不提交付费请求。');
        const discounted = Number(image.data.resolution_paid_prices?.['1K']);
        return { ...video, resolution: '720p', audio: false, videoCnyPerSecond: video.rates['720p'].silent,
          imageUsd, estimatedImageUsd: discounted > 0 && discounted <= imageUsd ? discounted : imageUsd,
          fxCnyPerUsd: 8, fxNote: '仅首帧供应商美元价格采用预算折算汇率，非人民币账单',
          audioReserveCny: 2, asrReserveCny: 1, asrCnyPerMinute: ASR_REFERENCE.cnyPerHour / 60, asrReference: ASR_REFERENCE,
          source: [...video.source, PRICE_ORIGIN + 'gpt-image-2', ASR_REFERENCE.source] };
      })
      : Promise.all([read(PRICE_ORIGIN + 'seedance-2.5'), readImagePrice()]).then(([video, image]) => parsePrices(video, image)))
      .then((value) => { cache.set(key, value); return value; }).finally(() => { pending.delete(key); }));
    return pending.get(key);
  };
}
function quotePlan(plan, prices, budgetCny) {
  const seconds = plan.shots.reduce((sum, s) => sum + s.seconds, 0), count = plan.pipelineVersion >= 2 && plan.pipelineVersion !== 4 ? plan.shots.length : 0;
  if (!validPrices(prices)) return { ready: false, budgetCny, estimatedCny: null, reservedCny: 0, actualCny: 0, pendingCny: 0, message: '报价暂不可用，方案已保留。' };
  if (plan.pipelineVersion >= 3) {
    if (prices.provider !== 'bailian' || prices.model !== plan.videoModel || prices.resolution !== plan.sourceResolution) return { ready: false, budgetCny, message: '当前报价与本次模型或清晰度不匹配，请重新核价。' };
    const videoCny = round(seconds * prices.videoCnyPerSecond), soundReserveCny = prices.audioReserveCny + prices.asrReserveCny;
    const imageEstimateCny = count ? count * prices.estimatedImageUsd * prices.fxCnyPerUsd : 0;
    const imageReserveCny = count ? count * round(prices.imageUsd * prices.fxCnyPerUsd) : 0;
    const retryReserveCny = plan.retryPolicy === 'one_failed_video' ? round(Math.max(0, ...plan.shots.map(shot => shot.seconds)) * prices.videoCnyPerSecond) : 0;
    return { ready: true, estimatedCny: round(videoCny + imageEstimateCny + soundReserveCny),
      maximumCny: round(videoCny + imageReserveCny + soundReserveCny + retryReserveCny),
      retryReserveCny,
      reservedCny: 0, actualCny: 0, pendingCny: 0, budgetCny, videoCny, audioReserveCny: prices.audioReserveCny,
      videoModel: prices.model, videoResolution: prices.resolution, videoAudio: false, videoCnyPerSecond: prices.videoCnyPerSecond,
      source: prices.source, checkedAt: prices.checkedAt, fxCnyPerUsd: prices.fxCnyPerUsd,
      note: `${plan.pipelineVersion === 4 ? 'Wan3原图直出，不另收场景首帧生成费用。' : '首帧美元费用保守折算。'}视频按阿里官方北京区域人民币标价；声音准备与识别为预留，实际账单另行核对。` };
  }
  if (prices.provider === 'bailian') return { ready: false, budgetCny, message: '旧任务须沿用原供应商报价，不能替换为阿里单价。' };
  const estimatedCny = round((seconds * prices.estimatedVideoUsdPerSecond + count * prices.estimatedImageUsd) * prices.fxCnyPerUsd + (count ? prices.asrReserveCny : 0));
  const maximumCny = round(plan.shots.reduce((sum, shot) => sum + round(shot.seconds * prices.videoUsdPerSecond * prices.fxCnyPerUsd), 0) + count * round(prices.imageUsd * prices.fxCnyPerUsd) + (count ? prices.asrReserveCny : 0));
  return { ready: true, estimatedCny, maximumCny, reservedCny: 0, actualCny: 0, pendingCny: 0, budgetCny,
    source: prices.source, checkedAt: prices.checkedAt, fxCnyPerUsd: prices.fxCnyPerUsd, note: '按公开标价保守预留；人民币为预算折算，实际账单另行核对。字幕识别预留非已扣费用。' };
}
// AI covers (gpt-image-2.5-ext, 1K) are priced per version; the content engine submits "sunburst".
const COVER_MODEL = 'gpt-image-2.5-ext', COVER_VERSION = 'sunburst';
function parseCoverPrice(payload, now = Date.now()) {
  const data = payload?.data;
  const imageUsd = Number(data?.version_resolution_prices?.[COVER_VERSION]?.['1K']);
  const paid = Number(data?.version_resolution_paid_prices?.[COVER_VERSION]?.['1K']);
  if (payload?.success !== true || data?.model_name !== COVER_MODEL || data?.billing_type !== 'version_resolution' || !(imageUsd > 0)) {
    throw fail('cover_price_unavailable', '未取得有效封面报价，未提交生成。');
  }
  return { ready: true, model: COVER_MODEL, version: COVER_VERSION, resolution: '1K', imageUsd,
    estimatedImageUsd: paid > 0 && paid <= imageUsd ? paid : imageUsd, fxCnyPerUsd: 8,
    fxNote: '美元公开价按预算汇率折算，非人民币账单', source: [PRICE_ORIGIN + COVER_MODEL], checkedAt: new Date(now).toISOString() };
}
function createCoverPriceReader({ fetchJson, fetch: fetchImpl, gatewayClient } = {}) {
  const read = fetchJson || (fetchImpl ? (url) => readFetchJson(url, fetchImpl) : readJson);
  let cached, pending;
  async function readPayload() {
    const source = PRICE_ORIGIN + COVER_MODEL;
    if (!gatewayClient?.isEnabled?.()) return read(source);
    const response = await gatewayClient.fetch(gatewayClient.url('/capabilities?price_model=' + COVER_MODEL),
      { method: 'GET', timeoutMs: 20000, maxBytes: MAX_PRICE_BYTES });
    if (!response.ok) throw fail('cover_price_unavailable', '封面报价暂不可用，未提交生成。');
    const result = await response.json(), price = result?.apimart_pricing;
    const age = Date.now() - Number(price?.checked_at) * 1000;
    if (result?.ok !== true || price?.source !== source || !Number.isFinite(age) || age < -300000 || age >= MAX_AGE) {
      throw fail('cover_price_unavailable', '封面报价来源或有效期无法核实，未提交生成。');
    }
    return price.payload;
  }
  // The price is public and anonymous: right after launch the gateway session may not
  // be ready yet, so fall back to the public page instead of failing the quote.
  const readAny = () => readPayload().catch(() => read(PRICE_ORIGIN + COVER_MODEL));
  return async () => {
    if (cached && Date.now() - Date.parse(cached.checkedAt) < MAX_AGE) return cached;
    if (!pending) pending = readAny().then((payload) => { cached = parseCoverPrice(payload); return cached; }).finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { createCoverPriceReader, parseCoverPrice, createPriceReader, parsePrices, validPrices, quotePlan, round, createBailianPriceReader, parseBailianPrices, parseDirectPrices, validBailianPrices, createReferencePriceReader };
