type StatusSource<T> = {
  status: () => Promise<T>;
  onUpdate?: (callback: (result: T) => void) => () => void;
};

export function subscribeToStatus<T>(
  source: StatusSource<T>,
  applyResult: (result: T) => void,
  onError: () => void,
  intervalMs: number
): () => void {
  let active = true;
  let polling = false;
  let pushedRevision = 0;
  const refresh = async () => {
    if (!active || polling) return;
    polling = true;
    const startingRevision = pushedRevision;
    try {
      const result = await source.status();
      if (active && startingRevision === pushedRevision) applyResult(result);
    } catch {
      if (active && startingRevision === pushedRevision) onError();
    } finally {
      polling = false;
    }
  };
  const unsubscribe = source.onUpdate?.((result) => {
    if (!active) return;
    pushedRevision += 1;
    applyResult(result);
  });
  void refresh();
  const timer = window.setInterval(() => void refresh(), intervalMs);
  return () => {
    active = false;
    unsubscribe?.();
    window.clearInterval(timer);
  };
}
