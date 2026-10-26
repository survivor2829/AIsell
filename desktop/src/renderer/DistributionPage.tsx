import { useState } from "react";
import { SocialAccountsPanel } from "./SocialAccountsPanel";
import { SocialPublishPanel } from "./SocialPublishPanel";
import "./KeywordAcquisitionPage.css";

// 一键分发：把成片发到抖音、快手、视频号、小红书。账号先在「平台账号」里扫码登录。
export function DistributionPage() {
  const [tab, setTab] = useState<"publish" | "accounts">("publish");
  return <section className="page distribution-page">
    <div className="page-head"><div><h1>一键分发</h1><p>做好的视频，一次发到抖音、快手、视频号和小红书。</p></div></div>
    <div className="keyword-tabs" role="tablist" aria-label="一键分发">
      {([["publish", "发布"], ["accounts", "平台账号"]] as const).map(([key, label]) => <button type="button" key={key} role="tab" aria-selected={tab === key} aria-controls={`distribution-panel-${key}`} id={`distribution-tab-${key}`} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    {tab === "publish" && <div id="distribution-panel-publish" role="tabpanel" aria-labelledby="distribution-tab-publish"><SocialPublishPanel onManageAccounts={() => setTab("accounts")} /></div>}
    {tab === "accounts" && <div id="distribution-panel-accounts" role="tabpanel" aria-labelledby="distribution-tab-accounts"><SocialAccountsPanel /></div>}
  </section>;
}
