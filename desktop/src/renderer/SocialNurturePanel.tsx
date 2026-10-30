import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Check, Pause, Pencil, Play, Plus, Square, Trash2, X, Zap } from "lucide-react";
import type { NurturePlan, NurturePlanInput, NurtureResult, NurtureState } from "./social-nurture-types";
import type { SocialAccountsState } from "./social-accounts-types";
import { PlatformIcon } from "./PlatformIcon";
import "./SocialNurturePanel.css";

type FinishedItem = { finishedVideoId: string; displayName: string; title: string; metadata?: Record<string, unknown>; available: boolean };
type FinishedApi = { finished?: { list: (payload?: { limit?: number }) => Promise<{ ok: boolean; data?: { items: FinishedItem[] } }> } };
const finishedApi = () => (window as unknown as { xiaoxiContent?: FinishedApi }).xiaoxiContent?.finished;
const GENERATED_ID = /^generated_video_[a-f0-9]{32}$/i;
const coverOf = (item: FinishedItem) => { const id = item.metadata?.generated_video_id; return typeof id === "string" && GENERATED_ID.test(id) ? `xiaoxi-content://generated/${id}/thumbnail` : ""; };

const DAYS = [{ day: 1, name: "冷启动" }, { day: 2, name: "打标签" }, { day: 3, name: "打标签" }, { day: 4, name: "加评论" }, { day: 5, name: "加评论" }, { day: 6, name: "强化" }, { day: 7, name: "强化" }, { day: 8, name: "发视频" }];
const SUGGESTED = ["洗地机", "扫地车", "商用清洁设备", "清洁机器人", "驾驶式洗地机", "物业保洁"];
const DEFAULT_COMMENTS = ["讲得很清楚", "这台设备效率不错", "学到了，感谢分享"];
// Same rule as the main process: contact details or ad wording get comments hidden.
const CONTACT = /\d{6,}|微信|v信|vx|wx|加我|私信|电话|手机|联系|http|www\.|\.com|二维码|扫码|链接/i;
const time = (value: number | string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
const stamp = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日 ${time(value)}`; };

function phaseText(plan: NurturePlan) {
  const today = plan.today;
  switch (plan.phase) {
    case "opening": return { text: "正在打开 Chrome", live: true };
    case "searching": return { text: "正在搜索行业关键词", live: true };
    case "watching": return { text: `正在刷视频 · 第 ${(today?.segmentsDone || 0) + 1} 段`, live: true };
    case "resting": return { text: `段间休息，约 ${time(today?.nextAt || 0)} 跑下一段`, live: false };
    case "starting": return { text: "马上开始下一段", live: false };
    case "done_today": return { text: `今天的 ${today?.segments || 0} 段已做完，明天打开软件会自动继续`, live: false };
    case "rest_today": return { text: "今天出现两次验证，为了账号安全停到明天", live: false, warn: true };
    case "paused": return { text: plan.reason || "已暂停", live: false, warn: true };
    case "finished": return { text: "8 天养号已完成", live: false };
    case "off": return { text: "已关闭，不会自动运行", live: false };
    default: return { text: "", live: false };
  }
}

function TagInput({ values, onChange, placeholder, max = 20 }: { values: string[]; onChange: (next: string[]) => void; placeholder: string; max?: number }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw.split(/[,，、\n]+/).map((part) => part.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...values, ...parts])].slice(0, max));
    setDraft("");
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === "，") { event.preventDefault(); add(draft); }
    else if (event.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
  };
  return <div className="nur-tags" onClick={(event) => (event.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
    {values.map((value) => <span key={value} className="nur-tag">{value}<button type="button" aria-label={`去掉 ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}><X size={14} /></button></span>)}
    <input value={draft} placeholder={values.length ? "" : placeholder} onChange={(event) => { if (/[,，、]/.test(event.target.value)) add(event.target.value); else setDraft(event.target.value); }} onKeyDown={onKey} onBlur={() => draft && add(draft)} />
  </div>;
}

// 养号：每个账号一张进度卡（8 天时间轴、今天的数量、正在做什么、上一段为什么结束），
// 新建用三步向导。点「开始养号」立刻跑第一段，之后软件开着就自动接着跑。
export function SocialNurturePanel({ onManageAccounts }: { onManageAccounts: () => void }) {
  const api = window.xiaoxiSocialNurture, accountsApi = window.xiaoxiSocialAccounts;
  const [state, setState] = useState<NurtureState>();
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  const [videos, setVideos] = useState<FinishedItem[]>([]);
  const [wizard, setWizard] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [comments, setComments] = useState<string[]>(DEFAULT_COMMENTS);
  const [newComment, setNewComment] = useState("");
  const [testVideo, setTestVideo] = useState<NurturePlanInput["testVideo"]>(null);
  const [showAllLog, setShowAllLog] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!api || !accountsApi) { setError("养号服务尚未连接，请重新打开桌面应用。"); return; }
    let active = true;
    const off = [api.onUpdate((next) => { if (active) setState(next); }), accountsApi.onUpdate((next) => { if (active) setAccounts(next); })];
    void api.status().then((result) => { if (!active) return; if (result.state) setState(result.state); if (!result.ok) setError(result.error || "养号记录读取失败。"); });
    void accountsApi.status().then((result) => { if (active && result.state) setAccounts(result.state); });
    void finishedApi()?.list({ limit: 48 }).then((result) => { if (active && result.ok) setVideos((result.data?.items || []).filter((item) => item.available)); }).catch(() => undefined);
    // Phase texts such as "约 14:20 跑下一段" stay current without a state change.
    const clock = window.setInterval(() => { if (active) setState((current) => current && { ...current }); }, 30_000);
    return () => { active = false; off.forEach((stop) => stop()); window.clearInterval(clock); };
  }, [api, accountsApi]);

  const plans = state?.plans || [];
  const taken = new Set(plans.filter((plan) => plan.status !== "finished" && plan.id !== editingId).map((plan) => plan.accountId));
  const douyin = (accounts?.accounts || []).filter((account) => account.platform === "douyin" && account.status === "active");
  const free = douyin.filter((account) => !taken.has(account.id));
  const showWizard = wizard || (state !== undefined && plans.length === 0);
  const badComment = comments.find((text) => CONTACT.test(text));
  const ready = Boolean(accountId) && keywords.length > 0 && comments.length > 0 && !badComment && (!testVideo || Boolean(testVideo.title.trim()));
  const log = useMemo(() => (state?.log || []).slice(0, showAllLog ? 120 : 20), [state, showAllLog]);

  const run = async (key: string, operation: () => Promise<NurtureResult>, success = "") => {
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
  const openWizard = (plan?: NurturePlan) => {
    setEditingId(plan?.id || ""); setAccountId(plan?.accountId || free[0]?.id || "");
    setKeywords(plan?.keywords || []); setComments(plan?.comments || DEFAULT_COMMENTS); setTestVideo(plan?.testVideo || null); setNewComment("");
    setWizard(true); setError(""); setNotice("");
  };
  const submit = async () => {
    if (!api || !ready) return;
    const ok = await run("save", () => api.savePlan({ id: editingId || undefined, accountId, keywords: keywords.join("\n"), comments: comments.join("\n"), testVideo }),
      editingId ? "计划已保存。" : "已开始养号：Chrome 窗口会弹出来刷抖音，请不要在那个窗口里操作。软件开着时会自动接着跑。");
    if (ok) { setWizard(false); setEditingId(""); }
  };
  const addComment = () => { const text = newComment.trim(); if (text) setComments([...new Set([...comments, text])].slice(0, 30)); setNewComment(""); };

  return <div className="nur">
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}

    {plans.map((plan) => {
      const phase = phaseText(plan), today = plan.today, running = state?.running === plan.id;
      const stats = [["看了", today?.counts.watched ?? 0, ""], ["点赞", today?.counts.likes ?? 0, today?.targets.likes ?? 0], ["关注", today?.counts.follows ?? 0, today?.targets.follows ?? 0], ["评论", today?.counts.comments ?? 0, today?.targets.comments ?? 0]] as const;
      return <section key={plan.id} className={`nur-plan ${phase.live ? "is-live" : ""}`} aria-label={`${plan.accountLabel} 的养号`}>
        <div className="nur-plan-head">
          <PlatformIcon platform="douyin" size={56} />
          <div className="nur-plan-who">
            <h2>{plan.accountLabel}</h2>
            <p className={`nur-phase ${phase.warn ? "is-warn" : ""}`}>{phase.live && <i aria-hidden="true" />}{phase.text}</p>
          </div>
          <div className="nur-plan-actions">
            {running && <button type="button" className="nur-btn" disabled={Boolean(pending)} onClick={() => api && void run("stop", () => api.stop(), "这一段已停下，稍后会按计划继续。")}><Square size={16} />停下这段</button>}
            {!running && plan.status !== "finished" && <button type="button" className="nur-btn is-go" disabled={Boolean(pending) || Boolean(state?.running)} onClick={() => api && void run(`now-${plan.id}`, () => api.runNow(plan.id), "已开始养号，Chrome 窗口会弹出来，请不要在那个窗口里操作。")}><Zap size={16} />现在就跑</button>}
            {plan.status !== "finished" && (plan.enabled && plan.status === "active"
              ? <button type="button" className="nur-btn" disabled={Boolean(pending)} onClick={() => api && void run(`off-${plan.id}`, () => api.setEnabled(plan.id, false), "已关闭，不会再自动运行。")}><Pause size={16} />关闭</button>
              : <button type="button" className="nur-btn is-go" disabled={Boolean(pending)} onClick={() => api && void run(`on-${plan.id}`, () => api.setEnabled(plan.id, true), "已打开，马上接着跑。")}><Play size={16} />{plan.status === "paused" ? "继续" : "打开"}</button>)}
            <button type="button" className="nur-icon" aria-label="编辑计划" disabled={running} onClick={() => openWizard(plan)}><Pencil size={17} /></button>
            <button type="button" className="nur-icon" aria-label="删除计划" disabled={running || Boolean(pending)} onClick={() => api && window.confirm(`删除「${plan.accountLabel}」的养号计划？进度不会保留。`) && void run(`rm-${plan.id}`, () => api.removePlan(plan.id))}><Trash2 size={17} /></button>
          </div>
        </div>
        <ol className="nur-days" aria-label="8 天进度">
          {DAYS.map(({ day, name }) => <li key={day} className={plan.status === "finished" || day < plan.day ? "is-done" : day === plan.day ? "is-now" : ""}><b>{day < plan.day || plan.status === "finished" ? <Check size={18} /> : day}</b><span>第 {day} 天</span><small>{name}</small></li>)}
        </ol>
        <div className="nur-stats">
          {stats.map(([label, value, target]) => <div key={label}><span>{label}</span><b>{value}{target !== "" && <small>/{target}</small>}</b></div>)}
          <div><span>今天进度</span><b>{today?.segmentsDone ?? 0}<small>/{today?.segments ?? 0} 段</small></b></div>
        </div>
        {plan.lastSegment && <p className={`nur-last is-${plan.lastSegment.outcome}`}>上一段 {stamp(plan.lastSegment.endedAt)} 结束：{plan.lastSegment.text}</p>}
        <p className="nur-meta">关键词：{plan.keywords.join("、")}{plan.mode === "feed" ? " · 抖音不让搜索，已改为刷推荐页、只和带关键词的视频互动" : ""}{plan.testVideo ? ` · 第 8 天发「${plan.testVideo.title}」` : ""}{plan.publishResult ? ` · ${plan.publishResult}` : ""}</p>
      </section>;
    })}

    {!showWizard && <button type="button" className="nur-new" disabled={!free.length} onClick={() => openWizard()}><Plus size={20} />{free.length ? "再养一个抖音号" : "所有已登录的抖音号都在养了"}</button>}

    {showWizard && <section className="nur-wizard" aria-label={editingId ? "编辑养号计划" : "新建养号计划"}>
      <header><h2>{editingId ? "编辑养号计划" : "新号先养 8 天，再稳定发视频"}</h2>
        <p>第 1 天只刷推荐，第 2–7 天搜行业词、逐步加点赞关注评论，第 8 天发一条测试视频。每天 2–3 段，每段 15–25 分钟。</p>
        {plans.length > 0 && <button type="button" className="nur-close" aria-label="收起" onClick={() => { setWizard(false); setEditingId(""); }}><X size={20} /></button>}</header>

      <div className="nur-step"><h3><em>1</em>选一个抖音号</h3>
        {douyin.length === 0 ? <div className="nur-empty"><p>还没有已登录的抖音号。</p><button type="button" className="nur-btn is-go" onClick={onManageAccounts}>去「平台账号」扫码登录</button></div>
          : <div className="nur-accounts">{douyin.map((account) => { const busy = taken.has(account.id) && account.id !== accountId;
            return <button type="button" key={account.id} className={`nur-account ${accountId === account.id ? "is-on" : ""}`} disabled={busy || Boolean(editingId)} aria-pressed={accountId === account.id} onClick={() => setAccountId(account.id)}>
              <PlatformIcon platform="douyin" size={44} /><span><b>{account.label}</b><small>{busy ? "已经在养了" : "已登录"}</small></span><i aria-hidden="true" /></button>; })}</div>}
      </div>

      <div className="nur-step"><h3><em>2</em>行业关键词</h3>
        <p className="nur-help">抖音会根据你搜的词给账号打标签。输入后按回车，可以填多个，每次随机用一个。</p>
        <TagInput values={keywords} onChange={setKeywords} placeholder="例如：洗地机，按回车添加" />
        <div className="nur-suggest">{SUGGESTED.filter((word) => !keywords.includes(word)).map((word) => <button type="button" key={word} onClick={() => setKeywords([...keywords, word].slice(0, 20))}><Plus size={14} />{word}</button>)}</div>
      </div>

      <div className="nur-step"><h3><em>3</em>评论话术</h3>
        <p className="nur-help">第 4 天起会在同行视频下评论，每次随机挑一条。只写普通互动的话，<b>不要写电话、微信、链接</b>，平台会当广告隐藏。</p>
        <ul className="nur-comments">{comments.map((text) => <li key={text} className={CONTACT.test(text) ? "is-bad" : ""}><span>{text}</span>{CONTACT.test(text) && <small>有联系方式或广告字样，请删掉</small>}
          <button type="button" aria-label={`删除 ${text}`} onClick={() => setComments(comments.filter((item) => item !== text))}><X size={16} /></button></li>)}</ul>
        <div className="nur-add"><input value={newComment} maxLength={40} placeholder="再写一条，例如：这个效果真不错" onChange={(event) => setNewComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addComment(); } }} />
          <button type="button" className="nur-btn" disabled={!newComment.trim()} onClick={addComment}><Plus size={16} />添加</button></div>
      </div>

      <div className="nur-step"><h3><em>4</em>第 8 天发哪条视频<span className="social-optional">选填</span></h3>
        <div className="nur-videos">
          <button type="button" className={`nur-video is-none ${!testVideo ? "is-on" : ""}`} onClick={() => setTestVideo(null)}><span>不发</span><small>只养号</small></button>
          {videos.slice(0, 11).map((item) => { const on = testVideo?.finishedVideoId === item.finishedVideoId, cover = coverOf(item);
            return <button type="button" key={item.finishedVideoId} className={`nur-video ${on ? "is-on" : ""}`} onClick={() => setTestVideo({ finishedVideoId: item.finishedVideoId, name: item.title || item.displayName, title: (item.title || "").slice(0, 30) })}>
              {cover ? <img src={cover} alt="" /> : <span className="nur-video-blank" />}<small>{item.title || item.displayName}</small><i aria-hidden="true" /></button>; })}
        </div>
        {testVideo && <label className="nur-title">发布标题<input value={testVideo.title} maxLength={30} placeholder="30 字以内" onChange={(event) => setTestVideo({ ...testVideo, title: event.target.value })} /></label>}
      </div>

      <footer>
        <p>点开始后会弹出 Chrome 窗口刷抖音，请不要在那个窗口里操作。抖音弹验证码时窗口会跳到前面，请你完成验证；一天出现两次就停到第二天。</p>
        <button type="button" className="ns-go" disabled={!ready || Boolean(pending) || !api} onClick={() => void submit()}><Play size={22} />{editingId ? "保存" : "开始养号"}</button>
      </footer>
    </section>}

    {(state?.log.length || 0) > 0 && <section className="nur-log" aria-labelledby="nur-log-title">
      <h2 id="nur-log-title">养号记录</h2>
      <ol>{log.map((entry, index) => <li key={`${entry.at}-${index}`}><time>{stamp(entry.at)}</time><span>{plans.find((plan) => plan.id === entry.planId)?.accountLabel || ""}</span><p>{entry.text}</p></li>)}</ol>
      {(state?.log.length || 0) > 20 && <button type="button" className="social-text-button" onClick={() => setShowAllLog(!showAllLog)}>{showAllLog ? "收起" : "看更多"}</button>}
    </section>}
  </div>;
}
