const catalog = require('./narration-templates.json');
const { wordBoundaries } = require('./word-breaks.cjs');
const current = () => catalog.templates.filter(t => t.version === 4);
const key = text => String(text || '').replace(/[\s，。！？；、,.!?;：:]/gu, '');
function normalizeCue(c) { return { text: c.text, startMs: Number(c.startMs ?? c.start_time ?? c.start_ms), endMs: Number(c.endMs ?? c.end_time ?? c.end_ms), words: c.words?.map(normalizeCue) }; }

function choose(task, visual = {}) {
  const rules = catalog.matching;
  const hits = patterns => patterns.filter(pattern => new RegExp(pattern, 'u').test(task.script || '')).length;
  const viewpoint = hits(rules.viewpoint), structured = hits(rules.structured);
  // 人物动作多时只放慢动效（见 buildPlan 的 motion），不再退回最素的版式：重点词高亮和花字照常显示。
  let preferred = viewpoint >= 2 ? 'impact_v4' : structured >= 2 ? 'layered_v4' : 'minimal_v4';
  const reasons = [viewpoint >= 2 ? '稿件包含对比与明确观点' : structured >= 2 ? '稿件包含步骤或选型问题' : '以清晰讲解为主，使用克制包装'];
  const available = current().map(t => t.id);
  if (task.packagingMode === 'manual' && available.includes(task.captionStyleId)) { preferred = task.captionStyleId; reasons[0] = '使用手动选择的风格'; }
  const candidates = available;
  return { templateId: preferred, candidates, reasons };
}

// 字幕在哪里可以断：标点处（hard，一屏不跨句）和词与词之间（soft，不把一个词切成两屏）。
// 识别结果常常一个字算一个「词」，所以词边界按稿子文字重新分词，位置用去掉标点后的字数表示。
function breakPoints(text, extra = []) {
  const hard = new Map(); let at = 0;
  for (const char of Array.from(String(text || ''))) {
    if (key(char).length) at += 1;
    else if (/[，。！？；、,.!?;：:]/u.test(char) && at > 0) hard.set(at, /[。！？!?；;]/u.test(char) ? 'sentence' : 'clause');
  }
  // 词边界用去掉标点后的文字算，位置和字数计数一致；行业词、数字+单位、重点词都不拆。
  const soft = wordBoundaries(key(text), extra);
  for (const point of hard.keys()) soft.add(point);
  soft.add(at);
  return { hard, soft };
}

function pages(cues, maxChars, emphasis) {
  const output = [];
  for (const raw of cues) {
    const cue = normalizeCue(raw);
    if (!cue.text || !Number.isFinite(cue.startMs) || !(cue.endMs > cue.startMs)) continue;
    const words = cue.words?.filter(w => w.text && w.endMs > w.startMs && w.startMs >= cue.startMs && w.endMs <= cue.endMs);
    // Never invent word timestamps. Unaligned/absent words keep their whole cue.
    if (!words?.length || key(words.map(w => w.text).join('')) !== key(cue.text)) { output.push({ text: cue.text, startMs: cue.startMs, endMs: cue.endMs, end: 'sentence' }); continue; }
    const { hard, soft } = breakPoints(cue.text, emphasis);
    const full = key(words.map(w => w.text).join(''));
    const ends = []; let total = 0;
    for (const word of words) { total += key(word.text).length; ends.push(total); }
    const inside = (at) => emphasis.some(p => { const k = key(p); let from = k ? full.indexOf(k) : -1; while (from >= 0) { if (from < at && from + k.length > at) return true; from = full.indexOf(k, from + 1); } return false; });
    let first = 0;
    const startOf = (index) => index ? ends[index - 1] : 0;
    const flush = (last, end) => {
      output.push({ text: words.slice(first, last + 1).map(w => w.text).join(''), startMs: words[first].startMs,
        endMs: last === words.length - 1 ? cue.endMs : Math.min(cue.endMs, words[last + 1].startMs), end });
      first = last + 1;
    };
    for (let i = 0; i < words.length; i++) {
      if (i === words.length - 1) { flush(i, 'sentence'); break; }
      const at = ends[i], length = at - startOf(first);
      if (inside(at)) continue;
      // Keep an emphasized phrase together, but do not drag the preceding
      // sentence onto a second line when only a one-line safe area remains.
      const crowded = emphasis.some(p => key(p) && full.startsWith(key(p), at) && length + key(p).length > maxChars);
      if (hard.has(at) && length >= 2) { flush(i, hard.get(at)); continue; }
      if (crowded && length >= 2 && soft.has(at)) { flush(i, 'word'); continue; }
      const pause = words[i + 1].startMs - words[i].endMs >= 240;
      if (soft.has(at) && length >= 5 && pause) { flush(i, 'word'); continue; }
      // A clause that nearly fits stays on one page; a longer one is split into even pages at the
      // word end nearest each target length, so no page is left with one or two dangling characters.
      const clauseEnd = [...hard.keys()].filter(k => k > startOf(first)).sort((a, b) => a - b)[0] ?? total;
      const clause = clauseEnd - startOf(first);
      if (clause <= maxChars + 3) continue;
      const target = clause / Math.ceil(clause / maxChars);
      if (length >= target && soft.has(at)) {
        // Cut here or at the previous word end, whichever is closer to the target length.
        let previous = -1;
        for (let j = i - 1; j >= first; j--) if (soft.has(ends[j]) && !inside(ends[j])) { previous = j; break; }
        const before = previous >= 0 ? ends[previous] - startOf(first) : -Infinity;
        flush(previous >= 0 && before >= 3 && target - before < length - target ? previous : i, 'word');
      } else if (length >= maxChars + 4) flush(i, 'word');
    }
  }
  return output;
}

// ---- 每条片子不重样：版式、配色、转场、镜头节奏轮换，避开同一个人最近几条用过的 ----
const PALETTES = [
  { id: 'mint', accent: '#9AF2BE' }, { id: 'lemon', accent: '#FFE56B' }, { id: 'sky', accent: '#7FE3FF' },
  { id: 'peach', accent: '#FFB067' }, { id: 'rose', accent: '#FF9CC2' }
];
const TRANSITIONS = ['flash', 'iris', 'push'];
// 景别节奏：第二个镜头就推到近景，短片也看得出推镜；a 从远景起，b 从中景起。
const RHYTHMS = { a: [1, 1.26, 1.08, 1.3], b: [1.14, 1.3, 1, 1.2] };
const hash = text => Array.from(String(text || '')).reduce((n, c) => (n * 31 + c.codePointAt(0)) >>> 0, 7);

function chooseVariant(task, recent = [], preferred) {
  const last = recent[0] || {}, seed = hash(task.id || task.script);
  const templates = current().map(t => t.id);
  // 内容决定首选版式；和上一条相同就换一个，连续两条不会是同一套版式。手动选的版式不动。
  let templateId = preferred;
  if (task.packagingMode !== 'manual' && last.templateId === templateId) {
    const others = templates.filter(id => id !== templateId);
    templateId = others[seed % others.length];
  }
  const used = recent.slice(0, 3).map(r => r.variant?.palette);
  const fresh = PALETTES.filter(p => !used.includes(p.id));
  const palette = fresh[seed % fresh.length];
  const transitions = TRANSITIONS.filter(t => t !== last.variant?.transition);
  const transition = transitions[seed % transitions.length];
  const rhythm = last.variant?.rhythm === 'a' ? 'b' : 'a';
  return { templateId, variant: { palette: palette.id, accent: palette.accent, transition, rhythm } };
}

// 镜头推拉：在句子结束处换景别（远/中/近）。字幕在脸下方时以下巴为基准放大：脸只往上长，
// 下沿不动，永远压不到字幕；放大多少只受头顶限制（允许裁掉一点额头，近景常见）。
function cameraPlan(displayPages, visual, layout, rhythm) {
  const union = visual.union;
  const known = union && Number.isFinite(union.y) && Number.isFinite(union.bottom) && union.bottom > union.y;
  const focusX = known && Number.isFinite(union.x) && Number.isFinite(union.right) ? (union.x + union.right) / 2 : .5;
  let focusY = known ? (union.y + union.bottom) / 2 : .35, maxScale = 1.12;
  if (known && layout.top > 1000) {
    focusY = union.bottom;
    maxScale = Math.max(1, Math.min(1.3, (union.bottom + .05) / (union.bottom - union.y)));
  }
  const steps = RHYTHMS[rhythm] || RHYTHMS.a, shots = [];
  let shotStart = 0;
  displayPages.forEach((page, index) => {
    const scale = () => +Math.min(maxScale, steps[shots.length % steps.length]).toFixed(3);
    if (!index) { shots.push({ startMs: page.startMs, scale: scale() }); shotStart = page.startMs; return; }
    const length = page.startMs - shotStart;
    if (displayPages[index - 1].end === 'sentence' && length >= 2500 || length >= 7000) { shots.push({ startMs: page.startMs, scale: scale() }); shotStart = page.startMs; }
  });
  return { focusX: +focusX.toFixed(4), focusY: +focusY.toFixed(4), shots };
}

// 花字：挑 1～2 个重点词，斜放在脸旁边空着的一侧；两边都太窄就不放，绝不压脸。
function stickerPlan(displayPages, visual) {
  const union = visual.union;
  if (!union || ![union.x, union.right, union.y, union.bottom].every(Number.isFinite)) return [];
  const rooms = [{ side: 'left', width: union.x * 1080 }, { side: 'right', width: (1 - union.right) * 1080 }].filter(r => r.width >= 250);
  if (!rooms.length) return [];
  const centerY = Math.round((union.y + union.bottom) / 2 * 1920);
  const stickers = []; let last = -Infinity;
  for (const page of displayPages) {
    if (stickers.length >= 2 || !page.phrase || page.endMs - page.startMs < 900 || page.startMs - last < 6000) continue;
    const room = rooms[stickers.length % rooms.length], perLine = Math.min(Array.from(page.phrase).length, 4);
    const fontSize = Math.max(44, Math.min(78, Math.floor((room.width - 50) / perLine)));
    stickers.push({ text: page.phrase, startMs: page.startMs, endMs: page.endMs + 400, side: room.side, top: centerY - 40,
      width: Math.round(room.width - 30), fontSize, rotate: room.side === 'left' ? -7 : 7 });
    // 同一屏字幕里这个词只做行内高亮，不再放大一遍，避免两处大字重复。
    page.emphasisMode = 'inline'; last = page.startMs;
  }
  return stickers;
}

function buildPlan(task, visual = {}, cues = [], final = false, recent = []) {
  const picked = choose(task, visual);
  // Quote freezes style. Measured speech can tune layout, never change cover/style.
  const frozen = final && task.packagingPlan?.templateId ? { templateId: task.packagingPlan.templateId, variant: task.packagingPlan.variant } : null;
  const chosen = frozen?.variant ? frozen : chooseVariant(task, recent, frozen?.templateId || picked.templateId);
  const templateId = chosen.templateId;
  if (templateId !== picked.templateId && !frozen) picked.reasons.push('和上一条换一套版式，避免重样');
  const definition = current().find(t => t.id === templateId) || current()[2];
  const warnings = visual.note ? [visual.note] : [];
  const safe = catalog.safeLayout, t = catalog.typography;
  const faceBottom = visual.union ? Math.ceil(visual.union.bottom * 1920) + safe.facePadding : 1230;
  const faceTop = visual.union ? visual.union.y * 1920 : 380;
  const duration = task.actualDurationSeconds || task.referenceSeconds || 30;
  const rate = key(task.script).length / Math.max(1, duration);
  const emphasis = task.emphasisPhrases || [];
  const height = (text, size, lineHeight, width = 818) => Math.ceil(text.length * size / width) * size * lineHeight;
  function fit(top, bottom) {
    const available = bottom - top;
    const maxChars = available < 310 || rate > 5 ? 9 : 12;
    const displayPages = pages(cues, maxChars, emphasis).map((cue, index) => {
      let phrase = emphasis.filter(p => cue.text.includes(p) && p.length <= 8).sort((a, b) => b.length - a.length)[0] || '';
      const normalHeight = height(cue.text, t.bodySize, t.bodyLineHeight) + 20 + safe.motionMargin;
      const before = phrase ? cue.text.slice(0, cue.text.indexOf(phrase)) : '';
      const after = phrase ? cue.text.slice(cue.text.indexOf(phrase) + phrase.length) : '';
      const phraseSize = phrase.length > 6 ? t.longEmphasisSize : t.emphasisSize;
      const highlightHeight = height(phrase, phraseSize, t.emphasisLineHeight) + t.underlineHeight + 12 + safe.motionMargin
        + (before ? height(before, t.auxSize, t.auxLineHeight) + t.gap : 0) + (after ? height(after, t.auxSize, t.auxLineHeight) + t.gap : 0);
      const inline = !!phrase && (highlightHeight > available || cue.endMs - cue.startMs < 650);
      return { ...cue, phrase, emphasisMode: inline ? 'inline' : 'stacked', ordinal: index + 1,
        overflow: (phrase && !inline ? highlightHeight : normalHeight) > available };
    });
    return { top, bottom, displayPages, blocked: available < safe.minHeight || displayPages.some(p => p.overflow) };
  }
  // Try readable, short, centered subtitles below the full sampled face range
  // before considering an upper region. Never shrink the font to force a fit.
  let region = fit(Math.max(1190, faceBottom), safe.bottom), upper = false;
  if (region.blocked) {
    const alternate = fit(120, Math.min(900, Math.floor(faceTop - 100)));
    if (!alternate.blocked) { region = alternate; upper = true; }
  }
  const { top, bottom, displayPages, blocked } = region;
  const availableHeight = bottom - top;
  if (upper) warnings.push('下方没有足够的安全文字空间，字幕固定放在上方留白区；已收起装饰标题，请检查全片。');
  if (blocked) warnings.push('整段画面没有足够的安全字幕空间，请换留白更多的素材或调整画面后重新本地包装。');
  const titleTop = 120;
  const title = String(task.title || '');
  const headings = title.split(/[，。！？：:]/u).filter(Boolean);
  const titleSize = title.length > 16 ? 64 : 76;
  const titleLines = (headings.length > 1 ? [headings[0], headings.slice(1).join('，')] : [title])
    .reduce((n, part) => n + Math.ceil(part.length * titleSize / 850), 0);
  const titleHeight = definition.layout === 'minimal' ? Math.ceil(title.length * 48 / 772) * 60 + 30 : titleLines * titleSize * 1.22 + 26;
  const showTitle = !upper && titleTop + titleHeight + safe.facePadding < faceTop;
  if (!showTitle && !upper) warnings.push('头部靠近顶部，已隐藏片内装饰标题；标题仍保留在独立封面。');
  const soundEvents = []; let last = -Infinity;
  if (task.soundEffects !== false) for (const page of displayPages) {
    if (page.phrase && page.startMs - last >= catalog.matching.soundSpacingMs && page.endMs - page.startMs >= 700) {
      soundEvents.push({ startMs: page.startMs, sound: definition.layout === 'impact' ? 'pop' : 'click', gain: .055 }); last = page.startMs;
    }
  }
  const layoutBox = { revision: 2, align: 'center', left: 115, width: 850, top, bottom, showTitle, titleTop, compact: availableHeight < 310 };
  const stickers = stickerPlan(displayPages, visual);
  return { version: 4, templateId, mode: task.packagingMode || 'auto', candidates: picked.candidates,
    variant: chosen.variant, camera: cameraPlan(displayPages, visual, layoutBox, chosen.variant.rhythm), stickers,
    reasons: task.packagingPlan?.reasons && final ? task.packagingPlan.reasons : picked.reasons,
    warnings, analysisVersion: visual.version || 'unavailable', analysisStatus: visual.status || 'unavailable',
    layout: layoutBox,
    motion: rate > 5 || visual.busy ? 'quiet' : definition.motion,
    pages: displayPages, soundEvents, blocked: blocked || displayPages.some(p => p.overflow) };
}
function validatePlan(plan, styleId) {
  if (!plan || plan.version !== 4 || plan.templateId !== styleId || !current().some(t => t.id === styleId)
      || JSON.stringify(plan).length > 100000 || !Array.isArray(plan.pages) || plan.pages.length > 500
      || !Array.isArray(plan.soundEvents) || plan.soundEvents.length > 60
      || !plan.layout || !Number.isFinite(plan.layout.top) || !Number.isFinite(plan.layout.bottom) || plan.layout.top < 120 || plan.layout.bottom > (plan.layout.revision === 2 ? catalog.safeLayout.bottom : 1600) || plan.layout.bottom - plan.layout.top < (plan.layout.revision === 2 ? catalog.safeLayout.minHeight : 180)
      || plan.layout.left !== (plan.layout.revision === 2 ? 115 : 82) || plan.layout.width !== 850
      || plan.layout.revision === 2 && plan.layout.align !== 'center'
      || plan.pages.some(p => typeof p.text !== 'string' || p.text.length > 500 || !Number.isFinite(p.startMs) || !Number.isFinite(p.endMs) || p.startMs < 0 || p.endMs <= p.startMs)
      || plan.soundEvents.some((s, i, a) => !['pop', 'click'].includes(s.sound) || !Number.isFinite(s.gain) || s.gain < 0 || s.gain > .06 || !Number.isFinite(s.startMs) || s.startMs < 0 || i > 0 && s.startMs - a[i - 1].startMs < 4000)
      || plan.variant && (!PALETTES.some(p => p.id === plan.variant.palette && p.accent === plan.variant.accent) || !TRANSITIONS.includes(plan.variant.transition) || !RHYTHMS[plan.variant.rhythm])
      || plan.camera && (!Array.isArray(plan.camera.shots) || plan.camera.shots.length > 200 || ![plan.camera.focusX, plan.camera.focusY].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
        || plan.camera.shots.some(s => !Number.isFinite(s.startMs) || s.startMs < 0 || !Number.isFinite(s.scale) || s.scale < 1 || s.scale > 1.3))
      || plan.stickers && (!Array.isArray(plan.stickers) || plan.stickers.length > 2 || plan.stickers.some(s => typeof s.text !== 'string' || !s.text || s.text.length > 12 || !['left', 'right'].includes(s.side)
        || ![s.startMs, s.endMs, s.top, s.width, s.fontSize, s.rotate].every(Number.isFinite) || s.endMs <= s.startMs || s.fontSize < 30 || s.fontSize > 90 || Math.abs(s.rotate) > 12))) throw Error('Invalid narration packaging plan');
  return plan;
}
module.exports = { choose, chooseVariant, buildPlan, validatePlan, pages, breakPoints, PALETTES, TRANSITIONS };
