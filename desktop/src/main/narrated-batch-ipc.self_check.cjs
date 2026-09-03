const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { registerContentEngineIpc } = require("./content-engine-ipc.cjs");
const { CHANNELS, publicBatch } = require("./narrated-batch-ipc.cjs");

async function main() {
  const handlers = new Map();
  const saved = [];
  const started = [];
  const sender = {};
  const batchId = `narrated_batch_${"a".repeat(32)}`;
  const assetId = `asset_${"b".repeat(32)}`;
  const controller = {
    onUpdate: () => () => {},
    saveNarratedBatch: async (p) => { saved.push(p); return { ...p, batch_id: batchId }; },
    generateNarratedSamples: async (id) => { started.push(id); return { batch_id: id, status: "planning" }; }
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
  const result = publicBatch({ batch_id: batchId, absolute_path: "C:\\private\\input.mp4", candidates: [{ title: "video", _tracks: {}, shots: [{ asset_id: assetId, source_path: "C:\\private\\input.mp4" }] }] });
  assert.equal(JSON.stringify(result).includes("private"), false);
  registration.dispose();
  console.log("narrated batch IPC self-check passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
