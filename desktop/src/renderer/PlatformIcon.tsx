import type { SocialPlatformKey } from "./social-accounts-types";

// Brand-coloured badges for the four platforms; drawn here so no external icon set is needed.
export const PLATFORM_NAMES: Record<SocialPlatformKey, string> = { douyin: "抖音", kuaishou: "快手", channels: "视频号", xiaohongshu: "小红书" };

export function PlatformIcon({ platform, size = 28 }: { platform: SocialPlatformKey; size?: number }) {
  const label = PLATFORM_NAMES[platform];
  return <svg className={`platform-icon is-${platform}`} width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={label}>
    {platform === "douyin" && <>
      <rect width="32" height="32" rx="8" fill="#111" />
      {/* note with the cyan / red offset of the Douyin mark */}
      <path d="M18.6 6.5v12.2a3.9 3.9 0 1 1-3.4-3.9" fill="none" stroke="#25F4EE" strokeWidth="2.6" strokeLinecap="round" transform="translate(-1 -0.8)" />
      <path d="M18.6 6.5v12.2a3.9 3.9 0 1 1-3.4-3.9" fill="none" stroke="#FE2C55" strokeWidth="2.6" strokeLinecap="round" transform="translate(1 0.8)" />
      <path d="M18.6 6.5v12.2a3.9 3.9 0 1 1-3.4-3.9M18.6 6.5c.6 2.6 2.4 4.2 5 4.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
    </>}
    {platform === "kuaishou" && <>
      <rect width="32" height="32" rx="8" fill="#FF4906" />
      <text x="16" y="22" textAnchor="middle" fontSize="16" fontWeight="700" fill="#fff" fontFamily="'Microsoft YaHei', sans-serif">快</text>
    </>}
    {platform === "xiaohongshu" && <>
      <rect width="32" height="32" rx="8" fill="#FF2442" />
      <text x="16" y="20" textAnchor="middle" fontSize="8.4" fontWeight="700" fill="#fff" fontFamily="'Microsoft YaHei', sans-serif">小红书</text>
    </>}
    {platform === "channels" && <>
      <rect width="32" height="32" rx="8" fill="#FA9D3B" />
      {/* butterfly-like loop of the Channels mark */}
      <path d="M16 16c-2.2-4.6-5.4-7-7.3-5.6-1.9 1.4-.8 6.4 2.6 8.4 2.1 1.2 3.7.6 4.7-2.8zm0 0c2.2-4.6 5.4-7 7.3-5.6 1.9 1.4.8 6.4-2.6 8.4-2.1 1.2-3.7.6-4.7-2.8z" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" />
    </>}
  </svg>;
}
