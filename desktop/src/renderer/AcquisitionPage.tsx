import { useEffect, useMemo, useState } from "react";
import { Check, Download, ExternalLink, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import type { AcquireLead, AcquireResult, AcquireState, AcquireTask, AcquireTaskInput } from "./social-acquisition-types";
import type { SocialAccountsState } from "./social-accounts-types";
import { PlatformIcon } from "./PlatformIcon";
import "./SocialAccountsPanel.css";
import "./AcquisitionPage.css";

const DAYS = [[1, "1 天内"], [7, "7 天内"], [30, "30 天内"], [90, "90 天内"]] as const;
const RUN_STATUS: Record<string, string> = { running: "运行中", needs_user: "等你验证", done: "已完成", stopped: "已停下", failed: "没完成" };
const LEAD_STATUS: Record<AcquireLead["status"], string> = { new: "新线索", contacted: "已联系", ignored: "已忽略" };
const emptyTask = (accountId = ""): AcquireTaskInput => ({ name: "", platform: "kuaishou", accountId, keywords: "", intentWords: "", days: 30, maxVideos: 10, allComments: false, skipAuthor: true });
const when = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日`; };

// 关键词获客：按关键词搜视频、读评论，把有购买意向的人整理成线索。这一步只看不动，不发任何东西。
export function AcquisitionPage() {
  const api = window.xiaoxiSocialAcquisition, accountsApi = window.xiaoxiSocialAccounts;
  const [state, setState] = useState<AcquireState>();
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  const [form, setForm] = useState<AcquireTaskInput>(emptyTask());
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<"all" | AcquireLead["status"]>("new");
  const [taskFilter, setTaskFilter] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!api || !accountsApi) { setError("关键词获客服务尚未连接，请重新打开桌面应用。"); return; }
    let active = true;
    const off = [api.onUpdate((next) => { if (active) setState(next); }), accountsApi.onUpdate((next) => { if (active) setAccounts(next); })];
    void api.status().then((result) => { if (active && result.state) setState(result.state); });
    void accountsApi.status().then((result) => { if (active && result.state) setAccounts(result.state); });
    return () => { active = false; off.forEach((stop) => stop()); };
  }, [api, accountsApi]);

  const kuaishouAccounts = (accounts?.accounts || []).filter((account) => account.platform === "kuaishou" && account.status === "active");
  useEffect(() => { if (!form.accountId && kuaishouAccounts[0]) setForm((current) => ({ ...current, accountId: kuaishouAccounts[0].id })); }, [kuaishouAccounts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const runFor = (task: AcquireTask) => state?.runs.find((run) => run.taskId === task.id);
  const runningRun = state?.runs.find((run) => run.id === state.running);
  const leads = useMemo(() => (state?.leads || []).filter((lead) => (filter === "all" || lead.status === filter) && (!taskFilter || lead.taskId === taskFilter)), [state, filter, taskFilter]);
  const counts = useMemo(() => ({ all: state?.leads.length || 0, new: state?.leads.filter((lead) => lead.status === "new").length || 0 }), [state]);

  const run = async (key: string, operation: () => Promise<AcquireResult>, success = "") => {
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
  const saveAndStart = async (startAfter: boolean) => {
    if (!api) return;
    const before = new Set((state?.tasks || []).map((task) => task.id));
    const ok = await run("save", () => api.saveTask(form), startAfter ? "" : "任务已保存。");
    if (!ok) return;
    const latest = await api.status();
    const saved = form.id ? latest.state?.tasks.find((task) => task.id === form.id) : latest.state?.tasks.find((task) => !before.has(task.id));
    setEditing(false); setForm(emptyTask(form.accountId));
    if (startAfter && saved) await run("start", () => api.start(saved.id), "已开始：会打开 Chrome 窗口搜视频、读评论，请不要在窗口里操作。");
  };
  const edit = (task: AcquireTask) => { setForm({ id: task.id, name: task.name, platform: task.platform, accountId: task.accountId, keywords: task.keywords.join("\n"), intentWords: task.intentWords.join(" "), days: task.days, maxVideos: task.maxVideos, allComments: task.allComments, skipAuthor: task.skipAuthor }); setEditing(true); };

  return <div className="acq">
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    {runningRun && <div className={`acq-live ${runningRun.status === "needs_user" ? "is-wait" : ""}`} role="status">
      <span className="acq-live-dot" aria-hidden="true" />
      <div><b>{RUN_STATUS[runningRun.status]}</b><span>{runningRun.detail || "处理中…"}</span></div>
      <ul><li><b>{runningRun.videos}</b>个视频</li><li><b>{runningRun.comments}</b>条意向评论</li><li><b>{runningRun.leads}</b>条新线索</li></ul>
      <button type="button" className="acq-stop" disabled={Boolean(pending)} onClick={() => api && void run("stop", () => api.stop())}><Square size={14} />停下</button>
    </div>}

    <div className="acq-grid">
      <section className="acq-card" aria-labelledby="acq-form">
        <div className="acq-sec"><h2 id="acq-form"><em>{form.id ? "编辑" : "新建"}</em>获客任务</h2>{editing && <button type="button" className="social-text-button" onClick={() => { setEditing(false); setForm(emptyTask(form.accountId)); }}>取消编辑</button>}</div>
        <div className="acq-platforms" role="radiogroup" aria-label="平台">
          <button type="button" role="radio" aria-checked={form.platform === "kuaishou"} className={form.platform === "kuaishou" ? "is-on" : ""} onClick={() => setForm({ ...form, platform: "kuaishou" })}><PlatformIcon platform="kuaishou" size={26} /><span><b>快手</b><small>可以使用</small></span></button>
          <button type="button" role="radio" aria-checked={false} disabled title="抖音网页版搜索会拦截软件控制的浏览器，暂不支持"><PlatformIcon platform="douyin" size={26} /><span><b>抖音</b><small>网页搜索被平台拦截，暂不支持</small></span></button>
        </div>
        <div className="acq-form">
          <label>用哪个账号搜{kuaishouAccounts.length ? <select value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}>{kuaishouAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select>
            : <p className="acq-hint is-warn">还没有已登录的快手账号，先到「一键分发 → 平台账号」添加并扫码。</p>}</label>
          <label>关键词<textarea rows={3} value={form.keywords} placeholder={"每行一个，例如：\n洗地机\n商用清洁设备"} onChange={(event) => setForm({ ...form, keywords: event.target.value })} /></label>
          <label>意向词<span className="social-optional">选填</span><input value={form.intentWords} placeholder="评论里出现这些词也算意向，空格分开，例如：租 批发 代理" onChange={(event) => setForm({ ...form, intentWords: event.target.value })} />
            <small>已内置：问价、想买、要联系方式、问好不好用 这几类说法</small></label>
          <div className="acq-row">
            <label>评论时间<select value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })}>{DAYS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>每个关键词看几个视频<input type="number" min={1} max={50} value={form.maxVideos} onChange={(event) => setForm({ ...form, maxVideos: Number(event.target.value) })} /></label>
          </div>
          <label className="acq-check"><input type="checkbox" checked={form.skipAuthor} onChange={(event) => setForm({ ...form, skipAuthor: event.target.checked })} />跳过视频作者自己的回复</label>
          <label className="acq-check"><input type="checkbox" checked={form.allComments} onChange={(event) => setForm({ ...form, allComments: event.target.checked })} />所有评论都收（不按意向筛）</label>
        </div>
        <div className="acq-actions">
          <button type="button" className="secondary-button" disabled={Boolean(pending) || !api} onClick={() => void saveAndStart(false)}>保存</button>
          <button type="button" className="ns-go acq-go" disabled={Boolean(pending) || !api || Boolean(state?.running) || !form.accountId} onClick={() => void saveAndStart(true)}><Play size={18} />保存并开始</button>
        </div>
        <p className="acq-hint">只搜视频、读评论，不点赞、不关注、不评论、不发私信。平台弹验证码时会暂停，Chrome 窗口跳到前面，请你点一下完成验证，然后自动继续。</p>
      </section>

      <section className="acq-card" aria-labelledby="acq-tasks">
        <div className="acq-sec"><h2 id="acq-tasks"><em>任务</em>我的获客任务</h2><button type="button" className="social-text-button" onClick={() => { setEditing(false); setForm(emptyTask(form.accountId)); }}><Plus size={14} />新建</button></div>
        {(state?.tasks.length || 0) === 0 ? <p className="social-empty">还没有任务。左边填好关键词，点「保存并开始」。</p> : <ul className="acq-tasks">
          {state!.tasks.map((task) => { const last = runFor(task); const running = state!.running && last?.id === state!.running;
            return <li key={task.id}>
              <PlatformIcon platform={task.platform} size={30} />
              <div className="acq-task-copy"><b>{task.name}</b><span>{task.accountLabel} · {task.keywords.length} 个关键词 · 每个看 {task.maxVideos} 个视频</span>
                {last && <small className={`is-${last.status}`}>{RUN_STATUS[last.status]} · {last.videos} 个视频 · 找到 {last.leads} 条线索{last.reason ? ` · ${last.reason}` : ""}</small>}</div>
              <div className="acq-task-actions">
                {!running && <button type="button" className="acq-mini is-go" disabled={Boolean(pending) || Boolean(state!.running)} onClick={() => api && void run(`start-${task.id}`, () => api.start(task.id), "已开始：会打开 Chrome 窗口搜视频、读评论，请不要在窗口里操作。")}><Play size={14} />开始</button>}
                <button type="button" className="acq-mini" aria-label="编辑任务" disabled={Boolean(running)} onClick={() => edit(task)}><Pencil size={14} /></button>
                <button type="button" className="acq-mini" aria-label="删除任务" disabled={Boolean(running) || Boolean(pending)} onClick={() => api && window.confirm(`删除任务「${task.name}」？已找到的线索会保留。`) && void run(`remove-${task.id}`, () => api.removeTask(task.id))}><Trash2 size={14} /></button>
              </div>
            </li>; })}
        </ul>}
      </section>
    </div>

    <section className="acq-card" aria-labelledby="acq-leads">
      <div className="acq-sec"><h2 id="acq-leads"><em>线索</em>意向客户</h2><span>共 {counts.all} 条，新线索 {counts.new} 条</span>
        <div className="acq-filters">
          <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)} aria-label="按任务看"><option value="">全部任务</option>{state?.tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select>
          <div className="acq-seg" role="radiogroup" aria-label="按状态看">{(["new", "contacted", "ignored", "all"] as const).map((key) => <button type="button" role="radio" aria-checked={filter === key} key={key} className={filter === key ? "is-on" : ""} onClick={() => setFilter(key)}>{key === "all" ? "全部" : LEAD_STATUS[key]}</button>)}</div>
          <button type="button" className="secondary-button" disabled={!counts.all || Boolean(pending)} onClick={() => api && void run("export", async () => { const result = await api.exportCsv(taskFilter); if (result.ok && result.state?.exported) setNotice("线索已导出成表格。"); return result; })}><Download size={15} />导出表格</button>
        </div>
      </div>
      {leads.length === 0 ? <p className="social-empty">{counts.all ? "这个筛选下没有线索。" : "还没有线索。运行一个获客任务后，有意向的评论会出现在这里。"}</p> : <ul className="acq-leads">
        {leads.slice(0, 300).map((lead) => <li key={lead.id} className={`is-${lead.status}`}>
          <PlatformIcon platform={lead.platform === "douyin" ? "douyin" : "kuaishou"} size={28} />
          <div className="acq-lead-main">
            <div className="acq-lead-head"><b>{lead.userName || "未知昵称"}</b>{lead.signals.map((signal) => <span key={signal} className="acq-chip">{signal}</span>)}<small>{when(lead.commentAt)}{lead.region ? ` · ${lead.region}` : ""}</small></div>
            <p>「{lead.comment}」</p>
            <small className="acq-lead-src">关键词「{lead.keyword}」 · 来自视频：{lead.videoTitle || lead.videoId}</small>
          </div>
          <div className="acq-lead-actions">
            <button type="button" className="acq-mini" onClick={() => api && void run(`open-${lead.id}`, () => api.openLead(lead.id))}><ExternalLink size={14} />看视频</button>
            {lead.status !== "contacted" && <button type="button" className="acq-mini is-go" onClick={() => api && void run(`c-${lead.id}`, () => api.setLead(lead.id, "contacted"))}><Check size={14} />已联系</button>}
            {lead.status === "new" && <button type="button" className="acq-mini" onClick={() => api && void run(`i-${lead.id}`, () => api.setLead(lead.id, "ignored"))}>忽略</button>}
            {lead.status !== "new" && <button type="button" className="acq-mini" onClick={() => api && void run(`n-${lead.id}`, () => api.setLead(lead.id, "new"))}>恢复</button>}
          </div>
        </li>)}
      </ul>}
    </section>
  </div>;
}
