export function createAuthoritativeReconciler({ mapItem, caches = [] } = {}) {
  if (typeof mapItem !== 'function' || !caches.length || caches.some((cache) => typeof cache?.reconcile !== 'function')) {
    throw new TypeError('Authoritative reconciliation requires mapping and predicate cache ownership');
  }
  return (rawItem) => {
    const item = mapItem(rawItem);
    caches.forEach((cache) => cache.reconcile(item));
    return item;
  };
}
