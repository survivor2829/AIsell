import { CheckCheck, Image as ImageIcon, MessageSquareText, PenLine, Search, ShieldCheck } from "lucide-react";
import type { StageAgent, StageCard, StageLog, StageModel, StageState } from "./AgentStage";

// 精准触达的 AI 工作台：一位客户的触达流程排成卡片，由执行器真实报出的当前步骤决定谁在干活。
// 执行器按“段”发送：先文字，再一张张图片，最后网址；每段开头都会重新准备联系人、核对当前聊天。
// 所以先看正在发哪一段，再看这段走到哪一步：只有文字段才分找人/核对/发文字，图片段、网址段整段落在各自的卡上。
// 只在执行器正在处理触达任务时显示；不在微信窗口上画任何东西。
export type TouchStageInput = {
  stage: string; partKind: string; partIndex?: number; partTotal?: number; textSent: boolean;
  contactIndex?: number; contactTotal?: number; hasImages: boolean; aiPolish: boolean;
  done: number; total: number; skipped: number; stepLabel: string;
};

const WRITE = new Set(["draft_generation"]);
const FIND = new Set(["prepare_contact", "contact_send", "select-customer", "calibrate", "prepare_window", "click-search-result-dry-run"]);
const VERIFY = new Set(["verify_session", "session_reuse", "session_reuse_verify"]);
const CONFIRM = new Set(["after_send_confirmation", "part_complete"]);
const STEP = {
  write: { label: "写话术", icon: <PenLine size={18} />, agent: "文案", color: "#f472b6" },
  find: { label: "找人", icon: <Search size={18} />, agent: "搜索员", color: "#22d3ee" },
  verify: { label: "核对身份", icon: <ShieldCheck size={18} />, agent: "核对员", color: "#a3e635" },
  text: { label: "发文字", icon: <MessageSquareText size={18} />, agent: "发送员", color: "#fb923c" },
  image: { label: "发图片", icon: <ImageIcon size={18} />, agent: "发图员", color: "#f59e0b" },
  link: { label: "发网址", icon: <MessageSquareText size={18} />, agent: "发送员", color: "#fdba74" },
  confirm: { label: "核验结果", icon: <CheckCheck size={18} />, agent: "核验员", color: "#a78bfa" }
} as const;
type StepId = keyof typeof STEP;

function currentStep(input: TouchStageInput): StepId | null {
  if (WRITE.has(input.stage)) return "write";
  if (input.partKind === "image") return "image";
  if (input.partKind === "link") return "link";
  if (CONFIRM.has(input.stage)) return "confirm";
  if (FIND.has(input.stage)) return "find";
  if (VERIFY.has(input.stage)) return "verify";
  if (input.partKind === "text" && input.stage) return "text"; // typing, the send-time checks and the click
  return null;
}

export function touchStageModel(input: TouchStageInput): StageModel {
  const now = currentStep(input);
  const images = input.hasImages || input.partKind === "image";
  const order: StepId[] = [...(input.aiPolish ? ["write" as const] : []), "find", "verify", "text", ...(images ? ["image" as const] : []),
    ...(input.partKind === "link" ? ["link" as const] : []), "confirm"];
  const at = now ? order.indexOf(now) : -1;
  const textDone = input.textSent || input.partKind === "image" || input.partKind === "link";
  const state = (id: StepId, index: number): StageState => {
    if (id === now) return "now";
    if (at < 0) return "wait";
    if (id === "confirm") return "wait"; // confirmation is per part; it is shown while it happens
    if (id === "text") return textDone ? "done" : index < at ? "done" : "wait";
    if (id === "image") return input.partKind === "link" ? "done" : "wait";
    return index < at || textDone ? "done" : "wait";
  };
  const who = input.contactIndex && input.contactTotal ? `第 ${input.contactIndex}/${input.contactTotal} 位` : "当前客户";
  const cards: StageCard[] = order.map((id, index) => ({ id, label: STEP[id].label, icon: STEP[id].icon, state: state(id, index),
    detail: id === "image" && input.partKind === "image" ? `第 ${Math.max(1, (input.partIndex || 2) - 1)} 张` : undefined }));
  cards.push({ id: "progress", label: "本次进度", icon: <CheckCheck size={18} />, state: "wait", detail: `${input.done}/${input.total} 位${input.skipped ? ` · 跳过 ${input.skipped}` : ""}` });
  const agents: StageAgent[] = order.map((id, index) => ({ id, name: STEP[id].agent, color: STEP[id].color, at: id, state: state(id, index) }));
  const log: StageLog[] = [];
  order.forEach((id, index) => {
    const value = state(id, index);
    if (value === "done") log.push({ id, who: STEP[id].agent, color: STEP[id].color, state: "done", text: `${who}：${STEP[id].label}完成` });
    if (value === "now") log.push({ id, who: STEP[id].agent, color: STEP[id].color, state: "now", text: `${who}：${input.stepLabel}` });
  });
  return { cards, agents, log };
}
