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
  make("z-early", 5, 3, "task.global_stop", { code: "task_context_mismatch" }),
  make("z-early", 6, 3.5, "start.started"),
  make("z-early", 7, 6, "touch.skipped_requeued", { details: { retried_count: 2, excluded_count: 1 } }),
  make("z-early", 8, 7, "workflow_contact_send.started", { trace_id: "trace-b" }),
  make("z-early", 9, 8, "workflow_contact_send.finished", { trace_id: "trace-b", duration_ms: 11000, details: { outcome: "sent_verified", side_effect: "confirmed", send_attempted: true, ok: true } })
];
const late = [
  make("a-late", 1, 12, "workflow_contact_send.started", { trace_id: "trace-c" }),
  make("a-late", 2, 13, "workflow_contact_send.failed", { trace_id: "trace-c", code: "search_result_identity_unverified", details: { rule_id: "search-r014", outcome: "not_attempted", side_effect: "none", send_attempted: false, ok: false } })
];
const durations = Array.from({ length: 10 }, (_, i) => make("z-early", 20 + i, 9, "send_stage", { phase: "finish", details: { stage: "sample", ok: true, elapsed_ms: (i + 1) * 100 } }));

async function fixture() {
  const one = new JSZip();
  one.file("diagnostics.jsonl.10", line([...durations, ...late]));
  one.file("diagnostics.jsonl.1", line(early));
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
  assert.equal(stats.rules["search-r008"], 1);
  assert.equal(stats.rules["search-r014"], 1);
  assert.equal(stats.streaks["search-r008"].max, 1);
  assert.deepEqual(stats.durations["sample / 成功"], { n: 10, p50: 600, p90: 900, max: 1000 });
  assert.equal(stats.globalStops, 1);
  assert.equal(stats.requeues, 1);
  assert.ok(markdown.indexOf("run z-early") < markdown.indexOf("run a-late"), "runs sort by first timestamp, not id");
  assert.match(markdown, /到下次启动 30\.0 秒/u);
  assert.match(markdown, /重新加入 2，排除 1/u);
  assert.match(markdown, /outcome_unknown: 0/u);
  assert.match(markdown, /paused \/ workflow_paused: 1/u);
  assert.match(markdown, /无规则号（T5 之前的构建）/u);
  assert.doesNotMatch(markdown, /private-contact-name|private-chat-text/u);

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
    assert.equal(all.includes(temp), false);
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
    const secondZip = await JSZip.loadAsync(fs.readFileSync(path.join(secondOutput, fs.readdirSync(secondOutput)[0])));
    const secondEnv = JSON.parse(await secondZip.file("environment.json").async("string"));
    assert.equal(secondEnv.profile, "delivery", "auto must pick the latest diagnostics.jsonl");
    assert.equal(secondEnv.otherProfileExists, true);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log("diagnostics analyzer self-check passed");
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
