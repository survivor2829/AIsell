import type { SocialPlatformKey } from "./social-accounts-types";

export type SocialPublishJob = {
  id: string; accountId: string; accountLabel: string; platform: SocialPlatformKey; videoName: string;
  title: string; description: string; visibility: "public" | "private";
  status: "queued" | "running" | "needs_user" | "clicked" | "published" | "unknown" | "failed" | "cancelled";
  step: string; reason: string; createdAt: string; updatedAt: string; clickedAt: string; finishedAt: string;
};
export type SocialPublishState = { jobs: SocialPublishJob[]; running: string; created?: number; skipped?: string[] };
export type SocialPublishResult = { ok: boolean; code?: string; error?: string; state?: SocialPublishState };
export type SocialPublishCopy = { title: string; description: string; topics: string[] };
type Result<T> = { ok: boolean; code?: string; error?: string; state?: T };
type SocialPublishApi = {
  status: () => Promise<SocialPublishResult>;
  submit: (payload: { videos: { finishedVideoId: string; name: string }[]; accountIds: string[]; title: string; description: string; visibility: "public" | "private" }) => Promise<SocialPublishResult>;
  covers: (ids: string[]) => Promise<Result<Record<string, string>>>;
  suggest: (payload: { hint: string; videos: { title: string; name: string; context: string }[] }) => Promise<Result<SocialPublishCopy>>;
  cancel: (id: string) => Promise<SocialPublishResult>;
  retry: (id: string) => Promise<SocialPublishResult>;
  resolve: (id: string, published: boolean) => Promise<SocialPublishResult>;
  remove: (id: string) => Promise<SocialPublishResult>;
  onUpdate: (callback: (state: SocialPublishState) => void) => () => void;
};
declare global { interface Window { xiaoxiSocialPublish?: SocialPublishApi } }
