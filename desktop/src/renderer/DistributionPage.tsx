import { useEffect, useMemo, useState } from "react";
import { SocialAccountsPanel } from "./SocialAccountsPanel";
import { SocialPublishPanel } from "./SocialPublishPanel";
import { SocialNurturePanel } from "./SocialNurturePanel";
import type { NurtureState } from "./social-nurture-types";
import { PlatformIcon, PLATFORM_NAMES } from "./PlatformIcon";
import type { SocialAccountsState, SocialPlatformKey } from "./social-accounts-types";
import type { SocialPublishState } from "./social-publish-types";
import "./KeywordAcquisitionPage.css";
// Shares the digital-human page's card, pick-dot and sticky-bar styles; no flow diagram here, the task is simple.
import "./NarrationSimplePage.css";
import "./DistributionPage.css";

const PLATFORMS: SocialPlatformKey[] = ["douyin", "kuaishou", "xiaohongshu", "channels"];
const today = (value: string) => Boolean(value) && new Date(value).toDateString() === new Date().toDateString();

// 账号运营（小丽）：平台账号 → 养号 → 一键分发。账号先在「平台账号」里扫码登录；新抖音号先养 8 天，
// 再把成片发到抖音、快手、小红书、视频号。三块是左侧导航里的子模块（用户 2026-10-30），这页只显示选中的那一块。
export type DistributionTab = "accounts" | "nurture" | "publish";
export function DistributionPage({ tab, onNavigate }: { tab: DistributionTab; onNavigate: (tab: DistributionTab) => void }) {
  const setTab = onNavigate;
  const [nurture, setNurture] = useState<NurtureState>();
  const [publish, setPublish] = useState<SocialPublishState>();
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  useEffect(() => {
    const publishApi = window.xiaoxiSocialPublish, accountsApi = window.xiaoxiSocialAccounts, nurtureApi = window.xiaoxiSocialNurture;
    let active = true;
    const off = [publishApi?.onUpdate((next) => { if (active) setPublish(next); }), accountsApi?.onUpdate((next) => { if (active) setAccounts(next); }), nurtureApi?.onUpdate((next) => { if (active) setNurture(next); })];
    void nurtureApi?.status().then((result) => { if (active && result.state) setNurture(result.state); });
    void publishApi?.status().then((result) => { if (active && result.state) setPublish(result.state); });
    void accountsApi?.status().then((result) => { if (active && result.state) setAccounts(result.state); });
    return () => { active = false; off.forEach((stop) => stop?.()); };
  }, []);
  const sent = useMemo(() => (publish?.jobs || []).filter((job) => job.status === "published" && today(job.clickedAt)), [publish]);
  const busy = (publish?.jobs || []).some((job) => ["running", "clicked", "needs_user"].includes(job.status));
  const reached = new Set(sent.map((job) => job.platform)).size;
  const nurturing = (nurture?.plans || []).filter((plan) => plan.status !== "finished" && plan.enabled).length;

  return <section className="ns-page distribution-page">
    <div className="dist-hero">
      <div>
        <div className="ns-kicker">账号运营{busy && <span className="ns-live"><i />正在发布</span>}{nurture?.running && <span className="ns-live"><i />正在养号</span>}</div>
        <h1 className="ns-h1">{tab === "nurture"
          ? nurturing ? <>正在养 <em>{nurturing} 个</em>抖音号</> : <>新号先养 <em>8 天</em>，再稳定发视频</>
          : sent.length
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
    {tab === "publish" && <div className="dist-panel"><SocialPublishPanel onManageAccounts={() => setTab("accounts")} /></div>}
    {tab === "nurture" && <div className="dist-panel"><SocialNurturePanel onManageAccounts={() => setTab("accounts")} /></div>}
    {tab === "accounts" && <div className="dist-panel"><SocialAccountsPanel /></div>}
  </section>;
}
