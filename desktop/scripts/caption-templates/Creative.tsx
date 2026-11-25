import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Caption } from "./Templates";

// Round 2 (user 2026-11-24: 框像疤、过时): no boxes or colour blocks. Text lives in the
// scene — behind the person, coloured from the footage, carried by the camera.

export type CreativeProps = {
  template: "depth" | "editorial" | "kinetic" | "glow";
  clip: string;
  audio?: string;
  person?: string; // transparent person layer (same timing as clip) for text behind people
  // Set from the person matte: true only when the title band is mostly free of people
  // (a close-up face would hide the whole title, so it then stands in front).
  titleBehind?: boolean;
  accent: string; // sampled from the footage
  eyebrow: string;
  title: [string, string];
  captions: Caption[];
  keywords: string[];
  durationMs: number;
};

const FONTS = `
@font-face { font-family: Noto; src: url(${staticFile("noto.ttf")}); font-weight: 100 900; }
@font-face { font-family: Smiley; src: url(${staticFile("smiley.ttf")}); }
@font-face { font-family: SerifHeavy; src: url(${staticFile("serif.ttf")}); }
`;

type Run = { text: string; key: boolean; s: number; chars: { t: string; s: number }[] };

function runs(caption: Caption, keywords: string[]): Run[] {
  const marks = new Array(caption.text.length).fill(false);
  for (const key of keywords) {
    let at = caption.text.indexOf(key);
    while (at >= 0) {
      for (let i = at; i < at + key.length; i += 1) marks[i] = true;
      at = caption.text.indexOf(key, at + key.length);
    }
  }
  const out: Run[] = [];
  [...caption.text].forEach((ch, i) => {
    const s = caption.words[i]?.s ?? caption.start + ((caption.end - caption.start) * i) / caption.text.length;
    const last = out[out.length - 1];
    if (last && last.key === marks[i]) {
      last.text += ch;
      last.chars.push({ t: ch, s });
    } else out.push({ text: ch, key: marks[i], s, chars: [{ t: ch, s }] });
  });
  return out;
}

// No box under captions: a soft dark halo keeps white text readable on a white shirt or bright floor.
const HALO = "0 2px 4px rgba(0,0,0,.55), 0 0 18px rgba(0,0,0,.45), 0 0 46px rgba(0,0,0,.35)";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

function useTime() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { frame, fps, ms: (frame / fps) * 1000 };
}

const springAt = (frame: number, fps: number, ms: number, config: { damping: number; stiffness: number; mass?: number }) =>
  spring({ frame: frame - Math.round((ms / 1000) * fps), fps, config });

const currentCaption = (p: CreativeProps, ms: number) => p.captions.find((c) => ms >= c.start - 60 && ms < c.end + 100);

// The camera leans in a little on every keyword and settles back.
function cameraScale(p: CreativeProps, ms: number, strength: number) {
  let push = 0;
  for (const c of p.captions) for (const r of runs(c, p.keywords)) {
    if (!r.key) continue;
    push = Math.max(push, interpolate(ms - r.s, [0, 160, 900, 1700], [0, 1, 0.45, 0], clamp));
  }
  return 1 + strength * push;
}

function Scene({ p, behind, scale }: { p: CreativeProps; behind: React.ReactNode; scale: number }) {
  return (
    <AbsoluteFill style={{ transform: `scale(${scale})` }}>
      <OffthreadVideo src={staticFile(p.clip)} muted={Boolean(p.audio)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      {behind}
      {p.person ? <OffthreadVideo src={staticFile(p.person)} transparent muted style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} /> : null}
    </AbsoluteFill>
  );
}

/* A 字在人后：巨型标题立在人物身后，字幕随语音逐字点亮 */
function Depth(p: CreativeProps) {
  const { frame, fps, ms } = useTime();
  const cap = currentCaption(p, ms);
  const title = (
    <div style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center" }}>
      {p.title.map((line, l) => (
        <div key={l} style={{ font: `900 ${l ? 176 : 196}px/1.02 Noto`, letterSpacing: -6, color: l ? p.accent : "#fff",
          textShadow: "0 18px 60px rgba(0,0,0,.35)" }}>
          {[...line].map((ch, i) => {
            const rise = springAt(frame, fps, 150 + (l * line.length + i) * 45, { damping: 18, stiffness: 120 });
            return <span key={i} style={{ display: "inline-block", opacity: rise, transform: `translateY(${(1 - rise) * 90}px)`, filter: `blur(${(1 - rise) * 14}px)` }}>{ch}</span>;
          })}
        </div>
      ))}
    </div>
  );
  return (
    <AbsoluteFill>
      <Scene p={p} behind={p.titleBehind ? title : null} scale={cameraScale(p, ms, 0.05)} />
      {p.titleBehind ? null : title}
      {cap ? (
        <div style={{ position: "absolute", top: 1390, left: 70, right: 70, textAlign: "center", textShadow: HALO }}>
          {runs(cap, p.keywords).map((r, i) => (
            <span key={i}>
              {r.chars.map((c, k) => {
                const lit = interpolate(ms, [c.s - 40, c.s + 80], [0.38, 1], clamp);
                return <span key={k} style={{ font: `${r.key ? 900 : 700} ${r.key ? 76 : 62}px Noto`, color: r.key && lit > 0.9 ? p.accent : "#fff", opacity: lit,
                  textShadow: r.key && lit > 0.9 ? `0 0 28px ${p.accent}88, ${HALO}` : undefined }}>{c.t}</span>;
              })}
            </span>
          ))}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

/* B 杂志排版：宋体粗标题 + 极细副标题左对齐，字幕左下逐行揭开，关键词换宋体 */
function Editorial(p: CreativeProps) {
  const { ms } = useTime();
  const cap = currentCaption(p, ms);
  const wipe = (start: number, len = 700) => interpolate(ms, [start, start + len], [100, 0], clamp);
  const title = (
    <div style={{ position: "absolute", top: 210, left: 84, right: 84 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18, font: "500 30px Noto", letterSpacing: 10, color: "#fff", opacity: 0.9,
        clipPath: `inset(0 ${wipe(100)}% 0 0)` }}>
        <span style={{ width: 70 * (1 - wipe(0, 500) / 100), height: 2, background: p.accent }} />{p.eyebrow}
      </div>
      <div style={{ marginTop: 26, font: "136px/1.08 SerifHeavy", color: "#fff", clipPath: `inset(0 ${wipe(350, 800)}% 0 0)`,
        textShadow: "0 10px 50px rgba(0,0,0,.45)" }}>{p.title[0]}</div>
      <div style={{ marginTop: 18, font: "200 80px/1.1 Noto", letterSpacing: 8, color: "#fff", clipPath: `inset(0 ${wipe(800, 800)}% 0 0)`,
        textShadow: "0 6px 30px rgba(0,0,0,.5)" }}>{p.title[1]}</div>
    </div>
  );
  return (
    <AbsoluteFill>
      <Scene p={p} behind={null} scale={cameraScale(p, ms, 0.035)} />
      {title}
      <AbsoluteFill style={{ background: "radial-gradient(120% 60% at 0% 100%, rgba(0,0,0,.55), rgba(0,0,0,0) 60%)" }} />
      {cap ? (
        <div key={cap.start} style={{ position: "absolute", top: 1360, left: 84, right: 120, clipPath: `inset(${interpolate(ms, [cap.start - 60, cap.start + 220], [100, 0], clamp)}% 0 0 0)` }}>
          {runs(cap, p.keywords).map((r, i) => (
            <span key={i} style={r.key ? { font: "80px SerifHeavy", color: p.accent, margin: "0 6px", textShadow: HALO } : { font: "500 58px Noto", color: "#fff", textShadow: HALO }}>{r.text}</span>
          ))}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

/* C 动态字流：镂空标题随播放进度被填满；字幕按重要程度错落排版，关键词砸进画面 */
function Kinetic(p: CreativeProps) {
  const { frame, fps, ms } = useTime();
  const cap = currentCaption(p, ms);
  const progress = (ms / p.durationMs) * 100;
  const title = (
    <div style={{ position: "absolute", top: 170, left: 0, right: 0, textAlign: "center" }}>
      {p.title.map((line, l) => (
        <div key={l} style={{ font: `900 ${l ? 104 : 118}px/1.15 Noto`, letterSpacing: 2, color: "transparent",
          WebkitTextStroke: "3px rgba(255,255,255,.95)",
          backgroundImage: `linear-gradient(90deg, #fff ${progress}%, rgba(255,255,255,0) ${progress}%)`, WebkitBackgroundClip: "text", backgroundClip: "text" }}>{line}</div>
      ))}
    </div>
  );
  const layout = cap ? runs(cap, p.keywords) : [];
  const flash = layout.some((r) => r.key && ms >= r.s && ms < r.s + 90);
  return (
    <AbsoluteFill>
      <Scene p={p} behind={null} scale={cameraScale(p, ms, 0.08)} />
      {title}
      {flash ? <AbsoluteFill style={{ background: "#fff", opacity: 0.16 }} /> : null}
      {cap ? (
        <div style={{ position: "absolute", top: 1240, left: 60, right: 60, display: "flex", flexDirection: "column", alignItems: "center", gap: 0 }}>
          {layout.map((r, i) => {
            if (r.key) {
              const slam = springAt(frame, fps, r.s, { damping: 11, stiffness: 260 });
              return <div key={i} style={{ font: `150px/1.05 Smiley`, color: p.accent, opacity: ms >= r.s ? 1 : 0,
                transform: `scale(${interpolate(slam, [0, 1], [2.2, 1])}) rotate(${(i % 2 ? 2 : -2) * slam}deg)`, filter: `blur(${(1 - slam) * 10}px)`,
                textShadow: HALO }}>{r.text}</div>;
            }
            const enter = springAt(frame, fps, r.s, { damping: 18, stiffness: 220 });
            return <div key={i} style={{ font: "700 60px/1.2 Noto", color: "#fff", opacity: enter, transform: `translateX(${(1 - enter) * (i % 2 ? 80 : -80)}px)`,
              filter: `blur(${(1 - enter) * 8}px)`, textShadow: HALO }}>{r.text}</div>;
          })}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

/* D 光感：标题取画面主色做渐变并有光扫过，字幕柔光，关键词渐变发光 */
function Glow(p: CreativeProps) {
  const { ms } = useTime();
  const cap = currentCaption(p, ms);
  const sweep = ((ms % 3200) / 3200) * 260 - 80;
  const titleFill = `linear-gradient(100deg, #fff 0%, #fff 35%, ${p.accent} 100%)`;
  const shine = `linear-gradient(100deg, rgba(255,255,255,0) ${sweep - 12}%, rgba(255,255,255,.95) ${sweep}%, rgba(255,255,255,0) ${sweep + 12}%)`;
  const appear = interpolate(ms, [0, 900], [0, 1], clamp);
  const title = (
    <div style={{ position: "absolute", top: 190, left: 0, right: 0, textAlign: "center", opacity: appear, transform: `translateY(${(1 - appear) * 30}px)`,
      filter: `drop-shadow(0 0 30px ${p.accent}66)` }}>
      {p.title.map((line, l) => (
        <div key={l} style={{ font: `900 ${l ? 96 : 112}px/1.18 Noto`, letterSpacing: 4, color: "transparent",
          backgroundImage: `${shine}, ${titleFill}`, WebkitBackgroundClip: "text", backgroundClip: "text" }}>{line}</div>
      ))}
    </div>
  );
  return (
    <AbsoluteFill>
      <Scene p={p} behind={null} scale={cameraScale(p, ms, 0.04)} />
      {title}
      {cap ? (
        <div style={{ position: "absolute", top: 1380, left: 70, right: 70, textAlign: "center",
          opacity: interpolate(ms, [cap.start - 60, cap.start + 140], [0, 1], clamp) }}>
          {runs(cap, p.keywords).map((r, i) => (
            <span key={i} style={r.key
              ? { font: "900 78px Noto", color: "transparent", backgroundImage: `linear-gradient(90deg, #fff, ${p.accent})`, WebkitBackgroundClip: "text",
                  backgroundClip: "text", filter: `drop-shadow(0 0 3px rgba(0,0,0,.7)) drop-shadow(0 0 18px ${p.accent}aa)`, margin: "0 6px" }
              : { font: "600 62px Noto", color: "#fff", textShadow: HALO }}>{r.text}</span>
          ))}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

const BY_ID = { depth: Depth, editorial: Editorial, kinetic: Kinetic, glow: Glow };

export const CreativeTemplate: React.FC<CreativeProps> = (props) => {
  const Body = BY_ID[props.template];
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <style>{FONTS}</style>
      {props.audio ? <Audio src={staticFile(props.audio)} /> : null}
      <Body {...props} />
    </AbsoluteFill>
  );
};
