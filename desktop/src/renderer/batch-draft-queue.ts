// One writer per page. A delayed response never replaces a newer draft.
const writers = new Set<Promise<void>>();
export async function waitForDraftWrites() {
  while (writers.size) await Promise.allSettled([...writers]);
}

export function createDraftQueue<T extends { batch_id?: string }, R extends { batch_id: string }>({
  save, saved, failed, active,
}: {
  save: (draft: T) => Promise<R>;
  saved: (result: R, fingerprint: string, owner: number) => void;
  failed: (error: unknown, owner: number) => void;
  active: (saving: boolean) => void;
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
          pending ||= ticket;
          failed(error, ticket.owner);
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
