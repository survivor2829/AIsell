const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function loadTs(name) {
  const filename = path.join(__dirname, name);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: true },
    fileName: filename
  }).outputText;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(__dirname);
  compiled._compile(output, filename);
  return compiled.exports;
}
const { callBatch } = loadTs("batch-studio-api.ts");
const {
  DISCARDED_DRAFT_KEY, PENDING_DRAFT_KEY, createDraftQueue, isDeterministicDraftError, restorePendingDraft
} = loadTs("batch-draft-queue.ts");
const page = fs.readFileSync(path.join(__dirname, "BatchCreativePage.tsx"), "utf8");

function memoryStorage(entries = {}, { failBackup = false } = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => {
      if (failBackup && key === DISCARDED_DRAFT_KEY) throw new Error("quota exceeded");
      map.set(key, String(value));
    },
    removeItem: (key) => { map.delete(key); }
  };
}
const failure = (code, message = "失败原因。") => Object.assign(new Error(message), { code });
const batchId = "narrated_batch_0a89fb41936f449bb671fb030d823ec0";
const monkey = { voice_persona_id: "volc-monkey-brother-2@1", workflow_version: 2 };
const emptyGroups = { opening: [], middle: [], ending: [] };
const draftBatch = { batch_id: batchId, status: "draft", groups: emptyGroups, candidates: [] };
// The cached draft found on the development machine: no materials, pointing at a
// finished batch that has four materials, confirmed copy and one completed work.
const completedBatch = {
  batch_id: batchId, status: "completed", completed_count: 1,
  groups: { opening: [], middle: ["asset_1", "asset_2", "asset_3", "asset_4"], ending: [] },
  script_confirmation: { script_id: "narrated_candidate_1", revision: 1 },
  candidates: [{ status: "completed", generated_video_id: "generated_video_1" }]
};
const pendingRaw = (draft, fingerprint = "fingerprint-1") => JSON.stringify({ draft, fingerprint });
function restorer(storage, { current = draftBatch, getError, saveErrors = [] } = {}) {
  const calls = { get: 0, save: [] };
  const run = (batchIdFilter) => restorePendingDraft({
    storage,
    batchId: batchIdFilter,
    get: async () => { calls.get += 1; if (getError) throw getError; return current; },
    save: async (draft) => {
      calls.save.push(draft);
      const error = saveErrors.shift();
      if (error) throw error;
      return { ...current, ...draft, status: "draft" };
    }
  });
  return { calls, run };
}

async function main() {
  // callBatch keeps the main-process code so the page can tell "retry later" from "never".
  const approvalMessage = "这条视频使用的声音尚未批准或批准已失效，请在「声音与配乐」中改选已批准的声音，或重新试听并批准后再试。";
  global.window = { xiaoxiContent: { batch: { save: async () => ({ ok: false, code: "auto_mix_voice_persona_approval_required", error: approvalMessage }) } } };
  const apiError = await callBatch("save", {}).then(() => null, (error) => error);
  assert.equal(apiError.message, approvalMessage);
  assert.equal(apiError.code, "auto_mix_voice_persona_approval_required", "callBatch must carry result.code");
  assert.equal(isDeterministicDraftError(apiError), true);
  for (const code of ["CONTENT_ENGINE_RUNTIME_UNAVAILABLE", "CONTENT_ENGINE_NOT_READY", "CONTENT_ENGINE_PIPE_FAILED",
    "narrated_batch_busy", "narrated_batch_paused", "UPDATE_IN_PROGRESS", "CONTENT_ENGINE_FAILED", undefined]) {
    assert.equal(isDeterministicDraftError(failure(code)), false, `${code} can clear up by itself`);
  }
  delete global.window;

  // Deterministic rejection: shown once with the real reason, backed up verbatim, never replayed.
  const unapprovedDraft = { batch_id: batchId, groups: { ...emptyGroups, middle: ["asset_1"] }, settings: monkey };
  const unapprovedRaw = pendingRaw(unapprovedDraft);
  const rejected = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const rejection = restorer(rejected, { saveErrors: [failure("auto_mix_voice_persona_approval_required", approvalMessage)] });
  const firstOpen = await rejection.run();
  assert.equal(firstOpen.kind, "discarded");
  assert.ok(firstOpen.message.includes(approvalMessage), "the page must show the real reason");
  assert.doesNotMatch(firstOpen.message, /当前任务结束后/u);
  assert.equal(rejected.map.has(PENDING_DRAFT_KEY), false);
  assert.ok(rejected.map.has(DISCARDED_DRAFT_KEY), "a discarded edit must be backed up, not silently lost");
  const backup = JSON.parse(rejected.map.get(DISCARDED_DRAFT_KEY));
  assert.equal(backup.pending, unapprovedRaw, "the discarded edit must be kept verbatim");
  assert.equal(backup.reason, "auto_mix_voice_persona_approval_required");
  assert.deepEqual(await rejection.run(), { kind: "none" });
  assert.equal(rejection.calls.save.length, 1, "a deterministic rejection must not be replayed on the next open");

  // Transient failures keep the edit untouched for the next open.
  for (const code of ["CONTENT_ENGINE_RUNTIME_UNAVAILABLE", "narrated_batch_busy", "narrated_batch_paused", undefined]) {
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
    const transient = restorer(storage, { saveErrors: [failure(code, "内容引擎尚未就绪，请稍后重试。")] });
    const kept = await transient.run();
    assert.equal(kept.kind, "kept", `${code} must keep the draft`);
    assert.match(kept.message, /内容引擎尚未就绪.*仍保留在本机/u);
    assert.equal(storage.map.get(PENDING_DRAFT_KEY), unapprovedRaw);
    assert.equal(storage.map.has(DISCARDED_DRAFT_KEY), false);
    assert.equal((await transient.run()).kind, "restored");
    assert.equal(transient.calls.save.length, 2, "a transient failure is retried on the next open");
    assert.equal(storage.map.has(PENDING_DRAFT_KEY), false);
  }
  const unreachable = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const lookupFailure = restorer(unreachable, { getError: failure("CONTENT_ENGINE_EXITED") });
  assert.equal((await lookupFailure.run()).kind, "kept");
  assert.equal(unreachable.map.get(PENDING_DRAFT_KEY), unapprovedRaw);
  const deleted = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const missingBatch = restorer(deleted, { getError: failure("narrated_batch_not_found") });
  assert.equal((await missingBatch.run()).kind, "discarded");
  assert.equal(JSON.parse(deleted.map.get(DISCARDED_DRAFT_KEY)).pending, unapprovedRaw);
  assert.equal(missingBatch.calls.save.length, 0);

  // A cached edit never lands on a batch past drafting, even when the save would succeed.
  const staleRaw = pendingRaw({ batch_id: batchId, groups: emptyGroups, settings: monkey, brief_version: 1 });
  for (const current of [
    completedBatch,
    { ...draftBatch, status: "scripts_ready", script_confirmation: { script_id: "narrated_candidate_1" } },
    { ...draftBatch, status: "failed", completed_count: 1 },
    { ...draftBatch, status: "rendering" },
    { ...draftBatch, archived: true },
    { ...draftBatch, groups: completedBatch.groups }
  ]) {
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: staleRaw });
    const guarded = restorer(storage, { current });
    const outcome = await guarded.run();
    assert.equal(outcome.kind, "discarded", `must not overwrite ${JSON.stringify(current).slice(0, 80)}`);
    assert.equal(guarded.calls.save.length, 0, "the non-draft batch must not be saved over");
    assert.equal(JSON.parse(storage.map.get(DISCARDED_DRAFT_KEY)).pending, staleRaw);
    assert.equal(storage.map.has(PENDING_DRAFT_KEY), false);
  }
  for (const [current, draft] of [
    [draftBatch, { batch_id: batchId, groups: emptyGroups }],
    [{ ...draftBatch, groups: completedBatch.groups }, { batch_id: batchId, groups: { ...emptyGroups, middle: ["asset_9"] } }],
    [{ ...draftBatch, status: "scripts_ready" }, { batch_id: batchId, groups: emptyGroups }]
  ]) {
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: pendingRaw(draft) });
    const normal = restorer(storage, { current });
    assert.equal((await normal.run()).kind, "restored", "an edit to a batch still being drafted is restored");
    assert.deepEqual(normal.calls.save, [draft]);
  }
  const unsaved = memoryStorage({ [PENDING_DRAFT_KEY]: pendingRaw({ groups: emptyGroups }) });
  const newBatch = restorer(unsaved);
  assert.equal((await newBatch.run()).kind, "restored");
  assert.equal(newBatch.calls.get, 0, "a never-saved batch has nothing to protect");
  const otherBatch = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const scoped = restorer(otherBatch);
  assert.deepEqual(await scoped.run("narrated_batch_ffffffffffffffffffffffffffffffff"), { kind: "none" });
  assert.equal(otherBatch.map.get(PENDING_DRAFT_KEY), unapprovedRaw);

  // No backup, no discard: the edit stays in place when the backup slot cannot be written.
  const full = memoryStorage({ [PENDING_DRAFT_KEY]: staleRaw }, { failBackup: true });
  assert.equal((await restorer(full, { current: completedBatch }).run()).kind, "discarded");
  assert.equal(full.map.get(PENDING_DRAFT_KEY), staleRaw, "an edit is never removed before its backup exists");
  // Only the most recent discarded edit is kept.
  const twice = memoryStorage({ [PENDING_DRAFT_KEY]: staleRaw });
  await restorer(twice, { current: completedBatch }).run();
  twice.setItem(PENDING_DRAFT_KEY, unapprovedRaw);
  await restorer(twice, { saveErrors: [failure("asset_archived")] }).run();
  assert.equal(JSON.parse(twice.map.get(DISCARDED_DRAFT_KEY)).pending, unapprovedRaw);

  // The save queue drops a deterministic failure so "新建视频" and "选择任务" are not
  // held by it forever, while transient failures stay queued.
  for (const [code, dropped] of [["auto_mix_voice_persona_approval_required", true], ["CONTENT_ENGINE_NOT_READY", false]]) {
    const saves = [];
    const failures = [];
    let reject = true;
    const queue = createDraftQueue({
      save: async (draft) => { saves.push(draft); if (reject) throw failure(code); return { batch_id: batchId }; },
      saved: () => undefined,
      failed: (error, owner, fingerprint) => failures.push([error.code, owner, fingerprint]),
      active: () => undefined,
      discard: isDeterministicDraftError
    });
    queue.enqueue({ batch_id: batchId, title: "old edit" }, "fingerprint-old", 1);
    await assert.rejects(queue.flush(), (error) => error.code === code, "the flush that hits the failure still reports it");
    assert.deepEqual(failures, [[code, 1, "fingerprint-old"]]);
    reject = false;
    await queue.flush();
    assert.equal(saves.length, dropped ? 1 : 2, dropped ? "a deterministic failure must not be replayed" : "a transient failure is retried");
    assert.equal(queue.busy(), false);
  }
  const saves = [];
  let release;
  const queue = createDraftQueue({
    save: (draft) => { saves.push(draft.title); return saves.length === 1 ? new Promise((_, rejectSave) => { release = rejectSave; }) : Promise.resolve({ batch_id: batchId }); },
    saved: () => undefined, failed: () => undefined, active: () => undefined, discard: isDeterministicDraftError
  });
  queue.enqueue({ batch_id: batchId, title: "old edit" }, "fingerprint-old", 1);
  const flight = queue.flush();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue({ batch_id: batchId, title: "new edit" }, "fingerprint-new", 1);
  release(failure("auto_mix_voice_persona_approval_required"));
  await assert.rejects(flight);
  await queue.flush();
  assert.deepEqual(saves, ["old edit", "new edit"], "dropping the rejected edit must keep a newer one");

  // The page wires the pieces together and no longer promises a recovery that cannot happen.
  assert.doesNotMatch(page, /当前任务结束后可重新打开恢复/u);
  assert.doesNotMatch(page, /callBatch<Batch>\("save", pending\.draft\)/u, "the page must not replay the cached draft directly");
  assert.match(page, /restorePendingDraft<Batch>\(\{/u);
  assert.match(page, /discard: isDeterministicDraftError/u);
  assert.match(page, /if \(isDeterministicDraftError\(error\)\) discardPendingDraft\(localStorage, [^;]+, fingerprint\)/u,
    "a dropped live edit must be backed up before the next edit replaces it");
  assert.match(page, /"该批次的声音需要重新试听批准，或改选已批准的声音。"/u);
  assert.match(page, /setDirty\(false\); setNotice\(voiceWarning\(b\)\);/u, "loading a batch must flag a voice that is no longer approved");

  console.log("Batch draft restore and save queue self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
