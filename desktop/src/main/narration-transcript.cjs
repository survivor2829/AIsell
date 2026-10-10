const { pinyin } = require('pinyin-pro');
const normalize = text => Array.from(String(text || '')).filter(char => /[\p{L}\p{N}]/u.test(char)).map(char => char.toLowerCase()).join('');

// Frozen TTS and its approved copy may differ only in ASR's Han spelling.
// Preserve measured boundaries; never infer missing words or alter numbers/IDs.
function reconcileNarrationSpelling(utterances, script) {
  if (!Array.isArray(utterances)) return null;
  const expected = Array.from(normalize(script));
  const recognized = Array.from(normalize(utterances.map(item => item?.text || '').join('')));
  const phonemes = text => pinyin(text, { type: 'array', toneType: 'num', nonZh: 'spaced' });
  const wanted = phonemes(expected.join('')), heard = phonemes(recognized.join(''));
  if (!expected.length || expected.length !== recognized.length || wanted.length !== expected.length || heard.length !== recognized.length
      || expected.some((char, index) => char !== recognized[index]
        && (!/\p{Script=Han}/u.test(char) || !/\p{Script=Han}/u.test(recognized[index]) || wanted[index] !== heard[index]))) return null;
  const corrected = (text, start) => {
    let index = start;
    return Array.from(String(text || '')).map(char => /[\p{L}\p{N}]/u.test(char)
      ? (char.toLowerCase() === expected[index] ? (index++, char) : expected[index++]) : char).join('');
  };
  let cursor = 0;
  const alignedUtterances = utterances.map(item => {
    const start = cursor; cursor += normalize(item.text).length;
    let wordCursor = start;
    const words = Array.isArray(item.words) && normalize(item.words.map(word => word.text).join('')) === normalize(item.text)
      ? item.words.filter(word => normalize(word.text)).map(word => {
        const text = corrected(word.text, wordCursor); wordCursor += normalize(word.text).length;
        return { ...word, text };
      }) : item.words;
    return { ...item, text: corrected(item.text, start), ...(words ? { words } : {}) };
  });
  return { alignedUtterances, matchedCharacters: expected.length,
    phoneticCorrections: expected.filter((char, index) => char !== recognized[index]).length };
}
module.exports = { normalize, reconcileNarrationSpelling };
