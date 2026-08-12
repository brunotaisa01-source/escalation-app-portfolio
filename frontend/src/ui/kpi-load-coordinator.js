const REGISTRY_KEY = Symbol.for('demo.escalation.kpi-loads');

function defaultRegistry() {
  if (!globalThis[REGISTRY_KEY]) globalThis[REGISTRY_KEY] = new Map();
  return globalThis[REGISTRY_KEY];
}

function publicState(entry) {
  return {
    status: entry.status, value: entry.value, error: entry.error,
    action: entry.status === 'unavailable' ? 'retry' : null,
  };
}

function broadcast(entry) {
  const state = publicState(entry);
  entry.listeners.forEach((listener) => listener(state));
}

function entryFor(registry, key, load) {
  if (!registry.has(key)) {
    registry.set(key, {
      load, status: 'idle', value: null, error: null, promise: null,
      scheduledPromise: null, timer: null, listeners: new Set(),
    });
  }
  return registry.get(key);
}

export function createKpiLoadCoordinator({ key, load, registry = defaultRegistry(), debounceMs = 300, onState = () => {} } = {}) {
  if (!key || typeof load !== 'function') throw new TypeError('KPI load coordinator requires a stable key and load function');
  const entry = entryFor(registry, String(key), load);
  entry.listeners.add(onState);

  function run(force) {
    if (entry.promise) return entry.promise;
    if (!force && entry.status === 'ready') return Promise.resolve(entry.value);
    entry.status = 'loading';
    entry.error = null;
    broadcast(entry);
    entry.promise = Promise.resolve(entry.load({ force })).then((value) => {
      entry.status = 'ready';
      entry.value = value;
      broadcast(entry);
      return value;
    }).catch((error) => {
      entry.status = 'unavailable';
      entry.error = error;
      broadcast(entry);
      throw error;
    }).finally(() => { entry.promise = null; });
    return entry.promise;
  }

  function refreshAfterSave() {
    if (entry.scheduledPromise) return entry.scheduledPromise;
    entry.scheduledPromise = new Promise((resolve, reject) => {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        run(true).then(resolve, reject).finally(() => { entry.scheduledPromise = null; });
      }, Math.max(0, Number(debounceMs) || 0));
    });
    return entry.scheduledPromise;
  }

  return {
    start: () => run(false), retry: () => run(true), refreshAfterSave,
    getState: () => publicState(entry),
    dispose: () => entry.listeners.delete(onState),
  };
}
