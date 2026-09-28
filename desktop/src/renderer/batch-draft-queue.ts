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
]);
export function isDeterministicDraftError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && DETERMINISTIC_DRAFT_ERRORS.has(code);
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
// Copies the cached edit verbatim to a single backup slot before it stops being
// replayed. With a fingerprint, only that exact edit is moved, never a newer one.
// If the backup cannot be written the edit stays where it was.
export function discardPendingDraft(storage: DraftStorage, reason: string, fingerprint?: string) {
  try {
    const raw = storage.getItem(PENDING_DRAFT_KEY);
    if (raw === null) return false;
    if (fingerprint !== undefined) {
      let current: { fingerprint?: unknown } | null = null;
      try { current = JSON.parse(raw); } catch { /* Not the edit that failed. */ }
      if (current?.fingerprint !== fingerprint) return false;
    }
    storage.setItem(DISCARDED_DRAFT_KEY, JSON.stringify({ discarded_at: new Date().toISOString(), reason, pending: raw }));
    storage.removeItem(PENDING_DRAFT_KEY);
    return true;
  } catch { return false; }
}

type RestorableBatch = {
  status?: string; archived?: boolean; script_confirmation?: unknown; completed_count?: number;
  groups?: Record<string, unknown>; candidates?: { status?: string; generated_video_id?: string | null }[];
};
const PRODUCED_STATUSES = new Set(["rendering", "awaiting_confirmation", "completed", "completed_with_errors"]);
const assetCount = (groups: unknown) => groups && typeof groups === "object"
  ? Object.values(groups).reduce<number>((sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0), 0) : 0;
// A cached edit may only land on a batch that is still being drafted: saving it
// over confirmed copy or finished works resets them, and an edit without the
// batch's materials would empty its groups.
export function draftMayOverwrite(batch: RestorableBatch, draft: Record<string, unknown>) {
  if (batch.archived || batch.script_confirmation || PRODUCED_STATUSES.has(batch.status || "")) return false;
  if ((batch.completed_count || 0) > 0 || batch.candidates?.some((c) => c.status === "completed" || c.generated_video_id)) return false;
  return !(assetCount(batch.groups) > 0 && assetCount(draft.groups) === 0);
}

type PendingDraft = { draft?: Record<string, unknown> & { batch_id?: string }; fingerprint?: string };
export type DraftRestore<B> = { kind: "none" } | { kind: "restored"; batch: B } | { kind: "kept" | "discarded"; message: string };
const reasonOf = (error: unknown) => (error as Error | null)?.message || "操作未完成。";
export async function restorePendingDraft<B extends RestorableBatch>({ storage, batchId, get, save }: {
  storage: DraftStorage;
  batchId?: string;
  get: (batchId: string) => Promise<B>;
  save: (draft: Record<string, unknown>) => Promise<B>;
}): Promise<DraftRestore<B>> {
  let pending: PendingDraft | null = null;
  try { pending = JSON.parse(storage.getItem(PENDING_DRAFT_KEY) || "null"); } catch { /* Ignore invalid UI recovery data. */ }
  const draft = pending?.draft;
  if (!draft || (batchId && draft.batch_id !== batchId)) return { kind: "none" };
  const discard = (reason: string, message: string): DraftRestore<B> => {
    discardPendingDraft(storage, reason);
    return { kind: "discarded", message };
  };
  try {
    if (draft.batch_id) {
      const current = await get(draft.batch_id);
      if (!draftMayOverwrite(current, draft)) {
        return discard("batch_not_draft", "上次未保存的编辑属于已确认文案或已有成片的批次，为避免覆盖已完成的内容，没有写回；这份编辑已在本机另存备份。");
      }
    }
    const batch = await save(draft);
    try { storage.removeItem(PENDING_DRAFT_KEY); } catch { /* The save already landed. */ }
    return { kind: "restored", batch };
  } catch (error) {
    if (!isDeterministicDraftError(error)) {
      return { kind: "kept", message: `上次未保存的编辑暂未恢复：${reasonOf(error)}编辑内容仍保留在本机，下次打开时会继续恢复。` };
    }
    return discard(String((error as { code?: unknown }).code), `上次未保存的编辑无法恢复：${reasonOf(error)}这份编辑已在本机另存备份，不会再自动恢复。`);
  }
}

export function createDraftQueue<T extends { batch_id?: string }, R extends { batch_id: string }>({
  save, saved, failed, active, discard,
}: {
  save: (draft: T) => Promise<R>;
  saved: (result: R, fingerprint: string, owner: number) => void;
  failed: (error: unknown, owner: number, fingerprint: string) => void;
  active: (saving: boolean) => void;
  // A draft the engine will always reject is dropped instead of re-queued, so it
  // cannot hold up "新建视频" or task switching; the failing flush still reports it.
  discard?: (error: unknown) => boolean;
}) {
  let pending: { draft: T; fingerprint: string; owner: number } | null = null;
  let flight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const created = new Map<number, string>();
  function flush(): Promise<void> {
    clearTimeout(timer);
    if (flight) return flight;
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
          if (!discard?.(error)) pending ||= ticket;
          failed(error, ticket.owner, ticket.fingerprint);
          throw error;
        }
      }
    }).finally(() => { writers.delete(flight!); flight = null; active(false); });
    writers.add(flight);
    return flight;
  }
  return {
    enqueue(draft: T, fingerprint: string, owner: number) {
      pending = { draft, fingerprint, owner };
      clearTimeout(timer);
      timer = setTimeout(() => { void flush().catch(() => undefined); }, 400);
    },
    flush,
    cancelPending() { clearTimeout(timer); pending = null; },
    busy: () => flight !== null,
  };
}
