export type AcquireTask = {
  id: string; name: string; platform: "kuaishou" | "douyin"; accountId: string; accountLabel: string;
  keywords: string[]; intentWords: string[]; days: number; maxVideos: number; allComments: boolean; skipAuthor: boolean;
  mode?: "collect" | "comment"; texts?: string[]; maxComments?: number;
  createdAt: string; updatedAt: string; lastRunAt: string;
};
export type AcquireRun = { id: string; kind?: "collect" | "comment" | "actions"; taskId: string; accountId?: string; accountLabel?: string; status: "running" | "needs_user" | "done" | "stopped" | "failed"; detail: string; videos: number; comments: number; leads: number; sent?: number; failed?: number; hidden?: number; reason: string; startedAt: string; finishedAt: string };
export type AcquireActionKind = "like" | "follow" | "comment";
export type AcquireAction = {
  id: string; kind: AcquireActionKind; platform: string; accountId: string; leadId?: string; taskId?: string;
  target: { videoId: string; videoTitle?: string; videoUrl?: string; commentId?: string; userId?: string; userName?: string; comment?: string; text?: string };
  status: "queued" | "running" | "done" | "failed" | "unknown" | "cancelled" | "hidden"; reason: string; already: boolean; createdAt: string; clickedAt: string; finishedAt: string;
};
export type AcquireCaps = Record<AcquireActionKind, number>;
export type AcquireToday = Record<string, Record<AcquireActionKind, number> & { pausedUntil: string }>;
export type AcquireLead = {
  id: string; taskId: string; platform: string; accountId: string; keyword: string; videoId: string; videoTitle: string; videoUrl: string; videoAuthor: string;
  commentId: string; userId: string; userName: string; comment: string; commentAt: string; region: string; signals: string[]; status: "new" | "contacted" | "ignored"; createdAt: string;
};
export type AcquireState = { tasks: AcquireTask[]; runs: AcquireRun[]; leads: AcquireLead[]; actions: AcquireAction[]; caps: AcquireCaps; today: AcquireToday; running: string; exported?: boolean; added?: number };
export type AcquireResult = { ok: boolean; code?: string; error?: string; state?: AcquireState };
export type AcquireTaskInput = { id?: string; name: string; mode: "collect" | "comment"; platform: string; accountId: string; keywords: string; intentWords: string; days: number; maxVideos: number; allComments: boolean; skipAuthor: boolean; texts: string; maxComments: number };
type AcquireApi = {
  status: () => Promise<AcquireResult>;
  saveTask: (task: AcquireTaskInput) => Promise<AcquireResult>;
  removeTask: (id: string) => Promise<AcquireResult>;
  start: (id: string) => Promise<AcquireResult>;
  stop: () => Promise<AcquireResult>;
  setLead: (id: string, status: AcquireLead["status"]) => Promise<AcquireResult>;
  queueActions: (leadIds: string[], kinds: AcquireActionKind[]) => Promise<AcquireResult>;
  resume: () => Promise<AcquireResult>;
  cancelQueued: () => Promise<AcquireResult>;
  resolveAction: (id: string, outcome: "done" | "failed") => Promise<AcquireResult>;
  saveCaps: (caps: AcquireCaps) => Promise<AcquireResult>;
  exportCsv: (taskId?: string) => Promise<AcquireResult>;
  openLead: (id: string) => Promise<AcquireResult>;
  onUpdate: (callback: (state: AcquireState) => void) => () => void;
};
declare global { interface Window { xiaoxiSocialAcquisition?: AcquireApi } }
