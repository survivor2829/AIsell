type Counts = { watched: number; likes: number; follows: number; comments: number };
export type NurtureToday = {
  date: string; segments: number; segmentsDone: number; targets: { likes: number; follows: number; comments: number }; counts: Counts;
  anomalies: number; commentsOff: boolean; restUntil: number; nextAt: number; earlyMisses?: number;
};
export type NurturePlan = {
  id: string; platform: "douyin"; accountId: string; accountLabel: string; keywords: string[]; comments: string[];
  testVideo: { finishedVideoId: string; name: string; title: string } | null;
  enabled: boolean; status: "active" | "paused" | "finished"; reason: string; mode: "search" | "feed"; day: number; stage: string;
  /** What it is doing now: opening, searching, watching, resting, starting, done_today, rest_today, paused, finished or off. */
  phase: string;
  lastSegment: { endedAt: string; outcome: "completed" | "verification" | "page_changed" | "stopped" | "login" | "error"; text: string } | null;
  today: NurtureToday | null; published: boolean; publishResult: string; createdAt: string; finishedAt: string;
};
export type NurtureState = { plans: NurturePlan[]; log: { at: string; planId: string; text: string }[]; running: string };
export type NurtureResult = { ok: boolean; code?: string; error?: string; state?: NurtureState };
export type NurturePlanInput = { id?: string; accountId: string; keywords: string; comments: string; testVideo: { finishedVideoId: string; name: string; title: string } | null };
type SocialNurtureApi = {
  status: () => Promise<NurtureResult>;
  savePlan: (plan: NurturePlanInput) => Promise<NurtureResult>;
  removePlan: (id: string) => Promise<NurtureResult>;
  setEnabled: (id: string, enabled: boolean) => Promise<NurtureResult>;
  runNow: (id: string) => Promise<NurtureResult>;
  stop: () => Promise<NurtureResult>;
  onUpdate: (callback: (state: NurtureState) => void) => () => void;
};
declare global { interface Window { xiaoxiSocialNurture?: SocialNurtureApi } }
