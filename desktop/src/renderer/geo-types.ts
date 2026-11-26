export type GeoBrand = { version: number; name: string; aliases: string[]; regions: string[]; services: string; cases: string; restrictions: string };
export type GeoQuestion = { id: string; text: string; group: string };
export type GeoArticle = { id: string; revision: number; title: string; body: string; questionId: string; question: string; createdAt: string; updatedAt: string };
export type GeoPublicationStatus = "scheduled" | "queued" | "running" | "public" | "reviewing" | "failed" | "unknown" | "cancelled";
export type GeoPublication = { id: string; articleId: string; title: string; platform: string; accountId: string; accountLabel: string; status: GeoPublicationStatus; reason: string; url: string; detail?: string; confirmedAt: string; clickedAt: string; finishedAt: string; dueAt?: string; planId?: string; planItemId?: string };
export type GeoReference = { title: string; url: string; domain?: string; source?: string; association: "confirmed" | "suspected" | "unmatched"; articleId: string | null };
export type GeoRank = "top" | "mention" | "none";
export type GeoVisibilityRun = { id: string; questionId?: string; question: string; engine?: string; status: "running" | "completed" | "failed"; reason?: string; answer?: string; mentioned?: boolean; rank?: GeoRank; hits?: { name: string; snippet: string }[]; references?: GeoReference[]; referenceStatus?: string; startedAt: string; finishedAt: string };
export type GeoChannel = { id: string; name: string; available: boolean; reason: string; trial?: boolean; titleLimit?: number };
export type GeoAccount = { id: string; platform: string; label: string; status: string; loggingIn?: boolean; publishing?: boolean };
export type GeoEngine = { id: string; name: string; available: boolean };
export type GeoInquiry = { id: string; at: string; via: string; from: string; note: string };
export type GeoPlanItem = { id: string; articleId: string; accountId: string; platform: string; due: string; title: string; question: string; accountLabel: string; publicationId: string; status: GeoPublicationStatus | ""; reason: string; url: string };
export type GeoPlan = { id: string; createdAt: string; confirmedAt?: string; status: "writing" | "ready" | "confirmed" | "stopped"; total: number; items: GeoPlanItem[]; message: string };
export type GeoStats = {
  asked: number; mentioned: number; top: number; engines: { id: string; asked: number; mentioned: number; top: number }[]; trend: (number | null)[]; cited: number;
  sources: { name: string; share: number }[]; questions: Record<string, ("" | GeoRank)[]>; inquiriesThisMonth: number; inquiriesFromAi: number;
};
export type GeoState = {
  brand: GeoBrand; questions: GeoQuestion[]; articles: GeoArticle[]; publications: GeoPublication[]; visibilityRuns: GeoVisibilityRun[]; inquiries: GeoInquiry[]; plan: GeoPlan | null;
  stats: GeoStats; engines: GeoEngine[]; pausedToday: boolean;
  usage: { ai: number; aiLimit: number; publishLimit: number; weekSize: number }; channels: GeoChannel[]; aiPending: { id: string; kind: string; label: string; startedAt: string }[];
  busy: string; progress: { done: number; total: number } | null; accounts: { browserReady: boolean; accounts: GeoAccount[] };
};
export type GeoResult = { ok: boolean; code?: string; error?: string; state?: GeoState };
type GeoApi = { invoke: (action: string, payload?: Record<string, unknown>) => Promise<GeoResult>; onUpdate: (callback: (state: GeoState) => void) => () => void };
declare global { interface Window { xiaoxiGeo?: GeoApi } }
