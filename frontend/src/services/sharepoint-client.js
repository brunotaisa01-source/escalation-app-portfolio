import { readRuntimeConfig } from '../config/runtime-config.example.js';
import {
  buildEscalationQuery,
  DEFAULT_FIELD_MAPPING,
  EDITABLE_FIELDS,
  UI_READ_FIELDS,
  validateSharePointConfig,
} from './sharepoint-query.js';
import { createSharePointTransport, resolveNextLink } from './sharepoint-transport.js';
import { countMatchingItems, exportMatchingItems, scanKpis } from './sharepoint-traversal.js';
import { createCurrentUserReader } from './sharepoint-current-user.js';
import {
  buildVendorReferenceQuery,
  createVendorReferenceClient,
  VENDOR_REFERENCE_READ_FIELDS,
} from './vendor-reference-client.js';

function listEndpoint(baseUrl, title) {
  const safeTitle = String(title).replaceAll("'", "''");
  return () => `${baseUrl}/_api/web/lists/getbytitle('${safeTitle}')/items`;
}

export function createSharePointClient(config = readRuntimeConfig(), fetchImpl = globalThis.fetch) {
  const verified = validateSharePointConfig(config);
  const baseUrl = String(verified.siteUrl).replace(/\/$/, '');
  const endpoint = listEndpoint(baseUrl, verified.listTitle);
  const transport = createSharePointTransport({ config: verified, fetchImpl, endpoint });
  const traversal = { endpoint, siteUrl: verified.siteUrl, transport, fieldMapping: verified.fieldMapping, config: verified };
  const vendorEndpoint = () => {
    if (!verified.vendorReferenceListTitle) throw new Error('Vendor Reference list binding is not configured');
    return listEndpoint(baseUrl, verified.vendorReferenceListTitle)();
  };
  const searchVendorReference = createVendorReferenceClient({ config: verified, transport, endpoint: vendorEndpoint });
  const getCurrentUser = createCurrentUserReader({ request: transport.request, baseUrl });

  return {
    mode: 'sharepoint',
    async listItems(options = {}) {
      const url = options.nextLink
        ? resolveNextLink(options.nextLink, verified.siteUrl)
        : `${endpoint()}?${buildEscalationQuery({ ...options, fieldMapping: verified.fieldMapping })}`;
      return transport.readPage(url);
    },
    getItem: (id) => transport.readItem(id),
    getEditableItem: (id) => transport.readItem(id),
    getCurrentUser,
    updateItem: (id, patch, etag) => transport.updateItem(id, patch, etag),
    searchVendorReference,
    exportItems: ({ mapItem, matches, signal } = {}) => exportMatchingItems({ ...traversal, selectFields: UI_READ_FIELDS, mapItem, matches, signal }),
    countItems: ({ mapItem, matches, signal } = {}) => countMatchingItems({ ...traversal, selectFields: UI_READ_FIELDS, mapItem, matches, signal }),
    scanKpis: ({ mapItem, signal } = {}) => scanKpis({ ...traversal, mapItem, signal }),
  };
}

export {
  buildEscalationQuery,
  buildVendorReferenceQuery,
  DEFAULT_FIELD_MAPPING,
  EDITABLE_FIELDS,
  UI_READ_FIELDS,
  validateSharePointConfig,
  VENDOR_REFERENCE_READ_FIELDS,
};
