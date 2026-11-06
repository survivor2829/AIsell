const assert = require('node:assert/strict');
const audio = require('./digital-human-audio.cjs');
const { selectVoiceReference } = require('./reference-human-media.cjs');

async function main() {
  assert.equal(audio.speechChunks('先说第一件事。再说第二件事。最后说第三件事。').length, 1);
  const timed = [{ text: '第一句', start_time: 100, end_time: 13000 }, { text: '第二句', start_time: 13200, end_time: 17100 }];
  const naturalSegments = audio.splitMeasuredSpeech(timed, 17.3);
  assert.equal(naturalSegments.length, 2);
  assert.equal(naturalSegments.reduce((sum, item) => sum + item.seconds, 0), 17.3, 'All real audio survives even when the target was 15 seconds.');
  assert.ok(naturalSegments.every((item) => item.seconds >= 2 && item.seconds <= 15));
  assert.throws(() => audio.splitMeasuredSpeech([{ text: '无分词时间的长句', start_time: 0, end_time: 21000 }], 21.2), /自然分段/);
  assert.equal(audio.splitScript('先说第一件事。再说第二件事。最后说第三件事。', 45).length, 3);
  assert.throws(() => audio.assertSpeechCoverage({ seconds: 11, speechStart: .1, speechEnd: 10.9, maxGapSeconds: .2 }, 15), /尚未提交视频/);
  assert.throws(() => audio.verifyTranscript([{ text: '漏了后面', end_time: 14500 }], '漏了后面完整的一句话。', 15), /不一致/);
  const numericSpeech = [{ text: '浦度CC1 Pro，15升，500毫米，3~4小时。', start_time: 100, end_time: 14500,
    words: [{ text: '浦度CC1 Pro', start_time: 100, end_time: 3000 }, { text: '15升', start_time: 3000, end_time: 6000 },
      { text: '500毫米', start_time: 6000, end_time: 9000 }, { text: '3~4小时', start_time: 9000, end_time: 14500 }] }];
  const preserved = JSON.stringify(numericSpeech);
  const alignedNumbers = audio.verifyTranscript(numericSpeech, '普渡CC1 Pro，十五升，五百毫米，三到四小时。', 15).alignedUtterances;
  assert.equal(alignedNumbers[0].text, '普渡CC1 Pro，十五升，五百毫米，三到四小时。');
  assert.deepEqual(alignedNumbers[0].words.map(word => [word.start_time, word.end_time]), numericSpeech[0].words.map(word => [word.start_time, word.end_time]));
  assert.equal(JSON.stringify(numericSpeech), preserved, 'Retain the original recognition receipt.');
  assert.throws(() => audio.verifyTranscript(numericSpeech, '普渡CC2 Pro，十五升，五百毫米，三到四小时。', 15), /不一致/);
  assert.throws(() => audio.verifyTranscript(numericSpeech, '普渡CC01 Pro，十五升，五百毫米，三到四小时。', 15), /不一致/);
  assert.throws(() => audio.verifyTranscript(numericSpeech, '普渡CC1 Pro，五十升，五百毫米，三到四小时。', 15), /不一致/);
  // 识别结果把「一万」写成「1万」：同一个数可以对上，换了数值（十万、一千、两万）仍然拦下
  const wan = [{ text: '凌晨2点，1万平车间没一个人。', start_time: 0, end_time: 14500 }];
  assert.ok(audio.verifyTranscript(wan, '凌晨两点，一万平车间没一个人。', 15));
  for (const changed of ['凌晨两点，十万平车间没一个人。', '凌晨两点，一千平车间没一个人。', '凌晨两点，两万平车间没一个人。'])
    assert.throws(() => audio.verifyTranscript(wan, changed, 15), /不一致/);
  // 真实失败任务：配音把「11月20、21、22」读成「11月20日、21、22」，品牌名同音字、四个→4个
  const dateSpeech = [{ text: '那就一定是喜联汇 AI 获客软件，4个 AI 员工。', start_time: 0, end_time: 7000 },
    { text: '11月20日、21、 22，现场实操。', start_time: 7200, end_time: 14500,
      words: [{ text: '11', start_time: 7200, end_time: 7500 }, { text: '月', start_time: 7500, end_time: 7700 }, { text: '20', start_time: 7700, end_time: 8000 },
        { text: '日', start_time: 8000, end_time: 8240 }, { text: '21', start_time: 8300, end_time: 8800 }, { text: '22', start_time: 8900, end_time: 9400 },
        { text: '现场实操', start_time: 9500, end_time: 14500 }] }];
  const dateScript = '那就一定是，玺联惠AI获客软件！四个AI员工，11月20、21、22，现场实操';
  const dated = audio.verifyTranscript(dateSpeech, dateScript, 15);
  assert.equal(dated.spokenDateSuffixes, 1);
  assert.equal(dated.alignedUtterances[0].text, '那就一定是玺联惠 AI 获客软件，四个 AI 员工。');
  // 包装要求对齐后的文字与确认文案逐字一致，所以放行的「日」不进字幕文字
  const packagingKey = text => Array.from(text).filter(char => /[\p{L}\p{N}]/u.test(char)).join('').toLowerCase();
  assert.equal(packagingKey(dated.alignedUtterances.map(item => item.text).join('')), packagingKey(dateScript));
  assert.equal(packagingKey(dated.alignedUtterances.flatMap(item => item.words || []).map(word => word.text).join('')), packagingKey('11月20、21、22，现场实操'));
  assert.equal(dated.alignedUtterances[1].words.length, 6);
  // 文案本身有「日活」，配音多读了日期的「日」
  assert.ok(audio.verifyTranscript([{ text: '11月20日日活翻倍。', start_time: 0, end_time: 14500 }], '11月20，日活翻倍。', 15));
  // 不是「数字+月」日期的位置，多出的「号」照样拦下
  assert.throws(() => audio.verifyTranscript([{ text: '包用3个月20号单起。', start_time: 0, end_time: 14500 }], '包用3个月20单起。', 15), /不一致/);
  assert.throws(() => audio.verifyTranscript([{ text: '每月20号结算。', start_time: 0, end_time: 14500 }], '每月20结算。', 15), /不一致/);
  // 识别把日期拆到两句时，相邻数字不会粘成一个数
  assert.ok(audio.verifyTranscript([{ text: '11月20', start_time: 0, end_time: 7000 }, { text: '21、22现场。', start_time: 7100, end_time: 14500 }], '11月20、21、22现场。', 15));
  assert.ok(audio.verifyTranscript(dateSpeech, dateScript.replace('20、', '20日、'), 15), 'Script that already says 日 still matches.');
  // 日期数字本身变了、或「日」不跟在「X月」日期后，照样拦下
  assert.throws(() => audio.verifyTranscript(dateSpeech, dateScript.replace('20、', '19、'), 15), /文案“.*”，配音读成“.*”/);
  assert.throws(() => audio.verifyTranscript([{ text: '每天20日用量。', start_time: 0, end_time: 14500 }], '每天20用量。', 15), /不一致/);
  assert.throws(() => audio.verifyTranscript([{ text: '漏了后面', end_time: 14500 }], '漏了后面完整的一句话。', 15), /文案“漏了后面完整的一句话。”，配音读成“漏了后面”/);
  const exact = '先看地面是否适合使用清洁机器人，再看现场需要清理什么污物，把现场情况发来一起安排合适的清洁方案。';
  assert.throws(() => audio.verifyTranscript([{ text: exact.replace('地面', '地棉'), start_time: 0, end_time: 14500 }], exact, 15), /不一致/, 'Even one substitution must stop before paid video; packaging needs exact anchors.');
  assert.throws(() => audio.verifyTranscript([{ text: 'CC1 Pro', start_time: 0, end_time: 14500 }], 'ＣＣ1 Pro', 15), /不一致/, 'Packaging does not normalize compatibility characters.');
  assert.equal(audio.verifyTranscript([{ text: 'CC1 PRO，地面清洁。', start_time: 0, end_time: 14500 }], 'cc1 pro：地面清洁！✨', 15).editDistance, 0);
  const sameSpeech = [{ text: '普度 CC1PRO洗扫推尘一体。', start_time: 200, end_time: 3240,
    words: [{ text: '普度', start_time: 200, end_time: 480 }, { text: ' ', start_time: -1, end_time: -1 },
      { text: 'CC1PRO洗扫推尘一体。', start_time: 720, end_time: 3240 }] }];
  const aligned = audio.verifyTranscript(sameSpeech, '普渡CC1 Pro，洗扫推尘一体。', 3.36);
  assert.equal(aligned.phoneticCorrections, 1);
  assert.equal(aligned.alignedUtterances[0].words[0].text, '普渡');
  assert.equal(aligned.alignedUtterances[0].words[0].end_time, 480);
  assert.equal(aligned.alignedUtterances[0].words.length, 2);
  assert.equal(sameSpeech[0].text, '普度 CC1PRO洗扫推尘一体。', 'Original supplier receipt stays untouched');
  assert.throws(() => audio.verifyTranscript([{ text: '普度CC2 Pro', start_time: 0, end_time: 3000 }], '普渡CC1 Pro', 3.3), /不一致/);
  assert.throws(() => audio.verifyTranscript([{ text: '先看地面', start_time: 0, end_time: 8000 }, { text: '再看污物', start_time: 7900, end_time: 14500 }], '先看地面，再看污物。', 15), /重叠/);
  const pcm = Buffer.alloc(15 * 16000 * 2);
  for (let i = 1600; i < 14.5 * 16000; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 15) * 10000), i * 2);
  const measured = audio.analyzePcm(pcm); audio.assertSpeechCoverage(measured, 15);
  assert.ok(measured.speechEnd >= 14.5 && measured.speechStart <= .12);
  const reference = Buffer.alloc(30 * 16000 * 2);
  pcm.copy(reference, 10 * 16000 * 2);
  const selected = selectVoiceReference(reference);
  assert.ok(selected.startSeconds >= 9.8 && selected.activeSeconds >= 14, 'Skip the silent opening and select a continuous active excerpt.');
  assert.ok(selected.seconds >= 10 && selected.seconds <= 20);
  assert.equal(selected.speakerAndBackgroundVerified, false, 'Energy cannot prove that a clip has only one speaker or no music.');
  assert.throws(() => selectVoiceReference(Buffer.alloc(12 * 16000 * 2)), { code: 'reference_voice_silent' });
  const overloaded = Buffer.alloc(12 * 16000 * 2);
  for (let i = 0; i < overloaded.length; i += 2) overloaded.writeInt16LE(32767, i);
  assert.throws(() => selectVoiceReference(overloaded), { code: 'reference_voice_clipped' });
  audio.verifyRecordingTranscript([{ text: '实际录音', start_time: 3000, end_time: 7000 }], 15);
  audio.assertSpeechCoverage({ seconds: 15, speechStart: 3, speechEnd: 7, maxGapSeconds: 2 }, 15, 0, { allowNaturalPauses: true });
  console.log('digital-human audio self-check passed: natural boundaries, exact transcript anchors, phonetic alignment without touching receipts, speech coverage, voice reference selection, uploaded actual speech');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
