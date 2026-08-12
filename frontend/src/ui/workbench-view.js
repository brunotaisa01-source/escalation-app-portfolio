import { calendarDayAge } from '../domain/calendar-age.js';
import { formatEscalationId } from '../domain/escalation-id.js';
import { vendorMatchState } from '../domain/vendor-match.js';
import { londonCalendarDate } from '../domain/sharepoint-calendar-date.js';
import { currentUserAriaLabel, currentUserInitials, currentUserWorkflowHeading } from '../domain/user-identity.js';
import { isGovernedStatus } from '../domain/status-policy.js';

export { formatEscalationId };

export const EMAIL_FIELDS = Object.freeze([
  'Mailbox', 'SourceQueue', 'From', 'Reference', 'ReceivedDateTime',
  'InternetMessageId', 'OutlookMessageId', 'ConversationId', 'SMarker',
  'UniqueKey', 'OriginalUniqueKey',
]);
export const VISIBLE_EMAIL_FIELDS = Object.freeze(['SourceQueue', 'From', 'ReceivedDateTime', 'Title', 'Reference']);
export const OPERATOR_FIELDS = Object.freeze([
  'Vendor', 'VendorName', 'VendorCategory', 'Entity', 'DocDate', 'InvRef',
  'Value', 'ActionType', 'Priority', 'APOwner', 'EscalationDate',
  'WorkingNotes', 'DateResolved', 'Status',
]);

export const TABLE_COLUMNS = Object.freeze([
  ['EscalationId', 'Escalation ID'], ['Status', 'Status'], ['ReceivedDateTime', 'Received'],
  ['Age', 'Age'], ['SourceQueue', 'Source Queue'], ['Mailbox', 'Mailbox'], ['From', 'From'],
  ['Vendor', 'Vendor'], ['VendorName', 'Vendor Name'], ['VendorCategory', 'Category'],
  ['Entity', 'Entity'], ['ReferenceOrSubject', 'Reference / Subject'], ['DocDate', 'Doc Date'],
  ['InvRef', 'Invoice Ref'], ['Value', 'Value'], ['APOwner', 'AP Owner'], ['Priority', 'Priority'],
  ['ActionType', 'Action Type'], ['EscalationDate', 'Escalation Date'], ['WorkingNotes', 'Working Notes'],
  ['DateResolved', 'Date Resolved'], ['DaysToResolve', 'Days To Resolve'],
]);
export const TABLE_RENDER_COLUMN_COUNT = TABLE_COLUMNS.length + 1;

export const HEADER_FILTER_DEFINITIONS = Object.freeze({
  EscalationId: { kind: 'friendly-id' }, Status: { kind: 'categorical' },
  ReceivedDateTime: { kind: 'date' }, Age: { kind: 'age' }, SourceQueue: { kind: 'categorical' },
  Mailbox: { kind: 'text' }, From: { kind: 'text' }, Vendor: { kind: 'text' },
  VendorName: { kind: 'text' }, VendorCategory: { kind: 'text' }, Entity: { kind: 'categorical' },
  ReferenceOrSubject: { kind: 'text' }, DocDate: { kind: 'date' }, InvRef: { kind: 'text' },
  Value: { kind: 'number' }, APOwner: { kind: 'categorical' }, Priority: { kind: 'categorical' },
  ActionType: { kind: 'categorical' }, EscalationDate: { kind: 'date' }, WorkingNotes: { kind: 'text' },
  DateResolved: { kind: 'date' }, DaysToResolve: { kind: 'number' },
});

const DEFAULT_FILTER_OPTIONS = Object.freeze({
  SourceQueue: Object.freeze(['Fixture-West', 'Fixture-East', 'Fixture-North', 'Fixture-South']),
});
export const FIELD_LABELS = Object.freeze({
  Mailbox: 'Mailbox', SourceQueue: 'Source Queue', From: 'From', Reference: 'Reference',
  ReceivedDateTime: 'Received', Title: 'Subject', Vendor: 'Vendor', VendorName: 'Vendor Name',
  VendorCategory: 'Category', Entity: 'Entity', DocDate: 'Doc Date', InvRef: 'Invoice Ref',
  Value: 'Value', ActionType: 'Action Type', Priority: 'Priority', APOwner: 'AP Owner',
  EscalationDate: 'Escalation Date', WorkingNotes: 'Working Notes', DateResolved: 'Date Resolved', Status: 'Status',
});

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
export function textValue(value) { return String(value ?? '').trim(); }
export function displayValue(value) { return escapeHtml(textValue(value) || '—'); }

export function dateInputValue(value) {
  return londonCalendarDate(value);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return displayValue(value);
  return escapeHtml(new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/London',
  }).format(date));
}
function formatAge(value) { const days = calendarDayAge(value); return days === null ? '—' : `${days}d`; }
function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number)
    ? escapeHtml(new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(number))
    : displayValue(value);
}
function statusClass(value) { return textValue(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'; }
function statusBadge(value) {
  const status = textValue(value) || 'Unknown';
  const warning = isGovernedStatus(value) ? '' : ' Unknown status; shown in All only.';
  return `<span class="status-pill status-${statusClass(value)}" aria-label="${escapeHtml(`${status} status${warning}`)}"${warning ? ' data-status-warning="true"' : ''}>${displayValue(value)}</span>`;
}
function uniqueValues(values) { return [...new Set(values.map(textValue).filter(Boolean))]; }
function filterValuesForUi(entry = {}) { return Array.isArray(entry) ? entry : Array.isArray(entry.values) ? entry.values : []; }

export function createDetailChoices(rows = [], field, currentValue = '', catalog = []) {
  const observed = uniqueValues(rows.map((row) => row?.[field]));
  const approved = uniqueValues(catalog);
  const base = approved.length ? [...approved] : [...observed].sort((a, b) => a.localeCompare(b));
  const current = textValue(currentValue);
  const choices = uniqueValues(base);
  if (current && !choices.includes(current)) choices.unshift(current);
  return choices;
}

function filterOptions(field, rows, config) {
  const catalog = config?.filterOptions?.[field] ?? config?.governedValues?.[field] ?? DEFAULT_FILTER_OPTIONS[field];
  if (Array.isArray(catalog) && catalog.length) return uniqueValues(catalog).sort((a, b) => a.localeCompare(b));
  return uniqueValues(rows.map((row) => row?.[field])).sort((a, b) => a.localeCompare(b));
}

function categoricalFilterMenu({ field, label, rows, config, entry, menuId }) {
  const selected = new Set(filterValuesForUi(entry));
  const options = filterOptions(field, rows, config);
  const choices = options.length
    ? options.map((value) => `<label class="column-filter-check"><input type="checkbox" data-filter-value="${escapeHtml(value)}"${selected.has(value) ? ' checked' : ''} /><span>${displayValue(value)}</span></label>`).join('')
    : '<p class="filter-empty">No configured choices available.</p>';
  return `<div id="${menuId}" class="column-filter-menu" data-column-filter-menu="${field}" role="dialog" aria-label="Filter ${escapeHtml(label)}" hidden><div class="filter-menu-actions"><button type="button" class="filter-menu-link" data-filter-select-all="${field}">Select all</button><button type="button" class="filter-menu-link" data-filter-clear="${field}">Clear choices</button></div><div class="column-filter-options">${choices}</div><div class="filter-menu-footer"><span class="field-hint">Choose values, then apply.</span><button type="button" class="primary-button" data-filter-apply="${field}">Apply</button><button type="button" class="secondary-button" data-filter-reset="${field}">Clear filter</button></div></div>`;
}

function filterMenu(field, label, rows, config, columnFilters) {
  const definition = HEADER_FILTER_DEFINITIONS[field];
  const entry = columnFilters?.[field] ?? {};
  const menuId = `column-filter-${field}`;
  if (definition.kind === 'categorical') return categoricalFilterMenu({ field, label, rows, config, entry, menuId });
  const textKind = definition.kind === 'text' || definition.kind === 'friendly-id';
  const operator = entry.operator ?? (textKind ? 'contains' : definition.kind === 'date' ? 'on' : 'equals');
  const inputType = definition.kind === 'date' ? 'date' : ['number', 'age'].includes(definition.kind) ? 'number' : 'search';
  const operators = textKind
    ? [['contains', 'Contains'], ['equals', 'Equals']]
    : definition.kind === 'date'
      ? [['on', 'On'], ['before', 'Before'], ['after', 'After'], ['between', 'Between']]
      : [['equals', 'Equals'], ['lt', 'Less than'], ['lte', 'Less than or equal'], ['gt', 'Greater than'], ['gte', 'Greater than or equal'], ['between', 'Between']];
  const second = `<label id="${menuId}-to-label" data-filter-to-label for="${menuId}-to"${operator === 'between' ? '' : ' hidden'}>To</label><input id="${menuId}-to" data-filter-to type="${inputType}" value="${escapeHtml(entry.to ?? '')}"${operator === 'between' ? '' : ' hidden'} />`;
  return `<div id="${menuId}" class="column-filter-menu" data-column-filter-menu="${field}" role="dialog" aria-label="Filter ${escapeHtml(label)}" hidden><label for="${menuId}-operator">Match</label><select id="${menuId}-operator" data-filter-operator>${operators.map(([value, text]) => `<option value="${value}"${value === operator ? ' selected' : ''}>${text}</option>`).join('')}</select><label for="${menuId}-value">Value</label><input id="${menuId}-value" data-filter-value type="${inputType}" value="${escapeHtml(entry.value ?? entry.from ?? '')}" />${second}<div class="filter-menu-footer"><span class="field-hint">Enter the filter, then apply.</span><button type="button" class="primary-button" data-filter-apply="${field}">Apply</button><button type="button" class="secondary-button" data-filter-reset="${field}">Clear filter</button></div></div>`;
}

function filterSummary(entry = {}) {
  const operator = String(entry.operator ?? '').replace(/^./, (value) => value.toUpperCase());
  if (Array.isArray(entry.values)) return `Selected: ${entry.values.join(', ')}`;
  if (entry.operator === 'between') return `Between: ${entry.from} to ${entry.to}`;
  return `${operator || 'Filter'}: ${entry.value ?? ''}`.trim();
}

export function renderTableHeader(rows, config, columnFilters) {
  const selection = '<th class="selection-column" scope="col"><span class="sr-only">Select</span></th>';
  const business = TABLE_COLUMNS.map(([field, label]) => {
    const entry = columnFilters?.[field];
    const active = Boolean(entry);
    const icon = active ? '<span class="filter-funnel" aria-hidden="true">⌑</span>' : '<span aria-hidden="true">▾</span>';
    const activeAttrs = active ? ` data-filter-active="true" title="${escapeHtml(filterSummary(entry))}"` : '';
    const aria = `Filter ${label}${active ? ', filter active' : ''}`;
    return `<th scope="col" data-column="${field}"${activeAttrs}><div class="header-cell"><span>${label}</span><button type="button" class="header-filter-toggle${active ? ' is-filtered' : ''}" data-column-filter-toggle="${field}" aria-haspopup="dialog" aria-expanded="false" aria-controls="column-filter-${field}" aria-label="${escapeHtml(aria)}">${icon}</button></div>${filterMenu(field, label, rows, config, columnFilters)}</th>`;
  }).join('');
  return `${selection}${business}`;
}

function optionsMarkup(values, currentValue, label, historicalValue = '') {
  const placeholder = `<option value=""${currentValue ? '' : ' selected'} disabled>Select ${escapeHtml(label)}</option>`;
  const choices = values.map((value) => {
    const selected = String(value) === String(currentValue ?? '');
    const historical = selected && String(value) === String(historicalValue);
    return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}${historical ? ' disabled' : ''}>${escapeHtml(value)}${historical ? ' (historical)' : ''}</option>`;
  }).join('');
  return `${placeholder}${choices}`;
}
function detailControl(item, field, rows, governedValues) {
  const label = FIELD_LABELS[field] ?? field;
  const value = item[field] ?? '';
  const duplicate = item.Status === 'Duplicate';
  if (['Status', 'Priority', 'ActionType', 'APOwner', 'Entity'].includes(field)) {
    const values = createDetailChoices(rows, field, value, governedValues[field]);
    const unknown = value && !governedValues[field]?.includes(value);
    const describedBy = unknown ? `field-${field}-hint field-${field}-error` : `field-${field}-error`;
    const required = field === 'Status' || !duplicate;
    return `<div class="detail-field"><label for="field-${field}">${label}</label><select id="field-${field}" class="field-control" data-field="${field}"${required ? ' required aria-required="true"' : ''} aria-describedby="${describedBy}">${optionsMarkup(values, value, label, unknown ? value : '')}</select>${unknown ? `<span id="field-${field}-hint" class="field-hint">Current historical value is shown but cannot be newly assigned.</span>` : ''}<span id="field-${field}-error" class="field-error" hidden></span></div>`;
  }
  if (field === 'WorkingNotes') return `<div class="detail-field detail-field-wide"><label for="field-${field}">${label}</label><textarea id="field-${field}" class="field-control" data-field="${field}" rows="4"${duplicate ? '' : ' required aria-required="true"'} aria-describedby="field-${field}-error">${escapeHtml(value)}</textarea><span id="field-${field}-error" class="field-error" hidden></span></div>`;
  if (['DocDate', 'EscalationDate', 'DateResolved'].includes(field)) {
    const required = field === 'DateResolved' && !duplicate;
    return `<div class="detail-field"><label for="field-${field}">${label}</label><input id="field-${field}" class="field-control" data-field="${field}" type="date" value="${escapeHtml(dateInputValue(value))}"${required ? ` required aria-required="true" aria-describedby="field-${field}-error"` : ''} />${required ? `<span id="field-${field}-error" class="field-error" hidden></span>` : ''}</div>`;
  }
  if (field === 'Value') return `<div class="detail-field"><label for="field-${field}">${label}</label><input id="field-${field}" class="field-control" data-field="${field}" type="number" step="0.01" value="${escapeHtml(value)}" /></div>`;
  if (field === 'Vendor') return '';
  return `<div class="detail-field"><label for="field-${field}">${label}</label><input id="field-${field}" class="field-control" data-field="${field}" type="text" value="${escapeHtml(value)}" /></div>`;
}

function readOnlyField(item, field) {
  return `<div class="detail-field${['Title', 'Reference'].includes(field) ? ' detail-field-wide' : ''}"><span class="field-label">${FIELD_LABELS[field] ?? field}</span><output>${field === 'ReceivedDateTime' ? formatDate(item[field]) : displayValue(item[field])}</output></div>`;
}
function transactionMarkup(transaction) {
  if (!transaction) return '';
  const action = transaction.state === 'Delayed'
    ? '<button type="button" class="row-transaction-action" data-transaction-action="retry">Retry confirmation</button>'
    : transaction.state === 'Conflict'
      ? '<button type="button" class="row-transaction-action" data-transaction-action="inspect">Resolve conflict</button>'
      : transaction.state === 'Error'
        ? '<button type="button" class="row-transaction-action" data-transaction-action="inspect">Inspect save error</button>' : '';
  return `<span class="row-transaction row-transaction-${transaction.state.toLocaleLowerCase()}">${escapeHtml(transaction.state)}</span>${action}`;
}

function tableCell(item, field, transaction) {
  if (field === 'EscalationId') return `<button class="row-select" type="button" data-select-row aria-label="Inspect ${escapeHtml(formatEscalationId(item))}">${escapeHtml(formatEscalationId(item))}</button>${transactionMarkup(transaction)}`;
  if (field === 'Status') return statusBadge(item.Status);
  if (field === 'Priority') return `<span class="priority-${statusClass(item.Priority)}">${displayValue(item.Priority)}</span>`;
  if (['ReceivedDateTime', 'DocDate', 'EscalationDate', 'DateResolved'].includes(field)) return formatDate(item[field]);
  if (field === 'Age') return formatAge(item.ReceivedDateTime);
  if (field === 'ReferenceOrSubject') return `<strong>${displayValue(item.Reference)}</strong><br><span>${displayValue(item.Title)}</span>`;
  if (field === 'Value') return formatMoney(item.Value);
  return displayValue(item[field]);
}

export function renderTable(items, selectedId, transactions = new Map()) {
  if (!items.length) return `<tr><td class="table-empty" colspan="${TABLE_RENDER_COLUMN_COUNT}">No escalations match this view.</td></tr>`;
  return items.map((item) => {
    const selected = String(item.id) === String(selectedId);
    const escalationId = formatEscalationId(item);
    const radio = `<td class="selection-cell"><input class="row-selection-radio" type="radio" name="selected-escalation" aria-label="Select ${escapeHtml(escalationId)}" value="${escapeHtml(item.id)}"${selected ? ' checked' : ''} /></td>`;
    const transaction = transactions.get?.(String(item.id));
    const cells = TABLE_COLUMNS.map(([field]) => `<td${field === 'Age' ? ' class="age-cell"' : ''}>${tableCell(item, field, transaction)}</td>`).join('');
    return `<tr class="case-table-row${selected ? ' is-selected' : ''}" data-case-id="${escapeHtml(item.id)}" tabindex="0" aria-current="${selected ? 'true' : 'false'}">${radio}${cells}</tr>`;
  }).join('');
}

function vendorStateMarkup(item, vendorResults, lookupState) {
  const state = vendorMatchState(item);
  const labels = { 'not-applicable': 'Vendor not applicable', unmatched: 'Vendor not matched', confirmed: 'Confirmed vendor match', incomplete: 'Vendor mapping incomplete' };
  const lookupMessage = lookupState.status === 'pending' ? 'Vendor lookup pending...'
    : lookupState.status === 'not-found' ? 'No vendor match found in Demo Vendor Reference.'
      : lookupState.status === 'error' ? `Vendor lookup error: ${lookupState.message}`
        : lookupState.status === 'success' ? `${vendorResults.length} vendor match${vendorResults.length === 1 ? '' : 'es'} found.`
          : lookupState.message || 'Search the live Supplier Reference list to match a vendor.';
  const results = vendorResults.length ? `<ul class="vendor-results" aria-label="Vendor search results">${vendorResults.map((vendor) => `<li><button type="button" class="vendor-result" data-vendor-id="${escapeHtml(vendor.id)}" data-vendor="${escapeHtml(vendor.Vendor)}" data-vendor-name="${escapeHtml(vendor.VendorName)}" data-vendor-category="${escapeHtml(vendor.VendorCategory)}"><strong>${displayValue(vendor.VendorName)}</strong><span>${displayValue(vendor.Vendor)} · ${displayValue(vendor.VendorCategory)}</span></button></li>`).join('')}</ul>` : '';
  const unmatchedAction = lookupState.status === 'not-found' && lookupState.query
    ? '<button id="keep-unmatched-vendor" class="secondary-button" type="button">Keep as unmatched vendor</button>' : '';
  return `<span class="vendor-state-badge vendor-state-${state}">${labels[state]}</span><div class="vendor-finder"><label for="vendor-search">Find vendor</label><div class="finder-row"><input id="vendor-search" type="search" value="${escapeHtml(lookupState.query ?? '')}" placeholder="Vendor, name or lookup key" autocomplete="off" /><button id="vendor-search-button" class="secondary-button" type="button">Find vendor</button></div><div id="vendor-lookup-state" class="field-hint" role="status" aria-live="polite">${escapeHtml(lookupMessage)}</div>${results}<div class="vendor-actions">${unmatchedAction}<button id="clear-vendor" class="secondary-button" type="button">Clear / not applicable</button></div></div>`;
}

export function renderCaseDetail(item, rows, config, vendorResults = [], vendorLookupState = { status: 'idle', message: '' }) {
  const governedValues = config.governedValues ?? {};
  const workflowOrder = ['Value', 'ActionType', 'Status', 'Priority', 'WorkingNotes', 'DateResolved', 'APOwner', 'Entity', 'DocDate', 'InvRef', 'EscalationDate'];
  const hydration = item.__editHydrationStatus ?? (item.__etag ? 'ready' : 'loading');
  const hydrationMessage = hydration === 'ready' ? 'Editor ready with current SharePoint version.'
    : hydration === 'error' ? `Editor unavailable: ${escapeHtml(item.__editHydrationMessage ?? 'ETag could not be loaded.')}`
      : 'Loading the current SharePoint version before editing...';
  const retryHydration = hydration === 'error' ? '<button id="retry-etag" class="secondary-button" type="button">Retry editor load</button>' : '';
  return `<div class="detail-header"><div><p class="eyebrow">Selected escalation</p><h2>${escapeHtml(formatEscalationId(item))}</h2>${statusBadge(item.Status)}</div><span class="detail-age">${formatAge(item.ReceivedDateTime)}</span></div><div id="editor-hydration-state" class="editor-hydration editor-hydration-${hydration}" role="status" aria-live="polite">${hydrationMessage}${retryHydration}</div><div id="save-state" class="save-state" role="status" aria-live="polite">${hydration === 'ready' ? 'No changes' : 'Save unavailable until the current version loads'}</div><div id="save-validation-summary" class="save-validation-summary" role="alert" tabindex="-1" hidden></div><div class="save-toolbar"><button id="save-case" class="primary-button" type="button" disabled>Save</button><button id="discard-changes" class="secondary-button" type="button" disabled>Discard changes</button><span class="save-help">Changes are sent together when you choose Save.</span></div><div class="readback-actions"><button id="retry-readback" class="secondary-button" type="button" hidden>Retry readback</button></div><div id="conflict-actions" class="conflict-actions" hidden><button id="refresh-compare" class="secondary-button" type="button">Refresh / Compare</button><div id="conflict-compare" class="conflict-compare" role="region" aria-live="polite" hidden></div></div><section class="detail-section operational-summary"><h3>Case details</h3><div class="detail-grid">${VISIBLE_EMAIL_FIELDS.map((field) => readOnlyField(item, field)).join('')}</div></section><section class="detail-section"><h3>Vendor match</h3>${vendorStateMarkup(item, vendorResults, vendorLookupState)}<div class="detail-grid vendor-summary"><div class="detail-field"><span class="field-label">Vendor</span><output>${displayValue(item.Vendor)}</output></div><div class="detail-field"><span class="field-label">Vendor Name</span><output>${displayValue(item.VendorName)}</output></div><div class="detail-field"><span class="field-label">Category</span><output>${displayValue(item.VendorCategory)}</output></div></div></section><section class="detail-section"><h3 id="workflow-heading">${escapeHtml(currentUserWorkflowHeading(config.currentUser))}</h3><div class="detail-grid">${workflowOrder.map((field) => detailControl(item, field, rows, governedValues)).join('')}</div></section><section id="activity-panel" class="detail-section activity-section"><h3>Activity</h3><ol class="activity-list"><li><span class="activity-dot" aria-hidden="true"></span><div><strong>Case captured</strong><small>${formatDate(item.ReceivedDateTime)}</small></div></li><li><span class="activity-dot" aria-hidden="true"></span><div><strong>Current status: ${displayValue(item.Status)}</strong><small>Activity history is supplied by SharePoint versioning when available.</small></div></li></ol></section>`;
}

function appShellTemplate(config) {
  const userLabel = currentUserAriaLabel(config.currentUser);
  return `<div class="app-shell"><header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">ES</span><div><p class="brand-kicker">DEMO Shared Services Portal</p><h1>Demo Escalation Workbench</h1></div></div><div class="topbar-search"><label class="sr-only" for="case-search">Search vendor, reference or sender</label><input id="case-search" type="search" autocomplete="off" placeholder="Search vendor, reference, sender…" /></div><div class="topbar-tools"><button class="icon-button" type="button" aria-label="Notifications">♧</button><button class="icon-button" type="button" aria-label="Help">?</button><span class="user-badge" aria-label="${escapeHtml(userLabel)}">${escapeHtml(currentUserInitials(config.currentUser))}</span></div></header><div class="workbench-layout"><section class="workbench-main" aria-label="Escalation cases"><div class="kpi-grid" aria-label="Escalation KPIs"><article class="kpi-card"><span>Open</span><strong id="kpi-open" data-kpi-value>Loading</strong></article><article class="kpi-card"><span>Closed</span><strong id="kpi-closed" data-kpi-value>Loading</strong></article><article class="kpi-card kpi-action"><span>Oldest Open</span><button id="kpi-oldest-open" type="button">Go to oldest →</button></article><article class="kpi-card"><span>Critical</span><strong id="kpi-critical" data-kpi-value>Loading</strong></article><article class="kpi-card"><span>Vendor Not Matched</span><strong id="kpi-vendor-unmatched" data-kpi-value>Loading</strong></article></div><button id="retry-kpis" class="secondary-button retry-kpis" type="button" hidden>Retry KPI counts</button><section class="case-panel"><div class="case-panel-heading"><div><p class="eyebrow">Work queue</p><h2>Escalation cases</h2></div><div class="case-panel-actions"><button id="export-csv" class="secondary-button" type="button">Export items</button><label for="page-size">Cases per page<select id="page-size"><option value="10">10</option><option value="20">20</option><option value="50">50</option></select></label></div></div><div class="tabs" role="tablist" aria-label="Case status"><button type="button" role="tab" aria-selected="true" data-status="Open">Open</button><button type="button" role="tab" aria-selected="false" data-status="Closed">Closed</button><button type="button" role="tab" aria-selected="false" data-status="All">All</button></div><div class="table-scroll" tabindex="0" aria-label="Scrollable escalation case table"><table id="case-table"><caption class="sr-only">Escalation cases</caption><thead><tr id="case-table-head"></tr></thead><tbody id="case-table-body"><tr><td class="table-empty" colspan="${TABLE_COLUMNS.length}">Loading cases…</td></tr></tbody></table></div><div class="case-panel-footer"><p id="live-status" role="status" aria-live="polite">Ready</p><nav id="case-pagination" class="pagination" aria-label="Case pagination"><button id="previous-page" type="button" aria-label="Previous page" disabled>‹</button><span id="page-status" aria-live="polite">Page 1</span><button id="next-page" type="button" aria-label="Next page" disabled>›</button></nav></div></section></section><aside id="detail-panel" class="detail-panel" aria-label="Selected case details"><p class="empty-state">Select an escalation to inspect details.</p></aside></div></div>`;
}

export function appShellMarkup(config) {
  return appShellTemplate(config)
    .replace('<button id="kpi-oldest-open" type="button">Go to oldest →</button>', '<button id="kpi-oldest-open" type="button" disabled>Go to oldest →</button>')
    .replace('<button id="retry-kpis" class="secondary-button retry-kpis" type="button" hidden>Retry KPI counts</button>', '<div class="kpi-load-state"><button id="retry-kpis" class="secondary-button retry-kpis" type="button" hidden>Retry KPI counts</button><span id="kpi-state" role="status" aria-live="polite">Loading KPI totals…</span></div>')
    .replace('<button id="export-csv" class="secondary-button" type="button">Export items</button>', '<button id="export-csv" class="secondary-button" type="button">Export items</button><button id="clear-column-filters" class="secondary-button" type="button" aria-label="Clear all column filters" disabled>Clear all filters</button>')
    .replace(`colspan="${TABLE_COLUMNS.length}"`, `colspan="${TABLE_RENDER_COLUMN_COUNT}"`);
}
