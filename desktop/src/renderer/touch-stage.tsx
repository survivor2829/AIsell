import { CheckCheck, Image as ImageIcon, MessageSquareText, PenLine, Search, ShieldCheck } from "lucide-react";
import type { StageAgent, StageCard, StageLog, StageModel, StageState } from "./AgentStage";

// 精准触达的 AI 工作台：一位客户的触达流程排成卡片，由执行器真实报出的当前步骤（currentExecution.stage）
// 决定谁在干活。只在执行器正在处理触达任务时显示；不在微信窗口上画任何东西。
export type TouchStageInput = {
  stage: string; partKind: string; partIndex?: number; partTotal?: number; textSent: boolean;
  contactIndex?: number; contactTotal?: number; hasImages: boolean; done: number; total: number; skipped: number; stepLabel: string;
};

const STEPS = [
  { id: "write", label: "写话术", icon: <PenLine size={18} />, agent: "文案", color: "#f472b6", stages: ["draft_generation"] },
  { id: "find", label: "找人", icon: <Search size={18} />, agent: "搜索员", color: "#22d3ee",
    stages: ["prepare_contact", "contact_send", "select-customer", "calibrate", "prepare_window", "click-search-result-dry-run"] },
  { id: "verify", label: "核对身份", icon: <ShieldCheck size={18} />, agent: "核对员", color: "#a3e635",
    stages: ["verify_session", "session_reuse", "session_reuse_verify", "send_session_check", "before_send_snapshot", "window_binding"] },
  { id: "text", label: "发文字", icon: <MessageSquareText size={18} />, agent: "发送员", color: "#fb923c",
    stages: ["input-message-dry-run", "send", "send_click", "existing_draft_clear"] },
  { id: "image", label: "发图片", icon: <ImageIcon size={18} />, agent: "发图员", color: "#f59e0b",
    stages: ["image_send", "script_started", "context", "source_file", "clipboard_backup", "image_load", "clipboard_bitmap", "paste", "preview_verification", "click_send", "image_retry_wait"] },
  { id: "confirm", label: "核验结果", icon: <CheckCheck size={18} />, agent: "核验员", color: "#a78bfa", stages: ["after_send_confirmation", "post_confirm", "part_complete"] }
];

export function touchStageModel(input: TouchStageInput): StageModel {
  const steps = STEPS.filter((step) => step.id !== "image" || input.hasImages);
  // The executor's own step; image parts report image stages, text parts text stages.
  let current = steps.findIndex((step) => step.stages.includes(input.stage));
  if (current < 0 && input.partKind === "image") current = steps.findIndex((step) => step.id === "image");
  const textDone = input.textSent || (input.partKind === "image");
  const state = (index: number): StageState => {
    const step = steps[index];
    if (current < 0) return "wait";
    if (index === current) return "now";
    // Text is confirmed before the images start; for an image part the text steps are done.
    if (step.id === "confirm") return "wait";
    return index < current || (step.id === "text" && textDone) ? "done" : "wait";
  };
  const who = input.contactIndex && input.contactTotal ? `第 ${input.contactIndex}/${input.contactTotal} 位` : "当前客户";
  const cards: StageCard[] = steps.map((step, index) => ({ id: step.id, label: step.label, icon: step.icon, state: state(index),
    detail: step.id === "image" && input.partKind === "image" && input.partTotal ? `第 ${Math.max(1, (input.partIndex || 2) - 1)} 张` : undefined }));
  cards.push({ id: "progress", label: "本次进度", icon: <CheckCheck size={18} />, state: "wait", detail: `${input.done}/${input.total} 位${input.skipped ? ` · 跳过 ${input.skipped}` : ""}` });
  const agents: StageAgent[] = steps.map((step, index) => ({ id: step.id, name: step.agent, color: step.color, at: step.id, state: state(index) }));
  const log: StageLog[] = [];
  steps.forEach((step, index) => {
    const value = state(index);
    if (value === "done") log.push({ id: step.id, who: step.agent, color: step.color, state: "done", text: `${who}：${step.label}完成` });
    if (value === "now") log.push({ id: step.id, who: step.agent, color: step.color, state: "now", text: `${who}：${input.stepLabel}` });
  });
  return { cards, agents, log };
}
