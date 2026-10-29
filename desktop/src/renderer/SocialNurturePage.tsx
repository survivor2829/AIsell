import { useEffect, useState } from "react";
import { Check, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import type { NurturePlan, NurturePlanInput, NurtureResult, NurtureState } from "./social-nurture-types";
import type { SocialAccountsState } from "./social-accounts-types";
import { PlatformIcon } from "./PlatformIcon";
import "./SocialAccountsPanel.css";
import "./AcquisitionPage.css";

type FinishedItem = { finishedVideoId: string; displayName: string; title: string; available: boolean };
type FinishedApi = { finished?: { list: (payload?: { limit?: number }) => Promise<{ ok: boolean; data?: { items: FinishedItem[] } }> } };
const finishedApi = () => (window as unknown as { xiaoxiContent?: FinishedApi }).xiaoxiContent?.finished;
const STAGES = ["第 1 天 冷启动：只刷推荐，不互动", "第 2–3 天 打标签：搜关键词，点赞、关注", "第 4–5 天 加评论", "第 6–7 天 强化：互动更多", "第 8 天 发测试视频"];
const emptyPlan = (accountId = ""): NurturePlanInput => ({ accountId, keywords: "", comments: "讲得很清楚\n这台设备效率不错\n学到了", startTime: "09:30", testVideo: null });
const clock = (value: string | number) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
const statusLine = (plan: NurturePlan, running: boolean) => {
  if (plan.status === "finished") return "8 天已完成";
  if (plan.status === "paused") return plan.reason || "已暂停";
  if (!plan.enabled) return "已关闭";
  if (running) return "正在养号";
  if (plan.today?.restUntil && plan.today.restUntil > Date.now()) return "今天出现了验证，停到明天";
  if (plan.today && plan.today.segmentsDone >= plan.today.segments) return "今天的已做完";
  return `等待中，每天 ${plan.startTime} 开始`;
};

// 养号：照谷小智的 8 天阶段表，每天在设定时间之后分几段在 Chrome 里刷抖音；
// 只有软件开着时才跑。遇到验证码会停下并把窗口弹到前面，一天出现两次就停到明天。
export function SocialNurturePage() {
  const api = window.xiaoxiSocialNurture, accountsApi = window.xiaoxiSocialAccounts;
  const [state, setState] = useState<NurtureState>();
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  const [videos, setVideos] = useState<FinishedItem[]>([]);
  const [form, setForm] = useState<NurturePlanInput>(emptyPlan());
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!api || !accountsApi) { setError("养号服务尚未连接，请重新打开桌面应用。"); return; }
    let active = true;
    const off = [api.onUpdate((next) => { if (active) setState(next); }), accountsApi.onUpdate((next) => { if (active) setAccounts(next); })];
    void api.status().then((result) => { if (!active) return; if (result.state) setState(result.state); if (!result.ok) setError(result.error || "养号记录读取失败。"); });
    void accountsApi.status().then((result) => { if (active && result.state) setAccounts(result.state); });
    void finishedApi()?.list({ limit: 60 }).then((result) => { if (active && result.ok) setVideos((result.data?.items || []).filter((item) => item.available)); }).catch(() => undefined);
    return () => { active = false; off.forEach((stop) => stop()); };
  }, [api, accountsApi]);

  const douyinAccounts = (accounts?.accounts || []).filter((account) => account.platform === "douyin" && account.status === "active");
  useEffect(() => { if (!form.accountId && douyinAccounts[0]) setForm((current) => ({ ...current, accountId: douyinAccounts[0].id })); }, [douyinAccounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const save = async () => {
    if (!api) return;
    if (await run("save", () => api.savePlan(form), form.id ? "计划已保存。" : `养号计划已开始：今天 ${form.startTime} 之后会自动打开 Chrome 刷抖音，请保持软件开着，不要在那个窗口里操作。`)) setForm(emptyPlan(form.accountId));
  };
  const edit = (plan: NurturePlan) => setForm({ id: plan.id, accountId: plan.accountId, keywords: plan.keywords.join("\n"), comments: plan.comments.join("\n"), startTime: plan.startTime, testVideo: plan.testVideo });
  const chosen = videos.find((item) => item.finishedVideoId === form.testVideo?.finishedVideoId);

  return <div className="acq">
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    <div className="acq-grid">
      <section className="acq-card" aria-labelledby="nurture-form">
        <div className="acq-sec"><h2 id="nurture-form"><em>{form.id ? "编辑" : "新建"}</em>养号计划</h2>{form.id && <button type="button" className="social-text-button" onClick={() => setForm(emptyPlan(form.accountId))}>取消编辑</button>}</div>
        <div className="acq-form">
          <label>抖音账号{douyinAccounts.length ? <select value={form.accountId} disabled={Boolean(form.id)} onChange={(event) => setForm({ ...form, accountId: event.target.value })}>{douyinAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select>
            : <p className="acq-hint is-warn">还没有已登录的抖音账号，先到「一键分发 → 平台账号」添加并扫码。</p>}</label>
          <label>行业关键词<textarea rows={2} value={form.keywords} placeholder={"每行一个，每次随机用一个，例如：\n洗地机\n商用清洁设备"} onChange={(event) => setForm({ ...form, keywords: event.target.value })} /></label>
          <label>评论话术<textarea rows={3} value={form.comments} onChange={(event) => setForm({ ...form, comments: event.target.value })} />
            <small>每行一条，每次随机用一条。只写普通互动的话，不要写电话、微信、链接，平台会当广告隐藏。</small></label>
          <div className="acq-row">
            <label>每天开始时间<input type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} /></label>
            <label>第 8 天测试视频<span className="social-optional">选填</span><select value={form.testVideo?.finishedVideoId || ""} onChange={(event) => { const item = videos.find((video) => video.finishedVideoId === event.target.value);
              setForm({ ...form, testVideo: item ? { finishedVideoId: item.finishedVideoId, name: item.title || item.displayName, title: (form.testVideo?.title || item.title || "").slice(0, 30) } : null }); }}>
              <option value="">不发</option>{videos.map((item) => <option key={item.finishedVideoId} value={item.finishedVideoId}>{item.title || item.displayName}</option>)}</select></label>
          </div>
          {chosen && <label>测试视频标题<input value={form.testVideo?.title || ""} maxLength={30} onChange={(event) => setForm({ ...form, testVideo: form.testVideo && { ...form.testVideo, title: event.target.value } })} /></label>}
        </div>
        <div className="acq-actions">
          <button type="button" className="ns-go acq-go" disabled={Boolean(pending) || !api || !form.accountId} onClick={() => void save()}><Play size={18} />{form.id ? "保存" : "保存并开始养号"}</button>
        </div>
        <ul className="acq-hint">{STAGES.map((stage) => <li key={stage}>{stage}</li>)}</ul>
        <p className="acq-hint">每天分 2–3 段，每段 15–25 分钟，段与段之间隔半小时左右；只在软件开着时运行。抖音弹验证码时会停下，Chrome 窗口跳到前面，请你完成验证；一天出现两次就停到第二天。</p>
      </section>

      <section className="acq-card" aria-labelledby="nurture-plans">
        <div className="acq-sec"><h2 id="nurture-plans"><em>计划</em>我的养号</h2><button type="button" className="social-text-button" onClick={() => setForm(emptyPlan(form.accountId))}><Plus size={14} />新建</button></div>
        {(state?.plans.length || 0) === 0 ? <p className="social-empty">还没有养号计划。左边选好账号、填关键词，点「保存并开始养号」。</p> : <ul className="acq-tasks">
          {state!.plans.map((plan) => { const running = state!.running === plan.id, today = plan.today;
            return <li key={plan.id}>
              <PlatformIcon platform="douyin" size={30} />
              <div className="acq-task-copy"><b>{plan.accountLabel} · 第 {Math.min(plan.day, 8)} 天 {plan.stage}</b>
                <span>{today ? `今天 ${today.segmentsDone}/${today.segments} 段 · 看了 ${today.counts.watched} 个 · 赞 ${today.counts.likes}/${today.targets.likes} · 关注 ${today.counts.follows}/${today.targets.follows} · 评论 ${today.counts.comments}/${today.targets.comments}` : `关键词：${plan.keywords.join("、")}`}</span>
                <small className={`is-${plan.status === "paused" ? "failed" : running ? "running" : "done"}`}>{statusLine(plan, running)}{plan.mode === "feed" ? " · 抖音不让搜索，改为刷推荐页" : ""}{plan.publishResult ? ` · ${plan.publishResult}` : ""}</small></div>
              <div className="acq-task-actions">
                {running && <button type="button" className="acq-mini" disabled={Boolean(pending)} onClick={() => api && void run("stop", () => api.stop(), "这一段已停下，稍后会按计划继续。")}><Square size={14} />停下这段</button>}
                {plan.status !== "finished" && (plan.enabled && plan.status === "active"
                  ? <button type="button" className="acq-mini" disabled={Boolean(pending)} onClick={() => api && void run(`off-${plan.id}`, () => api.setEnabled(plan.id, false), "已关闭，不会再自动运行。")}><Pause size={14} />关闭</button>
                  : <button type="button" className="acq-mini is-go" disabled={Boolean(pending)} onClick={() => api && void run(`on-${plan.id}`, () => api.setEnabled(plan.id, true), "已打开，会按计划继续。")}><Play size={14} />{plan.status === "paused" ? "继续" : "打开"}</button>)}
                <button type="button" className="acq-mini" aria-label="编辑计划" disabled={running} onClick={() => edit(plan)}><Pencil size={14} /></button>
                <button type="button" className="acq-mini" aria-label="删除计划" disabled={running || Boolean(pending)} onClick={() => api && window.confirm(`删除「${plan.accountLabel}」的养号计划？进度不会保留。`) && void run(`rm-${plan.id}`, () => api.removePlan(plan.id))}><Trash2 size={14} /></button>
              </div>
            </li>; })}
        </ul>}
      </section>
    </div>
    <section className="acq-card" aria-labelledby="nurture-log">
      <div className="acq-sec"><h2 id="nurture-log"><em>记录</em>养号动作</h2></div>
      {(state?.log.length || 0) === 0 ? <p className="social-empty">还没有记录。</p> : <ul className="acq-tasks">
        {state!.log.slice(0, 80).map((entry, index) => <li key={`${entry.at}-${index}`}><span>{clock(entry.at)}</span><span>{state!.plans.find((plan) => plan.id === entry.planId)?.accountLabel || ""}</span><span>{entry.text}</span></li>)}
      </ul>}
    </section>
  </div>;
}
