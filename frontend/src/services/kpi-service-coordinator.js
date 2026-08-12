function copyKpis(value) {
  return { ...value, oldestOpen: value?.oldestOpen ? { ...value.oldestOpen } : null };
}

export function createKpiServiceCoordinator({ scan, mapItem } = {}) {
  if (typeof scan !== 'function' || typeof mapItem !== 'function') throw new TypeError('KPI coordinator requires scan and mapping functions');
  let cache = null;
  let inFlight = null;

  function load({ force = false, signal } = {}) {
    if (!force && cache) return Promise.resolve(copyKpis(cache));
    if (inFlight) return inFlight;
    inFlight = Promise.resolve(scan({ signal, mapItem })).then((value) => {
      cache = { ...value, stale: false, loadedAt: Date.now() };
      return copyKpis(cache);
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function markStale() {
    if (cache) cache = { ...cache, stale: true };
  }

  return { load, markStale, getCached: () => cache ? copyKpis(cache) : null };
}
