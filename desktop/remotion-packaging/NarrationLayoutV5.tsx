import React from 'react';
import catalog from './narration-templates.json';
import type { NarrationCue } from './NarrationLayout';
import type { NarrationPlan } from './NarrationLayoutV4';

// Version 5 (user 2026-11-24): no boxes or colour blocks. The title and captions sit in the
// picture: a large rising title (rise_v5), a hollow title that fills as the video plays with
// keywords slammed in (kinetic_v5), or a lit gradient title (glow_v5). A soft dark halo keeps
// white text readable on bright floors and white shirts. Used by digital humans (with the
// packaging plan) and by lead mixes (no plan: pages come from the captions).

//
// Replicas (user 2026-11-26): three looks copied one to one from the user's own best videos.
// Their title stays on screen for the whole video at the very top, may lie over the hair, and
// keeps its own colours (no palette rotation):
// - redbar_v5: each title line in its own red box, white heavy italic; short one-line captions,
//   keywords yellow-green and a little larger; shot changes cut through a round frame.
// - tagline_v5: a single red title tag; captions are whole sentences on two or three lines,
//   heavy white with a black outline, keywords yellow.
// - songti_v5: a heavy serif title on a full-width translucent grey band; big outlined serif
//   captions, keywords pale yellow.

const FONT = '"Narration Sans", "Microsoft YaHei", sans-serif';
const SERIF = '"Narration Serif", "Noto Serif SC", "Source Han Serif SC", "SimSun", serif';
export const REPLICAS = ['redbar_v5', 'tagline_v5', 'songti_v5'];
const OUTLINE = (width: number) => ({ WebkitTextStroke: `${width}px #000`, paintOrder: 'stroke fill' as const });
const HALO = '0 2px 4px rgba(0,0,0,.55), 0 0 18px rgba(0,0,0,.45), 0 0 46px rgba(0,0,0,.35)';
const key = (text: string) => String(text || '').replace(/[\s，。！？；、,.!?;：:“”"'（）()]/gu, '');
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => 1 - Math.pow(1 - clamp01(value), 3);
// A damped spring from 0 to 1 that starts at `since` = 0 (ms).
const springy = (since: number, period = 70, decay = 120) => since <= 0 ? 0 : 1 - Math.exp(-since / decay) * Math.cos(since / period);

type Page = { text: string; startMs: number; endMs: number; phrase?: string };
type Char = { t: string; s: number; key: boolean };

export const isV5 = (styleId?: string) => catalog.templates.some((item) => item.id === styleId && item.version === 5);

// Pages depend only on the captions and keywords, which stay the same for the whole render.
const pageCache = new WeakMap<NarrationCue[], Map<string, Page[]>>();
function cachedPages(cues: NarrationCue[], emphasis: string[], maxChars = 12) {
  let byKey = pageCache.get(cues);
  if (!byKey) { byKey = new Map(); pageCache.set(cues, byKey); }
  const id = `${maxChars}:` + emphasis.join('');
  if (!byKey.has(id)) byKey.set(id, maxChars > 12 ? sentencePages(cues, emphasis, maxChars) : pagesFromCues(cues, emphasis));
  return byKey.get(id)!;
}

// Without a plan (lead mixes): one page per clause, long clauses split evenly, never inside a keyword.
function pagesFromCues(cues: NarrationCue[], emphasis: string[]): Page[] {
  const out: Page[] = [];
  for (const cue of cues) {
    const parts = String(cue.text || '').split(/(?<=[，。！？；,.!?;])/u).map((part) => part.trim()).filter((part) => key(part));
    const total = parts.reduce((sum, part) => sum + key(part).length, 0) || 1;
    let at = cue.startMs;
    for (const part of parts) {
      const length = (cue.endMs - cue.startMs) * key(part).length / total;
      const clean = part.replace(/[，。！？；,.!?;]+$/u, '');
      const chunks = Math.ceil(key(clean).length / 12);
      const size = Math.ceil(Array.from(clean).length / chunks);
      let rest = Array.from(clean), from = at;
      while (rest.length) {
        let cut = Math.min(rest.length, size);
        const text = rest.join('');
        for (const phrase of emphasis) {
          const index = Array.from(text.slice(0, text.indexOf(phrase))).length;
          if (text.includes(phrase) && index < cut && index + Array.from(phrase).length > cut) cut = index + Array.from(phrase).length;
        }
        const piece = rest.slice(0, cut).join('');
        const span = length * key(piece).length / Math.max(1, key(clean).length);
        out.push({ text: piece, startMs: Math.round(from), endMs: Math.round(from + span) });
        from += span; rest = rest.slice(cut);
      }
      at += length;
    }
  }
  return out;
}

// tagline_v5 without a plan: a page is a whole sentence (clauses joined up to maxChars), so
// the captions read as two or three lines like the user's mixes.
function sentencePages(cues: NarrationCue[], emphasis: string[], maxChars: number): Page[] {
  const out: Page[] = [];
  for (const cue of cues) {
    const start = out.length;
    for (const page of pagesFromCues([cue], emphasis)) {
      const last = out.length > start ? out[out.length - 1] : undefined;
      if (last && key(last.text).length + key(page.text).length <= maxChars) {
        last.text = `${last.text}，${page.text}`; last.endMs = page.endMs;
      } else out.push({ ...page });
    }
  }
  return out;
}

// Each character of a page with the moment it is said: aligned word times when the words
// match the page, otherwise spread evenly over the first 80% of the page.
function charsOf(page: Page, cues: NarrationCue[], phrases: string[]): Char[] {
  const words = cues.flatMap((cue) => cue.words || []).filter((word) => word.startMs >= page.startMs - 40 && word.startMs < page.endMs);
  const chars = Array.from(page.text);
  const times: number[] = [];
  if (words.length && key(words.map((word) => word.text).join('')) === key(page.text)) {
    let index = 0;
    for (const word of words) {
      const letters = Array.from(key(word.text));
      letters.forEach((_, i) => { times[index + i] = word.startMs + (word.endMs - word.startMs) * i / Math.max(1, letters.length); });
      index += letters.length;
    }
  }
  const spoken = chars.filter((char) => key(char)).length || 1;
  let n = 0;
  const marks = new Array(chars.length).fill(false);
  for (const phrase of phrases) {
    if (!phrase) continue;
    let at = page.text.indexOf(phrase);
    while (at >= 0) {
      const start = Array.from(page.text.slice(0, at)).length;
      for (let i = start; i < start + Array.from(phrase).length; i += 1) marks[i] = true;
      at = page.text.indexOf(phrase, at + phrase.length);
    }
  }
  return chars.map((char, i) => {
    const order = key(char) ? n++ : Math.max(0, n - 1);
    const s = times[order] ?? page.startMs + (page.endMs - page.startMs) * 0.8 * order / spoken;
    return { t: char, s, key: marks[i] };
  });
}

function runsOf(chars: Char[]) {
  const runs: { key: boolean; s: number; chars: Char[] }[] = [];
  for (const char of chars) {
    const last = runs[runs.length - 1];
    if (last && last.key === char.key) last.chars.push(char);
    else runs.push({ key: char.key, s: char.s, chars: [char] });
  }
  return runs;
}

function phrasesFor(page: Page, emphasis: string[]) {
  const listed = page.phrase ? [page.phrase] : [];
  return [...listed, ...emphasis.filter((phrase) => phrase && phrase.length <= 8 && page.text.includes(phrase) && !listed.includes(phrase))];
}

// tagline_v5 shows whole sentences; every other template one clause (at most 12 characters).
const pageChars = (styleId: string) => styleId === 'tagline_v5' ? 26 : 12;

// The camera leans in a little when a keyword is said and settles back (rise/kinetic/glow).
export function keywordPush(styleId: string, cues: NarrationCue[], emphasis: string[] = [], plan: NarrationPlan | undefined, nowMs: number) {
  if (!isV5(styleId)) return 0;
  // The replicas copy videos without a push, except redbar's punch-in on keywords.
  const strength = styleId === 'kinetic_v5' ? 0.07 : styleId === 'redbar_v5' ? 0.05 : REPLICAS.includes(styleId) ? 0 : 0.04;
  if (!strength) return 0;
  const pages: Page[] = plan?.pages?.length ? plan.pages : cachedPages(cues, emphasis, pageChars(styleId));
  let push = 0;
  for (const page of pages) {
    if (page.startMs > nowMs || page.endMs + 1800 < nowMs) continue;
    const phrases = phrasesFor(page, emphasis);
    if (!phrases.length) continue;
    const first = charsOf(page, cues, phrases).find((char) => char.key);
    if (!first) continue;
    const since = nowMs - first.s;
    push = Math.max(push, since < 0 ? 0 : since < 160 ? since / 160 : since < 900 ? 1 - 0.55 * (since - 160) / 740 : Math.max(0, 0.45 * (1 - (since - 900) / 800)));
  }
  return strength * push;
}

// Two clauses become two lines; a line longer than 10 characters is split evenly, so a long
// title wraps instead of running off the frame (at most 4 lines).
function titleLines(title: string) {
  const parts = title.split(/[，。！？：:、？?！!]/u).map((part) => part.trim()).filter(Boolean);
  const clauses = parts.length > 1 ? [parts[0], parts.slice(1).join('，')] : [title];
  const lines = clauses.flatMap((clause) => {
    const chars = Array.from(clause);
    const count = Math.ceil(chars.length / 10);
    const size = Math.ceil(chars.length / Math.max(1, count));
    return Array.from({ length: count }, (_, i) => chars.slice(i * size, (i + 1) * size).join('')).filter(Boolean);
  });
  if (lines.length <= 4) return lines;
  return [...lines.slice(0, 3), lines.slice(3).join('')];
}

// Largest size at which every line (letter spacing included) fits `width` and all lines fit
// `room`, capped at `max`; never below 44.
const titleSize = (lines: string[], max: number, room: number, lineHeight: number, spacing = 0, width = 980) =>
  Math.max(44, Math.min(max, ...lines.map((line) => Math.floor(width / Array.from(line).length - spacing)), Math.floor(room / (lines.length * lineHeight))));

// Replica title lines: clauses are joined while they fit `max` characters, a longer clause is
// split evenly. When that needs more than `limit` lines, the whole title is split evenly into
// `limit` lines instead (the size then shrinks to fit).
function replicaLines(title: string, max: number, limit: number) {
  const lines: string[] = [];
  for (const part of title.split(/[，。！？：:、?!；;]/u).map((item) => item.trim()).filter(Boolean)) {
    const chars = Array.from(part), last = lines[lines.length - 1];
    if (last !== undefined && Array.from(last).length + 1 + chars.length <= max) { lines[lines.length - 1] = `${last} ${part}`; continue; }
    const count = Math.ceil(chars.length / max), size = Math.ceil(chars.length / count);
    for (let i = 0; i < count; i += 1) lines.push(chars.slice(i * size, (i + 1) * size).join(''));
  }
  if (lines.length <= limit) return lines;
  const all = Array.from(lines.join('').replace(/\s+/gu, '')), size = Math.ceil(all.length / limit);
  return Array.from({ length: limit }, (_, i) => all.slice(i * size, (i + 1) * size).join('')).filter(Boolean);
}

const longest = (lines: string[]) => Math.max(1, ...lines.map((line) => Array.from(line).length));

function ReplicaLayout({ styleId, title, cues, nowMs, emphasis, plan, showTitle }: {
  styleId: string; title: string; cues: NarrationCue[]; nowMs: number; emphasis: string[]; plan?: NarrationPlan; showTitle: boolean;
}) {
  const accent = catalog.templates.find((item) => item.id === styleId)!.accent;
  const layout = plan?.layout;
  const pages: Page[] = plan?.pages?.length ? plan.pages : cachedPages(cues, emphasis, pageChars(styleId));
  const found = pages.find((item) => nowMs >= item.startMs - 60 && nowMs < item.endMs + 100);
  const page = found && { ...found, text: found.text.replace(/[，。！？；、,.!?;：:]+$/u, '') };
  const chars = page ? charsOf(page, cues, phrasesFor(page, emphasis)) : [];
  // Captions moved above the face (plan region starts high) take the top; the title then gives way.
  const upper = !!layout && layout.top < 900;
  const visibleTitle = !!title && !upper && (layout ? layout.showTitle : showTitle);

  let titleNode: React.ReactNode = null;
  if (visibleTitle && styleId === 'songti_v5') {
    const lines = replicaLines(title, 9, 2), size = Math.min(100, Math.floor(960 / longest(lines)));
    titleNode = <div style={{ position: 'absolute', top: 150, left: 0, right: 0, padding: `${Math.round(size * 0.14)}px 40px`, background: 'rgba(40,40,40,.45)', textAlign: 'center' }}>
      {lines.map((line, i) => <div key={i} style={{ fontFamily: SERIF, fontWeight: 900, fontSize: size, lineHeight: 1.08, color: '#fff', whiteSpace: 'nowrap',
        textShadow: '0 2px 5px rgba(0,0,0,.55)', ...OUTLINE(2) }}>{line}</div>)}
    </div>;
  } else if (visibleTitle) {
    // redbar: up to three lines of 13; tagline: one tag, two lines at most.
    const tagline = styleId === 'tagline_v5';
    const lines = tagline ? replicaLines(title, 12, 2) : replicaLines(title, 13, 3);
    const size = Math.min(tagline ? 80 : 70, Math.floor(940 / longest(lines)));
    titleNode = <div style={{ position: 'absolute', top: tagline ? 140 : 90, left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: Math.round(size * 0.08) }}>
      {lines.map((line, i) => <div key={i} style={{ background: tagline ? '#EE133B' : '#FF0039', padding: `${Math.round(size * 0.08)}px ${Math.round(size * 0.26)}px`,
        fontFamily: FONT, fontWeight: 900, fontStyle: 'italic', fontSize: size, lineHeight: 1.18, letterSpacing: 1, color: '#fff', whiteSpace: 'nowrap',
        textShadow: '0 2px 3px rgba(0,0,0,.35)' }}>{line}</div>)}
    </div>;
  }

  let captionNode: React.ReactNode = null;
  if (page) {
    const count = chars.length || 1;
    // Size first, then the height it takes, then where it sits: centred near y 1330 like the
    // user's videos, kept inside the plan's caption area below (or above) the face.
    let size: number, lineHeight: number, lines: number;
    // One line while it fits at a readable size; a longer page (no word times: a whole sentence)
    // wraps onto more lines rather than shrinking.
    const keys = chars.filter((char) => char.key).length;
    if (styleId === 'tagline_v5') { size = 80; lineHeight = 1.24; lines = Math.ceil(count * size / 880); }
    else if (styleId === 'songti_v5') { size = Math.max(80, Math.min(104, Math.floor(960 / count))); lineHeight = 1.2; lines = Math.ceil(count * size / 960); }
    else { size = Math.max(60, Math.min(72, Math.floor(900 / (count + 0.3 * keys)))); lineHeight = 1.25; lines = Math.ceil((count + 0.3 * keys) * size / 900); }
    const wrap = lines > 1 ? 'normal' : 'nowrap';
    const room = layout ? layout.bottom - layout.top : 640;
    if (lines * size * lineHeight > room) size = Math.floor(room / (lines * lineHeight));
    const height = lines * size * lineHeight;
    const centre = !layout ? 1330 : upper ? (layout.top + layout.bottom) / 2 : Math.max(layout.top + height / 2, Math.min(1330, layout.bottom - height / 2));
    const box: React.CSSProperties = { position: 'absolute', left: 70, right: 70, top: Math.round(centre - height / 2), textAlign: 'center', lineHeight };
    const runs = runsOf(chars);
    if (styleId === 'tagline_v5') {
      captionNode = <div style={{ ...box, fontFamily: FONT, fontWeight: 900, fontSize: size, color: '#fff', textShadow: '0 4px 8px rgba(0,0,0,.45)', ...OUTLINE(Math.round(size * 0.08)),
        opacity: ease((nowMs - page.startMs + 60) / 100) }}>
        {runs.map((run, i) => <span key={i} style={{ color: run.key ? accent : '#fff' }}>{run.chars.map((char) => char.t).join('')}</span>)}
      </div>;
    } else if (styleId === 'songti_v5') {
      const enter = ease((nowMs - page.startMs + 60) / 140);
      captionNode = <div style={{ ...box, fontFamily: SERIF, fontWeight: 900, fontSize: size, whiteSpace: wrap, textShadow: '0 4px 10px rgba(0,0,0,.5)', ...OUTLINE(Math.round(size * 0.05)),
        opacity: enter, transform: `translateY(${(1 - enter) * 16}px) skewX(-8deg)` }}>
        {runs.map((run, i) => <span key={i} style={{ color: run.key ? accent : '#fff' }}>{run.chars.map((char) => char.t).join('')}</span>)}
      </div>;
    } else {
      // redbar: the line pops in; a keyword lands a beat later, larger, in yellow-green.
      const pop = ease((nowMs - page.startMs + 60) / 140);
      captionNode = <div style={{ ...box, fontFamily: FONT, whiteSpace: wrap, opacity: pop, transform: `scale(${0.86 + 0.14 * pop})`,
        textShadow: '0 3px 6px rgba(0,0,0,.6), 0 0 2px rgba(0,0,0,.8)' }}>
        {runs.map((run, i) => {
          const text = run.chars.map((char) => char.t).join('');
          if (!run.key) return <span key={i} style={{ fontWeight: 800, fontSize: size, color: '#fff' }}>{text}</span>;
          const land = clamp01(springy(nowMs - run.s, 60, 110));
          return <span key={i} style={{ display: 'inline-block', fontWeight: 900, fontSize: Math.round(size * 1.18), color: nowMs >= run.s ? accent : '#fff',
            transform: `scale(${nowMs >= run.s ? 1.35 - 0.35 * land : 1})`, transformOrigin: '50% 70%' }}>{text}</span>;
        })}
      </div>;
    }
  }

  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    {titleNode}
    {captionNode}
  </div>;
}

export function NarrationLayoutV5({ styleId, title, cues, nowMs, emphasis = [], plan, showTitle = true }: {
  styleId: string; title: string; cues: NarrationCue[]; nowMs: number; emphasis?: string[]; plan?: NarrationPlan; showTitle?: boolean;
}) {
  if (REPLICAS.includes(styleId)) return <ReplicaLayout styleId={styleId} title={title} cues={cues} nowMs={nowMs} emphasis={emphasis} plan={plan} showTitle={showTitle} />;
  const template = catalog.templates.find((item) => item.id === styleId)!;
  const accent = plan?.variant?.accent || template.accent;
  const layout = plan?.layout;
  const pages: Page[] = plan?.pages?.length ? plan.pages : cachedPages(cues, emphasis);
  const found = pages.find((item) => nowMs >= item.startMs - 60 && nowMs < item.endMs + 100);
  // A caption line never ends on a comma or full stop.
  const page = found && { ...found, text: found.text.replace(/[，。！？；、,.!?;：:]+$/u, '') };
  const durationMs = Math.max(1, ...pages.map((item) => item.endMs), ...cues.map((cue) => cue.endMs));
  const lines = titleLines(title || '');
  const room = (layout as { titleRoom?: number } | undefined)?.titleRoom ?? 520;
  const titleTop = layout?.titleTop ?? 150;
  const visibleTitle = !!title && (layout ? layout.showTitle : showTitle);
  // Captions stay inside the plan's safe area (below or above the face); mixes use the lower third.
  const captionBottom = layout ? 1920 - layout.bottom : 330;
  const chars = page ? charsOf(page, cues, phrasesFor(page, emphasis)) : [];
  const runs = runsOf(chars);
  // v5 captions are larger than the sizes the plan measured; shrink a page that would grow
  // above the plan's caption area (into the face) instead of letting it spill upward.
  const captionRoom = layout ? layout.bottom - layout.top : 560;
  const lineCount = (count: number, size: number, width: number) => Math.max(1, Math.ceil(count * size / width));
  const estimate = styleId === 'kinetic_v5'
    ? runs.reduce((sum, run) => sum + (run.key ? (run.chars.length > 5 ? 118 : 146) * 1.05 : lineCount(run.chars.length, 64, 960) * 64 * 1.2), 0)
    : lineCount(chars.reduce((sum, char) => sum + (char.key ? 80 : 66), 0), 1, 900) * 80 * 1.22;
  const fit = Math.min(1, captionRoom / Math.max(1, estimate));
  const px = (size: number) => Math.round(size * fit);

  let titleNode: React.ReactNode = null;
  if (visibleTitle && styleId === 'rise_v5') {
    const size = titleSize(lines, 196, room, 1.04, -4);
    let index = 0;
    titleNode = <div style={{ position: 'absolute', top: titleTop, left: 40, right: 40, textAlign: 'center' }}>
      {lines.map((line, l) => <div key={l} style={{ fontFamily: FONT, fontWeight: 900, fontSize: l ? Math.round(size * 0.9) : size, lineHeight: 1.04, letterSpacing: -4,
        color: l ? accent : '#fff', textShadow: '0 18px 60px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.3)', whiteSpace: 'nowrap' }}>
        {Array.from(line).map((char, i) => {
          const rise = ease((nowMs - 150 - (index++) * 45) / 520);
          return <span key={i} style={{ display: 'inline-block', opacity: rise, transform: `translateY(${(1 - rise) * 90}px)`, filter: `blur(${(1 - rise) * 14}px)` }}>{char}</span>;
        })}
      </div>)}
    </div>;
  } else if (visibleTitle && styleId === 'kinetic_v5') {
    const size = titleSize(lines, 118, room, 1.15, 2);
    const progress = clamp01(nowMs / durationMs) * 100;
    titleNode = <div style={{ position: 'absolute', top: titleTop, left: 40, right: 40, textAlign: 'center', opacity: ease(nowMs / 400) }}>
      {lines.map((line, l) => <div key={l} style={{ fontFamily: FONT, fontWeight: 900, fontSize: l ? Math.round(size * 0.88) : size, lineHeight: 1.15, letterSpacing: 2,
        color: 'transparent', WebkitTextStroke: '3px rgba(255,255,255,.95)', whiteSpace: 'nowrap', filter: 'drop-shadow(0 4px 14px rgba(0,0,0,.45))',
        backgroundImage: `linear-gradient(90deg, #fff ${progress}%, rgba(255,255,255,0) ${progress}%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text' }}>{line}</div>)}
    </div>;
  } else if (visibleTitle) {
    const size = titleSize(lines, 112, room, 1.18, 4);
    const sweep = ((nowMs % 3200) / 3200) * 260 - 80;
    const appear = ease(nowMs / 900);
    titleNode = <div style={{ position: 'absolute', top: titleTop, left: 40, right: 40, textAlign: 'center', opacity: appear, transform: `translateY(${(1 - appear) * 30}px)`,
      filter: `drop-shadow(0 2px 4px rgba(0,0,0,.45)) drop-shadow(0 0 30px ${accent}66)` }}>
      {lines.map((line, l) => <div key={l} style={{ fontFamily: FONT, fontWeight: 900, fontSize: l ? Math.round(size * 0.86) : size, lineHeight: 1.18, letterSpacing: 4,
        color: 'transparent', whiteSpace: 'nowrap',
        backgroundImage: `linear-gradient(100deg, rgba(255,255,255,0) ${sweep - 12}%, rgba(255,255,255,.95) ${sweep}%, rgba(255,255,255,0) ${sweep + 12}%), linear-gradient(100deg, #fff 0%, #fff 35%, ${accent} 100%)`,
        WebkitBackgroundClip: 'text', backgroundClip: 'text' }}>{line}</div>)}
    </div>;
  }

  let captionNode: React.ReactNode = null;
  if (page && styleId === 'rise_v5') {
    // Every character lights up as it is said; keywords turn the accent colour.
    captionNode = <div style={{ position: 'absolute', left: 90, right: 90, bottom: captionBottom, textAlign: 'center', fontFamily: FONT, textShadow: HALO, lineHeight: 1.2 }}>
      {chars.map((char, i) => {
        const lit = 0.38 + 0.62 * clamp01((nowMs - char.s + 40) / 120);
        const on = char.key && lit > 0.9;
        return <span key={i} style={{ fontWeight: char.key ? 900 : 700, fontSize: px(char.key ? 80 : 66), color: on ? accent : '#fff', opacity: lit,
          textShadow: on ? `0 0 28px ${accent}88, ${HALO}` : HALO }}>{char.t}</span>;
      })}
    </div>;
  } else if (page && styleId === 'kinetic_v5') {
    // Plain runs slide in from alternate sides; a keyword gets its own line and slams in.
    captionNode = <div style={{ position: 'absolute', left: 60, right: 60, bottom: captionBottom, display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: FONT }}>
      {runs.map((run, i) => {
        const text = run.chars.map((char) => char.t).join('');
        if (run.key) {
          const slam = clamp01(springy(nowMs - run.s, 60, 110));
          return <div key={i} style={{ fontWeight: 900, fontSize: px(Array.from(text).length > 5 ? 118 : 146), lineHeight: 1.05, color: accent, fontStyle: 'italic',
            opacity: nowMs >= run.s ? 1 : 0, transform: `scale(${2.2 - 1.2 * slam}) rotate(${(i % 2 ? 2 : -2) * slam}deg) skewX(-6deg)`,
            filter: `blur(${(1 - slam) * 10}px)`, textShadow: HALO, whiteSpace: 'nowrap' }}>{text}</div>;
        }
        const enter = ease((nowMs - run.s + 60) / 260);
        return <div key={i} style={{ fontWeight: 700, fontSize: px(64), lineHeight: 1.2, color: '#fff', opacity: enter, textShadow: HALO,
          transform: `translateX(${(1 - enter) * (i % 2 ? 80 : -80)}px)`, filter: `blur(${(1 - enter) * 8}px)` }}>{text}</div>;
      })}
    </div>;
  } else if (page) {
    captionNode = <div style={{ position: 'absolute', left: 90, right: 90, bottom: captionBottom, textAlign: 'center', fontFamily: FONT, lineHeight: 1.22,
      opacity: ease((nowMs - page.startMs + 60) / 200) }}>
      {runs.map((run, i) => {
        const text = run.chars.map((char) => char.t).join('');
        return run.key
          ? <span key={i} style={{ fontWeight: 900, fontSize: px(80), color: 'transparent', backgroundImage: `linear-gradient(90deg, #fff, ${accent})`,
              WebkitBackgroundClip: 'text', backgroundClip: 'text', filter: `drop-shadow(0 0 3px rgba(0,0,0,.7)) drop-shadow(0 0 18px ${accent}aa)`, margin: '0 6px' }}>{text}</span>
          : <span key={i} style={{ fontWeight: 600, fontSize: px(64), color: '#fff', textShadow: HALO }}>{text}</span>;
      })}
    </div>;
  }

  // A keyword landing in kinetic flashes the frame for 90 ms.
  const flash = styleId === 'kinetic_v5' && runs.some((run) => run.key && nowMs >= run.s && nowMs < run.s + 90);
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    {flash ? <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: 0.16 }} /> : null}
    {titleNode}
    {captionNode}
  </div>;
}
