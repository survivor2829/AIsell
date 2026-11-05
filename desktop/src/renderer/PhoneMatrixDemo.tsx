import { useEffect, useRef, useState } from "react";
import { Cable, MonitorSmartphone, Usb } from "lucide-react";
import { isWindowShown, onWindowShownChange } from "./window-shown";
import "./PhoneMatrixDemo.css";

// 手机矩阵示例（用户 2026-11-04 录的真实操作，去掉了侧栏和顶部账号栏、无声）：客户没接手机时一看就知道
// 要集线器、要插到电脑上，接上后可以批量回桌面、打开微信、一键息屏。只在画面露出来、窗口在前台时播放。
const src = (kind: "mp4" | "jpg") => new URL(`./phone-matrix-demo/demo.${kind}`, document.baseURI).toString();
const STEPS = [
  { icon: Usb, title: "手机插上集线器", detail: "安卓手机打开「USB 调试」" },
  { icon: Cable, title: "集线器连到电脑", detail: "手机自动出现在手机墙上" },
  { icon: MonitorSmartphone, title: "一起操控", detail: "回桌面、打开微信等 App、一键息屏" }
];

export function PhoneMatrixDemo({ compact = false, autoPlay = true }: { compact?: boolean; autoPlay?: boolean }) {
  const box = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [seen, setSeen] = useState(false);
  const [foreground, setForeground] = useState(isWindowShown);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setSeen(entry.isIntersecting));
    if (box.current) observer.observe(box.current);
    const off = onWindowShownChange(() => setForeground(isWindowShown()));
    return () => { observer.disconnect(); off(); };
  }, []);
  useEffect(() => {
    if (failed) return;
    if (seen && foreground && autoPlay) void video.current?.play().catch(() => {});
    else video.current?.pause();
  }, [seen, foreground, autoPlay, failed]);

  return <section ref={box} className={`pm-demo${compact ? " is-compact" : ""}`} aria-label="手机矩阵示例">
    <div className="pm-demo-stage">
      {failed ? <img src={src("jpg")} alt="手机矩阵示例画面" />
        : <video ref={video} src={src("mp4")} poster={src("jpg")} muted loop playsInline controls preload="metadata" onError={() => setFailed(true)} />}
      <span className="pm-demo-tag">示例</span>
    </div>
    <div className="pm-demo-copy">
      <strong>插上集线器，几十部手机一起管</strong>
      <ol>{STEPS.map(({ icon: Icon, title, detail }) => <li key={title}><Icon size={18} /><span><b>{title}</b><small>{detail}</small></span></li>)}</ol>
    </div>
  </section>;
}
