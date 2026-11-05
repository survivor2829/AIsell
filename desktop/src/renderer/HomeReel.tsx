import { useEffect, useRef, useState } from "react";
import { isWindowShown, onWindowShownChange } from "./window-shown";

// 首页示例成片（用户 2026-11-02 / 11-04）：产品效果、线索混剪两只手机一样大。
// 默认轮播：任何时候只解码一个视频，另一只手机放下一条的封面图，低配电脑也跑得动。
// 点一下两条同时播（循环），再点一下回到轮播。文件是首页专用的 15 秒 480p 无声短片。
const CLIPS = ["cc1-pro", "lead-mix"] as const;
const clip = (name: string, kind: "mp4" | "jpg") => `./home-reel/${name}.${kind}`;
// 不放视频时封面图也照样轮换。
const STILL_MS = 6000;
const prefersStill = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || (navigator.hardwareConcurrency || 4) <= 2;

export function HomeReel() {
  const [index, setIndex] = useState(0);
  const [still, setStill] = useState(prefersStill);
  const [broken, setBroken] = useState(false);
  const [together, setTogether] = useState(false);
  // Only plays while it is really on screen: a hidden reel (small window, minimized app) must not keep decoding.
  const [seen, setSeen] = useState(false);
  const [foreground, setForeground] = useState(isWindowShown);
  const box = useRef<HTMLDivElement>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const next = () => setIndex((current) => (current + 1) % CLIPS.length);
  const running = seen && foreground;
  // 用户点了「同时播」就照样播，哪怕默认是静图（低配 / 减少动效）；视频坏了才只放图。
  const playing = !broken && (together || !still);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setSeen(entry.isIntersecting));
    if (box.current) observer.observe(box.current);
    const offShown = onWindowShownChange(() => setForeground(isWindowShown()));
    return () => { observer.disconnect(); offShown(); };
  }, []);
  useEffect(() => {
    for (const video of videos.current) {
      if (!video) continue;
      if (running && playing) void video.play().catch(() => {});
      else video.pause();
    }
  }, [index, running, playing, together]);
  useEffect(() => {
    if (playing || !running) return;
    const timer = window.setTimeout(next, STILL_MS);
    return () => window.clearTimeout(timer);
  }, [index, running, playing]);

  const toggle = () => setTogether((on) => !on);
  // 同时播：两只手机各放各的、循环。轮播：右边大手机放当前这条，左边放下一条的封面。
  const slots = together ? CLIPS.map((name) => ({ name, live: true }))
    : [{ name: CLIPS[(index + 1) % CLIPS.length], live: false }, { name: CLIPS[index], live: true }];
  videos.current = [];
  return <div className="home-reel" ref={box} role="button" tabIndex={0} aria-pressed={together}
    aria-label={together ? "两条示例成片同时播放中，点一下回到轮播" : "示例成片轮播中，点一下两条同时播放"}
    onClick={toggle} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}>
    {slots.map(({ name, live }, slot) => <div key={slot} className={`home-phone${live ? "" : " is-waiting"}`}>
      {live && playing ? <video key={`${name}-${together}`} ref={(element) => { videos.current.push(element); }} src={clip(name, "mp4")} poster={clip(name, "jpg")}
        muted playsInline preload="metadata" loop={together} onEnded={together ? undefined : next} onError={() => setBroken(true)} />
        : <img key={name} src={clip(name, "jpg")} alt="" />}
      {live && <span>示例成片</span>}
      {slot === 0 && <em className="home-reel-hint">{together ? "点一下回到轮播" : "点一下两条一起播"}</em>}
    </div>)}
  </div>;
}
