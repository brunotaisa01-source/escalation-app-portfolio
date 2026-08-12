const DEFAULT_CONTEXT_LIMIT = 8;
const DEFAULT_PAGE_LIMIT = 8;

function boundedSet(map, key, value, limit) {
  if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, value);
}

function requestKey(request) {
  const stable = {
    status: request.status ?? 'All', statuses: request.statuses ?? [], query: request.query ?? '',
    pageSize: request.pageSize, priority: request.priority, sourceQueues: request.sourceQueues ?? [],
    priorities: request.priorities ?? [], vendor: request.vendor, vendorMatched: request.vendorMatched,
    receivedBefore: request.receivedBefore, columnFilters: request.columnFilters ?? {},
  };
  return JSON.stringify(stable);
}

export function createPageContextCache({ loadFirst, loadNext, matches, totalFor, contextLimit = DEFAULT_CONTEXT_LIMIT, pageLimit = DEFAULT_PAGE_LIMIT } = {}) {
  if (typeof loadFirst !== 'function' || typeof loadNext !== 'function') throw new TypeError('Page cache requires first/next loaders');
  if (typeof matches !== 'function') throw new TypeError('Page cache requires a complete request predicate');
  const contexts = new Map();

  function contextFor(request) {
    const key = requestKey(request);
    if (!contexts.has(key)) boundedSet(contexts, key, { request: { ...request }, pages: new Map(), total: null, totalPromise: null }, contextLimit);
    return contexts.get(key);
  }

  function storePage(context, page, value) {
    const pageSize = Number(context.request.pageSize) || value.items.length || 10;
    if (Number.isFinite(value.total)) context.total = Number(value.total);
    if (!Number.isFinite(context.total) && !value.nextLink) context.total = ((page - 1) * pageSize) + value.items.length;
    if (!Number.isFinite(context.total) && value.nextLink && typeof totalFor === 'function' && !context.totalPromise) {
      context.totalPromise = Promise.resolve(totalFor(context.request)).then((total) => {
        context.total = Number(total);
        context.totalPromise = null;
        context.pages.forEach((cached) => { cached.total = context.total; delete cached.totalPromise; });
        return context.total;
      });
    }
    const stored = { ...value, total: context.total };
    if (context.totalPromise) stored.totalPromise = context.totalPromise;
    boundedSet(context.pages, page, stored, pageLimit);
    return stored;
  }

  async function read(request, page = 1) {
    const context = contextFor(request);
    if (context.pages.has(page)) return context.pages.get(page);
    if (page === 1) return storePage(context, page, await loadFirst(request));
    const previous = await read(request, page - 1);
    if (!previous.nextLink) return storePage(context, page, { items: [], nextLink: null, total: previous.total });
    return storePage(context, page, await loadNext(previous.nextLink, request));
  }

  function reconcile(item) {
    for (const context of contexts.values()) {
      const present = [...context.pages.values()].some((page) => page.items.some((row) => String(row.id) === String(item.id)));
      const belongs = matches(item, context.request);
      if (present !== belongs) {
        context.pages.clear();
        continue;
      }
      if (!present) continue;
      for (const page of context.pages.values()) {
        page.items = page.items.map((row) => String(row.id) === String(item.id) ? { ...row, ...item } : row);
      }
    }
    return item;
  }

  return { read, reconcile, clear: () => contexts.clear(), contextCount: () => contexts.size };
}
