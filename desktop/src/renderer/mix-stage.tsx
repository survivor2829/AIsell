import { Clapperboard, Film, Image as ImageIcon, Lightbulb } from "lucide-react";
import type { StageAgent, StageCard, StageLog, StageModel, StageState } from "./AgentStage";
import type { Batch, Candidate } from "./batch-studio-api";

// 线索视频混剪的 AI 工作台：只从批次的真实进度推出（阶段、正在处理第几个素材/第几条、引擎报的当前步骤、每条的结果）。
// 一条作品内部谁在干活按引擎报的步骤（正在配音 / 正在挑选配乐 / 渲染画面）判断；认不出时卡片亮着，不硬派一个角色。
export type MixStageInput = { batch: Batch; candidates: Candidate[]; running: boolean; submitting: boolean; ended: boolean; scriptCount: number };

const ORDER: Record<string, number> = { analysis: 0, script: 1, production: 2, finalizing: 2, complete: 3 };
// Statuses that mean something really went wrong; paused or waiting for the customer are not failures.
const FAILED = new Set(["failed", "needs_attention", "outcome_unknown", "insufficient_materials"]);
const FINISHED = new Set(["completed", "completed_with_errors"]);
const CREW = [
  { id: "voice", name: "配音员", color: "#fb923c", match: /配音/ },
  { id: "music", name: "配乐师", color: "#a3e635", match: /配乐/ },
  { id: "editor", name: "剪辑师", color: "#a78bfa", match: /合成画面|渲染|剪辑|字幕|画面/ }
];
const workDone = (candidate: Candidate) => candidate.status === "completed";
const workFailed = (candidate: Candidate) => ["failed", "skipped", "needs_attention", "outcome_unknown"].includes(candidate.status);

function phaseOf(batch: Batch, candidates: Candidate[], submitting: boolean, ended: boolean) {
  if (submitting) return 0; // A new run: the previous run's activity no longer applies.
  if (ended && FINISHED.has(batch.status)) return 3;
  const reported = ORDER[batch.activity?.phase || ""];
  if (reported !== undefined) return reported;
  // A generic step ("working") keeps the furthest stage the results show.
  if (candidates.some((candidate) => workDone(candidate) || candidate.status === "rendering")) return 2;
  return batch.script_confirmation || batch.script_options?.length ? 1 : 0;
}

export function mixStageModel({ batch, candidates, running, submitting, ended, scriptCount }: MixStageInput): StageModel {
  const activity = submitting ? undefined : batch.activity;
  const phase = phaseOf(batch, candidates, submitting, ended);
  const failed = FAILED.has(batch.status) && !running && !submitting;
  const live = running || submitting;
  const at = (step: number): StageState => phase > step ? "done" : phase === step ? (failed ? "fail" : live ? "now" : "wait") : "wait";
  // The work the engine is on: matched by its production order, not by the page's array position.
  const byOrder = (order: number) => candidates.findIndex((candidate, index) => (candidate.production_index ?? index + 1) === order);
  const reportedWork = activity?.item_index && phase === 2 ? byOrder(activity.item_index) : -1;
  const making = live && reportedWork >= 0 && !workDone(candidates[reportedWork]) && !workFailed(candidates[reportedWork]) ? reportedWork : -1;
  // A stopped batch: the work that failed, else the first one not finished.
  const stoppedWork = failed && phase === 2 ? Math.max(candidates.findIndex(workFailed), -1) >= 0 ? candidates.findIndex(workFailed) : candidates.findIndex((candidate) => !workDone(candidate)) : -1;
  const message = activity?.message || "";
  const crewNow = making >= 0 ? CREW.find((member) => member.match.test(message))?.id : undefined;
  const workState = (candidate: Candidate, index: number): StageState => workDone(candidate) ? "done"
    : workFailed(candidate) || index === stoppedWork ? "fail" : index === making ? "now" : "wait";
  const doneCount = candidates.filter(workDone).length;

  const cards: StageCard[] = [
    { id: "materials", label: "素材", icon: <ImageIcon size={18} />, state: at(0),
      detail: phase === 0 && activity?.item_total ? `第 ${activity.item_index || 1}/${activity.item_total} 个` : undefined },
    { id: "script", label: "文案", icon: <Lightbulb size={18} />, state: at(1),
      detail: batch.script_confirmation ? "已确认" : scriptCount ? `${scriptCount} 份` : undefined },
    ...candidates.map((candidate, index) => ({ id: `work-${index}`, label: `第 ${index + 1} 条`, icon: <Clapperboard size={18} />, state: workState(candidate, index), detail: candidate.title })),
    { id: "final", label: "成片", icon: <Film size={18} />, state: phase === 3 ? "done" : "wait", detail: doneCount ? `${doneCount} 条好了` : undefined }
  ];

  const agents: StageAgent[] = [
    { id: "reader", name: "素材理解", color: "#22d3ee", at: "materials", state: at(0) },
    { id: "writer", name: "编剧", color: "#f472b6", at: "script", state: at(1) },
    ...CREW.map((member) => ({ id: member.id, name: member.name, color: member.color,
      at: making >= 0 ? `work-${making}` : stoppedWork >= 0 ? `work-${stoppedWork}` : "final",
      state: (phase > 2 ? "done" : member.id === crewNow ? "now" : "wait") as StageState }))
  ];

  const log: StageLog[] = [];
  const add = (id: string, who: string, color: string, state: StageState, text: string) => { if (state !== "wait") log.push({ id, who, color, state, text }); };
  add("reader", "素材理解", "#22d3ee", at(0), at(0) === "done" ? "素材都看懂了" : message || "看素材");
  add("writer", "编剧", "#f472b6", at(1), at(1) === "done" ? (batch.script_confirmation ? "文案已确认" : `写好 ${scriptCount || candidates.length} 份文案`) : message || "写文案、核对画面");
  const member = CREW.find((item) => item.id === crewNow);
  candidates.forEach((candidate, index) => {
    const state = workState(candidate, index);
    add(`work-${index}`, state === "now" && member ? member.name : `第 ${index + 1} 条`, state === "now" && member ? member.color : "#c4b5fd", state,
      state === "done" ? `「${candidate.title}」做好了` : state === "fail" ? `「${candidate.title}」没做成${candidate.error ? `：${candidate.error}` : ""}` : message || `做「${candidate.title}」`);
  });
  if (phase === 3 && candidates.length) add("final", "成片", "#4ade80", "done", doneCount === candidates.length ? `${doneCount} 条全部做好` : `做好 ${doneCount} 条，${candidates.length - doneCount} 条没做成`);
  return { cards, agents, log };
}
