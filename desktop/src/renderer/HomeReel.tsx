import { useEffect, useRef, useState } from "react";
import { isWindowShown, onWindowShownChange } from "./window-shown";

// 首页示例成片（用户 2026-11-09）：产品效果、线索混剪两只手机一样大，打开就同时循环播放，不用点。
// 文件是首页专用的 15 秒 480p 无声短片；看不到首页时暂停，减少动效或只有两个核的电脑只放封面图。
const CLIPS = ["cc1-pro", "lead-mix"] as const;
const clip = (name: string, kind: "mp4" | "jpg") => `./home-reel/${name}.${kind}`;
const prefersStill = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || (navigator.hardwareConcurrency || 4) <= 2;

export function HomeReel() {
  const [still] = useState(prefersStill);
  const [broken, setBroken] = useState(false);
  const [seen, setSeen] = useState(false);
  const [foreground, setForeground] = useState(isWindowShown);
  const box = useRef<HTMLDivElement>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const running = seen && foreground;
  const playing = !broken && !still;

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
  }, [running, playing]);

  return <div className="home-reel" ref={box} aria-label="两条示例成片">
    {CLIPS.map((name, slot) => <div key={name} className="home-phone">
      {playing ? <video ref={(element) => { videos.current[slot] = element; }} src={clip(name, "mp4")} poster={clip(name, "jpg")}
        muted playsInline autoPlay preload="auto" loop onError={() => setBroken(true)} />
        : <img src={clip(name, "jpg")} alt="" />}
      <span>示例成片</span>
    </div>)}
  </div>;
}
