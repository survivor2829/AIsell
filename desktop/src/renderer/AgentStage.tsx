import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AlertTriangle, Check, Hand } from "lucide-react";
import "./AgentStage.css";

// AI 工作台（用户 2026-11-24：让老板看得见 AI 在干活、怎么干）。一块看板上摆着这次任务的产物，
// 每个 AI 角色是一个带名字的彩色光标：在干活的停在它的产物上点动，干完打勾去待命区，出错的停住标红。
// 看板、光标和日志只由调用方从任务真实状态推出来，这里不编造任何进度。
export type StageState = "wait" | "now" | "done" | "fail" | "user";
export type StageCard = { id: string; label: string; icon: ReactNode; state: StageState; detail?: string };
export type StageAgent = { id: string; name: string; color: string; at: string; state: StageState };
export type StageLog = { id: string; color: string; who: string; text: string; state: StageState };
export type StageModel = { cards: StageCard[]; agents: StageAgent[]; log: StageLog[] };

type Point = { x: number; y: number };
const DOCK_SLOT = 92;
const DOCK_ROW = 24;
const CURSOR_WIDTH = 104;

export function AgentStage({ model, label }: { model: StageModel; label: string }) {
  const board = useRef<HTMLDivElement>(null);
  const cards = useRef<Record<string, HTMLLIElement | null>>({});
  const dock = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const [points, setPoints] = useState<Record<string, Point>>({});
  const [dockRows, setDockRows] = useState(1);
  const logCount = useRef(0);
  // Re-measure only when what is shown changes, not on every parent poll.
  const signature = JSON.stringify([model.cards.map((card) => [card.id, card.state]), model.agents.map((agent) => [agent.id, agent.at, agent.state]), model.log.length]);

  // Cursors sit on their card while working, line up in the dock once done or still waiting.
  useLayoutEffect(() => {
    const measure = () => {
      const root = board.current?.getBoundingClientRect();
      if (!root) return;
      const next: Record<string, Point> = {};
      // Working agents whose card is not on the board wait in the dock rather than off-screen.
      const onCard = (agent: StageAgent) => (agent.state === "now" || agent.state === "fail") && Boolean(cards.current[agent.at]);
      const parked = model.agents.filter((agent) => !onCard(agent));
      const dockBox = dock.current?.getBoundingClientRect();
      model.agents.forEach((agent) => {
        const box = cards.current[agent.at]?.getBoundingClientRect();
        if (onCard(agent) && box) {
          // Several agents on one card spread across it.
          const crowd = model.agents.filter((other) => other.at === agent.at && onCard(other));
          const slot = crowd.indexOf(agent);
          // Lower right of the card, clear of its title and detail line.
          // Kept inside the board so the name tag never hangs off the right edge.
          next[agent.id] = { x: Math.min(box.left - root.left + box.width * 0.58 - slot * 10, root.width - CURSOR_WIDTH), y: box.top - root.top + box.height - 26 - slot * 6 };
        } else if (dockBox) {
          const index = parked.indexOf(agent);
          const perRow = Math.max(1, Math.floor((dockBox.width - 8) / DOCK_SLOT));
          next[agent.id] = { x: dockBox.left - root.left + 4 + (index % perRow) * DOCK_SLOT, y: dockBox.top - root.top + 6 + Math.floor(index / perRow) * DOCK_ROW };
        }
      });
      const perRow = Math.max(1, Math.floor(((dockBox?.width || DOCK_SLOT) - 8) / DOCK_SLOT));
      setDockRows(Math.max(1, Math.ceil(parked.length / perRow)));
      setPoints(next);
      // New lines scroll into view, unless the reader has scrolled up to read earlier ones.
      const list = log.current;
      if (list && list.childElementCount !== logCount.current) {
        const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
        if (nearBottom || logCount.current === 0) list.scrollTop = list.scrollHeight;
        logCount.current = list.childElementCount;
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (board.current) observer.observe(board.current);
    return () => observer.disconnect();
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  return <section className="agent-stage" aria-label={label}>
    <div className="agent-stage-board" ref={board}>
      <ol className="agent-stage-cards">{model.cards.map((card) => <li key={card.id} ref={(element) => { cards.current[card.id] = element; }} className={`is-${card.state}`}>
        <span className="agent-stage-icon">{card.state === "done" ? <Check size={18} strokeWidth={3} /> : card.state === "fail" ? <AlertTriangle size={18} /> : card.state === "user" ? <Hand size={18} /> : card.icon}</span>
        <b>{card.label}</b>{card.detail && <small>{card.detail}</small>}
      </li>)}</ol>
      <div className="agent-stage-dock" ref={dock} style={{ height: dockRows * DOCK_ROW + 6 }} aria-hidden="true" />
      {model.agents.map((agent) => {
        const point = points[agent.id];
        if (!point) return null;
        return <span key={agent.id} className={`agent-cursor is-${agent.state}`} style={{ "--agent": agent.color, transform: `translate(${point.x}px, ${point.y}px)` } as CSSProperties} aria-hidden="true">
          <svg width="18" height="22" viewBox="0 0 22 26"><path d="M1 1 L1 21 L6.5 16 L10 24 L13.5 22.5 L10 15 L18 15 Z" /></svg>
          <i>{agent.name}</i>
        </span>;
      })}
    </div>
    <ol className="agent-stage-log" ref={log} aria-live="polite">{model.log.map((line) => <li key={line.id} className={`is-${line.state}`} style={{ "--agent": line.color } as CSSProperties}>
      <b>{line.who}</b><span>{line.text}</span></li>)}</ol>
  </section>;
}
