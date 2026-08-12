import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const appSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'app.js'), 'utf8');
const viewSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'workbench-view.js'), 'utf8');
const editorSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'editor-workflow.js'), 'utf8');
const uiSource = `${appSource}\n${viewSource}\n${editorSource}`;
const frontendManifest = JSON.parse(readFileSync(path.join(root, 'manifests', 'frontend-contract.json'), 'utf8'));

test('frontend manifest binds one live SharePoint contract', () => {
  assert.equal(frontendManifest.mode, 'sharepoint');
  assert.equal(frontendManifest.siteContract.listTitle, 'Demo Escalations');
  assert.equal(frontendManifest.siteContract.vendorReferenceListTitle, 'Demo Vendor Reference');
  assert.deepEqual(frontendManifest.pageSizes, [10, 20, 50]);
  assert.equal(frontendManifest.filters.presentation, 'inline-header-arrow');
  assert.equal(frontendManifest.target.kind, 'relative-pack-assets');
  assert.equal(frontendManifest.target.path, 'frontend');
  assert.equal(frontendManifest.target.launcherPath, 'frontend/launcher/escalation-launcher.js');
  assert.equal(frontendManifest.target.shellPath, 'frontend/dist/index.html');
  assert.equal(frontendManifest.target.bundlePath, 'frontend/dist/assets/app.js');
});

test('every table header exposes an accessible Excel-style filter menu', () => {
  const columnBlock = viewSource.slice(viewSource.indexOf('export const TABLE_COLUMNS'), viewSource.indexOf('export const HEADER_FILTER_DEFINITIONS'));
  assert.equal((columnBlock.match(/\['[A-Za-z]+', '[^']+'\]/g) ?? []).length, 22);
  assert.match(viewSource, /data-column-filter-toggle/);
  assert.match(viewSource, /Select all/);
  assert.match(viewSource, /Clear/);
  assert.match(viewSource, /contains/);
  assert.match(viewSource, /equals/);
  assert.match(viewSource, /between/);
  assert.match(viewSource, /aria-haspopup="dialog"/);
});

test('Excel-style filters are inline header controls with persistent active indicators and no filter rail', () => {
  assert.doesNotMatch(uiSource, /id="filter-rail"/);
  assert.doesNotMatch(uiSource, /data-quick-filter/);
  assert.doesNotMatch(uiSource, /data-status-filter/);
  assert.match(viewSource, /header-filter-toggle/);
  assert.match(viewSource, /filter-funnel/);
  assert.match(viewSource, /filter active/);
  assert.doesNotMatch(viewSource, /header-filter-toggle[^>]*>\s*Filter\s*<\/button>/);
});

test('removing the filter rail also removes its stale KPI update hooks', () => {
  assert.doesNotMatch(uiSource, /quick-open-count|quick-critical-count|quick-unmatched-count/);
});

test('SharePoint query combines column filters server-side with OR within and AND across columns', async () => {
  const { buildEscalationQuery } = await import('../../frontend/src/services/sharepoint-client.js');
  const params = buildEscalationQuery({
    statuses: ['Action Required', 'In Progress'],
    sourceQueues: ['Fixture-West'],
    columnFilters: {
      Entity: { kind: 'categorical', values: ['DEMO-ENTITY-05', 'DEMO-ENTITY-02'] },
      Vendor: { kind: 'text', operator: 'contains', value: 'north' },
      Reference: { kind: 'text', operator: 'equals', value: 'INV-9' },
      ReceivedDateTime: { kind: 'date', operator: 'between', from: '2026-07-01', to: '2026-07-20' },
      Value: { kind: 'number', operator: 'gte', value: '100' },
    },
  });
  const filter = params.get('$filter');
  assert.match(filter, /Entity eq 'DEMO-ENTITY-05' or Entity eq 'DEMO-ENTITY-02'/);
  assert.match(filter, /substringof\('north',Vendor\)/);
  assert.match(filter, /Reference eq 'INV-9'/);
  assert.match(filter, /Received_x0020_Date_x0020_Time ge/);
  assert.match(filter, /Received_x0020_Date_x0020_Time lt/);
  assert.match(filter, /Value ge 100/);
  assert.match(filter, /and/);
});

test('column-filter query state is part of SharePoint paging context and never slices a full list', async () => {
  const { createConfiguredCaseService } = await import('../../frontend/src/services/case-service.js');
  const calls = [];
  const service = createConfiguredCaseService({
    mode: 'sharepoint',
    verified: true,
    siteUrl: 'https://fixture.example.invalid/sites/DEMO',
    listTitle: 'Escalations',
  }, async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ value: [], '@odata.count': 0 }) };
  });
  await service.query({ page: 1, pageSize: 20, columnFilters: { Value: { kind: 'number', operator: 'gt', value: '10' } } });
  assert.equal(new URL(calls[0]).searchParams.get('$filter'), 'Value gt 10');
  assert.doesNotMatch(calls[0], /%24top=5000|snapshot|full/i);
});

test('Vendor Finder uses bounded ID-keyset supplier requests without threshold-unsafe substring filters', async () => {
  const { buildVendorReferenceQuery } = await import('../../frontend/src/services/sharepoint-client.js');
  assert.equal(typeof buildVendorReferenceQuery, 'function');
  const params = buildVendorReferenceQuery(500, 73);
  assert.equal(params.get('$orderby'), 'Id asc');
  assert.equal(params.get('$top'), '73');
  assert.match(params.get('$select'), /Vendor_x0020_Name/);
  assert.match(params.get('$select'), /Vendor_x0020_Category/);
  assert.equal(params.get('$filter'), 'Id gt 500');
  assert.doesNotMatch(params.toString(), /substringof/i);
});

test('one MERGE is followed by GET-only confirmation retries and an explicit readback retry', async () => {
  const { saveDraftWithReadback } = await import('../../frontend/src/ui/app.js');
  let updateCalls = 0;
  let readCalls = 0;
  let pendingError;
  try {
    await saveDraftWithReadback({
      service: {
        update: async () => { updateCalls += 1; return { __etag: 'W/"2"' }; },
        get: async () => {
          readCalls += 1;
          if (readCalls < 3) throw Object.assign(new Error('readback unavailable'), { status: 503 });
          return { WorkingNotes: 'confirmed', __etag: 'W/"3"' };
        },
      },
      id: 9,
      draft: { WorkingNotes: 'confirmed' },
      base: { WorkingNotes: '' },
      etag: 'W/"1"',
      maxRetries: 1,
      retryBaseDelay: 0,
    });
  } catch (error) {
    pendingError = error;
  }
  assert.equal(pendingError?.code, 'READBACK_UNCONFIRMED');
  assert.equal(updateCalls, 1);
  assert.equal(readCalls, 2);
  const confirmed = await pendingError.retryReadback();
  assert.equal(confirmed.WorkingNotes, 'confirmed');
  assert.equal(updateCalls, 1);
  assert.equal(readCalls, 3);
});

test('save pending state locks every editable control and prevents change events from re-enabling Save', () => {
  assert.match(editorSource, /setControlsDisabled/);
  assert.match(editorSource, /querySelectorAll\('\[data-field\], #vendor-search/);
  assert.match(editorSource, /if \(session\.savePending\) return/);
  assert.match(editorSource, /retry-readback/);
});

test('legacy autosave controller and autosave tests are removed from the explicit-save frontend', () => {
  assert.doesNotMatch(appSource, /createAutosaveController/);
  const workbenchSource = readFileSync(path.join(root, 'tests', 'frontend', 'workbench-v2.test.js'), 'utf8');
  assert.match(workbenchSource, /explicit editing changes draft only/);
  assert.doesNotMatch(workbenchSource, /createAutosaveController/);
});

test('Entity, Action Type and AP Owner remain real accessible selects', () => {
  assert.match(viewSource, /\['Status', 'Priority', 'ActionType', 'APOwner', 'Entity'\]\.includes\(field\)/);
  assert.doesNotMatch(uiSource, /<datalist\b/);
  assert.doesNotMatch(uiSource, /role="combobox"/);
});
