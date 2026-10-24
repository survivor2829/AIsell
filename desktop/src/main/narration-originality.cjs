// 仿写稿的原创度：正文里有多少字落在「和参考连续 8 个字以上相同」的片段里。
// 算法与云端写稿（server/provider-gateway/service.py 的 _narration_originality）一致，
// 云端是旧版本、没有返回原创度时，桌面端照样能算出来并标出不达标。
const RUN = 8;
const LIMIT = 0.15;
const PARTS = ['钩子', '痛点', '方案', '证据', '行动号召'];

const chars = (text) => String(text || '').replace(/[^一-鿿A-Za-z0-9]/gu, '').toLowerCase();

function overlap(script, reference) {
  const source = chars([reference?.title, reference?.body].filter(Boolean).join(' ')), text = chars(script);
  if (text.length < RUN || source.length < RUN) return { ratio: 0, fragments: [] };
  const grams = new Set();
  for (let i = 0; i + RUN <= source.length; i += 1) grams.add(source.slice(i, i + RUN));
  const covered = new Array(text.length).fill(false);
  for (let i = 0; i + RUN <= text.length; i += 1) if (grams.has(text.slice(i, i + RUN))) covered.fill(true, i, i + RUN);
  const fragments = [];
  let start = -1;
  for (let i = 0; i <= text.length; i += 1) {
    if (covered[i] && start < 0) start = i;
    else if (!covered[i] && start >= 0) { fragments.push(text.slice(start, i).slice(0, 40)); start = -1; }
  }
  return { ratio: covered.filter(Boolean).length / text.length, fragments: fragments.slice(0, 8) };
}

// 有参考时才有原创度；以本地按最终正文算出的数字为准，重写次数沿用云端回执。
function scriptOriginality(script, reference, reported) {
  if (!reference || !(reference.title || reference.body)) return null;
  const { ratio, fragments } = overlap(script, reference);
  const attempts = reported?.attempts === 2 ? 2 : 1;
  // 向上取整：不达标的 0.1504 不会显示成正好 0.15。
  return { overlapRatio: Math.ceil(ratio * 1000) / 1000, limit: LIMIT, attempts, passed: ratio <= LIMIT, fragments };
}

// 结构拆解只是给用户看的说明，格式不对就丢掉，不影响已经付费的正文。
function scriptStructure(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).filter((item) => item && PARTS.includes(item.part) && typeof item.method === 'string' && item.method.trim())
    .map((item) => ({ part: item.part, method: item.method.trim().slice(0, 40) }));
}

module.exports = { overlap, scriptOriginality, scriptStructure, RUN, LIMIT, PARTS };
