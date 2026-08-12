import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_FIELD_MAPPING, GOVERNED_VALUES } from '../../frontend/src/config/runtime-config.example.js';
import { deriveDaysToResolve } from '../../frontend/src/domain/case-duration.js';
import { createCaseService, createSharePointCaseService } from '../../frontend/src/services/case-service.js';
import { formatPageStatus } from '../../frontend/src/ui/app.js';
import { renderCaseDetail } from '../../frontend/src/ui/workbench-view.js';
import { validateDraftForSave } from '../../frontend/src/ui/save-controller.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');

function config(overrides = {}) {
  return {
    mode: 'sharepoint', verified: true,
    siteUrl: 'https://tenant.example.invalid/sites/DEMO', listTitle: 'Demo Escalations',
    vendorReferenceListTitle: 'Demo Vendor Reference', fieldMapping: DEFAULT_FIELD_MAPPING,
    traversalChunkSize: 500, traversalMaxChunks: 40, traversalMaxDurationMs: 120000,
    ...overrides,
  };
}

function response(body) {
  return {
    ok: true, status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function editorItem(overrides = {}) {
  return {
    id: 1782, Title: 'Fixture', ReceivedDateTime: '2026-07-06T11:00:00Z',
    Status: 'Action Required', Priority: 'High', ActionType: GOVERNED_VALUES.ActionType[0],
    WorkingNotes: 'Ready', DateResolved: '2026-07-13', APOwner: 'Fixture Owner 01',
    Entity: GOVERNED_VALUES.Entity[0], __etag: 'W/"1"', __editHydrationStatus: 'ready',
    ...overrides,
  };
}

test('F1 empty authoritative governed values remain empty and render selected required placeholders', () => {
  const blank = createCaseService([editorItem({ Status: null, Priority: null, ActionType: null, APOwner: null, Entity: null })]).snapshot()[0];
  assert.equal(blank.Status, '');
  assert.equal(blank.Priority, '');
  const markup = renderCaseDetail({ ...blank, __editHydrationStatus: 'ready' }, [blank], { governedValues: GOVERNED_VALUES });
  for (const [field, label] of [
    ['Status', 'Status'], ['Priority', 'Priority'], ['ActionType', 'Action Type'],
    ['APOwner', 'AP Owner'], ['Entity', 'Entity'],
  ]) {
    const select = new RegExp(`<select[^>]+id="field-${field}"[\\s\\S]*?<option value="" selected disabled>Select ${label}<\\/option>`);
    assert.match(markup, select, field);
  }
});

test('all governed fixture choices plus historical values render as the exact selected control value', () => {
  let checked = 0;
  for (const [field, values] of Object.entries(GOVERNED_VALUES)) {
    for (const value of values) {
      const item = editorItem({ [field]: value });
      const markup = renderCaseDetail(item, [item], { governedValues: GOVERNED_VALUES });
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(markup, new RegExp(`<option value="${escaped}" selected>`), `${field}:${value}`);
      checked += 1;
    }
  }
  assert.equal(checked, 43);
  const historical = editorItem({ Entity: 'DEMO historical entity' });
  const markup = renderCaseDetail(historical, [historical], { governedValues: GOVERNED_VALUES });
  assert.match(markup, /<option value="DEMO historical entity" selected disabled>DEMO historical entity \(historical\)<\/option>/);
});

test('F1 required validation reports the complete seven-field contract in one pass', () => {
  const failures = [];
  const valid = validateDraftForSave({
    draft: { ActionType: '', Status: '', Priority: ' ', WorkingNotes: '\t', DateResolved: '', APOwner: '', Entity: '' },
    onInvalid: (message, field) => failures.push({ message, field }),
  });
  assert.equal(valid, false);
  assert.deepEqual(failures.map(({ field }) => field), ['ActionType', 'Status', 'Priority', 'WorkingNotes', 'DateResolved', 'APOwner', 'Entity']);
});

test('F2 Days To Resolve uses Received Date Time and rejects impossible dates', () => {
  const service = createCaseService([editorItem({
    ReceivedDateTime: '2026-07-06T12:00:00Z', EscalationDate: '2026-07-10', DateResolved: '2026-07-13',
  })]);
  assert.equal(service.snapshot()[0].DaysToResolve, 5);
  assert.equal(deriveDaysToResolve('2026-99-99', '2026-07-21'), null);
  assert.equal(deriveDaysToResolve('2026-02-30T12:00:00Z', '2026-07-21'), null);
  assert.equal(deriveDaysToResolve('2026-07-20T23:00:00Z', '2026-07-21'), 0);
  assert.equal(deriveDaysToResolve('2026-07-24', '2026-07-27'), 1);
  assert.equal(deriveDaysToResolve('2026-07-27', '2026-07-24'), null);
});

test('F3 omitted count starts one threshold-safe exact total and never loads the grid beyond its chunk', async () => {
  const calls = [];
  const total = 5001;
  const item = (id) => ({
    Id: id, Title: `Case ${id}`, Status: 'Action Required', Priority: 'High',
    Received_x0020_Date_x0020_Time: '2026-07-06T11:00:00Z',
  });
  const nextLink = "https://tenant.example.invalid/sites/DEMO/_api/web/lists/getbytitle('Demo Escalations')/items?$top=10&$skiptoken=page2";
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    const filter = parsed.searchParams.get('$filter') ?? '';
    if ((parsed.searchParams.get('$orderby') ?? '').startsWith('Id asc')) {
      const after = Number(/Id gt (\d+)/.exec(filter)?.[1] ?? 0);
      const rows = [];
      for (let id = after + 1; id <= Math.min(total, after + 500); id += 1) rows.push(item(id));
      return response({ value: rows });
    }
    return response({ value: Array.from({ length: 10 }, (_, index) => item(index + 1)), '@odata.nextLink': nextLink });
  };
  const service = createSharePointCaseService(config(), fetchImpl);
  const page = await service.query({ status: 'Open', page: 1, pageSize: 10 });
  assert.equal(page.items.length, 10);
  assert.equal(formatPageStatus(page), 'Page 1 · Calculating total…');
  assert.equal(typeof page.totalPromise?.then, 'function');
  assert.equal(await page.totalPromise, total);
  const scanCalls = calls.filter((url) => (url.searchParams.get('$orderby') ?? '').startsWith('Id asc')).length;
  assert.ok(scanCalls <= 12);
  await service.loadKpis();
  assert.equal(calls.filter((url) => (url.searchParams.get('$orderby') ?? '').startsWith('Id asc')).length, scanCalls);
  assert.ok(calls.filter((url) => (url.searchParams.get('$orderby') ?? '').startsWith('Received')).length === 1);
});

test('F3 filtered exact total is shared across 10/20/50 page contexts without duplicate full scans', async () => {
  const calls = [];
  const totalRows = 5003;
  const raw = (id) => ({
    Id: id, Title: id % 5 === 0 ? `Needle ${id}` : `Other ${id}`,
    Status: id % 3 === 0 ? 'Closed' : 'Action Required', Priority: id % 2 === 0 ? 'High' : 'Low',
    Received_x0020_Date_x0020_Time: '2026-07-06T11:00:00Z',
  });
  const all = Array.from({ length: totalRows }, (_, index) => raw(index + 1));
  const filtered = all.filter((row) => row.Status === 'Closed' && row.Priority === 'High' && row.Title.includes('Needle'));
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    const filter = parsed.searchParams.get('$filter') ?? '';
    if ((parsed.searchParams.get('$orderby') ?? '').startsWith('Id asc')) {
      const after = Number(/Id gt (\d+)/.exec(filter)?.[1] ?? 0);
      return response({ value: all.filter((row) => row.Id > after).slice(0, 500) });
    }
    const top = Number(parsed.searchParams.get('$top') ?? 10);
    return response({ value: filtered.slice(0, top), '@odata.nextLink': `${parsed.origin}${parsed.pathname}?$top=${top}&$skiptoken=page2` });
  };
  const service = createSharePointCaseService(config(), fetchImpl);
  const request = { status: 'Closed', query: 'Needle', columnFilters: { Priority: { kind: 'categorical', values: ['High'] } } };
  for (const pageSize of [10, 20, 50]) {
    const page = await service.query({ ...request, page: 1, pageSize });
    const resolvedTotal = page.totalPromise ? await page.totalPromise : page.total;
    assert.equal(resolvedTotal, filtered.length);
    const exact = await service.query({ ...request, page: 1, pageSize });
    assert.equal(exact.total, filtered.length);
    assert.equal(formatPageStatus(exact), `Page 1 of ${Math.ceil(filtered.length / pageSize)} · ${filtered.length} cases`);
  }
  assert.ok(calls.filter((url) => (url.searchParams.get('$orderby') ?? '').startsWith('Id asc')).length <= 12);
});

test('F3 a known first-page total survives later pages that omit count metadata', async () => {
  const nextLink = "https://tenant.example.invalid/sites/DEMO/_api/web/lists/getbytitle('Demo Escalations')/items?$top=10&$skiptoken=page2";
  const rows = (start) => Array.from({ length: 10 }, (_, index) => ({
    Id: start + index, Title: `Case ${start + index}`, Status: 'Action Required', Priority: 'High',
    Received_x0020_Date_x0020_Time: '2026-07-06T11:00:00Z',
  }));
  const service = createSharePointCaseService(config(), async (url) => response(String(url).includes('$skiptoken=page2')
    ? { value: rows(11) }
    : { value: rows(1), '@odata.count': 5001, '@odata.nextLink': nextLink }));
  assert.equal((await service.query({ status: 'Open', page: 1, pageSize: 10 })).total, 5001);
  assert.equal((await service.query({ status: 'Open', page: 2, pageSize: 10 })).total, 5001);
});

test('F4 editor CSS keeps an independent bounded scroller in split and stacked layouts', () => {
  const css = read('frontend', 'src', 'styles.css');
  assert.match(css, /\.detail-panel\s*\{[^}]*max-height:\s*calc\(100dvh\s*-\s*58px\s*-\s*2rem\)/s);
  const stacked = /@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(stacked, /\.detail-panel\s*\{[^}]*max-height:\s*calc\(100dvh\s*-\s*1rem\)/s);
  assert.match(stacked, /overflow-y:\s*auto/);
  assert.doesNotMatch(stacked, /max-height:\s*none/);
});

test('F5 launcher contains no dynamic text execution and owns one canonical same-origin script element', () => {
  const launcher = read('frontend', 'launcher', 'escalation-launcher.js');
  assert.doesNotMatch(launcher, /\beval\s*\(/);
  assert.doesNotMatch(launcher, /\bnew\s+Function\b/);
  assert.doesNotMatch(launcher, /\bFunction\s*\(/);
  assert.doesNotMatch(launcher, /response\.text\(\)[\s\S]{0,500}(?:eval|Function)/);
  assert.match(launcher, /document\.createElement\(["']script["']\)/);
  assert.match(launcher, /bundle\.onload\s*=\s*markBundleReady/);
  assert.match(launcher, /bundle\.onerror\s*=/);
  assert.match(launcher, /same-origin HTTPS Escalation frontend folder/);
  assert.match(launcher, /BUNDLE_ID\s*=\s*["']demo-escalation-bundle["']/);
});
