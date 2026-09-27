const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const JSZip = require("jszip");
const { analyzeZipBuffers } = require("./analyze-diagnostics.cjs");

const make = (run_id, seq, minute, event, extra = {}) => ({
  v: 1, ts: new Date(Date.UTC(2026, 8, 20) + minute * 60_000).toISOString(), run_id, seq,
  level: event.endsWith("failed") ? "error" : "info", module: "active_touch", event, ...extra
});
const line = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
const publicLines = (rows) => line(rows.map((row) => {
  const details = { ...row.details };
  delete details.private;
  return { ...row, details };
}));
const early = [
  make("z-early", 3, 1, "workflow_contact_send.started", { trace_id: "trace-a", details: { task_id: { sha256_16: "abcdef0123456789" }, private: "private-contact-name" } }),
  make("z-early", 4, 2, "workflow_contact_send.failed", { trace_id: "trace-a", code: "search_result_identity_unverified", details: { rule_id: "search-r008", outcome: "not_attempted", side_effect: "none", send_attempted: false, ok: false, private: "private-chat-text" } }),
  make("z-early", 5, 2.5, "workflow_contact_send.failed", { trace_id: "trace-a", code: "search_result_identity_unverified", details: { rule_id: "search-r008", outcome: "not_attempted", side_effect: "none", send_attempted: false, ok: false } }),
  make("z-early", 6, 3, "task.global_stop", { code: "task_context_mismatch" }),
  make("z-early", 7, 3.5, "start.started", { details: { previous_phase: "needs_attention" } }),
  make("z-early", 8, 6, "touch.skipped_requeued", { details: { retried_count: 2, excluded_count: 1 } }),
  make("z-early", 9, 7, "workflow_contact_send.started", { trace_id: "trace-b" }),
  make("z-early", 10, 8, "workflow_contact_send.finished", { trace_id: "trace-b", duration_ms: 11000, details: { outcome: "sent_verified", side_effect: "confirmed", send_attempted: true, ok: true } }),
  make("z-early", 11, 8.5, "workflow_contact_send.failed", { trace_id: "trace-d", code: "search_result_identity_unverified", details: { rule_id: "search-r008", outcome: "not_attempted", side_effect: "none", send_attempted: false, ok: false } })
];
const late = [
  make("a-late", 1, 12, "workflow_contact_send.started", { trace_id: "trace-c" }),
  make("a-late", 2, 13, "workflow_contact_send.failed", { trace_id: "trace-c", code: "search_result_identity_unverified", details: { rule_id: "search-r014", outcome: "not_attempted", side_effect: "none", send_attempted: false, ok: false } }),
  make("a-late", 3, 14, "pause.started", { module: "wechat_workflow", trace_id: "0123456789abcdef01234567", details: { trigger_code: "user", previous_phase: "needs_attention" } }),
  make("a-late", 4, 14.5, "pause.finished", { module: "wechat_workflow", trace_id: "0123456789abcdef01234567", details: { stage: "paused" } }),
  make("a-late", 5, 16, "start.started", { module: "wechat_workflow", details: { previous_phase: "paused" } }),
  make("a-late", 6, 17, "task.retry_requested", { module: "wechat_workflow", details: { previous_status: "needs_attention", and_start_requested: true } }),
  make("a-late", 7, 18, "task.retry_all_requested", { module: "wechat_workflow", details: { task_count: 2, and_start_requested: false } }),
  make("a-late", 8, 19, "window_closing", { module: "app" }),
  make("a-late", 9, 20, "quit_requested", { module: "app" }),
  make("a-late", 10, 21, "floating.close_redirected", { module: "wechat_workflow" }),
  make("a-late", 11, 22, "control.disposed", { module: "wechat_workflow" }),
  make("a-late", 12, 23, "send_stage", { details: { window_wechat_version: "4.1.13.65" } }),
  make("a-late", 13, 24, "send_stage", { details: { window_wechat_version: "4.1.15.13" } })
];
const durations = Array.from({ length: 10 }, (_, i) => make("z-early", 20 + i, 9, "send_stage", { phase: "finish", details: { stage: "sample", ok: true, elapsed_ms: (i + 1) * 100 } }));

async function fixture() {
  const one = new JSZip();
  one.file("diagnostics.jsonl.10", line([...durations, ...late,
    { v: 1, ts: "2026-09-20T01:25:00.000Z", run_id: "a-late", seq: 14, event: { private: "private-chat-text" } },
    { v: 1, ts: "2026-09-20T01:26:00.000Z", run_id: "a-late", seq: 15 }]));
  one.file("diagnostics.jsonl.1", line(early));
  one.file("summary.json", JSON.stringify({ app: { version: "1.1.54", base_version: "1.1.53", edition: "development", data_profile: "test", build_id: "build-1", build_commit: "abcdef0", source_dirty: false, packaged: true, component: { version: "1.1.54", id: "a".repeat(64), healthy: true } },
    wechat: { version: "4.1.15.13", source: "window_driver", versions_seen: [{ version: "4.1.15.13", first_ts: "2026-09-20T01:00:00.000Z", last_ts: "2026-09-20T02:00:00.000Z", count: 2 }] },
    display: { count: 1, primary: 0, displays: [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work_area: { width: 1920, height: 1040 }, scale_factor: 1.25, rotation: 0, internal: false }] },
    feedback_latest: { id: "12345678-1234-1234-1234-123456789012", created_at: "2026-09-20T02:00:00.000Z", delivery: "sent", status: "resolved" },
    log_coverage: { file_count: 2, total_bytes: 1234, runs: [{ run_id: "12345678-1234-1234-1234-123456789012", first_seq: 3, last_seq: 9, first_ts: "2026-09-20T01:00:00.000Z", last_ts: "2026-09-20T02:00:00.000Z", rotated_prefix: true }] } }));
  one.file("auto_reply\\auto-reply-diagnostics.jsonl", line([{ ...make("reply", 1, 1, "paused", { module: "auto_reply", code: "workflow_paused" }) }]));
  one.file("task-passports/active_touch/bills/run-1/run-bill.json", JSON.stringify({ summary: { total: 2, success: 1, skipped: 1, failed: 0 }, reason_counts: { search_result_identity_unverified: 1 }, rule_counts: {}, failures: [{ customer: "private-contact-name" }] }));
  one.file("failure-evidence/private.json", "private-contact-name");
  for (const name of ["screenshot.png", "task-passports/active_touch/a-1/raw-reading.json", "task-passports/active_touch/a-1/expected.json", "task-passports/active_touch/a-1/events.jsonl"]) one.file(name, "private-chat-text");
  const two = new JSZip();
  two.file("diagnostics.jsonl", line([early[1], early[2]]));
  return [await one.generateAsync({ type: "nodebuffer" }), await two.generateAsync({ type: "nodebuffer" })];
}

async function main() {
  const buffers = await fixture();
  const originalLoad = JSZip.loadAsync;
  const originalFs = new Map();
  const blocked = /^(?:writeFile|appendFile|mkdir|mkdtemp|createWriteStream|copyFile)/u;
  let forbiddenOpened = false;
  JSZip.loadAsync = async (...args) => {
    const zip = await originalLoad.apply(JSZip, args);
    for (const [name, item] of Object.entries(zip.files)) {
      if (/\.png$|raw-reading\.json$|expected\.json$|\/events\.jsonl$|^failure-evidence\//u.test(name)) {
        item.async = async () => { forbiddenOpened = true; throw new Error("forbidden entry opened"); };
      }
    }
    return zip;
  };
  for (const object of [fs, fs.promises]) for (const name of Object.keys(object)) {
    if (blocked.test(name) && typeof object[name] === "function") {
      originalFs.set(`${object === fs ? "fs" : "promises"}:${name}`, object[name]);
      object[name] = () => { throw new Error(`unexpected disk write: ${name}`); };
    }
  }
  assert.ok(originalFs.size >= 10, "write guard must cover sync and promise APIs");
  let result;
  try { result = await analyzeZipBuffers(buffers, { examples: 2 }); }
  finally {
    JSZip.loadAsync = originalLoad;
    for (const [key, value] of originalFs) {
      const [target, name] = key.split(":");
      (target === "fs" ? fs : fs.promises)[name] = value;
    }
  }
  const { markdown, stats } = result;
  assert.equal(forbiddenOpened, false);
  assert.equal(stats.rows, early.length + late.length + durations.length);
  assert.equal(stats.runs, 2);
  assert.equal(stats.sessions, 3);
  assert.equal(stats.sentVerified, 1);
  assert.equal(stats.outcomeUnknown, 0);
  assert.equal(stats.rules["search-r008"], 3);
  assert.equal(stats.rules["search-r014"], 1);
  assert.equal(stats.streaks["search-r008"].max, 2, "a success must separate consecutive failure streaks");
  assert.deepEqual(stats.streaks["search-r008"].bins, [1, 1, 0, 0]);
  assert.deepEqual(stats.durations["sample / 成功"], { n: 10, p50: 600, p90: 900, max: 1000 });
  assert.equal(stats.globalStops, 1);
  assert.equal(stats.requeues, 1);
  assert.ok(markdown.indexOf("run z-early") < markdown.indexOf("run a-late"), "runs sort by first timestamp, not id");
  assert.match(markdown, /到下次启动 30\.0 秒/u);
  assert.match(markdown, /重新加入 2，排除 1/u);
  assert.match(markdown, /outcome_unknown: 0/u);
  assert.match(markdown, /paused \/ workflow_paused: 1/u);
  assert.match(markdown, /pause\.started \/ user 1/u);
  assert.match(markdown, /pause\.finished \/ user 1/u);
  assert.match(markdown, /task\.retry_requested: 1；and_start_requested 1/u);
  assert.match(markdown, /task\.retry_all_requested: 1；and_start_requested 0/u);
  assert.match(markdown, /window_closing: 1/u);
  assert.match(markdown, /quit_requested: 1/u);
  assert.match(markdown, /floating\.close_redirected: 1/u);
  assert.match(markdown, /control\.disposed: 1/u);
  assert.match(markdown, /手动暂停（needs_attention）→ 下次启动 120\.0 秒/u);
  assert.match(markdown, /微信窗口版本变化：.*4\.1\.15\.13/u);
  assert.match(markdown, /日志覆盖：2 个文件/u);
  assert.match(markdown, /最新反馈：12345678/u);
  assert.match(markdown, /屏幕 0：1920×1080/u);
  assert.match(markdown, /微信版本：4\.1\.15\.13/u);
  assert.match(markdown, /run 12345678…：seq 3–9/u);
  assert.match(markdown, /无规则号（T5 之前的构建）/u);
  assert.doesNotMatch(markdown, /private-contact-name|private-chat-text/u);
  const legacy = await analyzeZipBuffers([buffers[1]]);
  assert.match(legacy.markdown, /该构建未记录/u);

  const script = path.resolve(__dirname, "../../tools/remote-diagnostics/Collect-Diagnostics.ps1");
  assert.ok([...fs.readFileSync(script)].every((byte) => byte < 0x80), "collector must remain ASCII-only");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-diagnostics-check-"));
  try {
    const data = path.join(temp, "xiaoxi-active-touch-test", "data");
    for (const relative of ["logs", "auto_reply", "active_touch"]) fs.mkdirSync(path.join(data, relative), { recursive: true });
    fs.writeFileSync(path.join(data, "logs", "diagnostics.jsonl"), publicLines(early));
    fs.writeFileSync(path.join(data, "logs", "diagnostics.jsonl.1"), publicLines(late));
    fs.writeFileSync(path.join(data, "auto_reply", "auto-reply-diagnostics.jsonl"), line([{ ...make("reply", 1, 1, "paused", { module: "auto_reply", code: "workflow_paused" }) }]));
    fs.writeFileSync(path.join(data, "auto_reply", "auto-reply-diagnostics.jsonl.1"), line([{ ...make("reply", 2, 2, "paused", { module: "auto_reply", code: "app_closed" }) }]));
    fs.writeFileSync(path.join(data, "auto_reply", "auto-reply-state.json"), JSON.stringify({ contact_states: { a: {}, b: {} } }));
    fs.writeFileSync(path.join(data, "active_touch", "contacts.json"), JSON.stringify([{ name: "private-contact-name" }]));
    const run = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-OutputRoot", temp, "-NoOpen"], {
      env: { ...process.env, APPDATA: temp }, encoding: "utf8", windowsHide: true, timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
    const output = fs.readdirSync(temp).filter((name) => name.endsWith(".zip"));
    assert.equal(output.length, 1);
    const archive = fs.readFileSync(path.join(temp, output[0]));
    const zip = await JSZip.loadAsync(archive);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    for (const name of ["diagnostics.jsonl", "diagnostics.jsonl.1", "auto_reply/auto-reply-diagnostics.jsonl", "auto_reply/auto-reply-diagnostics.jsonl.1", "environment.json"]) assert.ok(names.includes(name), name);
    assert.ok(names.every((name) => !name.includes("\\")));
    const env = JSON.parse(await zip.file("environment.json").async("string"));
    assert.equal(env.profile, "test");
    assert.equal(env.contactCount, 1);
    assert.equal(env.receptionStateCount, 2);
    const all = (await Promise.all(names.map((name) => zip.file(name).async("string")))).join("\n");
    assert.doesNotMatch(all, /private-contact-name|private-chat-text/u);
    assert.equal(all.includes(JSON.stringify(temp).slice(1, -1)), false,
      "JSON-escaped temporary paths must not enter the archive");
    if ((process.env.USERNAME || "").length >= 4) assert.equal(all.includes(process.env.USERNAME), false);
    const collected = await analyzeZipBuffers([archive]);
    assert.equal(collected.stats.rows, early.length + late.length);

    const delivery = path.join(temp, "xiaoxi-active-touch-delivery", "data", "logs");
    fs.mkdirSync(delivery, { recursive: true });
    const deliveryLog = path.join(delivery, "diagnostics.jsonl");
    fs.writeFileSync(deliveryLog, publicLines(late));
    fs.utimesSync(deliveryLog, new Date("2030-01-01"), new Date("2030-01-01"));
    const secondOutput = path.join(temp, "second-output");
    const second = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-OutputRoot", secondOutput, "-NoOpen"], {
      env: { ...process.env, APPDATA: temp }, encoding: "utf8", windowsHide: true, timeout: 30000
    });
    assert.equal(second.status, 0, second.stderr || second.stdout || String(second.error));
    const secondFiles = fs.readdirSync(secondOutput);
    assert.equal(secondFiles.length, 1, "collector must leave no intermediate directory under OutputRoot");
    assert.match(secondFiles[0], /\.zip$/u);
    const secondZip = await JSZip.loadAsync(fs.readFileSync(path.join(secondOutput, secondFiles[0])));
    const secondEnv = JSON.parse(await secondZip.file("environment.json").async("string"));
    assert.equal(secondEnv.profile, "delivery", "auto must pick the latest diagnostics.jsonl");
    assert.equal(secondEnv.otherProfileExists, true);
    const heldLog = path.join(data, "logs", "diagnostics.jsonl");
    const sharedOutput = path.join(temp, "shared-output");
    const shared = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "$h=[IO.File]::Open($env:XIAOXI_HELD_LOG,[IO.FileMode]::Open,[IO.FileAccess]::Write,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); try { & $env:XIAOXI_COLLECT_SCRIPT -DataRoot $env:XIAOXI_COLLECT_DATA -OutputRoot $env:XIAOXI_COLLECT_OUTPUT -NoOpen } finally { $h.Dispose() }"], {
      env: { ...process.env, APPDATA: temp, XIAOXI_HELD_LOG: heldLog, XIAOXI_COLLECT_SCRIPT: script,
        XIAOXI_COLLECT_DATA: data, XIAOXI_COLLECT_OUTPUT: sharedOutput }, encoding: "utf8", windowsHide: true, timeout: 30000
    });
    assert.equal(shared.status, 0, shared.stderr || shared.stdout || String(shared.error));
    assert.equal(fs.readdirSync(sharedOutput).filter((name) => name.endsWith(".zip")).length, 1,
      "collector must read a log while the application still has it open for writing");
    const failedOutput = path.join(temp, "failed-output");
    const exclusive = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "$h=[IO.File]::Open($env:XIAOXI_HELD_LOG,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::None); try { & $env:XIAOXI_COLLECT_SCRIPT -DataRoot $env:XIAOXI_COLLECT_DATA -OutputRoot $env:XIAOXI_COLLECT_OUTPUT -NoOpen } finally { $h.Dispose() }"], {
      env: { ...process.env, APPDATA: temp, XIAOXI_HELD_LOG: heldLog, XIAOXI_COLLECT_SCRIPT: script,
        XIAOXI_COLLECT_DATA: data, XIAOXI_COLLECT_OUTPUT: failedOutput }, encoding: "utf8", windowsHide: true, timeout: 30000
    });
    assert.match(exclusive.stderr + exclusive.stdout, /Diagnostics archive failed: diagnostics\.jsonl/u,
      "an exclusive lock must fail visibly using only the relative log name");
    assert.deepEqual(fs.readdirSync(failedOutput), [], "a failed collection must remove its partial archive");
    assert.doesNotMatch(exclusive.stderr + exclusive.stdout, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
      "a collection failure must not print the absolute output path");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log("diagnostics analyzer self-check passed");
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
