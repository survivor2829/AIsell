export type AcquireTask = {
  id: string; name: string; platform: "kuaishou" | "douyin"; accountId: string; accountLabel: string;
  keywords: string[]; intentWords: string[]; days: number; maxVideos: number; allComments: boolean; skipAuthor: boolean;
  createdAt: string; updatedAt: string; lastRunAt: string;
};
export type AcquireRun = { id: string; taskId: string; status: "running" | "needs_user" | "done" | "stopped" | "failed"; detail: string; videos: number; comments: number; leads: number; reason: string; startedAt: string; finishedAt: string };
export type AcquireLead = {
  id: string; taskId: string; platform: string; accountId: string; keyword: string; videoId: string; videoTitle: string; videoUrl: string; videoAuthor: string;
  commentId: string; userId: string; userName: string; comment: string; commentAt: string; region: string; signals: string[]; status: "new" | "contacted" | "ignored"; createdAt: string;
};
export type AcquireState = { tasks: AcquireTask[]; runs: AcquireRun[]; leads: AcquireLead[]; running: string; exported?: boolean };
export type AcquireResult = { ok: boolean; code?: string; error?: string; state?: AcquireState };
export type AcquireTaskInput = { id?: string; name: string; platform: string; accountId: string; keywords: string; intentWords: string; days: number; maxVideos: number; allComments: boolean; skipAuthor: boolean };
type AcquireApi = {
  status: () => Promise<AcquireResult>;
  saveTask: (task: AcquireTaskInput) => Promise<AcquireResult>;
  removeTask: (id: string) => Promise<AcquireResult>;
  start: (id: string) => Promise<AcquireResult>;
  stop: () => Promise<AcquireResult>;
  setLead: (id: string, status: AcquireLead["status"]) => Promise<AcquireResult>;
  exportCsv: (taskId?: string) => Promise<AcquireResult>;
  openLead: (id: string) => Promise<AcquireResult>;
  onUpdate: (callback: (state: AcquireState) => void) => () => void;
};
declare global { interface Window { xiaoxiSocialAcquisition?: AcquireApi } }
