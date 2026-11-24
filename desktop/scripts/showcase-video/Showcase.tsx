// 主页「场景效果视频」门面片（用户 2026-11-24）：开头几秒把 AI 导演组干活的过程摆出来
// （随手拍的产品照 → 四视角定妆照 → 场景图 → 分镜），再接真实成片镜头，切点卡在音乐鼓点上。
// 过程里的每一步都是这条成片真实走过的环节，素材都是它真实的中间产物。
import React from "react";
import { AbsoluteFill, Audio, Easing, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export type Segment = { src: string; from: number; caption: string };
export type ShowcaseProps = {
  introSeconds: number;
  shotSeconds: number;
  endSeconds: number;
  music: string;
  musicStart: number;
  segments: Segment[];
  products: string[];
  sheet: string;
  plate: string;
  thumbs: string[];
};

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const MONO = '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace';
const ease = Easing.bezier(0.22, 1, 0.36, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// Agents of the real crew, each with its own colour. Paths are [second, x, y] keyframes on the 1080×1920 stage.
type Agent = { name: string; color: string; path: [number, number, number][] };
const AGENTS: Agent[] = [
  { name: "产品分析师", color: "#22d3ee", path: [[0.2, -80, 520], [1.0, 250, 640], [1.8, 560, 700], [2.6, 820, 640], [3.4, 420, 860]] },
  { name: "导演", color: "#f472b6", path: [[0.5, 1160, 420], [1.4, 760, 560], [2.6, 540, 900], [4.2, 300, 1060], [5.8, 540, 1120], [7.0, 760, 1180]] },
  { name: "场景勘察", color: "#a3e635", path: [[1.6, 1160, 1300], [2.8, 820, 1150], [3.6, 720, 980], [4.6, 600, 940], [5.6, 380, 1000]] },
  { name: "摄影师 A", color: "#fb923c", path: [[4.4, -80, 1500], [5.4, 220, 1260], [6.4, 260, 1180], [7.4, 300, 1150]] },
  { name: "摄影师 B", color: "#f59e0b", path: [[4.7, 1160, 1560], [5.7, 560, 1300], [6.6, 540, 1200], [7.4, 560, 1160]] },
  { name: "摄影师 C", color: "#fbbf24", path: [[5.0, 540, 2000], [6.0, 860, 1320], [6.8, 820, 1200], [7.4, 820, 1160]] },
  { name: "质检", color: "#facc15", path: [[5.6, 1160, 900], [6.4, 900, 1080], [7.0, 560, 1120], [7.6, 260, 1120]] },
  { name: "字幕", color: "#a78bfa", path: [[6.2, -80, 1700], [7.0, 380, 1420], [7.6, 620, 1380]] }
];
const LOG: [number, string, string][] = [
  [0.4, "#22d3ee", "产品分析师  读 3 张随手拍：正面 / 侧面 / 操作台"],
  [1.6, "#22d3ee", "产品分析师  出四视角定妆照 · 部件 4 处核对"],
  [2.6, "#a3e635", "场景勘察    工厂仓库 · 水泥地 · 通道开阔"],
  [3.6, "#f472b6", "导演        卖点 3 个 → 镜头 3 个 · 一镜到底"],
  [4.6, "#fb923c", "摄影师 ×3   三个镜头同时开拍"],
  [5.8, "#facc15", "质检        逐镜检查 · 刮条贴地 ✓ 反光 ✓"],
  [6.8, "#a78bfa", "字幕        一趟洗一大片 / 扫吸一体 不扬尘"]
];

function pointAt(path: Agent["path"], t: number) {
  if (t <= path[0][0]) return { x: path[0][1], y: path[0][2], visible: false };
  for (let i = 1; i < path.length; i += 1) {
    const [t1, x1, y1] = path[i];
    const [t0, x0, y0] = path[i - 1];
    if (t <= t1) {
      const k = ease((t - t0) / (t1 - t0));
      return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, visible: true };
    }
  }
  const last = path[path.length - 1];
  return { x: last[1], y: last[2], visible: true };
}

function Cursor({ agent, t }: { agent: Agent; t: number }) {
  const trail = Array.from({ length: 10 }, (_, index) => pointAt(agent.path, t - index * 0.035));
  const head = trail[0];
  if (!head.visible) return null;
  return <>
    {trail.slice(1).map((p, index) => p.visible && <div key={index} style={{ position: "absolute", left: p.x - 6, top: p.y - 6, width: 12, height: 12, borderRadius: 6, background: agent.color, opacity: 0.45 - index * 0.045, filter: "blur(2px)" }} />)}
    <svg width="44" height="52" viewBox="0 0 22 26" style={{ position: "absolute", left: head.x, top: head.y, filter: `drop-shadow(0 0 10px ${agent.color})` }}>
      <path d="M1 1 L1 21 L6.5 16 L10 24 L13.5 22.5 L10 15 L18 15 Z" fill={agent.color} stroke="#0b1020" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
    <div style={{ position: "absolute", left: head.x + 34, top: head.y + 36, padding: "6px 14px", borderRadius: 10, background: agent.color, color: "#0b1020", font: `700 28px ${FONT}`, whiteSpace: "nowrap", boxShadow: `0 0 24px ${agent.color}88` }}>{agent.name}</div>
  </>;
}

function Card({ src, t, at, x, y, w, h, label, glow }: { src: string; t: number; at: number; x: number; y: number; w: number; h: number; label: string; glow: string }) {
  const k = interpolate(t, [at, at + 0.45], [0, 1], { ...clamp, easing: ease });
  if (k <= 0) return null;
  return <div style={{ position: "absolute", left: x, top: y, width: w, height: h, transform: `translateY(${(1 - k) * 60}px) scale(${0.9 + k * 0.1})`, opacity: k, borderRadius: 18, overflow: "hidden", border: `3px solid ${glow}`, boxShadow: `0 0 40px ${glow}55`, background: "#111827" }}>
    <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "10px 14px", background: "linear-gradient(transparent, #000c)", color: "#fff", font: `700 26px ${FONT}` }}>{label}</div>
  </div>;
}

function Intro({ props }: { props: ShowcaseProps }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const end = props.introSeconds;
  const headline = interpolate(t, [0, 0.5], [0, 1], { ...clamp, easing: ease });
  const zoom = interpolate(t, [end - 0.5, end], [1, 2.4], { ...clamp, easing: Easing.in(Easing.cubic) });
  const fade = interpolate(t, [end - 0.35, end], [1, 0], clamp);
  return <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 35%, #1b2550 0%, #0b1020 60%, #05070f 100%)", overflow: "hidden" }}>
    <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(#ffffff0a 1px, transparent 1px), linear-gradient(90deg, #ffffff0a 1px, transparent 1px)", backgroundSize: "60px 60px" }} />
    <div style={{ position: "absolute", top: 110, left: 0, right: 0, textAlign: "center", opacity: headline, transform: `translateY(${(1 - headline) * -30}px)` }}>
      <div style={{ font: `900 84px ${FONT}`, color: "#fff", letterSpacing: 2 }}>3 张随手拍的产品照</div>
      <div style={{ font: `900 84px ${FONT}`, color: "#facc15", marginTop: 10 }}>AI 导演组帮你拍成片</div>
    </div>
    <div style={{ position: "absolute", inset: 0, transform: `scale(${zoom})`, transformOrigin: "540px 1160px", opacity: fade }}>
      {props.products.map((src, index) => <Card key={src} src={src} t={t} at={0.3 + index * 0.25} x={70 + index * 320} y={420} w={300} h={420} label={["正面", "侧面", "操作台"][index] || ""} glow="#22d3ee" />)}
      <Card src={props.sheet} t={t} at={1.7} x={110} y={880} w={420} h={420} label="四视角定妆照" glow="#22d3ee" />
      <Card src={props.plate} t={t} at={2.7} x={570} y={880} w={400} h={420} label="场景：工厂仓库" glow="#a3e635" />
      {props.thumbs.map((src, index) => <Card key={src} src={src} t={t} at={4.6 + index * 0.3} x={110 + index * 290} y={1340} w={270} h={300} label={`镜头 ${index + 1}`} glow="#fb923c" />)}
      {AGENTS.map((agent) => <Cursor key={agent.name} agent={agent} t={t} />)}
    </div>
    <div style={{ position: "absolute", left: 60, right: 60, bottom: 70, height: 240, padding: "16px 22px", borderRadius: 16, background: "#05070fcc", border: "1px solid #ffffff22", opacity: fade, overflow: "hidden" }}>
      {LOG.filter(([at]) => t >= at).slice(-5).map(([at, color, text]) => <div key={at} style={{ font: `600 30px ${MONO}`, color, lineHeight: "42px", whiteSpace: "nowrap", opacity: interpolate(t, [at, at + 0.2], [0, 1], clamp) }}>▸ {text}</div>)}
    </div>
  </AbsoluteFill>;
}

function Shot({ segment, seconds, index }: { segment: Segment; seconds: number; index: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const push = interpolate(t, [0, seconds], [1.04, 1.12]);
  const flash = interpolate(t, [0, 0.12], [0.55, 0], clamp);
  const pop = interpolate(t, [0.05, 0.3], [0, 1], { ...clamp, easing: Easing.out(Easing.back(2)) });
  return <AbsoluteFill style={{ background: "#000" }}>
    <AbsoluteFill style={{ transform: `scale(${push})`, transformOrigin: index % 2 ? "50% 60%" : "50% 45%" }}>
      <OffthreadVideo src={staticFile(segment.src)} startFrom={Math.round(segment.from * fps)} volume={0.18} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
    <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
    {segment.caption && <div style={{ position: "absolute", top: 230, left: 0, right: 0, textAlign: "center", transform: `scale(${0.6 + pop * 0.4})`, opacity: pop }}>
      <span style={{ display: "inline-block", padding: "14px 34px", borderRadius: 18, background: "#facc15", color: "#111", font: `900 86px ${FONT}`, boxShadow: "0 10px 40px #0008" }}>{segment.caption}</span>
    </div>}
  </AbsoluteFill>;
}

function EndCard({ props }: { props: ShowcaseProps }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const k = interpolate(t, [0, 0.5], [0, 1], { ...clamp, easing: ease });
  return <AbsoluteFill style={{ background: "radial-gradient(circle at 50% 40%, #1b2550 0%, #05070f 75%)", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 40 }}>
    <div style={{ display: "flex", gap: 28, alignItems: "center", opacity: k, transform: `translateY(${(1 - k) * 40}px)` }}>
      <Img src={staticFile(props.products[0])} style={{ width: 300, height: 420, objectFit: "cover", borderRadius: 18, border: "3px solid #22d3ee" }} />
      <div style={{ font: `900 110px ${FONT}`, color: "#facc15" }}>→</div>
      <Img src={staticFile(props.thumbs[0])} style={{ width: 300, height: 420, objectFit: "cover", borderRadius: 18, border: "3px solid #fb923c" }} />
    </div>
    <div style={{ font: `900 92px ${FONT}`, color: "#fff", opacity: k }}>场景效果视频</div>
    <div style={{ font: `700 54px ${FONT}`, color: "#cbd5e1", opacity: k }}>上传产品图，AI 拍出现场效果</div>
  </AbsoluteFill>;
}

export function Showcase(props: ShowcaseProps) {
  const { fps } = useVideoConfig();
  const introFrames = Math.round(props.introSeconds * fps);
  const shotFrames = Math.round(props.shotSeconds * fps);
  const endStart = introFrames + shotFrames * props.segments.length;
  return <AbsoluteFill style={{ background: "#000" }}>
    <Audio src={staticFile(props.music)} startFrom={Math.round(props.musicStart * fps)} volume={(f) => interpolate(f, [endStart + Math.round(props.endSeconds * fps) - 25, endStart + Math.round(props.endSeconds * fps)], [1, 0], clamp)} />
    <Sequence durationInFrames={introFrames}><Intro props={props} /></Sequence>
    {props.segments.map((segment, index) => <Sequence key={index} from={introFrames + index * shotFrames} durationInFrames={shotFrames}><Shot segment={segment} seconds={props.shotSeconds} index={index} /></Sequence>)}
    <Sequence from={endStart} durationInFrames={Math.round(props.endSeconds * fps)}><EndCard props={props} /></Sequence>
  </AbsoluteFill>;
}
