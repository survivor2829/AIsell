const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { registerContentEngineIpc } = require("./content-engine-ipc.cjs");
const { CHANNELS, publicBatch } = require("./narrated-batch-ipc.cjs");

async function main() {
  const handlers = new Map();
  const saved = [];
  const started = [];
  const resolved = [];
  const confirmed = [];
  const sender = {};
  const batchId = `narrated_batch_${"a".repeat(32)}`;
  const assetId = `asset_${"b".repeat(32)}`;
  const controller = {
    onUpdate: () => () => {},
    saveNarratedBatch: async (p) => { saved.push(p); return { ...p, batch_id: batchId }; },
    generateNarratedSamples: async (id) => { started.push(id); return { batch_id: id, status: "planning" }; },
    prepareNarratedScripts: async (id) => ({ batch_id: id, status: "planning", script_options: [] }),
    confirmNarratedScript: async (payload) => { confirmed.push(payload); return { batch_id: payload.batch_id, script_confirmation: { script_id: payload.script_id, revision: payload.revision, narration: "用户确认正文" } }; },
    resolveNarratedPlanningOutcome: async (payload) => {
      resolved.push(payload);
      return { batch_id: payload.batch_id, status: "planning", planning_recovery_available: false };
    }
  };
  const registration = registerContentEngineIpc({
    electron: {}, ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: (key) => handlers.delete(key) },
    controller, getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => true, webContents: sender }),
    diagnosticLogger: { event() {}, recover() {} }
  });
  const draft = { groups: { opening: [assetId], middle: [], ending: [] }, title: "真实展示", description: "已确认资料", cta: "欢迎咨询", target_count: 6, settings: { voice_persona_id: "natural-life@1" } };
  const invoke = (payload) => handlers.get(CHANNELS.samples)({ sender }, payload);
  const token = `${CHANNELS.samples}:${randomUUID()}`;
  assert.equal((await invoke({ draft, clickToken: token })).ok, true);
  assert.equal(saved[0].target_count, 6);
  assert.deepEqual(started, [batchId]);
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
    batch_id: batchId, provider_log_checked: false, resolution: "retry_planning",
    note: "已核对", clickToken: `${CHANNELS.resolve}:${randomUUID()}`
  })).code, "narrated_planning_confirmation_required");
  const result = publicBatch({ batch_id: batchId, absolute_path: "C:\\private\\input.mp4", candidates: [{ title: "video", _tracks: {}, shots: [{ asset_id: assetId, source_path: "C:\\private\\input.mp4" }] }] });
  assert.equal(JSON.stringify(result).includes("private"), false);
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
  const brief = { brief_version: 1, target_audience: "物业保洁负责人", expression: "这位学员是小陈，想介绍他在现场认识设备部件的学习过程。", advantages: "提供现场试用", customer_pain_points: "担心地面不适用" };
  const scriptsResult = await handlers.get(CHANNELS.scripts)({ sender }, { draft: { ...draft, ...brief, settings: { workflow_version: 2, music_track_ids: [] } }, clickToken: `${CHANNELS.scripts}:${randomUUID()}` });
  assert.equal(scriptsResult.ok, true);
  assert.deepEqual(scriptsResult.data.script_options, []);
  for (const [key, value] of Object.entries(brief)) assert.equal(saved.at(-1)[key], value);
  const briefResult = publicBatch({ ...brief, brief_suggestions: { expression: "围绕现场演示介绍学习内容" },
    script_options: [{ framework: "problem_solution_cta", summary: "现场试用再选型", opening_example: "担心不适用？", _brief_review_hash: "private" }] });
  assert.equal(briefResult.script_options[0].framework, "problem_solution_cta");
  assert.equal(briefResult.brief_suggestions.expression, "围绕现场演示介绍学习内容");
  assert.equal(briefResult.script_options[0]._brief_review_hash, undefined);
  registration.dispose();
  console.log("narrated batch IPC self-check passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
