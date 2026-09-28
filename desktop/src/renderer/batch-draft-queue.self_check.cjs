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
  DISCARDED_DRAFT_KEY, PENDING_DRAFT_KEY, RESTORED_ELSEWHERE, createDraftQueue, createPendingDraftSlot, discardPendingDraft,
  isDeterministicDraftError, restoreNotice, restorePendingDraft
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
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const approvalMessage = "这条视频使用的声音尚未批准或批准已失效，请在「声音与配乐」中改选已批准的声音，或重新试听并批准后再试。";
const batchId = "narrated_batch_0a89fb41936f449bb671fb030d823ec0";
const otherBatchId = "narrated_batch_ffffffffffffffffffffffffffffffff";
const monkey = { voice_persona_id: "volc-monkey-brother-2@1", workflow_version: 2 };
const emptyGroups = { opening: [], middle: [], ending: [] };
const oneAsset = { ...emptyGroups, middle: ["asset_1"] };
const draftBatch = { batch_id: batchId, status: "draft", updated_at: "2026-09-28T01:00:00.000Z", groups: emptyGroups, candidates: [] };
// The cached draft found on the development machine: no materials, pointing at a
// finished batch that has four materials, confirmed copy and one completed work.
const completedBatch = {
  batch_id: batchId, status: "completed", updated_at: "2026-09-21T02:01:39.038Z",
  groups: { opening: [], middle: ["asset_1", "asset_2", "asset_3", "asset_4"], ending: [] },
  script_confirmation: { script_id: "narrated_candidate_1", revision: 1 },
  candidates: [{ status: "completed", generated_video_id: "generated_video_1" }]
};
const pendingRaw = (draft, fingerprint = "fingerprint-1", extra = {}) => JSON.stringify({ draft, fingerprint, ...extra });
function restorer(storage, { current = draftBatch, getError, saveErrors = [], duringGet } = {}) {
  const calls = { get: 0, save: [] };
  const run = () => restorePendingDraft({
    storage,
    get: async () => { calls.get += 1; duringGet?.(); await tick(); if (getError) throw getError; return current; },
    save: async (draft) => {
      calls.save.push(draft);
      const error = saveErrors.shift();
      if (error) throw error;
      return { ...current, ...draft, status: "draft" };
    }
  });
  return { calls, run };
}

// An in-memory engine: saves are rejected while the voice approval is revoked.
function fakeEngine(batches = []) {
  let clock = 0;
  const db = new Map(batches.map((b) => [b.batch_id, { ...b }]));
  const engine = {
    approved: false, db, saves: [],
    get: async (id) => {
      if (!db.has(id)) throw failure("narrated_batch_not_found", "没有找到这个批次。");
      return { ...db.get(id) };
    },
    save: async (draft) => {
      engine.saves.push(draft);
      await tick();
      if (draft.settings?.voice_persona_id && !engine.approved) throw failure("auto_mix_voice_persona_approval_required", approvalMessage);
      const id = draft.batch_id || `narrated_batch_${String(db.size + 1).padStart(32, "0")}`;
      // A content save resets the batch to draft and drops _archived_at (narrated_batch.py save);
      // the save response carries no archived flag.
      const { archived: _dropped, ...previous } = db.get(id) || { candidates: [] };
      const saved = { ...previous, ...draft, batch_id: id, status: "draft", updated_at: `2026-09-28T02:00:${String(++clock).padStart(2, "0")}.000Z` };
      db.set(id, saved);
      return { ...saved };
    },
    archive: async (id) => { await tick(); db.set(id, { ...db.get(id), archived: true }); return { batch_id: id }; }
  };
  return engine;
}
// The page's wiring around the slot, the queue and the restore (BatchCreativePage.tsx).
// The source assertions at the end pin the page lines each step mirrors.
function workbench(storage, engine) {
  const state = { owner: 0, mounted: true, notice: "", batch: null, form: null };
  const slot = createPendingDraftSlot(storage);
  const queue = createDraftQueue({
    save: (value) => engine.save(value),
    hold: isDeterministicDraftError,
    active: () => undefined,
    saved: (value, fingerprint, owner) => {
      if (owner !== state.owner) return;
      slot.saved(fingerprint, owner, value);
      state.batch = value;
    },
    failed: (error, owner, fingerprint, dropped) => {
      if (dropped && state.mounted) discardPendingDraft(storage, String(error.code), fingerprint);
      if (!state.mounted || owner !== state.owner) return;
      state.notice = `${dropped ? "上一份编辑未能保存" : "草稿尚未保存"}：${error.message}`;
    }
  });
  return {
    state, slot, queue,
    // The mount effect: replay the cached edit, then load what the page was opened on.
    async open(openedBatchId) {
      const restore = await restorePendingDraft({ storage, get: engine.get, save: engine.save });
      if (restore.kind === "restored" && (!openedBatchId || restore.batch.batch_id === openedBatchId)) {
        this.load(restore.batch);
        return restore;
      }
      state.notice = restoreNotice(restore);
      if (openedBatchId) this.load(await engine.get(openedBatchId));
      return restore;
    },
    load(batch) { state.owner += 1; queue.cancelPending(); state.batch = batch; state.form = null; },
    edit(changes, fingerprint) {
      const draft = { ...(state.batch ? { batch_id: state.batch.batch_id, groups: state.batch.groups, settings: state.batch.settings } : {}), ...changes };
      state.form = { draft, fingerprint };
      return this.effect();
    },
    // The autosave effect; it also runs again whenever busy flips back after an action.
    effect() {
      if (!state.form) return undefined;
      const { draft, fingerprint } = state.form;
      const base = state.batch && draft.batch_id === state.batch.batch_id ? state.batch.updated_at : undefined;
      slot.write({ draft, fingerprint, ...(base ? { base_updated_at: base } : {}) }, state.owner);
      queue.enqueue(draft, fingerprint, state.owner);
      return draft;
    },
    // run(): a failed action shows its error, and busy flipping back re-runs the effect.
    async click(action) {
      try { await action(); return true; } catch (error) { state.notice = error.message; return false; } finally { this.effect(); }
    },
    async newVideo() { await queue.flush(); state.owner += 1; state.batch = null; state.form = null; },
    async archive() {
      const id = state.batch.batch_id;
      await queue.flush();
      await engine.archive(id);
      state.owner += 1; queue.cancelPending();
      state.batch = null; state.form = null;
    },
    async start(draft) { queue.cancelPending(); const b = await engine.save(draft); slot.started(state.owner); state.batch = b; return b; },
    leave() { state.mounted = false; return queue.flush().catch(() => undefined); }
  };
}
const pendingText = (storage) => storage.map.get(PENDING_DRAFT_KEY) || "";
const backupOf = (storage) => storage.map.has(DISCARDED_DRAFT_KEY) ? JSON.parse(storage.map.get(DISCARDED_DRAFT_KEY)) : null;

async function main() {
  // callBatch keeps the main-process code so the page can tell "retry later" from "never".
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

  // discardPendingDraft moves only the edit it names, verbatim, and never loses one.
  {
    const older = pendingRaw({ batch_id: batchId }, "fingerprint-older");
    const newer = pendingRaw({ batch_id: batchId, title: "newer" }, "fingerprint-newer");
    const differ = memoryStorage({ [PENDING_DRAFT_KEY]: newer });
    assert.equal(discardPendingDraft(differ, "asset_archived", "fingerprint-older"), false);
    assert.equal(differ.map.get(PENDING_DRAFT_KEY), newer, "a newer edit is never moved for an older failure");
    assert.equal(differ.map.has(DISCARDED_DRAFT_KEY), false);
    const match = memoryStorage({ [PENDING_DRAFT_KEY]: older });
    assert.equal(discardPendingDraft(match, "asset_archived", "fingerprint-older"), true);
    assert.equal(match.map.has(PENDING_DRAFT_KEY), false);
    assert.equal(backupOf(match).pending, older, "the named edit is kept verbatim");
    assert.equal(backupOf(match).reason, "asset_archived");
    const invalid = memoryStorage({ [PENDING_DRAFT_KEY]: "{not json" });
    assert.equal(discardPendingDraft(invalid, "asset_archived", "fingerprint-older"), false);
    assert.equal(invalid.map.get(PENDING_DRAFT_KEY), "{not json");
    assert.equal(invalid.map.has(DISCARDED_DRAFT_KEY), false);
    assert.equal(discardPendingDraft(invalid, "replaced"), true, "without a fingerprint whatever is cached is moved");
    assert.equal(backupOf(invalid).pending, "{not json");
    const full = memoryStorage({ [PENDING_DRAFT_KEY]: older }, { failBackup: true });
    assert.equal(discardPendingDraft(full, "asset_archived", "fingerprint-older"), false);
    assert.equal(full.map.get(PENDING_DRAFT_KEY), older, "an edit is never removed before its backup exists");
    assert.equal(discardPendingDraft(memoryStorage(), "asset_archived"), false);
  }

  // Deterministic rejection: shown once with the real reason, backed up verbatim, never replayed.
  const unapprovedDraft = { batch_id: batchId, groups: oneAsset, settings: monkey };
  const unapprovedRaw = pendingRaw(unapprovedDraft);
  const rejected = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const rejection = restorer(rejected, { saveErrors: [failure("auto_mix_voice_persona_approval_required", approvalMessage)] });
  const firstOpen = await rejection.run();
  assert.equal(firstOpen.kind, "discarded");
  assert.ok(firstOpen.message.includes(approvalMessage), "the page must show the real reason");
  assert.match(firstOpen.message, /不会再自动恢复/u);
  assert.doesNotMatch(firstOpen.message, /当前任务结束后|备份/u);
  assert.equal(rejected.map.has(PENDING_DRAFT_KEY), false);
  assert.equal(backupOf(rejected).pending, unapprovedRaw, "a discarded edit must be backed up verbatim, not silently lost");
  assert.equal(backupOf(rejected).reason, "auto_mix_voice_persona_approval_required");
  assert.deepEqual(await rejection.run(), { kind: "none" });
  assert.equal(rejection.calls.save.length, 1, "a deterministic rejection must not be replayed on the next open");

  // Transient failures keep the edit untouched for the next open.
  for (const code of ["CONTENT_ENGINE_RUNTIME_UNAVAILABLE", "narrated_batch_busy", "narrated_batch_paused", undefined]) {
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
    const transient = restorer(storage, { saveErrors: [failure(code, "内容引擎尚未就绪，请稍后重试。")] });
    const kept = await transient.run();
    assert.equal(kept.kind, "kept", `${code} must keep the draft`);
    assert.match(kept.message, /暂未恢复：内容引擎尚未就绪.*下次打开工作台时会再尝试.*新的编辑为准/u);
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
  assert.equal(backupOf(deleted).pending, unapprovedRaw);
  assert.equal(missingBatch.calls.save.length, 0);

  // A cached edit only lands on a batch still in draft that has not changed since the
  // edit was made, even when the save itself would succeed. Each refusal says why.
  const legacyEmpty = { batch_id: batchId, groups: emptyGroups, settings: monkey, brief_version: 1 };
  for (const [current, entry, reason, why] of [
    [completedBatch, [legacyEmpty], "batch_produced", /已确认文案或已有成片/u],
    [{ ...draftBatch, status: "scripts_ready", script_confirmation: { script_id: "narrated_candidate_1" } }, [legacyEmpty], "batch_produced", /已确认文案/u],
    [{ ...draftBatch, status: "failed", candidates: [{ status: "completed", generated_video_id: "generated_video_1" }] }, [legacyEmpty], "batch_produced", /已有成片/u],
    [{ ...draftBatch, status: "rendering" }, [legacyEmpty], "batch_produced", /已有成片/u],
    [{ ...draftBatch, archived: true }, [legacyEmpty], "batch_archived", /已归档/u],
    [{ ...draftBatch, status: "scripts_ready", script_options: [{ candidate_id: "narrated_candidate_1" }] },
      [{ batch_id: batchId, groups: oneAsset }, "fingerprint-1", { base_updated_at: draftBatch.updated_at }], "batch_not_draft", /已生成文案/u],
    ...["ready", "insufficient_materials", "needs_attention", "outcome_unknown", "cancelled"].map((status) =>
      [{ ...draftBatch, status }, [{ batch_id: batchId, groups: oneAsset }], "batch_not_draft", /已生成文案或已开始处理/u]),
    [{ ...draftBatch, groups: completedBatch.groups, updated_at: "2026-09-28T03:00:00.000Z" },
      [{ batch_id: batchId, groups: oneAsset }, "fingerprint-1", { base_updated_at: draftBatch.updated_at }], "batch_changed", /又有了更新/u],
    [{ ...draftBatch, groups: completedBatch.groups }, [legacyEmpty], "draft_without_materials", /没有素材.*清空/u]
  ]) {
    const raw = pendingRaw(...entry);
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: raw });
    const guarded = restorer(storage, { current });
    const outcome = await guarded.run();
    assert.equal(outcome.kind, "discarded", `must not overwrite ${JSON.stringify(current).slice(0, 90)}`);
    assert.match(outcome.message, why, `the refusal must name the actual reason (${reason})`);
    assert.match(outcome.message, /没有写回，也不会再自动恢复。$/u);
    assert.equal(guarded.calls.save.length, 0, "the batch must not be saved over");
    assert.equal(backupOf(storage).pending, raw);
    assert.equal(backupOf(storage).reason, reason);
    assert.equal(storage.map.has(PENDING_DRAFT_KEY), false);
  }
  for (const [current, entry] of [
    [draftBatch, [{ batch_id: batchId, groups: emptyGroups }]],
    [{ ...draftBatch, groups: completedBatch.groups }, [{ batch_id: batchId, groups: oneAsset }]],
    [{ ...draftBatch, groups: completedBatch.groups }, [{ batch_id: batchId, groups: emptyGroups }, "fingerprint-1", { base_updated_at: draftBatch.updated_at }]]
  ]) {
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: pendingRaw(...entry) });
    const normal = restorer(storage, { current });
    assert.equal((await normal.run()).kind, "restored", "an edit to an unchanged batch still in draft is restored");
    assert.deepEqual(normal.calls.save, [entry[0]]);
  }
  const unsaved = memoryStorage({ [PENDING_DRAFT_KEY]: pendingRaw({ groups: emptyGroups }) });
  const newBatch = restorer(unsaved);
  assert.equal((await newBatch.run()).kind, "restored");
  assert.equal(newBatch.calls.get, 0, "a never-saved batch has nothing to protect");

  // The page shows the outcome of every replay it does not load.
  assert.equal(restoreNotice({ kind: "none" }), "");
  assert.equal(restoreNotice({ kind: "kept", message: "原因甲" }), "原因甲");
  assert.equal(restoreNotice({ kind: "discarded", message: "原因乙" }), "原因乙");
  assert.equal(restoreNotice({ kind: "restored", batch: draftBatch }), RESTORED_ELSEWHERE);
  assert.match(RESTORED_ELSEWHERE, /已存回.*制作记录/u);

  // A batch whose task row is gone fails every read the same way: stop replaying it.
  assert.equal(isDeterministicDraftError(failure("task_not_found")), true);
  const dangling = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const danglingTask = restorer(dangling, { getError: failure("task_not_found", "没有找到这条任务记录。") });
  const danglingOpen = await danglingTask.run();
  assert.equal(danglingOpen.kind, "discarded", "a dangling task reference must not be replayed on every open");
  assert.match(danglingOpen.message, /不会再自动恢复：没有找到这条任务记录/u);
  assert.equal(backupOf(dangling).pending, unapprovedRaw);
  assert.deepEqual(await danglingTask.run(), { kind: "none" });

  // Overlapping opens (React StrictMode runs the mount effect twice in development) share
  // one replay: both report what actually happened, and the engine sees one request.
  for (const [current, kind, message] of [
    [completedBatch, "discarded", /已确认文案或已有成片.*也不会再自动恢复。$/u],
    [draftBatch, "restored", null]
  ]) {
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: pendingRaw({ batch_id: batchId, groups: emptyGroups }) });
    const twice = restorer(storage, { current });
    const [first, second] = await Promise.all([twice.run(), twice.run()]);
    assert.equal(first.kind, kind, `overlapping opens: ${kind}`);
    assert.deepEqual(second, first, "the second open must report the same outcome, never 'kept' for an edit the first one moved");
    if (message) assert.match(second.message, message);
    assert.equal(twice.calls.get, 1);
    assert.equal(twice.calls.save.length, kind === "restored" ? 1 : 0);
    assert.equal(storage.map.has(PENDING_DRAFT_KEY), false);
  }
  // An edit that left the slot while its batch was being read (moved, restored or
  // replaced by someone else) is not this replay's to report; only a failed backup is "kept".
  const vanished = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const gone = await restorer(vanished, { current: completedBatch, duringGet: () => vanished.removeItem(PENDING_DRAFT_KEY) }).run();
  assert.deepEqual(gone, { kind: "none" }, "an edit no longer cached must not be reported as kept");
  const replaced = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw });
  const newer = pendingRaw({ batch_id: batchId, groups: oneAsset, title: "newer" }, "fingerprint-newer");
  assert.deepEqual(await restorer(replaced, { current: completedBatch, duringGet: () => replaced.setItem(PENDING_DRAFT_KEY, newer) }).run(), { kind: "none" });
  assert.equal(replaced.map.get(PENDING_DRAFT_KEY), newer, "a newer edit is left alone");
  assert.equal(replaced.map.has(DISCARDED_DRAFT_KEY), false);

  // No backup, no discard, and no claim that the replay has stopped: the edit stays and
  // is checked again on the next open.
  const full = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw }, { failBackup: true });
  const quota = restorer(full, { saveErrors: [failure("auto_mix_voice_persona_approval_required", approvalMessage), failure("auto_mix_voice_persona_approval_required", approvalMessage)] });
  for (let open = 1; open <= 2; open += 1) {
    const outcome = await quota.run();
    assert.equal(outcome.kind, "kept", "without a backup the edit is kept, not reported as discarded");
    assert.ok(outcome.message.includes(approvalMessage));
    assert.match(outcome.message, /仍保留在本机，下次打开时会再次检查/u);
    assert.doesNotMatch(outcome.message, /不会再自动恢复|备份/u);
    assert.equal(full.map.get(PENDING_DRAFT_KEY), unapprovedRaw);
    assert.equal(quota.calls.save.length, open);
  }
  const fullGuard = memoryStorage({ [PENDING_DRAFT_KEY]: unapprovedRaw }, { failBackup: true });
  const blockedNoBackup = await restorer(fullGuard, { current: completedBatch }).run();
  assert.equal(blockedNoBackup.kind, "kept");
  assert.doesNotMatch(blockedNoBackup.message, /不会再自动恢复/u);
  assert.equal(fullGuard.map.get(PENDING_DRAFT_KEY), unapprovedRaw);
  // Only the most recent discarded edit is kept.
  const twice = memoryStorage({ [PENDING_DRAFT_KEY]: pendingRaw(legacyEmpty) });
  await restorer(twice, { current: completedBatch }).run();
  twice.setItem(PENDING_DRAFT_KEY, unapprovedRaw);
  await restorer(twice, { saveErrors: [failure("asset_archived")] }).run();
  assert.equal(backupOf(twice).pending, unapprovedRaw);

  // The slot only replaces or clears the page's own latest edit for the current form.
  {
    const kept = pendingRaw({ batch_id: batchId, groups: oneAsset, expression: "上次会话未恢复的长文案" }, "fingerprint-kept",
      { base_updated_at: draftBatch.updated_at });
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: kept });
    const slot = createPendingDraftSlot(storage);
    assert.equal(slot.write({ draft: { groups: emptyGroups, title: "新视频" }, fingerprint: "fingerprint-a" }, 1), true);
    assert.equal(backupOf(storage).pending, kept, "an edit kept from an earlier session is backed up before it is replaced");
    assert.equal(backupOf(storage).reason, "replaced");
    assert.equal(JSON.parse(pendingText(storage)).fingerprint, "fingerprint-a");
    assert.equal(slot.write({ draft: { groups: emptyGroups, title: "新视频2" }, fingerprint: "fingerprint-b" }, 1), true);
    assert.equal(backupOf(storage).pending, kept, "a later state of the same edit replaces it without another backup");
    // The page moved on (新建视频 / 选择任务) while its old edit was still cached.
    assert.equal(slot.write({ draft: { groups: oneAsset, title: "另一条" }, fingerprint: "fingerprint-c" }, 2), true);
    assert.equal(JSON.parse(backupOf(storage).pending).fingerprint, "fingerprint-b", "an edit the page moved on from is backed up");
    const invalid = memoryStorage({ [PENDING_DRAFT_KEY]: "{not json" });
    createPendingDraftSlot(invalid).write({ draft: { groups: emptyGroups }, fingerprint: "fingerprint-a" }, 1);
    assert.equal(backupOf(invalid).pending, "{not json", "unreadable cached data is backed up verbatim, not overwritten");
    const fullSlot = memoryStorage({ [PENDING_DRAFT_KEY]: kept }, { failBackup: true });
    assert.equal(createPendingDraftSlot(fullSlot).write({ draft: { groups: emptyGroups }, fingerprint: "fingerprint-a" }, 1), false);
    assert.equal(fullSlot.map.get(PENDING_DRAFT_KEY), kept, "without a backup the earlier edit is left in place");

    // After a save: the saved edit is cleared; a newer own edit learns its batch and base;
    // anything else is left alone.
    const saves = memoryStorage();
    const own = createPendingDraftSlot(saves);
    own.write({ draft: { groups: oneAsset }, fingerprint: "fingerprint-1" }, 1);
    own.write({ draft: { groups: oneAsset, title: "更新" }, fingerprint: "fingerprint-2" }, 1);
    own.saved("fingerprint-1", 1, { batch_id: batchId, updated_at: "2026-09-28T02:00:01.000Z" });
    assert.deepEqual(JSON.parse(pendingText(saves)), {
      draft: { groups: oneAsset, title: "更新", batch_id: batchId }, fingerprint: "fingerprint-2", base_updated_at: "2026-09-28T02:00:01.000Z"
    });
    own.saved("fingerprint-2", 1, { batch_id: batchId, updated_at: "2026-09-28T02:00:02.000Z" });
    assert.equal(saves.map.has(PENDING_DRAFT_KEY), false);
    const foreign = memoryStorage({ [PENDING_DRAFT_KEY]: kept });
    const foreignSlot = createPendingDraftSlot(foreign);
    foreignSlot.saved("fingerprint-kept", 1, { batch_id: otherBatchId, updated_at: "x" });
    foreignSlot.started(1);
    assert.equal(foreign.map.get(PENDING_DRAFT_KEY), kept, "a save or task start in this session never clears an edit it did not write");
    const startedSlot = createPendingDraftSlot(saves);
    startedSlot.write({ draft: { batch_id: batchId, groups: oneAsset }, fingerprint: "fingerprint-3" }, 4);
    startedSlot.started(5);
    assert.equal(JSON.parse(pendingText(saves)).fingerprint, "fingerprint-3", "a start for another form keeps this edit");
    startedSlot.started(4);
    assert.equal(saves.map.has(PENDING_DRAFT_KEY), false, "a task start clears the page's own edit");
  }

  // The save queue holds a deterministic failure instead of retrying it in the background.
  // An explicit flush tries it once more, and only a second rejection lets it go.
  {
    const saves = [];
    const failures = [];
    let rejectCode = "auto_mix_voice_persona_approval_required";
    const queue = createDraftQueue({
      save: async (draft) => { saves.push(draft.title); if (rejectCode) throw failure(rejectCode); return { batch_id: batchId }; },
      saved: () => undefined,
      failed: (error, owner, fingerprint, dropped) => failures.push([error.code, owner, fingerprint, dropped]),
      active: () => undefined,
      hold: isDeterministicDraftError
    });
    queue.enqueue({ batch_id: batchId, title: "held" }, "fingerprint-held", 1);
    await sleep(450);
    assert.deepEqual(saves, ["held"], "the background save ran once");
    assert.deepEqual(failures, [["auto_mix_voice_persona_approval_required", 1, "fingerprint-held", false]]);
    await sleep(450);
    assert.equal(saves.length, 1, "a held edit is not retried in the background");
    rejectCode = null;
    await queue.flush();
    assert.deepEqual(saves, ["held", "held"], "an explicit flush retries the held edit once the cause is fixed");
    await queue.flush();
    assert.equal(saves.length, 2);

    rejectCode = "asset_archived";
    queue.enqueue({ batch_id: batchId, title: "fresh" }, "fingerprint-fresh", 1);
    await assert.rejects(queue.flush(), (error) => error.code === "asset_archived", "a first rejection is reported and holds the page");
    await queue.flush();
    assert.deepEqual(saves.slice(2), ["fresh", "fresh"]);
    assert.deepEqual(failures.slice(-2), [["asset_archived", 1, "fingerprint-fresh", false], ["asset_archived", 1, "fingerprint-fresh", true]],
      "the second rejection on an explicit flush drops the edit and lets the page move on");
    await queue.flush();
    assert.equal(saves.length, 4, "a dropped edit is not tried again");
    assert.equal(queue.busy(), false);

    rejectCode = "CONTENT_ENGINE_NOT_READY";
    queue.enqueue({ batch_id: batchId, title: "transient" }, "fingerprint-transient", 1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(queue.flush(), (error) => error.code === "CONTENT_ENGINE_NOT_READY", "a transient failure keeps holding the page");
    }
    assert.ok(failures.slice(-3).every((entry) => entry[3] === false), "a transient failure is never dropped");
    rejectCode = null;
    await queue.flush();
    assert.equal(saves.at(-1), "transient");

    rejectCode = "asset_archived";
    queue.enqueue({ batch_id: batchId, title: "superseded" }, "fingerprint-superseded", 1);
    await queue.flush().catch(() => undefined);
    rejectCode = null;
    queue.enqueue({ batch_id: batchId, title: "newest" }, "fingerprint-newest", 1);
    await sleep(450);
    await queue.flush();
    assert.deepEqual(saves.slice(-2), ["superseded", "newest"], "a newer edit replaces a held one; the held one is never saved over it");

    rejectCode = "asset_archived";
    queue.enqueue({ batch_id: batchId, title: "cancelled" }, "fingerprint-cancelled", 1);
    await queue.flush().catch(() => undefined);
    const beforeCancel = saves.length;
    queue.cancelPending();
    rejectCode = null;
    await queue.flush();
    assert.equal(saves.length, beforeCancel, "cancelPending also forgets a held edit");

    // The page re-enqueues the unchanged form after each failed action. That neither
    // clears the rejection nor starts another background save.
    rejectCode = "asset_archived";
    const unchanged = { batch_id: batchId, title: "unchanged" };
    queue.enqueue(unchanged, "fingerprint-unchanged", 1);
    await assert.rejects(queue.flush(), (error) => error.code === "asset_archived");
    const afterFirstRejection = saves.length;
    queue.enqueue({ ...unchanged }, "fingerprint-unchanged", 1);
    await sleep(450);
    assert.equal(saves.length, afterFirstRejection, "re-enqueueing the rejected form does not retry it in the background");
    await queue.flush();
    assert.equal(saves.length, afterFirstRejection + 1);
    assert.deepEqual(failures.at(-1), ["asset_archived", 1, "fingerprint-unchanged", true],
      "re-enqueueing the unchanged form keeps its rejection: the next explicit flush is its last try");
    queue.enqueue({ batch_id: batchId, title: "changed" }, "fingerprint-changed", 2);
    await assert.rejects(queue.flush(), (error) => error.code === "asset_archived", "a changed form starts over");
    queue.enqueue({ batch_id: batchId, title: "changed" }, "fingerprint-changed", 3);
    await assert.rejects(queue.flush(), (error) => error.code === "asset_archived", "the same form under a new owner starts over");
    queue.cancelPending();
    rejectCode = null;
  }
  // A newer edit that arrives while an older one is failing is saved right away, whether
  // or not its own debounce already fired during that save.
  for (const code of ["auto_mix_voice_persona_approval_required", "CONTENT_ENGINE_NOT_READY"]) {
    const saves = [];
    let release;
    const queue = createDraftQueue({
      save: (draft) => { saves.push(draft.title); return saves.length === 1 ? new Promise((_, rejectSave) => { release = rejectSave; }) : Promise.resolve({ batch_id: batchId }); },
      saved: () => undefined, failed: () => undefined, active: () => undefined, hold: isDeterministicDraftError
    });
    queue.enqueue({ batch_id: batchId, title: "old edit" }, "fingerprint-old", 1);
    await sleep(450);
    queue.enqueue({ batch_id: batchId, title: "new edit" }, "fingerprint-new", 1);
    await sleep(450);
    release(failure(code));
    await sleep(50);
    assert.deepEqual(saves, ["old edit", "new edit"], `after ${code}, the newer edit must be saved without another trigger`);
    assert.equal(queue.busy(), false);
  }

  // Page flows, wired as BatchCreativePage.tsx wires them.
  const monkeyBatch = { ...draftBatch, groups: oneAsset, settings: monkey };
  const typed = { expression: "用户刚写好的新文案" };
  {
    // Fix the voice on the page, then move on: the edit is saved, not stranded.
    const storage = memoryStorage();
    const engine = fakeEngine([monkeyBatch]);
    const bench = workbench(storage, engine);
    bench.load(await engine.get(batchId));
    const draft = bench.edit(typed, "fingerprint-typed");
    await sleep(450);
    assert.equal(bench.state.notice, `草稿尚未保存：${approvalMessage}`);
    assert.equal(JSON.parse(pendingText(storage)).draft.expression, typed.expression, "a live rejection leaves the edit cached");
    assert.equal(storage.map.has(DISCARDED_DRAFT_KEY), false);
    engine.approved = true;
    await bench.newVideo();
    assert.equal(engine.db.get(batchId).expression, typed.expression, "after the voice is approved, 新建视频 saves the held edit");
    assert.deepEqual(engine.saves, [draft, draft]);
    assert.equal(storage.map.has(PENDING_DRAFT_KEY), false);
  }
  {
    // Move on without fixing it: 新建视频 is not blocked, and the edit is backed up verbatim.
    const storage = memoryStorage();
    const engine = fakeEngine([monkeyBatch]);
    const bench = workbench(storage, engine);
    bench.load(await engine.get(batchId));
    bench.edit(typed, "fingerprint-typed");
    await sleep(450);
    const cached = pendingText(storage);
    await bench.newVideo();
    assert.equal(bench.state.notice, `上一份编辑未能保存：${approvalMessage}`);
    assert.equal(backupOf(storage).pending, cached, "an edit the user moved on from is backed up verbatim");
    assert.equal(storage.map.has(PENDING_DRAFT_KEY), false);
    assert.equal(engine.db.get(batchId).expression, undefined);
    bench.edit({ groups: oneAsset, title: "新视频" }, "fingerprint-next");
    assert.equal(backupOf(storage).pending, cached, "the next edit does not touch the backup");
  }
  {
    // Leave the page, approve the voice elsewhere, come back: the edit is restored.
    const storage = memoryStorage();
    const engine = fakeEngine([monkeyBatch]);
    const bench = workbench(storage, engine);
    bench.load(await engine.get(batchId));
    bench.edit(typed, "fingerprint-typed");
    await sleep(450);
    await bench.leave();
    assert.equal(engine.saves.length, 2, "leaving the page retries the held edit once");
    assert.equal(JSON.parse(pendingText(storage)).draft.expression, typed.expression, "leaving keeps the edit cached for the next open");
    assert.equal(storage.map.has(DISCARDED_DRAFT_KEY), false);
    engine.approved = true;
    const reopened = await workbench(storage, engine).open();
    assert.equal(reopened.kind, "restored");
    assert.equal(engine.db.get(batchId).expression, typed.expression);
  }
  {
    // A save that lands between edits moves the next edit's base, so it is still restorable.
    const storage = memoryStorage();
    const engine = fakeEngine([{ ...draftBatch, groups: oneAsset }]);
    const bench = workbench(storage, engine);
    bench.load(await engine.get(batchId));
    bench.edit({ title: "第一稿" }, "fingerprint-1");
    await bench.queue.flush();
    const saveFailure = engine.save;
    engine.save = async () => { throw failure("CONTENT_ENGINE_PIPE_FAILED", "内容引擎连接中断，请重试。"); };
    bench.edit({ title: "第二稿" }, "fingerprint-2");
    await bench.leave();
    engine.save = saveFailure;
    assert.equal(JSON.parse(pendingText(storage)).base_updated_at, engine.db.get(batchId).updated_at);
    assert.equal((await workbench(storage, engine).open()).kind, "restored");
    assert.equal(engine.db.get(batchId).title, "第二稿");
  }
  {
    // A draft kept through an engine outage is not lost to the next edit or task start.
    const kept = pendingRaw({ batch_id: batchId, groups: oneAsset, expression: "上次会话未恢复的长文案" }, "fingerprint-kept",
      { base_updated_at: draftBatch.updated_at });
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: kept });
    const engine = fakeEngine([draftBatch]);
    const down = { get: async () => { throw failure("CONTENT_ENGINE_NOT_READY", "内容引擎尚未就绪，请稍后重试。"); }, save: engine.save };
    const bench = workbench(storage, down);
    assert.equal((await bench.open()).kind, "kept");
    await bench.start({ groups: oneAsset, title: "另一批" });
    assert.equal(pendingText(storage), kept, "a task start elsewhere leaves the kept edit for the next open");
    bench.edit({ groups: oneAsset, title: "新开始的一条" }, "fingerprint-new");
    assert.equal(backupOf(storage).pending, kept, "the next edit backs the kept edit up before replacing it");
    assert.equal(JSON.parse(pendingText(storage)).fingerprint, "fingerprint-new");
  }
  {
    // Clicking 新建视频 again right after it was blocked by a rejected edit: busy flipping
    // back re-runs the autosave effect, and that must not reset the rejection count.
    const storage = memoryStorage();
    const engine = fakeEngine([monkeyBatch]);
    const bench = workbench(storage, engine);
    bench.load(await engine.get(batchId));
    bench.edit(typed, "fingerprint-typed");
    assert.equal(await bench.click(() => bench.newVideo()), false, "the first rejection is shown and holds the page");
    assert.equal(bench.state.notice, approvalMessage);
    await sleep(200);
    assert.equal(await bench.click(() => bench.newVideo()), true, "the second click moves on without waiting for a background save");
    assert.equal(engine.saves.length, 2, "one save per click, no extra background save");
    assert.equal(bench.state.batch, null);
    assert.equal(JSON.parse(backupOf(storage).pending).draft.expression, typed.expression);
  }
  {
    // Opened on another batch from 制作记录: the cached edit is still replayed into its own
    // batch, the page says so, and the first keystroke here has nothing to replace.
    const other = { ...draftBatch, batch_id: otherBatchId, groups: oneAsset };
    const cached = pendingRaw({ batch_id: batchId, groups: oneAsset, expression: "另一条视频上没存上的文案" }, "fingerprint-x",
      { base_updated_at: draftBatch.updated_at });
    const storage = memoryStorage({ [PENDING_DRAFT_KEY]: cached });
    const engine = fakeEngine([draftBatch, other]);
    const bench = workbench(storage, engine);
    assert.equal((await bench.open(otherBatchId)).kind, "restored");
    assert.equal(bench.state.batch.batch_id, otherBatchId, "the page still opens the batch that was asked for");
    assert.equal(bench.state.notice, RESTORED_ELSEWHERE);
    assert.equal(engine.db.get(batchId).expression, "另一条视频上没存上的文案", "the cached edit lands in its own batch");
    assert.equal(storage.map.has(PENDING_DRAFT_KEY), false);
    bench.edit({ title: "在这条上开始编辑" }, "fingerprint-y");
    assert.equal(storage.map.has(DISCARDED_DRAFT_KEY), false, "nothing was left behind for the first keystroke to replace");
    bench.load(other);
    // The same open with the incident draft: refused, backed up, and the reason is shown here.
    const incident = memoryStorage({ [PENDING_DRAFT_KEY]: pendingRaw(legacyEmpty) });
    const refused = workbench(incident, fakeEngine([completedBatch, other]));
    assert.equal((await refused.open(otherBatchId)).kind, "discarded");
    assert.match(refused.state.notice, /已确认文案或已有成片.*不会再自动恢复/u);
    assert.equal(refused.state.batch.batch_id, otherBatchId);
    assert.equal(backupOf(incident).pending, pendingRaw(legacyEmpty));
  }
  {
    // 归档批次 within the autosave delay of an edit. The old wiring let the delayed save
    // land after the archive: it took the batch out of the archive and selected it again.
    const oldWiring = async (bench, engine) => { await engine.archive(bench.state.batch.batch_id); bench.state.batch = null; bench.state.form = null; };
    for (const [label, archive] of [["old wiring", oldWiring], ["page", (bench) => bench.archive()]]) {
      const storage = memoryStorage();
      const engine = fakeEngine([{ ...draftBatch, groups: oneAsset }]);
      const bench = workbench(storage, engine);
      bench.load(await engine.get(batchId));
      bench.edit({ title: "归档前的最后一改" }, "fingerprint-last");
      await archive(bench, engine);
      await sleep(450);
      if (label === "old wiring") {
        assert.equal(engine.db.get(batchId).archived, undefined, "the model reproduces the race: the late save revives the batch");
        assert.equal(bench.state.batch?.batch_id, batchId);
        continue;
      }
      assert.equal(engine.db.get(batchId).archived, true, "an archived batch stays archived");
      assert.equal(engine.db.get(batchId).title, "归档前的最后一改", "the last edit lands before the archive");
      assert.equal(bench.state.batch, null, "no late response selects the archived batch again");
      bench.edit({ groups: oneAsset, title: "新视频" }, "fingerprint-new");
      await sleep(450);
      assert.equal(engine.db.get(batchId).title, "归档前的最后一改", "the next video is not saved into the archived batch");
      assert.equal(engine.db.size, 2);
    }
  }

  // The page wires the pieces together and no longer promises a recovery that cannot happen.
  assert.doesNotMatch(page, /当前任务结束后可重新打开恢复/u);
  assert.doesNotMatch(page, /callBatch<Batch>\("save", pending\.draft\)/u, "the page must not replay the cached draft directly");
  assert.doesNotMatch(page, /(?:setItem|removeItem)\("batch-studio-pending-draft"/u, "every cache write goes through the draft slot");
  assert.match(page, /restorePendingDraft<Batch>\(\{/u);
  assert.doesNotMatch(page, /batchId: initial\?\.batchId/u, "the cached edit is replayed whichever batch the page opens");
  assert.match(page, /if \(restore\.kind === "restored" && \(!initial\?\.batchId \|\| restore\.batch\.batch_id === initial\.batchId\)\) \{/u);
  assert.match(page, /const notices = \[restoreNotice\(restore\)\];/u, "the page must show the outcome of a replay it does not load");
  assert.match(page, /if \(notices\.some\(Boolean\)\) setNotice\(notices\.filter\(Boolean\)\.join\(" "\)\);/u);
  assert.match(page, /\}, \[dirty, busy, running, submitting, draftFingerprint\]\);/u, "the harness models the effect re-running when busy flips");
  assert.match(page, /await draftQueue\.flush\(\);\s*await callBatch\("archive", \{ batch_id: batch\.batch_id \}\);\s*draftOwner\.current \+= 1; draftQueue\.cancelPending\(\);/u,
    "archiving must let a waiting edit land first and ignore later responses for the old form");
  assert.match(page, /const \[draftSlot\] = useState\(\(\) => createPendingDraftSlot\(localStorage\)\)/u);
  assert.match(page, /hold: isDeterministicDraftError/u);
  assert.match(page, /draftSlot\.saved\(fingerprint, owner, value\)/u);
  assert.match(page, /draftSlot\.write\(\{ draft: value, fingerprint: draftFingerprint, \.\.\.\(base \? \{ base_updated_at: base \} : \{\}\) \}, draftOwner\.current\);\s*draftQueue\.enqueue\(/u);
  assert.match(page, /const b = await callBatch<Batch>\(action, payload\);\s*draftSlot\.started\(draftOwner\.current\);/u);
  assert.match(page, /if \(dropped && mounted\.current\) discardPendingDraft\(localStorage, [^;]+, fingerprint\);/u,
    "only an edit the user moved on from is backed up; leaving the page keeps it cached");
  assert.match(page, /"该批次的声音需要重新试听批准，或改选已批准的声音。"/u);
  assert.match(page, /setDirty\(false\); setNotice\(\[droppedNotice\.current, voiceWarning\(b\)\]\.filter\(Boolean\)\.join\(" "\)\);/u,
    "loading a batch must flag a voice that is no longer approved and keep a dropped-edit notice");

  console.log("Batch draft restore and save queue self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
