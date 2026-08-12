import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { DEFAULT_FIELD_MAPPING } from '../../frontend/src/config/runtime-config.example.js';
import { matchesCaseRequest } from '../../frontend/src/domain/case-filter.js';
import { createSharePointCaseService } from '../../frontend/src/services/case-service.js';
import { createSharePointClient } from '../../frontend/src/services/sharepoint-client.js';
import { buildEscalationQuery } from '../../frontend/src/services/sharepoint-query.js';
import { dateInputValue } from '../../frontend/src/ui/workbench-view.js';
import { appShellMarkup, renderTableHeader } from '../../frontend/src/ui/workbench-view.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const source = (...parts) => path.join(root, 'frontend', 'src', ...parts);

function config(overrides = {}) {
  return {
    mode: 'sharepoint', verified: true,
    siteUrl: 'https://tenant.example.invalid/sites/DEMO', listTitle: 'Demo Escalations',
    vendorReferenceListTitle: 'Demo Vendor Reference', fieldMapping: DEFAULT_FIELD_MAPPING,
    retryBaseDelayMs: 0, retryMaxDelayMs: 0, ...overrides,
  };
}

function response(body, { status = 200, headers = {} } = {}) {
  const values = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => values[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

async function importBoundary(name) {
  const file = source('ui', name);
  assert.equal(existsSync(file), true, `${name} ownership boundary is missing`);
  return import(`${pathToFileURL(file).href}?wave3=${Date.now()}-${Math.random()}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('F1: Open and Closed memberships are explicit and unknown statuses are All-only', () => {
  for (const status of ['Action Required', 'In Progress']) {
    assert.equal(matchesCaseRequest({ Status: status }, { status: 'Open' }), true, String(status));
  }
  for (const status of ['Waiting approval', 'Future Governed Status', '', null]) {
    assert.equal(matchesCaseRequest({ Status: status }, { status: 'Open' }), false, String(status));
    assert.equal(matchesCaseRequest({ Status: status }, { status: 'Closed' }), false, String(status));
    assert.equal(matchesCaseRequest({ Status: status }, { status: 'All' }), true, String(status));
  }
  assert.equal(matchesCaseRequest({ Status: 'Closed' }, { status: 'Closed' }), true);
  assert.equal(matchesCaseRequest({ Status: 'Duplicate' }, { status: 'Closed' }), true);
  assert.equal(matchesCaseRequest({ Status: 'In Progress' }, { status: 'Closed' }), false);
  const open = buildEscalationQuery({ status: 'Open', fieldMapping: DEFAULT_FIELD_MAPPING }).get('$filter') ?? '';
  assert.match(open, /Status eq 'Action Required'/);
  assert.match(open, /Status eq 'In Progress'/);
  assert.doesNotMatch(open, /Status ne/);
});

test('F8: friendly Escalation ID Contains uses case-insensitive substring semantics over the visible ID', () => {
  const row = { id: 1826, ReceivedDateTime: '2026-07-06T11:22:00Z', Status: 'Closed' };
  const contains = { columnFilters: { EscalationId: { kind: 'friendly-id', operator: 'contains', value: '1826' } } };
  assert.equal(matchesCaseRequest(row, contains), true);
  assert.equal(matchesCaseRequest(row, { columnFilters: { EscalationId: { kind: 'friendly-id', operator: 'contains', value: 'esc-2026-0018' } } }), true);
  assert.equal(matchesCaseRequest(row, { columnFilters: { EscalationId: { kind: 'friendly-id', operator: 'contains', value: '9999' } } }), false);
  const filter = buildEscalationQuery({ ...contains, fieldMapping: DEFAULT_FIELD_MAPPING }).get('$filter') ?? '';
  assert.doesNotMatch(filter, /substringof\([^)]*,\s*Id\)|1 eq 0/i, 'numeric Id must not receive unsupported substring or false predicates');
});

test('F8: visible UK dd/MM/yyyy date composes identically with Open/Closed/All across grid totals and export-all', async () => {
  const rows = [
    { Id: 1826, Title: 'Closed fixture', Status: 'Closed', Priority: 'High', Received_x0020_Date_x0020_Time: '2026-07-06T11:22:00Z', Escalation_x0020_Date: '2026-07-05T23:00:00Z', Date_x0020_Resolved: '2026-07-06T22:30:00Z', Doc_x0020_Date: '2026-07-06' },
    { Id: 1827, Title: 'Open fixture', Status: 'In Progress', Priority: 'Low', Received_x0020_Date_x0020_Time: '2026-07-06T20:00:00Z', Escalation_x0020_Date: '2026-07-06T08:00:00Z', Date_x0020_Resolved: '2026-07-06', Doc_x0020_Date: '2026-07-06T00:00:00Z' },
    { Id: 1828, Title: 'Other date', Status: 'Action Required', Priority: 'Low', Received_x0020_Date_x0020_Time: '2026-07-07T00:01:00Z' },
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const filter = parsed.searchParams.get('$filter') ?? '';
    const after = Number(/Id gt (\d+)/.exec(filter)?.[1] ?? 0);
    if (/Id gt/.test(filter)) return response({ value: rows.filter((row) => row.Id > after).slice(0, 500) });
    const dateMatch = /(Received_x0020_Date_x0020_Time|Escalation_x0020_Date|Date_x0020_Resolved|Doc_x0020_Date) ge datetime'([^']+)' and \1 lt datetime'([^']+)'/.exec(filter);
    const filtered = rows.filter((row) => {
      if (/Status eq 'Action Required'/.test(filter) && /Status eq 'In Progress'/.test(filter) && !['Action Required', 'In Progress'].includes(row.Status)) return false;
      if (/Status eq 'Closed'/.test(filter) && /Status eq 'Duplicate'/.test(filter) && !['Closed', 'Duplicate'].includes(row.Status)) return false;
      if (!dateMatch) return true;
      const instant = new Date(row[dateMatch[1]]).getTime();
      return Number.isFinite(instant) && instant >= new Date(dateMatch[2]).getTime() && instant < new Date(dateMatch[3]).getTime();
    });
    return response({ value: filtered, '@odata.count': filtered.length });
  };
  const service = createSharePointCaseService(config({ traversalChunkSize: 500 }), fetchImpl);
  for (const field of ['ReceivedDateTime', 'EscalationDate', 'DateResolved', 'DocDate']) {
    const columnFilters = { [field]: { kind: 'date', operator: 'on', value: '06/07/2026' } };
    const all = await service.query({ status: 'All', columnFilters, page: 1, pageSize: 10 });
    const open = await service.query({ status: 'Open', columnFilters, page: 1, pageSize: 10 });
    const closed = await service.query({ status: 'Closed', columnFilters, page: 1, pageSize: 10 });
    const exported = await service.exportAll({ status: 'All', columnFilters });
    assert.ok(all.items.some((item) => item.id === 1826), `${field} All must include Closed ESC-2026-001826`);
    assert.ok(open.items.every((item) => item.Status !== 'Closed'), `${field} Open leaked Closed`);
    assert.deepEqual(closed.items.map((item) => item.id), [1826], `${field} Closed mismatch`);
    assert.deepEqual(exported.map((item) => item.id), all.items.map((item) => item.id), `${field} grid/export mismatch`);
    assert.equal(all.total, all.items.length, `${field} result count mismatch`);
  }
  assert.ok(calls.length > 0);
});

test('F9: Days To Resolve preserves workbook NETWORKDAYS minus one with London calendar dates', async () => {
  const { deriveDaysToResolve } = await import('../../frontend/src/domain/case-duration.js');
  assert.equal(deriveDaysToResolve('2026-07-06', '2026-07-06'), 0, 'same Monday must display numeric zero');
  assert.equal(deriveDaysToResolve('2026-07-06', '2026-07-09'), 3, 'Monday to Thursday');
  assert.equal(deriveDaysToResolve('2026-07-10', '2026-07-13'), 1, 'Friday to Monday excludes weekend');
  assert.equal(deriveDaysToResolve('2026-07-05T23:00:00Z', '2026-07-06T23:00:00Z'), 1, 'BST instants are London Monday to Tuesday');
  assert.equal(deriveDaysToResolve('', '2026-07-06'), null);
  assert.equal(deriveDaysToResolve('2026-07-06', ''), null);
  assert.equal(deriveDaysToResolve('2026-07-07', '2026-07-06'), null, 'reversed input must remain controlled and blank');
});

test('F9: mapped and authoritative cases derive Days To Resolve from Received Date Time, overriding stale supplied values', async () => {
  let dateResolved = '2026-07-13T15:00:00Z';
  const service = createSharePointCaseService(config(), async (url) => {
    const raw = {
      Id: 77, Status: 'Closed', Priority: 'High',
      Received_x0020_Date_x0020_Time: '2026-07-06T12:00:00Z',
      Escalation_x0020_Date: '2026-07-10T00:00:00Z',
      Date_x0020_Resolved: dateResolved,
      Days_x0020_To_x0020_Resolve: 999,
      '@odata.etag': 'W/"77"',
    };
    return response(/items\(77\)/.test(String(url)) ? raw : { value: [raw], '@odata.count': 1 }, { headers: { ETag: 'W/"77"' } });
  });
  assert.equal((await service.query({ status: 'Closed', page: 1, pageSize: 10 })).items[0].DaysToResolve, 5);
  dateResolved = '2026-07-14T23:00:00Z';
  assert.equal((await service.get(77)).DaysToResolve, 7, 'fresh authoritative readback must update derived display');
});

test('F12: debounced live filter applies only the final rapid value and empty input clears', async () => {
  const { createLiveFilterController } = await importBoundary('live-filter-controller.js');
  const timers = [];
  const applied = [];
  const controller = createLiveFilterController({
    delayMs: 400,
    apply: (columnFilters) => applied.push(columnFilters),
    schedule: (callback) => { timers.push(callback); return timers.length; },
    cancel: () => {},
  });
  for (const value of ['1', '18', '182', '1826']) {
    controller.stage('EscalationId', { kind: 'friendly-id', operator: 'contains', value });
  }
  assert.equal(timers.length, 4);
  timers.forEach((callback) => callback());
  assert.deepEqual(applied, [{ EscalationId: { kind: 'friendly-id', operator: 'contains', value: '1826' } }]);
  controller.stage('EscalationId', null);
  timers.at(-1)();
  assert.deepEqual(applied.at(-1), {});
});

test('F13: shell exposes an accessible disabled Clear all filters control beside Export CSV', () => {
  const markup = appShellMarkup({});
  assert.match(markup, /id="export-csv"[\s\S]{0,200}id="clear-column-filters"/);
  assert.match(markup, /id="clear-column-filters"[^>]*disabled/);
  assert.doesNotMatch(markup, /id="load-kpis"|Not loaded|Load on demand/i);
});

test('F14: every active column header has a persistent non-colour filter indicator and accessible summary', () => {
  const header = renderTableHeader([], {}, {
    EscalationId: { kind: 'friendly-id', operator: 'contains', value: '1826' },
    DateResolved: { kind: 'date', operator: 'on', value: '06/07/2026' },
  });
  assert.equal((header.match(/data-filter-active="true"/g) ?? []).length, 2);
  assert.match(header, /aria-label="Filter Escalation ID, filter active"/);
  assert.match(header, /title="Contains: 1826"/);
  assert.match(header, /aria-label="Filter Date Resolved, filter active"/);
  assert.match(header, /class="[^"]*filter-funnel/);
});

test('F10: footer formatter covers zero, one and many-page record totals', async () => {
  const { formatPageStatus } = await import('../../frontend/src/ui/app.js');
  assert.equal(formatPageStatus({ page: 1, pageSize: 10, total: 0 }), 'Page 1 of 1 · 0 cases');
  assert.equal(formatPageStatus({ page: 1, pageSize: 10, total: 1 }), 'Page 1 of 1 · 1 case');
  assert.equal(formatPageStatus({ page: 1, pageSize: 10, total: 233 }), 'Page 1 of 24 · 233 cases');
  assert.equal(formatPageStatus({ page: 8, pageSize: 50, total: 233 }), 'Page 5 of 5 · 233 cases');
});

test('F1/F7: authoritative readback invalidates complete cached predicates across close and reopen transitions', async () => {
  let currentStatus = 'Action Required';
  let listReads = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (/items\(7\)/.test(target)) {
      return response({ Id: 7, Status: currentStatus, Title: 'Synthetic', Priority: 'High', '@odata.etag': `W/"${currentStatus}"` }, { headers: { ETag: `W/"${currentStatus}"` } });
    }
    listReads += 1;
    const filter = new URL(target).searchParams.get('$filter') ?? '';
    const matches = /Status eq 'Action Required'/.test(filter) && /Status eq 'In Progress'/.test(filter)
      ? ['Action Required', 'In Progress'].includes(currentStatus)
      : /Status eq 'Closed'/.test(filter) && /Status eq 'Duplicate'/.test(filter)
        ? ['Closed', 'Duplicate'].includes(currentStatus) : true;
    return response({ value: matches ? [{ Id: 7, Status: currentStatus, Title: 'Synthetic', Priority: 'High' }] : [], '@odata.count': matches ? 1 : 0 });
  };
  const service = createSharePointCaseService(config(), fetchImpl);
  assert.equal((await service.query({ status: 'Open', page: 1, pageSize: 10 })).items.length, 1);
  currentStatus = 'Closed';
  await service.get(7);
  assert.equal((await service.query({ status: 'Open', page: 1, pageSize: 10 })).items.length, 0);
  assert.equal((await service.query({ status: 'Closed', page: 1, pageSize: 10 })).items.length, 1);
  currentStatus = 'Action Required';
  await service.get(7);
  assert.equal((await service.query({ status: 'Closed', page: 1, pageSize: 10 })).items.length, 0);
  assert.equal((await service.query({ status: 'Open', page: 1, pageSize: 10 })).items.length, 1);
  currentStatus = 'Future Governed Status';
  await service.get(7);
  assert.equal((await service.query({ status: 'Open', page: 1, pageSize: 10 })).items.length, 0);
  assert.equal((await service.query({ status: 'All', page: 1, pageSize: 10 })).items[0].Status, 'Future Governed Status');
  assert.ok(listReads >= 5, 'membership transitions must invalidate and re-read affected contexts');
});

test('F2: Save A then select/dirty B leaves B byte-for-byte unchanged when A confirms and moves', async () => {
  const { createItemSaveCoordinator } = await importBoundary('save-transaction-coordinator.js');
  const readA = deferred();
  const updates = [];
  const ui = { selectedId: 'B', draft: { WorkingNotes: 'B draft' }, focus: 'field-WorkingNotes', etag: 'W/"B-7"', controls: 'enabled' };
  const before = JSON.stringify(ui);
  const coordinator = createItemSaveCoordinator({
    service: {
      update: async (id, patch, etag) => { updates.push({ id, patch, etag }); return { id, ...patch, __etag: 'W/"A-2"' }; },
      get: async () => readA.promise,
    },
    maxPollAttempts: 2, baseDelayMs: 0, maxDelayMs: 0,
    onConfirmed: (item, snapshot) => { if (ui.selectedId === String(snapshot.itemId)) ui.etag = item.__etag; },
  });
  const transaction = coordinator.save({ itemId: 'A', patch: { Status: 'Closed' }, etag: 'W/"A-1"', uiState: { selectedId: 'A', focus: 'field-Status' } });
  assert.equal(coordinator.isLocked('A'), true);
  readA.resolve({ id: 'A', Status: 'Closed', __etag: 'W/"A-3"' });
  await transaction.completion;
  assert.equal(transaction.state, 'Confirmed');
  assert.deepEqual(updates, [{ id: 'A', patch: { Status: 'Closed' }, etag: 'W/"A-1"' }]);
  assert.equal(JSON.stringify(ui), before, 'B draft/focus/ETag/controls changed after A confirmation');
  assert.equal(Object.isFrozen(transaction.snapshot), true);
  assert.equal(Object.isFrozen(transaction.snapshot.patch), true);
});

test('F2: A and C poll concurrently within the configured bound and a 412 on A cannot affect B', async () => {
  const { createItemSaveCoordinator } = await importBoundary('save-transaction-coordinator.js');
  let activeReads = 0;
  let maxActiveReads = 0;
  const release = deferred();
  const b = { selectedId: 'B', draft: 'exact B bytes', focus: 'field-APOwner', etag: 'W/"B-4"' };
  const before = JSON.stringify(b);
  const coordinator = createItemSaveCoordinator({
    service: {
      update: async (id, patch) => {
        if (id === 'A') throw Object.assign(new Error('Edit conflict'), { code: 'ETAG_CONFLICT', status: 412 });
        return { id, ...patch, __etag: `W/"${id}-2"` };
      },
      get: async (id) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await release.promise;
        activeReads -= 1;
        return { id, Status: 'Closed', __etag: `W/"${id}-3"` };
      },
    },
    maxConcurrentReadbacks: 1, maxPollAttempts: 1, baseDelayMs: 0, maxDelayMs: 0,
  });
  const a = coordinator.save({ itemId: 'A', patch: { Status: 'Closed' }, etag: 'W/"A-1"', uiState: b });
  const c = coordinator.save({ itemId: 'C', patch: { Status: 'Closed' }, etag: 'W/"C-1"', uiState: b });
  await a.completion;
  release.resolve();
  await c.completion;
  assert.equal(a.state, 'Conflict');
  assert.equal(c.state, 'Confirmed');
  assert.ok(maxActiveReads <= 1, `readback concurrency exceeded bound: ${maxActiveReads}`);
  assert.equal(JSON.stringify(b), before);
});

test('F3/F4: successful stale bodies are automatically polled, UK dates compare by London calendar day, and PATCH occurs once', async () => {
  const { createItemSaveCoordinator } = await importBoundary('save-transaction-coordinator.js');
  let patches = 0;
  let reads = 0;
  const coordinator = createItemSaveCoordinator({
    service: {
      update: async (_id, patch) => { patches += 1; return { id: 7, ...patch, __etag: 'W/"2"' }; },
      get: async () => {
        reads += 1;
        return { id: 7, DateResolved: '2026-07-20T23:00:00Z', APOwner: reads >= 3 ? 'Fixture Owner 01' : 'Fixture Owner 02', __etag: `W/"${reads + 2}"` };
      },
    },
    maxPollAttempts: 4, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0,
  });
  const transaction = coordinator.save({ itemId: 7, patch: { DateResolved: '2026-07-21', APOwner: 'Fixture Owner 01' }, etag: 'W/"1"' });
  await transaction.completion;
  assert.equal(transaction.state, 'Confirmed');
  assert.equal(patches, 1);
  assert.equal(reads, 3);
  assert.equal(transaction.item.__etag, 'W/"5"');
  assert.equal(dateInputValue('2026-07-20T23:00:00Z'), '2026-07-21');
});

test('F3: fresh single-item reads are cache-busted/no-store and delayed Retry restarts GET-only polling', async () => {
  const calls = [];
  const client = createSharePointClient(config(), async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response({ Id: 7, Status: 'Closed', '@odata.etag': 'W/"7"' }, { headers: { ETag: 'W/"7"' } });
  });
  await client.getItem(7);
  await client.getItem(7);
  assert.equal(new Set(calls.map((call) => call.url)).size, 2);
  assert.ok(calls.every((call) => call.options.cache === 'no-store'));

  const { createItemSaveCoordinator } = await importBoundary('save-transaction-coordinator.js');
  let patches = 0;
  let reads = 0;
  let authoritative = false;
  const coordinator = createItemSaveCoordinator({
    service: {
      update: async () => { patches += 1; return { id: 7, Status: 'Closed' }; },
      get: async () => { reads += 1; return { id: 7, Status: authoritative ? 'Closed' : 'In Progress', __etag: `W/"${reads}"` }; },
    },
    maxPollAttempts: 2, baseDelayMs: 0, maxDelayMs: 0,
  });
  const transaction = coordinator.save({ itemId: 7, patch: { Status: 'Closed' }, etag: 'W/"1"' });
  await transaction.completion;
  assert.equal(transaction.state, 'Delayed');
  authoritative = true;
  await coordinator.retry(7);
  assert.equal(transaction.state, 'Confirmed');
  assert.equal(patches, 1, 'Retry must never resend PATCH');
  assert.equal(reads, 3);
});

test('F5: automatic KPI coordinator dedupes initial/reinjected scans and one debounced post-save refresh', async () => {
  const { createKpiLoadCoordinator } = await importBoundary('kpi-load-coordinator.js');
  const registry = new Map();
  const first = deferred();
  let scans = 0;
  const load = async ({ force }) => {
    scans += 1;
    if (!force) return first.promise;
    return { open: 2, closed: 1, critical: 1, vendorUnmatched: 0, oldestOpen: null };
  };
  const states = [];
  const a = createKpiLoadCoordinator({ key: 'same-list', load, registry, debounceMs: 0, onState: (state) => states.push(state.status) });
  const reinjected = createKpiLoadCoordinator({ key: 'same-list', load, registry, debounceMs: 0 });
  const initialA = a.start();
  const initialB = reinjected.start();
  assert.equal(scans, 1);
  first.resolve({ open: 1, closed: 1, critical: 0, vendorUnmatched: 0, oldestOpen: null });
  assert.deepEqual(await initialA, await initialB);
  const refreshA = a.refreshAfterSave();
  const refreshB = reinjected.refreshAfterSave();
  assert.strictEqual(refreshA, refreshB);
  await refreshA;
  assert.equal(scans, 2);
  assert.ok(states.includes('loading'));
  assert.ok(states.includes('ready'));
});

test('F5/F7: KPI failure exposes Retry-only fallback; Closed remains editable and fixture owner survives reopen/reopen-status writes', async () => {
  const { createKpiLoadCoordinator } = await importBoundary('kpi-load-coordinator.js');
  let fail = true;
  const coordinator = createKpiLoadCoordinator({
    key: 'retry-list', registry: new Map(), debounceMs: 0,
    load: async () => { if (fail) throw new Error('scan failed'); return { open: 0, closed: 1, critical: 0, vendorUnmatched: 0, oldestOpen: null }; },
  });
  await assert.rejects(coordinator.start(), /scan failed/);
  assert.equal(coordinator.getState().status, 'unavailable');
  assert.equal(coordinator.getState().action, 'retry');
  fail = false;
  assert.equal((await coordinator.retry()).closed, 1);

  const patchBodies = [];
  let status = 'Closed';
  let owner = 'Fixture Owner 01';
  let etag = 'W/"1"';
  const client = createSharePointClient(config(), async (url, options = {}) => {
    if (String(url).includes('contextinfo')) return response({ FormDigestValue: 'digest' });
    if (options.headers?.['X-HTTP-Method'] === 'MERGE') {
      const body = JSON.parse(options.body);
      patchBodies.push(body);
      if (body.Status !== undefined) status = body.Status;
      if (body.AP_x0020_Owner !== undefined) owner = body.AP_x0020_Owner;
      etag = `W/"${patchBodies.length + 1}"`;
      return response({}, { status: 204, headers: { ETag: etag } });
    }
    return response({ Id: 7, Status: status, AP_x0020_Owner: owner, '@odata.etag': etag }, { headers: { ETag: etag } });
  });
  const hydrated = await client.getEditableItem(7);
  assert.equal(hydrated.Status, 'Closed');
  for (const nextStatus of ['Closed', 'In Progress', 'Action Required']) {
    await client.updateItem(7, { Status: nextStatus, APOwner: 'Fixture Owner 01' }, etag);
    const reopened = await client.getEditableItem(7);
    assert.equal(reopened.Status, nextStatus);
    assert.equal(reopened.AP_x0020_Owner, 'Fixture Owner 01');
    etag = reopened.__etag;
  }
  assert.ok(patchBodies.every((body) => body.AP_x0020_Owner === 'Fixture Owner 01'));
  assert.ok(patchBodies.every((body) => !Object.hasOwn(body, 'Fixture owner')));
});
