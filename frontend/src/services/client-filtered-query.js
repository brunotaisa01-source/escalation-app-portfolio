function requestKey(request) {
  return JSON.stringify({
    status: request.status ?? 'All', statuses: request.statuses ?? [], query: request.query ?? '',
    sourceQueues: request.sourceQueues ?? [], priorities: request.priorities ?? [],
    vendor: request.vendor, vendorMatched: request.vendorMatched,
    receivedBefore: request.receivedBefore, columnFilters: request.columnFilters ?? {},
  });
}

export function createClientFilteredQuery({ loadAll, matches, limit = 4 } = {}) {
  if (typeof loadAll !== 'function' || typeof matches !== 'function') {
    throw new TypeError('Client filtered query requires a bounded loader and complete predicate');
  }
  const contexts = new Map();

  function load(request) {
    const key = requestKey(request);
    if (contexts.has(key)) return contexts.get(key).promise;
    if (contexts.size >= limit) contexts.delete(contexts.keys().next().value);
    const context = { request: { ...request }, rows: null, promise: null };
    context.promise = Promise.resolve(loadAll(request)).then((rows) => {
      context.rows = rows;
      return rows;
    }).catch((error) => {
      contexts.delete(key);
      throw error;
    });
    contexts.set(key, context);
    return context.promise;
  }

  async function read(request, page, pageSize) {
    const rows = await load(request);
    const start = (page - 1) * pageSize;
    return {
      items: rows.slice(start, start + pageSize),
      total: rows.length,
      hasNext: start + pageSize < rows.length,
    };
  }

  function reconcile(item) {
    for (const context of contexts.values()) {
      if (!context.rows) continue;
      const index = context.rows.findIndex((row) => String(row.id) === String(item.id));
      const belongs = matches(item, context.request);
      if ((index >= 0) !== belongs) {
        contexts.clear();
        return item;
      }
      if (index >= 0) context.rows[index] = { ...context.rows[index], ...item };
    }
    return item;
  }

  return { read, reconcile, clear: () => contexts.clear() };
}
