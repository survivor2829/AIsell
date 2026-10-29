import { useState, type ReactNode } from "react";
import { PlayCircle, Plus } from "lucide-react";
import { weekCount } from "./overview-stats";
import "./TouchHero.css";

type Loose = Record<string, unknown>;
const asset = (file: string) => new URL(`./video-examples/${file}`, document.baseURI).toString();

// How many people the touch tasks reached this week and today, counting every run of a daily task.
export function touchNumbers(tasks: Loose[], now = Date.now()) {
  const runs = tasks.filter((task) => task.type === "touch").flatMap((task) => Array.isArray(task.runs) && task.runs.length
    ? task.runs as Loose[] : task.completedAt ? [{ completedAt: task.completedAt, done: (task.progress as Loose | undefined)?.done }] : []);
  const done = (run: Loose) => { const value = Number(run.done); return Number.isFinite(value) && value > 0 ? value : 0; };
  const today = new Date(now).toDateString();
  return {
    week: weekCount(runs, ["completedAt"], now, done).now,
    today: runs.filter((run) => new Date(String(run.completedAt)).toDateString() === today).reduce((sum, run) => sum + done(run), 0)
  };
}

// 精准触达的页头（用户 2026-10-29：页面放大后太空，要饱满、大气）：和主页同一套浅色大卡片，
// 左边标题、新建按钮、开关和数字，右边是真实操作录屏，点一下就播。
export function TouchHero({ tasks, contactCount, planned, toggle, onAdd, addDisabled }: {
  tasks: Loose[]; contactCount: number; planned: number; toggle: ReactNode; onAdd: () => void; addDisabled: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const numbers = touchNumbers(tasks);
  const kpis = [
    { value: numbers.week, unit: "人", label: "本周已触达" },
    { value: numbers.today, unit: "人", label: "今天已触达" },
    { value: contactCount, unit: "位", label: "已同步联系人" },
    { value: planned, unit: "项", label: "计划中任务" }
  ];
  return <section className="touch-hero" aria-label="精准触达">
    <div className="touch-hero-copy">
      <span className="touch-chip">微信拓客 · 精准触达</span>
      <h1>选好客户，<br /><em>AI 帮你</em>挨个聊</h1>
      <p>按你的话术和图片，一个个发给选定的客户，发完自动接着跟进。</p>
      <div className="touch-actions">
        <button type="button" className="touch-add" onClick={onAdd} disabled={addDisabled}><Plus size={20} />新建触达任务</button>
        <div className="touch-toggle">{toggle}</div>
      </div>
    </div>
    <dl className="touch-kpis">
      {kpis.map((kpi) => <div key={kpi.label}><dt>{kpi.label}</dt><dd><b>{kpi.value}</b><small>{kpi.unit}</small></dd></div>)}
    </dl>
    <div className="touch-demo">
      {playing
        ? <video src={asset("wechat-touch.mp4")} poster={asset("wechat-touch.jpg")} controls autoPlay playsInline />
        : <button type="button" className="touch-demo-poster" aria-label="播放精准触达操作演示" onClick={() => setPlaying(true)}>
          <img src={asset("wechat-touch.jpg")} alt="" /><span><PlayCircle size={56} aria-hidden="true" /></span><small>真实操作录屏 · 1 分 08 秒</small>
        </button>}
    </div>
  </section>;
}
