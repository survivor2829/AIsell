import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Globe2, Lock, RefreshCw, RotateCcw, Send, Sparkles, Trash2, X } from "lucide-react";
import type { SocialAccount, SocialAccountsState, SocialPlatformKey } from "./social-accounts-types";
import type { SocialPublishJob, SocialPublishResult, SocialPublishState } from "./social-publish-types";
import { PlatformIcon, PLATFORM_NAMES } from "./PlatformIcon";
import "./SocialPublishPanel.css";

type FinishedItem = { finishedVideoId: string; displayName: string; title: string; metadata: Record<string, unknown>; createdAt: string; available: boolean };
type FinishedApi = { finished?: { list: (payload?: { limit?: number }) => Promise<{ ok: boolean; data?: { items: FinishedItem[] } }> } };
const finishedApi = () => (window as unknown as { xiaoxiContent?: FinishedApi }).xiaoxiContent?.finished;

const PLATFORM_ORDER: SocialPlatformKey[] = ["douyin", "kuaishou", "xiaohongshu", "channels"];
const TITLE_LIMITS: Partial<Record<SocialPlatformKey, number>> = { douyin: 30, xiaohongshu: 20 };
const STATUS: Record<SocialPublishJob["status"], string> = { queued: "排队中", running: "进行中", needs_user: "等你验证", clicked: "等待平台结果", published: "已发出", unknown: "结果不明", failed: "没有发出", cancelled: "已取消" };
// Records that still need the user or are still running are listed first, so none is hidden by older ones.
const ATTENTION = new Set<SocialPublishJob["status"]>(["unknown", "needs_user", "running", "clicked", "queued"]);
const GENERATED_ID = /^generated_video_[a-f0-9]{32}$/i;
const generatedThumb = (item: FinishedItem) => { const id = item.metadata?.generated_video_id; return typeof id === "string" && GENERATED_ID.test(id) ? `xiaoxi-content://generated/${id}/thumbnail` : ""; };
const videoName = (item: FinishedItem) => item.title || item.displayName;
const videoContext = (item: FinishedItem) => typeof item.metadata?.batch_title === "string" ? String(item.metadata.batch_title) : "";
const topicText = (topics: string[]) => topics.map((topic) => `#${topic}`).join(" ");
const parseTopics = (value: string) => [...new Set(value.split(/[\s,，#]+/).map((topic) => topic.trim()).filter(Boolean))].slice(0, 8);

export function SocialPublishPanel({ onManageAccounts }: { onManageAccounts: () => void }) {
  const publishApi = window.xiaoxiSocialPublish;
  const accountsApi = window.xiaoxiSocialAccounts;
  const [videos, setVideos] = useState<FinishedItem[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  const [state, setState] = useState<SocialPublishState>();
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [topics, setTopics] = useState("");
  const [hint, setHint] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [pending, setPending] = useState("");
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const autoWritten = useRef("");

  const loadVideos = async () => {
    const api = finishedApi();
    if (!api) { setError("成片中心暂时无法读取，请重新打开软件。"); return; }
    const result = await api.list({ limit: 200 }).catch(() => null);
    if (!result?.ok) { setError("成片读取失败，请稍后刷新。"); return; }
    const items = (result.data?.items || []).filter((item) => item.available);
    setVideos(items);
    // Videos without a generated thumbnail (for example ones imported from disk) get a frame from the file.
    const missing = items.slice(0, 48).filter((item) => !generatedThumb(item)).map((item) => item.finishedVideoId);
    if (missing.length && publishApi) {
      for (let index = 0; index < missing.length; index += 24) {
        const batch = await publishApi.covers(missing.slice(index, index + 24)).catch(() => null);
        if (batch?.ok && batch.state) setCovers((current) => ({ ...current, ...batch.state }));
      }
    }
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

  const chosenVideos = useMemo(() => videos.filter((item) => selectedVideos.includes(item.finishedVideoId)), [videos, selectedVideos]);
  const chosenAccounts = useMemo(() => (accounts?.accounts || []).filter((account) => selectedAccounts.includes(account.id)), [accounts, selectedAccounts]);
  const fullDescription = [description.trim(), topicText(parseTopics(topics))].filter(Boolean).join(" ");
  const problems = useMemo(() => {
    const list: string[] = [];
    for (const account of chosenAccounts) {
      const limit = TITLE_LIMITS[account.platform];
      if (limit && title.trim().length > limit) list.push(`${PLATFORM_NAMES[account.platform]}标题最多 ${limit} 个字`);
      if (visibility === "private" && account.platform === "channels") list.push("视频号发表时不能设为仅自己可见");
    }
    return [...new Set(list)];
  }, [chosenAccounts, title, visibility]);

  const writeCopy = async (auto = false) => {
    if (!publishApi || !chosenVideos.length) return;
    setWriting(true); if (!auto) { setError(""); setNotice(""); }
    try {
      const result = await publishApi.suggest({ hint, videos: chosenVideos.map((item) => ({ title: item.title, name: item.displayName, context: videoContext(item) })) });
      if (!result.ok || !result.state) { if (!auto) setError(result.error || "AI 写文案暂时不可用，请自己填写。"); return; }
      setTitle(result.state.title); setDescription(result.state.description); setTopics(result.state.topics.join(" "));
      setNotice("AI 已写好标题、正文和话题，可以直接改。");
    } catch { if (!auto) setError("AI 写文案暂时不可用，请自己填写。"); }
    finally { setWriting(false); }
  };
  // Picking a video with empty copy fields drafts the copy automatically, once per selection.
  useEffect(() => {
    const key = selectedVideos.join(",");
    if (!key || title.trim() || description.trim() || autoWritten.current === key) return;
    autoWritten.current = key;
    void writeCopy(true);
  }, [selectedVideos]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Publishing is visible to followers at once; say exactly where it goes before anything starts.
    const targets = chosenAccounts.map((account) => `${PLATFORM_NAMES[account.platform]} · ${account.label}`).join("\n");
    const scope = visibility === "public" ? "公开发布（所有人可见）" : "仅自己可见";
    if (!window.confirm(`确认发布 ${chosenVideos.length} 条视频，${scope}，发到这些账号？\n\n${targets}\n\n标题：${title.trim()}`)) return;
    const ok = await run("submit", async () => {
      const result = await publishApi.submit({ videos: chosenVideos.map((item) => ({ finishedVideoId: item.finishedVideoId, name: videoName(item) })), accountIds: selectedAccounts, title, description: fullDescription, visibility });
      if (result.ok && result.state) {
        const skipped = result.state.skipped || [];
        setNotice(`已加入发布队列 ${result.state.created || 0} 条。${skipped.length ? `已跳过 ${skipped.length} 条重复发布。` : ""}发布时会自动打开 Chrome 窗口，请不要在窗口里打字。`);
      }
      return result;
    });
    if (ok) { setSelectedVideos([]); autoWritten.current = ""; }
  };

  const usable = (account: SocialAccount) => account.status === "active" && !account.loggingIn;
  const coverOf = (item: FinishedItem) => generatedThumb(item) || covers[item.finishedVideoId] || "";
  const accountsByPlatform = PLATFORM_ORDER.map((platform) => ({ platform, list: (accounts?.accounts || []).filter((account) => account.platform === platform) }));
  const jobs = [...(state?.jobs || [])].sort((a, b) => Number(!ATTENTION.has(a.status)) - Number(!ATTENTION.has(b.status))).slice(0, 100);
  const canSubmit = Boolean(publishApi) && !pending && !writing && chosenVideos.length > 0 && selectedAccounts.length > 0 && Boolean(title.trim()) && problems.length === 0;

  return <div className="social-publish">
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    <div className="social-publish-layout">
      <section className="social-publish-videos" aria-labelledby="publish-videos">
        <div className="social-publish-head"><h2 id="publish-videos"><span className="social-step">1</span>选视频<small>已选 {selectedVideos.length}/20</small></h2>
          <button type="button" className="social-text-button" onClick={() => void loadVideos()}><RefreshCw size={14} />刷新</button></div>
        {videos.length === 0 ? <div className="social-publish-empty"><p>成片中心还没有视频。</p><p>做好的视频会自动出现在这里，也可以在「成片中心」里点「登记已有成片」导入。</p></div> : <ul className="social-video-grid">
          {videos.slice(0, 60).map((item) => { const selected = selectedVideos.includes(item.finishedVideoId); const cover = coverOf(item);
            return <li key={item.finishedVideoId}><button type="button" className={`social-video ${selected ? "is-selected" : ""}`} aria-pressed={selected} onClick={() => setSelectedVideos(toggle(selectedVideos, item.finishedVideoId, 20))}>
              {cover ? <img src={cover} alt="" loading="lazy" /> : <span className="social-video-blank" aria-hidden="true" />}
              <span className="social-video-title">{videoName(item)}</span>
              <span className="social-video-check" aria-hidden="true">{selected ? <Check size={15} /> : null}</span>
            </button></li>; })}
        </ul>}
      </section>
      <aside className="social-publish-side">
        <section className="social-publish-card" aria-labelledby="publish-accounts">
          <div className="social-publish-head"><h2 id="publish-accounts"><span className="social-step">2</span>选账号<small>已选 {selectedAccounts.length}</small></h2>
            <button type="button" className="social-text-button" onClick={onManageAccounts}>管理账号</button></div>
          {(accounts?.accounts.length || 0) === 0 ? <p className="social-empty">还没有登录任何平台账号，先到「平台账号」扫码登录。</p> : <div className="social-account-tiles">
            {accountsByPlatform.filter((group) => group.list.length).flatMap((group) => group.list.map((account) => {
              const selected = selectedAccounts.includes(account.id);
              return <button type="button" key={account.id} className={`social-account-tile ${selected ? "is-selected" : ""}`} aria-pressed={selected} disabled={!usable(account)} onClick={() => setSelectedAccounts(toggle(selectedAccounts, account.id))}>
                <PlatformIcon platform={account.platform} size={30} />
                <span><strong>{account.label}</strong><small>{usable(account) ? PLATFORM_NAMES[account.platform] : account.status === "active" ? "登录窗口打开中" : "需要重新登录"}</small></span>
                {selected && <Check size={15} className="social-tile-check" />}
              </button>;
            }))}
          </div>}
        </section>
        <section className="social-publish-card" aria-labelledby="publish-copy">
          <div className="social-publish-head"><h2 id="publish-copy"><span className="social-step">3</span>标题和文案</h2>
            <button type="button" className="social-ai-button" disabled={!chosenVideos.length || writing} onClick={() => void writeCopy()}><Sparkles size={14} />{writing ? "AI 正在写…" : title ? "AI 重写" : "AI 帮我写"}</button></div>
          <div className="social-publish-form">
            <label>标题<input value={title} maxLength={60} placeholder={chosenVideos.length ? "AI 会自动写，也可以自己填" : "先在左边选视频"} onChange={(event) => setTitle(event.target.value)} />
              <small className="social-count">{title.trim().length} 字 · 抖音≤30，小红书≤20</small></label>
            <label>正文<textarea rows={4} value={description} maxLength={800} placeholder="说说视频讲了什么、对谁有用" onChange={(event) => setDescription(event.target.value)} /></label>
            <label>话题<input value={topics} placeholder="用空格分开，例如：清洁设备 保洁" onChange={(event) => setTopics(event.target.value)} /></label>
            {parseTopics(topics).length > 0 && <div className="social-topics">{parseTopics(topics).map((topic) => <span key={topic}>#{topic}</span>)}</div>}
            <label>给 AI 的补充说明<span className="social-optional">选填</span><input value={hint} maxLength={300} placeholder="例如：主推商用洗地机，面向物业" onChange={(event) => setHint(event.target.value)} /></label>
            <div className="social-visibility" role="radiogroup" aria-label="可见范围">
              <button type="button" role="radio" aria-checked={visibility === "public"} className={visibility === "public" ? "is-on" : ""} onClick={() => setVisibility("public")}><Globe2 size={15} />公开</button>
              <button type="button" role="radio" aria-checked={visibility === "private"} className={visibility === "private" ? "is-on" : ""} onClick={() => setVisibility("private")}><Lock size={15} />仅自己可见</button>
            </div>
          </div>
          {problems.length > 0 && <p className="social-problems" role="alert">{problems.join("；")}。</p>}
          <button type="button" className="primary-button social-publish-go" disabled={!canSubmit} onClick={() => void submit()}><Send size={17} />开始发布{chosenVideos.length && selectedAccounts.length ? `（${chosenVideos.length * selectedAccounts.length} 条）` : ""}</button>
          <p className="social-hint">每个账号一条一条地发，每天最多 10 条。发布时会打开 Chrome 窗口；平台要验证时窗口会跳到前面等你处理。</p>
        </section>
      </aside>
    </div>
    <section className="social-publish-card" aria-labelledby="publish-jobs">
      <div className="social-publish-head"><h2 id="publish-jobs">发布记录</h2></div>
      {jobs.length === 0 ? <p className="social-empty">还没有发布记录。</p> : <ul className="social-jobs">
        {jobs.map((job) => <li key={job.id} className={`is-${job.status}`}>
          <PlatformIcon platform={job.platform} size={26} />
          <div className="social-job-copy">
            <strong>{job.title}</strong>
            <span>{job.accountLabel} · {job.videoName} · {job.visibility === "private" ? "仅自己可见" : "公开"}</span>
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
