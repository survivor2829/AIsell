import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2 } from "lucide-react";
import { lowPowerDevice, useWindowActive } from "./power-saving";
import { ExampleVideoPlayer, VIDEO_EXAMPLES } from "./VideoExamples";

// 首页示例成片（用户 2026-11-09）：产品效果、线索混剪两只手机一样大，打开就同时循环播放，不用点。
// 文件是首页专用的 15 秒 480p 无声短片；看不到首页时暂停，减少动效或只有两个核的电脑只放封面图。
// 点手机放大看完整成片（带声音，可全屏，用户 2026-11-24）；产品效果换成新奔 SIBEN 门面片。
const CLIPS = ["siben", "lead-mix"] as const;
const clip = (name: string, kind: "mp4" | "jpg") => `./home-reel/${name}.${kind}`;
// 省电 (2026-11-19): a low-power computer shows the covers, and the clips play only while the window is in use.
const prefersStill = () => lowPowerDevice;

export function HomeReel() {
  const still = useRef(prefersStill()).current;
  const [broken, setBroken] = useState(false);
  const [seen, setSeen] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const foreground = useWindowActive();
  const box = useRef<HTMLDivElement>(null);
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const running = seen && foreground && !opened;
  const playing = !broken && !still;

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setSeen(entry.isIntersecting));
    if (box.current) observer.observe(box.current);
    return () => { observer.disconnect(); };
  }, []);
  useEffect(() => {
    for (const video of videos.current) {
      if (!video) continue;
      if (running && playing) void video.play().catch(() => {});
      else video.pause();
    }
  }, [running, playing]);

  return <div className="home-reel" ref={box} role="group" aria-label="两条示例成片">
    {CLIPS.map((name, slot) => <button type="button" key={name} className="home-phone" aria-label={`放大看${VIDEO_EXAMPLES.find((item) => item.file === name)?.module || ""}示例成片`} onClick={() => setOpened(name)}>
      {playing ? <video ref={(element) => { videos.current[slot] = element; }} src={clip(name, "mp4")} poster={clip(name, "jpg")}
        muted playsInline autoPlay preload="auto" loop onError={() => setBroken(true)} />
        : <img src={clip(name, "jpg")} alt="" />}
      <span>示例成片</span>
      <i className="home-phone-zoom" aria-hidden="true"><Maximize2 size={18} /></i>
    </button>)}
    {/* Outside the reel: small windows hide the reel, and a hidden modal would still block the page. */}
    {opened && createPortal(<ExampleVideoPlayer file={opened} onClose={() => setOpened(null)} />, document.body)}
  </div>;
}
