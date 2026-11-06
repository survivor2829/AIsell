// Text pasted from WeChat/Moments carries emoji and sticker codes. Voice synthesis
// reads some of them as extra words (2026-11-06: "——🤖" became "明明", "✅…——"
// became "满陇"), so the transcript check then rightly refuses to buy the video.
// Clean only what is never meant to be spoken; keep every real word.
function cleanSpokenScript(value) {
  return String(value || '')
    .replace(/\r\n?/gu, '\n')
    // WeChat sticker codes such as [月亮] [呲牙] [OK].
    .replace(/\[[\p{Script=Han}A-Za-z]{1,6}\]/gu, '')
    // Emoji, flags, keycap marks, variation selectors and joiners.
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️‍⃣]/gu, '')
    // Dashes are read aloud or as filler; a pause is what the writer meant.
    .replace(/[—–]+|-{2,}/gu, '，')
    // "清洁机器人+AI" is read "加"; write it so the check compares the same words.
    .replace(/(\S)[ \t]*\+[ \t]*(?=\S)/gu, '$1加')
    // "11月20/21/22" (three or more numbers) is a list; "3/5" stays as written.
    .replace(/\d+(?:[ \t]*\/[ \t]*\d+){2,}/gu, (list) => list.split('/').map((part) => part.trim()).join('、'))
    .split('\n').map((line) => line.replace(/[ \t]{2,}/gu, ' ').trim()
      // A pause mark left at the start of a line, or doubled with another mark.
      .replace(/^[，、；：]+/u, '').replace(/[，、]+(?=[，、。！？；：!?])/gu, '').replace(/([。！？!?])[，、]+/gu, '$1'))
    // One paragraph, as before; a line that ends without a mark gets a pause so sentences do not run together.
    .filter(Boolean).reduce((text, line) => !text ? line : /[。！？!?，、；：…,.;:]$/u.test(text) ? text + line : `${text}，${line}`, '').trim();
}

module.exports = { cleanSpokenScript };
