export type GeoBrand = { version: number; name: string; aliases: string[]; regions: string[]; services: string; cases: string; restrictions: string };
export type GeoQuestion = { id: string; text: string };
export type GeoArticle = { id: string; revision: number; title: string; body: string; questionId: string; question: string; updatedAt: string };
export type GeoPublication = { id: string; articleId: string; title: string; platform: string; accountId: string; accountLabel: string; status: "queued" | "running" | "public" | "reviewing" | "failed" | "unknown" | "cancelled"; reason: string; url: string; detail?: string; clickedAt: string; finishedAt: string };
export type GeoReference = { title: string; url: string; association: "confirmed" | "suspected" | "unmatched"; articleId: string | null };
export type GeoVisibilityRun = { id: string; question: string; status: "running" | "completed" | "failed"; reason?: string; answer?: string; mentioned?: boolean; hits?: { name: string; snippet: string }[]; references?: GeoReference[]; referenceStatus?: string; startedAt: string; finishedAt: string };
export type GeoChannel = { id: string; name: string; available: boolean; reason: string; trial?: boolean };
export type GeoAccount = { id: string; platform: string; label: string; status: string; loggingIn?: boolean };
export type GeoState = {
  brand: GeoBrand; questions: GeoQuestion[]; articles: GeoArticle[]; publications: GeoPublication[]; visibilityRuns: GeoVisibilityRun[];
  usage: { ai: number; aiLimit: number; publishLimit: number }; channels: GeoChannel[]; aiPending: { id: string; kind: string; label: string; startedAt: string }[];
  busy: string; accounts: { browserReady: boolean; accounts: GeoAccount[] };
};
export type GeoResult = { ok: boolean; code?: string; error?: string; state?: GeoState };
type GeoApi = { invoke: (action: string, payload?: Record<string, unknown>) => Promise<GeoResult>; onUpdate: (callback: (state: GeoState) => void) => () => void };
declare global { interface Window { xiaoxiGeo?: GeoApi } }
