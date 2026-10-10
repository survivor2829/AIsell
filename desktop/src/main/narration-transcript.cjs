const { pinyin } = require('pinyin-pro');
const normalize = text => Array.from(String(text || '')).filter(char => /[\p{L}\p{N}]/u.test(char)).map(char => char.toLowerCase()).join('');

function integerKey(text) {
  if (/^\d+$/u.test(text)) return `number:${BigInt(text)}`;
  const digits = '零一二三四五六七八九', units = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  text = text.replace(/〇/gu, '零').replace(/两/gu, '二');
  if (!/[十百千万亿]/u.test(text)) return `number:${BigInt(Array.from(text, c => digits.indexOf(c)).join(''))}`;
  if (/[一二三四五六七八九]{2}/u.test(text)) return `literal:${text}`;
  let total = 0, section = 0, digit = 0, previousUnit = Infinity;
  for (const char of text) {
    if (digits.includes(char)) { digit = digits.indexOf(char); continue; }
    const unit = units[char];
    if (unit >= 10000) {
      total = unit === 100000000 ? (total + section + digit) * unit : total + (section + digit) * unit;
      section = digit = 0; previousUnit = Infinity;
    }
    else {
      if (unit >= previousUnit) return `literal:${text}`;
      section += (digit || 1) * unit; digit = 0; previousUnit = unit;
    }
  }
  const value = total + section + digit;
  return Number.isSafeInteger(value) ? `number:${value}` : `literal:${text}`;
}

// Keep numbers as indivisible values. ASR may render 十五 as 15 or 三到四 as
// 3~4, but 15 must never match 50. Model identifiers retain their digit values.
function spokenTokens(text) {
  const tokens = Array.from(String(text || '').matchAll(/[零〇一二两三四五六七八九十百千万亿]+|\d+|\p{L}|[~～]/gu), match => ({ text: match[0], at: match.index }));
  for (const [index, token] of tokens.entries()) {
    token.key = /^[零〇一二两三四五六七八九十百千万亿\d]+$/u.test(token.text) ? integerKey(token.text) : token.text.toLowerCase();
    if (/^[~～]$/u.test(token.text) && /^number:/u.test(tokens[index - 1]?.key || '') && /^[零〇一二两三四五六七八九十百千万亿\d]+$/u.test(tokens[index + 1]?.text || '')) token.key = '到';
  }
  return tokens;
}

// Frozen TTS may differ in ASR spelling and equivalent integer notation.
// Preserve measured boundaries; never infer missing words or change values/IDs.
function reconcileNarrationSpelling(utterances, script) {
  if (!Array.isArray(utterances)) return null;
  const expected = spokenTokens(script);
  const recognized = spokenTokens(utterances.map(item => item?.text || '').join(''));
  const homophone = (a, b) => /^\p{Script=Han}$/u.test(a) && /^\p{Script=Han}$/u.test(b)
    && pinyin(a, { toneType: 'num' }) === pinyin(b, { toneType: 'num' });
  if (!expected.length || expected.length !== recognized.length
      || expected.some((token, index) => token.key !== recognized[index].key
        && (/^number:/u.test(token.key) || /^number:/u.test(recognized[index].key) || !homophone(token.text, recognized[index].text)))) return null;
  const corrected = (text, start) => {
    let cursor = 0, output = '';
    for (const [index, token] of spokenTokens(text).entries()) {
      const target = expected[start + index];
      output += text.slice(cursor, token.at) + (token.text.toLowerCase() === target.text.toLowerCase() ? token.text : target.text);
      cursor = token.at + token.text.length;
    }
    return output + text.slice(cursor);
  };
  let cursor = 0;
  const alignedUtterances = utterances.map(item => {
    const start = cursor; cursor += spokenTokens(item.text).length;
    let wordCursor = start;
    const words = Array.isArray(item.words) && JSON.stringify(item.words.flatMap(word => spokenTokens(word.text).map(t => t.key))) === JSON.stringify(spokenTokens(item.text).map(t => t.key))
      ? item.words.filter(word => spokenTokens(word.text).length).map(word => {
        const text = corrected(word.text, wordCursor); wordCursor += spokenTokens(word.text).length;
        return { ...word, text };
      }) : undefined;
    const sentence = { ...item }; delete sentence.words;
    return { ...sentence, text: corrected(item.text, start), ...(words ? { words } : {}) };
  });
  return { alignedUtterances, matchedCharacters: expected.length,
    phoneticCorrections: expected.filter((token, index) => token.key !== recognized[index].key).length,
    notationCorrections: expected.filter((token, index) => token.key === recognized[index].key
      && token.text.toLowerCase() !== recognized[index].text.toLowerCase()).length };
}
module.exports = { normalize, reconcileNarrationSpelling };
