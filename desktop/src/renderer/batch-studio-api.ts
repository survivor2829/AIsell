export type Asset = { assetId: string; displayName: string; mediaKind: "image" | "video"; durationMs?: number; availableLocationCount?: number };
export type Collection = { collection_id: string; name: string; description: string; asset_ids: string[] };
export type Group = "opening" | "middle" | "ending";
export type Groups = Record<Group, string[]>;
export type Shot = { segment_id: string; asset_id: string; description: string; source_start_ms: number; source_end_ms: number };
export type Candidate = { framework?: string; summary?: string; opening_example?: string; candidate_id: string; title: string; narration: string; phrases?: { text: string }[]; angle: string; audience?: string; pain_point?: string; estimated_duration_ms?: number; status: string; generated_video_id?: string; error?: string; duration_ms?: number; shots: Shot[]; actual_shots?: Shot[]; revision: number; music_track_id?: string; source_script_id?: string; production_index?: number };
export type ScriptSelection = { script_id: string; revision: number; count: number; title: string; narration: string; confirmed_at: string };
export type ProductionJob = { script_id: string; ordinal: number; production_index: number; candidate_id?: string; status: string; error?: string };
export type Batch = {
  brief_version?: number; target_audience?: string; expression?: string; advantages?: string; customer_pain_points?: string;
  brief_suggestions?: { expression?: string; advantages?: string; customer_pain_points?: string };
  batch_id: string; title: string; description: string; cta: string; collection_id?: string;
  groups: Groups; target_count: number | null; recommended_count: number; feasible_count: number;
  count_is_exact: boolean; reasons: string[]; status: string; task_id?: string; task_status?: string;
  progress: number; candidates: Candidate[]; available_shots: Shot[]; completed_count?: number;
  settings: { voice_persona_id?: string; brand_profile_id?: string; minimum_duration_seconds?: number; workflow_version?: number; music_track_ids?: string[] }; approved: boolean;
  script_options?: Candidate[]; selected_script_id?: string;
  script_selections?: ScriptSelection[]; production_jobs?: ProductionJob[]; production_retry_available?: boolean;
  material_context?: string; export_ready?: boolean; exported_count?: number; export_error?: string;
  script_confirmation?: { script_id: string; revision: number; narration: string; confirmed_at: string } | null;
  direction?: { audience?: string; pain_point?: string; angle?: string };
  music_selections?: { candidate_id: string; track_id: string; display_name?: string }[];
  updated_at: string; created_at?: string;
  activity?: { message: string; started_at: string; completed: number | null; total: number | null };
  planning_recovery_available?: boolean;
  suggested_brief?: { title: string; description: string; cta: string };
};
type Result<T> = { ok: boolean; data?: T; code?: string; error?: string };
type BatchApi = Record<string, (payload?: unknown) => Promise<Result<unknown>>>;
export function batchApi(): BatchApi {
  const api = (window as unknown as { xiaoxiContent?: { batch?: BatchApi } }).xiaoxiContent?.batch;
  if (!api) throw new Error("内容引擎尚未连接，请重新启动应用。");
  return api;
}
export async function callBatch<T>(action: string, payload?: unknown): Promise<T> {
  const result = await batchApi()[action](payload);
  if (!result.ok || result.data === undefined) throw new Error(result.error || "操作未完成，请重试。");
  return result.data as T;
}
export const assetUrl = (id: string, variant = "thumbnail") => `xiaoxi-content://asset/${id}/${variant}`;
export const videoUrl = (id: string, variant = "video") => `xiaoxi-content://generated/${id}/${variant}`;
export const groupNames: Record<Group, string> = { opening: "开头", middle: "中间", ending: "结尾" };
export const batchStatus: Record<string, string> = {
  draft: "待选材", planning: "正在准备文案", scripts_ready: "请选择文案", ready: "可以生成", insufficient_materials: "暂未得到合格作品",
  rendering: "正在制作", awaiting_confirmation: "样片待确认", completed: "已完成", completed_with_errors: "部分完成",
  paused: "已暂停", cancelled: "已取消", needs_attention: "需要处理", outcome_unknown: "调用结果待核对",
  queued: "排队中", analyzing: "正在分析素材", planned: "待制作", needs_review: "修改待复核", failed: "制作失败"
};
