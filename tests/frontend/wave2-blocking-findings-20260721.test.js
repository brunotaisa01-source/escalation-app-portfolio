import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_FIELD_MAPPING, GOVERNED_VALUES, readRuntimeConfig } from '../../frontend/src/config/runtime-config.example.js';
import { createCaseService, createSharePointCaseService } from '../../frontend/src/services/case-service.js';
import { createSharePointClient } from '../../frontend/src/services/sharepoint-client.js';
import { appShellMarkup, createDetailChoices, renderCaseDetail, renderTable, renderTableHeader, TABLE_COLUMNS } from '../../frontend/src/ui/workbench-view.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const source = (...parts) => path.join(root, 'frontend', 'src', ...parts);

function config(overrides = {}) {
  return {
    mode: 'sharepoint',
    verified: true,
    siteUrl: 'https://tenant.example.invalid/sites/DEMO',
    listTitle: 'Demo Escalations',
    vendorReferenceListTitle: 'Demo Vendor Reference',
    pageSize: 10,
    fieldMapping: DEFAULT_FIELD_MAPPING,
    traversalChunkSize: 500,
    traversalMaxChunks: 100,
    traversalMaxDurationMs: 120000,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    ...overrides,
  };
}

function response(body, { status = 200, headers = {} } = {}) {
  const lookup = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLocaleLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lookup[String(name).toLocaleLowerCase()] ?? null },
    json: async () => body,
  };
}

function afterIdFrom(url) {
  const filter = new URL(url).searchParams.get('$filter') ?? '';
  const match = filter.match(/\bId\s+gt\s+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function syntheticRows(count) {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return {
      Id: id,
      Title: id % 97 === 0 ? `Needle case ${id}` : `Case ${id}`,
      Status: id % 3 === 0 ? 'Closed' : id % 2 === 0 ? 'In Progress' : 'Action Required',
      Priority: id % 5 === 0 ? 'Critical' : id % 2 === 0 ? 'High' : 'Low',
      Received_x0020_Date_x0020_Time: new Date(Date.UTC(2026, 0, 1, 0, id % 60)).toISOString(),
      Source_x0020_Queue: id % 2 === 0 ? 'Fixture-East' : 'Fixture-West',
      From: id % 97 === 0 ? 'needle@example.invalid' : 'sender@example.invalid',
      Reference: `REF-${id}`,
      Vendor: id % 11 === 0 ? '' : String(100000 + id),
      Vendor_x0020_Name: id % 7 === 0 ? '' : `Vendor ${id}`,
      Vendor_x0020_Category: id % 13 === 0 ? '' : 'Services',
      Entity: 'DEMO-ENTITY-05',
      Value: id,
      Action_x0020_Type: 'Reminder',
      AP_x0020_Owner: 'Fixture Owner 01',
      Working_x0020_Notes: 'Synthetic',
      Date_x0020_Resolved: id % 3 === 0 ? '2026-02-01' : '',
    };
  });
}

function keysetFetch(rows, calls, { unsafeSubstringFails = false, crossSiteNextLink = false } = {}) {
  return async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const filter = parsed.searchParams.get('$filter') ?? '';
    if (unsafeSubstringFails && /substringof/i.test(filter)) return response({}, { status: 500 });
    const top = Number(parsed.searchParams.get('$top') ?? 500);
    const afterId = afterIdFrom(url);
    const chunk = rows.filter((row) => row.Id > afterId).slice(0, top);
    const body = { value: chunk };
    if (crossSiteNextLink && chunk.length) body['@odata.nextLink'] = 'https://attacker.example.invalid/_api/items?$skiptoken=unsafe';
    return response(body);
  };
}

test('F1: filtered CSV uses only bounded Id-keyset server predicates and returns the exact client-filtered set above 8k', async () => {
  const rows = syntheticRows(8207);
  const calls = [];
  const service = createSharePointCaseService(config(), keysetFetch(rows, calls, { unsafeSubstringFails: true }));
  const request = {
    status: 'Open',
    statuses: ['Action Required', 'In Progress'],
    query: 'needle',
    sourceQueues: ['Fixture-East'],
    columnFilters: { Priority: { kind: 'categorical', values: ['High'] }, Value: { kind: 'number', operator: 'between', from: 1000, to: 8000 } },
  };
  const exported = await service.exportAll(request);
  const expectedIds = rows.filter((row) => row.Id % 97 === 0 && row.Id % 2 === 0 && row.Id % 3 !== 0 && row.Id % 5 !== 0 && row.Id >= 1000 && row.Id <= 8000).map((row) => row.Id);
  assert.deepEqual(exported.map((row) => row.id), expectedIds);
  assert.ok(calls.length > 16, 'the full list must be traversed in bounded chunks');
  assert.doesNotMatch(new URL(calls[0]).searchParams.get('$filter') ?? '', /substringof/i);
  assert.match(new URL(calls[0]).searchParams.get('$filter') ?? '', /^Id gt 0$/i);
});

test('F1: export rejects unsafe next links, distinguishes cancellation from zero rows, and retries 429/503 only', async () => {
  const rows = syntheticRows(2);
  const unsafe = createSharePointCaseService(config(), keysetFetch(rows, [], { crossSiteNextLink: true }));
  await assert.rejects(() => unsafe.exportAll({ status: 'All' }), /outside the configured site boundary/i);

  const empty = createSharePointCaseService(config(), keysetFetch([], []));
  assert.deepEqual(await empty.exportAll({ status: 'All' }), []);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => empty.exportAll({ status: 'All' }, { signal: controller.signal }), (error) => error?.code === 'TRAVERSAL_CANCELLED');

  let attempts = 0;
  const retrying = createSharePointCaseService(config(), async () => {
    attempts += 1;
    if (attempts === 1) return response({}, { status: 429, headers: { 'Retry-After': '0' } });
    if (attempts === 2) return response({}, { status: 503 });
    return response({ value: [] });
  });
  assert.deepEqual(await retrying.exportAll({ status: 'All' }), []);
  assert.equal(attempts, 3);
});

test('F5 GREEN: startup exposes automatic Loading state with no manual KPI control', () => {
  const shell = appShellMarkup(config());
  assert.match(shell, />Loading</);
  assert.match(shell, /id="kpi-state"[^>]*>Loading KPI totals/);
  assert.doesNotMatch(shell, /id="load-kpis"|Not loaded|Load on demand/i);
  const app = readFileSync(source('ui', 'app.js'), 'utf8');
  assert.match(app, /initialPageRendered[\s\S]*context\.kpis\.start\(\)/);
});

test('F2: one explicit 10,001-row stream computes every KPI, caches, marks stale and refreshes without partial totals', async () => {
  const rows = syntheticRows(10001);
  const calls = [];
  const service = createSharePointCaseService(config(), keysetFetch(rows, calls));
  assert.equal(typeof service.loadKpis, 'function');
  assert.equal(typeof service.markKpisStale, 'function');
  assert.equal(calls.length, 0);
  const first = await service.loadKpis();
  const expected = {
    open: rows.filter((row) => row.Status !== 'Closed').length,
    closed: rows.filter((row) => row.Status === 'Closed').length,
    critical: rows.filter((row) => row.Priority === 'Critical').length,
    vendorUnmatched: rows.filter((row) => row.Vendor && (!row.Vendor_x0020_Name || !row.Vendor_x0020_Category)).length,
  };
  assert.deepEqual({ open: first.open, closed: first.closed, critical: first.critical, vendorUnmatched: first.vendorUnmatched }, expected);
  assert.equal(first.oldestOpen.id, 1);
  const firstCallCount = calls.length;
  assert.ok(firstCallCount >= 21 && firstCallCount <= 22);
  assert.ok(calls.every((url) => /\bId\s+gt\s+\d+/i.test(new URL(url).searchParams.get('$filter') ?? '')));
  assert.deepEqual(await service.loadKpis(), first, 'second load reads complete cache');
  assert.equal(calls.length, firstCallCount);
  service.markKpisStale();
  const stale = await service.loadKpis();
  assert.equal(stale.stale, true);
  assert.equal(calls.length, firstCallCount);
  const refreshed = await service.loadKpis({ force: true });
  assert.equal(refreshed.stale, false);
  assert.ok(calls.length > firstCallCount);
});

test('F3: selection prepends one non-business radio column with checked/current semantics while preserving 22 business columns', () => {
  const rows = [{ id: 7, ReceivedDateTime: '2026-01-02T00:00:00Z', Status: 'Action Required', Priority: 'High' }, { id: 8, ReceivedDateTime: '2026-01-03T00:00:00Z', Status: 'In Progress', Priority: 'Low' }];
  const header = renderTableHeader(rows, { governedValues: GOVERNED_VALUES }, {});
  const body = renderTable(rows, 8);
  assert.equal(TABLE_COLUMNS.length, 22);
  assert.match(header, /^<th[^>]*class="selection-column"[^>]*>.*Select/m);
  assert.equal((header.match(/<th\b/g) ?? []).length, 23);
  assert.equal((body.match(/type="radio"/g) ?? []).length, 2);
  assert.match(body, /name="selected-escalation"[^>]*aria-label="Select ESC-2026-000008"[^>]*checked/);
  assert.equal((body.match(/\schecked/g) ?? []).length, 1);
  assert.match(body, /data-case-id="8"[^>]*aria-current="true"/);
  const app = readFileSync(source('ui', 'app.js'), 'utf8');
  assert.match(app, /ArrowUp|ArrowDown/);
  assert.match(app, /event\.key === ' '|Enter/);
});

test('F4: Excel-complete governed catalogs apply the approved semantic exceptions and explicit legacy Status mapping', () => {
  assert.deepEqual(GOVERNED_VALUES.Priority, ['Critical', 'High', 'Medium', 'Low']);
  assert.deepEqual(GOVERNED_VALUES.ActionType, [
    'Invoice review', 'Invoice review / partner', 'Waiting for bank details',
    'AP query follow-up', 'Manual payment investigation', 'manual payment', 'Accounting system issue',
    'Document distribution', 'Document rejected', 'Recovered from inbox', 'Authority posting',
    'Reminder', 'Dunning fees', 'Urgent manual posting', 'Waiting approval',
  ]);
  assert.deepEqual(GOVERNED_VALUES.Entity, [
    'DEMO-ENTITY-01', 'DEMO-ENTITY-02', 'DEMO-ENTITY-03', 'DEMO-ENTITY-04',
    'DEMO-ENTITY-05', 'DEMO-ENTITY-06', 'DEMO-ENTITY-07', 'DEMO-ENTITY-08',
    'DEMO-ENTITY-09', 'DEMO-ENTITY-10', 'DEMO-ENTITY-11', 'DEMO-ENTITY-12',
  ]);
  assert.deepEqual(GOVERNED_VALUES.APOwner, ['Fixture Owner 01', 'Fixture Owner 02', 'Fixture Owner 03', 'Fixture Owner 04', 'Fixture Owner 05', 'Fixture Owner 06', 'Fixture Owner 07', 'Fixture Owner 08']);
  assert.equal(GOVERNED_VALUES.ActionType.length, 15);
  assert.ok(GOVERNED_VALUES.ActionType.includes('Waiting approval'));
  assert.ok(!GOVERNED_VALUES.APOwner.includes('Awaiting Approval'));
  assert.ok(!JSON.stringify(GOVERNED_VALUES).includes('Awaiting Payment'));
  const mock = createCaseService([
    { id: 1, Status: 'Not Yet Started' },
    { id: 2, Status: 'In Process' },
    { id: 3, Status: 'Closed' },
  ]);
  assert.deepEqual(mock.snapshot().map((item) => item.Status), ['Action Required', 'In Progress', 'Closed']);
  assert.equal(createDetailChoices([], 'APOwner', 'Awaiting Approval', GOVERNED_VALUES.APOwner)[0], 'Awaiting Approval');
  const historical = renderCaseDetail({ id: 4, Status: 'Action Required', APOwner: 'Awaiting Approval', __etag: 'W/"4"' }, [], { governedValues: GOVERNED_VALUES });
  assert.match(historical, /value="Awaiting Approval" selected disabled>Awaiting Approval \(historical\)<\/option>/);
});

test('F4: valid runtime catalogues merge without losing Excel defaults or bypassing safety policy', () => {
  const previous = globalThis.DEMO_ESCALATION_CONFIG;
  globalThis.DEMO_ESCALATION_CONFIG = {
    governedValues: {
      Entity: ['XX01 - Runtime Entity'],
      ActionType: ['Runtime Action'],
      APOwner: ['Runtime Person', 'Awaiting Approval'],
      Status: ['Not Yet Started', 'In Process', 'Closed'],
    },
  };
  try {
    const runtime = readRuntimeConfig();
    assert.ok(runtime.governedValues.Entity.includes('DEMO-ENTITY-01'));
    assert.ok(runtime.governedValues.Entity.includes('XX01 - Runtime Entity'));
    assert.ok(runtime.governedValues.ActionType.includes('Waiting approval'));
    assert.ok(runtime.governedValues.ActionType.includes('Runtime Action'));
    assert.ok(runtime.governedValues.APOwner.includes('Runtime Person'));
    assert.ok(!runtime.governedValues.APOwner.includes('Awaiting Approval'));
    assert.deepEqual(runtime.governedValues.Status, ['Action Required', 'In Progress', 'Closed', 'Duplicate']);
  } finally {
    if (previous === undefined) delete globalThis.DEMO_ESCALATION_CONFIG;
    else globalThis.DEMO_ESCALATION_CONFIG = previous;
  }
});

test('F5: SharePoint and vendor production ownership are split into cohesive acyclic boundaries', async () => {
  const required = [
    source('services', 'sharepoint-query.js'),
    source('services', 'sharepoint-transport.js'),
    source('services', 'sharepoint-traversal.js'),
    source('services', 'vendor-reference-client.js'),
    source('domain', 'case-filter.js'),
    source('ui', 'editor-hydration-controller.js'),
  ];
  required.forEach((file) => assert.equal(existsSync(file), true, `${path.basename(file)} boundary is missing`));
  const clientSource = readFileSync(source('services', 'sharepoint-client.js'), 'utf8');
  assert.ok(clientSource.split(/\r?\n/).length < 140, 'SharePoint composition facade must stay minimal');
  for (const boundary of ['sharepoint-query.js', 'sharepoint-transport.js', 'sharepoint-traversal.js', 'vendor-reference-client.js']) {
    assert.match(clientSource, new RegExp(boundary.replace('.', '\\.')));
  }
  const budgets = new Map([
    ['sharepoint-query.js', 500], ['sharepoint-transport.js', 300], ['sharepoint-traversal.js', 350],
    ['vendor-reference-client.js', 220], ['sharepoint-client.js', 140],
  ]);
  budgets.forEach((budget, file) => assert.ok(readFileSync(source('services', file), 'utf8').split(/\r?\n/).length < budget, `${file} exceeds its recorded module budget`));
  assert.ok(readFileSync(source('ui', 'editor-hydration-controller.js'), 'utf8').split(/\r?\n/).length < 160);
  const transportSource = readFileSync(source('services', 'sharepoint-transport.js'), 'utf8');
  assert.ok(transportSource.slice(transportSource.indexOf('export function createSharePointTransport')).split(/\r?\n/).length < 80, 'transport composition function exceeds its function budget');
  const serviceFiles = [...budgets.keys()];
  const graph = new Map(serviceFiles.map((file) => {
    const imports = [...readFileSync(source('services', file), 'utf8').matchAll(/from ['"]\.\/(.+?\.js)['"]/g)].map((match) => match[1]).filter((name) => serviceFiles.includes(name));
    return [file, imports];
  }));
  const visiting = new Set();
  const visited = new Set();
  function visit(file) {
    assert.ok(!visiting.has(file), `service import cycle reaches ${file}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    visiting.delete(file);
    visited.add(file);
  }
  serviceFiles.forEach(visit);
  const editorSource = readFileSync(source('ui', 'editor-workflow.js'), 'utf8');
  assert.match(editorSource, /vendor-finder-controller\.js/);
  assert.doesNotMatch(editorSource, /from ['"]\.\.\/domain\/vendor-match\.js['"]/);
  const architecture = await import(pathToFileURL(source('services', 'sharepoint-client.js')).href + `?wave2=${Date.now()}`);
  assert.equal(typeof architecture.createSharePointClient, 'function');
});

test('F6: selection hydrates a missing list ETag before edit, accepts header/body ETags, retries failure and never writes without one', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('contextinfo')) return response({ FormDigestValue: 'digest' });
    if (String(url).includes('items(7)')) return response({ Id: 7, Status: 'Action Required', Priority: 'High' }, { headers: { ETag: 'W/"7-a"' } });
    return response({ value: [{ Id: 7, Title: 'No list etag', Status: 'Action Required', Priority: 'High', Received_x0020_Date_x0020_Time: '2026-01-01T00:00:00Z' }] });
  };
  const service = createSharePointCaseService(config(), fetchImpl);
  const page = await service.query({ status: 'All', page: 1, pageSize: 10 });
  assert.equal(page.items[0].__etag, undefined);
  assert.equal(typeof service.hydrateForEdit, 'function');
  const hydrated = await service.hydrateForEdit(7);
  assert.equal(hydrated.__etag, 'W/"7-a"');

  const bodyClient = createSharePointClient(config(), async () => response({ Id: 8, '@odata.etag': 'W/"8-body"' }));
  assert.equal((await bodyClient.getEditableItem(8)).__etag, 'W/"8-body"');

  const noEtagCalls = [];
  const noEtagClient = createSharePointClient(config(), async (url, options) => { noEtagCalls.push({ url, options }); return response({ Id: 9 }); });
  await assert.rejects(() => noEtagClient.getEditableItem(9), (error) => error?.code === 'ETAG_UNAVAILABLE');
  await assert.rejects(() => noEtagClient.updateItem(9, { Status: 'Closed' }, null), (error) => error?.code === 'ETAG_REQUIRED');
  assert.equal(noEtagCalls.length, 1, 'missing ETag update must not request digest or issue MERGE');

  const hydrationPath = source('ui', 'editor-hydration-controller.js');
  assert.equal(existsSync(hydrationPath), true);
  const { createEditorHydrationController } = await import(pathToFileURL(hydrationPath).href + `?wave2=${Date.now()}`);
  let attempts = 0;
  const states = [];
  const hydration = createEditorHydrationController({
    hydrate: async () => { attempts += 1; if (attempts === 1) throw new Error('temporary GET failure'); return { id: 7, __etag: 'W/"7-retry"' }; },
    onState: (state) => states.push(state.status),
  });
  await assert.rejects(() => hydration.select({ id: 7 }), /temporary GET failure/);
  assert.equal(hydration.getState().status, 'error');
  assert.equal((await hydration.retry()).__etag, 'W/"7-retry"');
  assert.deepEqual(states, ['loading', 'error', 'loading', 'ready']);
});

test('F6: a concurrent writer between hydration and MERGE remains a 412 conflict and fresh readback ETag supports the second edit', async () => {
  let currentEtag = 'W/"1"';
  const mergeEtags = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('contextinfo')) return response({ FormDigestValue: 'digest' });
    if (options.headers?.['X-HTTP-Method'] === 'MERGE') {
      mergeEtags.push(options.headers['IF-MATCH']);
      if (options.headers['IF-MATCH'] !== currentEtag) return response({}, { status: 412 });
      currentEtag = currentEtag === 'W/"1"' ? 'W/"2"' : 'W/"3"';
      return response({}, { status: 204, headers: { ETag: currentEtag } });
    }
    return response({ Id: 7, Status: 'Action Required', Priority: 'High', '@odata.etag': currentEtag }, { headers: { ETag: currentEtag } });
  };
  const service = createSharePointCaseService(config(), fetchImpl);
  const hydrated = await service.hydrateForEdit(7);
  currentEtag = 'W/"other-user"';
  await assert.rejects(() => service.update(7, { WorkingNotes: 'mine' }, hydrated.__etag), (error) => error?.code === 'ETAG_CONFLICT');
  const refreshed = await service.hydrateForEdit(7);
  await service.update(7, { WorkingNotes: 'mine' }, refreshed.__etag);
  const readback = await service.get(7);
  assert.equal(readback.__etag, 'W/"3"');
  await service.update(7, { WorkingNotes: 'second edit' }, readback.__etag);
  assert.deepEqual(mergeEtags, ['W/"1"', 'W/"other-user"', 'W/"3"']);
  assert.ok(mergeEtags.every((etag) => etag !== '*'));
});
