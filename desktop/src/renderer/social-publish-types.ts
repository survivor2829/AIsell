import type { SocialPlatformKey } from "./social-accounts-types";

export type SocialPublishJob = {
  id: string; accountId: string; accountLabel: string; platform: SocialPlatformKey; videoName: string;
  title: string; description: string; visibility: "public" | "private";
  status: "queued" | "running" | "needs_user" | "clicked" | "published" | "unknown" | "failed" | "cancelled";
  step: string; reason: string; createdAt: string; updatedAt: string; clickedAt: string; finishedAt: string;
};
export type SocialPublishState = { jobs: SocialPublishJob[]; running: string; created?: number; skipped?: string[] };
export type SocialPublishResult = { ok: boolean; code?: string; error?: string; state?: SocialPublishState };
type SocialPublishApi = {
  status: () => Promise<SocialPublishResult>;
  submit: (payload: { videos: { finishedVideoId: string; name: string }[]; accountIds: string[]; title: string; description: string; visibility: "public" | "private" }) => Promise<SocialPublishResult>;
  cancel: (id: string) => Promise<SocialPublishResult>;
  retry: (id: string) => Promise<SocialPublishResult>;
  resolve: (id: string, published: boolean) => Promise<SocialPublishResult>;
  remove: (id: string) => Promise<SocialPublishResult>;
  onUpdate: (callback: (state: SocialPublishState) => void) => () => void;
};
declare global { interface Window { xiaoxiSocialPublish?: SocialPublishApi } }
