import React from 'react';
import catalog from './narration-templates.json';
import type { NarrationCue } from './NarrationLayout';
import type { NarrationPlan } from './NarrationLayoutV4';

// Version 5 (user 2026-11-24): no boxes or colour blocks. The title and captions sit in the
// picture: a large rising title (rise_v5), a hollow title that fills as the video plays with
// keywords slammed in (kinetic_v5), or a lit gradient title (glow_v5). A soft dark halo keeps
// white text readable on bright floors and white shirts. Used by digital humans (with the
// packaging plan) and by lead mixes (no plan: pages come from the captions).

const FONT = '"Narration Sans", "Microsoft YaHei", sans-serif';
const HALO = '0 2px 4px rgba(0,0,0,.55), 0 0 18px rgba(0,0,0,.45), 0 0 46px rgba(0,0,0,.35)';
const key = (text: string) => String(text || '').replace(/[\s，。！？；、,.!?;：:“”"'（）()]/gu, '');
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => 1 - Math.pow(1 - clamp01(value), 3);
// A damped spring from 0 to 1 that starts at `since` = 0 (ms).
const springy = (since: number, period = 70, decay = 120) => since <= 0 ? 0 : 1 - Math.exp(-since / decay) * Math.cos(since / period);

type Page = { text: string; startMs: number; endMs: number; phrase?: string };
type Char = { t: string; s: number; key: boolean };

export const isV5 = (styleId?: string) => catalog.templates.some((item) => item.id === styleId && item.version === 5);

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

// The camera leans in a little when a keyword is said and settles back (rise/kinetic/glow).
export function keywordPush(styleId: string, cues: NarrationCue[], emphasis: string[] = [], plan: NarrationPlan | undefined, nowMs: number) {
  if (!isV5(styleId)) return 0;
  const strength = styleId === 'kinetic_v5' ? 0.07 : 0.04;
  const pages: Page[] = plan?.pages?.length ? plan.pages : pagesFromCues(cues, emphasis);
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

function titleLines(title: string) {
  const parts = title.split(/[，。！？：:、？?！!]/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) return [parts[0], parts.slice(1).join('，')];
  const chars = Array.from(title);
  if (chars.length <= 7) return [title];
  const half = Math.ceil(chars.length / 2);
  return [chars.slice(0, half).join(''), chars.slice(half).join('')];
}

// Largest size at which every line fits `width` and all lines fit `room`, capped at `max`.
const titleSize = (lines: string[], max: number, room: number, lineHeight: number, width = 940) =>
  Math.max(56, Math.min(max, Math.floor(width / Math.max(...lines.map((line) => Array.from(line).length))), Math.floor(room / (lines.length * lineHeight))));

export function NarrationLayoutV5({ styleId, title, cues, nowMs, emphasis = [], plan, showTitle = true }: {
  styleId: string; title: string; cues: NarrationCue[]; nowMs: number; emphasis?: string[]; plan?: NarrationPlan; showTitle?: boolean;
}) {
  const template = catalog.templates.find((item) => item.id === styleId)!;
  const accent = plan?.variant?.accent || template.accent;
  const layout = plan?.layout;
  const pages: Page[] = plan?.pages?.length ? plan.pages : pagesFromCues(cues, emphasis);
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

  let titleNode: React.ReactNode = null;
  if (visibleTitle && styleId === 'rise_v5') {
    const size = titleSize(lines, 196, room, 1.04);
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
    const size = titleSize(lines, 118, room, 1.15);
    const progress = clamp01(nowMs / durationMs) * 100;
    titleNode = <div style={{ position: 'absolute', top: titleTop, left: 40, right: 40, textAlign: 'center', opacity: ease(nowMs / 400) }}>
      {lines.map((line, l) => <div key={l} style={{ fontFamily: FONT, fontWeight: 900, fontSize: l ? Math.round(size * 0.88) : size, lineHeight: 1.15, letterSpacing: 2,
        color: 'transparent', WebkitTextStroke: '3px rgba(255,255,255,.95)', whiteSpace: 'nowrap', filter: 'drop-shadow(0 4px 14px rgba(0,0,0,.45))',
        backgroundImage: `linear-gradient(90deg, #fff ${progress}%, rgba(255,255,255,0) ${progress}%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text' }}>{line}</div>)}
    </div>;
  } else if (visibleTitle) {
    const size = titleSize(lines, 112, room, 1.18);
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
        return <span key={i} style={{ fontWeight: char.key ? 900 : 700, fontSize: char.key ? 80 : 66, color: on ? accent : '#fff', opacity: lit,
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
          return <div key={i} style={{ fontWeight: 900, fontSize: Array.from(text).length > 5 ? 118 : 146, lineHeight: 1.05, color: accent, fontStyle: 'italic',
            opacity: nowMs >= run.s ? 1 : 0, transform: `scale(${2.2 - 1.2 * slam}) rotate(${(i % 2 ? 2 : -2) * slam}deg) skewX(-6deg)`,
            filter: `blur(${(1 - slam) * 10}px)`, textShadow: HALO, whiteSpace: 'nowrap' }}>{text}</div>;
        }
        const enter = ease((nowMs - run.s + 60) / 260);
        return <div key={i} style={{ fontWeight: 700, fontSize: 64, lineHeight: 1.2, color: '#fff', opacity: enter, textShadow: HALO,
          transform: `translateX(${(1 - enter) * (i % 2 ? 80 : -80)}px)`, filter: `blur(${(1 - enter) * 8}px)` }}>{text}</div>;
      })}
    </div>;
  } else if (page) {
    captionNode = <div style={{ position: 'absolute', left: 90, right: 90, bottom: captionBottom, textAlign: 'center', fontFamily: FONT, lineHeight: 1.22,
      opacity: ease((nowMs - page.startMs + 60) / 200) }}>
      {runs.map((run, i) => {
        const text = run.chars.map((char) => char.t).join('');
        return run.key
          ? <span key={i} style={{ fontWeight: 900, fontSize: 80, color: 'transparent', backgroundImage: `linear-gradient(90deg, #fff, ${accent})`,
              WebkitBackgroundClip: 'text', backgroundClip: 'text', filter: `drop-shadow(0 0 3px rgba(0,0,0,.7)) drop-shadow(0 0 18px ${accent}aa)`, margin: '0 6px' }}>{text}</span>
          : <span key={i} style={{ fontWeight: 600, fontSize: 64, color: '#fff', textShadow: HALO }}>{text}</span>;
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
