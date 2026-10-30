import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkflowController } from "./WechatWorkflow";
import "./XiaoxiSprite.css";

// 小玺 (user decisions 2026-10-30): a small living robot always on screen at the right edge. It wanders a
// little, can be dragged, and talks in a comic bubble: a warm line when something starts, a short
// 「ING」 line with the progress while it runs, a happy or worried line when it ends, and now and then
// a light remark that has nothing to do with work.

export type SpriteActivity = { kind: string; title: string; detail?: string; done?: number; total?: number; attention?: boolean; pausable?: boolean };
type Mood = "idle" | "hello" | "work" | "done" | "error" | "sleep";
type Line = { text: string; sub?: string; mood?: "done" | "error" | "" };

const GREETINGS: [RegExp, string][] = [
  [/朋友圈/, "我来帮你给朋友圈点赞、留言啦～"],
  [/触达|发消息|联系客户/, "我来帮你一个个联系客户啦～"],
  [/回复|接待/, "我帮你看着客户消息，有人找你我就回～"],
  [/联系人/, "我去把微信联系人搬过来～"],
  [/养号/, "我去帮你养号啦，刷刷视频、混个脸熟～"],
  [/分发|发布/, "视频我来帮你发出去～"],
  [/视频|素材|封面|包装/, "视频交给我来做，好了叫你～"],
  [/找客户|获客|线索/, "我去帮你找找有意向的客户～"],
  [/./, "这件事交给我啦～"]
];
const FINISHED: [RegExp, Line][] = [
  [/^wechat$/, { text: "微信这边都办好啦～", sub: "辛苦你等我一会儿", mood: "done" }],
  [/^nurture$/, { text: "这一轮养号跑完啦～", sub: "账号又涨了点人气", mood: "done" }],
  [/^publish$/, { text: "视频都交给平台啦～", sub: "结果在发布记录里", mood: "done" }],
  [/acquisition/, { text: "找客户这一轮跑完啦～", sub: "线索都放在获客页面里", mood: "done" }]
];
// Light remarks for the quiet moments.
const CHATTER = [
  "记得喝口水呀～", "坐久了，起来伸个懒腰吧～", "有我在，你放心忙别的～", "我在这儿呢，需要我就点我～",
  "今天的客户一定会多多的～", "看看远处，让眼睛休息一下～", "嘿嘿，我刚学会了一个新表情～", "今天也辛苦啦～"
];
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const greetingFor = (title: string) => (GREETINGS.find(([pattern]) => pattern.test(title)) || GREETINGS[GREETINGS.length - 1])[1];

export function XiaoxiSprite({ workflow, activity, alert }: { workflow: WorkflowController; activity: SpriteActivity | null; alert: string }) {
  const api = window.xiaoxiWorkflow;
  const [line, setLine] = useState<Line | null>(null);
  const [greeting, setGreeting] = useState("");
  const [typed, setTyped] = useState("");
  const [mood, setMood] = useState<Mood>("idle");
  const [blink, setBlink] = useState(false);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [tilt, setTilt] = useState(0);
  const [roam, setRoam] = useState({ x: 0, y: 0 });
  const lastKind = useRef("");
  const lastTitle = useRef("");
  const idleSince = useRef(Date.now());
  const drag = useRef(false);
  const lineTimer = useRef<number>();

  const show = (next: Line, ms = 5200) => {
    window.clearTimeout(lineTimer.current);
    setLine(next);
    if (ms) lineTimer.current = window.setTimeout(() => setLine(null), ms);
  };

  // Something started, changed, or ended.
  useEffect(() => {
    const kind = activity?.kind || "";
    if (kind && (kind !== lastKind.current || activity!.title !== lastTitle.current) && !lastKind.current) {
      setGreeting(greetingFor(activity!.title));
      window.setTimeout(() => setGreeting(""), 4200);
    }
    if (!kind && lastKind.current && !alert) {
      const done = FINISHED.find(([pattern]) => pattern.test(lastKind.current));
      if (done) show(done[1]);
      idleSince.current = Date.now();
    }
    lastKind.current = kind; lastTitle.current = activity?.title || "";
  }, [activity?.kind, activity?.title, alert]);

  // One-off lines from the main process (a finished video, a failed job).
  useEffect(() => api?.onSpriteSay?.((said: Line) => show(said, said.mood === "error" ? 9000 : 6000)), [api]);

  // Mood follows what is going on.
  useEffect(() => {
    const next: Mood = alert ? "error" : line?.mood === "done" ? "done" : line?.mood === "error" ? "error"
      : greeting ? "hello" : activity ? "work" : Date.now() - idleSince.current > 180000 ? "sleep" : "idle";
    setMood(next);
  }, [alert, line, greeting, activity]);

  // Alive: blinks at uneven intervals, glances around, tilts its head, wanders a little.
  useEffect(() => {
    let alive = true;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(() => alive && fn(), ms));
    const doBlink = () => {
      setBlink(true); later(() => setBlink(false), 110);
      if (Math.random() < .25) later(() => { setBlink(true); later(() => setBlink(false), 100); }, 260);
      later(doBlink, 1800 + Math.random() * 3800);
    };
    const glance = () => {
      setLook({ x: (Math.random() - .5) * 10, y: (Math.random() - .5) * 5 });
      setTilt(Math.random() < .35 ? (Math.random() - .5) * 10 : 0);
      later(glance, 900 + Math.random() * 2200);
    };
    const wander = () => {
      if (!drag.current) setRoam({ x: (Math.random() - .5) * 22, y: (Math.random() - .5) * 26 });
      later(wander, 3600 + Math.random() * 3000);
    };
    // Small talk now and then, never over something important.
    const chatter = () => {
      later(chatter, 45000 + Math.random() * 75000);
      if (!alert && Math.random() < .45) show({ text: pick(CHATTER) }, 4200);
    };
    later(doBlink, 1200); later(glance, 700); later(wander, 2000); later(chatter, 20000 + Math.random() * 20000);
    return () => { alive = false; timers.forEach(window.clearTimeout); };
  }, [alert]);

  // The words being typed out like someone talking.
  const message: Line | null = alert ? { text: "遇到点小麻烦～", sub: alert, mood: "error" }
    : line || (greeting ? { text: greeting, sub: activity?.title } : null);
  useEffect(() => {
    const text = message?.text || "";
    setTyped("");
    if (!text) return;
    let i = 0;
    const timer = window.setInterval(() => { i += 1; setTyped(text.slice(0, i)); if (i >= text.length) window.clearInterval(timer); }, 55);
    return () => window.clearInterval(timer);
  }, [message?.text]);

  const percent = activity?.total ? Math.round((activity.done || 0) / activity.total * 100) : null;
  const showMain = () => { void api?.showMain(); };
  const interactive = (on: boolean) => { if (!drag.current) api?.spriteInteractive?.(on); };
  // Holding 小玺 hands the dragging to the main process; letting go without moving opens the app.
  const down = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    drag.current = true;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    api?.spriteDragStart?.();
  };
  const up = async () => {
    if (!drag.current) return;
    drag.current = false;
    const result = await api?.spriteDragEnd?.();
    if (!result?.moved) showMain();
  };

  return <main className="floating-shell workflow-floating-shell xiaoxi-shell">
    <div className="xiaoxi-roam" style={{ transform: `translate(${roam.x}px, ${roam.y}px)` }}>
      {(message || activity) && <section className={`xiaoxi-bubble${message?.mood ? ` is-${message.mood}` : ""}`} key={message?.text || activity?.title} role="status" aria-live="polite"
        onPointerEnter={() => interactive(true)} onPointerLeave={() => interactive(false)}>
        {message ? <>
          <strong>{typed}{typed.length < message.text.length && <i className="xiaoxi-caret" />}</strong>
          {message.sub && <span className="xiaoxi-sub">{message.sub}</span>}
        </> : activity && <>
          <strong>{activity.title}</strong>
          {activity.detail && <span className="xiaoxi-sub">{activity.detail}</span>}
          <span className="xiaoxi-ing-row"><span className="xiaoxi-ing">ING<i /><i /><i /></span>{percent !== null && <b>{activity.total === 100 ? `${percent}%` : `${activity.done}/${activity.total}`}</b>}</span>
        </>}
        {activity?.pausable && <button type="button" className="xiaoxi-link" onClick={() => void workflow.run(() => api!.pause())}>先暂停</button>}
      </section>}
      <button type="button" className="xiaoxi-buddy" data-mood={mood} aria-label="小玺：点我回到软件，按住可以拖动"
        onPointerEnter={() => interactive(true)} onPointerLeave={() => interactive(false)} onPointerDown={down} onPointerUp={() => void up()} onPointerCancel={() => void up()}>
        <svg viewBox="0 0 200 220" aria-hidden="true">
          <ellipse className="xs-shadow" cx="100" cy="208" rx="52" ry="7" fill="#000" />
          <g className="xs-body">
            <g className="xs-arm l"><path d="M52 150 C38 156 32 168 34 178" fill="none" stroke="#e9ecf2" strokeWidth="13" strokeLinecap="round" /><circle cx="34" cy="180" r="9" fill="#e60012" /></g>
            <g className="xs-arm r"><path d="M148 150 C162 156 168 168 166 178" fill="none" stroke="#e9ecf2" strokeWidth="13" strokeLinecap="round" /><circle cx="166" cy="180" r="9" fill="#e60012" /></g>
            <rect x="62" y="138" width="76" height="56" rx="26" fill="#f6f7fa" stroke="#dfe3ea" strokeWidth="3" />
            <rect x="90" y="156" width="20" height="8" rx="4" fill="#5ee6ff" className="xs-led" />
            <g className="xs-head" style={{ transform: `rotate(${tilt}deg)` }}>
              <g className="xs-tuft"><path d="M100 36 C90 20 110 10 116 20 C110 24 112 34 105 40 Z" fill="#e60012" stroke="#c0000f" strokeWidth="2" /></g>
              <rect x="30" y="38" width="140" height="112" rx="46" fill="#f8f9fb" stroke="#dfe3ea" strokeWidth="3" />
              <rect x="23" y="78" width="10" height="30" rx="5" fill="#e60012" /><rect x="167" y="78" width="10" height="30" rx="5" fill="#e60012" />
              <rect x="44" y="52" width="112" height="80" rx="32" fill="#141b28" />
              <path d="M58 60 Q84 54 108 58" stroke="#ffffff" strokeOpacity=".12" strokeWidth="6" strokeLinecap="round" fill="none" />
              <ellipse cx="62" cy="112" rx="8" ry="4.5" fill="#ff6b8a" opacity=".55" /><ellipse cx="138" cy="112" rx="8" ry="4.5" fill="#ff6b8a" opacity=".55" />
              {["idle", "hello", "work"].includes(mood) && <g>
                <g style={{ transform: `translate(${look.x}px, ${look.y}px)`, transition: "transform .18s ease-out" }}>
                  <g className="xs-lid" style={{ transform: `scaleY(${blink ? .08 : 1})` }}><rect x="66" y="74" width="20" height="28" rx="10" fill="#5ee6ff" /><circle cx="80" cy="81" r="3" fill="#fff" opacity=".85" /></g>
                  <g className="xs-lid" style={{ transform: `scaleY(${blink ? .08 : 1})` }}><rect x="114" y="74" width="20" height="28" rx="10" fill="#5ee6ff" /><circle cx="128" cy="81" r="3" fill="#fff" opacity=".85" /></g>
                </g>
                {mood === "hello" ? <ellipse cx="100" cy="116" rx="6" ry="5" fill="#5ee6ff" /> : <path d="M90 114 Q100 120 110 114" fill="none" stroke="#5ee6ff" strokeWidth="3.5" strokeLinecap="round" />}
              </g>}
              {mood === "done" && <g>
                <path d="M64 92 L76 78 L88 92 M112 92 L124 78 L136 92" fill="none" stroke="#5ff0a0" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M84 108 Q100 124 116 108" fill="none" stroke="#5ff0a0" strokeWidth="5" strokeLinecap="round" />
              </g>}
              {mood === "error" && <g>
                <path d="M64 80 L84 72 M136 80 L116 72" stroke="#ffb547" strokeWidth="4" strokeLinecap="round" />
                <rect x="68" y="84" width="16" height="18" rx="8" fill="#ffb547" /><rect x="116" y="84" width="16" height="18" rx="8" fill="#ffb547" />
                <path d="M88 118 Q94 112 100 118 Q106 124 112 118" fill="none" stroke="#ffb547" strokeWidth="3.5" strokeLinecap="round" />
                <path className="xs-drop" d="M160 44 Q167 56 160 61 Q153 56 160 44 Z" fill="#7fc8ff" />
              </g>}
              {mood === "sleep" && <g>
                <path d="M64 92 Q76 99 88 92 M112 92 Q124 99 136 92" fill="none" stroke="#5ee6ff" strokeOpacity=".7" strokeWidth="5" strokeLinecap="round" />
                <ellipse cx="100" cy="116" rx="4" ry="3" fill="#5ee6ff" opacity=".6" />
                <text className="xs-zz" x="150" y="40" fontSize="20" fontWeight="800" fill="#9cc4ff">z</text>
                <text className="xs-zz b" x="164" y="26" fontSize="14" fontWeight="800" fill="#9cc4ff">z</text>
              </g>}
            </g>
          </g>
        </svg>
      </button>
    </div>
  </main>;
}
