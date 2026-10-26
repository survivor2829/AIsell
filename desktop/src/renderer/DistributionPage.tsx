import { useState } from "react";
import { SocialAccountsPanel } from "./SocialAccountsPanel";
import { SocialPublishPanel } from "./SocialPublishPanel";
import { PlatformIcon, PLATFORM_NAMES } from "./PlatformIcon";
import "./KeywordAcquisitionPage.css";

// 一键分发：把成片发到抖音、快手、视频号、小红书。账号先在「平台账号」里扫码登录。
export function DistributionPage() {
  const [tab, setTab] = useState<"publish" | "accounts">("publish");
  return <section className="page distribution-page">
    <div className="page-head distribution-head"><div><h1>一键分发</h1><p>做好的视频，一次发到抖音、快手、小红书和视频号。</p></div>
      <ul className="distribution-platforms" aria-label="支持的平台">{(["douyin", "kuaishou", "xiaohongshu", "channels"] as const).map((platform) => <li key={platform}><PlatformIcon platform={platform} size={34} /><span>{PLATFORM_NAMES[platform]}</span></li>)}</ul>
    </div>
    <div className="keyword-tabs" role="tablist" aria-label="一键分发">
      {([["publish", "发布"], ["accounts", "平台账号"]] as const).map(([key, label]) => <button type="button" key={key} role="tab" aria-selected={tab === key} aria-controls={`distribution-panel-${key}`} id={`distribution-tab-${key}`} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    {tab === "publish" && <div id="distribution-panel-publish" role="tabpanel" aria-labelledby="distribution-tab-publish"><SocialPublishPanel onManageAccounts={() => setTab("accounts")} /></div>}
    {tab === "accounts" && <div id="distribution-panel-accounts" role="tabpanel" aria-labelledby="distribution-tab-accounts"><SocialAccountsPanel /></div>}
  </section>;
}
