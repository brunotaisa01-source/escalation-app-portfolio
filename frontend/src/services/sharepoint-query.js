import { DEFAULT_FIELD_MAPPING } from '../config/runtime-config.example.js';
import { buildAgeODataClause } from '../domain/calendar-age.js';
import { parseEscalationId } from '../domain/escalation-id.js';
import { londonDateRange } from '../domain/sharepoint-calendar-date.js';
import { CLOSED_STATUS_VALUES, GOVERNED_STATUSES, OPEN_STATUS_VALUES } from '../domain/status-policy.js';

const ODATA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REQUIRED_FIELDS = ['id', 'Title', 'Status', 'Priority', 'ReceivedDateTime'];

export const EDITABLE_FIELDS = Object.freeze([
  'Status', 'Priority', 'WorkingNotes', 'DateResolved', 'ActionType',
  'APOwner', 'Entity', 'DocDate', 'InvRef', 'Value', 'EscalationDate',
  'Vendor', 'VendorName', 'VendorCategory',
  'DaysToResolve', 'IsClosed',
]);

export const UI_READ_FIELDS = Object.freeze([
  'id', 'Title', 'Mailbox', 'SourceQueue', 'From', 'Reference', 'ReceivedDateTime',
  'InternetMessageId', 'OutlookMessageId', 'ConversationId', 'SMarker', 'UniqueKey',
  'OriginalUniqueKey', 'Vendor', 'VendorName', 'VendorCategory', 'Entity', 'DocDate',
  'InvRef', 'Value', 'ActionType', 'Priority', 'APOwner', 'EscalationDate',
  'WorkingNotes', 'DateResolved', 'DaysToResolve', 'IsClosed', 'Status',
]);

const FILTER_KINDS = Object.freeze({
  EscalationId: 'friendly-id', Status: 'categorical', ReceivedDateTime: 'date', Age: 'age',
  SourceQueue: 'categorical', Mailbox: 'text', From: 'text', Reference: 'text', Title: 'text', Vendor: 'text',
  VendorName: 'text', VendorCategory: 'text', Entity: 'categorical',
  ReferenceOrSubject: 'reference-subject', DocDate: 'date', InvRef: 'text', Value: 'number',
  APOwner: 'categorical', Priority: 'categorical', ActionType: 'categorical',
  EscalationDate: 'date', WorkingNotes: 'text', DateResolved: 'date', DaysToResolve: 'number',
});

export const encodeOData = (value) => String(value).replaceAll("'", "''");

export function assertConfiguredField(mapping, field) {
  const internalName = mapping[field];
  if (!internalName || !ODATA_IDENTIFIER.test(String(internalName))) {
    throw new Error(`SharePoint field mapping is incomplete for ${field}`);
  }
  return String(internalName);
}

export function validateSharePointConfig(config = {}) {
  if (config.mode !== 'sharepoint') throw new Error('SharePoint service requires mode=sharepoint');
  if (config.verified !== true) throw new Error('SharePoint configuration is not verified');
  if (!config.siteUrl || /^__.*__$/.test(String(config.siteUrl))) throw new Error('SharePoint siteUrl is not configured');
  if (!config.listTitle || /^__.*__$/.test(String(config.listTitle))) throw new Error('SharePoint listTitle is not configured');
  const fieldMapping = { ...DEFAULT_FIELD_MAPPING, ...(config.fieldMapping ?? {}) };
  [...REQUIRED_FIELDS, ...EDITABLE_FIELDS].forEach((field) => assertConfiguredField(fieldMapping, field));
  return { ...config, fieldMapping };
}

function clean(value) {
  return String(value ?? '').trim();
}

function values(entry) {
  const source = Array.isArray(entry) ? entry : entry?.values;
  return Array.isArray(source) ? source.map(clean).filter(Boolean) : [];
}

const asDateTime = (date) => `datetime'${date.toISOString()}'`;

function friendlyIdClause(entry, mapping) {
  if (entry?.operator !== 'equals') return null;
  const parsed = parseEscalationId(entry?.value);
  if (!parsed) return '(1 eq 0)';
  const idField = assertConfiguredField(mapping, 'id');
  const received = assertConfiguredField(mapping, 'ReceivedDateTime');
  return `(${idField} eq ${parsed.id} and ${received} ge datetime'${parsed.year}-01-01T00:00:00.000Z' and ${received} lt datetime'${parsed.year + 1}-01-01T00:00:00.000Z')`;
}

function textClause(field, entry) {
  const value = clean(entry?.value);
  if (!value) return null;
  return entry?.operator === 'equals' ? `${field} eq '${encodeOData(value)}'` : `substringof('${encodeOData(value)}',${field})`;
}

function numericClause(field, entry) {
  if (entry?.operator === 'between') {
    const from = Number(entry?.from);
    const to = Number(entry?.to);
    return Number.isFinite(from) && Number.isFinite(to) ? `(${field} ge ${from} and ${field} le ${to})` : null;
  }
  const value = Number(entry?.value);
  const operator = { equals: 'eq', lt: 'lt', lte: 'le', gt: 'gt', gte: 'ge' }[entry?.operator ?? 'equals'];
  return Number.isFinite(value) && operator ? `${field} ${operator} ${value}` : null;
}

function dateClause(field, entry) {
  if (entry?.operator === 'between') {
    const from = londonDateRange(entry?.from);
    const to = londonDateRange(entry?.to);
    return from && to ? `(${field} ge ${asDateTime(from.start)} and ${field} lt ${asDateTime(to.end)})` : null;
  }
  if ((entry?.operator ?? 'on') === 'on') {
    const range = londonDateRange(entry?.value);
    return range ? `(${field} ge ${asDateTime(range.start)} and ${field} lt ${asDateTime(range.end)})` : null;
  }
  const range = londonDateRange(entry?.value);
  if (!range) return null;
  if (entry?.operator === 'before') return `${field} lt ${asDateTime(range.start)}`;
  if (entry?.operator === 'after') return `${field} ge ${asDateTime(range.end)}`;
  if (entry?.operator === 'gte') return `${field} ge ${asDateTime(range.start)}`;
  if (entry?.operator === 'lte') return `${field} lt ${asDateTime(range.end)}`;
  return null;
}

function referenceSubjectClause(entry, mapping) {
  const value = clean(entry?.value);
  if (!value) return null;
  const reference = assertConfiguredField(mapping, 'Reference');
  const subject = assertConfiguredField(mapping, 'Title');
  const safe = encodeOData(value);
  return entry?.operator === 'equals'
    ? `(${reference} eq '${safe}' or ${subject} eq '${safe}')`
    : `(substringof('${safe}',${reference}) or substringof('${safe}',${subject}))`;
}

function columnClause(logicalField, entry, mapping, now) {
  const kind = FILTER_KINDS[logicalField];
  if (!kind) return null;
  if (kind === 'friendly-id') return friendlyIdClause(entry, mapping);
  if (kind === 'reference-subject') return referenceSubjectClause(entry, mapping);
  const field = assertConfiguredField(mapping, kind === 'age' ? 'ReceivedDateTime' : logicalField);
  if (kind === 'categorical') {
    const selected = values(entry);
    return selected.length ? `(${selected.map((value) => `${field} eq '${encodeOData(value)}'`).join(' or ')})` : null;
  }
  if (kind === 'text') return textClause(field, entry);
  if (kind === 'number') return numericClause(field, entry);
  if (kind === 'date') return dateClause(field, entry);
  return buildAgeODataClause(field, entry, now);
}

function statusClauses({ status, statuses }, mapping) {
  const field = assertConfiguredField(mapping, 'Status');
  const selected = [...new Set((Array.isArray(statuses) ? statuses : [statuses]).filter(Boolean).map(encodeOData))];
  if (status === 'None') return ['(1 eq 0)'];
  if (status === 'Open') return [`(${OPEN_STATUS_VALUES.map((value) => `${field} eq '${encodeOData(value)}'`).join(' or ')})`];
  if (status === 'Closed') return [`(${CLOSED_STATUS_VALUES.map((value) => `${field} eq '${encodeOData(value)}'`).join(' or ')})`];
  if (selected.length === GOVERNED_STATUSES.length && GOVERNED_STATUSES.every((value) => selected.includes(value))) return [];
  if (selected.length) return [`(${selected.map((value) => `${field} eq '${value}'`).join(' or ')})`];
  if (!status || status === 'All') return [];
  return [];
}

function simpleRequestClauses(options, mapping) {
  const filters = statusClauses(options, mapping);
  if (options.query) {
    const safe = encodeOData(options.query);
    const fields = ['Title', 'Vendor', 'Reference', 'From'].map((field) => assertConfiguredField(mapping, field));
    filters.push(`(${fields.map((field) => `substringof('${safe}',${field})`).join(' or ')})`);
  }
  for (const [option, logical] of [['sourceQueues', 'SourceQueue'], ['priorities', 'Priority']]) {
    const selected = [...new Set((Array.isArray(options[option]) ? options[option] : [options[option]]).filter(Boolean).map(encodeOData))];
    if (selected.length) filters.push(`(${selected.map((value) => `${assertConfiguredField(mapping, logical)} eq '${value}'`).join(' or ')})`);
  }
  return filters;
}

function vendorClauses(options, mapping) {
  const vendor = assertConfiguredField(mapping, 'Vendor');
  const name = assertConfiguredField(mapping, 'VendorName');
  const category = assertConfiguredField(mapping, 'VendorCategory');
  if (options.vendorMatched === true) return [`(${vendor} ne null and ${vendor} ne '' and ${name} ne null and ${name} ne '' and ${category} ne null and ${category} ne '')`];
  if (options.vendorMatched === false) return [`(${vendor} ne null and ${vendor} ne '' and (${name} eq null or ${name} eq '' or ${category} eq null or ${category} eq ''))`];
  return [];
}

export function buildEscalationQuery(options = {}) {
  const mapping = { ...DEFAULT_FIELD_MAPPING, ...(options.fieldMapping ?? {}) };
  const filters = [...simpleRequestClauses(options, mapping), ...vendorClauses(options, mapping)];
  if (options.receivedBefore) filters.push(`${assertConfiguredField(mapping, 'ReceivedDateTime')} lt '${encodeOData(options.receivedBefore)}'`);
  Object.entries(options.columnFilters ?? {}).forEach(([field, entry]) => {
    const clause = columnClause(field, entry, mapping, options.now ?? new Date());
    if (clause) filters.push(clause);
  });
  const select = UI_READ_FIELDS.map((field) => mapping[field]).filter(Boolean).map(String);
  const params = new URLSearchParams({
    '$select': [...new Set(select)].join(','),
    '$orderby': `${assertConfiguredField(mapping, 'ReceivedDateTime')} asc`,
    '$top': String(options.pageSize ?? 10),
    '$count': 'true',
  });
  if (filters.length) params.set('$filter', filters.join(' and '));
  if (options.skipToken) params.set('$skiptoken', options.skipToken);
  return params;
}

export function requiresClientTraversal(options = {}) {
  const entry = options.columnFilters?.EscalationId;
  return Boolean(clean(entry?.value) && entry?.operator !== 'equals');
}

export function buildIdKeysetQuery({ afterId = 0, pageSize = 500, selectFields = UI_READ_FIELDS, fieldMapping = DEFAULT_FIELD_MAPPING } = {}) {
  const idField = assertConfiguredField(fieldMapping, 'id');
  const select = selectFields.map((field) => fieldMapping[field] ?? field).filter(Boolean).map(String);
  return new URLSearchParams({
    '$select': [...new Set(select)].join(','),
    '$filter': `${idField} gt ${Math.max(0, Number(afterId) || 0)}`,
    '$orderby': `${idField} asc`,
    '$top': String(Math.max(1, Number(pageSize) || 500)),
  });
}

export function editableSelectFields(mapping = DEFAULT_FIELD_MAPPING) {
  return [...new Set(['id', ...EDITABLE_FIELDS].map((field) => assertConfiguredField(mapping, field)))];
}

export { DEFAULT_FIELD_MAPPING };
