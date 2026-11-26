
const { promptRef } = require("../shared/prompt-ref.cjs");// AI 看图兜底 (user 2026-11-21: "more intelligence, less structure" for 精准触达). The rule-based reader
// (UIA + Windows OCR + string rules) skipped people who were plainly on screen: on a 200% laptop the
// search dropdown showed the person under 最常使用 but the green highlighted name was never read (1.3.45, ~1700 skips in
// one night). When the rules give up, a vision model looks at the same picture. The model only READS:
// it lists the names it sees and where; the code decides, by exact comparison with the expected name,
// whether anything is clicked or sent. No answer, an unsure answer or a mismatch keeps the old skip.
const ROUTE = '/bailian/compatible-mode/v1/chat/completions';
const MODEL = 'qwen3-vl-plus';
const TIMEOUT_MS = 20_000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const fold = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').trim();

// The dropdown under the search box: every result row the model can see, top to bottom.
function searchMessages({ image, query }) {
  const system = promptRef("wechat.vision.search_dropdown");
  return [{ role: 'system', content: system },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: `搜索框里输入的是：${query}` }] }];
}

// The chat that is open: the top strip of the WeChat window (wechat_title_strip.cjs), whose layout
// differs between computers (225%: the title sat well below where the rules looked), so the model
// says where the title is as well as what it says.
function titleMessages({ image }) {
  const system = promptRef("wechat.vision.header_title");
  return [{ role: 'system', content: system },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: '现在打开的是谁的聊天？' }] }];
}

function jsonOf(content) {
  const text = String(content || '').replace(/```(?:json)?/giu, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw fail('vision_answer_invalid', 'no JSON');
  return JSON.parse(text.slice(start, end + 1));
}

const LOCAL = new Set(['联系人', '最常使用']);
const PEOPLE = new Set([...LOCAL, '群聊']);
// The one row the code may click: a local contact row, read surely, whose 微信号 equals the searched
// 微信号 (a 微信号 search) or whose name equals the expected name (a name search) — and no other row
// matching the same way (two same-named contacts, or a 微信号 read one digit short next to the real one → skipped).
function pickSearchRow(answer, { query, queryType, expectedName }) {
  const rows = Array.isArray(answer?.rows) ? answer.rows : [];
  const byId = queryType === 'wechat_id';
  const target = fold(byId ? query : expectedName || query);
  const matches = (row) => fold(byId ? row?.wechat_id : row?.name) === target;
  // Replay of 30 field dropdowns (2026-11-21): search suggestions (magnifier, no avatar) and the chat
  // list behind the panel were both read as 联系人. Only a row in the panel, with an avatar, counts.
  const shown = (row) => row.avatar === true && row.in_panel === true;
  // Another person or group with the same name makes it ambiguous; the person's own 聊天记录 entry and
  // the 搜索网络结果 suggestion echoing the query do not (dev machine, the test contact shown four times).
  const same = rows.filter((row) => matches(row) && shown(row) && PEOPLE.has(String(row.group)));
  const local = same.filter((row) => LOCAL.has(String(row.group)) && row.unsure !== true);
  const inRange = (value) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) < 1000;
  // A 微信号 search goes by the 微信号 alone: in the replay the name beside a correctly read 微信号 was
  // misread by one character. The chat title is still checked after the click.
  if (!target || local.length !== 1 || same.length !== 1 || !inRange(local[0].x) || !inRange(local[0].y)) {
    return { ok: false, reason: !same.length ? (rows.some(matches) ? 'vision_not_local' : 'vision_not_found') : same.length > 1 ? 'vision_ambiguous'
      : !local.length ? 'vision_not_local' : 'vision_position_invalid', seen: rows.length };
  }
  return { ok: true, x: Number(local[0].x) / 1000, y: Number(local[0].y) / 1000, seen: rows.length };
}
// The chat counts as the expected one only if the model read the expected name exactly, surely, as
// the chat title, with the search cleared and no dropdown left open (a click that did not land leaves
// the query in the box: a060ad68, the query typed while another chat stayed open). Where the title is
// tells the next step which pixels must stay the same.
// The grey hint in an empty search box (replay of 32 field strips, 2026-11-21: copied as text 6 times).
const typed = (value) => !['', '搜索', 'search'].includes(fold(value).toLowerCase());
function pickTitle(answer, expectedName) {
  const title = fold(answer?.title), expected = fold(expectedName);
  const box = Array.isArray(answer?.title_box) ? answer.title_box.map(Number) : [];
  const boxOk = box.length === 4 && box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1000) && box[0] < box[2] && box[1] < box[3];
  const reason = !title ? 'vision_title_empty' : answer?.unsure === true ? 'vision_title_unsure' : title !== expected ? 'vision_title_mismatch'
    : typed(answer?.search_box) || answer?.dropdown_open === true ? 'vision_search_still_open' : !boxOk ? 'vision_position_invalid' : '';
  if (!expected || reason) return { ok: false, reason: reason || 'vision_title_mismatch', read: Boolean(title) };
  return { ok: true, read: true, box: { left: box[0] / 1000, top: box[1] / 1000, right: box[2] / 1000, bottom: box[3] / 1000 } };
}

function createWechatVisionCheck({ gatewayClient, fetchTimeoutMs = TIMEOUT_MS, model = MODEL } = {}) {
  const ready = () => Boolean(gatewayClient?.isReady?.() && typeof gatewayClient.fetch === 'function');
  async function ask(messages) {
    if (!ready()) throw fail('vision_unavailable', 'gateway not ready');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const response = await gatewayClient.fetch(gatewayClient.url(ROUTE), { method: 'POST', redirect: 'error', signal: controller.signal, timeoutMs: fetchTimeoutMs,
        headers: { 'content-type': 'application/json', ...gatewayClient.requestHeaders(), 'X-Xiaoxi-Billing-Feature': 'wechat' },
        body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 1200 }) });
      if (!response.ok) throw fail('vision_http_' + response.status, 'vision request failed');
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      try { return { answer: jsonOf(content), usage: payload?.usage || null }; }
      catch (error) { throw Object.assign(fail('vision_answer_invalid', 'answer is not JSON'), { raw: String(content || '').slice(0, 600),
        finish: payload?.choices?.[0]?.finish_reason || '', usage: payload?.usage || null }); }
    } finally { clearTimeout(timer); }
  }
  return {
    ready,
    readSearch: ({ image, query }) => ask(searchMessages({ image, query })),
    readTitle: ({ image }) => ask(titleMessages({ image })),
    async findSearchRow({ image, query, queryType, expectedName }) {
      const { answer, usage } = await ask(searchMessages({ image, query }));
      return { ...pickSearchRow(answer, { query, queryType, expectedName }), usage, rows: Array.isArray(answer?.rows) ? answer.rows.length : 0 };
    },
    async confirmTitle({ image, expectedName }) {
      const { answer, usage } = await ask(titleMessages({ image }));
      return { ...pickTitle(answer, expectedName), usage };
    }
  };
}

// 微信之眼: what the WeChat steps ask, each from a picture file our own steps took, every answer
// logged (outcome, time, tokens; never names). Absent or failing, the steps keep the old skip.
function createWechatEyes({ gatewayClient, logger, readFile = require('node:fs').readFileSync, vision = createWechatVisionCheck({ gatewayClient }) } = {}) {
  const image = (file) => 'data:image/png;base64,' + readFile(file).toString('base64');
  async function look(event, okCode, run) {
    const started = Date.now();
    const result = await Promise.resolve().then(run).catch((error) => ({ ok: false, reason: String(error?.code || 'vision_failed') }));
    const code = result.ok ? okCode : String(result.reason || 'vision_failed');
    logger?.event?.('active_touch', event, { outcome: code, elapsed_ms: Date.now() - started, rows_seen: Number(result.rows) || 0,
      input_tokens: Number(result.usage?.prompt_tokens) || 0, output_tokens: Number(result.usage?.completion_tokens) || 0 },
      { level: result.ok ? 'info' : 'warn', code });
    return result;
  }
  return {
    ready: vision.ready,
    searchRow: ({ file, query, queryType, expectedName }) => look('vision_rescue', 'vision_row_found',
      () => vision.findSearchRow({ image: image(file), query, queryType, expectedName })),
    chatTitle: ({ file, expectedName }) => look('vision_title', 'vision_title_confirmed',
      () => vision.confirmTitle({ image: image(file), expectedName }))
  };
}

module.exports = { ROUTE, MODEL, searchMessages, titleMessages, pickSearchRow, pickTitle, jsonOf, createWechatVisionCheck, createWechatEyes };
