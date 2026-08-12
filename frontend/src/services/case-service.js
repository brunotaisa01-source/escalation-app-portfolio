import { canonicalStatus, DEFAULT_FIELD_MAPPING } from '../config/runtime-config.example.js';
import { matchesCaseRequest } from '../domain/case-filter.js';
import { deriveDaysToResolve } from '../domain/case-duration.js';
import { isClosedStatus, isOpenStatus } from '../domain/status-policy.js';
import { isVendorConfirmed, isVendorUnmatched } from '../domain/vendor-match.js';
import { createAuthoritativeReconciler } from './authoritative-reconciliation.js';
import { createCaseExportFacade } from './case-export-facade.js';
import { createClientFilteredQuery } from './client-filtered-query.js';
import { createKpiServiceCoordinator } from './kpi-service-coordinator.js';
import { createPageContextCache } from './page-context-cache.js';
import { createQueryTotalCoordinator } from './query-total-coordinator.js';
import { createSharePointClient } from './sharepoint-client.js';
import { requiresClientTraversal } from './sharepoint-query.js';

const STATUS_VALUES = new Set(['Action Required', 'In Progress', 'Closed', 'Duplicate']);
const PRIORITY_VALUES = new Set(['Low', 'Medium', 'High', 'Critical']);
const OPEN_STATUSES = Object.freeze({ has: isOpenStatus });

function normaliseCase(item, index, { mockEtag = true } = {}) {
  const normalised = {
    ...item,
    id: item.id ?? item.ID ?? index + 1,
    Status: item.Status == null ? '' : canonicalStatus(item.Status),
    Priority: item.Priority ?? '',
    Title: item.Title ?? item.Reference ?? `Escalation ${index + 1}`,
  };
  normalised.DaysToResolve = deriveDaysToResolve(normalised.ReceivedDateTime, normalised.DateResolved);
  const etag = item.__etag ?? (mockEtag ? `W/"mock-${index + 1}"` : null);
  if (etag) normalised.__etag = etag;
  else delete normalised.__etag;
  return normalised;
}

function mapSharePointCase(item, fieldMapping) {
  const mapped = { ...item };
  Object.entries(fieldMapping).forEach(([field, internalName]) => {
    if (item[internalName] !== undefined) mapped[field] = item[internalName];
  });
  mapped.__etag = item['@odata.etag'] ?? item.ETag ?? item['odata.etag'] ?? item.__etag;
  mapped.id = mapped.id ?? mapped.ID ?? mapped.Id;
  if (mapped.Status !== undefined) mapped.Status = canonicalStatus(mapped.Status);
  if (!mapped.__etag) delete mapped.__etag;
  return mapped;
}

function createMockUpdater(readCases, writeCases) {
  return (id, patch, expectedEtag) => {
    const cases = readCases();
    const index = cases.findIndex((item) => String(item.id) === String(id));
    if (index < 0) throw new Error('Escalation not found');
    if (patch.Status !== undefined && !STATUS_VALUES.has(patch.Status)) throw new Error('Status is not controlled');
    if (patch.Priority !== undefined && !PRIORITY_VALUES.has(patch.Priority)) throw new Error('Priority is not controlled');
    if (expectedEtag && expectedEtag !== cases[index].__etag) {
      const error = new Error('Edit conflict');
      error.code = 'ETAG_CONFLICT';
      throw error;
    }
    const next = [...cases];
    next[index] = { ...next[index], ...patch, __etag: `W/"mock-${Date.now()}"` };
    writeCases(next);
    return next[index];
  };
}

export function createCaseService(seed = []) {
  let cases = seed.map(normaliseCase);
  const filter = (request = {}) => cases.filter((item) => matchesCaseRequest(item, request));
  const oldestOpen = () => cases.filter((item) => isOpenStatus(item.Status))
    .sort((a, b) => String(a.ReceivedDateTime ?? '').localeCompare(String(b.ReceivedDateTime ?? '')))[0] ?? null;
  const update = createMockUpdater(() => cases, (next) => { cases = next; });
  const get = (id) => {
    const item = cases.find((candidate) => String(candidate.id) === String(id));
    if (!item) throw new Error('Escalation not found');
    return { ...item };
  };
  return {
    mode: 'mock', filter,
    getCurrentUser: async () => null,
    invalidateReadCaches() {},
    query({ page = 1, pageSize = 10, ...request } = {}) {
      const filtered = filter(request);
      const start = Math.max(0, (page - 1) * pageSize);
      return { items: filtered.slice(start, start + pageSize), page, pageSize, total: filtered.length, hasNext: start + pageSize < filtered.length };
    },
    exportAll: (request = {}) => filter(request).map((item) => ({ ...item })),
    counts() {
      return {
        open: cases.filter((item) => isOpenStatus(item.Status)).length,
        closed: cases.filter((item) => isClosedStatus(item.Status)).length,
        critical: cases.filter((item) => item.Priority === 'Critical').length,
        vendorUnmatched: cases.filter(isVendorUnmatched).length,
        oldestOpen: oldestOpen(), stale: false,
      };
    },
    loadKpis() { return this.counts(); }, markKpisStale() {}, hydrateForEdit: get, oldestOpen,
    searchVendorReference(query = '') {
      const needle = String(query).trim().toLocaleLowerCase();
      return cases.filter((item) => !needle || [item.Vendor, item.VendorName, item.VendorCategory, item.VendorLookupKey]
        .filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
        .map(({ id, Title, Vendor, VendorName, VendorCategory, VendorLookupKey }) => ({ id, Title, Vendor, VendorName, VendorCategory, VendorLookupKey }));
    },
    update, get, snapshot: () => cases.map((item) => ({ ...item })),
  };
}

function createSharePointRuntime(config, fetchImpl) {
  const client = createSharePointClient(config, fetchImpl);
  const mapping = { ...DEFAULT_FIELD_MAPPING, ...(config.fieldMapping ?? {}) };
  const mapItem = (item, index = 0) => normaliseCase(mapSharePointCase(item, mapping), index, { mockEtag: false });
  const loadFirst = async (request) => mapPage(await client.listItems(request), mapItem);
  const loadNext = async (nextLink) => mapPage(await client.listItems({ nextLink }), mapItem);
  const kpis = createKpiServiceCoordinator({ scan: (options) => client.scanKpis(options), mapItem });
  const exactCount = async (request) => {
    if (canUseKpiTotal(request)) {
      const counts = await kpis.load({ force: kpis.getCached()?.stale === true });
      if (request.status === 'Open') return counts.open;
      if (request.status === 'Closed') return counts.closed;
      return counts.open + counts.closed;
    }
    return client.countItems({ mapItem, matches: (item) => matchesCaseRequest(item, request) });
  };
  const totals = createQueryTotalCoordinator({
    count: exactCount,
  });
  const pageCache = createPageContextCache({ loadFirst, loadNext, matches: matchesCaseRequest, totalFor: totals.get });
  const exportAll = createCaseExportFacade({ exportItems: (options) => client.exportItems(options), mapItem, matches: matchesCaseRequest });
  const clientQuery = createClientFilteredQuery({ loadAll: exportAll, matches: matchesCaseRequest });
  const reconcile = createAuthoritativeReconciler({ mapItem, caches: [pageCache, clientQuery] });
  return { client, mapItem, pageCache, clientQuery, reconcile, kpis, exportAll, totals };
}

function canUseKpiTotal(request = {}) {
  const noValues = (value) => !Array.isArray(value) || value.length === 0;
  return ['Open', 'Closed', 'All'].includes(request.status ?? 'All')
    && noValues(request.statuses) && noValues(request.sourceQueues) && noValues(request.priorities)
    && !request.query && !request.priority && !request.vendor && request.vendorMatched === undefined
    && !request.receivedBefore && !Object.keys(request.columnFilters ?? {}).length;
}

function mapPage(response, mapItem) {
  return {
    items: response.items.map((item, index) => mapItem(item, index)),
    nextLink: response.nextLink,
    total: response.total,
  };
}

function createSharePointQuery(pageCache, clientQuery) {
  return async ({ page = 1, pageSize = 10, ...request } = {}) => {
    if (![10, 20, 50].includes(Number(pageSize))) throw new RangeError('Page size must be 10, 20 or 50');
    const requestedPage = Math.max(1, Number(page));
    const complete = { ...request, pageSize: Number(pageSize) };
    const result = requiresClientTraversal(complete)
      ? await clientQuery.read(complete, requestedPage, Number(pageSize))
      : await pageCache.read(complete, requestedPage);
    return {
      items: result.items, page: requestedPage, pageSize: Number(pageSize),
      total: result.total, totalPromise: result.totalPromise,
      hasNext: result.hasNext ?? (Number.isFinite(result.total)
        ? requestedPage * Number(pageSize) < result.total
        : Boolean(result.nextLink)),
    };
  };
}

export function createSharePointCaseService(config, fetchImpl = globalThis.fetch) {
  const runtime = createSharePointRuntime(config, fetchImpl);
  return {
    mode: 'sharepoint',
    getCurrentUser: runtime.client.getCurrentUser,
    invalidateReadCaches({ includeTotals = false } = {}) {
      runtime.pageCache.clear();
      runtime.clientQuery.clear();
      if (includeTotals) {
        runtime.totals.clear();
        runtime.kpis.markStale();
      }
    },
    query: createSharePointQuery(runtime.pageCache, runtime.clientQuery),
    loadKpis: runtime.kpis.load,
    counts: runtime.kpis.load,
    markKpisStale: runtime.kpis.markStale,
    exportAll: runtime.exportAll,
    async oldestOpen() {
      const response = await runtime.client.listItems({ status: 'Open', pageSize: 1 });
      return response.items[0] ? runtime.mapItem(response.items[0]) : null;
    },
    searchVendorReference: (query = '') => runtime.client.searchVendorReference(query),
    async get(id) { return runtime.reconcile(await runtime.client.getItem(id)); },
    async hydrateForEdit(id) { return runtime.reconcile(await runtime.client.getEditableItem(id)); },
    async update(id, patch, expectedEtag) {
      const result = await runtime.client.updateItem(id, patch, expectedEtag);
      runtime.kpis.markStale();
      runtime.pageCache.clear();
      runtime.clientQuery.clear();
      runtime.totals.clear();
      return result;
    },
  };
}

export function createConfiguredCaseService(config = {}, fetchImpl = globalThis.fetch, mockSeed = []) {
  if (config.mode === 'mock') return createCaseService(config.seed ?? mockSeed);
  if (config.mode === 'sharepoint') {
    try { return createSharePointCaseService(config, fetchImpl); }
    catch (error) { return createUnavailableCaseService(error.message); }
  }
  return createUnavailableCaseService('Unsupported runtime mode; choose sharepoint or explicitly choose mock for local preview');
}

export function createUnavailableCaseService(message) {
  const fail = () => Promise.reject(new Error(message));
  return {
    mode: 'unavailable', query: fail, counts: fail, loadKpis: fail, markKpisStale() {},
    getCurrentUser: fail, invalidateReadCaches() {}, hydrateForEdit: fail, oldestOpen: fail,
    searchVendorReference: fail, exportAll: fail, update: fail, get: fail,
  };
}

export { isVendorConfirmed, isVendorUnmatched, OPEN_STATUSES, PRIORITY_VALUES, STATUS_VALUES };
