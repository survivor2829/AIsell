import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Globe2, Lock, RefreshCw, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import type { SocialAccount, SocialAccountsState, SocialPlatformKey } from "./social-accounts-types";
import type { SocialPublishJob, SocialPublishResult, SocialPublishState } from "./social-publish-types";
import { PlatformIcon, PLATFORM_NAMES } from "./PlatformIcon";
import "./SocialPublishPanel.css";

type FinishedItem = { finishedVideoId: string; displayName: string; title: string; metadata: Record<string, unknown>; createdAt: string; available: boolean };
type FinishedApi = { finished?: { list: (payload?: { limit?: number }) => Promise<{ ok: boolean; data?: { items: FinishedItem[] } }>; chooseAndRegister?: () => Promise<{ ok: boolean; message?: string }> } };
const finishedApi = () => (window as unknown as { xiaoxiContent?: FinishedApi }).xiaoxiContent?.finished;

const PLATFORM_ORDER: SocialPlatformKey[] = ["douyin", "kuaishou", "xiaohongshu", "channels"];
const TITLE_LIMITS: Partial<Record<SocialPlatformKey, number>> = { douyin: 30, xiaohongshu: 20 };
const STATUS: Record<SocialPublishJob["status"], string> = { queued: "排队中", running: "进行中", needs_user: "等你验证", clicked: "等待平台结果", published: "已发出", unknown: "结果不明", failed: "没有发出", cancelled: "已取消" };
const ACTIVE = new Set<SocialPublishJob["status"]>(["queued", "running", "clicked", "needs_user"]);
// Records that still need the user or are still running are shown first and never folded away.
const ATTENTION = new Set<SocialPublishJob["status"]>(["unknown", "needs_user", "running", "clicked", "queued"]);
const STEPS = ["上传", "填文案", "点发布", "平台结果", "核对"];
const STEP_OF: Record<string, number> = { 打开平台: 0, 上传视频: 0, 设置封面: 1, 填写内容: 1, 点击发布: 2, 等待平台结果: 3, 等你验证: 3, 核对作品: 4 };
const GENERATED_ID = /^generated_video_[a-f0-9]{32}$/i;
const generatedThumb = (item: FinishedItem) => { const id = item.metadata?.generated_video_id; return typeof id === "string" && GENERATED_ID.test(id) ? `xiaoxi-content://generated/${id}/thumbnail` : ""; };
const videoName = (item: FinishedItem) => item.title || item.displayName;
const videoDate = (item: FinishedItem) => { const date = new Date(item.createdAt); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日`; };
const videoContext = (item: FinishedItem) => typeof item.metadata?.batch_title === "string" ? String(item.metadata.batch_title) : "";
const topicText = (topics: string[]) => topics.map((topic) => `#${topic}`).join(" ");
type Copy = { title: string; description: string; topics: string };
const EMPTY_COPY: Copy = { title: "", description: "", topics: "" };
const STYLE_HINT: Record<SocialPlatformKey, string> = { douyin: "口语、有钩子", kuaishou: "接地气、实在", xiaohongshu: "种草笔记风", channels: "稳重、可信" };
const parseTopics = (value: string) => [...new Set(value.split(/[\s,，#]+/).map((topic) => topic.trim()).filter(Boolean))].slice(0, 8);

// Five step pills for one job: done / current / failed / waiting, read from status and step only.
function stepStates(job: SocialPublishJob): ("done" | "now" | "fail" | "wait" | "")[] {
  if (job.status === "published") return STEPS.map(() => "done");
  if (job.status === "queued" || job.status === "cancelled") return STEPS.map(() => "");
  if (job.status === "unknown") return STEPS.map((_, index) => index < 3 ? "done" : "wait");
  if (job.status === "failed") return STEPS.map((_, index) => job.clickedAt ? (index < 3 ? "done" : "fail") : index === 0 ? "fail" : "");
  const at = STEP_OF[job.step] ?? 0;
  return STEPS.map((_, index) => index < at ? "done" : index === at ? (job.status === "needs_user" ? "wait" : "now") : "");
}

export function SocialPublishPanel({ onManageAccounts }: { onManageAccounts: () => void }) {
  const publishApi = window.xiaoxiSocialPublish;
  const accountsApi = window.xiaoxiSocialAccounts;
  const [videos, setVideos] = useState<FinishedItem[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  const [state, setState] = useState<SocialPublishState>();
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [copies, setCopies] = useState<Partial<Record<SocialPlatformKey, Copy>>>({});
  const [tabPlatform, setTabPlatform] = useState<SocialPlatformKey>("douyin");
  const [hint, setHint] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [pending, setPending] = useState("");
  const [writing, setWriting] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const autoWritten = useRef("");
  const batchIds = useRef<Set<string>>(new Set());

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
  const importVideo = async () => {
    const api = finishedApi();
    if (!api?.chooseAndRegister) { setError("暂时不能导入，请到「成片中心」点「登记已有成片」。"); return; }
    const result = await api.chooseAndRegister().catch(() => null);
    if (result?.ok) { setNotice("视频已导入成片中心。"); await loadVideos(); }
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
  const coverOf = (item: FinishedItem) => generatedThumb(item) || covers[item.finishedVideoId] || "";
  const coverByName = useMemo(() => new Map(videos.map((item) => [videoName(item), coverOf(item)])), [videos, covers]); // eslint-disable-line react-hooks/exhaustive-deps
  // The platforms being published to decide which copies are needed; with no account chosen yet, all four.
  const copyPlatforms = useMemo(() => { const chosen = PLATFORM_ORDER.filter((platform) => chosenAccounts.some((account) => account.platform === platform)); return chosen.length ? chosen : PLATFORM_ORDER; }, [chosenAccounts]);
  const activePlatform = copyPlatforms.includes(tabPlatform) ? tabPlatform : copyPlatforms[0];
  const current = copies[activePlatform] || EMPTY_COPY;
  const setCurrent = (patch: Partial<Copy>) => setCopies((all) => ({ ...all, [activePlatform]: { ...(all[activePlatform] || EMPTY_COPY), ...patch } }));
  const copyOf = (platform: SocialPlatformKey) => copies[platform] || EMPTY_COPY;
  const hasAnyCopy = copyPlatforms.some((platform) => copyOf(platform).title.trim() || copyOf(platform).description.trim());
  const missingTitle = copyPlatforms.filter((platform) => !copyOf(platform).title.trim());
  const previewVideo = chosenVideos[0];
  const previewAccount = chosenAccounts.find((account) => account.platform === activePlatform);
  const syncToOthers = () => setCopies((all) => Object.fromEntries(copyPlatforms.map((platform) => [platform, { ...(all[activePlatform] || EMPTY_COPY) }])) as Partial<Record<SocialPlatformKey, Copy>>);
  const problems = useMemo(() => {
    const list: string[] = [];
    for (const account of chosenAccounts) {
      const limit = TITLE_LIMITS[account.platform];
      if (limit && copyOf(account.platform).title.trim().length > limit) list.push(`${PLATFORM_NAMES[account.platform]}标题最多 ${limit} 个字`);
      if (visibility === "private" && account.platform === "channels") list.push("视频号发表时不能设为仅自己可见");
    }
    return [...new Set(list)];
  }, [chosenAccounts, copies, visibility]); // eslint-disable-line react-hooks/exhaustive-deps

  const jobs = state?.jobs || [];
  const running = jobs.filter((job) => ACTIVE.has(job.status));
  const batch = jobs.filter((job) => batchIds.current.has(job.id));

  const writeCopy = async (auto = false) => {
    if (!publishApi || !chosenVideos.length) return;
    setWriting(true); if (!auto) { setError(""); setNotice(""); }
    try {
      const result = await publishApi.suggest({ hint, platforms: copyPlatforms, videos: chosenVideos.map((item) => ({ title: item.title, name: item.displayName, context: videoContext(item) })) });
      if (!result.ok || !result.state) { if (!auto) setError(result.error || "AI 写文案暂时不可用，请自己填写。"); return; }
      const written = result.state;
      setCopies((all) => ({ ...all, ...Object.fromEntries(Object.entries(written).map(([platform, copy]) => [platform, { title: copy.title, description: copy.description, topics: copy.topics.join(" ") }])) }));
      setNotice(`AI 已按 ${Object.keys(written).map((platform) => PLATFORM_NAMES[platform as SocialPlatformKey]).join("、")} 各写了一套文案，切换上面的平台查看和修改。`);
    } catch { if (!auto) setError("AI 写文案暂时不可用，请自己填写。"); }
    finally { setWriting(false); }
  };
  // Picking a video with empty copy fields drafts the copy automatically, once per selection.
  useEffect(() => {
    const key = selectedVideos.join(",");
    if (!key || hasAnyCopy || autoWritten.current === key) return;
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
    const titles = copyPlatforms.map((platform) => `${PLATFORM_NAMES[platform]}：${copyOf(platform).title.trim()}`).join("\n");
    if (!window.confirm(`确认发布 ${chosenVideos.length} 条视频，${scope}，发到这些账号？\n\n${targets}\n\n各平台标题：\n${titles}`)) return;
    const before = new Set(jobs.map((job) => job.id));
    const ok = await run("submit", async () => {
      const result = await publishApi.submit({ videos: chosenVideos.map((item) => ({ finishedVideoId: item.finishedVideoId, name: videoName(item) })), accountIds: selectedAccounts, visibility,
        title: copyOf(copyPlatforms[0]).title, description: "",
        copies: Object.fromEntries(copyPlatforms.map((platform) => [platform, { title: copyOf(platform).title, description: [copyOf(platform).description.trim(), topicText(parseTopics(copyOf(platform).topics))].filter(Boolean).join(" ") }])) });
      if (result.ok && result.state) {
        batchIds.current = new Set(result.state.jobs.filter((job) => !before.has(job.id)).map((job) => job.id));
        const skipped = result.state.skipped || [];
        setNotice(`已加入发布队列 ${result.state.created || 0} 条。${skipped.length ? `已跳过 ${skipped.length} 条重复发布。` : ""}发布时会自动打开 Chrome 窗口，请不要在窗口里打字。`);
      }
      return result;
    });
    if (ok) { setSelectedVideos([]); autoWritten.current = ""; }
  };

  const usable = (account: SocialAccount) => account.status === "active" && !account.loggingIn;
  const accountsByPlatform = PLATFORM_ORDER.flatMap((platform) => (accounts?.accounts || []).filter((account) => account.platform === platform));
  const sorted = [...jobs].sort((a, b) => Number(!ATTENTION.has(a.status)) - Number(!ATTENTION.has(b.status)));
  const open = sorted.filter((job) => ATTENTION.has(job.status));
  const done = sorted.filter((job) => !ATTENTION.has(job.status)).slice(0, 80);
  const total = chosenVideos.length * selectedAccounts.length;
  const progress = running.length || batch.some((job) => ACTIVE.has(job.status)) ? { sent: batch.filter((job) => job.status === "published").length, all: batch.length || running.length } : null;
  const canSubmit = Boolean(publishApi) && !pending && !writing && total > 0 && missingTitle.length === 0 && problems.length === 0;

  const jobRow = (job: SocialPublishJob) => {
    const cover = coverByName.get(job.videoName);
    return <li key={job.id} className={`dist-job is-${job.status}`}>
      <span className="dist-job-media">{cover ? <img src={cover} alt="" /> : <span />}<PlatformIcon platform={job.platform} size={24} /></span>
      <div className="dist-job-copy">
        <strong>{job.title}</strong>
        <span>{PLATFORM_NAMES[job.platform]} · {job.accountLabel} · {job.visibility === "private" ? "仅自己可见" : "公开"}</span>
        {job.reason && <small>{job.reason}</small>}
      </div>
      <div className="dist-job-track">
        <ol className="dist-steps" aria-label={`进度：${STATUS[job.status]}`}>{stepStates(job).map((value, index) => <li key={STEPS[index]} className={value ? `is-${value}` : ""}><i /><span>{STEPS[index]}</span></li>)}</ol>
        <b className={`dist-job-status is-${job.status}`}>{STATUS[job.status]}</b>
      </div>
      <div className="dist-job-actions">
        {job.status === "queued" && <button type="button" className="social-text-button" disabled={Boolean(pending)} onClick={() => publishApi && void run(`cancel-${job.id}`, () => publishApi.cancel(job.id))}><X size={14} />取消</button>}
        {job.status === "failed" && <button type="button" className="social-text-button" disabled={Boolean(pending)} onClick={() => publishApi && void run(`retry-${job.id}`, () => publishApi.retry(job.id))}><RotateCcw size={14} />重新发布</button>}
        {job.status === "unknown" && <>
          <button type="button" className="dist-check is-yes" disabled={Boolean(pending)} onClick={() => publishApi && void run(`yes-${job.id}`, () => publishApi.resolve(job.id, true))}>我核对过：已发出</button>
          <button type="button" className="dist-check" disabled={Boolean(pending)} onClick={() => publishApi && void run(`no-${job.id}`, () => publishApi.resolve(job.id, false))}>我核对过：没发出</button>
        </>}
        {["published", "failed", "cancelled"].includes(job.status) && <button type="button" className="social-text-button is-danger" aria-label="删除这条记录" disabled={Boolean(pending)} onClick={() => publishApi && void run(`remove-${job.id}`, () => publishApi.remove(job.id))}><Trash2 size={14} /></button>}
      </div>
    </li>;
  };

  return <div className="social-publish dist-publish">
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}

    <div className="dist-grid">
      <section className="dist-videos" aria-labelledby="publish-videos">
        <div className="dist-sec"><h2 id="publish-videos"><em>第 1 步</em>选视频</h2><span>已选 {selectedVideos.length}/20</span>
          <button type="button" className="social-text-button" onClick={() => void loadVideos()}><RefreshCw size={14} />刷新</button></div>
        <ul className="dist-video-rows">
          {videos.slice(0, 60).map((item, index) => { const selected = selectedVideos.includes(item.finishedVideoId); const cover = coverOf(item);
            return <li key={item.finishedVideoId} style={{ "--i": Math.min(index, 20) } as CSSProperties}><button type="button" className={`dist-video-row ${selected ? "is-on" : ""}`} aria-pressed={selected} onClick={() => setSelectedVideos(toggle(selectedVideos, item.finishedVideoId, 20))}>
              {cover ? <img src={cover} alt="" loading="lazy" /> : <span className="dist-video-blank" aria-hidden="true" />}
              <span className="dist-video-meta"><b>{videoName(item)}</b><small>{videoDate(item) ? `${videoDate(item)} · ` : ""}来自成片中心</small></span>
              <span className="ns-pick" aria-hidden="true" />
            </button></li>; })}
          <li><button type="button" className="dist-video-row is-import" onClick={() => void importVideo()}>
            <span className="dist-import-plus" aria-hidden="true">+</span>
            <span className="dist-video-meta"><b>导入已有成片</b><small>从电脑里选视频文件，加入成片中心</small></span>
          </button></li>
        </ul>
        <div className="dist-preview">
          <div className="dist-preview-head"><b>发布预览</b><span>{PLATFORM_NAMES[activePlatform]}上大致的样子 · 右边切换平台</span></div>
          <div className={`dist-phone is-${activePlatform}`}>
            {previewVideo && coverOf(previewVideo) ? <>
              {landscape && <img className="dist-phone-backdrop" src={coverOf(previewVideo)} alt="" aria-hidden="true" />}
              <img className={landscape ? "dist-phone-landscape" : ""} src={coverOf(previewVideo)} alt="" onLoad={(event) => setLandscape(event.currentTarget.naturalWidth > event.currentTarget.naturalHeight)} />
            </> : <span className="dist-phone-blank" />}
            {!previewVideo && <p className="dist-phone-empty">选一条视频，<br />这里预览它发出去的样子</p>}
            <div className="dist-phone-top"><PlatformIcon platform={activePlatform} size={22} /><span>{PLATFORM_NAMES[activePlatform]}</span></div>
            {previewVideo && <div className="dist-phone-copy">
              <b className="dist-phone-account">@{previewAccount?.label || `${PLATFORM_NAMES[activePlatform]}账号`}</b>
              <strong>{current.title.trim() || "标题会显示在这里"}</strong>
              {current.description.trim() && <p>{current.description.trim()}</p>}
              {parseTopics(current.topics).length > 0 && <span className="dist-phone-topics">{parseTopics(current.topics).map((topic) => `#${topic}`).join("  ")}</span>}
            </div>}
          </div>
          <ul className="dist-preview-facts">
            <li><b>{chosenVideos.length}</b><span>条视频</span></li>
            <li><b>{selectedAccounts.length}</b><span>个账号</span></li>
            <li><b>{total}</b><span>条待发</span></li>
            <li><b>{visibility === "public" ? "公开" : "仅自己"}</b><span>可见范围</span></li>
          </ul>
        </div>
      </section>

      <aside className="dist-side">
        <section className="dist-card" aria-labelledby="publish-accounts">
          <div className="dist-sec"><h2 id="publish-accounts"><em>第 2 步</em>选账号</h2><span>已选 {selectedAccounts.length}</span>
            <button type="button" className="social-text-button" onClick={onManageAccounts}>管理账号</button></div>
          {accountsByPlatform.length === 0 ? <p className="social-empty">还没有登录任何平台账号，先到「平台账号」扫码登录。</p> : <div className="dist-accounts">
            {accountsByPlatform.map((account) => {
              const selected = selectedAccounts.includes(account.id);
              return <button type="button" key={account.id} className={`dist-account ${selected ? "is-on" : ""}`} aria-pressed={selected} disabled={!usable(account)} onClick={() => {
                  setSelectedAccounts(toggle(selectedAccounts, account.id));
                  if (!selected && account.uploadTroubleAt) { setError(""); setNotice(`「${account.label}」上次上传异常（账号或网络问题），这次可能还会失败；发成功后会自动去掉这个提醒。`); }
                }}>
                <PlatformIcon platform={account.platform} size={36} />
                <span><b>{PLATFORM_NAMES[account.platform]}</b><small>{usable(account) ? account.label : account.status === "active" ? "登录窗口打开中" : "需要重新登录"}</small>
                  {account.uploadTroubleAt && <small className="dist-account-trouble">上次上传异常</small>}</span>
                <span className="ns-pick" aria-hidden="true" />
              </button>;
            })}
          </div>}
        </section>

        <section className={`dist-card ${writing ? "is-writing" : ""}`} aria-labelledby="publish-copy">
          <div className="dist-sec"><h2 id="publish-copy"><em>第 3 步</em>写文案</h2>
            <button type="button" className="social-ai-button" disabled={!chosenVideos.length || writing} onClick={() => void writeCopy()}><Sparkles size={14} />{writing ? "AI 正在写…" : hasAnyCopy ? "AI 重写" : "AI 帮我写"}</button></div>
          <div className="dist-copy-tabs" role="tablist" aria-label="按平台编辑文案">
            {copyPlatforms.map((platform) => <button type="button" role="tab" key={platform} aria-selected={platform === activePlatform} className={platform === activePlatform ? "is-on" : ""} onClick={() => setTabPlatform(platform)}>
              <PlatformIcon platform={platform} size={22} /><span>{PLATFORM_NAMES[platform]}</span>{!copyOf(platform).title.trim() && <i aria-label="还没写" />}
            </button>)}
          </div>
          <p className="dist-copy-style">{PLATFORM_NAMES[activePlatform]}风格：{STYLE_HINT[activePlatform]}{copyPlatforms.length > 1 && <button type="button" className="social-text-button" disabled={!current.title.trim()} onClick={syncToOthers}>同步到其他平台</button>}</p>
          <div className="dist-form">
            <label>标题<input value={current.title} maxLength={60} placeholder={chosenVideos.length ? "AI 会自动写，也可以自己填" : "先选视频"} onChange={(event) => setCurrent({ title: event.target.value })} />
              <small>{current.title.trim().length} 字{TITLE_LIMITS[activePlatform] ? ` · ${PLATFORM_NAMES[activePlatform]}最多 ${TITLE_LIMITS[activePlatform]} 字` : ""}</small></label>
            <label>正文<textarea rows={5} value={current.description} maxLength={800} placeholder="说说视频讲了什么、对谁有用" onChange={(event) => setCurrent({ description: event.target.value })} /></label>
            <label>话题<input value={current.topics} placeholder="用空格分开，例如：清洁设备 保洁" onChange={(event) => setCurrent({ topics: event.target.value })} /></label>
            {parseTopics(current.topics).length > 0 && <div className="dist-topics">{parseTopics(current.topics).map((topic) => <span key={topic}>#{topic}</span>)}</div>}
            <label>给 AI 的补充说明<span className="social-optional">选填</span><input value={hint} maxLength={300} placeholder="例如：主推商用洗地机，面向物业" onChange={(event) => setHint(event.target.value)} /></label>
            <div className="dist-visibility" role="radiogroup" aria-label="可见范围">
              <button type="button" role="radio" aria-checked={visibility === "public"} className={visibility === "public" ? "is-on" : ""} onClick={() => setVisibility("public")}><Globe2 size={15} />公开</button>
              <button type="button" role="radio" aria-checked={visibility === "private"} className={visibility === "private" ? "is-on" : ""} onClick={() => setVisibility("private")}><Lock size={15} />仅自己可见</button>
            </div>
            {visibility === "public" && <p className="dist-public-note">公开发布：所有人都能看到，粉丝会刷到。</p>}
          </div>
          {problems.length > 0 && <p className="social-problems" role="alert">{problems.join("；")}。</p>}
          {total > 0 && missingTitle.length > 0 && <p className="social-problems">还没写标题：{missingTitle.map((platform) => PLATFORM_NAMES[platform]).join("、")}。</p>}
        </section>
      </aside>
    </div>

    <section className="dist-board" aria-labelledby="publish-jobs">
      <div className="dist-sec"><h2 id="publish-jobs"><em>进度</em>发布记录</h2><span>{open.length ? `${open.length} 条进行中或待处理` : "没有进行中的发布"}</span></div>
      {open.length === 0 && done.length === 0 ? <p className="social-empty">还没有发布记录。</p> : <>
        {open.length > 0 && <ul className="dist-jobs">{open.map(jobRow)}</ul>}
        {done.length > 0 && <>
          <button type="button" className="dist-fold" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}><ChevronDown size={16} />已完成 {done.length} 条</button>
          {showDone && <ul className="dist-jobs">{done.map(jobRow)}</ul>}
        </>}
      </>}
    </section>

    <div className="ns-bar dist-bar">
      <div className="ns-bar-in">
        <div className="ns-sel">
          {total ? <>已选 {chosenVideos.length} 条视频 × {selectedAccounts.length} 个账号 = <em className="dist-total">{total} 条</em></> : "选好视频和账号，就可以一键发布"}
          <small>
            <span className="dist-bar-icons">{[...new Set(chosenAccounts.map((account) => account.platform))].map((platform) => <PlatformIcon key={platform} platform={platform} size={20} />)}</span>
            {visibility === "public" ? "公开发布" : "仅自己可见"}{progress ? ` · 本轮已发出 ${progress.sent}/${progress.all}` : ""}
          </small>
          {progress && <span className="ns-progress"><i style={{ width: `${progress.all ? Math.round(progress.sent / progress.all * 100) : 0}%` }} /></span>}
        </div>
        <button type="button" className="ns-go" disabled={!canSubmit} onClick={() => void submit()}>开始发布</button>
      </div>
    </div>
  </div>;
}
