import { useEffect, useMemo, useState } from "react";
import { SocialAccountsPanel } from "./SocialAccountsPanel";
import { SocialPublishPanel } from "./SocialPublishPanel";
import { PlatformIcon, PLATFORM_NAMES } from "./PlatformIcon";
import type { SocialAccountsState, SocialPlatformKey } from "./social-accounts-types";
import type { SocialPublishState } from "./social-publish-types";
import "./KeywordAcquisitionPage.css";
// Shares the digital-human page's card, pick-dot and sticky-bar styles; no flow diagram here, the task is simple.
import "./NarrationSimplePage.css";
import "./DistributionPage.css";

const PLATFORMS: SocialPlatformKey[] = ["douyin", "kuaishou", "xiaohongshu", "channels"];
const today = (value: string) => Boolean(value) && new Date(value).toDateString() === new Date().toDateString();

// 一键分发：把成片发到抖音、快手、小红书、视频号。账号先在「平台账号」里扫码登录。
export function DistributionPage() {
  const [tab, setTab] = useState<"publish" | "accounts">("publish");
  const [publish, setPublish] = useState<SocialPublishState>();
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  useEffect(() => {
    const publishApi = window.xiaoxiSocialPublish, accountsApi = window.xiaoxiSocialAccounts;
    let active = true;
    const off = [publishApi?.onUpdate((next) => { if (active) setPublish(next); }), accountsApi?.onUpdate((next) => { if (active) setAccounts(next); })];
    void publishApi?.status().then((result) => { if (active && result.state) setPublish(result.state); });
    void accountsApi?.status().then((result) => { if (active && result.state) setAccounts(result.state); });
    return () => { active = false; off.forEach((stop) => stop?.()); };
  }, []);
  const sent = useMemo(() => (publish?.jobs || []).filter((job) => job.status === "published" && today(job.clickedAt)), [publish]);
  const busy = (publish?.jobs || []).some((job) => ["running", "clicked", "needs_user"].includes(job.status));
  const reached = new Set(sent.map((job) => job.platform)).size;

  return <section className="ns-page distribution-page">
    <div className="dist-hero">
      <div>
        <div className="ns-kicker">一键分发{busy && <span className="ns-live"><i />正在发布</span>}</div>
        <h1 className="ns-h1">{sent.length
          ? <>今天已发出 <em>{sent.length} 条</em>，覆盖 <em>{reached} 个</em>平台</>
          : <>一条视频，<em>四个平台</em>同时上线</>}</h1>
      </div>
      <ul className="dist-platforms" aria-label="平台账号状态">
        {PLATFORMS.map((platform) => {
          const list = (accounts?.accounts || []).filter((account) => account.platform === platform);
          const ready = list.filter((account) => account.status === "active").length;
          return <li key={platform}>
            <PlatformIcon platform={platform} size={52} />
            <b>{PLATFORM_NAMES[platform]}</b>
            <span className={ready ? "is-ready" : list.length ? "is-expired" : ""}><i />{list.length ? `${ready}/${list.length} 已登录` : "未添加"}</span>
          </li>;
        })}
      </ul>
    </div>
    <div className="dist-tabs" role="tablist" aria-label="一键分发">
      {([["publish", "发布"], ["accounts", "平台账号"]] as const).map(([key, label]) => <button type="button" key={key} role="tab" aria-selected={tab === key} aria-controls={`distribution-panel-${key}`} id={`distribution-tab-${key}`} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    {tab === "publish" && <div id="distribution-panel-publish" role="tabpanel" aria-labelledby="distribution-tab-publish" className="dist-panel"><SocialPublishPanel onManageAccounts={() => setTab("accounts")} /></div>}
    {tab === "accounts" && <div id="distribution-panel-accounts" role="tabpanel" aria-labelledby="distribution-tab-accounts" className="dist-panel"><SocialAccountsPanel /></div>}
  </section>;
}
