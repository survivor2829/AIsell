export type Asset = { assetId: string; displayName: string; mediaKind: "image" | "video"; durationMs?: number; availableLocationCount?: number };
export type Collection = { collection_id: string; name: string; description: string; asset_ids: string[] };
export type Group = "opening" | "middle" | "ending";
export type Groups = Record<Group, string[]>;
export type Shot = { segment_id: string; asset_id: string; description: string; source_start_ms: number; source_end_ms: number };
export type Candidate = { candidate_id: string; title: string; narration: string; angle: string; status: string; generated_video_id?: string; error?: string; shots: Shot[]; actual_shots?: Shot[]; revision: number };
export type Batch = {
  batch_id: string; title: string; description: string; cta: string; collection_id?: string;
  groups: Groups; target_count: number | null; recommended_count: number; feasible_count: number;
  count_is_exact: boolean; reasons: string[]; status: string; task_id?: string; task_status?: string;
  progress: number; candidates: Candidate[]; available_shots: Shot[]; completed_count?: number;
  settings: { voice_persona_id?: string; brand_profile_id?: string }; approved: boolean;
  updated_at: string;
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
  draft: "待选材", planning: "正在分析与规划", ready: "方案已就绪", insufficient_materials: "请调整生成数量",
  rendering: "正在制作", awaiting_confirmation: "样片待确认", completed: "已完成", completed_with_errors: "部分完成",
  paused: "已暂停", cancelled: "已取消", needs_attention: "需要处理", outcome_unknown: "调用结果待核对",
  queued: "排队中", analyzing: "正在分析素材", planned: "待制作", needs_review: "修改待复核", failed: "制作失败"
};
