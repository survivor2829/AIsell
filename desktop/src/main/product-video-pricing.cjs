const https = require('node:https');
const { fail } = require('./digital-human-provider.cjs');
const PRICE_ORIGIN = 'https://apimart.ai/api/pricing/model?model=';
const MAX_AGE = 24 * 60 * 60 * 1000;
const PRICE_TIMEOUT_MS = 15000, MAX_PRICE_BYTES = 1000000;
// Published reference for the same speech service. It is an estimate, not the
// gateway account's actual bill; the larger allowance below stays pending.
const ASR_REFERENCE = Object.freeze({ resourceId: 'volc.bigasr.auc_turbo', cnyPerHour: 4.5,
  source: 'https://docs.coze.cn/coze_pro_internal_integrations_fee', verifiedOn: '2026-10-07' });
const round = (n) => Math.ceil((n - 1e-9) * 100) / 100;
function readJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: PRICE_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > MAX_PRICE_BYTES) res.destroy(new Error('price_response_too_large')); });
      res.on('error', reject);
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('price_unavailable'); resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('price_timeout')));
  });
}
async function readFetchJson(url, fetchImpl) {
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
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (controller.signal.aborted) throw new Error('price_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    reader?.releaseLock();
  }
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
  return prices?.ready === true && [prices.videoUsdPerSecond, prices.imageUsd, prices.fxCnyPerUsd, prices.asrReserveCny].every((n) => Number.isFinite(n) && n > 0)
    && Number.isFinite(Date.parse(prices.checkedAt)) && now - Date.parse(prices.checkedAt) >= 0 && now - Date.parse(prices.checkedAt) < MAX_AGE;
}
function createPriceReader({ fetchJson, fetch: fetchImpl } = {}) {
  const read = fetchJson || (fetchImpl ? (url) => readFetchJson(url, fetchImpl) : readJson);
  let cached, pending;
  return async function prices() {
    if (validPrices(cached)) return cached;
    if (!pending) pending = Promise.all([read(PRICE_ORIGIN + 'seedance-2.5'), read(PRICE_ORIGIN + 'gpt-image-2')])
      .then(([video, image]) => { cached = parsePrices(video, image); return cached; }).finally(() => { pending = null; });
    return pending;
  };
}
function quotePlan(plan, prices, budgetCny) {
  const seconds = plan.shots.reduce((sum, s) => sum + s.seconds, 0), count = plan.pipelineVersion === 2 ? plan.shots.length : 0;
  if (!validPrices(prices)) return { ready: false, budgetCny, estimatedCny: null, reservedCny: 0, actualCny: 0, pendingCny: 0, message: '报价暂不可用，方案已保留。' };
  const estimatedCny = round((seconds * prices.estimatedVideoUsdPerSecond + count * prices.estimatedImageUsd) * prices.fxCnyPerUsd + (count ? prices.asrReserveCny : 0));
  const maximumCny = round(plan.shots.reduce((sum, shot) => sum + round(shot.seconds * prices.videoUsdPerSecond * prices.fxCnyPerUsd), 0) + count * round(prices.imageUsd * prices.fxCnyPerUsd) + (count ? prices.asrReserveCny : 0));
  return { ready: true, estimatedCny, maximumCny, reservedCny: 0, actualCny: 0, pendingCny: 0, budgetCny,
    source: prices.source, checkedAt: prices.checkedAt, fxCnyPerUsd: prices.fxCnyPerUsd, note: '按公开标价保守预留；人民币为预算折算，实际账单另行核对。字幕识别预留非已扣费用。' };
}
module.exports = { createPriceReader, parsePrices, validPrices, quotePlan, round };
