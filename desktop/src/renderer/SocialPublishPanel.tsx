import { useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, RotateCcw, Send, Trash2, X } from "lucide-react";
import type { SocialAccount, SocialAccountsState, SocialPlatformKey } from "./social-accounts-types";
import type { SocialPublishJob, SocialPublishResult, SocialPublishState } from "./social-publish-types";
import "./SocialPublishPanel.css";

type FinishedItem = { finishedVideoId: string; displayName: string; title: string; metadata: Record<string, unknown>; createdAt: string; available: boolean };
type FinishedApi = { finished?: { list: (payload?: { limit?: number }) => Promise<{ ok: boolean; data?: { items: FinishedItem[] }; message?: string }> } };
const finishedApi = () => (window as unknown as { xiaoxiContent?: FinishedApi }).xiaoxiContent?.finished;

const PLATFORM_NAMES: Record<SocialPlatformKey, string> = { douyin: "抖音", kuaishou: "快手", channels: "视频号", xiaohongshu: "小红书" };
const TITLE_LIMITS: Partial<Record<SocialPlatformKey, number>> = { douyin: 30, xiaohongshu: 20 };
const STATUS: Record<SocialPublishJob["status"], string> = { queued: "排队中", running: "进行中", needs_user: "等你验证", clicked: "等待平台结果", published: "已发出", unknown: "结果不明", failed: "没有发出", cancelled: "已取消" };
// Records that still need the user or are still running are listed first, so none is hidden by older ones.
const ATTENTION = new Set<SocialPublishJob["status"]>(["unknown", "needs_user", "running", "clicked", "queued"]);
const GENERATED_ID = /^generated_video_[a-f0-9]{32}$/i;
const thumbnail = (item: FinishedItem) => { const id = item.metadata?.generated_video_id; return typeof id === "string" && GENERATED_ID.test(id) ? `xiaoxi-content://generated/${id}/thumbnail` : ""; };

export function SocialPublishPanel({ onManageAccounts }: { onManageAccounts: () => void }) {
  const publishApi = window.xiaoxiSocialPublish;
  const accountsApi = window.xiaoxiSocialAccounts;
  const [videos, setVideos] = useState<FinishedItem[]>([]);
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  const [state, setState] = useState<SocialPublishState>();
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadVideos = async () => {
    const api = finishedApi();
    if (!api) { setError("成片中心暂时无法读取，请重新打开软件。"); return; }
    const result = await api.list({ limit: 200 }).catch(() => null);
    if (result?.ok) setVideos((result.data?.items || []).filter((item) => item.available));
    else setError("成片读取失败，请稍后刷新。");
  };
  useEffect(() => {
    void loadVideos();
    if (!publishApi || !accountsApi) { setError("一键分发服务尚未连接，请重新打开桌面应用。"); return; }
    let active = true;
    const offPublish = publishApi.onUpdate((next) => { if (active) setState(next); });
    const offAccounts = accountsApi.onUpdate((next) => { if (active) setAccounts(next); });
    void publishApi.status().then((result) => { if (active && result.state) setState(result.state); });
    void accountsApi.status().then((result) => { if (active && result.state) setAccounts(result.state); });
    return () => { active = false; offPublish(); offAccounts(); };
  }, [publishApi, accountsApi]);

  const chosenAccounts = useMemo(() => (accounts?.accounts || []).filter((account) => selectedAccounts.includes(account.id)), [accounts, selectedAccounts]);
  const problems = useMemo(() => {
    const list: string[] = [];
    for (const account of chosenAccounts) {
      const limit = TITLE_LIMITS[account.platform];
      if (limit && title.trim().length > limit) list.push(`${PLATFORM_NAMES[account.platform]}标题最多 ${limit} 个字`);
      if (visibility === "private" && account.platform === "channels") list.push("视频号发表时不能设为仅自己可见");
    }
    return [...new Set(list)];
  }, [chosenAccounts, title, visibility]);

  const toggle = (list: string[], value: string, max = 99) => list.includes(value) ? list.filter((item) => item !== value) : list.length >= max ? list : [...list, value];
  const run = async (key: string, operation: () => Promise<SocialPublishResult>, success = "") => {
    setPending(key); setError(""); setNotice("");
    try {
      const result = await operation();
      if (result.state) setState(result.state);
      if (!result.ok) { setError(result.error || "操作未完成，请稍后重试。"); return false; }
      if (success) setNotice(success);
      return true;
    } catch { setError("操作未完成，请稍后重试。"); return false; }
    finally { setPending(""); }
  };
  const submit = async () => {
    if (!publishApi) return;
    const chosen = videos.filter((item) => selectedVideos.includes(item.finishedVideoId));
    const ok = await run("submit", async () => {
      const result = await publishApi.submit({ videos: chosen.map((item) => ({ finishedVideoId: item.finishedVideoId, name: item.title || item.displayName })), accountIds: selectedAccounts, title, description, visibility });
      if (result.ok && result.state) {
        const skipped = result.state.skipped || [];
        setNotice(`已加入发布队列 ${result.state.created || 0} 条。${skipped.length ? `已跳过 ${skipped.length} 条重复发布。` : ""}发布时会自动打开 Chrome 窗口，请不要在窗口里打字。`);
      }
      return result;
    });
    if (ok) setSelectedVideos([]);
  };

  const usable = (account: SocialAccount) => account.status === "active" && !account.loggingIn;
  return <div className="social-publish">
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    <section className="social-publish-block" aria-labelledby="publish-videos">
      <div className="social-publish-head"><h2 id="publish-videos">1. 选视频<span>已选 {selectedVideos.length}/20</span></h2>
        <button type="button" className="social-text-button" onClick={() => void loadVideos()}><RefreshCw size={14} />刷新</button></div>
      {videos.length === 0 ? <p className="social-empty">成片中心还没有视频。做好的视频会出现在这里。</p> : <ul className="social-video-grid">
        {videos.slice(0, 60).map((item) => { const selected = selectedVideos.includes(item.finishedVideoId); const cover = thumbnail(item);
          return <li key={item.finishedVideoId}><button type="button" className={`social-video ${selected ? "is-selected" : ""}`} aria-pressed={selected} onClick={() => setSelectedVideos(toggle(selectedVideos, item.finishedVideoId, 20))}>
            {cover ? <img src={cover} alt="" loading="lazy" /> : <span className="social-video-blank" aria-hidden="true" />}
            <span className="social-video-title">{item.title || item.displayName}</span>
            {selected && <span className="social-video-check" aria-hidden="true"><Check size={14} /></span>}
          </button></li>; })}
      </ul>}
    </section>
    <section className="social-publish-block" aria-labelledby="publish-accounts">
      <div className="social-publish-head"><h2 id="publish-accounts">2. 选账号<span>已选 {selectedAccounts.length}</span></h2>
        <button type="button" className="social-text-button" onClick={onManageAccounts}>管理平台账号</button></div>
      {(accounts?.accounts.length || 0) === 0 ? <p className="social-empty">还没有登录任何平台账号，先到「平台账号」扫码登录。</p> : <div className="social-account-picks">
        {(accounts?.accounts || []).map((account) => <label key={account.id} className={usable(account) ? "" : "is-disabled"}>
          <input type="checkbox" disabled={!usable(account)} checked={selectedAccounts.includes(account.id)} onChange={() => setSelectedAccounts(toggle(selectedAccounts, account.id))} />
          <span>{PLATFORM_NAMES[account.platform]} · {account.label}</span>{!usable(account) && <small>{account.status === "active" ? "登录窗口打开中" : "需要重新登录"}</small>}
        </label>)}
      </div>}
    </section>
    <section className="social-publish-block" aria-labelledby="publish-copy">
      <div className="social-publish-head"><h2 id="publish-copy">3. 填内容</h2></div>
      <div className="social-publish-form">
        <label>标题<input value={title} maxLength={60} placeholder="抖音最多 30 字，小红书最多 20 字" onChange={(event) => setTitle(event.target.value)} /></label>
        <label>正文和话题<span className="social-optional">选填</span><textarea rows={3} value={description} maxLength={1000} placeholder="例如：清洁设备怎么选？ #清洁设备 #保洁" onChange={(event) => setDescription(event.target.value)} /></label>
        <fieldset><legend>可见范围</legend>
          <label><input type="radio" name="publish-visibility" checked={visibility === "public"} onChange={() => setVisibility("public")} />公开</label>
          <label><input type="radio" name="publish-visibility" checked={visibility === "private"} onChange={() => setVisibility("private")} />仅自己可见</label>
        </fieldset>
      </div>
      {problems.length > 0 && <p className="social-problems" role="alert">{problems.join("；")}。</p>}
      <button type="button" className="primary-button" disabled={!publishApi || Boolean(pending) || !selectedVideos.length || !selectedAccounts.length || !title.trim() || problems.length > 0} onClick={() => void submit()}><Send size={16} />开始发布</button>
      <p className="social-hint">每个账号一条一条地发，每天最多 10 条。发布时会打开 Chrome 窗口；如果平台要求验证，窗口会跳到前面等你处理。</p>
    </section>
    <section className="social-publish-block" aria-labelledby="publish-jobs">
      <div className="social-publish-head"><h2 id="publish-jobs">发布记录</h2></div>
      {(state?.jobs.length || 0) === 0 ? <p className="social-empty">还没有发布记录。</p> : <ul className="social-jobs">
        {[...(state?.jobs || [])].sort((a, b) => Number(!ATTENTION.has(a.status)) - Number(!ATTENTION.has(b.status))).slice(0, 100).map((job) => <li key={job.id} className={`is-${job.status}`}>
          <div className="social-job-copy">
            <strong>{job.videoName}</strong>
            <span>{PLATFORM_NAMES[job.platform]} · {job.accountLabel} · {job.visibility === "private" ? "仅自己可见" : "公开"}</span>
            {job.reason && <small>{job.reason}</small>}
          </div>
          <span className={`social-job-status is-${job.status}`}>{STATUS[job.status]}{job.step && ["running", "clicked", "needs_user"].includes(job.status) ? ` · ${job.step}` : ""}</span>
          <div className="social-job-actions">
            {job.status === "queued" && <button type="button" className="social-text-button" disabled={Boolean(pending)} onClick={() => publishApi && void run(`cancel-${job.id}`, () => publishApi.cancel(job.id))}><X size={14} />取消</button>}
            {job.status === "failed" && <button type="button" className="social-text-button" disabled={Boolean(pending)} onClick={() => publishApi && void run(`retry-${job.id}`, () => publishApi.retry(job.id))}><RotateCcw size={14} />重新发布</button>}
            {job.status === "unknown" && <>
              <button type="button" className="social-text-button" disabled={Boolean(pending)} onClick={() => publishApi && void run(`yes-${job.id}`, () => publishApi.resolve(job.id, true))}>我核对过：已发出</button>
              <button type="button" className="social-text-button" disabled={Boolean(pending)} onClick={() => publishApi && void run(`no-${job.id}`, () => publishApi.resolve(job.id, false))}>我核对过：没发出</button>
            </>}
            {["published", "failed", "cancelled"].includes(job.status) && <button type="button" className="social-text-button is-danger" aria-label="删除这条记录" disabled={Boolean(pending)} onClick={() => publishApi && void run(`remove-${job.id}`, () => publishApi.remove(job.id))}><Trash2 size={14} /></button>}
          </div>
        </li>)}
      </ul>}
    </section>
  </div>;
}
