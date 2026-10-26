const assert = require('node:assert/strict');
const plan = require('../../remotion-packaging/narration-plan.cjs');

// 识别结果常常一个字一个「词」：模拟这种逐字时间戳
const cue = (text, startMs = 0, perChar = 250) => {
  const chars = [...text.replace(/[，。！？]/gu, '')];
  return { text, startMs, endMs: startMs + chars.length * perChar, words: chars.map((t, i) => ({ text: t, startMs: startMs + i * perChar, endMs: startMs + (i + 1) * perChar })) };
};

// 1. 字幕分页：遇到标点就换页、一屏不跨句；长分句均分，只在词与词之间切，不留一两个字的尾巴
const pages = plan.pages([cue('窄了效率上不去，最后看垃圾箱容量大了少倒几次。'), cue('选清洁设备，先看续航能不能干满八小时，再看清扫宽度。', 6000)], 9, []);
const texts = pages.map((p) => p.text);
assert.deepEqual(texts.slice(0, 3), ['窄了效率上不去', '最后看垃圾箱容量', '大了少倒几次']);
assert.ok(!texts.some((t) => t.includes('不去最后')), '不跨标点');
assert.ok(texts.every((t) => [...t].length >= 3), `没有一两个字的尾巴：${texts.join(' / ')}`);
assert.ok(!texts.some((t) => /^箱|垃$|圾$/u.test(t)), '「垃圾箱」不会被切开');
assert.equal(pages[0].end, 'clause'); assert.equal(pages[2].end, 'sentence');
assert.deepEqual(plan.pages([cue('最后看垃圾箱容量大了少倒几次。')], 12, []).map((p) => p.text), ['最后看垃圾箱容量大了少倒几次'], '差一点就放得下的分句整句一页');
// 重点词不被拆开
assert.ok(plan.pages([cue('我们这款七十公分刷头，三十五升垃圾箱。')], 9, ['七十公分刷头']).some((p) => p.text.includes('七十公分刷头')));
// 没有可靠的逐字时间时，不编造时间，整句一页
assert.equal(plan.pages([{ text: '凌晨两点，一万平车间没一个人。', startMs: 0, endMs: 3000, words: [{ text: '凌晨', startMs: 0, endMs: 400 }] }], 9, []).length, 1);

// 2. 包装轮换：连续五条，相邻两条版式不同、最近三条配色不同、相邻转场不同、镜头节奏交替
const script = '选清洁设备，先看续航能不能干满八小时，再看清扫宽度。别光听我说，按这三点去比。';
const visual = { status: 'measured', version: 'test', union: { x: .3, right: .7, y: .12, bottom: .6 } };
const cues = [cue(script.slice(0, 26)), cue(script.slice(26), 8000)];
const recent = [];
for (let n = 0; n < 5; n += 1) {
  const built = plan.buildPlan({ id: `rh_${n}`, script, emphasisPhrases: ['干满八小时', '按这三点去比'] }, visual, cues, false, recent.slice());
  plan.validatePlan(built, built.templateId);
  if (recent[0]) {
    assert.notEqual(built.templateId, recent[0].templateId, `第 ${n + 1} 条和上一条版式不同`);
    assert.notEqual(built.variant.transition, recent[0].variant.transition, '转场不同');
    assert.notEqual(built.variant.rhythm, recent[0].variant.rhythm, '镜头节奏交替');
  }
  assert.ok(!recent.slice(0, 3).some((r) => r.variant.palette === built.variant.palette), '最近三条配色不重复');
  recent.unshift({ templateId: built.templateId, variant: built.variant });
}
// 报价时定下的组合，出片时（final）保持不变
const quoted = plan.buildPlan({ id: 'rh_q', script, emphasisPhrases: ['干满八小时', '按这三点去比'] }, visual, cues, false, recent);
const final = plan.buildPlan({ id: 'rh_q', script, emphasisPhrases: ['干满八小时', '按这三点去比'], packagingPlan: quoted }, visual, cues, true, []);
assert.deepEqual([final.templateId, final.variant], [quoted.templateId, quoted.variant]);
// 手动选的版式不被轮换改掉
assert.equal(plan.buildPlan({ id: 'rh_m', script, packagingMode: 'manual', captionStyleId: 'minimal_v4' }, visual, cues, false, [{ templateId: 'minimal_v4', variant: quoted.variant }]).templateId, 'minimal_v4');

// 3. 镜头推拉：在句子结束处换景别；以下巴为基准放大，脸的下沿不动（压不到字幕），推镜看得出来
const camera = quoted.camera;
assert.ok(camera.shots.length >= 2, '至少换一次景别');
assert.deepEqual([camera.focusX, camera.focusY], [.5, .6], '以下巴为基准');
assert.ok(quoted.layout.top >= .6 * 1920, '字幕在脸下方');
assert.ok(Math.max(...camera.shots.map((s) => s.scale)) >= 1.2, '近景明显放大');
assert.ok(camera.shots.every((s) => .6 - (.6 - .12) * s.scale >= -.05 - 1e-9), '放大后头顶最多裁掉一点额头');
assert.ok(camera.shots.every((s, i) => !i || s.startMs > camera.shots[i - 1].startMs));
const tight = plan.buildPlan({ id: 'rh_t', script }, { ...visual, union: { x: .3, right: .7, y: .12, bottom: .66 } }, cues);
assert.ok(tight.camera.shots.every((s) => s.scale >= 1 && s.scale <= 1.3));

// 4. 花字：放在脸旁边空着的一侧，不压脸；两侧太窄就不放
assert.ok(quoted.stickers.length >= 1 && quoted.stickers.length <= 2);
for (const s of quoted.stickers) {
  assert.ok(s.width <= .3 * 1080, '花字宽度不超过脸旁边的空位');
  assert.equal(quoted.pages.find((p) => p.startMs === s.startMs).emphasisMode, 'inline', '同屏字幕只做行内高亮，不重复放大');
}
assert.deepEqual(plan.buildPlan({ id: 'rh_w', script, emphasisPhrases: ['干满八小时'] }, { ...visual, union: { x: .15, right: .85, y: .12, bottom: .6 } }, cues).stickers, []);

// 5. 校验：坏的组合、越界的镜头和花字都不放行
assert.throws(() => plan.validatePlan({ ...quoted, variant: { ...quoted.variant, palette: 'neon' } }, quoted.templateId));
assert.throws(() => plan.validatePlan({ ...quoted, camera: { ...quoted.camera, shots: [{ startMs: 0, scale: 2 }] } }, quoted.templateId));
assert.throws(() => plan.validatePlan({ ...quoted, stickers: [{ ...quoted.stickers[0], rotate: 45 }] }, quoted.templateId));
plan.validatePlan({ ...quoted, variant: undefined, camera: undefined, stickers: undefined }, quoted.templateId);

console.log('narration plan self-check passed: word and punctuation page breaks, rotating layout/palette/transition/rhythm, frozen at final, face-safe camera zoom, side stickers, plan validation');
