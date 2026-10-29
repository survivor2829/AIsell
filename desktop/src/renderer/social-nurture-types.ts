type Counts = { watched: number; likes: number; follows: number; comments: number };
export type NurtureToday = {
  date: string; segments: number; segmentsDone: number; targets: { likes: number; follows: number; comments: number }; counts: Counts;
  anomalies: number; commentsOff: boolean; restUntil: number; nextAt: number;
};
export type NurturePlan = {
  id: string; platform: "douyin"; accountId: string; accountLabel: string; keywords: string[]; comments: string[]; startTime: string;
  testVideo: { finishedVideoId: string; name: string; title: string } | null;
  enabled: boolean; status: "active" | "paused" | "finished"; reason: string; mode: "search" | "feed"; day: number; stage: string;
  today: NurtureToday | null; published: boolean; publishResult: string; createdAt: string; finishedAt: string;
};
export type NurtureState = { plans: NurturePlan[]; log: { at: string; planId: string; text: string }[]; running: string };
export type NurtureResult = { ok: boolean; code?: string; error?: string; state?: NurtureState };
export type NurturePlanInput = { id?: string; accountId: string; keywords: string; comments: string; startTime: string; testVideo: { finishedVideoId: string; name: string; title: string } | null };
type SocialNurtureApi = {
  status: () => Promise<NurtureResult>;
  savePlan: (plan: NurturePlanInput) => Promise<NurtureResult>;
  removePlan: (id: string) => Promise<NurtureResult>;
  setEnabled: (id: string, enabled: boolean) => Promise<NurtureResult>;
  stop: () => Promise<NurtureResult>;
  onUpdate: (callback: (state: NurtureState) => void) => () => void;
};
declare global { interface Window { xiaoxiSocialNurture?: SocialNurtureApi } }
