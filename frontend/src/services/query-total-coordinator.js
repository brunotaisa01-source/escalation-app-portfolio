function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function totalKey(request = {}) {
  const filters = { ...request };
  delete filters.page;
  delete filters.pageSize;
  return JSON.stringify(stableValue(filters));
}

export function createQueryTotalCoordinator({ count, limit = 8 } = {}) {
  if (typeof count !== 'function') throw new TypeError('Exact total coordinator requires a count function');
  const contexts = new Map();

  function get(request = {}) {
    const key = totalKey(request);
    if (contexts.has(key)) return contexts.get(key);
    if (contexts.size >= limit) contexts.delete(contexts.keys().next().value);
    const pending = Promise.resolve(count(request)).then((total) => {
      if (!Number.isFinite(total) || total < 0) throw new Error('Exact total traversal returned an invalid count');
      return Number(total);
    }).catch((error) => {
      contexts.delete(key);
      throw error;
    });
    contexts.set(key, pending);
    return pending;
  }

  return { get, clear: () => contexts.clear() };
}
