import { useState, type ReactNode } from "react";
import { ImagePlus, PlayCircle, Plus, ThumbsUp } from "lucide-react";
import { weekCount } from "./overview-stats";
import "./TouchHero.css";

type Loose = Record<string, unknown>;
const asset = (file: string) => new URL(`./video-examples/${file}`, document.baseURI).toString();

// How much tasks of one type did this week and today (people reached, posts published, interactions),
// counting every run of a daily task.
export function runNumbers(tasks: Loose[], type: string, now = Date.now()) {
  const runs = tasks.filter((task) => task.type === type).flatMap((task) => Array.isArray(task.runs) && task.runs.length
    ? task.runs as Loose[] : task.completedAt ? [{ completedAt: task.completedAt, done: (task.progress as Loose | undefined)?.done }] : []);
  const done = (run: Loose) => { const value = Number(run.done); return Number.isFinite(value) && value > 0 ? value : 0; };
  const today = new Date(now).toDateString();
  return {
    week: weekCount(runs, ["completedAt"], now, done).now,
    today: runs.filter((run) => new Date(String(run.completedAt)).toDateString() === today).reduce((sum, run) => sum + done(run), 0)
  };
}

// 微信拓客各页的页头（用户 2026-10-29：页面放大后太空，要饱满、大气）：和主页同一套浅色大卡片，
// 左边标题、按钮和数字，右边是真实操作录屏，点一下就播。
export function PageHero({ label, chip, title, lead, actions, kpis, video, duration }: {
  label: string; chip: string; title: ReactNode; lead: string; actions: ReactNode;
  kpis: { value: ReactNode; unit: string; label: string }[]; video: string; duration: string;
}) {
  const [playing, setPlaying] = useState(false);
  return <section className="touch-hero" aria-label={label}>
    <div className="touch-hero-copy">
      <span className="touch-chip">{chip}</span>
      <h1>{title}</h1>
      <p>{lead}</p>
      <div className="touch-actions">{actions}</div>
    </div>
    <dl className="touch-kpis">
      {kpis.map((kpi) => <div key={kpi.label}><dt>{kpi.label}</dt><dd><b>{kpi.value}</b><small>{kpi.unit}</small></dd></div>)}
    </dl>
    <div className="touch-demo">
      {playing
        ? <video src={asset(`${video}.mp4`)} poster={asset(`${video}.jpg`)} controls autoPlay playsInline />
        : <button type="button" className="touch-demo-poster" aria-label={`播放${label}操作演示`} onClick={() => setPlaying(true)}>
          <img src={asset(`${video}.jpg`)} alt="" /><span><PlayCircle size={56} aria-hidden="true" /></span><small>真实操作录屏 · {duration}</small>
        </button>}
    </div>
  </section>;
}

export function TouchHero({ tasks, contactCount, planned, toggle, onAdd, addDisabled }: {
  tasks: Loose[]; contactCount: number; planned: number; toggle: ReactNode; onAdd: () => void; addDisabled: boolean;
}) {
  const numbers = runNumbers(tasks, "touch");
  return <PageHero label="精准触达" chip="微信拓客 · 精准触达" title={<>选好客户，<br /><em>AI 帮你</em>挨个聊</>}
    lead="按你的话术和图片，一个个发给选定的客户，发完自动接着跟进。" video="wechat-touch" duration="1 分 08 秒"
    actions={<><button type="button" className="touch-add" onClick={onAdd} disabled={addDisabled}><Plus size={20} />新建触达任务</button><div className="touch-toggle">{toggle}</div></>}
    kpis={[
      { value: numbers.week, unit: "人", label: "本周已触达" },
      { value: numbers.today, unit: "人", label: "今天已触达" },
      { value: contactCount, unit: "位", label: "已同步联系人" },
      { value: planned, unit: "项", label: "计划中任务" }
    ]} />;
}

export function MomentsHero({ tasks, planned, toggle, onAdd, addDisabled }: {
  tasks: Loose[]; planned: number; toggle: ReactNode; onAdd: (type: "publish" | "interact") => void; addDisabled: boolean;
}) {
  const posts = runNumbers(tasks, "publish");
  const interactions = runNumbers(tasks, "interact");
  return <PageHero label="朋友圈运营" chip="微信拓客 · 朋友圈运营" title={<>朋友圈天天有动静，<br /><em>AI 帮你</em>发和互动</>}
    lead="写好文案、选好图片，按时间自动发朋友圈；再给客户的动态点赞评论，让客户常常看到你。" video="wechat-moments" duration="1 分 05 秒"
    actions={<><button type="button" className="touch-add" onClick={() => onAdd("publish")} disabled={addDisabled}><ImagePlus size={20} />发朋友圈</button>
      <button type="button" className="touch-add is-light" onClick={() => onAdd("interact")} disabled={addDisabled}><ThumbsUp size={20} />朋友圈互动</button>
      <div className="touch-toggle">{toggle}</div></>}
    kpis={[
      { value: posts.week, unit: "条", label: "本周已发" },
      { value: posts.today, unit: "条", label: "今天已发" },
      { value: interactions.week, unit: "次", label: "本周互动" },
      { value: planned, unit: "项", label: "计划中任务" }
    ]} />;
}
