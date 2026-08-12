import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const appSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'app.js'), 'utf8');
const viewSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'workbench-view.js'), 'utf8');
const editorSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'editor-workflow.js'), 'utf8');
const vendorControllerSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'vendor-finder-controller.js'), 'utf8');
const source = `${appSource}\n${viewSource}\n${editorSource}\n${vendorControllerSource}`;

test('approved workbench has the full dashboard composition', () => {
  for (const landmark of ['kpi-open', 'kpi-closed', 'kpi-oldest-open', 'kpi-critical', 'kpi-vendor-unmatched', 'case-table', 'detail-panel', 'activity-panel']) {
    assert.match(source, new RegExp(`(?:id|data-testid)=["']${landmark}["']`), `missing v2 landmark ${landmark}`);
  }
  assert.match(source, /class="workbench-layout"/);
  assert.doesNotMatch(source, /id="filter-rail"/);
  assert.match(source, /header-filter-toggle/);
  assert.match(source, /filter-funnel/);
  assert.match(source, /<table\b/);
  assert.match(source, /Source Queue/);
  assert.match(source, /Vendor Name/);
  assert.match(source, /Action Type/);
  assert.match(source, /Entity/);
});

test('editable workflow fields use native accessible selects and explicit Save only', () => {
  assert.match(source, /\['Status', 'Priority', 'ActionType', 'APOwner', 'Entity'\]\.includes\(field\)/);
  assert.match(source, /data-field="\$\{field\}"/);
  assert.match(source, /<select[^>]+data-field="\$\{field\}"/);
  assert.doesNotMatch(source, /<datalist\b/);
  assert.doesNotMatch(source, /role="combobox"/);
  assert.match(source, /id="save-case"/);
  assert.match(source, /id="discard-changes"/);
  assert.match(source, /ETAG_CONFLICT/);
});

test('header filters expose the full Excel business set and supported operators', () => {
  assert.match(source, /TABLE_COLUMNS = Object\.freeze\(\[/);
  assert.equal((viewSource.match(/\['[A-Za-z]+', '[^']+'\]/g) ?? []).filter((value) => value.includes(',')).length >= 22, true);
  assert.match(source, /data-column-filter-toggle/);
  assert.match(source, /data-column-filter-menu/);
  assert.match(source, /Select all/);
  assert.match(source, /Clear filter/);
  assert.match(source, /contains/);
  assert.match(source, /equals/);
  assert.match(source, /between/);
  assert.match(source, /aria-haspopup="dialog"/);
});

test('vendor lookup states and page-size boundaries remain visible', () => {
  assert.match(source, /id="vendor-lookup-state"/);
  assert.match(source, /Vendor lookup pending/);
  assert.match(source, /No vendor match found/);
  assert.match(source, /Vendor lookup error/);
  assert.match(source, /Confirmed vendor values are staged in the draft/);
  assert.equal((source.match(/<option value="(?:10|20|50)">/g) ?? []).length, 3);
  assert.match(source, /id="previous-page"/);
  assert.match(source, /id="next-page"/);
  assert.match(source, /nextLink|hasNext/);
});

test('governed catalogs and unknown-value preservation match the approved contract', async () => {
  const { GOVERNED_VALUES } = await import('../../frontend/src/config/runtime-config.example.js');
  const { createDetailChoices } = await import('../../frontend/src/ui/app.js');
  assert.deepEqual(GOVERNED_VALUES.Status, ['Action Required', 'In Progress', 'Closed', 'Duplicate']);
  assert.deepEqual(GOVERNED_VALUES.Priority, ['Critical', 'High', 'Medium', 'Low']);
  assert.equal(GOVERNED_VALUES.ActionType.length, 15);
  assert.equal(GOVERNED_VALUES.Entity.length, 12);
  assert.equal(GOVERNED_VALUES.APOwner.length, 8);
  assert.ok(GOVERNED_VALUES.ActionType.includes('Waiting approval'));
  assert.ok(!GOVERNED_VALUES.APOwner.includes('Awaiting Approval'));
  assert.deepEqual(createDetailChoices([{ ActionType: 'Legacy value' }], 'ActionType', 'Legacy value', GOVERNED_VALUES.ActionType).slice(0, 1), ['Legacy value']);
});

test('explicit editing changes draft only and Save sends one minimal payload', async () => {
  const { createExplicitSaveController, saveDraftWithReadback, validateDraftForSave } = await import('../../frontend/src/ui/app.js');
  const calls = [];
  const editor = createExplicitSaveController({ item: { id: 9, Status: 'Action Required', WorkingNotes: '', __etag: 'W/"1"' } });
  editor.change('WorkingNotes', 'first note');
  editor.change('Priority', 'High');
  assert.deepEqual(calls, []);
  assert.deepEqual(editor.getPatch(), { WorkingNotes: 'first note', Priority: 'High' });
  const result = await saveDraftWithReadback({
    service: {
      update: async (id, patch, etag) => { calls.push(['update', id, patch, etag]); return { __etag: 'W/"2"' }; },
      get: async (id) => { calls.push(['get', id]); return { WorkingNotes: 'first note', Priority: 'High', __etag: 'W/"3"' }; },
    },
    id: 9,
    draft: editor.getDraft(),
    base: editor.getBase(),
    etag: editor.getEtag(),
  });
  assert.deepEqual(result.patch, { WorkingNotes: 'first note', Priority: 'High' });
  assert.deepEqual(calls, [['update', 9, { WorkingNotes: 'first note', Priority: 'High' }, 'W/"1"'], ['get', 9]]);
  editor.markSaved(result.item, result.item.__etag);
  assert.equal(editor.isDirty(), false);
  assert.equal(validateDraftForSave({ draft: { Status: 'Action Required' } }), false);
});

test('all seven required fields block a save before any update request', async () => {
  const { saveDraftWithReadback, validateDraftForSave } = await import('../../frontend/src/ui/app.js');
  const complete = { ActionType: 'Reminder', Status: 'Closed', Priority: 'High', WorkingNotes: 'note', DateResolved: '2026-07-20', APOwner: 'Fixture Owner 01', Entity: 'DEMO-ENTITY-05' };
  for (const field of ['ActionType', 'Status', 'Priority', 'WorkingNotes', 'DateResolved', 'APOwner', 'Entity']) {
    const draft = { ...complete, [field]: '' };
    const errors = [];
    assert.equal(validateDraftForSave({ draft, onInvalid: (message, invalidField) => errors.push({ message, invalidField }) }), false, field);
    assert.equal(errors[0].invalidField, field);
    let updates = 0;
    await assert.rejects(Promise.resolve().then(() => {
      if (!validateDraftForSave({ draft })) throw Object.assign(new Error('validation failed'), { code: 'VALIDATION_FAILED' });
      return saveDraftWithReadback({ service: { update: async () => { updates += 1; }, get: async () => ({}) }, id: 1, draft, base: complete, etag: 'W/"1"' });
    }), (error) => error.code === 'VALIDATION_FAILED');
    assert.equal(updates, 0, `${field} must block update`);
  }
  assert.equal(validateDraftForSave({ draft: complete }), true);
});

test('readback confirmation is mandatory and 412 preserves pending draft', async () => {
  const { createExplicitSaveController, saveDraftWithReadback } = await import('../../frontend/src/ui/app.js');
  const editor = createExplicitSaveController({ item: { id: 4, WorkingNotes: 'old', __etag: 'W/"4-1"' } });
  editor.change('WorkingNotes', 'new');
  let updateCalls = 0;
  const conflict = Object.assign(new Error('Edit conflict'), { code: 'ETAG_CONFLICT', status: 412 });
  await assert.rejects(saveDraftWithReadback({ service: { update: async () => { updateCalls += 1; throw conflict; }, get: async () => ({}) }, id: 4, draft: editor.getDraft(), base: editor.getBase(), etag: editor.getEtag() }), (error) => error.code === 'ETAG_CONFLICT');
  assert.equal(updateCalls, 1);
  assert.deepEqual(editor.getPatch(), { WorkingNotes: 'new' });
});

test('five users update different items independently while stale same-item edit conflicts', async () => {
  const { createExplicitSaveController, saveDraftWithReadback } = await import('../../frontend/src/ui/app.js');
  const server = new Map(Array.from({ length: 5 }, (_, index) => [String(index + 1), { id: index + 1, WorkingNotes: '', __etag: `W/"${index + 1}-1"` }]));
  const revisions = new Map(Array.from({ length: 5 }, (_, index) => [String(index + 1), 1]));
  const save = async (id, patch, etag) => {
    const current = server.get(String(id));
    if (current.__etag !== etag) throw Object.assign(new Error('Edit conflict'), { code: 'ETAG_CONFLICT', status: 412 });
    const revision = revisions.get(String(id)) + 1;
    revisions.set(String(id), revision);
    const next = { ...current, ...patch, __etag: `W/"${id}-${revision}"` };
    server.set(String(id), next);
    return next;
  };
  assert.doesNotMatch(save.toString(), /Date\.now/, 'fixture ETags must advance deterministically');
  const editors = Array.from({ length: 5 }, (_, index) => createExplicitSaveController({ item: server.get(String(index + 1)) }));
  editors.forEach((editor, index) => editor.change('WorkingNotes', `user-${index + 1}`));
  await Promise.all(editors.map((editor, index) => saveDraftWithReadback({ service: { update: (id, patch, etag) => save(id, patch, etag), get: async (id) => server.get(String(id)) }, id: index + 1, draft: editor.getDraft(), base: editor.getBase(), etag: editor.getEtag() })));
  assert.deepEqual([...server.values()].map((item) => item.WorkingNotes), ['user-1', 'user-2', 'user-3', 'user-4', 'user-5']);
  const stale = createExplicitSaveController({ item: server.get('1') });
  const winner = createExplicitSaveController({ item: server.get('1') });
  assert.equal(stale.getEtag(), winner.getEtag(), 'both controllers must capture the same pre-winner ETag');
  const staleEtag = stale.getEtag();
  stale.change('WorkingNotes', 'stale');
  winner.change('WorkingNotes', 'winner');
  await saveDraftWithReadback({ service: { update: (id, patch, etag) => save(id, patch, etag), get: async (id) => server.get(String(id)) }, id: 1, draft: winner.getDraft(), base: winner.getBase(), etag: winner.getEtag() });
  assert.notEqual(server.get('1').__etag, staleEtag, 'winner save must advance the server ETag before stale save');
  await assert.rejects(saveDraftWithReadback({ service: { update: (id, patch, etag) => save(id, patch, etag), get: async (id) => server.get(String(id)) }, id: 1, draft: stale.getDraft(), base: stale.getBase(), etag: stale.getEtag() }), (error) => error.code === 'ETAG_CONFLICT');
});
