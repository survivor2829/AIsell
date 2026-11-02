import { useEffect, useRef, useState } from "react";

// 首页示例成片轮播（用户 2026-11-02）：产品效果、线索混剪交替播放；用户决定本人数字人先不上首页。
// 文件是首页专用的 15 秒 480p 无声短片；任何时候只解码一个视频，另一块手机只放下一条的封面图，低配电脑也跑得动。
const CLIPS = ["cc1-pro", "lead-mix"] as const;
const clip = (name: string, kind: "mp4" | "jpg") => `./home-reel/${name}.${kind}`;
// 不放视频时封面图也照样轮换。
const STILL_MS = 6000;
const prefersStill = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || (navigator.hardwareConcurrency || 4) <= 2;

export function HomeReel() {
  const [index, setIndex] = useState(0);
  const [still, setStill] = useState(prefersStill);
  // Only plays while it is really on screen: a hidden reel (small window, minimized app) must not keep decoding.
  const [seen, setSeen] = useState(false);
  const [foreground, setForeground] = useState(() => !document.hidden);
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const next = () => setIndex((current) => (current + 1) % CLIPS.length);
  const running = seen && foreground;

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setSeen(entry.isIntersecting));
    if (box.current) observer.observe(box.current);
    const onVisibility = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  useEffect(() => {
    if (still) return;
    if (running) void video.current?.play().catch(() => {});
    else video.current?.pause();
  }, [index, running, still]);
  useEffect(() => {
    if (!still || !running) return;
    const timer = window.setTimeout(next, STILL_MS);
    return () => window.clearTimeout(timer);
  }, [index, running, still]);

  const current = CLIPS[index], upcoming = CLIPS[(index + 1) % CLIPS.length];
  return <div className="home-reel" aria-hidden="true" ref={box}>
    <div className="home-phone is-small"><img key={upcoming} src={clip(upcoming, "jpg")} alt="" /></div>
    <div className="home-phone">
      {still ? <img key={current} src={clip(current, "jpg")} alt="" />
        : <video ref={video} src={clip(current, "mp4")} poster={clip(current, "jpg")} muted playsInline preload="metadata" onEnded={next} onError={() => setStill(true)} />}
      <span>示例成片</span>
    </div>
  </div>;
}
