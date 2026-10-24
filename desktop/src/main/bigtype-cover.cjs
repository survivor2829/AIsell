// 大字封面：本地用 ffmpeg 合成，不调用任何付费生图。
// 版式（3:4，1080×1440）：上方品牌色块放满宽主标题（白黄撞色），下方是人物画面（按人脸位置裁，脸不被字压住），
// 右侧竖排副标题，底部深色标签条。没有抠像模型，所以人物保留原画面背景，不做真抠像。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const W = 1080, H = 1440;
const LIMITS = { title: 12, subtitle: 8, tag: 8, tags: 3 };
const COLORS = { band: '0xE60000', accent: '0xFFE14D', title: ['white', '0xFFE14D', 'white'], shade: '0x111111' };
const BREAK_AFTER = /[，。！？、；：,.!?;:]/u;

function problem(code, message) { return Object.assign(new Error(message), { code }); }
const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, '').trim();

// 主标题按字数均分成 1—3 行；优先在标点后断行，标点本身不进封面。
function splitTitle(title) {
  const chars = [...title];
  const count = chars.length <= 5 ? 1 : chars.length <= 10 ? 2 : 3;
  const lines = [];
  let rest = chars;
  for (let i = count; i > 1; i -= 1) {
    const ideal = Math.ceil(rest.length / i);
    let cut = ideal;
    for (const delta of [0, 1, -1, 2, -2]) {
      const at = ideal + delta;
      if (at > 0 && at < rest.length && BREAK_AFTER.test(rest[at - 1])) { cut = at; break; }
    }
    lines.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
  }
  lines.push(rest.join(''));
  return lines.map((line) => line.replace(/[，。！？、；：,.!?;:]+$/u, '')).filter(Boolean);
}

function planBigtypeCover({ title, subtitle = '', tags = [], source, face = null }) {
  const headline = clean(title);
  if (!headline) throw problem('bigtype_title_required', '大字封面需要主标题。');
  if ([...headline].length > LIMITS.title) throw problem('bigtype_title_long', `封面主标题最多 ${LIMITS.title} 个字。`);
  const side = [...clean(subtitle)].slice(0, LIMITS.subtitle).join('');
  const labels = (Array.isArray(tags) ? tags : []).map((tag) => [...clean(tag)].slice(0, LIMITS.tag).join('')).filter(Boolean).slice(0, LIMITS.tags);
  if (!(source?.width > 0 && source?.height > 0)) throw problem('bigtype_source_invalid', '人物画面尺寸无效。');

  // 字号让最长的一行占满约 90% 宽度。
  const lines = splitTitle(headline);
  const longest = Math.max(...lines.map((line) => [...line].length));
  const fontSize = Math.min(250, Math.floor((W * 0.9) / longest));
  const lineHeight = Math.round(fontSize * 1.14);
  const band = Math.max(420, Math.min(760, 70 + lines.length * lineHeight + 56));

  // 人物画面铺满色块下方区域；有人脸框时让脸的中心落在画面 38% 高度处，没有时取偏上的位置。
  const photoH = H - band;
  const scale = Math.max(W / source.width, photoH / source.height);
  const scaledW = Math.ceil(source.width * scale / 2) * 2, scaledH = Math.ceil(source.height * scale / 2) * 2;
  const faceX = face ? ((face.x + face.right) / 2) * scaledW : scaledW / 2;
  const faceY = face ? ((face.y + face.bottom) / 2) * scaledH : scaledH * 0.3;
  const cropX = Math.round(Math.min(Math.max(faceX - W / 2, 0), scaledW - W));
  const cropY = Math.round(Math.min(Math.max(faceY - photoH * 0.38, 0), scaledH - photoH));

  // 竖排副标题放在色块下方、标签条上方；字多放不下时整体缩小字号。
  const tagBar = labels.length ? 128 : 0;
  const room = H - tagBar - (band + 48) - 40;
  const sideStep = side ? Math.min(Math.round(64 * 1.22), Math.floor(room / [...side].length)) : 0;
  const sideFont = Math.floor(sideStep / 1.22);
  return { width: W, height: H, lines, fontSize, lineHeight, band, photo: { height: photoH, scaledW, scaledH, cropX, cropY },
    // 竖排副标题逐字定位，底框高度按实际每字步长算，最后一个字不会出框。
    subtitle: side ? { chars: [...side], fontSize: sideFont, step: sideStep, x: W - 54 - Math.round(sideFont / 2), y: band + 48 } : null,
    tags: labels, tagBar };
}

// 文字一律写进临时文本文件交给 drawtext，用户写的内容不会被当成滤镜语法。
const filterPath = (file) => file.replace(/\\/gu, '/').replace(/:/gu, '\\:').replace(/'/gu, "\\'");

function bigtypeFilter(plan, fontFile, textFile) {
  const font = `fontfile='${filterPath(fontFile)}'`;
  const text = (name) => `textfile='${filterPath(textFile(name))}':expansion=none`;
  const p = plan.photo;
  const steps = [`scale=${p.scaledW}:${p.scaledH}`, `crop=${W}:${p.height}:${p.cropX}:${p.cropY}`, `pad=${W}:${H}:0:${plan.band}:color=${COLORS.band}`,
    `drawbox=x=0:y=${plan.band - 14}:w=${W}:h=14:color=${COLORS.accent}:t=fill`];
  const top = Math.round((plan.band - 14 - plan.lines.length * plan.lineHeight) / 2);
  plan.lines.forEach((_, i) => {
    // 同色描边加粗笔画，再加一层深色投影，可变字体默认字重下也足够醒目。
    steps.push(`drawtext=${font}:${text(`title-${i}`)}:fontsize=${plan.fontSize}:fontcolor=${COLORS.title[i]}:borderw=${Math.round(plan.fontSize / 28)}:bordercolor=${COLORS.title[i]}:shadowx=0:shadowy=${Math.round(plan.fontSize / 18)}:shadowcolor=0x7A0000@0.55:x=(w-text_w)/2:y=${top + i * plan.lineHeight}`);
  });
  if (plan.subtitle) {
    const s = plan.subtitle;
    steps.push(`drawbox=x=${s.x - 22}:y=${s.y - 22}:w=${s.fontSize + 44}:h=${s.chars.length * s.step + 30}:color=${COLORS.shade}@0.72:t=fill`);
    s.chars.forEach((_, i) => steps.push(`drawtext=${font}:${text(`subtitle-${i}`)}:fontsize=${s.fontSize}:fontcolor=${COLORS.accent}:borderw=2:bordercolor=${COLORS.accent}:x=${s.x}+(${s.fontSize}-text_w)/2:y=${s.y + i * s.step}`));
  }
  if (plan.tags.length) {
    steps.push(`drawbox=x=0:y=${H - plan.tagBar}:w=${W}:h=${plan.tagBar}:color=${COLORS.shade}@0.88:t=fill`);
    steps.push(`drawtext=${font}:${text('tags')}:fontsize=52:fontcolor=white:borderw=2:bordercolor=white:x=(w-text_w)/2:y=${H - plan.tagBar}+(${plan.tagBar}-text_h)/2`);
  }
  return steps.join(',');
}

function coverTexts(plan) {
  const texts = Object.fromEntries(plan.lines.map((line, i) => [`title-${i}`, line]));
  if (plan.subtitle) plan.subtitle.chars.forEach((char, i) => { texts[`subtitle-${i}`] = char; });
  if (plan.tags.length) texts.tags = plan.tags.join('   |   ');
  return texts;
}

async function renderBigtypeCover({ ffmpegPath = 'ffmpeg', source, seconds = 0, sourceSize, face, title, subtitle, tags, fontFile, target, run = promisify(execFile) }) {
  if (!fontFile || !fs.existsSync(fontFile)) throw problem('bigtype_font_missing', '封面字体缺失，请重新安装应用。');
  const plan = planBigtypeCover({ title, subtitle, tags, source: sourceSize, face });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-bigtype-'));
  try {
    const files = {};
    for (const [name, value] of Object.entries(coverTexts(plan))) { files[name] = path.join(work, `${name}.txt`); fs.writeFileSync(files[name], value, 'utf8'); }
    const partial = `${target}.partial.jpg`;
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(Math.max(0, Number(seconds) || 0)), '-i', source,
      '-frames:v', '1', '-vf', bigtypeFilter(plan, fontFile, (name) => files[name]), '-q:v', '2', partial], { windowsHide: true, timeout: 60000 });
    if (!fs.existsSync(partial) || !fs.statSync(partial).size) throw problem('bigtype_render_failed', '大字封面没有生成成功，成片不受影响，可以重试。');
    fs.renameSync(partial, target);
    return { file: target, plan };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { planBigtypeCover, splitTitle, bigtypeFilter, coverTexts, renderBigtypeCover, LIMITS, WIDTH: W, HEIGHT: H };
