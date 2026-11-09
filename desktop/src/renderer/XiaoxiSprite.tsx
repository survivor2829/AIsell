import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { WorkflowController } from "./WechatWorkflow";
import { createMascotPet, type PetWork } from "./MascotPet";
import "./XiaoxiSprite.css";

// The company mascot as a desktop pet (user decisions 2026-11-08) that talks in a comic bubble: a warm line
// when something starts, the live title, detail and progress of the work while it runs, a happy or worried
// line when it ends. Touching and playing belong to MascotPet; what is shown about the work belongs here.

export type SpriteActivity = { kind: string; title: string; detail?: string; done?: number; total?: number; attention?: boolean; pausable?: boolean };
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
  "记得喝口水呀～", "坐久了，起来伸个懒腰吧～", "有我在，你放心忙别的～", "我在这儿呢，双击我就回到软件～",
  "今天的客户一定会多多的～", "看看远处，让眼睛休息一下～", "今天也辛苦啦～"
];
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const greetingFor = (title: string) => (GREETINGS.find(([pattern]) => pattern.test(title)) || GREETINGS[GREETINGS.length - 1])[1];
const workFor = (activity: SpriteActivity | null, alert: string): PetWork => {
  if (alert) return "error";
  if (!activity) return null;
  return activity.kind === "wechat" || /消息|触达|回复|接待|朋友圈|联系人/.test(activity.title) ? "typing" : "work";
};

export function XiaoxiSprite({ workflow, activity, alert }: { workflow: WorkflowController; activity: SpriteActivity | null; alert: string }) {
  const api = window.xiaoxiWorkflow;
  const [line, setLine] = useState<Line | null>(null);
  const [greeting, setGreeting] = useState("");
  const [typed, setTyped] = useState("");
  const lastKind = useRef("");
  const lastTitle = useRef("");
  const pressed = useRef(false);
  const lineTimer = useRef<number>();
  const host = useRef<HTMLDivElement>(null);
  const pet = useRef<ReturnType<typeof createMascotPet> | null>(null);
  // What the pet says for fun must never cover the live state of the work.
  const quiet = useRef(true);
  quiet.current = !activity && !alert && !greeting && !line?.mood;

  const show = (next: Line, ms = 5200) => {
    window.clearTimeout(lineTimer.current);
    setLine(next);
    if (ms) lineTimer.current = window.setTimeout(() => setLine(null), ms);
  };

  useEffect(() => {
    if (!host.current) return;
    const created = createMascotPet(host.current, {
      walk: async (dx) => api?.spriteWalk?.(dx),
      stopWalk: () => api?.spriteWalkStop?.(),
      say: (text, ms) => { if (quiet.current) show({ text }, ms); },
      openMain: () => { void api?.showMain(); }
    });
    pet.current = created;
    const offCursor = api?.onSpriteCursor?.((point: { x: number; y: number }) => created.cursor(point.x, point.y));
    const offDrag = api?.onSpriteDrag?.((speed: { vx: number; vy: number }) => created.dragMove(speed.vx, speed.vy));
    return () => { offCursor?.(); offDrag?.(); created.destroy(); pet.current = null; };
  }, [api]);

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
    }
    lastKind.current = kind; lastTitle.current = activity?.title || "";
  }, [activity?.kind, activity?.title, alert]);

  // One-off lines from the main process (a finished video, a failed job).
  useEffect(() => api?.onSpriteSay?.((said: Line) => show(said, said.mood === "error" ? 9000 : 6000)), [api]);

  // The pet acts out whatever is really going on.
  const work = workFor(activity, alert);
  useEffect(() => { pet.current?.setWork(work); }, [work]);
  useEffect(() => {
    if (line?.mood === "done") pet.current?.celebrate();
    else if (line?.mood === "error") pet.current?.oops();
  }, [line]);

  // Small talk now and then, never over the work.
  useEffect(() => {
    let timer = 0;
    const chatter = () => {
      timer = window.setTimeout(chatter, 60000 + Math.random() * 90000);
      if (quiet.current && Math.random() < .4) show({ text: pick(CHATTER) }, 4200);
    };
    timer = window.setTimeout(chatter, 40000);
    return () => window.clearTimeout(timer);
  }, []);

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
  const interactive = (on: boolean) => { if (!pressed.current) api?.spriteInteractive?.(on); };
  // Holding the pet hands the dragging to the main process; letting go without moving is a touch.
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    pressed.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    api?.spriteDragStart?.();
  };
  const up = async (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!pressed.current) return;
    pressed.current = false;
    const { clientX, clientY } = event;
    const result = await api?.spriteDragEnd?.();
    if (result?.caught) return; // Picked up again in mid-air: that press finishes the job.
    if (result?.moved) pet.current?.dragEnd(Number(result.impact) || 0);
    else pet.current?.click(clientX, clientY);
  };

  return <main className="floating-shell workflow-floating-shell xiaoxi-shell">
    <div className="xiaoxi-roam">
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
      <button type="button" className="xiaoxi-buddy" aria-label="吉祥物：双击回到软件，按住可以拖动"
        onClick={(event) => { if (event.detail === 0) void api?.showMain(); }}
        onPointerEnter={() => interactive(true)} onPointerLeave={() => { interactive(false); pet.current?.leave(); }}
        onPointerMove={(event) => { if (!pressed.current) pet.current?.hover(event.clientX, event.clientY); }}
        onPointerDown={down} onPointerUp={(event) => void up(event)} onPointerCancel={(event) => void up(event)}>
        <div className="xiaoxi-pet" ref={host} />
      </button>
    </div>
  </main>;
}
