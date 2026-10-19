const catalog = require('./narration-templates.json');
const current = () => catalog.templates.filter(t => t.version === 4);
const key = text => String(text || '').replace(/[\s，。！？；、,.!?;：:]/gu, '');
function normalizeCue(c) { return { text: c.text, startMs: Number(c.startMs ?? c.start_time ?? c.start_ms), endMs: Number(c.endMs ?? c.end_time ?? c.end_ms), words: c.words?.map(normalizeCue) }; }

function choose(task, visual = {}) {
  const rules = catalog.matching;
  const hits = patterns => patterns.filter(pattern => new RegExp(pattern, 'u').test(task.script || '')).length;
  const viewpoint = hits(rules.viewpoint), structured = hits(rules.structured);
  let preferred = visual.busy ? 'minimal_v4' : viewpoint >= 2 ? 'impact_v4' : structured >= 2 ? 'layered_v4' : 'minimal_v4';
  const reasons = [visual.busy ? '人物位置变化较多，减少画面装饰' : viewpoint >= 2 ? '稿件包含对比与明确观点' : structured >= 2 ? '稿件包含步骤或选型问题' : '以清晰讲解为主，使用克制包装'];
  const available = current().map(t => t.id);
  if (task.packagingMode === 'manual' && available.includes(task.captionStyleId)) { preferred = task.captionStyleId; reasons[0] = '使用手动选择的风格'; }
  const candidates = available;
  return { templateId: preferred, candidates, reasons };
}

function pages(cues, maxChars, emphasis) {
  const output = [];
  for (const raw of cues) {
    const cue = normalizeCue(raw);
    if (!cue.text || !Number.isFinite(cue.startMs) || !(cue.endMs > cue.startMs)) continue;
    const words = cue.words?.filter(w => w.text && w.endMs > w.startMs && w.startMs >= cue.startMs && w.endMs <= cue.endMs);
    // Never invent word timestamps. Unaligned/absent words keep their whole cue.
    if (!words?.length || key(words.map(w => w.text).join('')) !== key(cue.text)) { output.push({ text: cue.text, startMs: cue.startMs, endMs: cue.endMs }); continue; }
    let group = [], consumed = 0;
    const full = words.map(w => w.text).join('');
    for (let i = 0; i < words.length; i++) {
      // Keep an emphasized phrase together, but do not drag the preceding
      // sentence onto a second line when only a one-line safe area remains.
      if (group.length && emphasis.some(p => full.startsWith(p, consumed) && group.map(w => w.text).join('').length + p.length > maxChars)) {
        output.push({ text: group.map(w => w.text).join(''), startMs: group[0].startMs, endMs: words[i].startMs }); group = [];
      }
      group.push(words[i]); consumed += words[i].text.length;
      const text = group.map(w => w.text).join('');
      const inside = emphasis.some(p => { let at = full.indexOf(p); while (at >= 0) { if (at < consumed && at + p.length > consumed) return true; at = full.indexOf(p, at + 1); } return false; });
      if (i === words.length - 1 || !inside && (text.length >= maxChars || text.length >= 5 && words[i + 1].startMs - words[i].endMs >= 240)) {
        output.push({ text, startMs: group[0].startMs, endMs: i === words.length - 1 ? cue.endMs : Math.min(cue.endMs, words[i + 1].startMs) }); group = [];
      }
    }
  }
  return output;
}

function buildPlan(task, visual = {}, cues = [], final = false) {
  const picked = choose(task, visual);
  // Quote freezes style. Measured speech can tune layout, never change cover/style.
  const templateId = final && task.packagingPlan?.templateId || picked.templateId;
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
  if (task.soundEffects !== false && definition.layout !== 'minimal') for (const page of displayPages) {
    if (page.phrase && page.startMs - last >= catalog.matching.soundSpacingMs && page.endMs - page.startMs >= 700) {
      soundEvents.push({ startMs: page.startMs, sound: definition.layout === 'impact' ? 'pop' : 'click', gain: .055 }); last = page.startMs;
    }
  }
  return { version: 4, templateId, mode: task.packagingMode || 'auto', candidates: picked.candidates,
    reasons: task.packagingPlan?.reasons && final ? task.packagingPlan.reasons : picked.reasons,
    warnings, analysisVersion: visual.version || 'unavailable', analysisStatus: visual.status || 'unavailable',
    layout: { revision: 2, align: 'center', left: 115, width: 850, top, bottom, showTitle, titleTop, compact: availableHeight < 310 },
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
      || plan.soundEvents.some((s, i, a) => !['pop', 'click'].includes(s.sound) || !Number.isFinite(s.gain) || s.gain < 0 || s.gain > .06 || !Number.isFinite(s.startMs) || s.startMs < 0 || i > 0 && s.startMs - a[i - 1].startMs < 4000)) throw Error('Invalid narration packaging plan');
  return plan;
}
module.exports = { choose, buildPlan, validatePlan, pages };
