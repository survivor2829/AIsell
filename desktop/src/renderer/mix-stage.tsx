import { Clapperboard, Film, Image as ImageIcon, Lightbulb } from "lucide-react";
import type { StageAgent, StageCard, StageLog, StageModel, StageState } from "./AgentStage";
import type { Batch, Candidate } from "./batch-studio-api";

// 线索视频混剪的 AI 工作台：只从批次的真实进度推出（阶段、正在处理第几个素材/第几条、引擎报的当前步骤文字、每条的结果）。
// 一条作品内部的配音、剪辑、配乐、封面按引擎当前报的步骤文字判断谁在干活，认不出时算剪辑师。
export type MixStageInput = { batch: Batch; candidates: Candidate[]; running: boolean; stopped: boolean; ended: boolean; scriptCount: number };

const ORDER: Record<string, number> = { analysis: 0, script: 1, production: 2, finalizing: 2, complete: 3 };
const CREW = [
  { id: "voice", name: "配音员", color: "#fb923c", match: /配音|声音|语音|朗读/ },
  { id: "music", name: "配乐师", color: "#a3e635", match: /配乐|音乐|曲/ },
  { id: "cover", name: "封面设计", color: "#facc15", match: /封面/ },
  { id: "editor", name: "剪辑师", color: "#a78bfa", match: /剪辑|渲染|画面|拼接|合成|字幕|镜头|包装/ }
];

export function mixStageModel({ batch, candidates, running, stopped, ended, scriptCount }: MixStageInput): StageModel {
  const activity = batch.activity;
  const phase = ended && batch.status === "completed" ? 3 : ORDER[activity?.phase || ""] ?? 0;
  const at = (step: number): StageState => phase > step ? "done" : phase === step ? (stopped ? "fail" : running ? "now" : "wait") : "wait";
  const making = phase === 2 && running ? (activity?.item_index || 0) - 1 : -1;
  const message = activity?.message || "";
  const crewNow = CREW.find((member) => member.match.test(message))?.id || "editor";
  const workState = (candidate: Candidate, index: number): StageState => candidate.status === "completed" ? "done"
    : ["failed", "skipped"].includes(candidate.status) ? "fail" : index === making ? "now" : stopped && phase === 2 && index === (activity?.item_index || 0) - 1 ? "fail" : "wait";
  const doneCount = candidates.filter((candidate) => candidate.status === "completed").length;

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
    ...CREW.map((member) => ({ id: member.id, name: member.name, color: member.color, at: making >= 0 ? `work-${making}` : "final",
      state: (phase > 2 ? "done" : making >= 0 && member.id === crewNow ? "now" : stopped && phase === 2 && member.id === crewNow ? "fail" : "wait") as StageState }))
  ];
  if (stopped && phase === 2) {
    const index = (activity?.item_index || 1) - 1;
    agents.forEach((agent) => { if (agent.state === "fail") agent.at = `work-${index}`; });
  }

  const log: StageLog[] = [];
  const add = (id: string, who: string, color: string, state: StageState, text: string) => { if (state !== "wait") log.push({ id, who, color, state, text }); };
  add("reader", "素材理解", "#22d3ee", at(0), at(0) === "done" ? "素材都看懂了" : message || "看素材");
  add("writer", "编剧", "#f472b6", at(1), at(1) === "done" ? (batch.script_confirmation ? "文案已确认" : `写好 ${scriptCount || candidates.length} 份文案`) : message || "写文案、核对画面");
  candidates.forEach((candidate, index) => {
    const state = workState(candidate, index);
    const member = CREW.find((item) => item.id === crewNow)!;
    add(`work-${index}`, state === "now" ? member.name : `第 ${index + 1} 条`, state === "now" ? member.color : "#c4b5fd", state,
      state === "done" ? `「${candidate.title}」做好了` : state === "fail" ? `「${candidate.title}」没做成${candidate.error ? `：${candidate.error}` : ""}` : message || `做「${candidate.title}」`);
  });
  if (phase === 3) add("final", "成片", "#4ade80", "done", doneCount === candidates.length ? `${doneCount} 条全部做好` : `做好 ${doneCount} 条，${candidates.length - doneCount} 条没做成`);
  return { cards, agents, log };
}
