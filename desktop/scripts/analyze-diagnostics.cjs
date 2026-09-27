const fs = require("node:fs");
const JSZip = require("jszip");

const MAIN_LOG = /^diagnostics\.jsonl(?:\.\d+)?$/u;
const REPLY_LOG = /^auto_reply\/auto-reply-diagnostics\.jsonl(?:\.\d+)?$/u;
const BILL = /^task-passports\/[^/]+\/bills\/[^/]+\/run-bill\.json$/u;
const safe = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/u.test(value) ? value : "unknown";
const count = (map, key, amount = 1) => map.set(key, (map.get(key) || 0) + amount);
const entries = (map) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const compact = (value, length = 8) => safe(value).slice(0, length);
const taskHash = (row) => /^[a-f0-9]{16}$/u.test(row?.details?.task_id?.sha256_16 || "")
  ? row.details.task_id.sha256_16.slice(0, 6) : "unknown";
const ms = (row) => Date.parse(row?.ts || "");
const stamp = (time) => Number.isFinite(time) ? new Date(time + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ") : "unknown";
const seconds = (value) => Number.isFinite(value) ? (value / 1000).toFixed(1) : "unknown";
const minutes = (value) => Number.isFinite(value) ? (value / 60_000).toFixed(1) : "unknown";
const percentile = (values, q) => values.length ? [...values].sort((a, b) => a - b)[Math.round(q * (values.length - 1))] : null;
const numeric = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const chart = (map) => entries(map).map(([key, value]) => `- ${key}: ${value}`);
const field = (row, name) => safe(row?.details?.[name]);
const isContact = (row) => row.module === "active_touch" && /^workflow_contact_send\.(?:started|finished|failed)$/u.test(row.event);
const isResult = (row) => row.module === "active_touch" && /^workflow_contact_send\.(?:finished|failed)$/u.test(row.event);

async function analyzeZipBuffers(buffers, options = {}) {
  const input = Array.isArray(buffers) ? buffers : [buffers];
  const rows = new Map();
  const replies = new Map();
  const bills = new Map();
  let summary = null;
  let environment = null;
  for (const buffer of input) {
    const zip = await JSZip.loadAsync(buffer);
    for (const [rawName, item] of Object.entries(zip.files)) {
      if (item.dir) continue;
      const name = rawName.replaceAll("\\", "/");
      const kind = MAIN_LOG.test(name) ? "main" : REPLY_LOG.test(name) ? "reply" : BILL.test(name) ? "bill"
        : name === "summary.json" ? "summary" : name === "environment.json" ? "environment" : null;
      if (!kind) continue;
      const source = await item.async("string");
      if (kind === "summary" || kind === "environment" || kind === "bill") {
        let data;
        try { data = JSON.parse(source.replace(/^\uFEFF/u, "")); } catch { continue; }
        if (kind === "summary") summary ||= data;
        else if (kind === "environment") environment ||= data;
        else bills.set(name, data);
        continue;
      }
      for (const line of source.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line.replace(/^\uFEFF/u, "")); } catch { continue; }
        if (!row || typeof row.event !== "string" || !Number.isSafeInteger(row.seq) || typeof row.run_id !== "string") continue;
        const key = `${row.run_id}:${row.seq}`;
        (kind === "main" ? rows : replies).set(key, row);
      }
    }
  }
  const runGroups = new Map();
  for (const row of rows.values()) {
    if (!runGroups.has(row.run_id)) runGroups.set(row.run_id, []);
    runGroups.get(row.run_id).push(row);
  }
  const runs = [...runGroups].map(([id, group]) => ({ id, group: group.sort((a, b) => a.seq - b.seq), first: ms(group[0]) }))
    .sort((a, b) => a.first - b.first || a.id.localeCompare(b.id));
  const ordered = runs.flatMap((run) => run.group);
  const replyRows = [...replies.values()].sort((a, b) => ms(a) - ms(b) || a.seq - b.seq);
  const allTimes = ordered.map(ms).filter(Number.isFinite);
  const first = allTimes.reduce((earliest, time) => Math.min(earliest, time), Infinity);
  const last = allTimes.reduce((latest, time) => Math.max(latest, time), -Infinity);
  const levels = new Map();
  for (const row of ordered) count(levels, safe(row.level));
  const out = ["# 诊断时间线", "", "## 包概况",
    `- 版本：${safe(summary?.build?.edition)} / ${safe(summary?.build?.buildId)} / ${safe(summary?.diagnostics?.environment?.app?.version)}`];
  for (const display of summary?.diagnostics?.environment?.displays || []) {
    const bounds = display?.bounds || {};
    out.push(`- 屏幕：${numeric(bounds.width) ?? "?"}×${numeric(bounds.height) ?? "?"}，scale_factor ${numeric(display.scale_factor) ?? "?"}`);
  }
  if (environment) out.push(`- 采集 profile：${safe(environment.profile)}`);
  if (summary?.app) {
    const app = summary.app;
    out.push(`- app：业务 ${safe(app.version)}；底座 ${safe(app.base_version)}；${safe(app.edition)} / ${safe(app.data_profile)}；build ${safe(app.build_id)} / ${safe(app.build_commit)}；源码脏 ${app.source_dirty === true}；已打包 ${app.packaged === true}；组件 ${safe(app.component?.version)} / ${safe(app.component?.id)}；健康 ${app.component?.healthy === true}`);
  } else out.push("- app：该构建未记录");
  if (summary?.wechat) out.push(`- 微信版本：${safe(summary.wechat.version)}（${safe(summary.wechat.source)}）；出现过 ${Array.isArray(summary.wechat.versions_seen) ? summary.wechat.versions_seen.length : 0} 个版本`);
  else out.push("- 微信版本：该构建未记录");
  for (const version of Array.isArray(summary?.wechat?.versions_seen) ? summary.wechat.versions_seen : []) {
    out.push(`  - ${safe(version.version)}：${safe(version.first_ts)} → ${safe(version.last_ts)}；${numeric(version.count) ?? "?"} 次`);
  }
  if (summary?.display) out.push(`- 导出时显示器：${numeric(summary.display.count) ?? "?"}；主屏索引 ${numeric(summary.display.primary) ?? "?"}`);
  else out.push("- 导出时显示器：该构建未记录");
  for (const [index, display] of (Array.isArray(summary?.display?.displays) ? summary.display.displays : []).entries()) {
    const bounds = display.bounds || {}, work = display.work_area || {};
    out.push(`  - 屏幕 ${index}：${numeric(bounds.width) ?? "?"}×${numeric(bounds.height) ?? "?"} @ ${numeric(bounds.x) ?? "?"},${numeric(bounds.y) ?? "?"}；工作区 ${numeric(work.width) ?? "?"}×${numeric(work.height) ?? "?"}；scale_factor ${numeric(display.scale_factor) ?? "?"}；旋转 ${numeric(display.rotation) ?? "?"}；内置 ${display.internal === true}`);
  }
  if (summary?.feedback_latest) out.push(`- 最新反馈：${safe(summary.feedback_latest.id)} / ${safe(summary.feedback_latest.created_at)} / ${safe(summary.feedback_latest.delivery)} / ${safe(summary.feedback_latest.status)}`);
  else out.push("- 最新反馈：该构建未记录");
  if (summary?.log_coverage) out.push(`- 日志覆盖：${numeric(summary.log_coverage.file_count) ?? "?"} 个文件，${numeric(summary.log_coverage.total_bytes) ?? "?"} 字节；${(Array.isArray(summary.log_coverage.runs) ? summary.log_coverage.runs : []).filter((run) => run.rotated_prefix === true).length} 个 run 前段被轮转`);
  else out.push("- 日志覆盖：该构建未记录");
  for (const run of Array.isArray(summary?.log_coverage?.runs) ? summary.log_coverage.runs : []) {
    out.push(`  - run ${compact(run.run_id)}…：seq ${numeric(run.first_seq) ?? "?"}–${numeric(run.last_seq) ?? "?"}；${safe(run.first_ts)} → ${safe(run.last_ts)}；前段被轮转 ${run.rotated_prefix === true}`);
  }
  let lastWechatVersion = "";
  for (const row of ordered) {
    const version = row?.details?.window_wechat_version;
    if (typeof version === "string" && /^\d+(\.\d+){1,3}$/u.test(version) && version !== lastWechatVersion) {
      out.push(`- 微信窗口版本变化：${stamp(ms(row))} → ${version}`);
      lastWechatVersion = version;
    }
  }
  for (const run of runs) {
    const start = run.group[0].seq;
    const end = run.group.at(-1).seq;
    out.push(`- run ${compact(run.id)}…：seq ${start}–${end}${start > 1 ? `；本 run 前 ${start - 1} 行已被轮转覆盖` : ""}`);
  }
  out.push(`- 时间：${stamp(first)} → ${stamp(last)}（UTC+8），${((last - first) / 3600_000).toFixed(1)} 小时`);
  out.push(`- 总行数 ${ordered.length}；${entries(levels).map(([k, v]) => `${k} ${v}`).join("、")}；send_stage ${(100 * ordered.filter((r) => r.event === "send_stage").length / (ordered.length || 1)).toFixed(1)}%`);

  const contacts = ordered.filter(isContact);
  const results = ordered.filter(isResult);
  const sessions = [];
  for (const row of contacts) {
    const time = ms(row);
    let segment = sessions.at(-1);
    if (!segment || time - segment.last > 120_000) {
      segment = { first: time, last: time, starts: 0, sent: 0, rules: new Map(), tasks: new Set() };
      sessions.push(segment);
    }
    segment.last = time;
    if (row.event.endsWith("started")) { segment.starts++; segment.tasks.add(taskHash(row)); }
    if (row.event.endsWith("finished") && field(row, "outcome") === "sent_verified") segment.sent++;
    if (row.event.endsWith("failed") && field(row, "rule_id") !== "unknown") count(segment.rules, field(row, "rule_id"));
  }
  out.push("", "## 活跃时段");
  for (const [index, segment] of sessions.entries()) out.push(`- ${index + 1}. ${stamp(segment.first)} → ${stamp(segment.last)}；${minutes(segment.last - segment.first)} 分钟；尝试 ${segment.starts}；sent_verified ${segment.sent}；规则 ${entries(segment.rules).map(([k, v]) => `${k}:${v}`).join(", ") || "无"}；任务 ${[...segment.tasks].join(", ") || "unknown"}`);
  const activeMs = sessions.reduce((sum, segment) => sum + segment.last - segment.first, 0);
  const sentTotal = sessions.reduce((sum, segment) => sum + segment.sent, 0);
  out.push(`- 合计 ${minutes(activeMs)} 分钟；平均每个 sent_verified ${seconds(activeMs / sentTotal)} 秒`);

  const outcomes = new Map(), sideEffects = new Map(), attempts = new Map();
  for (const row of results) {
    count(outcomes, field(row, "outcome"));
    count(sideEffects, field(row, "side_effect"));
    count(attempts, String(row.details?.send_attempted === true));
  }
  out.push("", "## 发送状态", ...chart(new Map(entries(outcomes).filter(([key]) => key !== "outcome_unknown"))), `- outcome_unknown: ${outcomes.get("outcome_unknown") || 0}`, `- side_effect：${entries(sideEffects).map(([k, v]) => `${k} ${v}`).join("、")}`, `- send_attempted：${entries(attempts).map(([k, v]) => `${k} ${v}`).join("、")}`);

  const codes = new Map(), rules = new Map(), stops = new Map(), executorFails = new Map();
  for (const row of ordered) {
    if (row.event === "workflow_contact_send.failed") {
      if (row.code) count(codes, safe(row.code));
      if (row.details?.rule_id) count(rules, field(row, "rule_id"));
    }
    if (row.event === "task.global_stop") count(stops, safe(row.code || row.details?.reason));
    if (row.event === "executor.failed") count(executorFails, safe(row.code));
  }
  out.push("", "## 原因与规则", "- code", ...chart(codes), "- rule_id", ...chart(rules), "- task.global_stop", ...chart(stops), "- executor.failed", ...chart(executorFails));

  const streaks = new Map(), current = { key: null, length: 0 };
  function closeStreak() {
    if (current.key) {
      const stat = streaks.get(current.key) || { max: 0, bins: [0, 0, 0, 0] };
      stat.max = Math.max(stat.max, current.length);
      stat.bins[current.length === 1 ? 0 : current.length < 5 ? 1 : current.length < 10 ? 2 : 3]++;
      streaks.set(current.key, stat);
    }
  }
  for (const row of results) {
    const failed = row.event.endsWith("failed") || row.details?.ok === false;
    const key = failed ? safe(row.details?.rule_id || row.code) : null;
    if (key !== current.key) { closeStreak(); current.key = key; current.length = 0; }
    if (key) current.length++;
  }
  closeStreak();
  out.push("", "## 连续失败");
  for (const [key, stat] of [...streaks].sort((a, b) => b[1].max - a[1].max)) out.push(`- ${key}：最长 ${stat.max}；串长 1 / 2–4 / 5–9 / ≥10 = ${stat.bins.join(" / ")}`);

  const durations = new Map(), executorActions = new Map();
  function addDuration(key, value) { if (numeric(value) === null) return; if (!durations.has(key)) durations.set(key, []); durations.get(key).push(value); }
  for (const row of ordered) {
    if (row.event === "send_stage" && (row.phase === "finish" || row.details?.phase === "finish")) addDuration(`${field(row, "stage")} / ${row.details?.ok === true ? "成功" : "失败"}`, row.details?.elapsed_ms ?? row.duration_ms);
    if (row.event === "workflow_contact_send.finished") addDuration("workflow_contact_send.finished", row.duration_ms);
    if (row.event.startsWith("executor.")) {
      count(executorActions, `${safe(row.event)} / ${field(row, "action")}`);
      addDuration(`executor.${field(row, "action")}`, row.duration_ms);
    }
  }
  out.push("", "## 步骤耗时（ms）");
  for (const [key, values] of [...durations].sort((a, b) => a[0].localeCompare(b[0]))) out.push(`- ${key}：n ${values.length}，p50 ${percentile(values, .5)}，p90 ${percentile(values, .9)}，max ${Math.max(...values)}，累计 ${minutes(values.reduce((a, b) => a + b, 0))} 分钟`);
  out.push("- executor 事件 × action", ...chart(executorActions));

  const globalStops = ordered.filter((r) => r.event === "task.global_stop");
  const starts = ordered.filter((r) => r.event === "start.started");
  const requeues = ordered.filter((r) => r.event === "touch.skipped_requeued");
  const manualPauses = ordered.filter((r) => r.event === "pause.started" && field(r, "trigger_code") === "user");
  out.push("", "## 全局暂停与恢复");
  for (const row of globalStops) {
    const next = starts.find((start) => ms(start) > ms(row));
    out.push(`- ${stamp(ms(row))}：${safe(row.code || row.details?.reason)}，任务 ${taskHash(row)}；到下次启动 ${seconds(next ? ms(next) - ms(row) : NaN)} 秒`);
  }
  out.push(`- classification.unknown_reason_paused：${ordered.filter((r) => r.event === "classification.unknown_reason_paused").length}`);
  for (const row of requeues) {
    const prior = results.filter((result) => ms(result) < ms(row)).at(-1);
    out.push(`- ${stamp(ms(row))} touch.skipped_requeued：重新加入 ${numeric(row.details?.retried_count) ?? 0}，排除 ${numeric(row.details?.excluded_count) ?? 0}；距上次发送结束 ${minutes(prior ? ms(row) - ms(prior) : NaN)} 分钟`);
  }
  for (const row of manualPauses) {
    const next = starts.find((start) => ms(start) > ms(row));
    out.push(`- ${stamp(ms(row))} 手动暂停（${field(row, "previous_phase")}）→ 下次启动 ${seconds(next ? ms(next) - ms(row) : NaN)} 秒；启动前状态 ${next ? field(next, "previous_phase") : "unknown"}`);
  }

  const startStatuses = new Map();
  for (const row of ordered.filter((r) => r.event === "start.finished")) count(startStatuses, field(row, "status"));
  const replyPaused = replyRows.filter((r) => r.event === "paused");
  const pausedCodes = new Map();
  for (const row of replyPaused) count(pausedCodes, safe(row.code));
  out.push("", "## 人工操作", `- start.started ${starts.length}；start.finished：${entries(startStatuses).map(([k, v]) => `${k} ${v}`).join("、")}`, `- 重新加入 ${requeues.length}`, `- 自动回复 paused（间接证据）${replyPaused.length}：${entries(pausedCodes).map(([k, v]) => `${k} ${v}`).join("、")}`);
  const pauseTriggers = new Map();
  const pauseTraceTriggers = new Map();
  for (const row of ordered.filter((r) => r.event === "pause.started" && r.trace_id)) {
    pauseTraceTriggers.set(row.trace_id, field(row, "trigger_code"));
  }
  for (const row of ordered.filter((r) => r.event.startsWith("pause."))) {
    count(pauseTriggers, `${safe(row.event)} / ${field(row, "trigger_code") === "unknown"
      ? pauseTraceTriggers.get(row.trace_id) || "unknown" : field(row, "trigger_code")}`);
  }
  out.push(`- pause.*：${entries(pauseTriggers).map(([k, v]) => `${k} ${v}`).join("、") || "该构建未记录"}`);
  for (const event of ["task.retry_requested", "task.retry_all_requested", "window_closing", "quit_requested", "floating.close_redirected", "control.disposed"]) {
    const matching = ordered.filter((row) => row.event === event);
    out.push(`- ${event}: ${matching.length}${event.startsWith("task.retry") ? `；and_start_requested ${matching.filter((row) => row.details?.and_start_requested === true).length}` : ""}`);
  }
  for (const row of replyPaused) out.push(`- ${stamp(ms(row))} paused / ${safe(row.code)}（间接证据）`);

  const traces = new Map();
  for (const row of contacts.filter((r) => r.event.endsWith("started") && r.trace_id)) traces.set(row.trace_id, []);
  for (const row of ordered) if (traces.has(row.trace_id) && row.event === "send_stage") traces.get(row.trace_id).push(`${field(row, "stage")}:${safe(row.phase || row.details?.phase)}`);
  const executorParents = new Set(ordered.filter((r) => r.event === "executor.started" && r.parent_trace_id).map((r) => r.parent_trace_id));
  out.push("", "## trace 链", `- 联系人 trace ${traces.size}；executor.started ${ordered.filter((r) => r.event === "executor.started" && r.module === "wechat_adapter").length}；executor 父 trace ${executorParents.size}，匹配联系人 ${[...executorParents].filter((id) => traces.has(id)).length}`);
  const limit = Number.isSafeInteger(options.examples) && options.examples >= 0 ? options.examples : 10;
  for (const row of results.filter((r) => r.event.endsWith("failed")).slice(0, limit)) out.push(`- ${stamp(ms(row))} ${compact(row.trace_id)}：${safe(row.code)} / ${field(row, "rule_id")}；${(traces.get(row.trace_id) || []).join(" > ")}`);

  out.push("", "## run-bill");
  for (const [name, bill] of bills) {
    const sum = bill.summary || {};
    out.push(`- ${compact(name.split("/").at(-2))}：total ${numeric(sum.total) ?? 0}，success ${numeric(sum.success) ?? 0}，skipped ${numeric(sum.skipped) ?? 0}，failed ${numeric(sum.failed) ?? 0}`);
    out.push(`  - reason_counts：${Object.entries(bill.reason_counts || {}).map(([k, v]) => `${safe(k)} ${numeric(v) ?? 0}`).join("、") || "无"}`);
    out.push(`  - rule_counts：${Object.entries(bill.rule_counts || {}).map(([k, v]) => `${safe(k)} ${numeric(v) ?? 0}`).join("、") || "无规则号（T5 之前的构建）"}`);
  }
  const replyCounts = new Map(), mainReplyCounts = new Map();
  for (const row of replyRows) count(replyCounts, `${safe(row.event)} / ${safe(row.code)}`);
  for (const row of ordered.filter((r) => r.event.startsWith("reply."))) count(mainReplyCounts, `${safe(row.event)} / ${safe(row.code)}`);
  out.push("", "## 自动回复", "- auto_reply 日志", ...chart(replyCounts), "- 主日志 reply.*", ...chart(mainReplyCounts));
  return { markdown: `${out.join("\n")}\n`, stats: { rows: ordered.length, runs: runs.length, sessions: sessions.length, results: results.length, sentVerified: outcomes.get("sent_verified") || 0, outcomeUnknown: outcomes.get("outcome_unknown") || 0, rules: Object.fromEntries(rules), streaks: Object.fromEntries(streaks), durations: Object.fromEntries([...durations].map(([k, v]) => [k, { n: v.length, p50: percentile(v, .5), p90: percentile(v, .9), max: Math.max(...v) }])), globalStops: globalStops.length, requeues: requeues.length, bills: bills.size } };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const exampleAt = args.indexOf("--examples");
  let examples;
  if (exampleAt >= 0) {
    examples = Number(args[exampleAt + 1]);
    if (!Number.isSafeInteger(examples) || examples < 0) throw new Error("--examples requires a nonnegative integer");
    args.splice(exampleAt, 2);
  }
  if (!args.length || args.some((arg) => arg.startsWith("--"))) throw new Error("Usage: node scripts/analyze-diagnostics.cjs <zip> [<zip>...] [--examples N]");
  analyzeZipBuffers(args.map((file) => fs.readFileSync(file)), { examples }).then(({ markdown }) => process.stdout.write(markdown)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { analyzeZipBuffers };
