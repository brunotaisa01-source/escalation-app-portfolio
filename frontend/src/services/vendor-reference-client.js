import { traverseIdKeyset } from './sharepoint-traversal.js';

export const VENDOR_REFERENCE_READ_FIELDS = Object.freeze({
  id: 'Id',
  Title: 'Title',
  Vendor: 'Vendor',
  VendorName: 'Vendor_x0020_Name',
  VendorCategory: 'Vendor_x0020_Category',
  VendorLookupKey: 'Vendor_x0020_Lookup_x0020_Key',
});

export function buildVendorReferenceQuery(afterId = 0, pageSize = 500, fieldMapping = VENDOR_REFERENCE_READ_FIELDS) {
  const values = [...new Set(Object.values(fieldMapping).filter(Boolean).map(String))];
  return new URLSearchParams({
    '$select': values.join(','),
    '$filter': `${fieldMapping.id} gt ${Math.max(0, Number(afterId) || 0)}`,
    '$orderby': `${fieldMapping.id} asc`,
    '$top': String(Math.min(500, Math.max(1, Number(pageSize) || 500))),
  });
}

function mapVendor(item) {
  return {
    id: item[VENDOR_REFERENCE_READ_FIELDS.id] ?? item.ID,
    Title: item[VENDOR_REFERENCE_READ_FIELDS.Title] ?? '',
    Vendor: item[VENDOR_REFERENCE_READ_FIELDS.Vendor] ?? '',
    VendorName: item[VENDOR_REFERENCE_READ_FIELDS.VendorName] ?? '',
    VendorCategory: item[VENDOR_REFERENCE_READ_FIELDS.VendorCategory] ?? '',
    VendorLookupKey: item[VENDOR_REFERENCE_READ_FIELDS.VendorLookupKey] ?? '',
  };
}

function vendorTraversalConfig(config) {
  return {
    ...config,
    traversalChunkSize: Math.min(500, Math.max(1, Number(config.vendorSearchChunkSize) || 500)),
    traversalMaxChunks: Math.min(200, Math.max(1, Number(config.vendorSearchMaxChunks) || 40)),
  };
}

export function createVendorReferenceClient({ config, transport, endpoint }) {
  return async function searchVendorReference(query = '', { signal } = {}) {
    const needle = String(query ?? '').trim().toLocaleLowerCase();
    if (!needle) return [];
    const results = [];
    const ids = new Set();
    await traverseIdKeyset({
      endpoint,
      siteUrl: config.siteUrl,
      transport,
      fieldMapping: VENDOR_REFERENCE_READ_FIELDS,
      selectFields: Object.keys(VENDOR_REFERENCE_READ_FIELDS),
      config: vendorTraversalConfig(config),
      signal,
      onChunk: async (rows) => {
        for (const item of rows.map(mapVendor)) {
          const searchable = [item.Vendor, item.VendorName, item.VendorLookupKey].filter(Boolean).join(' ').toLocaleLowerCase();
          if (!searchable.includes(needle) || ids.has(String(item.id))) continue;
          ids.add(String(item.id));
          results.push(item);
          if (results.length >= 25) return false;
        }
        return true;
      },
    });
    return results;
  };
}
