import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";

import effectRegistryData from "./effect-registry.json";
import layoutGridData from "./layout-grid.json";
import stylePackData from "./style-packs.json";
import narrationEmoji from "./narration-emoji.json";
import type {
  EffectRendererId,
  EffectSelection,
  FocusRect,
  MotionEvent,
  MotionLayoutZone,
  MotionManifest,
  StylePack,
  TimedWord
} from "./types";

const stylePacks = stylePackData as Record<MotionManifest["styleId"], StylePack>;
const layoutGrid = layoutGridData as Record<MotionLayoutZone, { x: number; y: number; width: number; height: number }>;
const baseFont = '"Microsoft YaHei", "Noto Sans SC", sans-serif';

type RegistryVariant = { id: string; styles: string[]; motion: string; surface: string };
type RegistryComponent = {
  id: string;
  target: "event" | "focus";
  renderer: EffectRendererId;
  eventTypes: string[];
  sizes: string[];
  zones: string[];
  variants: RegistryVariant[];
};
type ResolvedEffect = { component: RegistryComponent; variant: RegistryVariant };

const registryComponents = effectRegistryData.components as RegistryComponent[];
const registryComponentsById = new Map(
  registryComponents.map((component) => [component.id, component])
);
const registryVariantsByComponent = new Map(
  registryComponents.map((component) => [
    component.id,
    new Map(component.variants.map((variant) => [variant.id, variant]))
  ])
);
const msToFrame = (milliseconds: number, fps: number) => Math.max(0, Math.round((milliseconds * fps) / 1_000));
const activeAt = (startMs: number, endMs: number, nowMs: number) => nowMs >= startMs && nowMs < endMs;

export const resolveRegisteredEffect = (
  effect: EffectSelection | undefined,
  styleId: MotionManifest["styleId"],
  target: RegistryComponent["target"],
  event?: MotionEvent
): ResolvedEffect | null => {
  if (!effect || effect.registryVersion !== effectRegistryData.version) return null;
  const component = registryComponentsById.get(effect.componentId);
  if (component?.target !== target) return null;
  if (!component || component.renderer !== effect.renderer) return null;
  const variant = registryVariantsByComponent.get(component.id)?.get(effect.variantId);
  if (!variant || !(
    variant.styles.includes(styleId)
    && variant.motion === effect.motion
    && variant.surface === effect.surface
  )) return null;
  if (event && (
    !component.eventTypes.includes(event.type)
    || !component.sizes.includes(event.size)
    || !component.zones.includes(event.zone)
  )) return null;
  return { component, variant };
};

const motionEventLayout = (event: MotionEvent): React.CSSProperties => {
  const cell = layoutGrid[event.zone];
  return {
    left: Math.round(cell.x * 1080),
    top: Math.round(cell.y * 1920),
    width: Math.round(cell.width * 1080)
  };
};

const eventProgress = (event: MotionEvent, frame: number, fps: number) => {
  const start = msToFrame(event.startMs, fps);
  const duration = Math.max(1, msToFrame(event.endMs - event.startMs, fps));
  const intro = spring({ frame: frame - start, fps, config: { damping: 13, stiffness: 180, mass: 0.7 } });
  const outro = interpolate(frame, [start + duration - 8, start + duration], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic)
  });
  return Math.max(0, intro * outro);
};

const iconPaths: Record<string, React.ReactNode> = {
  brush: <><path d="M10 4h10v4H10z" /><path d="M8 8h14l-2 12H10z" /><path d="M7 20h16" /></>,
  office: <><path d="M7 22V5h10v17" /><path d="M3 22h18" /><path d="M10 9h2M10 13h2M10 17h2" /></>,
  shop: <><path d="M4 10h16v12H4z" /><path d="M3 10l2-6h14l2 6" /><path d="M9 22v-7h6v7" /></>,
  spark: <><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" /><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z" /></>,
  warning: <><path d="M12 3l10 18H2z" /><path d="M12 9v5M12 18h.01" /></>,
  check: <path d="M4 13l5 5L20 6" />
};

const LineIcon: React.FC<{ name: string | null; color: string; size?: number }> = ({ name, color, size = 54 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    {iconPaths[name || "spark"] || iconPaths.spark}
  </svg>
);

const variantDirection = (effect: EffectSelection) => (
  [...effect.variantId].reduce((total, character) => total + character.codePointAt(0)!, 0) % 2 ? 1 : -1
);

const effectSurface = (pack: StylePack, effect: EffectSelection): React.CSSProperties => {
  const outlined = ["outline", "rule", "bracket", "underline"].includes(effect.surface);
  const glass = effect.surface === "glass";
  const solid = effect.surface === "solid";
  return {
    color: solid ? pack.palette.ink : pack.palette.paper,
    background: solid ? pack.palette.accent : glass ? `${pack.palette.ink}E0` : `${pack.palette.ink}C7`,
    border: `${outlined ? 3 : 2}px solid ${outlined ? pack.palette.accent : pack.palette.paper}`,
    borderRadius: effect.surface === "pill" ? 999 : effect.surface === "column" ? 2 : 24,
    boxShadow: outlined
      ? `${variantDirection(effect) * 7}px 9px 0 ${pack.palette.accent}55`
      : `0 0 ${glass ? 38 : 20}px ${pack.palette.accent}55 inset`
  };
};

const effectTransform = (effect: EffectSelection, progress: number, distance = 56) => {
  const direction = variantDirection(effect);
  if (["mask", "sweep", "slide", "wipe", "page", "crop", "draw"].includes(effect.motion)) {
    return `translateX(${(1 - progress) * distance * direction}px)`;
  }
  if (["lock", "scan", "trace", "scope", "depth", "reveal", "blink"].includes(effect.motion)) {
    return `translateY(${(1 - progress) * distance}px) scale(${0.96 + progress * 0.04})`;
  }
  return `scale(${0.72 + progress * 0.28}) rotate(${(1 - progress) * 5 * direction}deg)`;
};

const effectAttributes = (effect: EffectSelection) => ({
  "data-effect-component": effect.componentId,
  "data-effect-variant": effect.variantId,
  "data-effect-motion": effect.motion,
  "data-effect-surface": effect.surface
});

const VideoBase: React.FC<{ manifest: MotionManifest; pack: StylePack; frame: number; zoomProgress: number }> = ({ manifest, pack, frame, zoomProgress }) => {
  const reference = manifest.captionPresentation === "reference_narration";
  const scale = reference ? 1 : pack.video.scale + Math.sin(frame / pack.video.pulseDivisor) * pack.video.pulse + zoomProgress * 0.035;
  return (
    <AbsoluteFill style={{ backgroundColor: pack.palette.ink, overflow: "hidden" }}>
      <OffthreadVideo
        src={staticFile(manifest.sourceFile)}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${scale})` }}
      />
      {!reference && <AbsoluteFill style={{ background: pack.video.overlay }} />}
    </AbsoluteFill>
  );
};

type EventEffectProps = { event: MotionEvent; pack: StylePack; progress: number };
type EventEffectRenderer = React.FC<EventEffectProps>;

const ElasticHeadingEffect: EventEffectRenderer = ({ event, pack, progress }) => (
  <div {...effectAttributes(event.effect)} style={{
    position: "absolute", ...motionEventLayout(event), ...effectSurface(pack, event.effect),
    padding: event.size === "hero" ? "28px 34px" : "22px 28px", fontFamily: baseFont,
    fontSize: event.size === "hero" ? 68 : event.size === "card" ? 54 : 40, fontWeight: 950,
    lineHeight: 1.06, opacity: progress, transform: effectTransform(event.effect, progress, 72)
  }}>{event.text}</div>
);

const KeywordStickerEffect: EventEffectRenderer = ({ event, pack, progress }) => (
  <div {...effectAttributes(event.effect)} style={{
    position: "absolute", ...motionEventLayout(event), ...effectSurface(pack, event.effect), width: "fit-content",
    maxWidth: Math.round(layoutGrid[event.zone].width * 1080), padding: event.effect.surface === "tape" ? "20px 30px 14px" : "16px 26px",
    fontFamily: baseFont, fontSize: event.size === "card" ? 48 : 38, fontWeight: 900, lineHeight: 1.08,
    opacity: progress, transform: effectTransform(event.effect, progress)
  }}>{event.text}</div>
);

const SvgCalloutEffect: EventEffectRenderer = ({ event, pack, progress }) => (
  <div {...effectAttributes(event.effect)} style={{
    position: "absolute", ...motionEventLayout(event), ...effectSurface(pack, event.effect), display: "flex",
    alignItems: "center", gap: 18, padding: "18px 24px", fontFamily: baseFont,
    fontSize: event.size === "card" ? 46 : 36, fontWeight: 850, opacity: progress,
    transform: effectTransform(event.effect, progress)
  }}>
    <LineIcon name={event.type === "warning" ? "warning" : event.icon} color={pack.palette.accent} size={event.size === "card" ? 58 : 46} />
    <span>{event.text}</span>
    <svg width="58" height="28" viewBox="0 0 58 28" fill="none" aria-hidden="true">
      <path d="M2 14h47m-9-9 9 9-9 9" stroke={pack.palette.accent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </div>
);

const NumericStepCardEffect: EventEffectRenderer = ({ event, pack, progress }) => (
  <div {...effectAttributes(event.effect)} style={{
    position: "absolute", ...motionEventLayout(event), ...effectSurface(pack, event.effect), display: "grid",
    gridTemplateColumns: "86px 1fr", alignItems: "center", padding: "20px 26px", fontFamily: baseFont,
    opacity: progress, transform: effectTransform(event.effect, progress)
  }}>
    <span style={{ color: pack.palette.accent, fontSize: 58, fontWeight: 950, lineHeight: 1 }}>{String(Math.max(1, event.ordinal)).padStart(2, "0")}</span>
    <span style={{ fontSize: event.size === "hero" ? 54 : event.size === "card" ? 46 : 36, fontWeight: 850, lineHeight: 1.08 }}>{event.text}</span>
  </div>
);

const ChapterBarEffect: EventEffectRenderer = ({ event, pack, progress }) => (
  <div {...effectAttributes(event.effect)} style={{
    position: "absolute", ...motionEventLayout(event), color: pack.palette.paper, fontFamily: baseFont,
    fontSize: event.size === "hero" ? 62 : event.size === "card" ? 50 : 38, fontWeight: 900,
    lineHeight: 1.08, opacity: progress, transform: effectTransform(event.effect, progress)
  }}>
    <div>{event.text}</div>
    <div style={{ width: `${Math.round(progress * 100)}%`, height: event.effect.surface === "rule" ? 4 : 10, marginTop: 14, background: pack.palette.accent }} />
  </div>
);

const ZoomTransitionEffect: EventEffectRenderer = ({ event, pack, progress }) => (
  <div {...effectAttributes(event.effect)} style={{
    position: "absolute", ...motionEventLayout(event), ...effectSurface(pack, event.effect), width: "fit-content",
    padding: "12px 20px", fontFamily: baseFont, fontSize: event.size === "hero" ? 48 : event.size === "card" ? 40 : 32,
    fontWeight: 850, opacity: progress, transform: effectTransform(event.effect, progress)
  }}>{event.text}</div>
);

type EventRendererId = Exclude<EffectRendererId, "focusFrame">;
const eventEffectRenderers: Record<EventRendererId, EventEffectRenderer> = {
  elasticHeading: ElasticHeadingEffect,
  keywordSticker: KeywordStickerEffect,
  svgCallout: SvgCalloutEffect,
  numericStepCard: NumericStepCardEffect,
  chapterBar: ChapterBarEffect,
  zoomTransition: ZoomTransitionEffect
};

type RegisteredEventEffectProps = EventEffectProps & { definition?: ResolvedEffect };
export const RegisteredEventEffect: React.FC<RegisteredEventEffectProps> = ({ event, pack, progress, definition: resolved }) => {
  const definition = resolved || resolveRegisteredEffect(event.effect, pack.id, "event", event);
  if (!definition || definition.component.renderer === "focusFrame") return null;
  const Renderer = eventEffectRenderers[definition.component.renderer];
  return Renderer ? <Renderer event={event} pack={pack} progress={progress} /> : null;
};

type FocusEffectProps = { focus: FocusRect; pack: StylePack; frame: number };
type FocusEffectRenderer = React.FC<FocusEffectProps>;
type RegisteredFocusEffectProps = FocusEffectProps & { definition: ResolvedEffect };

const FocusFrameEffect: FocusEffectRenderer = ({ focus, pack, frame }) => {
  const { fps } = useVideoConfig();
  const start = msToFrame(focus.startMs, fps);
  const appear = spring({ frame: frame - start, fps, config: { damping: 14, stiffness: 170 } });
  return (
    <div {...effectAttributes(focus.effect)} style={{
      position: "absolute", left: `${focus.x * 100}%`, top: `${focus.y * 100}%`, width: `${focus.width * 100}%`, height: `${focus.height * 100}%`,
      border: `${focus.effect.surface === "outline" ? 3 : 5}px solid ${pack.palette.accent}`,
      borderRadius: focus.effect.surface === "rule" ? 2 : 26,
      boxShadow: `0 0 0 9999px rgba(4,8,13,.24), ${variantDirection(focus.effect) * 8}px 0 36px ${pack.palette.accent}88`,
      opacity: appear, transform: effectTransform(focus.effect, appear, 12), transformOrigin: "center"
    }} />
  );
};

const focusEffectRenderers: Partial<Record<EffectRendererId, FocusEffectRenderer>> = {
  focusFrame: FocusFrameEffect
};

export const REGISTERED_RENDERER_IDS = Object.freeze([
  ...Object.keys(eventEffectRenderers),
  ...Object.keys(focusEffectRenderers)
] as EffectRendererId[]);

const RegisteredFocusEffect: React.FC<RegisteredFocusEffectProps> = ({ focus, pack, frame, definition }) => {
  const Renderer = focusEffectRenderers[definition.component.renderer];
  return Renderer ? <Renderer focus={focus} pack={pack} frame={frame} /> : null;
};

type CaptionTreatment = { gap: string; padding: string; background: string; border: string; borderRadius: number; fontSize: number };
const captionTreatments: Record<string, (pack: StylePack) => CaptionTreatment> = {
  "low-bubble": () => ({ gap: "10px 7px", padding: "20px 26px", background: "rgba(20,16,25,.78)", border: "none", borderRadius: 34, fontSize: 50 }),
  "editorial-line": () => ({ gap: "10px 2px", padding: "22px 30px 28px", background: "rgba(10,10,11,.74)", border: "none", borderRadius: 0, fontSize: 48 }),
  "glass-console": (pack) => ({ gap: "10px 7px", padding: "22px 30px", background: "rgba(4,20,31,.82)", border: `2px solid ${pack.palette.accent}99`, borderRadius: 20, fontSize: 50 })
};

export const findActiveCaptionIndex = (captions: TimedWord[], nowMs: number) => (
  captions.findIndex((word) => activeAt(word.startMs, word.endMs, nowMs))
);

const CaptionTrack: React.FC<{ captions: TimedWord[]; pack: StylePack; nowMs: number; frame: number }> = ({ captions, pack, nowMs, frame }) => {
  const { fps } = useVideoConfig();
  if (!captions.length) return null;
  const activeIndex = findActiveCaptionIndex(captions, nowMs);
  if (activeIndex < 0) return null;
  const treatment = (captionTreatments[pack.caption.placement] || captionTreatments["low-bubble"])(pack);
  // A timed item can be a Chinese sentence, not just one word. Bound pages
  // by display width as well as item count, and never cross a sentence end.
  const pageWidth = Math.floor((1080 - 128 - 60) / treatment.fontSize) * 1.6;
  let pageStart = 0;
  let pageEnd = 0;
  while (pageEnd <= activeIndex) {
    pageStart = pageEnd;
    let width = 0;
    while (pageEnd < captions.length) {
      const text = captions[pageEnd].text;
      const nextWidth = Array.from(String(text)).reduce((sum, char) => sum + (/[^\x00-\xff]/u.test(char) ? 1 : 0.55), 0) + 0.5;
      if (pageEnd > pageStart && (width + nextWidth > pageWidth || pageEnd - pageStart >= pack.caption.maxWordsPerPage)) break;
      width += nextWidth;
      pageEnd += 1;
      if (/[。！？.!?]$/u.test(text.trim())) break;
    }
  }
  const page = captions.slice(pageStart, pageEnd);
  return (
    <div style={{
      position: "absolute", left: 64, right: 64, bottom: 132, display: "flex", justifyContent: "center", flexWrap: "wrap",
      gap: treatment.gap, padding: treatment.padding, background: treatment.background, border: treatment.border,
      borderRadius: treatment.borderRadius, backdropFilter: "blur(14px)", boxShadow: "0 18px 50px rgba(0,0,0,.25)",
      fontFamily: baseFont, fontSize: treatment.fontSize, fontWeight: 900, lineHeight: 1.28
    }}>
      {page.map((word, index) => {
        const absoluteIndex = pageStart + index;
        const active = absoluteIndex === activeIndex;
        const wordFrame = frame - msToFrame(word.startMs, fps);
        const bounce = active ? spring({ frame: wordFrame, fps, config: { damping: 12, stiffness: 220, mass: 0.55 } }) : 1;
        return (
          <span key={`${word.startMs}-${index}`} style={{
            position: "relative", display: "inline-block", color: active ? pack.palette.ink : pack.palette.paper,
            background: active ? pack.palette.accent : "transparent", padding: active ? "0 8px 3px" : "0 2px 3px",
            borderRadius: active && treatment.borderRadius > 0 ? 10 : 0,
            transform: `scale(${active ? 0.82 + bounce * (pack.caption.activeScale - 0.82) : 1})`,
            textShadow: active ? "none" : "0 3px 8px rgba(0,0,0,.65)"
          }}>{word.text}</span>
        );
      })}
    </div>
  );
};

const captionWidth = (text: string) => Array.from(text).reduce((sum, char) => sum + (/[^\x00-\xff]/u.test(char) ? 1 : 0.55), 0);

// Linguistic word boundaries protect numbers, names and two-character words.
// Long untimed fallback paragraphs remain a single caption; shrinking the
// typography never implies that a guessed reading position is ASR evidence.
export const referenceCaptionLines = (text: string): { lines: string[]; fontSize: number } => {
  const clean = text.replace(/\s+/gu, " ").trim()
    .replace(/(\p{Script=Han}) +(?=\p{Script=Han})/gu, "$1");
  if (captionWidth(clean) <= 14.6) return { lines: [clean], fontSize: 64 };
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const breaks = Array.from(segmenter.segment(clean)).slice(1).map((segment) => segment.index)
    .filter((index) => !/^[，。！？、；：,.!?;:\uFFFC]/u.test(clean.slice(index))
      && captionWidth(clean.slice(0, index)) >= 2 && captionWidth(clean.slice(index)) >= 2);
  if (!breaks.length) return { lines: [clean], fontSize: Math.min(64, 920 / Math.max(1, captionWidth(clean))) };
  const score = (index: number) => {
    const left = captionWidth(clean.slice(0, index));
    const right = captionWidth(clean.slice(index));
    const punctuationBreak = /[，。！？、；：,.!?;:]\s*$/u.test(clean.slice(0, index));
    return Math.max(left, right) * 3 + Math.abs(left - right) - (punctuationBreak ? 3 : 0);
  };
  const at = breaks.reduce((best, next) => score(next) < score(best) ? next : best);
  const lines = [clean.slice(0, at).trim(), clean.slice(at).trim()];
  return { lines, fontSize: Math.min(64, 920 / Math.max(...lines.map(captionWidth))) };
};

type NarrationEmoji = { id: string; keywords: string[]; dataUri: string };
const narrationEmojiAssets = narrationEmoji.images as NarrationEmoji[];

const selectNarrationDecorations = (captions: TimedWord[], durationMs: number) => {
  const maximum = Math.min(4, Math.max(2, Math.round(durationMs / 12_000)));
  const chosen: { index: number; asset: NarrationEmoji }[] = [];
  for (const [index, caption] of captions.entries()) {
    const asset = narrationEmojiAssets.find((item) => item.keywords.some((keyword) => caption.text.includes(keyword)));
    if (!asset || chosen.some((item) => Math.abs(captions[item.index].startMs - caption.startMs) < 6_000)) continue;
    chosen.push({ index, asset });
    if (chosen.length >= maximum) break;
  }
  return chosen;
};

const ReferenceCaptionTrack: React.FC<{ captions: TimedWord[]; nowMs: number; durationMs: number }> = ({ captions, nowMs, durationMs }) => {
  const activeIndex = findActiveCaptionIndex(captions, nowMs);
  const decorations = React.useMemo(() => selectNarrationDecorations(captions, durationMs), [captions, durationMs]);
  if (activeIndex < 0) return null;
  const caption = captions[activeIndex];
  const decoration = decorations.find((item) => item.index === activeIndex);
  const keyword = decoration?.asset.keywords.find((word) => caption.text.includes(word));
  const insertion = keyword ? caption.text.indexOf(keyword) + keyword.length : -1;
  // The placeholder participates in line width, but never enters narration text.
  const displayText = insertion >= 0
    ? `${caption.text.slice(0, insertion)}\uFFFC${caption.text.slice(insertion)}`
    : caption.text;
  const { lines, fontSize } = referenceCaptionLines(displayText);
  const emphasis = caption.text.match(/不用|担心|终于|放心|省心|反复|来不及|看清楚|关键/u)?.[0];
  return (
    <div style={{ position: "absolute", left: 70, right: 70, top: "74%", transform: "translateY(-50%)",
      textAlign: "center", fontFamily: baseFont, fontSize, fontWeight: 800, lineHeight: 1.28,
      color: "#fff", WebkitTextStroke: "4px #141414", paintOrder: "stroke fill", textShadow: "0 3px 2px rgba(0,0,0,.6)" }}>
      {lines.map((line, index) => {
        return <div key={index} style={{ whiteSpace: "pre" }}>{line.split("\uFFFC").map((part, partIndex) => {
          const at = emphasis ? part.indexOf(emphasis) : -1;
          return <React.Fragment key={partIndex}>
            {partIndex > 0 && decoration ? <Img src={decoration.asset.dataUri} style={{ display: "inline-block", width: "1em", height: "1em", verticalAlign: "-0.12em", filter: "drop-shadow(0 2px 2px rgba(0,0,0,.35))" }} /> : null}
            {at < 0 ? part : <>{part.slice(0, at)}<span style={{ color: "#ffe88d" }}>{emphasis}</span>{part.slice(at + emphasis!.length)}</>}
          </React.Fragment>;
        })}</div>;
      })}
    </div>
  );
};

const SoundEffects: React.FC<{ events: MotionEvent[]; fps: number }> = ({ events, fps }) => (
  <>
    {events.map((event, index) => {
      const sound = event.type === "hook" || event.type === "result" ? "sfx-whoosh.wav" : event.type === "warning" ? "sfx-click.wav" : "sfx-pop.wav";
      return (
        <Sequence key={`${event.startMs}-${index}`} from={msToFrame(event.startMs, fps)} durationInFrames={Math.max(2, msToFrame(450, fps))} layout="none">
          <Audio src={staticFile(sound)} volume={event.type === "hook" ? 0.18 : 0.11} />
        </Sequence>
      );
    })}
  </>
);

export const DynamicPackaging: React.FC<MotionManifest> = (manifest) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = (frame / fps) * 1_000;
  const pack = stylePacks[manifest.styleId];
  const registeredEvents = React.useMemo(() => manifest.events.flatMap((event) => {
    const definition = resolveRegisteredEffect(event.effect, pack.id, "event", event);
    return definition ? [{ event, definition }] : [];
  }), [manifest.events, pack.id]);
  const registeredFocusRects = React.useMemo(() => manifest.focusRects.flatMap((focus) => {
    const definition = resolveRegisteredEffect(focus.effect, pack.id, "focus");
    return definition ? [{ focus, definition }] : [];
  }), [manifest.focusRects, pack.id]);
  const soundEvents = React.useMemo(
    () => registeredEvents.map(({ event }) => event),
    [registeredEvents]
  );
  const activeEvents = registeredEvents.filter(({ event }) =>
    activeAt(event.startMs, event.endMs, nowMs) &&
    (manifest.captionPresentation !== "reference_narration" || event.reason === "narrated_ending_cta"));
  const activeFocus = manifest.captionPresentation === "reference_narration" ? null : registeredFocusRects.find(({ focus }) => activeAt(focus.startMs, focus.endMs, nowMs));
  const zoomEvent = activeEvents.find(({ event }) => event.effect.renderer === "zoomTransition");
  const zoomProgress = zoomEvent ? eventProgress(zoomEvent.event, frame, fps) : 0;
  return (
    <AbsoluteFill style={{ background: pack.palette.ink, overflow: "hidden" }}>
      <VideoBase manifest={manifest} pack={pack} frame={frame} zoomProgress={zoomProgress} />
      {activeFocus ? <RegisteredFocusEffect focus={activeFocus.focus} definition={activeFocus.definition} pack={pack} frame={frame} /> : null}
      {activeEvents.map(({ event, definition }, index) => (
        <RegisteredEventEffect key={`${event.startMs}-${event.effect.variantId}-${index}`} event={event} definition={definition} pack={pack} progress={eventProgress(event, frame, fps)} />
      ))}
      {manifest.captionPresentation === "reference_narration"
        ? <ReferenceCaptionTrack captions={manifest.captions} nowMs={nowMs} durationMs={manifest.durationMs} />
        : <CaptionTrack captions={manifest.captions} pack={pack} nowMs={nowMs} frame={frame} />}
      {manifest.captionPresentation !== "reference_narration" ? <SoundEffects events={soundEvents} fps={fps} /> : null}
    </AbsoluteFill>
  );
};
