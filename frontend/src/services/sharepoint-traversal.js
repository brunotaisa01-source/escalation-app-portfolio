import { isVendorUnmatched } from '../domain/vendor-match.js';
import { buildIdKeysetQuery } from './sharepoint-query.js';
import { resolveNextLink } from './sharepoint-transport.js';
import { isClosedStatus, isOpenStatus } from '../domain/status-policy.js';

export const KPI_READ_FIELDS = Object.freeze([
  'id', 'Status', 'Priority', 'Vendor', 'VendorName', 'VendorCategory', 'ReceivedDateTime',
]);

function cancellationError() {
  const error = new Error('SharePoint traversal was cancelled');
  error.name = 'AbortError';
  error.code = 'TRAVERSAL_CANCELLED';
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError();
}

function retryDelay(error, attempt, baseDelay, maxDelay) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
  return Math.min(maxDelay, baseDelay * (2 ** attempt));
}

function wait(milliseconds, signal) {
  if (!milliseconds) {
    throwIfCancelled(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(cancellationError());
    }, { once: true });
  });
}

async function readWithRetry({ transport, url, signal, maxRetries, baseDelay, maxDelay }) {
  for (let attempt = 0; ; attempt += 1) {
    throwIfCancelled(signal);
    try {
      return await transport.readPage(url, { method: 'GET', signal });
    } catch (error) {
      throwIfCancelled(signal);
      if (![429, 503].includes(Number(error?.status)) || attempt >= maxRetries) throw error;
      await wait(retryDelay(error, attempt, baseDelay, maxDelay), signal);
    }
  }
}

function traversalLimits(config = {}) {
  const configured = (name, fallback) => config[name] === undefined ? fallback : Number(config[name]);
  return {
    chunkSize: Math.min(1000, Math.max(1, configured('traversalChunkSize', 500))),
    maxChunks: Math.min(500, Math.max(1, configured('traversalMaxChunks', 200))),
    maxDurationMs: Math.min(600000, Math.max(1000, configured('traversalMaxDurationMs', 120000))),
    maxRetries: Math.min(8, Math.max(0, configured('traversalMaxRetries', 3))),
    baseDelay: Math.max(0, configured('retryBaseDelayMs', 250)),
    maxDelay: Math.max(0, configured('retryMaxDelayMs', 4000)),
  };
}

function ensureWithinTime(startedAt, maxDurationMs) {
  if (Date.now() - startedAt <= maxDurationMs) return;
  const error = new Error('SharePoint traversal exceeded the bounded time limit');
  error.code = 'TRAVERSAL_TIME_LIMIT';
  throw error;
}

function nextAfterId(rows, idField, previous) {
  const ids = rows.map((row) => Number(row?.[idField])).filter(Number.isFinite);
  const next = ids.length ? Math.max(...ids) : previous;
  if (rows.length && next <= previous) {
    const error = new Error('SharePoint Id-keyset traversal did not advance');
    error.code = 'TRAVERSAL_NO_PROGRESS';
    throw error;
  }
  return next;
}

export async function traverseIdKeyset({ endpoint, siteUrl, transport, fieldMapping, selectFields, config, signal, onChunk }) {
  const limits = traversalLimits(config);
  const idField = fieldMapping.id;
  const seenNextLinks = new Set();
  const startedAt = Date.now();
  let afterId = 0;
  let rowCount = 0;
  for (let chunk = 0; chunk < limits.maxChunks; chunk += 1) {
    throwIfCancelled(signal);
    ensureWithinTime(startedAt, limits.maxDurationMs);
    const query = buildIdKeysetQuery({ afterId, pageSize: limits.chunkSize, selectFields, fieldMapping });
    const page = await readWithRetry({ transport, url: `${endpoint()}?${query}`, signal, maxRetries: limits.maxRetries, baseDelay: limits.baseDelay, maxDelay: limits.maxDelay });
    ensureWithinTime(startedAt, limits.maxDurationMs);
    if (page.nextLink) {
      const safe = resolveNextLink(page.nextLink, siteUrl);
      if (seenNextLinks.has(safe)) throw new Error('SharePoint traversal returned a repeated nextLink');
      seenNextLinks.add(safe);
    }
    if (!page.items.length) return { chunks: chunk + 1, rowCount, lastId: afterId };
    const nextId = nextAfterId(page.items, idField, afterId);
    const shouldContinue = await onChunk?.(page.items, { chunk: chunk + 1, afterId, nextId });
    rowCount += page.items.length;
    afterId = nextId;
    if (shouldContinue === false) return { chunks: chunk + 1, rowCount, lastId: afterId, stopped: true };
    if (page.items.length < limits.chunkSize && !page.nextLink) return { chunks: chunk + 1, rowCount, lastId: afterId };
  }
  const error = new Error('SharePoint traversal exceeded the bounded chunk limit');
  error.code = 'TRAVERSAL_CHUNK_LIMIT';
  throw error;
}

export async function exportMatchingItems(options) {
  const matches = [];
  await traverseIdKeyset({
    ...options,
    onChunk: async (rows) => {
      for (const row of rows) {
        const item = options.mapItem(row);
        if (options.matches(item)) matches.push(item);
      }
    },
  });
  return matches;
}

export async function countMatchingItems(options) {
  let count = 0;
  await traverseIdKeyset({
    ...options,
    onChunk: async (rows) => {
      for (const row of rows) {
        if (options.matches(options.mapItem(row))) count += 1;
      }
    },
  });
  return count;
}

function initialKpis() {
  return { open: 0, closed: 0, critical: 0, vendorUnmatched: 0, oldestOpen: null };
}

function olderOpen(current, candidate) {
  if (!current) return candidate;
  const left = String(current.ReceivedDateTime ?? '');
  const right = String(candidate.ReceivedDateTime ?? '');
  if (right < left) return candidate;
  if (right === left && Number(candidate.id) < Number(current.id)) return candidate;
  return current;
}

export async function scanKpis(options) {
  const kpis = initialKpis();
  await traverseIdKeyset({
    ...options,
    selectFields: KPI_READ_FIELDS,
    onChunk: async (rows) => {
      rows.map(options.mapItem).forEach((item) => {
        if (isClosedStatus(item.Status)) kpis.closed += 1;
        if (isOpenStatus(item.Status)) {
          kpis.open += 1;
          kpis.oldestOpen = olderOpen(kpis.oldestOpen, item);
        }
        if (item.Priority === 'Critical') kpis.critical += 1;
        if (isVendorUnmatched(item)) kpis.vendorUnmatched += 1;
      });
    },
  });
  return kpis;
}

export { cancellationError };
