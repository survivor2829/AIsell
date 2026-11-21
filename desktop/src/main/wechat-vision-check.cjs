// AI 看图兜底 (user 2026-11-21: "more intelligence, less structure" for 精准触达). The rule-based reader
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
  const system = `你在看微信 Windows 版搜索时弹出的下拉面板的截图。下拉面板是浮在最上层、带阴影边框的白色面板；面板外面（后面）露出来的聊天列表不是搜索结果。
面板里按分组排列：分组标题是灰色小字（联系人、最常使用、群聊、聊天记录、公众号、搜索网络结果等）。联系人和群聊的行左边有头像图片；「搜索网络结果」下面的行左边是放大镜图标、没有头像，那些只是搜索建议。
按从上到下的顺序，列出截图里每一个结果行（分组标题本身不算）：
- name：行里大字显示的名字，一字不差照抄，包括符号和空格；
- wechat_id：名字下面的灰色小字如果写的是「微信号：xxx」，照抄 xxx（字母、数字、下划线、横线逐个看清，大小写照原样，不多不少）；写的是「昵称」「备注」「地区」或别的，或者没有小字，都留空；
- group：这一行所在分组的标题（联系人、最常使用、群聊、聊天记录、公众号、搜索网络结果、其他）；
- avatar：这一行左边是头像图片为 true，是放大镜或其他图标为 false；
- in_panel：这一行在下拉面板里为 true，在面板外面露出来的列表里为 false；
- x、y：这一行名字中心点在截图里的位置，用 0 到 1000 的相对坐标；
- unsure：名字或微信号里有任何一个字看不清、被挡住或被截断时为 true，不要猜。
和搜索词相同的部分会显示成绿色，照常抄出。
只输出 JSON，不要解释：{"rows":[{"name":"","wechat_id":"","group":"","avatar":true,"in_panel":true,"x":0,"y":0,"unsure":false}]}`;
  return [{ role: 'system', content: system },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: `搜索框里输入的是：${query}` }] }];
}

// The chat that is open: the title above the messages.
function titleMessages({ image }) {
  const system = `你在看微信 Windows 版聊天窗口顶部的截图。读出当前打开的聊天的标题（对方的名字或群名），一字不差照抄，看不清的字不要猜，看不清就把 unsure 设为 true。没有打开任何聊天时 title 为空。
只输出 JSON：{"title":"","unsure":false}`;
  return [{ role: 'system', content: system },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: '当前打开的是谁的聊天？' }] }];
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
function titleMatches(answer, expectedName) {
  const title = fold(answer?.title);
  return { ok: Boolean(title) && answer?.unsure !== true && title === fold(expectedName), read: Boolean(title) };
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
      return { ...titleMatches(answer, expectedName), usage };
    }
  };
}

module.exports = { ROUTE, MODEL, searchMessages, titleMessages, pickSearchRow, titleMatches, jsonOf, createWechatVisionCheck };
