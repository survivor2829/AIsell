const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { publicError, registerContentEngineIpc } = require("./content-engine-ipc.cjs");
const { CHANNELS, publicBatch } = require("./narrated-batch-ipc.cjs");

// Static guard: every code the engine can raise while saving or starting a batch
// must reach the page as its own message. An unmapped code turns into the generic
// "内容引擎暂时不可用，请重试。" and hides a fixable cause such as an unapproved voice.
function pythonFunction(source, name) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^\\s*def ${name}\\(`, "u").test(line));
  assert.ok(start >= 0, `${name} must exist`);
  const indent = lines[start].search(/\S/u);
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() && lines[end].search(/\S/u) <= indent && !/^\s*[)\]}#]/u.test(lines[end]))) end += 1;
  return lines.slice(start + 1, end).join("\n");
}
function callArguments(source, callee) {
  return [...source.matchAll(new RegExp(`\\b${callee}\\(`, "gu"))].map((match) => {
    const args = [];
    let depth = 1; let quote = ""; let current = "";
    for (let index = match.index + match[0].length; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        current += char;
        if (char === "\\") current += source[++index];
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "'" || char === "\"") quote = char;
      else if ("([{".includes(char)) depth += 1;
      else if (")]}".includes(char) && --depth === 0) break;
      else if (char === "," && depth === 1) { args.push(current.trim()); current = ""; continue; }
      current += char;
    }
    return [...args, current.trim()];
  });
}
// Codes computed at runtime, resolved by hand. The formal renderer's capability code is
// creative_render.py FFmpegRenderer.capability: media_tools_unavailable, or the code its
// encoder check raises (media_encoder_unavailable).
const DYNAMIC_CODES = {
  "narrated_production.py:_validate_render_capacity:capability.get('code') or 'media_tools_unavailable'":
    ["media_tools_unavailable", "media_encoder_unavailable"]
};
function raisedCodes(file, functions) {
  const source = fs.readFileSync(path.join(__dirname, "../../sidecars/content-engine/content_engine", file), "utf8");
  return functions.flatMap((name) => {
    const body = pythonFunction(source, name);
    return [...callArguments(body, "require").map((args) => args[1]), ...callArguments(body, "ContentEngineError").map((args) => args[0])]
      .flatMap((literal) => {
        const code = /^['"]([A-Za-z0-9_]+)['"]$/u.exec(literal || "")?.[1];
        const resolved = code ? [code] : DYNAMIC_CODES[`${file}:${name}:${literal}`];
        assert.ok(resolved, `${file}:${name} raises a non-literal code ${literal}; map it explicitly`);
        return resolved;
      });
  });
}
const saveStartCodes = new Set([
  ...raisedCodes("narrated_batch.py", ["save", "start", "_load", "_idle", "_asset_ids", "validate_count", "confirm_script"]),
  ...raisedCodes("creative_domain.py", ["_asset_row", "_brand_row", "_task_row"]),
  // Every start goes through the service wrapper, which probes new materials first.
  ...raisedCodes("service.py", ["_start_narrated_batch", "probe_asset", "_require_media_probe", "_validate_id"]),
  // "确认制作" checks the chosen copy, voice, music and render capacity before it starts.
  ...raisedCodes("narrated_production.py", ["confirm_selections", "_require_unique_footage_capacity",
    "_require_source_duration_upper_bound", "_validate_music_capacity", "_validate_render_capacity"])
]);
for (const expected of ["auto_mix_voice_persona_approval_required", "invalid_narrated_settings", "invalid_narrated_groups",
  "asset_archived", "narrated_batch_busy", "narrated_script_already_confirmed", "asset_not_found",
  "media_metadata_unavailable", "capability_unavailable", "invalid_id", "invalid_narrated_selection",
  "narrated_duration_too_short", "volcengine_tts_not_configured", "narrated_candidate_not_found", "media_encoder_unavailable"]) {
  assert.ok(saveStartCodes.has(expected), `the save/start/confirm scan must see ${expected}`);
}
assert.deepEqual([...saveStartCodes].filter((code) => publicError({ code, message: "x" }).code !== code), [],
  "every save/start/confirm error code the engine raises needs a public message");
const ipcSource = fs.readFileSync(path.join(__dirname, "narrated-batch-ipc.cjs"), "utf8");
const ipcCodes = [...ipcSource.matchAll(/\binvalid\("([A-Za-z0-9_]+)"\)/gu)].map((match) => match[1]);
assert.ok(ipcCodes.includes("invalid_narrated_settings"));
assert.deepEqual([...new Set([...ipcCodes, "invalid_params", "invalid_id", "invalid_voice_persona_id"])]
  .filter((code) => publicError({ code }).code !== code), [], "every batch IPC validation code needs a public message");
// The batch start and confirm handlers call beforeProviderWork, which main.cjs implements;
// its codes reach the same page.
const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
const preflightStart = mainSource.indexOf("const beforeContentProviderWork = async");
assert.ok(preflightStart >= 0, "main.cjs must still define beforeContentProviderWork");
const preflightBody = mainSource.slice(preflightStart, mainSource.indexOf("\n      };", preflightStart));
const preflightCodes = [...preflightBody.matchAll(/\bcode:\s*['"]([A-Za-z0-9_]+)['"]/gu)].map((match) => match[1]);
assert.deepEqual([...preflightCodes].sort(), ["CONTENT_ENGINE_PROVIDER_REFRESH_BUSY", "CONTENT_ENGINE_PROVIDER_REFRESH_FAILED",
  "PROVIDER_GATEWAY_UNAVAILABLE"], "the provider preflight scan must see every code it raises");
assert.deepEqual(preflightCodes.filter((code) => publicError({ code, message: "x" }).code !== code), [],
  "every provider preflight code needs a public message");

async function main() {
  const handlers = new Map();
  const saved = [];
  const started = [];
  const resolved = [];
  const confirmed = [];
  const notifications = [];
  const sender = {};
  const batchId = `narrated_batch_${"a".repeat(32)}`;
  const taskId = `task_${"c".repeat(32)}`;
  const assetId = `asset_${"b".repeat(32)}`;
  const controller = {
    onUpdate: () => () => {},
    saveNarratedBatch: async (p) => { saved.push(p); return { ...p, batch_id: batchId }; },
    getNarratedBatch: async () => ({ batch_id: batchId, task_id: taskId, status: "completed_with_errors", completed_count: 2, target_count: 3 }),
    generateNarratedSamples: async (id) => { started.push(id); return { batch_id: id, task_id: taskId, status: "planning" }; },
    prepareNarratedScripts: async (id) => ({ batch_id: id, status: "planning", script_options: [] }),
    confirmNarratedScript: async (payload) => { confirmed.push(payload); return { batch_id: payload.batch_id, script_confirmation: { script_id: payload.script_id, revision: payload.revision, narration: "用户确认正文" } }; },
    resolveNarratedPlanningOutcome: async (payload) => {
      resolved.push(payload);
      return { batch_id: payload.batch_id, status: "planning", planning_recovery_available: false };
    }
  };
  const mainWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    show: () => undefined,
    focus: () => undefined,
    webContents: sender
  };
  const notificationFactory = (details) => {
    const listeners = new Map();
    const notification = {
      ...details,
      on: (event, listener) => listeners.set(event, listener),
      show: () => notifications.push(notification),
      click: () => listeners.get("click")?.()
    };
    return notification;
  };
  const registration = registerContentEngineIpc({
    electron: {}, ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: (key) => handlers.delete(key) },
    controller, getMainWindow: () => mainWindow,
    diagnosticLogger: { event() {}, recover() {} }, notificationFactory
  });
  const draft = { groups: { opening: [assetId], middle: [], ending: [] }, title: "真实展示", description: "已确认资料", cta: "欢迎咨询", target_count: 6, settings: { voice_persona_id: "natural-life@1" } };
  const invoke = (payload) => handlers.get(CHANNELS.samples)({ sender }, payload);
  await handlers.get(CHANNELS.get)({ sender }, { batch_id: batchId });
  assert.equal(notifications.length, 0, '读取历史失败批次不得弹出新故障通知');
  const token = `${CHANNELS.samples}:${randomUUID()}`;
  assert.equal((await invoke({ draft, clickToken: token })).ok, true);
  assert.equal(saved[0].target_count, 6);
  assert.deepEqual(started, [batchId]);
  const partial = await handlers.get(CHANNELS.get)({ sender }, { batch_id: batchId });
  assert.equal(partial.ok, true);
  assert.equal(notifications.length, 1, "a partial narrated batch must notify the user once");
  assert.match(notifications[0].body, /部分完成/);
  notifications[0].click();
  await handlers.get(CHANNELS.get)({ sender }, { batch_id: batchId });
  assert.equal(notifications.length, 1, "re-reading the same batch state must not duplicate notifications");
  assert.equal((await invoke({ draft, clickToken: token })).code, "trusted_user_click_required");
  assert.equal((await invoke({ draft: { ...draft, target_count: 301 }, clickToken: `${CHANNELS.samples}:${randomUUID()}` })).code, "invalid_narrated_count");
  assert.equal(saved.length, 1);
  assert.equal((await invoke({ draft: { ...draft, absolute_path: "C:\\private\\input.mp4" }, clickToken: `${CHANNELS.samples}:${randomUUID()}` })).code, "invalid_params");
  const resolve = (payload) => handlers.get(CHANNELS.resolve)({ sender }, payload);
  assert.equal((await resolve({
    batch_id: batchId, provider_log_checked: true, resolution: "retry_planning",
    note: "百炼记录中未见成功返回", clickToken: `${CHANNELS.resolve}:${randomUUID()}`
  })).ok, true);
  assert.equal(resolved[0].note, "百炼记录中未见成功返回");
  assert.equal((await resolve({
    batch_id: batchId, user_confirmed_retry: true, resolution: "retry_planning",
    clickToken: `${CHANNELS.resolve}:${randomUUID()}`
  })).ok, true);
  assert.equal(resolved[1].provider_log_checked, false);
  assert.equal(resolved[1].user_confirmed_retry, true);
  assert.equal((await resolve({
    batch_id: batchId, provider_log_checked: false, resolution: "retry_planning",
    note: "已核对", clickToken: `${CHANNELS.resolve}:${randomUUID()}`
  })).code, "narrated_planning_confirmation_required");
  const result = publicBatch({ batch_id: batchId, absolute_path: "C:\\private\\input.mp4", candidates: [{ title: "video", _tracks: {}, shots: [{ asset_id: assetId, source_path: "C:\\private\\input.mp4" }] }] });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(publicBatch({ activity: {
    phase: "analysis", phase_label: "素材理解", overall_percent: 23, phase_percent: 51,
    item_index: 2, item_total: 4, item_name: "课程录像.mp4",
    heartbeat_at: "2026-09-20T10:00:00.000Z", private_detail: "must-not-leak"
  } }).activity, {
    phase: "analysis", phase_label: "素材理解", overall_percent: 23, phase_percent: 51,
    item_index: 2, item_total: 4, item_name: "课程录像.mp4",
    heartbeat_at: "2026-09-20T10:00:00.000Z"
  });
  assert.deepEqual(publicBatch({
    planning_checkpoint: {
      stage: "candidate_planning", completed: 2, total: 4,
      provider_request_id: "private-request-id", local_path: "C:\\private\\checkpoint.json"
    },
    internal_planning_state: "must-not-leak"
  }), {
    planning_checkpoint: { stage: "candidate_planning", completed: 2, total: 4 }
  });
  const scriptId = `narrated_candidate_${"c".repeat(32)}`;
  const confirm = (payload) => handlers.get(CHANNELS.confirm)({ sender }, payload);
  const confirmedResult = await confirm({ batch_id: batchId, script_id: scriptId, revision: 2, clickToken: `${CHANNELS.confirm}:${randomUUID()}` });
  assert.equal(confirmedResult.data.script_confirmation.narration, "用户确认正文");
  assert.equal(confirmed[0].revision, 2);
  assert.equal((await confirm({ batch_id: batchId, script_id: scriptId, revision: 0, clickToken: `${CHANNELS.confirm}:${randomUUID()}` })).ok, false);
  const secondScriptId = `narrated_candidate_${"d".repeat(32)}`;
  const selections = [{ script_id: scriptId, revision: 2, count: 2 }, { script_id: secondScriptId, revision: 1, count: 1 }];
  assert.equal((await confirm({ batch_id: batchId, selections, clickToken: `${CHANNELS.confirm}:${randomUUID()}` })).ok, true);
  assert.deepEqual(confirmed.at(-1).selections, selections);
  const beforeInvalid = confirmed.length;
  for (const invalidSelection of [[selections[0], selections[0]], [{ ...selections[0], count: 0 }],
    [{ ...selections[0], count: 300 }, selections[1]]]) {
    assert.equal((await confirm({ batch_id: batchId, selections: invalidSelection, clickToken: `${CHANNELS.confirm}:${randomUUID()}` })).ok, false);
  }
  assert.equal(confirmed.length, beforeInvalid, "Invalid selections must not enqueue work");
  const multiPublic = publicBatch({ script_selections: selections, production_jobs: [{ production_index: 1, status: "skipped", error: "素材不足" }], export_ready: true, _exported_candidates: { file: "C:\\private\\output.mp4" } });
  assert.deepEqual(multiPublic.script_selections, selections);
  assert.equal(multiPublic.export_ready, true);
  assert.equal(multiPublic._exported_candidates, undefined);
  const brief = { brief_version: 1, script_action: "expand", target_audience: "物业保洁负责人", expression: "这位学员是小陈，想介绍他在现场认识设备部件的学习过程。", advantages: "提供现场试用", customer_pain_points: "担心地面不适用" };
  const scriptsResult = await handlers.get(CHANNELS.scripts)({ sender }, { draft: { ...draft, ...brief, settings: { workflow_version: 2, music_mode: "auto", music_track_ids: [] } }, clickToken: `${CHANNELS.scripts}:${randomUUID()}` });
  assert.equal(scriptsResult.ok, true);
  assert.deepEqual(scriptsResult.data.script_options, []);
  for (const [key, value] of Object.entries(brief)) assert.equal(saved.at(-1)[key], value);
  const briefResult = publicBatch({ ...brief, brief_suggestions: { expression: "围绕现场演示介绍学习内容" },
    script_options: [{ framework: "problem_solution_cta", summary: "现场试用再选型", opening_example: "担心不适用？", _brief_review_hash: "private" }] });
  assert.equal(briefResult.script_options[0].framework, "problem_solution_cta");
  assert.equal(briefResult.script_action, "expand", "Reopening a draft preserves the explicitly chosen editing action.");
  assert.equal(briefResult.brief_suggestions.expression, "围绕现场演示介绍学习内容");
  assert.equal(briefResult.script_options[0]._brief_review_hash, undefined);
  // CE3: the strict visual review switch is a boolean setting that reaches the engine and comes back.
  const save = (settings) => handlers.get(CHANNELS.save)({ sender }, { ...draft, settings });
  for (const value of [true, false]) {
    assert.equal((await save({ workflow_version: 2, strict_visual_review: value })).ok, true);
    assert.equal(saved.at(-1).settings.strict_visual_review, value);
  }
  assert.equal((await save({ workflow_version: 2 })).ok, true);
  assert.equal("strict_visual_review" in saved.at(-1).settings, false, "an older batch without the switch keeps the default");
  const savedBefore = saved.length;
  for (const value of ["true", 1, null, {}]) {
    const refused = await save({ workflow_version: 2, strict_visual_review: value });
    assert.equal(refused.code, "invalid_narrated_settings", `strict_visual_review=${JSON.stringify(value)} must be refused`);
  }
  assert.equal(saved.length, savedBefore, "an invalid switch never reaches the engine");
  const strictConfirm = await confirm({ batch_id: batchId, selections: selections.slice(0, 1),
    settings: { workflow_version: 2, strict_visual_review: true }, clickToken: `${CHANNELS.confirm}:${randomUUID()}` });
  assert.equal(strictConfirm.ok, true);
  assert.equal(confirmed.at(-1).settings.strict_visual_review, true);
  const confirmedBefore = confirmed.length;
  assert.equal((await confirm({ batch_id: batchId, selections: selections.slice(0, 1),
    settings: { workflow_version: 2, strict_visual_review: "yes" }, clickToken: `${CHANNELS.confirm}:${randomUUID()}` })).code,
    "invalid_narrated_settings");
  assert.equal(confirmed.length, confirmedBefore);
  assert.deepEqual(publicBatch({ settings: { strict_visual_review: true, private_detail: "x" },
    candidates: [{ candidate_id: "c", review_mode: "follow_script", review_reason: "internal", _run_id: "r" }] }),
  { settings: { strict_visual_review: true }, candidates: [{ candidate_id: "c", review_mode: "follow_script" }] });
  registration.dispose();
  console.log("narrated batch IPC self-check passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
