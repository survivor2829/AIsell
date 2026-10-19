// Published estimates and observed usage are separate from authorization caps.
// Never call an estimate a settled bill or reinterpret an old task's quote.
function estimate(script, seconds, prices, coverPrices, enabled = true, minimum = Math.min(30, seconds)) {
  if (!enabled || !(prices.voiceCnyPer10kChars > 0 && prices.asrCnyPerHour > 0)) return undefined;
  const characters = [...script].reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0);
  const voiceCny = characters * prices.voiceCnyPer10kChars / 10000;
  const coverCny = coverPrices ? (coverPrices.estimatedImageUsd || coverPrices.imageUsd) * coverPrices.fxCnyPerUsd : 0;
  const minimumSeconds = Math.min(minimum, seconds);
  const total = (duration) => voiceCny + duration * (prices.videoCnyPerSecond + prices.asrCnyPerHour / 3600) + coverCny;
  return { minimumCny: total(minimumSeconds), maximumCny: total(seconds), minimumSeconds, maximumSeconds: seconds,
    characters, voiceCny, coverCny, voiceCnyPer10kChars: prices.voiceCnyPer10kChars, asrCnyPerHour: prices.asrCnyPerHour,
    voiceSource: prices.voiceSource, asrSource: prices.asrSource, ratesCheckedOn: prices.checkedOn,
    coverConditional: Boolean(coverPrices?.estimatedImageUsd), fxCnyPerUsd: coverPrices?.fxCnyPerUsd };
}
function usage(task) {
  const operations = task.operations || {};
  const voice = operations.voice, characters = voice?.response?.usage?.characters;
  return { settledCny: null, audioSeconds: task.actualDurationSeconds || null,
    voiceCharacters: Number.isFinite(characters) ? characters : null,
    voiceReused: voice?.reused === true || Boolean(task.sourceTaskId),
    operations: Object.entries(operations).map(([stage, op]) => ({ stage,
      state: op.reused ? 'reused' : op.rejected ? 'failed' : op.response ? 'received' : 'unknown' })) };
}
module.exports = { estimate, usage };
