export type SocialPlatformKey = "douyin" | "kuaishou" | "channels" | "xiaohongshu";
export type SocialAccount = {
  id: string; platform: SocialPlatformKey; label: string;
  status: "login_required" | "active" | "expired";
  createdAt: string; lastLoginAt: string; checkedAt: string; loggingIn: boolean;
};
export type SocialAccountsState = { platforms: { key: SocialPlatformKey; name: string }[]; browserReady: boolean; accounts: SocialAccount[] };
export type SocialAccountsResult = { ok: boolean; code?: string; error?: string; state?: SocialAccountsState };
type SocialAccountsApi = {
  status: () => Promise<SocialAccountsResult>;
  add: (platform: SocialPlatformKey, label: string) => Promise<SocialAccountsResult>;
  rename: (id: string, label: string) => Promise<SocialAccountsResult>;
  login: (id: string) => Promise<SocialAccountsResult>;
  refresh: () => Promise<SocialAccountsResult>;
  remove: (id: string) => Promise<SocialAccountsResult>;
  onUpdate: (callback: (state: SocialAccountsState) => void) => () => void;
};
declare global { interface Window { xiaoxiSocialAccounts?: SocialAccountsApi } }
