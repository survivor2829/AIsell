const { pinyin } = require('pinyin-pro');
const normalize = text => Array.from(String(text || '')).filter(char => /[\p{L}\p{N}]/u.test(char)).map(char => char.toLowerCase()).join('');

function integerKey(text) {
  if (/^\d+$/u.test(text)) return `number:${BigInt(text)}`;
  // ASR writes 一万 as 1万 and 三千 as 3千: digits times one magnitude unit.
  const mixed = text.match(/^(\d+)([千万亿])$/u);
  if (mixed) return `number:${BigInt(mixed[1]) * BigInt({ 千: 1000, 万: 10000, 亿: 100000000 }[mixed[2]])}`;
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
  const source = String(text || '');
  const tokens = Array.from(source.matchAll(/\d+[千万亿](?![零〇一二两三四五六七八九十百千万亿\d])|[零〇一二两三四五六七八九十百千万亿]+|\d+|\p{L}|[~～]/gu), match => ({ text: match[0], at: match.index }));
  for (const [index, token] of tokens.entries()) {
    token.key = /^[零〇一二两三四五六七八九十百千万亿\d]+$/u.test(token.text) ? integerKey(token.text) : token.text.toLowerCase();
    if (/^number:/u.test(token.key) && /[A-Za-z]/u.test(source.slice(Math.max(0, token.at - 1), token.at) + source.slice(token.at + token.text.length, token.at + token.text.length + 1))) token.key = `identifier:${token.text}`;
    if (/^[~～]$/u.test(token.text) && /^number:/u.test(tokens[index - 1]?.key || '') && /^[零〇一二两三四五六七八九十百千万亿\d]+$/u.test(tokens[index + 1]?.text || '')) token.key = '到';
  }
  return tokens;
}

const homophone = (a, b) => /^\p{Script=Han}$/u.test(a) && /^\p{Script=Han}$/u.test(b)
  && pinyin(a, { toneType: 'num' }) === pinyin(b, { toneType: 'num' });
const sameSpoken = (a, b) => a.key === b.key
  || (!/^(number|identifier):/u.test(a.key) && !/^(number|identifier):/u.test(b.key) && homophone(a.text, b.text));

const isNumber = token => /^number:/u.test(token?.key || '');

// TTS reads a date list such as 11月20、21、22 as 11月20日、21、22. Only a
// spoken 日/号 after a day number in a "<number>月<day>" list may be skipped
// (not 3个月20号 or 每月20号); the numbers themselves must still match.
function spokenDateSuffix(tokens, index) {
  if (!/^[日号號]$/u.test(tokens[index]?.text || '') || !isNumber(tokens[index - 1])) return false;
  for (let back = index - 2; back >= 0; back -= 1) {
    if (tokens[back].text === '月') return isNumber(tokens[back - 1]);
    if (!isNumber(tokens[back]) && !/^[日号號]$/u.test(tokens[back].text)) return false;
  }
  return false;
}

// Maps each recognized token to its script token, or -1 for a skipped date
// suffix. On failure, reports where the two first diverge.
function alignTokens(expected, recognized) {
  const map = [];
  let i = 0;
  for (let j = 0; j < recognized.length; j += 1) {
    const suffix = spokenDateSuffix(recognized, j);
    // 11月20日活 vs script 11月20，日活: the spoken 日 is the suffix when the
    // next heard token, not this one, continues the script.
    const skipFirst = suffix && recognized[j + 1] && i < expected.length && sameSpoken(expected[i], recognized[j + 1])
      && !(expected[i + 1] && sameSpoken(expected[i + 1], recognized[j + 1]));
    if (!skipFirst && i < expected.length && sameSpoken(expected[i], recognized[j])) { map.push(i); i += 1; }
    else if (suffix) map.push(-1);
    else return { expectedAt: i, recognizedAt: j };
  }
  return i === expected.length ? { map } : { expectedAt: i, recognizedAt: recognized.length };
}

// Utterances are joined with a line break so digits at the end of one
// sentence never merge with digits starting the next.
function tokenize(utterances, script) {
  const heard = utterances.map(item => item?.text || '').join('\n');
  return { heard, expected: spokenTokens(script), recognized: spokenTokens(heard) };
}

// A short excerpt starting just before the first difference, cut on code points.
const around = (text, tokens, index) => {
  const at = index < tokens.length ? tokens[index].at : text.length;
  const before = Array.from(text.slice(0, at)).slice(-4).join(''), after = Array.from(text.slice(at)).slice(0, 10).join('');
  return (before + after).replace(/\s+/gu, '');
};

// Says where the voice and the script first differ, for a fixable error message.
function describeNarrationMismatch(utterances, script) {
  if (!Array.isArray(utterances)) return null;
  const { heard, expected, recognized } = tokenize(utterances, script);
  if (!expected.length) return null;
  const aligned = alignTokens(expected, recognized);
  if (aligned.map) return null;
  return { expected: around(String(script || ''), expected, aligned.expectedAt), heard: around(heard, recognized, aligned.recognizedAt) };
}

// Frozen TTS may differ in ASR spelling and equivalent integer notation.
// Preserve measured boundaries; never infer missing words or change values/IDs.
// A skipped date suffix keeps its timing but is removed from the text, because
// packaging requires the aligned text to equal the confirmed script exactly.
function reconcileNarrationSpelling(utterances, script) {
  if (!Array.isArray(utterances)) return null;
  const { expected, recognized } = tokenize(utterances, script);
  if (!expected.length) return null;
  const { map } = alignTokens(expected, recognized);
  if (!map) return null;
  const corrected = (text, start) => {
    let cursor = 0, output = '';
    for (const [index, token] of spokenTokens(text).entries()) {
      const target = expected[map[start + index]];
      output += text.slice(cursor, token.at) + (!target ? '' : token.text.toLowerCase() === target.text.toLowerCase() ? token.text : target.text);
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
      }).filter(word => normalize(word.text)) : undefined;
    const sentence = { ...item }; delete sentence.words;
    return { ...sentence, text: corrected(item.text, start), ...(words ? { words } : {}) };
  });
  const pairs = map.map((target, index) => [expected[target], recognized[index]]).filter(([token]) => token);
  return { alignedUtterances, matchedCharacters: expected.length,
    phoneticCorrections: pairs.filter(([token, heard]) => token.key !== heard.key).length,
    notationCorrections: pairs.filter(([token, heard]) => token.key === heard.key
      && token.text.toLowerCase() !== heard.text.toLowerCase()).length,
    spokenDateSuffixes: map.filter(target => target < 0).length };
}
module.exports = { normalize, reconcileNarrationSpelling, describeNarrationMismatch };
