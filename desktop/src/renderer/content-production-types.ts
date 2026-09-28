export type ProductionCategory = "active" | "needs_attention" | "history" | "archived";
export type ProductionView = ProductionCategory | "pending" | "all";
export type ProductionSummary = {
  active: number;
  needsAttention: number;
  pending: number;
  history: number;
  archived: number;
  total: number;
};
export type ProductionStep = {
  taskId: string;
  taskType: string;
  status: string;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ContentProduction = {
  productionId: string;
  kind: "narrated_batch" | "guided_session" | "auto_mix_v2" | "task";
  title: string;
  state: string;
  category: ProductionCategory;
  archived: boolean;
  taskId: string | null;
  taskType: string;
  taskStatus: string | null;
  progress: number;
  projectId: string | null;
  runId: string | null;
  batchId: string | null;
  sessionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  steps: ProductionStep[];
};
export type ProductionList = {
  items: ContentProduction[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  summary: ProductionSummary;
};
export type ProductionResult<T> = { ok: boolean; data?: T; code?: string; error?: string };
export type ProviderUsageCall = {
  call_id: string; purpose: string; kind: string; model: string; outcome: string;
  started_at: string; attempt: number; correction_attempt: number; elapsed_ms: number | null;
  request_id: string; client_request_id: string; log_id: string;
  input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null;
  billed_characters: number | null; requested_characters: number | null; audio_ms: number | null;
};
export type ProviderUsage = { items: ProviderUsageCall[]; totals: Record<string, number | null>; truncated: boolean; amount: null };
export type ProductionsApi = {
  usage: (payload: { taskId?: string; batchId?: string; limit?: number }) => Promise<ProductionResult<ProviderUsage>>;
  summary: () => Promise<ProductionResult<ProductionSummary>>;
  list: (payload?: { view?: ProductionView; offset?: number; limit?: number }) => Promise<ProductionResult<ProductionList>>;
};
