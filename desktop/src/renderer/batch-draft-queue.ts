// One writer per page. A delayed response never replaces a newer draft.
const writers = new Set<Promise<void>>();
export async function waitForDraftWrites() {
  while (writers.size) await Promise.allSettled([...writers]);
}

export const PENDING_DRAFT_KEY = "batch-studio-pending-draft";
export const DISCARDED_DRAFT_KEY = "batch-studio-discarded-draft";
// The engine rejects these drafts the same way on every replay. Anything else
// (runtime unavailable, busy, paused, pipe failure, update hold, no code) can
// clear up by itself, so the local edit is kept for the next attempt.
const DETERMINISTIC_DRAFT_ERRORS = new Set([
  "auto_mix_voice_persona_approval_required", "auto_mix_voice_persona_not_found", "invalid_voice_persona_id",
  "invalid_narrated_settings", "invalid_narrated_groups", "invalid_narrated_count",
  "invalid_asset_ids", "invalid_asset_id", "asset_archived", "asset_not_found",
  "collection_not_found", "brand_profile_not_found", "narrated_batch_not_found", "invalid_params", "invalid_id",
  // A batch whose task row is gone fails every read the same way.
  "task_not_found",
]);
export function isDeterministicDraftError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && DETERMINISTIC_DRAFT_ERRORS.has(code);
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Draft = Record<string, unknown> & { batch_id?: string };
// base_updated_at is the batch state the edit was made on, so a replay can tell
// whether the batch changed since. Edits cached by older builds do not carry it.
export type PendingDraft = { draft?: Draft; fingerprint?: string; base_updated_at?: string };
function readPending(storage: DraftStorage): PendingDraft | null {
  try {
    const value = JSON.parse(storage.getItem(PENDING_DRAFT_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

// Copies the cached edit verbatim to a single backup slot before it stops being
// replayed. With a fingerprint, only that exact edit is moved, never a newer one.
// "absent": the slot no longer holds that edit (already moved, restored or replaced).
// "failed": the backup could not be written, so the edit stays where it was.
function movePendingDraft(storage: DraftStorage, reason: string, fingerprint?: string): "moved" | "absent" | "failed" {
  let raw: string | null;
  try { raw = storage.getItem(PENDING_DRAFT_KEY); } catch { return "failed"; }
  if (raw === null) return "absent";
  if (fingerprint !== undefined) {
    let current: { fingerprint?: unknown } | null = null;
    try { current = JSON.parse(raw); } catch { /* Not the edit that failed. */ }
    if (current?.fingerprint !== fingerprint) return "absent";
  }
  try {
    storage.setItem(DISCARDED_DRAFT_KEY, JSON.stringify({ discarded_at: new Date().toISOString(), reason, pending: raw }));
    storage.removeItem(PENDING_DRAFT_KEY);
    return "moved";
  } catch { return "failed"; }
}
export function discardPendingDraft(storage: DraftStorage, reason: string, fingerprint?: string) {
  return movePendingDraft(storage, reason, fingerprint) === "moved";
}

// The page's cache slot. The page only overwrites or clears its own latest edit for
// the current form; anything else found there (an edit a restore kept from an earlier
// session, one the page has moved on from, one from an older build) is backed up
// first. If that backup fails it stays in place and IPC alone saves the new edit.
export function createPendingDraftSlot(storage: DraftStorage) {
  let own: { fingerprint: string; owner: number } | null = null;
  const mine = (owner: number) => own?.owner === owner ? own.fingerprint : undefined;
  return {
    write(entry: { draft: Draft; fingerprint: string; base_updated_at?: string }, owner: number) {
      try {
        if (storage.getItem(PENDING_DRAFT_KEY) !== null) {
          const current = readPending(storage)?.fingerprint;
          const replaceable = typeof current === "string" && current === mine(owner);
          if (!replaceable && !discardPendingDraft(storage, "replaced", typeof current === "string" ? current : undefined)) return false;
        }
        storage.setItem(PENDING_DRAFT_KEY, JSON.stringify(entry));
        own = { fingerprint: entry.fingerprint, owner };
        return true;
      } catch { return false; }
    },
    // A save landed: its cached copy is done. A newer cached edit of the same form now
    // belongs to the saved batch and is based on the batch's new state.
    saved(fingerprint: string, owner: number, batch: { batch_id: string; updated_at?: string }) {
      try {
        const current = readPending(storage);
        if (!current?.draft || current.fingerprint === undefined || current.fingerprint !== mine(owner)) return;
        if (current.fingerprint === fingerprint) storage.removeItem(PENDING_DRAFT_KEY);
        else if (!current.draft.batch_id || current.draft.batch_id === batch.batch_id) {
          storage.setItem(PENDING_DRAFT_KEY, JSON.stringify({ ...current, draft: { ...current.draft, batch_id: batch.batch_id },
            ...(batch.updated_at ? { base_updated_at: batch.updated_at } : {}) }));
        }
      } catch { /* The main-process save is authoritative. */ }
    },
    // A task start saved the whole form, so this page's own cached edit is done.
    started(owner: number) {
      try {
        const fingerprint = mine(owner);
        if (fingerprint !== undefined && readPending(storage)?.fingerprint === fingerprint) storage.removeItem(PENDING_DRAFT_KEY);
      } catch { /* Nothing else reads the slot in this session. */ }
    },
  };
}

type RestorableBatch = {
  status?: string; archived?: boolean; updated_at?: string; script_confirmation?: unknown;
  groups?: Record<string, unknown>; candidates?: { status?: string; generated_video_id?: string | null }[];
};
const PRODUCED_STATUSES = new Set(["rendering", "awaiting_confirmation", "completed", "completed_with_errors"]);
const assetCount = (groups: unknown) => groups && typeof groups === "object"
  ? Object.values(groups).reduce<number>((sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0), 0) : 0;
const BLOCKED_RESTORE = {
  batch_archived: "上次未保存的编辑属于已归档的批次，没有写回",
  batch_produced: "上次未保存的编辑属于已确认文案或已有成片的批次，为避免覆盖已完成的内容，没有写回",
  batch_not_draft: "上次未保存的编辑所属的批次已生成文案或已开始处理，为避免覆盖其中的结果，没有写回",
  batch_changed: "上次未保存的编辑之后，所属批次又有了更新，为避免用旧内容覆盖，没有写回",
  draft_without_materials: "上次未保存的编辑没有素材，写回会清空所属批次已选的素材，所以没有写回",
} as const;
export type RestoreBlocker = keyof typeof BLOCKED_RESTORE;
// Why a cached edit must not be saved over this batch, or null when it may. A save that
// changes materials or the brief clears generated copy, confirmed copy and candidates,
// so a replay only lands on a batch still in draft that has not changed since the edit
// was made. An edit cached by an older build has no base; it is at least kept from
// emptying the batch's materials.
export function restoreBlocker(batch: RestorableBatch, entry: PendingDraft): RestoreBlocker | null {
  if (batch.archived) return "batch_archived";
  if (batch.script_confirmation || PRODUCED_STATUSES.has(batch.status || "")
      || batch.candidates?.some((c) => c.status === "completed" || c.generated_video_id)) return "batch_produced";
  if (batch.status !== "draft") return "batch_not_draft";
  if (entry.base_updated_at !== undefined) return entry.base_updated_at === batch.updated_at ? null : "batch_changed";
  return assetCount(batch.groups) > 0 && assetCount(entry.draft?.groups) === 0 ? "draft_without_materials" : null;
}

export type DraftRestore<B> = { kind: "none" } | { kind: "restored"; batch: B } | { kind: "kept" | "discarded"; message: string };
const reasonOf = (error: unknown) => (error as Error | null)?.message || "操作未完成。";
const KEPT_AFTER_REJECTION = "这份编辑仍保留在本机，下次打开时会再次检查。";
type RestoreOptions<B> = {
  storage: DraftStorage;
  get: (batchId: string) => Promise<B>;
  save: (draft: Record<string, unknown>) => Promise<B>;
};
// Every open replays the cached edit, whichever batch the page opens: it belongs to one
// batch (or to a new one), and leaving it for a later open lets the first keystroke on
// another batch replace it without a word. Opens that overlap (React StrictMode runs
// the mount effect twice in development) share one replay and one result, so a second
// run cannot report on an edit the first one already moved.
const restoring = new WeakMap<DraftStorage, Promise<DraftRestore<unknown>>>();
export function restorePendingDraft<B extends RestorableBatch>(options: RestoreOptions<B>): Promise<DraftRestore<B>> {
  const running = restoring.get(options.storage) as Promise<DraftRestore<B>> | undefined;
  if (running) return running;
  const flight = restoreOnce(options).finally(() => restoring.delete(options.storage));
  restoring.set(options.storage, flight);
  return flight;
}
// The page's notice for a replay it does not load: a kept or rejected edit says why, and
// one restored into another batch than the page opened says where it went.
export const RESTORED_ELSEWHERE = "上次未保存的编辑已存回它所属的视频草稿，可在「制作记录」中找到。";
export function restoreNotice(restore: DraftRestore<unknown>) {
  return restore.kind === "restored" ? RESTORED_ELSEWHERE : restore.kind === "none" ? "" : restore.message;
}
async function restoreOnce<B extends RestorableBatch>({ storage, get, save }: RestoreOptions<B>): Promise<DraftRestore<B>> {
  const pending = readPending(storage);
  const draft = pending?.draft;
  if (!pending || !draft || typeof draft !== "object") return { kind: "none" };
  // The replay stops only once a copy exists. Without one the edit stays cached, the
  // message says so, and the next open checks it again. If the edit has left the slot
  // meanwhile, whatever moved it decided its fate and there is nothing to report.
  const stop = (reason: string, discarded: string, kept: string): DraftRestore<B> => {
    const moved = movePendingDraft(storage, reason, pending.fingerprint);
    return moved === "moved" ? { kind: "discarded", message: discarded } : moved === "absent" ? { kind: "none" } : { kind: "kept", message: kept };
  };
  try {
    if (draft.batch_id) {
      const blocker = restoreBlocker(await get(draft.batch_id), pending);
      if (blocker) {
        const message = BLOCKED_RESTORE[blocker];
        return stop(blocker, `${message}，也不会再自动恢复。`, `${message}。${KEPT_AFTER_REJECTION}`);
      }
    }
    const batch = await save(draft);
    try {
      if (readPending(storage)?.fingerprint === pending.fingerprint) storage.removeItem(PENDING_DRAFT_KEY);
    } catch { /* The save already landed. */ }
    return { kind: "restored", batch };
  } catch (error) {
    if (!isDeterministicDraftError(error)) {
      return { kind: "kept", message: `上次未保存的编辑暂未恢复：${reasonOf(error)}下次打开工作台时会再尝试；如果现在开始新的编辑，将以新的编辑为准。` };
    }
    return stop(String((error as { code?: unknown }).code),
      `上次未保存的编辑没有恢复，也不会再自动恢复：${reasonOf(error)}`,
      `上次未保存的编辑没有恢复：${reasonOf(error)}${KEPT_AFTER_REJECTION}`);
  }
}

export function createDraftQueue<T extends { batch_id?: string }, R extends { batch_id: string }>({
  save, saved, failed, active, hold,
}: {
  save: (draft: T) => Promise<R>;
  saved: (result: R, fingerprint: string, owner: number) => void;
  // dropped: an explicit flush retried an edit the engine had already rejected, it was
  // rejected again, and the queue let go of it so the page can move on.
  failed: (error: unknown, owner: number, fingerprint: string, dropped: boolean) => void;
  active: (saving: boolean) => void;
  // Errors the engine repeats on every attempt. Such an edit is held instead of retried
  // in the background; the next explicit flush ("新建视频", "选择任务", leaving the page)
  // tries it once more, since the user may have fixed the cause meanwhile.
  hold?: (error: unknown) => boolean;
}) {
  type Ticket = { draft: T; fingerprint: string; owner: number; rejected?: boolean };
  let pending: Ticket | null = null;
  let held: Ticket | null = null;
  let flight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const created = new Map<number, string>();
  function run(explicit: boolean): Promise<void> {
    clearTimeout(timer);
    if (flight) return flight;
    if (explicit && held) { pending ||= held; held = null; }
    if (!pending) return Promise.resolve();
    active(true);
    flight = Promise.resolve().then(async () => {
      while (pending) {
        const ticket = pending;
        pending = null;
        try {
          const result = await save({ ...ticket.draft,
            ...(ticket.draft.batch_id || !created.has(ticket.owner) ? {} : { batch_id: created.get(ticket.owner) }),
          });
          created.set(ticket.owner, result.batch_id);
          saved(result, ticket.fingerprint, ticket.owner);
        } catch (error) {
          // A newer edit of the form arrived meanwhile and replaces this one; save it now
          // rather than wait for another keystroke.
          if (pending) continue;
          const repeated = hold?.(error) === true;
          const dropped = repeated && explicit && ticket.rejected === true;
          if (!repeated) pending = ticket;
          else if (!dropped) held = { ...ticket, rejected: true };
          failed(error, ticket.owner, ticket.fingerprint, dropped);
          if (!dropped) throw error;
        }
      }
    }).finally(() => { writers.delete(flight!); flight = null; active(false); });
    writers.add(flight);
    return flight;
  }
  return {
    enqueue(draft: T, fingerprint: string, owner: number) {
      clearTimeout(timer);
      // The page re-enqueues the unchanged form after every failed action. That is still
      // the edit the engine rejected: keep holding it, marked, without a background retry,
      // so the next explicit flush is its second and last try.
      if (held && held.fingerprint === fingerprint && held.owner === owner) {
        held = { ...held, draft };
        pending = null;
        return;
      }
      pending = { draft, fingerprint, owner };
      held = null;
      timer = setTimeout(() => { void run(false).catch(() => undefined); }, 400);
    },
    flush: () => run(true),
    cancelPending() { clearTimeout(timer); pending = null; held = null; },
    busy: () => flight !== null,
  };
}
