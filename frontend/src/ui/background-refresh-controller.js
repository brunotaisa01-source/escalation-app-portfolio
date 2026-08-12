const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_FULL_REFRESH_EVERY = 10;

function intervalValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 5000 ? parsed : DEFAULT_INTERVAL_MS;
}

export function createBackgroundRefreshController({
  intervalMs = DEFAULT_INTERVAL_MS,
  fullRefreshEvery = DEFAULT_FULL_REFRESH_EVERY,
  invalidate = () => {},
  refresh,
  syncSelected = () => {},
  onError = () => {},
  windowTarget = globalThis,
  documentTarget = globalThis.document,
  schedule = globalThis.setInterval,
  cancel = globalThis.clearInterval,
} = {}) {
  if (typeof refresh !== 'function') throw new TypeError('Background refresh requires a refresh function');
  let timer = null;
  let pending = null;
  let cycle = 0;

  const visible = () => !documentTarget || documentTarget.visibilityState !== 'hidden';
  const run = (reason = 'timer') => {
    if (!visible()) return Promise.resolve(false);
    if (pending) return pending;
    cycle += 1;
    const includeTotals = cycle % Math.max(1, Number(fullRefreshEvery) || DEFAULT_FULL_REFRESH_EVERY) === 0;
    pending = Promise.resolve()
      .then(() => invalidate({ includeTotals }))
      .then(() => refresh({ reason, includeTotals }))
      .then(() => syncSelected({ reason }))
      .then(() => true)
      .catch((error) => { onError(error); return false; })
      .finally(() => { pending = null; });
    return pending;
  };
  const onFocus = () => { void run('focus'); };
  const onVisibility = () => { if (visible()) void run('visibility'); };

  return {
    run,
    start() {
      if (timer !== null) return;
      timer = schedule(() => { void run('timer'); }, intervalValue(intervalMs));
      windowTarget?.addEventListener?.('focus', onFocus);
      documentTarget?.addEventListener?.('visibilitychange', onVisibility);
    },
    stop() {
      if (timer !== null) cancel(timer);
      timer = null;
      windowTarget?.removeEventListener?.('focus', onFocus);
      documentTarget?.removeEventListener?.('visibilitychange', onVisibility);
    },
    isPending: () => Boolean(pending),
  };
}
