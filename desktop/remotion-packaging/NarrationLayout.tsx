import React from 'react';
import { NarrationLayoutV4, type NarrationPlan } from './NarrationLayoutV4';
import catalog from './narration-templates.json';

export type NarrationCue = { text: string; startMs: number; endMs: number; words?: NarrationCue[] };
export type NarrationLayoutProps = { styleId: string; title: string; cues: NarrationCue[]; nowMs: number; emphasis?: string[]; plan?: NarrationPlan };

// Real word boundaries are the only source for page timing. Sentence-only
// captions remain a sentence; no guessed per-character timestamps.
export function narrationPages(cues: NarrationCue[], emphasis: string[] = [], pageLength = 16): NarrationCue[] {
  return cues.flatMap((cue) => {
    if (!cue.words?.length || cue.text.length <= pageLength + 2) return [cue];
    const pages: NarrationCue[] = []; let words: NarrationCue[] = [], offset = 0;
    const fullText = cue.words.map((word) => word.text).join('');
    const protectedRanges = emphasis.flatMap((phrase) => Array.from(fullText.matchAll(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu')), (match) => [match.index!, match.index! + phrase.length]));
    for (const [index, word] of cue.words.entries()) {
      words.push(word);
      offset += word.text.length;
      const text = words.map((item) => item.text).join('');
      const pause = (cue.words[index + 1]?.startMs ?? word.endMs) - word.endMs;
      const insideEmphasis = protectedRanges.some(([start, end]) => offset > start && offset < end);
      if (!insideEmphasis && (text.length >= pageLength || (text.length >= 5 && (pause >= 250 || /[，。！？；、,.!?;]$/u.test(text))))) {
        pages.push({ text, startMs: words[0].startMs, endMs: word.endMs, words }); words = [];
      }
    }
    if (words.length) pages.push({ text: words.map((word) => word.text).join(''), startMs: words[0].startMs, endMs: cue.endMs, words });
    return pages;
  });
}

export function NarrationLayout({ styleId, title, cues, nowMs, emphasis = [], plan }: NarrationLayoutProps) {
  if (styleId.endsWith('_v4')) return <NarrationLayoutV4 styleId={styleId} title={title} cues={cues} nowMs={nowMs} emphasis={emphasis} plan={plan} />;
  if (catalog.templates.find((item) => item.id === styleId)?.version === 3) return <NarrationLayoutV3 styleId={styleId} title={title} cues={cues} nowMs={nowMs} emphasis={emphasis} />;
  if (catalog.templates.find((item) => item.id === styleId)?.version === 2) {
    return <NarrationLayoutV2 styleId={styleId} title={title} cues={cues} nowMs={nowMs} emphasis={emphasis} />;
  }
  const template = catalog.templates.find((item) => item.id === styleId) || catalog.templates[0];
  const pages = narrationPages(cues, emphasis);
  const cue = pages.find((item) => nowMs >= item.startMs && nowMs < item.endMs);
  const minimal = template.layout === 'minimal', impact = template.layout === 'impact';
  const elapsed = cue ? Math.max(0, nowMs - cue.startMs) : 0;
  const enter = 1 - Math.pow(1 - Math.min(1, elapsed / 230), 3);
  const selected = cue && emphasis.filter((text) => cue.text.includes(text)).sort((a, b) => b.length - a.length)[0];
  const text = cue?.text || '';
  const at = selected ? text.indexOf(selected) : -1;
  const rawAfter = selected ? text.slice(at + selected.length) : '';
  const attachedPunctuation = rawAfter.match(/^[，。！？；、,.!?;]+/u)?.[0] || '';
  const after = rawAfter.slice(attachedPunctuation.length);
  const punctuationOnly = /^[\s，。！？；、,.!?;]*$/u.test(after);
  const base: React.CSSProperties = { position: 'absolute', fontFamily: '"Narration Sans", "Microsoft YaHei", sans-serif', color: '#fff', boxSizing: 'border-box' };
  const shadow = '0 4px 6px #000a';
  const titleSize = title.length > 20 ? 58 : 72;
  const bodySize = Math.max(38, Math.min(minimal ? 64 : 78, 1280 / Math.max(16, text.length)));
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    {!minimal && <div style={{ position: 'absolute', inset: '49% 0 0', background: 'linear-gradient(transparent,rgba(0,0,0,.56) 52%,rgba(0,0,0,.22))' }} />}
    <div style={{ ...base, top: 104, left: minimal ? 64 : 100, right: minimal ? 240 : 100, textAlign: minimal ? 'left' : 'center',
      fontSize: minimal ? 42 : titleSize, fontWeight: 900, lineHeight: 1.18, overflowWrap: 'anywhere', textShadow: shadow,
      WebkitTextStroke: minimal ? undefined : '2px #171a1c', paintOrder: 'stroke fill',
      ...(minimal ? { width: 'fit-content', maxWidth: 740, padding: '14px 22px', background: '#202624b3', borderRadius: 8 } : {}) }}>
      {minimal ? title : <><span style={{ color: template.accent }}>{title.slice(0, Math.min(6, Math.ceil(title.length / 2)))}</span>{title.slice(Math.min(6, Math.ceil(title.length / 2)))}</>}
    </div>
    {cue && <div style={{ ...base, left: minimal ? 100 : 100, right: 140, top: minimal ? '71%' : '65%',
      textAlign: minimal ? 'center' : 'left', textWrap: 'balance', fontSize: bodySize, fontWeight: minimal ? 800 : 500, lineHeight: 1.4,
      textShadow: shadow, WebkitTextStroke: minimal ? '3px #131816' : '1px #202521', paintOrder: 'stroke fill',
      transform: `translateY(${(1 - enter) * (minimal ? 8 : 22)}px)`, opacity: .65 + .35 * enter }}>
      {at >= 0 ? <>
        {text.slice(0, at) && <div style={{ color: '#F0F3F0', fontSize: bodySize * .83, marginBottom: 10 }}>{text.slice(0, at)}</div>}
        <div style={{ width: 'fit-content', maxWidth: '100%', color: template.accent, fontSize: bodySize * (impact ? 1.32 : 1.12), fontWeight: 900,
          lineHeight: 1.2, margin: minimal ? '0 auto' : undefined, transformOrigin: 'left center',
          transform: impact ? `rotate(-3deg) scale(${.9 + enter * .1})` : undefined, WebkitTextStroke: '3px #16201b', paintOrder: 'stroke fill' }}>{selected}{attachedPunctuation}{punctuationOnly ? after : ''}</div>
        {!punctuationOnly && <div style={{ marginTop: 10, fontSize: bodySize * .92 }}>{after}</div>}
      </> : <div style={{ fontWeight: minimal ? 800 : 750, color: '#FFFFFF', overflowWrap: 'anywhere' }}>{text}</div>}
    </div>}
  </div>;
}

// V3 uses measured cue/word boundaries only. Legacy rendering stays unchanged.
function NarrationLayoutV3({ styleId, title, cues, nowMs, emphasis = [] }: NarrationLayoutProps) {
  const template = catalog.templates.find((item) => item.id === styleId)!;
  const cue = narrationPages(cues, emphasis, 10).find((item) => nowMs >= item.startMs && nowMs < item.endMs);
  const impact = template.layout === 'impact', minimal = template.layout === 'minimal';
  const text = cue?.text || '', elapsed = cue ? Math.max(0, nowMs - cue.startMs) : 0;
  const enter = 1 - Math.pow(1 - Math.min(1, elapsed / (minimal ? 180 : 260)), 3);
  const phrase = emphasis.filter((item) => item && text.includes(item)).sort((a, b) => b.length - a.length)[0];
  const at = phrase ? text.indexOf(phrase) : -1;
  const trailing = phrase ? text.slice(at + phrase.length) : '';
  const punctuation = trailing.match(/^[，。！？；、,.!?;]+/u)?.[0] || '';
  const after = trailing.slice(punctuation.length);
  const accentSize = phrase && phrase.length <= 6 ? (impact ? 156 : 140) : 120;
  const bodySize = text.length > 36 ? 72 : minimal ? 88 : 92;
  const pop = impact ? 1 - .16 * Math.exp(-elapsed / 120) * Math.cos(elapsed / 60) : .96 + .04 * enter;
  const base: React.CSSProperties = { position: 'absolute', boxSizing: 'border-box', fontFamily: '"Narration Sans", "Microsoft YaHei", sans-serif', color: '#fff', fontWeight: 900, paintOrder: 'stroke fill', WebkitTextStroke: '5px #15221d', textShadow: '0 5px 9px #0009' };
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', inset: '53% 0 0', background: `linear-gradient(transparent,rgba(10,18,14,${minimal ? '.38' : '.68'}) 55%,rgba(10,18,14,.24))` }} />
    <div style={{ ...base, top: 108, left: 72, right: 130, fontSize: minimal ? 52 : title.length > 16 ? 64 : 74, lineHeight: 1.2, textWrap: 'balance', textAlign: minimal ? 'left' : 'center', overflowWrap: 'anywhere' }}>
      <span style={{ color: minimal ? '#fff' : template.accent, ...(minimal ? { background: '#16251dde', padding: '10px 18px', boxDecorationBreak: 'clone' } : {}) }}>{title}</span>
    </div>
    {cue && <div style={{ ...base, left: 74, right: 132, bottom: 320, fontSize: bodySize, lineHeight: 1.18, textWrap: 'balance', textAlign: minimal ? 'center' : 'left', overflowWrap: 'anywhere', opacity: .75 + .25 * enter, transform: `translateY(${(1 - enter) * (minimal ? 10 : 26)}px)` }}>
      {at >= 0 ? <>
        {text.slice(0, at) && <div style={{ fontSize: minimal ? bodySize : 80, color: '#F1F2EE', marginBottom: 14 }}>{text.slice(0, at)}</div>}
        <div style={{ color: template.accent, fontSize: accentSize, lineHeight: 1.12, fontWeight: 950, transform: `rotate(${impact ? -2 : 0}deg) scale(${minimal ? 1 : pop})`, transformOrigin: minimal ? 'center' : 'left center' }}>{phrase}{punctuation}</div>
        {after && <div style={{ marginTop: 14 }}>{after}</div>}
      </> : <div>{text}</div>}
    </div>}
  </div>;
}

function NarrationLayoutV2({ styleId, title, cues, nowMs, emphasis = [] }: NarrationLayoutProps) {
  const template = catalog.templates.find((item) => item.id === styleId)!;
  // Keep the V1 page algorithm's measured word edges. Without word times the
  // whole observed sentence is laid out together, never fake word-by-word read.
  const cue = narrationPages(cues, emphasis).find((item) => nowMs >= item.startMs && nowMs < item.endMs);
  const minimal = template.layout === 'minimal', impact = template.layout === 'impact';
  const cueElapsed = cue ? Math.max(0, nowMs - cue.startMs) : 0;
  // Display pages within the observed sentence interval. These are layout
  // transitions, not invented word timestamps or word-follow highlighting.
  const displayPages: string[] = [];
  let remaining = cue?.text || '';
  while (remaining.length > 22) {
    let boundary = 18;
    const punctuationAt = remaining.slice(4, 19).search(/[，。！？；、,.!?;]/u);
    if (punctuationAt >= 0) boundary = punctuationAt + 5;
    for (const phrase of emphasis) {
      const at = remaining.indexOf(phrase);
      if (at >= 0 && at < boundary && at + phrase.length > boundary) boundary = at || at + phrase.length;
    }
    displayPages.push(remaining.slice(0, boundary)); remaining = remaining.slice(boundary);
  }
  if (remaining) displayPages.push(remaining);
  const pageDuration = cue ? (cue.endMs - cue.startMs) / Math.max(1, displayPages.length) : 1;
  const pageIndex = Math.min(displayPages.length - 1, Math.floor(cueElapsed / Math.max(1, pageDuration)));
  const elapsed = cueElapsed - Math.max(0, pageIndex) * pageDuration;
  const progress = Math.min(1, elapsed / (minimal ? 180 : 280));
  const enter = 1 - Math.pow(1 - progress, 3);
  const pop = impact ? 1 - .15 * Math.exp(-elapsed / 130) * Math.cos(elapsed / 62) : .95 + enter * .05;
  const text = displayPages[pageIndex] || '';
  const selected = emphasis.filter((phrase) => phrase && text.includes(phrase)).sort((a, b) => b.length - a.length)[0];
  const at = selected ? text.indexOf(selected) : -1;
  const trailing = selected ? text.slice(at + selected.length) : '';
  const punctuation = trailing.match(/^[，。！？；、,.!?;]+/u)?.[0] || '';
  const after = trailing.slice(punctuation.length);
  const bodySize = text.length > 24 ? 72 : minimal ? 88 : 96;
  // A long user-selected phrase is kept intact and accented, rather than
  // overflowing or secretly deleting text to make an oversized keyword fit.
  const emphasisSize = selected && selected.length <= 14 ? Math.max(120, Math.min(160, 820 / (selected.length + punctuation.length))) : bodySize;
  const base: React.CSSProperties = { position: 'absolute', boxSizing: 'border-box', fontFamily: '"Narration Sans", "Microsoft YaHei", sans-serif', color: '#fff' };
  const ink: React.CSSProperties = { textShadow: '0 6px 12px #0009', WebkitTextStroke: '5px #141a19', paintOrder: 'stroke fill' };
  const titleProgress = 1 - Math.pow(1 - Math.min(1, Math.max(0, nowMs) / 320), 3);
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', inset: '55% 0 0', background: minimal
      ? 'linear-gradient(transparent,rgba(0,0,0,.24) 38%,rgba(0,0,0,.38))'
      : 'linear-gradient(transparent,rgba(0,0,0,.68) 46%,rgba(0,0,0,.34))' }} />
    <div style={{ ...base, ...ink, top: 110, left: 76, right: 116, textAlign: minimal ? 'left' : 'center',
      fontWeight: 900, fontSize: minimal ? 50 : title.length > 16 ? 64 : 76, lineHeight: 1.22, textWrap: 'balance', overflowWrap: 'anywhere',
      transform: `translateY(${(1 - titleProgress) * -14}px)`, opacity: .6 + titleProgress * .4 }}>
      <span style={minimal ? { display: 'inline', padding: '8px 14px', background: '#17211bd9', boxDecorationBreak: 'clone' }
        : { color: template.accent }}>{title}</span>
    </div>
    {cue && <div style={{ ...base, ...ink, left: 76, right: 124, top: text.length > 32 ? 1100 : 1200,
      fontSize: bodySize, fontWeight: 900, lineHeight: 1.17, textAlign: minimal ? 'center' : 'left', textWrap: 'balance',
      overflowWrap: 'anywhere', transform: `translateY(${(1 - enter) * (minimal ? 12 : 32)}px)`, opacity: .7 + enter * .3 }}>
      {at >= 0 ? <>
        {text.slice(0, at) && <div style={{ color: minimal ? '#FFF' : '#EDF0EE', marginBottom: 14 }}>{text.slice(0, at)}</div>}
        <div style={{ position: 'relative', width: 'fit-content', maxWidth: '100%', color: template.accent,
          fontSize: emphasisSize, fontWeight: 950, lineHeight: 1.12, margin: minimal ? '0 auto' : undefined,
          transformOrigin: minimal ? 'center' : 'left center', transform: `rotate(${impact ? -2 : 0}deg) scale(${minimal ? 1 : pop})` }}>
          {selected}{punctuation}
          {!minimal && <span aria-hidden style={{ display: 'block', height: impact ? 9 : 6, width: `${enter * 100}%`,
            marginTop: 10, background: template.accent, opacity: impact ? .9 : .65 }} />}
        </div>
        {after && <div style={{ marginTop: 14 }}>{after}</div>}
      </> : <div>{text}</div>}
    </div>}
  </div>;
}
