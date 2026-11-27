import { Clapperboard, Film, Image as ImageIcon, ImagePlus, MapPin, ScanEye, Sparkles } from "lucide-react";
import type { StageAgent, StageCard, StageLog, StageModel, StageState } from "./AgentStage";

// 场景效果视频（无人实拍 + AI 导演）的 AI 工作台：只从任务的真实状态推出看板、光标和日志。
// 步骤顺序与主进程 advanceReal 一致：定妆照 → 等客户确认 → 导演写分镜 → 画场地 → 风险审查 → 并行拍镜头 → AI 检查 → 拼接加字幕。
export type SceneStageTask = {
  status: string; resumeStatus?: string; error?: string; failedShotIndex?: number | null; currentShot?: number;
  sheetStep?: boolean; sheetConfirmed?: boolean; sceneStep?: boolean; sceneConfirmed?: boolean; directorStep?: boolean; directed?: boolean;
  imagesReady?: Record<string, boolean>; shotsReady?: boolean[]; shotsRunning?: boolean[];
  review?: { skipped?: boolean; shots: { ok: boolean; redone?: boolean }[] } | null;
  crew?: { sides: string[]; survey: { widthM: number | null; canTurn: boolean } | null; risks: { index: number }[]; rewritten: boolean; fallback?: number[] } | null;
  plan: { machine?: string; shots: { index: number; title: string; place?: string }[] };
};

const PHASE = { upload: 0, sheet: 1, confirm: 2, direct: 3, plate: 4, preflight: 5, shoot: 6, review: 7, finish: 8, done: 9 } as const;
const STUCK = new Set(["needs_attention", "outcome_unknown"]);
const CAMERA_COLORS = ["#fb923c", "#f59e0b", "#fbbf24", "#fdba74", "#f97316", "#fcd34d", "#fed7aa", "#ea580c"];

function phaseOf(task: SceneStageTask, status: string) {
  const plateNeeded = task.plan.shots.some((shot) => shot.place === "venue");
  if (status === "uploading") return PHASE.upload;
  if (status === "awaiting_sheet") return PHASE.confirm;
  if (status === "directing") return PHASE.direct;
  if (status === "imaging") {
    // The analyst still reads the sheet after it is drawn; the customer's turn starts at awaiting_sheet.
    if (task.sheetStep && !task.sheetConfirmed) return PHASE.sheet;
    if (task.directorStep && !task.directed) return PHASE.direct;
    return plateNeeded && !task.imagesReady?.plate ? PHASE.plate : PHASE.preflight;
  }
  // real-4: the customer looks at the drawn place before the risk review and the keyframes.
  if (status === "awaiting_scene") return PHASE.plate;
  // real-3: the keyframes and the customer's look at them come right before filming.
  if (status === "drawing_frames" || status === "awaiting_storyboard") return PHASE.preflight;
  if (status === "submitting" || status === "generating") return PHASE.shoot;
  if (status === "assembling") return task.directorStep && !task.review ? PHASE.review : PHASE.finish;
  if (status === "packaging") return PHASE.finish;
  if (status === "completed") return PHASE.done;
  return PHASE.upload;
}

// A stuck task that did not record where it stopped: the furthest step its results show.
function inferredStatus(task: SceneStageTask) {
  const shots = task.plan.shots;
  const plateNeeded = shots.some((shot) => shot.place === "venue");
  if (shots.length && shots.every((_, index) => task.shotsReady?.[index])) return "assembling";
  if (task.shotsReady?.some(Boolean) || task.shotsRunning?.some(Boolean)) return "generating";
  if ((!task.sheetStep || task.sheetConfirmed) && (!task.directorStep || task.directed) && (!plateNeeded || task.imagesReady?.plate)) return "generating";
  if (!task.sheetStep || task.sheetConfirmed) return task.directorStep && !task.directed ? "directing" : "imaging";
  return task.imagesReady?.sheet ? "awaiting_sheet" : "imaging";
}

export function sceneStageModel(task: SceneStageTask): StageModel {
  const stuck = STUCK.has(task.status);
  const phase = phaseOf(task, stuck ? task.resumeStatus || inferredStatus(task) : task.status);
  const plateNeeded = task.plan.shots.some((shot) => shot.place === "venue");
  const at = (step: number): StageState => phase > step ? "done" : phase === step ? (stuck ? "fail" : "now") : "wait";
  const shots = task.plan.shots;
  // The shot the main process recorded as failed; several shots run at once, so not simply the first open one.
  const failedShot = Number.isInteger(task.failedShotIndex) ? Number(task.failedShotIndex)
    : Number.isInteger(task.currentShot) && !task.shotsReady?.[Number(task.currentShot)] ? Number(task.currentShot)
    : shots.findIndex((_, index) => !task.shotsReady?.[index]);
  const shotState = (index: number): StageState => {
    if (phase > PHASE.shoot || task.shotsReady?.[index]) return "done";
    if (phase < PHASE.shoot) return "wait";
    if (stuck) return index === failedShot ? "fail" : "wait";
    return task.shotsRunning?.[index] ? "now" : "wait";
  };
  const sheetState: StageState = phase === PHASE.confirm ? (stuck ? "fail" : "user") : at(PHASE.sheet);
  const crew = task.crew;
  // The risk review is finished before the keyframes are drawn (real-3/real-4), though both share its phase.
  const riskState: StageState = task.status === "drawing_frames" || task.status === "awaiting_storyboard" ? "done" : at(PHASE.preflight);
  const flagged = task.review?.shots.filter((shot) => !shot.ok && !shot.redone).length || 0;

  const cards: StageCard[] = [
    { id: "photos", label: "产品照", icon: <ImageIcon size={18} />, state: at(PHASE.upload) },
    ...(task.sheetStep ? [{ id: "sheet", label: "定妆照", icon: <ImagePlus size={18} />, state: sheetState, detail: sheetState === "user" ? "等你确认" : undefined }] : []),
    // Every real shoot has a shot plan; without the AI director it comes from the customer's picks, and the
    // pre-shoot check still runs on it, so the card is always there to show that step.
    { id: "board", label: "分镜", icon: <Sparkles size={18} />, state: task.status === "awaiting_storyboard" ? "user" : phase === PHASE.preflight ? at(PHASE.preflight) : task.directorStep ? at(PHASE.direct) : at(PHASE.upload),
      detail: task.status === "awaiting_storyboard" ? "等你确认" : task.status === "drawing_frames" ? "画分镜图" : phase > PHASE.direct ? `${shots.length} 个镜头` : undefined },
    ...(plateNeeded ? [{ id: "plate", label: "拍摄场地", icon: <MapPin size={18} />, state: (task.status === "awaiting_scene" ? "user" : at(PHASE.plate)) as StageState,
      detail: task.status === "awaiting_scene" ? "等你确认" : undefined }] : []),
    ...shots.map((shot, index) => ({ id: `shot-${index}`, label: `镜头 ${index + 1}`, icon: <Clapperboard size={18} />, state: shotState(index), detail: shot.title })),
    ...(task.directorStep ? [{ id: "review", label: "AI 检查", icon: <ScanEye size={18} />, state: at(PHASE.review),
      detail: task.review && !task.review.skipped ? (flagged ? `${flagged} 个镜头要看` : "都没问题") : undefined }] : []),
    { id: "final", label: "成片", icon: <Film size={18} />, state: at(PHASE.finish) }
  ];

  const agent = (id: string, name: string, color: string, card: string, state: StageState): StageAgent => ({ id, name, color, at: card, state });
  const agents: StageAgent[] = [
    agent("analyst", "产品分析师", "#22d3ee", task.sheetStep ? "sheet" : "photos", task.sheetStep ? (sheetState === "user" ? "done" : at(PHASE.sheet)) : at(PHASE.upload)),
    ...(task.directorStep ? [agent("director", "导演", "#f472b6", "board", at(PHASE.direct))] : []),
    ...(plateNeeded ? [agent("survey", "场景勘察", "#a3e635", "plate", at(PHASE.plate))] : []),
    ...(task.directorStep ? [agent("risk", "风险审查", "#fb7185", "board", riskState)] : []),
    ...shots.map((_, index) => agent(`camera-${index}`, `摄影师 ${index + 1}`, CAMERA_COLORS[index % CAMERA_COLORS.length], `shot-${index}`, shotState(index))),
    ...(task.directorStep ? [agent("qa", "质检", "#facc15", "review", at(PHASE.review))] : []),
    agent("editor", "剪辑", "#a78bfa", "final", at(PHASE.finish))
  ];

  // Log: one line per step reached, in pipeline order; the step in progress reads as "now".
  const log: StageLog[] = [];
  const line = (id: string, who: string, color: string, state: StageState, now: string, done: string) => {
    if (state === "wait") return;
    log.push({ id, who, color, state, text: state === "done" ? done : state === "fail" ? `${now}，停住了` : now });
  };
  const sides = crew?.sides?.length ? `拍到${crew.sides.join("、")}` : "";
  if (task.sheetStep) {
    line("analyst", "产品分析师", "#22d3ee", sheetState === "user" ? "done" : at(PHASE.sheet), "看产品照，出四视角定妆照", ["定妆照出好了", sides].filter(Boolean).join(" · "));
    if (phase >= PHASE.confirm) line("you", "你", "#fde047", sheetState === "user" ? "user" : phase > PHASE.confirm ? "done" : sheetState, "请看定妆照像不像，确认后开拍", "定妆照已确认");
  }
  if (task.directorStep) line("director", "导演", "#f472b6", at(PHASE.direct), "看定妆照，判断怎么拍、写分镜",
    [task.plan.machine?.split(/[，,（(]/)[0], `${shots.length} 个镜头：${shots.map((shot) => shot.title).join(" / ")}`].filter(Boolean).join(" · "));
  if (plateNeeded) line("survey", "场景勘察", "#a3e635", at(PHASE.plate), "画拍摄场地",
    crew?.survey ? `场地宽约 ${crew.survey.widthM ?? "?"} 米 · ${crew.survey.canTurn ? "能转弯" : "只直行"}` : "场地画好了");
  if (task.directorStep) line("risk", "风险审查", "#fb7185", riskState, "逐镜查穿帮风险",
    crew?.risks?.length ? `第 ${crew.risks.map((row) => row.index + 1).join("、")} 镜仍有风险` : crew?.fallback?.length ? `第 ${crew.fallback.map((index) => index + 1).join("、")} 镜换成稳妥拍法` : crew?.rewritten ? "让导演改过分镜，没有穿帮风险了" : "没发现穿帮风险");
  if (task.sceneStep && plateNeeded) line("you-scene", "你", "#fde047", task.status === "awaiting_scene" ? "user" : phase > PHASE.plate ? "done" : "wait", "请看拍摄现场，可以换一个", "拍摄现场已确认");
  if (phase >= PHASE.preflight && (task.status === "drawing_frames" || task.status === "awaiting_storyboard" || phase > PHASE.preflight))
    line("you-board", "你", "#fde047", task.status === "awaiting_storyboard" ? "user" : task.status === "drawing_frames" ? "now" : "done", task.status === "drawing_frames" ? "AI 正在画每个镜头的开始和结束画面" : "请看分镜，可以改动作和角度", "分镜已确认");
  shots.forEach((shot, index) => line(`camera-${index}`, `摄影师 ${index + 1}`, CAMERA_COLORS[index % CAMERA_COLORS.length], shotState(index), `拍镜头 ${index + 1}「${shot.title}」`, `镜头 ${index + 1}「${shot.title}」拍好了`));
  if (task.directorStep) line("qa", "质检", "#facc15", at(PHASE.review), "逐镜检查画面",
    task.review?.skipped ? "这次没能自动检查" : flagged ? `${flagged} 个镜头可能要重拍` : "每个镜头都没发现明显问题");
  line("editor", "剪辑", "#a78bfa", at(PHASE.finish), "拼接镜头、加字幕", "成片好了");
  return { cards, agents, log };
}

