import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { createConfiguredCaseService } from '../../frontend/src/services/case-service.js';
import { buildEscalationQuery } from '../../frontend/src/services/sharepoint-client.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const viewPath = path.join(root, 'frontend', 'src', 'ui', 'workbench-view.js');
const popoverPath = path.join(root, 'frontend', 'src', 'ui', 'column-filter-menu.js');
const pagingFilterPath = path.join(root, 'frontend', 'src', 'ui', 'paging-filter-controller.js');
const csvPath = path.join(root, 'frontend', 'src', 'services', 'csv-export.js');
const appPath = path.join(root, 'frontend', 'src', 'ui', 'app.js');

const technicalLabels = [
  'Internet Message ID',
  'Outlook Message ID',
  'Conversation ID',
  'Unique Key',
  'Original Unique Key',
  'S marker',
];

function sampleCase(overrides = {}) {
  return {
    id: 148,
    Title: 'Invoice escalation',
    Status: 'Action Required',
    Priority: 'Critical',
    ReceivedDateTime: '2026-07-20T09:15:00Z',
    SourceQueue: 'Fixture-East',
    From: 'sender@example.invalid',
    Reference: 'REF-148',
    Vendor: 'V-1',
    VendorName: 'Example Vendor',
    VendorCategory: 'Goods',
    Entity: 'DEMO-ENTITY-05',
    Value: 1200.5,
    ActionType: 'Investigate',
    APOwner: 'Owner A',
    InternetMessageId: '<hidden@example.invalid>',
    OutlookMessageId: 'outlook-hidden',
    ConversationId: 'conversation-hidden',
    UniqueKey: 'unique-hidden',
    OriginalUniqueKey: 'original-hidden',
    SMarker: 'S',
    ...overrides,
  };
}

test('visible workbench boundary renders stable friendly IDs and hides technical identifiers', async () => {
  assert.equal(existsSync(viewPath), true, 'focused workbench view boundary must exist');
  const view = await import(pathToFileURL(viewPath));
  const item = sampleCase();
  assert.equal(view.formatEscalationId(item), 'ESC-2026-000148');
  assert.equal(view.formatEscalationId({ ...item, WorkingNotes: 'saved' }), 'ESC-2026-000148');
  assert.notEqual(view.formatEscalationId({ ...item, id: 149 }), view.formatEscalationId(item));
  const markup = view.renderCaseDetail(item, [item], {
    governedValues: {},
    currentUser: { displayName: 'Avery Example', email: 'avery.user@example.invalid' },
  });
  assert.match(markup, /ESC-2026-000148/);
  assert.match(markup, /Source Queue/);
  assert.match(markup, /From/);
  assert.match(markup, /Received/);
  assert.match(markup, /Subject/);
  assert.match(markup, /Reference/);
  assert.ok(markup.indexOf('Vendor match') > markup.indexOf('Reference'));
  assert.ok(markup.indexOf('Avery&#39;s workflow') > markup.indexOf('Vendor match'));
  for (const label of technicalLabels) assert.doesNotMatch(markup, new RegExp(label, 'i'));
  for (const value of ['outlook-hidden', 'conversation-hidden', 'unique-hidden', 'original-hidden']) {
    assert.doesNotMatch(markup, new RegExp(value));
  }
});

test('authenticated SharePoint identity owns initials, accessible label and workflow heading', async () => {
  const view = await import(pathToFileURL(viewPath));
  const currentUser = { displayName: 'Avery Example', email: 'avery.user@example.invalid' };
  const shell = view.appShellMarkup({ currentUser });
  const detail = view.renderCaseDetail(sampleCase(), [sampleCase()], { governedValues: {}, currentUser });

  assert.match(shell, /class="user-badge"[^>]*aria-label="Current user: Avery Example \(avery\.user@example\.invalid\)"[^>]*>AE<\/span>/);
  assert.match(detail, /id="workflow-heading"[^>]*>Avery&#39;s workflow<\/h3>/);
  assert.doesNotMatch(`${shell}\n${detail}`, /Fixture owner's workflow|>SA<\/span>/);

  const neutral = view.appShellMarkup({});
  assert.match(neutral, /aria-label="Current user unavailable"[^>]*>--<\/span>/);
});

test('a neutral service result preserves a verified preconfigured identity', async () => {
  const { createCurrentUserController } = await import('../../frontend/src/ui/current-user-controller.js');
  const attributes = new Map();
  const badge = {
    textContent: '',
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
  };
  const heading = { textContent: '' };
  const context = {
    root: { querySelector: () => badge },
    dom: { detail: { querySelector: () => heading } },
    config: { currentUser: { displayName: 'Avery Example', email: 'avery.user@example.invalid' } },
    service: { getCurrentUser: async () => null },
  };
  await createCurrentUserController(context).load();
  assert.equal(badge.textContent, 'AE');
  assert.equal(heading.textContent, "Avery's workflow");
  assert.match(attributes.get('aria-label'), /Avery Example/);
});

test('app owns a GET-only background refresh path that protects active drafts', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /createBackgroundRefreshController/);
  assert.match(source, /invalidateReadCaches/);
  assert.match(source, /hasUnsavedChanges/);
  assert.match(source, /backgroundRefreshMs/);
});

test('background refresh is bounded, deduplicated and visibility-aware', async () => {
  const { createBackgroundRefreshController } = await import('../../frontend/src/ui/background-refresh-controller.js');
  const events = [];
  const listeners = new Map();
  const windowTarget = {
    addEventListener: (name, handler) => listeners.set(`window:${name}`, handler),
    removeEventListener: (name) => listeners.delete(`window:${name}`),
  };
  const documentTarget = {
    visibilityState: 'visible',
    addEventListener: (name, handler) => listeners.set(`document:${name}`, handler),
    removeEventListener: (name) => listeners.delete(`document:${name}`),
  };
  let scheduled = null;
  let releaseRefresh;
  const controller = createBackgroundRefreshController({
    intervalMs: 30000,
    fullRefreshEvery: 2,
    windowTarget,
    documentTarget,
    schedule: (handler, interval) => { scheduled = { handler, interval }; return 7; },
    cancel: (id) => events.push(`cancel:${id}`),
    invalidate: ({ includeTotals }) => events.push(`invalidate:${includeTotals}`),
    refresh: ({ reason }) => new Promise((resolve) => { events.push(`refresh:${reason}`); releaseRefresh = resolve; }),
    syncSelected: () => events.push('sync-selected'),
  });

  controller.start();
  assert.equal(scheduled.interval, 30000);
  const first = controller.run('manual');
  const duplicate = controller.run('manual');
  assert.equal(first, duplicate);
  await Promise.resolve();
  await Promise.resolve();
  releaseRefresh();
  assert.equal(await first, true);
  assert.deepEqual(events.slice(0, 3), ['invalidate:false', 'refresh:manual', 'sync-selected']);

  documentTarget.visibilityState = 'hidden';
  assert.equal(await controller.run('timer'), false);
  documentTarget.visibilityState = 'visible';
  const second = controller.run('focus');
  await Promise.resolve();
  await Promise.resolve();
  releaseRefresh();
  await second;
  assert.ok(events.includes('invalidate:true'));
  controller.stop();
  assert.ok(events.includes('cancel:7'));
  assert.equal(listeners.size, 0);
});

test('the full Excel business set has one correctly typed filter menu per header', async () => {
  assert.equal(existsSync(viewPath), true, 'focused workbench view boundary must exist');
  const view = await import(pathToFileURL(viewPath));
  const expected = [
    ['EscalationId', 'friendly-id'], ['Status', 'categorical'], ['ReceivedDateTime', 'date'],
    ['Age', 'age'], ['SourceQueue', 'categorical'], ['Mailbox', 'text'], ['From', 'text'],
    ['Vendor', 'text'], ['VendorName', 'text'], ['VendorCategory', 'text'], ['Entity', 'categorical'],
    ['ReferenceOrSubject', 'text'], ['DocDate', 'date'], ['InvRef', 'text'], ['Value', 'number'],
    ['APOwner', 'categorical'], ['Priority', 'categorical'], ['ActionType', 'categorical'],
    ['EscalationDate', 'date'], ['WorkingNotes', 'text'], ['DateResolved', 'date'], ['DaysToResolve', 'number'],
  ];
  assert.deepEqual(view.TABLE_COLUMNS.map(([field]) => [field, view.HEADER_FILTER_DEFINITIONS[field].kind]), expected);
  const markup = view.renderTableHeader([sampleCase()], { governedValues: {} }, {});
  assert.equal((markup.match(/data-column-filter-toggle=/g) ?? []).length, expected.length);
  assert.equal((markup.match(/data-column-filter-menu=/g) ?? []).length, expected.length);
  for (const [field] of expected) {
    assert.equal((markup.match(new RegExp(`data-column-filter-toggle="${field}"`, 'g')) ?? []).length, 1, field);
    assert.equal((markup.match(new RegExp(`data-column-filter-menu="${field}"`, 'g')) ?? []).length, 1, field);
  }
});

test('Excel Column1 maps to Priority and every confirmed business field is read and exported', async () => {
  const { DEFAULT_FIELD_MAPPING } = await import('../../frontend/src/config/runtime-config.example.js');
  const { CSV_COLUMNS } = await import('../../frontend/src/services/csv-export.js');
  assert.equal(DEFAULT_FIELD_MAPPING.Priority, 'Priority');
  assert.equal(DEFAULT_FIELD_MAPPING.DaysToResolve, 'Days_x0020_To_x0020_Resolve');
  const labels = CSV_COLUMNS.map(([label]) => label);
  for (const label of ['Category', 'Mailbox', 'From', 'Vendor', 'Vendor Name', 'Entity', 'Reference / Subject', 'Doc Date', 'Invoice Ref', 'Value', 'Action Type', 'Status', 'Priority', 'AP Owner', 'Received', 'Escalation Date', 'Working Notes', 'Date Resolved', 'Days To Resolve']) {
    assert.ok(labels.includes(label), `CSV missing ${label}`);
  }
});

test('friendly ID and Reference/Subject filters map server-side with OR within and AND across columns', () => {
  const filter = buildEscalationQuery({
    columnFilters: {
      EscalationId: { kind: 'friendly-id', operator: 'equals', value: 'ESC-2026-000148' },
      ReferenceOrSubject: { kind: 'text', operator: 'contains', value: "invoice's" },
      Priority: { kind: 'categorical', values: ['Critical', 'High'] },
    },
  }).get('$filter');
  assert.match(filter, /Id eq 148/);
  assert.match(filter, /Received_x0020_Date_x0020_Time ge datetime'2026-01-01T00:00:00\.000Z'/);
  assert.match(filter, /substringof\('invoice''s',Reference\) or substringof\('invoice''s',Title\)/);
  assert.match(filter, /Priority eq 'Critical' or Priority eq 'High'/);
  assert.match(filter, / and /);
});

test('every expanded Excel business filter maps to a confirmed SharePoint field', () => {
  const filter = buildEscalationQuery({
    columnFilters: {
      Mailbox: { kind: 'text', operator: 'contains', value: 'Fixture-East' },
      From: { kind: 'text', operator: 'equals', value: 'synthetic@example.invalid' },
      VendorCategory: { kind: 'text', operator: 'contains', value: 'Goods' },
      DocDate: { kind: 'date', operator: 'on', value: '2026-07-20' },
      InvRef: { kind: 'text', operator: 'contains', value: 'INV' },
      EscalationDate: { kind: 'date', operator: 'after', value: '2026-07-01' },
      WorkingNotes: { kind: 'text', operator: 'contains', value: 'follow up' },
      DateResolved: { kind: 'date', operator: 'before', value: '2026-08-01' },
      DaysToResolve: { kind: 'number', operator: 'gte', value: '2' },
    },
  }).get('$filter');
  for (const internalName of ['Mailbox', 'From', 'Vendor_x0020_Category', 'Doc_x0020_Date', 'Inv_x0020_Ref', 'Escalation_x0020_Date', 'Working_x0020_Notes', 'Date_x0020_Resolved', 'Days_x0020_To_x0020_Resolve']) {
    assert.match(filter, new RegExp(internalName));
  }
});

test('KPI counts use one ID-keyset stream, dedupe concurrent loads and cache complete success', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const filter = parsed.searchParams.get('$filter') ?? '';
    const after = Number(/Id gt (\d+)/.exec(filter)?.[1] ?? 0);
    const rows = [
      { Id: 1, Status: 'Action Required', Priority: 'Critical', Vendor: '', Received_x0020_Date_x0020_Time: '2026-01-01T00:00:00Z' },
      { Id: 2, Status: 'Closed', Priority: 'Low', Vendor: 'V2', Vendor_x0020_Name: '', Vendor_x0020_Category: '', Received_x0020_Date_x0020_Time: '2026-01-02T00:00:00Z' },
      { Id: 3, Status: 'In Progress', Priority: 'High', Vendor: 'V3', Vendor_x0020_Name: 'Mapped', Vendor_x0020_Category: 'Goods', Received_x0020_Date_x0020_Time: '2026-01-03T00:00:00Z' },
      { Id: 4, Status: 'Closed', Priority: 'Critical', Vendor: 'V4', Vendor_x0020_Name: 'Mapped', Vendor_x0020_Category: 'Goods', Received_x0020_Date_x0020_Time: '2026-01-04T00:00:00Z' },
    ];
    return { ok: true, json: async () => ({ value: rows.filter((row) => row.Id > after).slice(0, 2) }) };
  };
  const service = createConfiguredCaseService({
    mode: 'sharepoint', verified: true, siteUrl: 'https://fixture.example.invalid/sites/DEMO', listTitle: 'Escalations',
    traversalChunkSize: 2, retryBaseDelayMs: 0, retryMaxDelayMs: 0,
  }, fetchImpl);
  const [first, deduped] = await Promise.all([service.counts(), service.counts()]);
  assert.deepEqual({ open: first.open, closed: first.closed, critical: first.critical, vendorUnmatched: first.vendorUnmatched, oldestId: first.oldestOpen.id }, { open: 2, closed: 2, critical: 2, vendorUnmatched: 1, oldestId: 1 });
  assert.deepEqual(deduped, first);
  const requestCount = calls.length;
  assert.deepEqual(await service.counts(), first);
  assert.equal(calls.length, requestCount, 'ordinary rerenders must use the count cache');
  assert.equal(requestCount, 3);
  assert.ok(calls.every((url) => /^Id gt \d+$/.test(new URL(url).searchParams.get('$filter') ?? '')));
  assert.ok(calls.every((url) => (new URL(url).searchParams.get('$select') ?? '').includes('Status')));
});

test('KPI count failures remain explicit and are retryable', async () => {
  let fail = true;
  const service = createConfiguredCaseService({
    mode: 'sharepoint', verified: true, siteUrl: 'https://fixture.example.invalid/sites/DEMO', listTitle: 'Escalations',
  }, async () => fail
    ? { ok: false, status: 503, json: async () => ({}) }
    : { ok: true, json: async () => ({ value: [] }) });
  await assert.rejects(service.counts(), /503/);
  fail = false;
  const recovered = await service.counts({ force: true });
  assert.deepEqual({ open: recovered.open, closed: recovered.closed, critical: recovered.critical, vendorUnmatched: recovered.vendorUnmatched, oldestOpen: recovered.oldestOpen, stale: recovered.stale }, { open: 0, closed: 0, critical: 0, vendorUnmatched: 0, oldestOpen: null, stale: false });
});

test('CSV utility exports all business rows with RFC escaping, UTF-8 and URL cleanup', async () => {
  assert.equal(existsSync(csvPath), true, 'focused CSV boundary must exist');
  const csv = await import(pathToFileURL(csvPath));
  const rows = [sampleCase({ Title: 'Comma, quote " and\nnewline', Value: 12.5 }), sampleCase({ id: 149, Title: '', Value: 0 })];
  const text = csv.buildEscalationCsv(rows);
  assert.equal(text.startsWith('\uFEFF'), true);
  assert.match(text, /"REF-148 \/ Comma, quote "" and\nnewline"/);
  assert.match(text, /ESC-2026-000148/);
  assert.match(text, /,12\.5,/);
  for (const label of technicalLabels) assert.doesNotMatch(text, new RegExp(label, 'i'));
  for (const field of ['InternetMessageId', 'OutlookMessageId', 'ConversationId', 'UniqueKey', 'OriginalUniqueKey', 'SMarker']) {
    assert.doesNotMatch(text, new RegExp(field, 'i'));
  }
  const events = [];
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.options = options; } }
  const result = csv.downloadEscalationCsv(rows, {
    BlobCtor: FakeBlob,
    now: new Date('2026-07-21T08:30:00Z'),
    urlApi: { createObjectURL: () => { events.push('create'); return 'blob:test'; }, revokeObjectURL: (url) => events.push(`revoke:${url}`) },
    documentRef: { createElement: () => ({ click: () => events.push('click'), remove: () => events.push('remove') }), body: { append: () => events.push('append') } },
  });
  assert.equal(result.filename, 'DEMO_Escalations_20260721_083000.csv');
  assert.deepEqual(events, ['create', 'append', 'click', 'remove', 'revoke:blob:test']);
  assert.equal(result.blob.options.type, 'text/csv;charset=utf-8');
  assert.match(csv.buildEscalationCsv([]), /^\uFEFFEscalation ID,/);
});

test('one export button traverses every item in the current view and respects its active filters', async () => {
  const view = await import(pathToFileURL(viewPath));
  const shell = view.appShellMarkup({});
  assert.match(shell, /id="export-csv"[^>]*>Export items<\/button>/);
  assert.doesNotMatch(shell, /id="export-all-items"/);
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /service\.exportAll\(\{ \.\.\.context\.state\.filters \}/);
});

test('explicit export traverses a bounded ID keyset and applies complete filtering client-side', async () => {
  const calls = [];
  const service = createConfiguredCaseService({
    mode: 'sharepoint', verified: true, siteUrl: 'https://fixture.example.invalid/sites/DEMO', listTitle: 'Escalations', traversalChunkSize: 1,
  }, async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const after = Number(/Id gt (\d+)/.exec(parsed.searchParams.get('$filter') ?? '')?.[1] ?? 0);
    const values = [{ Id: 1, Title: 'A', Status: 'Closed', Priority: 'Low' }, { Id: 2, Title: 'A follow-up', Status: 'Closed', Priority: 'Low' }];
    return { ok: true, json: async () => ({ value: values.filter((row) => row.Id > after).slice(0, 1) }) };
  });
  assert.equal(typeof service.exportAll, 'function');
  const rows = await service.exportAll({ status: 'Closed', query: 'A', pageSize: 20, columnFilters: { Priority: { kind: 'categorical', values: ['Low'] } } });
  assert.deepEqual(rows.map((row) => row.id), [1, 2]);
  assert.equal(calls.length, 3);
  const first = new URL(calls[0]);
  assert.equal(first.searchParams.get('$filter'), 'Id gt 0');
  assert.doesNotMatch(first.searchParams.get('$filter'), /substringof|Status|Priority/i);
});

test('the same export path returns all 8,501 items on All and every matching item on a filtered view', async () => {
  const total = 8501;
  const rows = Array.from({ length: total }, (_, index) => ({
    Id: index + 1,
    Title: `Case ${index + 1}`,
    Status: (index + 1) % 4 === 0 ? 'Closed' : 'Action Required',
    Priority: (index + 1) % 7 === 0 ? 'Critical' : 'Low',
  }));
  const service = createConfiguredCaseService({
    mode: 'sharepoint', verified: true, siteUrl: 'https://fixture.example.invalid/sites/DEMO',
    listTitle: 'Escalations', traversalChunkSize: 500,
  }, async (url) => {
    const parsed = new URL(String(url));
    const after = Number(/Id gt (\d+)/.exec(parsed.searchParams.get('$filter') ?? '')?.[1] ?? 0);
    return { ok: true, json: async () => ({ value: rows.filter((row) => row.Id > after).slice(0, 500) }) };
  });

  const all = await service.exportAll({ status: 'All', query: '', columnFilters: {} });
  const filtered = await service.exportAll({
    status: 'Closed',
    columnFilters: { Priority: { kind: 'categorical', values: ['Critical'] } },
  });
  assert.equal(all.length, total);
  assert.deepEqual(filtered.map((item) => item.id), rows
    .filter((row) => row.Status === 'Closed' && row.Priority === 'Critical')
    .map((row) => row.Id));
});

test('filter popovers remain within right and lower viewport boundaries', async () => {
  assert.equal(existsSync(popoverPath), true, 'focused popover boundary must exist');
  const { calculateFilterPopoverPosition } = await import(pathToFileURL(popoverPath));
  const rightEdge = calculateFilterPopoverPosition({ left: 1180, right: 1210, top: 100, bottom: 130 }, { width: 260, height: 340 }, { width: 1280, height: 720, margin: 8 });
  assert.ok(rightEdge.left >= 8 && rightEdge.left + 260 <= 1272);
  assert.ok(rightEdge.top >= 8 && rightEdge.top + 340 <= 712);
  const bottomEdge = calculateFilterPopoverPosition({ left: 900, right: 930, top: 650, bottom: 680 }, { width: 260, height: 300 }, { width: 1024, height: 720, margin: 8 });
  assert.equal(bottomEdge.placementY, 'above');
  assert.ok(bottomEdge.top >= 8 && bottomEdge.top + 300 <= 712);
});

test('an open filter survives refresh and every filter waits for explicit Apply', async () => {
  const view = await import(pathToFileURL(viewPath));
  const popover = await import(pathToFileURL(popoverPath));
  const header = view.renderTableHeader([sampleCase()], { governedValues: {} }, {});
  const menuCount = (header.match(/data-column-filter-menu=/g) ?? []).length;
  const applyCount = (header.match(/data-filter-apply=/g) ?? []).length;
  const pagingSource = readFileSync(pagingFilterPath, 'utf8');

  assert.equal(applyCount, menuCount, 'every filter menu must require one explicit Apply action');
  assert.doesNotMatch(header, /filter immediately|Filters automatically/i);
  assert.doesNotMatch(pagingSource, /addEventListener\('input',[\s\S]*?applyLiveEntry/);
  assert.doesNotMatch(pagingSource, /addEventListener\('change',[\s\S]*?applyLiveEntry/);
  assert.equal(typeof popover.refreshColumnFilterHeader, 'function');

  let replacements = 0;
  let bindings = 0;
  const openMenu = { hidden: false };
  const rootStub = {
    querySelector: (selector) => (
      selector === '[data-column-filter-menu]:not([hidden])' && !openMenu.hidden ? openMenu : null
    ),
  };
  const tableHead = {
    set innerHTML(value) {
      replacements += 1;
      this.value = value;
    },
  };
  const refreshHeader = () => popover.refreshColumnFilterHeader({
    root: rootStub,
    tableHead,
    render: () => '<th>refreshed</th>',
    bind: () => { bindings += 1; },
  });

  assert.equal(refreshHeader(), false, 'an open filter must keep ownership of the header');
  assert.equal(replacements, 0);
  assert.equal(bindings, 0);

  openMenu.hidden = true;
  assert.equal(refreshHeader(), true, 'the latest header can render after the interaction closes');
  assert.equal(replacements, 1);
  assert.equal(bindings, 1);
});

test('STRUCTURE_GATE leaves app.js orchestration below the module threshold', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.ok(source.split(/\r?\n/).length < 800, 'app.js must be decomposed below 800 lines');
  assert.doesNotMatch(source, /function buildEscalationCsv|createObjectURL/);
  assert.doesNotMatch(source, /function buildColumnFilterClauses|_api\/web\/lists/);
});
