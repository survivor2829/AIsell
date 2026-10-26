const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planBigtypeCover, splitTitle, bigtypeFilter, coverTexts, renderBigtypeCover, WIDTH, HEIGHT } = require('./bigtype-cover.cjs');

// 断行：5 字以内一行，10 字以内两行，最多三行；优先在标点后断，标点不上封面
assert.deepEqual(splitTitle('先试再买'), ['先试再买']);
assert.deepEqual(splitTitle('物业别再招保洁了'), ['物业别再', '招保洁了']);
assert.deepEqual(splitTitle('买还是租？算完这笔账'), ['买还是租', '算完这笔账']);
assert.equal(splitTitle('一二三四五六七八九十甲乙').length, 3);

const portrait = { width: 1080, height: 1920 };
const plan = planBigtypeCover({ title: '物业别再招保洁了', subtitle: '一台顶六个人，真的', tags: ['洗地机', '物业降本', '可租可买', '多余的标签'], source: portrait });
// 最长一行占满约九成宽度，不会超出画面
assert.ok(4 * plan.fontSize <= WIDTH * 0.9 && 4 * (plan.fontSize + 1) > WIDTH * 0.9);
assert.equal(plan.subtitle.chars.length, 8, '副标题最多 8 个字');
assert.deepEqual(plan.tags, ['洗地机', '物业降本', '可租可买'], '标签最多 3 个');
assert.ok(plan.subtitle.y + plan.subtitle.chars.length * plan.subtitle.step < HEIGHT - plan.tagBar, '竖排副标题不压到底部标签条');
assert.throws(() => planBigtypeCover({ title: '  ', source: portrait }), { code: 'bigtype_title_required' });
assert.throws(() => planBigtypeCover({ title: '一二三四五六七八九十甲乙丙', source: portrait }), { code: 'bigtype_title_long' });
assert.throws(() => planBigtypeCover({ title: '先试再买', source: { width: 0, height: 10 } }), { code: 'bigtype_source_invalid' });

// 人物画面：裁切框始终在画面内；有人脸框时脸的中心落在画面上部，靠边的脸也不越界
for (const face of [null, { x: 0.4, y: 0.1, right: 0.6, bottom: 0.25 }, { x: 0.9, y: 0.9, right: 1, bottom: 1 }, { x: 0, y: 0, right: 0.1, bottom: 0.05 }]) {
  for (const source of [portrait, { width: 1920, height: 1080 }, { width: 1122, height: 1402 }]) {
    const p = planBigtypeCover({ title: '先试再买', source, face }).photo;
    assert.ok(p.scaledW >= WIDTH && p.scaledH >= p.height);
    assert.ok(p.cropX >= 0 && p.cropX + WIDTH <= p.scaledW && p.cropY >= 0 && p.cropY + p.height <= p.scaledH, JSON.stringify({ face, source, p }));
  }
}
const centered = planBigtypeCover({ title: '先试再买', source: portrait, face: { x: 0.4, y: 0.3, right: 0.6, bottom: 0.42 } });
const faceCenter = 0.36 * centered.photo.scaledH - centered.photo.cropY;
assert.ok(Math.abs(faceCenter - centered.photo.height * 0.38) <= 1, '脸的中心落在人物画面 38% 高度处');
const moving = planBigtypeCover({ title: '先试再买', source: portrait, face: { x: 0.07, y: 0.22, right: 1, bottom: 0.8 } }).photo;
assert.ok(0.22 * moving.scaledH - moving.cropY >= moving.height * 0.19, '人一直在动、人脸范围很大时，头顶上方留出空间，不切头');

// 用户写的文字只进临时文本文件，滤镜里只有文件路径，引号、冒号、百分号都不会被当成滤镜语法
const tricky = planBigtypeCover({ title: "别信'50%'省钱:说法", subtitle: '注意\'引号', tags: ['a:b'], source: portrait });
const filter = bigtypeFilter(tricky, 'C:\\Fonts\\noto.ttf', (name) => `C:\\tmp\\${name}.txt`);
assert.ok(!filter.includes('50%') && !filter.includes("别信") && !filter.includes('a:b'));
assert.match(filter, /fontfile='C\\:\/Fonts\/noto\.ttf'/);
assert.match(filter, /textfile='C\\:\/tmp\/title-0\.txt':expansion=none/);
assert.equal(Object.values(coverTexts(tricky)).join(''), [...tricky.lines, ...tricky.subtitle.chars, tricky.tags.join('   |   ')].join(''));

(async () => {
  // 渲染：写好文本文件交给 ffmpeg；先写到临时文件，成功后再换成正式文件，临时目录用完即删
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigtype-check-'));
  const font = path.join(dir, 'font.ttf'); fs.writeFileSync(font, 'x');
  const target = path.join(dir, 'cover.jpg');
  let seen;
  const run = async (bin, args) => {
    const vf = args[args.indexOf('-vf') + 1];
    const files = [...vf.matchAll(/textfile='([^']+)'/g)].map((m) => m[1].replace(/\\:/g, ':'));
    seen = { bin, args, texts: files.map((file) => fs.readFileSync(file, 'utf8')) };
    fs.writeFileSync(args.at(-1), 'jpeg');
  };
  const before = new Set(fs.readdirSync(os.tmpdir()));
  const result = await renderBigtypeCover({ ffmpegPath: 'ffmpeg-test', source: 'person.mp4', seconds: 3.5, sourceSize: portrait, title: '买还是租？算完这笔账', subtitle: '八成物业选错', tags: ['洗地机租赁'], fontFile: font, target, run });
  assert.equal(seen.bin, 'ffmpeg-test');
  assert.deepEqual(seen.args.slice(seen.args.indexOf('-ss'), seen.args.indexOf('-ss') + 4), ['-ss', '3.5', '-i', 'person.mp4']);
  assert.deepEqual(seen.texts, ['买还是租', '算完这笔账', ...'八成物业选错', '洗地机租赁']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'jpeg');
  assert.equal(result.file, target);
  assert.ok(!fs.readdirSync(os.tmpdir()).some((name) => !before.has(name) && name.startsWith('xiaoxi-bigtype-') && fs.existsSync(path.join(os.tmpdir(), name, 'title-0.txt'))), '临时文字文件已清理');
  await assert.rejects(renderBigtypeCover({ source: 'x', sourceSize: portrait, title: '先试', fontFile: path.join(dir, 'missing.ttf'), target, run }), { code: 'bigtype_font_missing' });
  await assert.rejects(renderBigtypeCover({ source: 'x', sourceSize: portrait, title: '先试', fontFile: font, target: path.join(dir, 'empty.jpg'), run: async () => {} }), { code: 'bigtype_render_failed' });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('bigtype cover self-check passed: title line breaks, width fit, text limits, face-aware crop inside frame, user text only via text files, atomic local render');
})().catch((error) => { console.error(error); process.exit(1); });
