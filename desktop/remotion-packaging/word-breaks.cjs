// 中文词边界：系统分词 + 行业词表 + 「数字+单位」整体 + 额外不拆的词（如稿子里的重点词）。
// 字幕分页、封面标题用这里；NarrationLayoutV4.tsx 的折行用同一份词表和同样的规则。
const { words: GLOSSARY } = require('./word-glossary.json');

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
const NUMBER_WITH_UNIT = /[0-9０-９.零〇一二两三四五六七八九十百千万亿半几]+(?:万平|平方|平米|小时|分钟|公分|厘米|毫米|公斤|升|个|台|次|天|年|元|块|倍|人|米|点)/gu;

// 不能从中间断开的片段，按码点位置 [start, end)。
function protectedSpans(text, extra = []) {
  const chars = Array.from(text), joined = chars.join(''), spans = [];
  const codePoint = (index) => Array.from(joined.slice(0, index)).length;
  for (const word of [...GLOSSARY, ...extra.filter(Boolean)]) {
    for (let at = joined.indexOf(word); at >= 0; at = joined.indexOf(word, at + 1)) spans.push([codePoint(at), codePoint(at) + Array.from(word).length]);
  }
  for (const match of joined.matchAll(NUMBER_WITH_UNIT)) spans.push([codePoint(match.index), codePoint(match.index) + Array.from(match[0]).length]);
  return spans;
}

// 可以断开的位置（码点数，表示「前面这么多个字之后」），不含 0 和全长。
function wordBoundaries(text, extra = []) {
  const value = String(text || ''), length = Array.from(value).length, ends = new Set();
  let at = 0;
  for (const part of segmenter ? Array.from(segmenter.segment(value), (piece) => piece.segment) : Array.from(value)) { at += Array.from(part).length; ends.add(at); }
  for (const [start, end] of protectedSpans(value, extra)) for (let inner = start + 1; inner < end; inner += 1) ends.delete(inner);
  ends.delete(0); ends.delete(length);
  return ends;
}

module.exports = { wordBoundaries, protectedSpans, GLOSSARY };
