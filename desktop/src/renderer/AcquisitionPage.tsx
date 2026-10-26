import { useEffect, useMemo, useState } from "react";
import { Check, Download, ExternalLink, Heart, MessageSquare, Pencil, Play, Plus, Search, Square, Trash2, UserPlus } from "lucide-react";
import type { AcquireAction, AcquireActionKind, AcquireCaps, AcquireLead, AcquireResult, AcquireRun, AcquireState, AcquireTask, AcquireTaskInput } from "./social-acquisition-types";
import type { SocialAccountsState } from "./social-accounts-types";
import { PlatformIcon } from "./PlatformIcon";
import "./SocialAccountsPanel.css";
import "./AcquisitionPage.css";

const DAYS = [[1, "1 天内"], [7, "7 天内"], [30, "30 天内"], [90, "90 天内"]] as const;
const RUN_STATUS: Record<string, string> = { running: "运行中", needs_user: "等你验证", done: "已完成", stopped: "已停下", failed: "没完成" };
const LEAD_STATUS: Record<AcquireLead["status"], string> = { new: "新线索", contacted: "已联系", ignored: "已忽略" };
const ACTION_NAME: Record<AcquireActionKind, string> = { like: "点赞", follow: "关注", comment: "留言" };
const ACTION_STATUS: Record<AcquireAction["status"], string> = { queued: "排队中", running: "进行中", done: "已完成", failed: "没成功", unknown: "结果不明", cancelled: "已取消" };
const emptyTask = (accountId = "", mode: AcquireTaskInput["mode"] = "collect"): AcquireTaskInput => ({ name: "", mode, platform: "kuaishou", accountId, keywords: "", intentWords: "", days: 30, maxVideos: 10, allComments: false, skipAuthor: true, texts: "", maxComments: 5 });
const when = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日`; };
const clock = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };
const runLine = (run: AcquireRun) => run.kind === "comment" ? `看了 ${run.videos} 个视频 · 留言 ${run.sent || 0} 条` : run.kind === "actions" ? `做完 ${run.sent || 0} 个 · 没成功 ${run.failed || 0} 个` : `${run.videos} 个视频 · 找到 ${run.leads} 条线索`;

// 关键词获客：按关键词搜视频、读评论，把有购买意向的人整理成线索；可以给线索的评论点赞、关注线索，
// 也可以在同行视频下留言。每个动作都有每天上限，平台提示频繁就停到明天，结果不明的不会自动重做。
export function AcquisitionPage() {
  const api = window.xiaoxiSocialAcquisition, accountsApi = window.xiaoxiSocialAccounts;
  const [state, setState] = useState<AcquireState>();
  const [accounts, setAccounts] = useState<SocialAccountsState>();
  const [form, setForm] = useState<AcquireTaskInput>(emptyTask());
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<"all" | AcquireLead["status"]>("new");
  const [taskFilter, setTaskFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [capsDraft, setCapsDraft] = useState<AcquireCaps>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!api || !accountsApi) { setError("关键词获客服务尚未连接，请重新打开桌面应用。"); return; }
    let active = true;
    const off = [api.onUpdate((next) => { if (active) setState(next); }), accountsApi.onUpdate((next) => { if (active) setAccounts(next); })];
    void api.status().then((result) => { if (!active) return; if (result.state) setState(result.state); if (!result.ok) setError(result.error || "关键词获客记录读取失败。"); });
    void accountsApi.status().then((result) => { if (active && result.state) setAccounts(result.state); });
    return () => { active = false; off.forEach((stop) => stop()); };
  }, [api, accountsApi]);

  const kuaishouAccounts = (accounts?.accounts || []).filter((account) => account.platform === "kuaishou" && account.status === "active");
  const accountName = (id: string) => (accounts?.accounts || []).find((account) => account.id === id)?.label || "快手号";
  useEffect(() => { if (!form.accountId && kuaishouAccounts[0]) setForm((current) => ({ ...current, accountId: kuaishouAccounts[0].id })); }, [kuaishouAccounts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const runFor = (task: AcquireTask) => state?.runs.find((run) => run.taskId === task.id);
  const runningRun = state?.runs.find((run) => run.id === state.running);
  const actions = state?.actions || [];
  // The latest record of each action per lead (a cancelled one does not count).
  const leadActs = useMemo(() => {
    const map = new Map<string, Partial<Record<AcquireActionKind, AcquireAction>>>();
    for (const action of actions) if (action.leadId && action.status !== "cancelled") { const entry = map.get(action.leadId) || {}; if (!entry[action.kind]) entry[action.kind] = action; map.set(action.leadId, entry); }
    return map;
  }, [actions]);
  const leads = useMemo(() => (state?.leads || []).filter((lead) => (filter === "all" || lead.status === filter) && (!taskFilter || lead.taskId === taskFilter)), [state, filter, taskFilter]);
  const counts = useMemo(() => ({ all: state?.leads.length || 0, new: state?.leads.filter((lead) => lead.status === "new").length || 0 }), [state]);
  const queued = actions.filter((action) => action.status === "queued").length;
  const unknown = actions.filter((action) => action.status === "unknown");
  const commentRecords = actions.filter((action) => action.kind === "comment" && action.status !== "cancelled").slice(0, 30);
  const visibleLeads = leads.slice(0, 300);
  const pickedLeads = visibleLeads.filter((lead) => picked.has(lead.id));

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
    if (startAfter && form.mode === "comment" && !window.confirm(`会在搜到的同行视频下面公开留言，所有人都能看到。\n本次最多留言 ${form.maxComments} 条，每个视频只留一次，每条之间隔一两分钟。\n确定开始吗？`)) return;
    const before = new Set((state?.tasks || []).map((task) => task.id));
    const ok = await run("save", () => api.saveTask(form), startAfter ? "" : "任务已保存。");
    if (!ok) return;
    const latest = await api.status();
    const saved = form.id ? latest.state?.tasks.find((task) => task.id === form.id) : latest.state?.tasks.find((task) => !before.has(task.id));
    setEditing(false); setForm(emptyTask(form.accountId, form.mode));
    if (startAfter && saved) await run("start", () => api.start(saved.id), startNote(saved));
  };
  const startNote = (task: AcquireTask) => task.mode === "comment" ? "已开始：会打开 Chrome 窗口搜视频并留言，请不要在窗口里操作。" : "已开始：会打开 Chrome 窗口搜视频、读评论，请不要在窗口里操作。";
  const startTask = (task: AcquireTask) => {
    if (!api) return;
    if (task.mode === "comment" && !window.confirm(`任务「${task.name}」会在同行视频下面公开留言，本次最多 ${task.maxComments || 5} 条。确定开始吗？`)) return;
    void run(`start-${task.id}`, () => api.start(task.id), startNote(task));
  };
  const edit = (task: AcquireTask) => { setForm({ id: task.id, name: task.name, mode: task.mode || "collect", platform: task.platform, accountId: task.accountId, keywords: task.keywords.join("\n"), intentWords: task.intentWords.join(" "), days: task.days, maxVideos: task.maxVideos, allComments: task.allComments, skipAuthor: task.skipAuthor, texts: (task.texts || []).join("\n"), maxComments: task.maxComments || 5 }); setEditing(true); };
  const queue = (leadIds: string[], kinds: AcquireActionKind[]) => {
    if (!api || !leadIds.length) return;
    const what = kinds.map((kind) => ACTION_NAME[kind]).join("和");
    const caps = state?.caps;
    if (!window.confirm(`给 ${leadIds.length} 个人${kinds.includes("like") ? "的评论" : ""}${what}？\n会用找到他们的那个快手号去做，每个动作间隔半分钟到一分钟。\n每个账号每天最多点赞 ${caps?.like ?? 60} 个、关注 ${caps?.follow ?? 30} 个；平台提示频繁就停到明天。`)) return;
    void run("queue", async () => { const result = await api.queueActions(leadIds, kinds); if (result.ok) { setPicked(new Set()); setNotice(result.state?.added ? `已加入 ${result.state.added} 个动作，正在依次执行。` : "这些人已经做过或已在排队，没有新加入的。"); } return result; });
  };
  const togglePick = (id: string) => setPicked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allPicked = visibleLeads.length > 0 && visibleLeads.every((lead) => picked.has(lead.id));
  const todayRows = Object.entries(state?.today || {});

  const actChip = (action?: AcquireAction) => action ? <span className={`acq-act is-${action.status}`} title={action.reason || undefined}>{ACTION_NAME[action.kind]}{action.status === "done" ? "✓" : `·${ACTION_STATUS[action.status]}`}</span> : null;

  return <div className="acq">
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    {runningRun && <div className={`acq-live ${runningRun.status === "needs_user" ? "is-wait" : ""}`} role="status">
      <span className="acq-live-dot" aria-hidden="true" />
      <div><b>{RUN_STATUS[runningRun.status]}{runningRun.kind === "actions" ? ` · ${runningRun.accountLabel || "快手号"}在做点赞关注` : runningRun.kind === "comment" ? " · 同行视频留言" : ""}</b><span>{runningRun.detail || "处理中…"}</span></div>
      {runningRun.kind === "actions" ? <ul><li><b>{runningRun.sent || 0}</b>个做完</li><li><b>{runningRun.failed || 0}</b>个没成功</li><li><b>{queued}</b>个排队</li></ul>
        : runningRun.kind === "comment" ? <ul><li><b>{runningRun.videos}</b>个视频</li><li><b>{runningRun.sent || 0}</b>条已留言</li></ul>
        : <ul><li><b>{runningRun.videos}</b>个视频</li><li><b>{runningRun.comments}</b>条意向评论</li><li><b>{runningRun.leads}</b>条新线索</li></ul>}
      <button type="button" className="acq-stop" disabled={Boolean(pending)} onClick={() => api && void run("stop", () => api.stop())}><Square size={14} />停下</button>
    </div>}

    <div className="acq-grid">
      <section className="acq-card" aria-labelledby="acq-form">
        <div className="acq-sec"><h2 id="acq-form"><em>{form.id ? "编辑" : "新建"}</em>获客任务</h2>{editing && <button type="button" className="social-text-button" onClick={() => { setEditing(false); setForm(emptyTask(form.accountId, form.mode)); }}>取消编辑</button>}</div>
        <div className="acq-seg acq-mode" role="radiogroup" aria-label="任务类型">
          <button type="button" role="radio" aria-checked={form.mode === "collect"} className={form.mode === "collect" ? "is-on" : ""} onClick={() => setForm({ ...form, mode: "collect" })}><Search size={14} />找客户（读评论）</button>
          <button type="button" role="radio" aria-checked={form.mode === "comment"} className={form.mode === "comment" ? "is-on" : ""} onClick={() => setForm({ ...form, mode: "comment" })}><MessageSquare size={14} />同行视频留言</button>
        </div>
        <div className="acq-platforms" role="radiogroup" aria-label="平台">
          <button type="button" role="radio" aria-checked={form.platform === "kuaishou"} className={form.platform === "kuaishou" ? "is-on" : ""} onClick={() => setForm({ ...form, platform: "kuaishou" })}><PlatformIcon platform="kuaishou" size={26} /><span><b>快手</b><small>可以使用</small></span></button>
          <button type="button" role="radio" aria-checked={false} disabled title="抖音网页版搜索会拦截软件控制的浏览器，暂不支持"><PlatformIcon platform="douyin" size={26} /><span><b>抖音</b><small>网页搜索被平台拦截，暂不支持</small></span></button>
        </div>
        <div className="acq-form">
          <label>用哪个账号{kuaishouAccounts.length ? <select value={form.accountId} onChange={(event) => setForm({ ...form, accountId: event.target.value })}>{kuaishouAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select>
            : <p className="acq-hint is-warn">还没有已登录的快手账号，先到「一键分发 → 平台账号」添加并扫码。</p>}</label>
          <label>关键词<textarea rows={3} value={form.keywords} placeholder={"每行一个，例如：\n洗地机\n商用清洁设备"} onChange={(event) => setForm({ ...form, keywords: event.target.value })} /></label>
          {form.mode === "collect" ? <>
            <label>意向词<span className="social-optional">选填</span><input value={form.intentWords} placeholder="评论里出现这些词也算意向，空格分开，例如：租 批发 代理" onChange={(event) => setForm({ ...form, intentWords: event.target.value })} />
              <small>已内置：问价、想买、要联系方式、问好不好用 这几类说法</small></label>
            <div className="acq-row">
              <label>评论时间<select value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })}>{DAYS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>每个关键词看几个视频<input type="number" min={1} max={50} value={form.maxVideos} onChange={(event) => setForm({ ...form, maxVideos: Number(event.target.value) })} /></label>
            </div>
            <label className="acq-check"><input type="checkbox" checked={form.skipAuthor} onChange={(event) => setForm({ ...form, skipAuthor: event.target.checked })} />跳过视频作者自己的回复</label>
            <label className="acq-check"><input type="checkbox" checked={form.allComments} onChange={(event) => setForm({ ...form, allComments: event.target.checked })} />所有评论都收（不按意向筛）</label>
          </> : <>
            <label>留言内容<textarea rows={4} value={form.texts} placeholder={"每行一条，按顺序轮流使用，例如：\n我们是厂家直供，商用洗地机可以租也可以买，需要的私信我\n做清洁设备十年了，有问题可以问我"} onChange={(event) => setForm({ ...form, texts: event.target.value })} />
              <small>最多 10 条，每条 200 字以内。用你自己的话写，留言是公开的</small></label>
            <div className="acq-row">
              <label>这次最多留言几条<input type="number" min={1} max={20} value={form.maxComments} onChange={(event) => setForm({ ...form, maxComments: Number(event.target.value) })} /></label>
              <label>每个关键词看几个视频<input type="number" min={1} max={50} value={form.maxVideos} onChange={(event) => setForm({ ...form, maxVideos: Number(event.target.value) })} /></label>
            </div>
          </>}
        </div>
        <div className="acq-actions">
          <button type="button" className="secondary-button" disabled={Boolean(pending) || !api} onClick={() => void saveAndStart(false)}>保存</button>
          <button type="button" className="ns-go acq-go" disabled={Boolean(pending) || !api || Boolean(state?.running) || !form.accountId} onClick={() => void saveAndStart(true)}><Play size={18} />保存并开始</button>
        </div>
        <p className="acq-hint">{form.mode === "collect" ? "只搜视频、读评论，不对外发任何东西。找到线索后，可以在下面给他们的评论点赞、关注他们。" : `会在搜到的同行视频下面公开留言，每个视频只留一次，每条之间隔一两分钟；每个账号每天最多 ${state?.caps.comment ?? 15} 条。`}平台弹验证码时会暂停，Chrome 窗口跳到前面，请你点一下完成验证，然后自动继续。</p>
      </section>

      <section className="acq-card" aria-labelledby="acq-tasks">
        <div className="acq-sec"><h2 id="acq-tasks"><em>任务</em>我的获客任务</h2><button type="button" className="social-text-button" onClick={() => { setEditing(false); setForm(emptyTask(form.accountId, form.mode)); }}><Plus size={14} />新建</button></div>
        {(state?.tasks.length || 0) === 0 ? <p className="social-empty">还没有任务。左边填好关键词，点「保存并开始」。</p> : <ul className="acq-tasks">
          {state!.tasks.map((task) => { const last = runFor(task); const running = state!.running && last?.id === state!.running;
            return <li key={task.id}>
              <PlatformIcon platform={task.platform} size={30} />
              <div className="acq-task-copy"><b>{task.mode === "comment" && <span className="acq-chip">留言</span>} {task.name}</b><span>{task.accountLabel} · {task.keywords.length} 个关键词 · {task.mode === "comment" ? `每次最多留言 ${task.maxComments || 5} 条` : `每个看 ${task.maxVideos} 个视频`}</span>
                {last && <small className={`is-${last.status}`}>{RUN_STATUS[last.status]} · {runLine(last)}{last.reason ? ` · ${last.reason}` : ""}</small>}</div>
              <div className="acq-task-actions">
                {!running && <button type="button" className="acq-mini is-go" disabled={Boolean(pending) || Boolean(state!.running)} onClick={() => startTask(task)}><Play size={14} />开始</button>}
                <button type="button" className="acq-mini" aria-label="编辑任务" disabled={Boolean(running)} onClick={() => edit(task)}><Pencil size={14} /></button>
                <button type="button" className="acq-mini" aria-label="删除任务" disabled={Boolean(running) || Boolean(pending)} onClick={() => api && window.confirm(`删除任务「${task.name}」？已找到的线索和留言记录会保留。`) && void run(`remove-${task.id}`, () => api.removeTask(task.id))}><Trash2 size={14} /></button>
              </div>
            </li>; })}
        </ul>}
      </section>
    </div>

    <section className="acq-card" aria-labelledby="acq-today">
      <div className="acq-sec"><h2 id="acq-today"><em>今天</em>动作与上限</h2>
        <span>{queued ? `还有 ${queued} 个排队` : "没有排队的动作"}</span>
        <div className="acq-filters">
          {queued > 0 && !state?.running && <button type="button" className="acq-mini is-go" disabled={Boolean(pending)} onClick={() => api && void run("resume", () => api.resume(), "继续执行排队的动作。")}><Play size={14} />继续执行</button>}
          {queued > 0 && <button type="button" className="acq-mini" disabled={Boolean(pending)} onClick={() => api && window.confirm(`取消 ${queued} 个还没做的动作？`) && void run("cancel", () => api.cancelQueued())}>取消排队</button>}
          <button type="button" className="social-text-button" onClick={() => setCapsDraft(capsDraft ? undefined : state?.caps)}>{capsDraft ? "收起" : "调整每天上限"}</button>
        </div>
      </div>
      {capsDraft && <div className="acq-caps">
        {(["like", "follow", "comment"] as const).map((kind) => <label key={kind}>每个账号每天{ACTION_NAME[kind]}<input type="number" min={0} max={kind === "like" ? 200 : kind === "follow" ? 100 : 50} value={capsDraft[kind]} onChange={(event) => setCapsDraft({ ...capsDraft, [kind]: Number(event.target.value) })} /></label>)}
        <button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => api && void run("caps", async () => { const result = await api.saveCaps(capsDraft); if (result.ok) setCapsDraft(undefined); return result; }, "上限已保存。")}>保存</button>
        <small>上限设得越高，被平台限制的可能越大。平台一提示频繁，这个账号当天就会停下。</small>
      </div>}
      {todayRows.length === 0 ? <p className="social-empty">今天还没有点赞、关注或留言。</p> : <ul className="acq-today">
        {todayRows.map(([accountId, today]) => <li key={accountId}>
          <PlatformIcon platform="kuaishou" size={24} /><b>{accountName(accountId)}</b>
          {(["like", "follow", "comment"] as const).map((kind) => <span key={kind}>{ACTION_NAME[kind]} <b>{today[kind]}</b>/{state?.caps[kind]}</span>)}
          {today.pausedUntil && <em>平台提示频繁，今天已停下</em>}
        </li>)}
      </ul>}
      {unknown.length > 0 && <div className="acq-unknown" role="alert">
        <b>{unknown.length} 个动作结果不明</b><span>已经点下，但没等到平台确认。请到快手上看一下，再告诉软件结果；软件不会自己重做。</span>
        <ul>{unknown.slice(0, 20).map((action) => <li key={action.id}>
          <span>{ACTION_NAME[action.kind]} · {action.target.userName || action.target.videoTitle || action.target.videoId} · {clock(action.clickedAt)}</span>
          <button type="button" className="acq-mini" onClick={() => api && void run(`open-${action.id}`, () => api.openLead(action.leadId || action.id))}><ExternalLink size={14} />去看看</button>
          <button type="button" className="acq-mini is-go" onClick={() => api && void run(`ok-${action.id}`, () => api.resolveAction(action.id, "done"))}>已成功</button>
          <button type="button" className="acq-mini" onClick={() => api && void run(`no-${action.id}`, () => api.resolveAction(action.id, "failed"))}>没成功</button>
        </li>)}</ul>
      </div>}
    </section>

    <section className="acq-card" aria-labelledby="acq-leads">
      <div className="acq-sec"><h2 id="acq-leads"><em>线索</em>意向客户</h2><span>共 {counts.all} 条，新线索 {counts.new} 条</span>
        <div className="acq-filters">
          <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)} aria-label="按任务看"><option value="">全部任务</option>{state?.tasks.filter((task) => task.mode !== "comment").map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select>
          <div className="acq-seg" role="radiogroup" aria-label="按状态看">{(["new", "contacted", "ignored", "all"] as const).map((key) => <button type="button" role="radio" aria-checked={filter === key} key={key} className={filter === key ? "is-on" : ""} onClick={() => setFilter(key)}>{key === "all" ? "全部" : LEAD_STATUS[key]}</button>)}</div>
          <button type="button" className="secondary-button" disabled={!counts.all || Boolean(pending)} onClick={() => api && void run("export", async () => { const result = await api.exportCsv(taskFilter); if (result.ok && result.state?.exported) setNotice("线索已导出成表格。"); return result; })}><Download size={15} />导出表格</button>
        </div>
      </div>
      {visibleLeads.length > 0 && <div className="acq-bulk">
        <label className="acq-check"><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(visibleLeads.map((lead) => lead.id)))} />全选</label>
        <span>已选 {pickedLeads.length} 人</span>
        <button type="button" className="acq-mini" disabled={!pickedLeads.length || Boolean(pending)} onClick={() => queue(pickedLeads.map((lead) => lead.id), ["like"])}><Heart size={14} />点赞评论</button>
        <button type="button" className="acq-mini" disabled={!pickedLeads.length || Boolean(pending)} onClick={() => queue(pickedLeads.map((lead) => lead.id), ["follow"])}><UserPlus size={14} />关注</button>
        <button type="button" className="acq-mini is-go" disabled={!pickedLeads.length || Boolean(pending)} onClick={() => queue(pickedLeads.map((lead) => lead.id), ["like", "follow"])}>点赞 + 关注</button>
        <small>快手网页版不能回复评论，所以没有「回复」。</small>
      </div>}
      {visibleLeads.length === 0 ? <p className="social-empty">{counts.all ? "这个筛选下没有线索。" : "还没有线索。运行一个「找客户」任务后，有意向的评论会出现在这里。"}</p> : <ul className="acq-leads">
        {visibleLeads.map((lead) => { const acts = leadActs.get(lead.id) || {};
          return <li key={lead.id} className={`is-${lead.status}`}>
            <input type="checkbox" className="acq-pick" aria-label={`选择 ${lead.userName}`} checked={picked.has(lead.id)} onChange={() => togglePick(lead.id)} />
            <PlatformIcon platform={lead.platform === "douyin" ? "douyin" : "kuaishou"} size={28} />
            <div className="acq-lead-main">
              <div className="acq-lead-head"><b>{lead.userName || "未知昵称"}</b>{lead.signals.map((signal) => <span key={signal} className="acq-chip">{signal}</span>)}{actChip(acts.like)}{actChip(acts.follow)}<small>{when(lead.commentAt)}{lead.region ? ` · ${lead.region}` : ""}</small></div>
              <p>「{lead.comment}」</p>
              <small className="acq-lead-src">关键词「{lead.keyword}」 · 来自视频：{lead.videoTitle || lead.videoId}</small>
            </div>
            <div className="acq-lead-actions">
              <button type="button" className="acq-mini" onClick={() => api && void run(`open-${lead.id}`, () => api.openLead(lead.id))}><ExternalLink size={14} />看视频</button>
              {(!acts.like || acts.like.status === "failed") && <button type="button" className="acq-mini" disabled={Boolean(pending)} onClick={() => queue([lead.id], ["like"])}><Heart size={14} />点赞</button>}
              {(!acts.follow || acts.follow.status === "failed") && <button type="button" className="acq-mini" disabled={Boolean(pending)} onClick={() => queue([lead.id], ["follow"])}><UserPlus size={14} />关注</button>}
              {lead.status !== "contacted" && <button type="button" className="acq-mini is-go" onClick={() => api && void run(`c-${lead.id}`, () => api.setLead(lead.id, "contacted"))}><Check size={14} />已联系</button>}
              {lead.status === "new" && <button type="button" className="acq-mini" onClick={() => api && void run(`i-${lead.id}`, () => api.setLead(lead.id, "ignored"))}>忽略</button>}
              {lead.status !== "new" && <button type="button" className="acq-mini" onClick={() => api && void run(`n-${lead.id}`, () => api.setLead(lead.id, "new"))}>恢复</button>}
            </div>
          </li>; })}
      </ul>}
    </section>

    {commentRecords.length > 0 && <section className="acq-card" aria-labelledby="acq-comments">
      <div className="acq-sec"><h2 id="acq-comments"><em>留言</em>同行视频留言记录</h2><span>最近 {commentRecords.length} 条</span></div>
      <ul className="acq-tasks">{commentRecords.map((action) => <li key={action.id}>
        <MessageSquare size={20} />
        <div className="acq-task-copy"><b>「{action.target.text}」</b><span>{accountName(action.accountId)} · 视频：{action.target.videoTitle || action.target.videoId}</span>
          <small className={`is-${action.status === "done" ? "done" : action.status === "failed" ? "failed" : "running"}`}>{ACTION_STATUS[action.status]}{action.clickedAt ? ` · ${clock(action.clickedAt)}` : ""}{action.reason ? ` · ${action.reason}` : ""}</small></div>
        <div className="acq-task-actions"><button type="button" className="acq-mini" onClick={() => api && void run(`open-${action.id}`, () => api.openLead(action.id))}><ExternalLink size={14} />看视频</button></div>
      </li>)}</ul>
    </section>}
  </div>;
}
