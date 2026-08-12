import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_FIELD_MAPPING, GOVERNED_VALUES } from '../../frontend/src/config/runtime-config.example.js';
import * as statusPolicy from '../../frontend/src/domain/status-policy.js';
import { londonCalendarDate } from '../../frontend/src/domain/sharepoint-calendar-date.js';
import { createCaseService, STATUS_VALUES } from '../../frontend/src/services/case-service.js';
import { buildEscalationCsv } from '../../frontend/src/services/csv-export.js';
import { buildEscalationQuery, EDITABLE_FIELDS, UI_READ_FIELDS } from '../../frontend/src/services/sharepoint-query.js';
import { deriveStatusFilter } from '../../frontend/src/ui/app.js';
import * as saveController from '../../frontend/src/ui/save-controller.js';
import { renderCaseDetail, renderTable, renderTableHeader } from '../../frontend/src/ui/workbench-view.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const statuses = ['Action Required', 'In Progress', 'Closed', 'Duplicate'];

function sha256(relativePath) {
  return createHash('sha256').update(readFileSync(path.join(root, relativePath))).digest('hex').toUpperCase();
}

test('Duplicate contract exposes exactly four governed and writable statuses', () => {
  assert.deepEqual([...GOVERNED_VALUES.Status], statuses);
  assert.deepEqual([...STATUS_VALUES], statuses);
  const schema = JSON.parse(readFileSync(path.join(root, 'manifests', 'schema.json'), 'utf8'));
  assert.deepEqual(schema.choiceFields.Status, statuses);
});

test('Open and Closed membership is explicit and unknown statuses are All-only', () => {
  assert.equal(statusPolicy.isOpenStatus('Action Required'), true);
  assert.equal(statusPolicy.isOpenStatus('In Progress'), true);
  assert.equal(statusPolicy.isOpenStatus('Closed'), false);
  assert.equal(statusPolicy.isOpenStatus('Duplicate'), false);
  assert.equal(statusPolicy.isOpenStatus('Future Status'), false);
  assert.equal(statusPolicy.isClosedStatus('Closed'), true);
  assert.equal(statusPolicy.isClosedStatus('Duplicate'), true);
  assert.equal(statusPolicy.isClosedStatus('Future Status'), false);
  assert.equal(statusPolicy.matchesStatusView('Future Status', 'All'), true);
  assert.equal(statusPolicy.matchesStatusView('Future Status', 'Open'), false);
  assert.equal(statusPolicy.matchesStatusView('Future Status', 'Closed'), false);
});

test('SharePoint Open and Closed OData use exact membership and four choices remove the status filter', () => {
  const open = buildEscalationQuery({ status: 'Open' }).get('$filter');
  const closed = buildEscalationQuery({ status: 'Closed' }).get('$filter');
  assert.match(open, /Status eq 'Action Required'/);
  assert.match(open, /Status eq 'In Progress'/);
  assert.doesNotMatch(open, / ne /);
  assert.match(closed, /Status eq 'Closed'/);
  assert.match(closed, /Status eq 'Duplicate'/);
  assert.equal(buildEscalationQuery({ statuses }).has('$filter'), false);
});

test('Duplicate bypasses the ordinary seven required fields while Status remains governed', () => {
  assert.deepEqual(saveController.missingRequiredFields({ Status: 'Duplicate' }), []);
  assert.deepEqual(saveController.missingRequiredFields({ Status: 'Unknown' }), ['ActionType', 'Status', 'Priority', 'WorkingNotes', 'DateResolved', 'APOwner', 'Entity']);
});

test('Duplicate transition confirms without writing and stages London resolution fields', () => {
  assert.equal(typeof saveController.planStatusTransition, 'function');
  const confirmations = [];
  const base = { id: 7, ReceivedDateTime: '2026-07-20T08:00:00Z', Status: 'Action Required', WorkingNotes: '', DateResolved: '', DaysToResolve: null, IsClosed: false };
  const result = saveController.planStatusTransition({
    base,
    draft: { ...base },
    nextStatus: 'Duplicate',
    now: new Date('2026-07-22T23:30:00Z'),
    confirm: (message) => { confirmations.push(message); return true; },
  });
  assert.equal(confirmations[0], 'Mark ESC-2026-000007 as Duplicate? It will leave Open and appear in Closed.');
  assert.equal(result.accepted, true);
  assert.equal(result.draft.Status, 'Duplicate');
  assert.equal(result.draft.WorkingNotes, 'Duplicate');
  assert.equal(result.draft.DateResolved, '2026-07-22T23:30:00.000Z');
  assert.equal(londonCalendarDate(result.draft.DateResolved), '2026-07-23');
  assert.equal(result.draft.DaysToResolve, 3);
  assert.equal(result.draft.IsClosed, true);
  assert.deepEqual(saveController.buildMinimalPatch(result.draft, base), {
    Status: 'Duplicate',
    WorkingNotes: 'Duplicate',
    DateResolved: '2026-07-22T23:30:00.000Z',
    DaysToResolve: 3,
    IsClosed: true,
  });
  assert.equal('write' in result, false, 'confirmation/staging must not write');
});

test('Duplicate note preserves content, appends once, and cancellation/leave restores unsaved values', () => {
  assert.equal(typeof saveController.planStatusTransition, 'function');
  const base = { id: 8, ReceivedDateTime: '2026-07-20', Status: 'In Progress', WorkingNotes: 'Investigated', DateResolved: '', DaysToResolve: null, IsClosed: false };
  const cancelled = saveController.planStatusTransition({ base, draft: { ...base }, nextStatus: 'Duplicate', now: new Date('2026-07-22T09:00:00Z'), confirm: () => false });
  assert.deepEqual(cancelled.draft, base);
  const staged = saveController.planStatusTransition({ base, draft: { ...base }, nextStatus: 'Duplicate', now: new Date('2026-07-22T09:00:00Z'), confirm: () => true });
  assert.equal(staged.draft.WorkingNotes, 'Investigated\nDuplicate');
  const left = saveController.planStatusTransition({ base, draft: staged.draft, duplicateSnapshot: staged.duplicateSnapshot, nextStatus: 'In Progress', confirm: () => true });
  assert.equal(left.draft.WorkingNotes, 'Investigated');
  assert.equal(left.draft.DateResolved, '');
  const restaged = saveController.planStatusTransition({ base: { ...base, WorkingNotes: 'Investigated\nDuplicate' }, draft: { ...base, WorkingNotes: 'Investigated\nDuplicate' }, nextStatus: 'Duplicate', now: new Date('2026-07-22T10:00:00Z'), confirm: () => true });
  assert.equal(restaged.draft.WorkingNotes, 'Investigated\nDuplicate');
});

test('Reopening Closed or Duplicate confirms, clears terminal fields, and preserves notes', () => {
  assert.equal(typeof saveController.planStatusTransition, 'function');
  const base = { id: 9, ReceivedDateTime: '2026-07-18', Status: 'Duplicate', WorkingNotes: 'Original\nDuplicate', DateResolved: '2026-07-22T09:00:00Z', DaysToResolve: 2, IsClosed: true };
  const confirmations = [];
  const reopened = saveController.planStatusTransition({ base, draft: { ...base }, nextStatus: 'Action Required', confirm: (message) => { confirmations.push(message); return true; } });
  assert.match(confirmations[0], /^Reopen ESC-2026-000009\?/);
  assert.equal(reopened.draft.Status, 'Action Required');
  assert.equal(reopened.draft.DateResolved, '');
  assert.equal(reopened.draft.DaysToResolve, null);
  assert.equal(reopened.draft.IsClosed, false);
  assert.equal(reopened.draft.WorkingNotes, 'Original\nDuplicate');
});

test('safe terminal fields use confirmed local EntityPropertyName mappings', () => {
  assert.equal(DEFAULT_FIELD_MAPPING.IsClosed, 'Is_x0020_Closed');
  assert.equal(DEFAULT_FIELD_MAPPING.DaysToResolve, 'Days_x0020_To_x0020_Resolve');
  assert.ok(EDITABLE_FIELDS.includes('IsClosed'));
  assert.ok(EDITABLE_FIELDS.includes('DaysToResolve'));
  assert.ok(UI_READ_FIELDS.includes('IsClosed'));
});

test('Duplicate badge and native status control are neutral, labelled and keyboard reachable', () => {
  const item = { id: 10, ReceivedDateTime: '2026-07-22', Status: 'Duplicate', __etag: 'W/"10"', __editHydrationStatus: 'ready' };
  const row = renderTable([item], 10);
  const detail = renderCaseDetail(item, [item], { governedValues: { ...GOVERNED_VALUES } });
  assert.match(row, /status-duplicate/);
  assert.match(row, /aria-label="Duplicate status"/);
  assert.match(detail, /<select[^>]+data-field="Status"/);
  assert.match(detail, />Duplicate<\/option>/);
  assert.doesNotMatch(detail, /data-field="WorkingNotes"[^>]+aria-required="true"/);

  const listeners = new Map();
  const control = {
    tagName: 'SELECT',
    dataset: { field: 'Status' },
    value: 'Duplicate',
    disabled: false,
    addEventListener: (event, listener) => listeners.set(event, listener),
    removeEventListener: (event) => listeners.delete(event),
  };
  let keyboardTransition = null;
  saveController.bindEditableControl(control, {
    getItem: () => item,
    setItem: () => {},
    draft: { change: () => {} },
    governedValues: GOVERNED_VALUES,
    onStatusTransition: (transition) => { keyboardTransition = transition; },
  });
  listeners.get('change')();
  assert.equal(keyboardTransition.value, 'Duplicate', 'native keyboard selection reaches the same confirmation/staging path');
});

test('four-choice Status menu, tabs, column filters, CSV, pagination and KPIs share membership', () => {
  const rows = [
    { id: 1, ReceivedDateTime: '2026-07-18', Status: 'Action Required', WorkingNotes: '' },
    { id: 2, ReceivedDateTime: '2026-07-17', Status: 'In Progress', WorkingNotes: '' },
    { id: 3, ReceivedDateTime: '2026-07-16', Status: 'Closed', WorkingNotes: '' },
    { id: 4, ReceivedDateTime: '2026-07-15', Status: 'Duplicate', WorkingNotes: 'Duplicate' },
    { id: 5, ReceivedDateTime: '2026-07-14', Status: 'Future Status', WorkingNotes: '' },
  ];
  const header = renderTableHeader(rows, { governedValues: GOVERNED_VALUES }, {});
  const statusMenu = header.match(/data-column-filter-menu="Status"[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
  assert.equal((statusMenu.match(/type="checkbox"/g) ?? []).length, 4);
  assert.deepEqual(deriveStatusFilter(statuses), { status: 'All', statuses });
  assert.deepEqual(deriveStatusFilter(['Closed', 'Duplicate']), { status: 'Closed', statuses: ['Closed', 'Duplicate'] });
  const service = createCaseService(rows);
  assert.deepEqual(service.query({ status: 'Open', page: 1, pageSize: 10 }).items.map((row) => row.id), [1, 2]);
  assert.deepEqual(service.query({ status: 'Closed', page: 1, pageSize: 1 }), { items: [service.get(3)], page: 1, pageSize: 1, total: 2, hasNext: true });
  assert.deepEqual(service.query({ status: 'All', page: 1, pageSize: 10 }).items.map((row) => row.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(service.query({ status: 'All', statuses: ['Duplicate'], page: 1, pageSize: 10 }).items.map((row) => row.id), [4]);
  const kpis = service.counts();
  assert.equal(kpis.open, 2);
  assert.equal(kpis.closed, 2);
  assert.equal(kpis.oldestOpen.id, 2);
  assert.match(buildEscalationCsv([rows[3]]), /Duplicate/);
});

test('sanitized recurrence flow package archives are present and readable', () => {
  for (const file of ['ingest-queue-west.zip', 'ingest-queue-north.zip', 'ingest-queue-east.zip', 'ingest-queue-south.zip']) {
    assert.equal(existsSync(path.join(root, 'packages', file)), true, file);
    assert.ok(sha256(`packages/${file}`).length === 64, file);
  }
});

test('sanitized launcher/build paths are explicit and bootstrap definition remains present', () => {
  const launcher = readFileSync(path.join(root, 'frontend', 'launcher', 'escalation-launcher.js'), 'utf8');
  const webpack = readFileSync(path.join(root, 'frontend', 'webpack.config.cjs'), 'utf8');
  assert.match(launcher, /new URL\("\."/);
  assert.match(launcher, /assets\/app\.js/);
  assert.match(webpack, /filename:\s*'assets\/app\.js'/);
  assert.equal(existsSync(path.join(root, 'packages', 'bootstrap-lists.zip')), true);
  assert.match(readFileSync(path.join(root, 'flows', 'bootstrap-lists', 'definition.json'), 'utf8'), /Initialize_list_definitions/);
});
