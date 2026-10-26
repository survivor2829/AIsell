import React from 'react';
import catalog from './narration-templates.json';
import glossary from './word-glossary.json';
const typography = catalog.typography;
import type { NarrationCue } from './NarrationLayout';

export type NarrationPlan = {
  version: 4; templateId: string; mode: string; reasons: string[]; candidates: string[]; warnings: string[];
  analysisStatus: string; motion: string; blocked?: boolean;
  layout: { revision?: number; align?: 'center'; left: number; width: number; top: number; bottom: number; showTitle: boolean; titleTop: number; compact: boolean };
  pages: { text: string; startMs: number; endMs: number; phrase?: string; emphasisMode?: 'inline' | 'stacked'; ordinal?: number }[];
  soundEvents: { startMs: number; sound: string; gain: number }[];
  variant?: { palette: string; accent: string; transition: 'flash' | 'iris' | 'push'; rhythm: string };
  camera?: { focusX: number; focusY: number; shots: { startMs: number; scale: number }[] };
  stickers?: { text: string; startMs: number; endMs: number; side: 'left' | 'right' | 'top'; top: number; width: number; fontSize: number; rotate: number }[];
};

// 只在词与词之间换行：词边界插入零宽空格，再配合 keep-all 禁止在词中间断开。
// 词边界规则和 word-breaks.cjs 相同：系统分词 + 行业词表 + 「数字+单位」不拆。
type WordSegmenter = { segment(text: string): Iterable<{ segment: string }> };
const segmenter = new (Intl as unknown as { Segmenter: new (locale: string, options: { granularity: 'word' }) => WordSegmenter }).Segmenter('zh-CN', { granularity: 'word' });
const NUMBER_WITH_UNIT = /[0-9０-９.零〇一二两三四五六七八九十百千万亿半几]+(?:万平|平方|平米|小时|分钟|公分|厘米|毫米|公斤|升|个|台|次|天|年|元|块|倍|人|米|点)/gu;
function wrapWords(text: string) {
  const chars = Array.from(text), ends = new Set<number>();
  let at = 0;
  for (const part of segmenter.segment(text)) { at += Array.from(part.segment).length; ends.add(at); }
  const keep = (index: number, word: string) => { const start = Array.from(text.slice(0, index)).length; for (let inner = start + 1; inner < start + Array.from(word).length; inner++) ends.delete(inner); };
  for (const word of glossary.words) for (let index = text.indexOf(word); index >= 0; index = text.indexOf(word, index + 1)) keep(index, word);
  for (const match of text.matchAll(NUMBER_WITH_UNIT)) keep(match.index ?? 0, match[0]);
  return chars.map((char, index) => char + (ends.has(index + 1) && index + 1 < chars.length ? '\u200B' : '')).join('');
}

// 花字：斜放在脸旁边空着的一侧，弹入后轻微晃动，到点淡出。
function Sticker({ sticker, nowMs, accent }: { sticker: NonNullable<NarrationPlan['stickers']>[number]; nowMs: number; accent: string }) {
  if (nowMs < sticker.startMs || nowMs >= sticker.endMs) return null;
  const elapsed = nowMs - sticker.startMs, left = sticker.endMs - nowMs;
  const pop = 1 - .35 * Math.exp(-elapsed / 120) * Math.cos(elapsed / 55);
  const fade = Math.min(1, left / 200, elapsed / 90);
  // 头顶上方的花字一行放下；脸旁边的窄，超过 4 个字分两行。
  const chars = Array.from(sticker.text), perLine = sticker.side === 'top' ? chars.length : Math.min(chars.length, 4);
  const lines = chars.length > perLine ? [chars.slice(0, Math.ceil(chars.length / 2)).join(''), chars.slice(Math.ceil(chars.length / 2)).join('')] : [sticker.text];
  return <div style={{ position: 'absolute', top: sticker.top, width: sticker.width, ...(sticker.side === 'left' ? { left: 18 } : sticker.side === 'right' ? { right: 18 } : { left: (1080 - sticker.width) / 2 }),
    display: 'flex', justifyContent: 'center', opacity: fade, transform: `rotate(${sticker.rotate + Math.sin(elapsed / 260) * 1.2}deg) scale(${pop})` }}>
    <div style={{ padding: '10px 16px 14px', borderRadius: 16, background: '#111a', border: `5px solid ${accent}`, boxShadow: '0 10px 24px #0008',
      fontFamily: '"Narration Sans", "Microsoft YaHei", sans-serif', fontWeight: 900, fontSize: sticker.fontSize, lineHeight: 1.12, color: accent,
      textAlign: 'center', WebkitTextStroke: '3px #101915', paintOrder: 'stroke fill', textShadow: '0 4px 0 #000a' }}>
      {lines.map(line => <div key={line}>{line}</div>)}
    </div>
  </div>;
}

// All positions are in the 1080x1920 composition. Preview scales this composition,
// never reflows it. Actual outputs use the frozen plan, demos use labelled cues.
export function NarrationLayoutV4({ styleId, title, cues, nowMs, emphasis = [], plan }: {
  styleId: string; title: string; cues: NarrationCue[]; nowMs: number; emphasis?: string[]; plan?: NarrationPlan;
}) {
  const minimal = styleId === 'minimal_v4', impact = styleId === 'impact_v4';
  // 每条片子的强调色由包装方案轮换；旧方案没有时沿用版式自带的颜色。
  const accent = plan?.variant?.accent || (impact ? '#FFE56B' : '#9AF2BE');
  const layout = plan?.layout || { revision: 2, align: 'center' as const, left: 115, width: 850, top: 1210, bottom: catalog.safeLayout.bottom, showTitle: true, titleTop: 120, compact: false };
  const page = (plan?.pages || cues).find(c => nowMs >= c.startMs && nowMs < c.endMs);
  const phrase = page && ('phrase' in page ? page.phrase : emphasis.find(p => page.text.includes(p) && p.length <= 8)) || '';
  const at = phrase && page ? page.text.indexOf(phrase) : -1;
  const inline = page && 'emphasisMode' in page && page.emphasisMode === 'inline';
  const elapsed = page ? Math.max(0, nowMs - page.startMs) : 0;
  const enter = 1 - Math.pow(1 - Math.min(1, elapsed / (minimal ? 180 : 260)), 3);
  const pop = impact && plan?.motion !== 'quiet' ? 1 - .12 * Math.exp(-elapsed / 110) * Math.cos(elapsed / 65) : 1;
  const before = at >= 0 ? page!.text.slice(0, at) : '', after = at >= 0 ? page!.text.slice(at + phrase.length) : '';
  const body: React.CSSProperties = { fontFamily: '"Narration Sans", "Microsoft YaHei", sans-serif', color: '#fff', fontWeight: 700, lineHeight: 1.16, textShadow: '0 3px 8px #000b', WebkitTextStroke: '2px #101915', paintOrder: 'stroke fill', boxSizing: 'border-box', wordBreak: 'keep-all' };
  const heading = title.split(/[，。！？：:]/u).filter(Boolean);
  const titleEnter = 1 - Math.pow(1 - Math.min(1, nowMs / 300), 3);
  return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
    <div style={{ position: 'absolute', left: 0, right: 0,
      ...(layout.bottom < 1000 ? { top: 0, height: layout.bottom + 50, background: `linear-gradient(rgba(6,12,10,${minimal ? '.32' : '.55'}),rgba(6,12,10,.28) 80%,transparent)` }
        : { top: Math.max(1050, layout.top - 120), bottom: 0, background: `linear-gradient(transparent,rgba(6,12,10,${minimal ? '.32' : '.55'}) 48%,rgba(6,12,10,.22))` }) }} />
    {layout.showTitle && !(plan?.stickers || []).some(s => s.side === 'top' && nowMs >= s.startMs - 150 && nowMs < s.endMs + 150) && <div style={{ ...body, position: 'absolute', top: layout.titleTop, left: layout.left, width: layout.width,
      transform: `translateY(${(1 - titleEnter) * -12}px)`, opacity: .8 + titleEnter * .2 }}>
      {minimal ? <div style={{ display: 'inline-block', maxWidth: 820, padding: '15px 24px', borderRadius: 10, background: '#12221dde',
        fontSize: 48, fontWeight: 750, lineHeight: 1.25, textWrap: 'balance' }}>{title}</div>
        : <div style={{ textAlign: 'center', fontSize: title.length > 16 ? 64 : 76, fontWeight: 900, lineHeight: 1.22, textWrap: 'balance', WebkitTextStroke: '3px #142019' }}>
          {heading.length > 1 ? <>{heading[0]}<br /><span style={{ color: accent }}>{heading.slice(1).join('，')}</span></> : title}
          <div style={{ width: impact ? 92 : 60, height: impact ? 8 : 5, borderRadius: 3, background: accent, margin: '18px auto 0' }} />
        </div>}
    </div>}
    {page && <div style={{ ...body, position: 'absolute', left: layout.left, width: layout.width, bottom: 1920 - layout.bottom,
      transform: `translateY(${(1 - enter) * (minimal || plan?.motion === 'quiet' ? 7 : 20)}px)`, opacity: .72 + .28 * enter,
      textAlign: layout.align || (minimal ? 'center' : 'left'), overflowWrap: 'break-word', textWrap: 'balance' }}>
      {at >= 0 && !inline ? <>
        {before && <div style={{ fontWeight: minimal ? 650 : 500, color: '#EEF1ED', fontSize: typography.auxSize, marginBottom: 12 }}>{wrapWords(before)}</div>}
        <div style={{ position: 'relative', display: minimal ? 'block' : 'inline-block', maxWidth: '100%', fontSize: phrase.length > 6 ? typography.longEmphasisSize : typography.emphasisSize,
          fontWeight: 900, lineHeight: 1.12, color: accent, WebkitTextStroke: '3px #15231c',
          transform: `scale(${pop}) rotate(${impact ? -1.5 : 0}deg)`, transformOrigin: layout.align === 'center' ? 'center' : 'left center' }}>
          {phrase}
          {!minimal && <svg width="100%" height="16" viewBox="0 0 300 16" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible', opacity: .9 }} aria-hidden="true">
            <path d={impact ? 'M0 12 L300 4' : 'M0 10 Q140 2 300 8'} fill="none" stroke={accent} strokeWidth={impact ? 7 : 4} strokeLinecap="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - enter} />
          </svg>}
        </div>
        {after && <div style={{ fontWeight: minimal ? 650 : 500, fontSize: typography.auxSize, marginTop: 12 }}>{wrapWords(after)}</div>}
      </> : <div style={{ fontSize: typography.bodySize, fontWeight: minimal ? 700 : 650, lineHeight: 1.12,
        ...(minimal ? { display: 'inline-block', background: '#13201a80', padding: '10px 16px', borderRadius: 8 } : {}) }}>{inline && at >= 0 ? <>{wrapWords(before)}<span style={{ color: accent, fontWeight: 900 }}>{phrase}</span>{wrapWords(after)}</> : wrapWords(page.text)}</div>}
    </div>}
    {(plan?.stickers || []).map(sticker => <Sticker key={sticker.startMs} sticker={sticker} nowMs={nowMs} accent={accent} />)}
  </div>;
}
