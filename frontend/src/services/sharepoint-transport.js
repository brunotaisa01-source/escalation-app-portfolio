import { assertConfiguredField, EDITABLE_FIELDS, editableSelectFields } from './sharepoint-query.js';

const EDITABLE_FIELD_SET = new Set(EDITABLE_FIELDS);

function header(response, name) {
  return typeof response?.headers?.get === 'function' ? response.headers.get(name) : null;
}

export function extractEtag(response, item = {}) {
  return header(response, 'ETag')
    ?? item?.['@odata.etag']
    ?? item?.['odata.etag']
    ?? item?.ETag
    ?? item?.__metadata?.etag
    ?? null;
}

export function resolveNextLink(nextLink, siteUrl) {
  const base = `${String(siteUrl).replace(/\/$/, '')}/`;
  const resolved = new URL(String(nextLink), base);
  const configured = new URL(String(siteUrl), globalThis.location?.origin ?? 'http://localhost');
  const sitePath = configured.pathname.replace(/\/$/, '');
  if (resolved.origin !== configured.origin || !resolved.pathname.startsWith(`${sitePath}/`)) {
    throw new Error('SharePoint nextLink is outside the configured site boundary');
  }
  return resolved.toString();
}

function httpError(message, response) {
  const error = new Error(`${message} (${response.status})`);
  error.status = response.status;
  const retryAfter = header(response, 'Retry-After');
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

async function detailedHttpError(message, response) {
  let detail;
  try {
    const body = await response.json();
    detail = body?.error?.message?.value
      ?? body?.error?.message
      ?? body?.['odata.error']?.message?.value
      ?? body?.['odata.error']?.message
      ?? '';
  } catch {
    return httpError(message, response);
  }
  return httpError(detail ? `${message}: ${String(detail).trim()}` : message, response);
}

function createRequest(fetchImpl) {
  return (url, options = {}) => fetchImpl(url, {
    credentials: 'include',
    ...options,
    headers: { Accept: 'application/json;odata=nometadata', ...(options.headers ?? {}) },
  });
}

function createPageReader(request) {
  return async (url, options = {}) => {
    const response = await request(url, options);
    if (!response.ok) throw httpError('SharePoint query failed', response);
    const body = await response.json();
    const totalValue = body['@odata.count'] ?? body['odata.count'];
    return {
      items: Array.isArray(body.value) ? body.value : [],
      nextLink: body['@odata.nextLink'] ?? body['odata.nextLink'] ?? null,
      total: totalValue === undefined ? null : Number(totalValue),
      response,
    };
  };
}

function createDigestReader(request, baseUrl) {
  return async () => {
    const response = await request(`${baseUrl}/_api/contextinfo`, { method: 'POST' });
    if (!response.ok) throw httpError('SharePoint request digest failed', response);
    const body = await response.json();
    const digest = body?.d?.GetContextWebInformation?.FormDigestValue ?? body?.FormDigestValue;
    if (!digest) throw new Error('SharePoint request digest was not returned');
    return digest;
  };
}

function etagUnavailable() {
  const error = new Error('SharePoint did not return an ETag for this item. Retry loading the editor.');
  error.code = 'ETAG_UNAVAILABLE';
  return error;
}

let freshReadSequence = 0;

function freshItemUrl(endpoint, id, select) {
  freshReadSequence += 1;
  const token = `${encodeURIComponent(id)}-${Date.now()}-${freshReadSequence}`;
  return `${endpoint()}(${encodeURIComponent(id)})?$select=${select}&_fresh=${encodeURIComponent(token)}`;
}

function createItemReader(request, endpoint, mapping) {
  return async (id, selectFields = editableSelectFields(mapping)) => {
    const select = encodeURIComponent([...new Set(selectFields)].join(','));
    const response = await request(freshItemUrl(endpoint, id, select), {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!response.ok) throw httpError('SharePoint item read failed', response);
    const body = await response.json();
    const item = body.d ?? body;
    const etag = extractEtag(response, item);
    if (!etag) throw etagUnavailable();
    return { ...item, __etag: etag };
  };
}

function validatePatch(patch, etag) {
  if (!etag) {
    const error = new Error('SharePoint update requires the current item ETag');
    error.code = 'ETAG_REQUIRED';
    throw error;
  }
  const entries = Object.entries(patch ?? {});
  const forbidden = entries.map(([field]) => field).filter((field) => !EDITABLE_FIELD_SET.has(field));
  if (forbidden.length) {
    const error = new Error(`Patch contains non-editable fields: ${forbidden.join(', ')}`);
    error.code = 'PATCH_FIELD_FORBIDDEN';
    throw error;
  }
  if (!entries.length) {
    const error = new Error('SharePoint update requires at least one editable field');
    error.code = 'PATCH_EMPTY';
    throw error;
  }
  return entries;
}

function createItemUpdater({ request, requestDigest, endpoint, mapping }) {
  return async (id, patch, etag) => {
    const entries = validatePatch(patch, etag);
    const body = Object.fromEntries(entries.map(([field, value]) => [assertConfiguredField(mapping, field), value]));
    const digest = await requestDigest();
    const response = await request(`${endpoint()}(${encodeURIComponent(id)})`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;odata=nometadata', 'IF-MATCH': etag, 'X-HTTP-Method': 'MERGE', 'X-RequestDigest': digest },
      body: JSON.stringify(body),
    });
    if ([409, 412].includes(response.status)) {
      const error = await detailedHttpError('Edit conflict', response);
      error.code = 'ETAG_CONFLICT';
      throw error;
    }
    if (!response.ok) throw await detailedHttpError('SharePoint update failed', response);
    return { Id: id, ...patch, __etag: extractEtag(response) };
  };
}

export function createSharePointTransport({ config, fetchImpl, endpoint }) {
  if (typeof fetchImpl !== 'function') throw new Error('Authenticated fetch is unavailable');
  const request = createRequest(fetchImpl);
  const requestDigest = createDigestReader(request, String(config.siteUrl).replace(/\/$/, ''));
  return {
    request,
    readPage: createPageReader(request),
    readItem: createItemReader(request, endpoint, config.fieldMapping),
    updateItem: createItemUpdater({ request, requestDigest, endpoint, mapping: config.fieldMapping }),
  };
}
