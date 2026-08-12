export const DEFAULT_FIELD_MAPPING = Object.freeze({
  id: 'Id',
  Title: 'Title',
  UniqueKey: 'UniqueKey',
  Status: 'Status',
  Priority: 'Priority',
  Vendor: 'Vendor',
  VendorName: 'Vendor_x0020_Name',
  Reference: 'Reference',
  From: 'From',
  ReceivedDateTime: 'Received_x0020_Date_x0020_Time',
  DateResolved: 'Date_x0020_Resolved',
  WorkingNotes: 'Working_x0020_Notes',
  Mailbox: 'Mailbox',
  SourceQueue: 'Source_x0020_Queue',
  InternetMessageId: 'Internet_x0020_Message_x0020_ID',
  OutlookMessageId: 'Outlook_x0020_Message_x0020_ID',
  ConversationId: 'Conversation_x0020_ID',
  SMarker: 'SMarker',
  OriginalUniqueKey: 'Original_x0020_UniqueKey',
  VendorCategory: 'Vendor_x0020_Category',
  Entity: 'Entity',
  DocDate: 'Doc_x0020_Date',
  InvRef: 'Inv_x0020_Ref',
  Value: 'Value',
  ActionType: 'Action_x0020_Type',
  APOwner: 'AP_x0020_Owner',
  EscalationDate: 'Escalation_x0020_Date',
  DaysToResolve: 'Days_x0020_To_x0020_Resolve',
  IsClosed: 'Is_x0020_Closed',
});

// Approved governed catalogs. These are UI validation/reference values only;
// SharePoint remains the operational source of truth for case rows and queries.
export const GOVERNED_VALUES = Object.freeze({
  Status: Object.freeze(['Action Required', 'In Progress', 'Closed', 'Duplicate']),
  Priority: Object.freeze(['Critical', 'High', 'Medium', 'Low']),
  ActionType: Object.freeze([
    'Invoice review',
    'Invoice review / partner',
    'Waiting for bank details',
    'AP query follow-up',
    'Manual payment investigation',
    'manual payment',
    'Accounting system issue',
    'Document distribution',
    'Document rejected',
    'Recovered from inbox',
    'Authority posting',
    'Reminder',
    'Dunning fees',
    'Urgent manual posting',
    'Waiting approval',
  ]),
  Entity: Object.freeze([
    'DEMO-ENTITY-01',
    'DEMO-ENTITY-02',
    'DEMO-ENTITY-03',
    'DEMO-ENTITY-04',
    'DEMO-ENTITY-05',
    'DEMO-ENTITY-06',
    'DEMO-ENTITY-07',
    'DEMO-ENTITY-08',
    'DEMO-ENTITY-09',
    'DEMO-ENTITY-10',
    'DEMO-ENTITY-11',
    'DEMO-ENTITY-12',
  ]),
  APOwner: Object.freeze([
    'Fixture Owner 01',
    'Fixture Owner 02',
    'Fixture Owner 03',
    'Fixture Owner 04',
    'Fixture Owner 05',
    'Fixture Owner 06',
    'Fixture Owner 07',
    'Fixture Owner 08',
  ]),
});

export const LEGACY_STATUS_MAP = Object.freeze({
  'Not Yet Started': 'Action Required',
  'In Process': 'In Progress',
  Closed: 'Closed',
  Open: 'Action Required',
  'Action Required': 'Action Required',
  'In Progress': 'In Progress',
  Duplicate: 'Duplicate',
});

const OWNER_BLOCKLIST = new Set([
  'Awaiting Approval', 'Waiting approval', 'Awaiting Payment',
  'Action Required', 'In Progress', 'Closed', 'Duplicate', 'Not Yet Started', 'In Process',
]);

function cleanCatalog(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function canonicalStatus(value) {
  const text = String(value ?? '').trim();
  return LEGACY_STATUS_MAP[text] ?? text;
}

export function mergeGovernedValues(injected = {}) {
  const merged = {};
  Object.entries(GOVERNED_VALUES).forEach(([field, defaults]) => {
    if (field === 'Status') {
      merged[field] = GOVERNED_VALUES.Status;
      return;
    }
    let additions = cleanCatalog(injected?.[field]);
    if (field === 'APOwner') additions = additions.filter((value) => !OWNER_BLOCKLIST.has(value));
    if (field === 'ActionType') additions = additions.filter((value) => value !== 'Awaiting Payment');
    merged[field] = Object.freeze([...new Set([...defaults, ...additions])]);
  });
  return Object.freeze(merged);
}

const defaults = Object.freeze({
  status: 'TEMPLATE_REBIND_REQUIRED',
  mode: 'sharepoint',
  verified: false,
  siteUrl: '',
  listTitle: '',
  vendorReferenceListTitle: '',
  pageSize: 10,
  backgroundRefreshMs: 30000,
  fieldMapping: DEFAULT_FIELD_MAPPING,
  governedValues: GOVERNED_VALUES,
});

export function readRuntimeConfig() {
  const injected = globalThis.DEMO_ESCALATION_CONFIG;
  if (!injected || typeof injected !== 'object') return defaults;
  return Object.freeze({
    ...defaults,
    ...injected,
    fieldMapping: Object.freeze({ ...DEFAULT_FIELD_MAPPING, ...(injected.fieldMapping ?? {}) }),
    governedValues: mergeGovernedValues(injected.governedValues),
  });
}

export const runtimeConfig = defaults;
