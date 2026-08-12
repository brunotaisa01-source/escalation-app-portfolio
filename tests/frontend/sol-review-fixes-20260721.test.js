import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildEscalationCsv } from '../../frontend/src/services/csv-export.js';
import { createConfiguredCaseService } from '../../frontend/src/services/case-service.js';
import { buildEscalationQuery, createSharePointClient } from '../../frontend/src/services/sharepoint-client.js';
import { calculateFilterPopoverPosition } from '../../frontend/src/ui/column-filter-menu.js';
import { PAGE_SIZES, createCasePaginationController } from '../../frontend/src/ui/app.js';
import { renderCaseDetail, renderTableHeader } from '../../frontend/src/ui/workbench-view.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const appPath = path.join(root, 'frontend', 'src', 'ui', 'app.js');
const stylesPath = path.join(root, 'frontend', 'src', 'styles.css');
const launcherPath = path.join(root, 'frontend', 'launcher', 'escalation-launcher.js');
const runtimePath = path.join(root, 'frontend', 'src', 'config', 'runtime-config.example.js');

const liveConfig = (overrides = {}) => ({
  mode: 'sharepoint',
  verified: true,
  siteUrl: 'https://fixture.example.invalid/sites/DEMO',
  listTitle: 'Escalations',
  vendorReferenceListTitle: 'Demo Vendor Reference',
  ...overrides,
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

test('finding 1: Vendor Finder traverses more than 8,000 rows with bounded ID-keyset GETs and client matching', async () => {
  const calls = [];
  const client = createSharePointClient(liveConfig(), async (url, options) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    const filter = parsed.searchParams.get('$filter') ?? '';
    const start = Number(/Id gt (\d+)/.exec(filter)?.[1] ?? 0);
    const end = Math.min(start + 500, 8500);
    const value = Array.from({ length: end - start }, (_, index) => {
      const id = start + index + 1;
      return {
        Id: id,
        Vendor: `VEN-${id}`,
        Vendor_x0020_Name: id === 8218 ? 'Needle Supplier Limited' : `Supplier ${id}`,
        Vendor_x0020_Category: 'Goods',
        Vendor_x0020_Lookup_x0020_Key: `KEY-${id}`,
      };
    });
    const next = end < 8500
      ? `${parsed.origin}${parsed.pathname}?%24select=Id%2CTitle%2CVendor%2CVendor_x0020_Name%2CVendor_x0020_Category%2CVendor_x0020_Lookup_x0020_Key&%24filter=Id+gt+${end}&%24orderby=Id+asc&%24top=500`
      : null;
    return jsonResponse({ value, ...(next ? { '@odata.nextLink': next } : {}) });
  });

  const results = await client.searchVendorReference('needle supplier');

  assert.deepEqual(results.map((item) => item.id), [8218]);
  assert.ok(calls.length >= 17, 'the explicit search must safely cross the 5,000-item threshold');
  for (const call of calls) {
    assert.equal(call.options.method ?? 'GET', 'GET');
    const filter = new URL(call.url).searchParams.get('$filter') ?? '';
    assert.match(filter, /^Id gt \d+$/);
    assert.doesNotMatch(filter, /substringof|\sor\s/i);
  }
});

test('finding 1: Vendor Finder keeps transport failure distinct from a successful no-match result', async () => {
  const client = createSharePointClient(liveConfig(), async () => jsonResponse({}, { status: 500 }));
  await assert.rejects(client.searchVendorReference('VEN-404'), /500/);
});

test('finding 2: vendor not-applicable, explicit unmatched and confirmed states are distinct and reversible', async () => {
  const caseModule = await import('../../frontend/src/services/case-service.js');
  const appModule = await import('../../frontend/src/ui/app.js');
  assert.equal(typeof caseModule.isVendorUnmatched, 'function');
  assert.equal(typeof appModule.createVendorFinderController, 'function');
  assert.equal(caseModule.isVendorUnmatched({ Vendor: '', VendorName: '', VendorCategory: '' }), false);
  assert.equal(caseModule.isVendorUnmatched({ Vendor: '  00042  ', VendorName: '', VendorCategory: '' }), true);
  assert.equal(caseModule.isVendorUnmatched({ Vendor: '00042', VendorName: 'Mapped', VendorCategory: 'Goods' }), false);
  assert.equal(caseModule.isVendorUnmatched({ Vendor: '00042', VendorName: 'Mapped', VendorCategory: '' }), true);

  const staged = [];
  let fail = true;
  const finder = appModule.createVendorFinderController({
    search: async () => {
      if (fail) throw new Error('HTTP 500');
      return [];
    },
    onStage: (patch) => staged.push(patch),
  });
  await assert.rejects(finder.search('  00042  '), /500/);
  assert.deepEqual(staged, [], 'failed search must not mutate the draft');
  fail = false;
  assert.deepEqual(await finder.search('  00042  '), []);
  assert.deepEqual(finder.keepAsUnmatched(), { Vendor: '00042', VendorName: '', VendorCategory: '' });
  assert.deepEqual(finder.clearNotApplicable(), { Vendor: '', VendorName: '', VendorCategory: '' });
  assert.deepEqual(finder.select({ Vendor: '00042', VendorName: 'Mapped', VendorCategory: 'Goods' }), { Vendor: '00042', VendorName: 'Mapped', VendorCategory: 'Goods' });

  const detail = renderCaseDetail({ id: 1, Vendor: '00042', VendorName: '', VendorCategory: '', Status: 'Action Required' }, [], { governedValues: {} }, [], { status: 'not-found', query: '00042', message: '' });
  assert.match(detail, /Vendor not matched/);
  assert.match(detail, /Keep as unmatched vendor/);
  assert.match(detail, /Clear \/ not applicable/);
});

test('finding 3: paging choices are exactly 10, 20 and 50 with an initial 10-row request only', () => {
  assert.deepEqual(PAGE_SIZES, [10, 20, 50]);
  const calls = [];
  const controller = createCasePaginationController({ query: (request) => {
    calls.push(request);
    return { items: [], page: request.page, pageSize: request.pageSize, total: 100, hasNext: true };
  } });
  controller.request();
  assert.deepEqual(calls, [{ status: 'Open', query: '', page: 1, pageSize: 10 }]);
  controller.setPageSize(50);
  assert.deepEqual(calls.at(-1), { status: 'Open', query: '', page: 1, pageSize: 50 });
  assert.match(readFileSync(launcherPath, 'utf8'), /pageSize:\s*10/);
  assert.match(readFileSync(runtimePath, 'utf8'), /pageSize:\s*10/);
});

test('finding 4: CSV neutralizes formulas while preserving ordinary negative numbers and UTF-8 escaping', () => {
  const csv = buildEscalationCsv([{
    id: 1,
    ReceivedDateTime: '2026-07-21T00:00:00Z',
    Title: '=HYPERLINK("https://example.invalid")',
    Reference: '',
    Vendor: '@vendor',
    VendorName: '-SUM(1,1)',
    InvRef: '+CMD',
    Value: -123.45,
    WorkingNotes: 'safe, "quoted"\nline',
  }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+CMD/);
  assert.match(csv, /'@vendor/);
  assert.match(csv, /'-SUM/);
  assert.match(csv, /,-123\.45,/);
  assert.match(csv, /"safe, ""quoted""\nline"/);
});

test('finding 5: range controls hide To for single operators and stay reachable after Between growth', () => {
  const styles = readFileSync(stylesPath, 'utf8');
  assert.match(styles, /\.column-filter-menu\s+\[hidden\]\s*\{\s*display:\s*none/);
  const markup = renderTableHeader([], { governedValues: {} }, {});
  for (const field of ['ReceivedDateTime', 'Age', 'DocDate', 'Value', 'EscalationDate', 'DateResolved', 'DaysToResolve']) {
    const menu = markup.slice(markup.indexOf(`data-column-filter-menu="${field}"`));
    assert.match(menu.slice(0, menu.indexOf('</th>')), /data-filter-to-label[^>]* hidden/);
    assert.match(menu.slice(0, menu.indexOf('</th>')), /data-filter-to[^>]* hidden/);
  }
  const position = calculateFilterPopoverPosition(
    { left: 930, right: 960, top: 620, bottom: 650 },
    { width: 300, height: 520 },
    { width: 1024, height: 700, margin: 8 },
  );
  const availableAbove = 620 - 8 - 4;
  assert.equal(position.placementY, 'above');
  assert.ok(position.maxHeight <= availableAbove);
  assert.ok(position.top >= 8);
});

test('finding 6: workbench uses the full ultrawide viewport and keeps narrow stacking', () => {
  const styles = readFileSync(stylesPath, 'utf8');
  const layoutRule = /\.workbench-layout\s*\{([^}]*)\}/s.exec(styles)?.[1] ?? '';
  assert.match(layoutRule, /width:\s*100%/);
  assert.doesNotMatch(layoutRule, /1800px|min\(/);
  assert.match(styles, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.workbench-layout\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.table-scroll[^}]*overflow-x:\s*(?:auto|scroll)/s);
  assert.match(styles, /\.detail-panel[^}]*overflow-y:\s*auto/s);
});

test('finding 7: authoritative readback refreshes every cached context with the fresh ETag', async () => {
  const calls = [];
  const service = createConfiguredCaseService(liveConfig(), async (url) => {
    calls.push(String(url));
    if (/items\(7\)/.test(url)) {
      return jsonResponse({ Id: 7, Title: 'Updated', Status: 'In Progress', Priority: 'High', Working_x0020_Notes: 'authoritative' }, { headers: { ETag: 'W/"2"' } });
    }
    return jsonResponse({ value: [{ Id: 7, Title: 'Old', Status: 'Action Required', Priority: 'High', Working_x0020_Notes: 'old', '@odata.etag': 'W/"1"' }] });
  });
  await service.query({ status: 'Open', page: 1, pageSize: 20 });
  await service.query({ status: 'All', page: 1, pageSize: 20 });
  const readback = await service.get(7);
  assert.equal(readback.__etag, 'W/"2"');
  const open = await service.query({ status: 'Open', page: 1, pageSize: 20 });
  const all = await service.query({ status: 'All', page: 1, pageSize: 20 });
  assert.equal(open.items[0].__etag, 'W/"2"');
  assert.equal(all.items[0].__etag, 'W/"2"');
  assert.equal(open.items[0].WorkingNotes, 'authoritative');
  assert.equal(all.items[0].WorkingNotes, 'authoritative');
  assert.equal(calls.length, 3, 'cached contexts should be reconciled without duplicate list fetches');
});

test('finding 8: forbidden PATCH keys are rejected before digest or network work', async () => {
  for (const forbidden of ['UniqueKey', 'id', 'From', 'InternetMessageId', 'OutlookMessageId', 'ConversationId']) {
    let networkCalls = 0;
    const client = createSharePointClient(liveConfig(), async () => {
      networkCalls += 1;
      return jsonResponse({ d: { GetContextWebInformation: { FormDigestValue: 'digest' } } });
    });
    await assert.rejects(client.updateItem(1, { [forbidden]: 'blocked' }, 'W/"1"'), (error) => error.code === 'PATCH_FIELD_FORBIDDEN');
    assert.equal(networkCalls, 0, `${forbidden} must be rejected before contextinfo`);
  }
});

test('finding 9: Age equals/range uses Europe-London calendar days across DST', () => {
  const equals = buildEscalationQuery({
    now: new Date('2026-03-30T00:30:00Z'),
    columnFilters: { Age: { kind: 'age', operator: 'equals', value: '1' } },
  }).get('$filter');
  assert.match(equals, /ge datetime'2026-03-29T00:00:00\.000Z'/);
  assert.match(equals, /lt datetime'2026-03-29T23:00:00\.000Z'/);
  assert.doesNotMatch(equals, /le datetime/);

  const range = buildEscalationQuery({
    now: new Date('2026-10-26T00:30:00Z'),
    columnFilters: { Age: { kind: 'age', operator: 'between', from: '1', to: '2' } },
  }).get('$filter');
  assert.match(range, /ge datetime'2026-10-23T23:00:00\.000Z'/);
  assert.match(range, /lt datetime'2026-10-26T00:00:00\.000Z'/);
});

test('finding 10: renderApp is a small composition boundary with separate owners', () => {
  const source = readFileSync(appPath, 'utf8');
  const start = source.indexOf('export function renderApp');
  const end = source.indexOf('\nexport {', start);
  const renderAppBlock = source.slice(start, end);
  assert.ok(renderAppBlock.split(/\r?\n/).length <= 80, 'renderApp must be orchestration only');
  for (const boundary of ['paging-filter-controller.js', 'editor-workflow.js', 'vendor-finder-controller.js']) {
    assert.match(source, new RegExp(boundary.replace('.', '\\.')));
  }
});
