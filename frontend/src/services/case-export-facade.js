export function createCaseExportFacade({ exportItems, mapItem, matches } = {}) {
  if (typeof exportItems !== 'function' || typeof mapItem !== 'function' || typeof matches !== 'function') {
    throw new TypeError('Export facade requires traversal, mapping and predicate functions');
  }
  return (request = {}, { signal } = {}) => exportItems({
    signal,
    mapItem,
    matches: (item) => matches(item, request),
  });
}
