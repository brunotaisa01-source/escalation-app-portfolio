export function createLiveFilterController(options = {}) {
  const {
    apply, delayMs = 400,
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = (timer) => clearTimeout(timer),
  } = options;
  if (typeof apply !== 'function') throw new TypeError('Live filter controller requires an apply callback');
  let filters = { ...(options.initial ?? {}) };
  let generation = 0;
  let timer = null;

  function commit(expected) {
    if (expected !== generation) return;
    timer = null;
    apply({ ...filters });
  }

  function stage(field, entry) {
    generation += 1;
    if (timer !== null) cancel(timer);
    if (entry) filters[field] = entry;
    else delete filters[field];
    const expected = generation;
    timer = schedule(() => commit(expected), delayMs);
  }

  function applyNow(next = filters) {
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
    filters = { ...next };
    apply({ ...filters });
  }

  return {
    stage,
    applyNow,
    clear: (field) => {
      const next = { ...filters };
      delete next[field];
      applyNow(next);
    },
    clearAll: () => applyNow({}),
    replace: (next) => { filters = { ...(next ?? {}) }; },
    cancel: () => { generation += 1; if (timer !== null) cancel(timer); timer = null; },
    snapshot: () => ({ ...filters }),
  };
}
