import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
const clone = (value) => structuredClone(value);

let crosswalk;
let importFailure;
try {
  crosswalk = await import('../../tools/source-repair-crosswalk.mjs');
} catch (error) {
  importFailure = error;
}

function compare(sourceDefinition, repairDefinition, slug = 'ingest-queue-west') {
  return crosswalk.compareFlowContracts({ slug, sourceDefinition, repairDefinition });
}

test('deep source-repair contract API is executable', () => {
  assert.equal(importFailure, undefined, importFailure?.message);
  assert.equal(typeof crosswalk?.compareFlowContracts, 'function');
  assert.equal(typeof crosswalk?.verifyRepairMapBindings, 'function');
});

test('canonical recurrence preserves Minute and only the exact deterministic startTime transform is allowed', () => {
  const canonical = readJson('flows/ingest-queue-west/definition.json');
  const sourceLike = clone(canonical);
  const sourceTrigger = sourceLike.properties.definition.triggers.Recurrence;
  sourceTrigger.recurrence.startTime = '2026-02-04T10:00:00.000Z';
  sourceTrigger.evaluatedRecurrence.startTime = '2026-02-04T10:00:00.000Z';
  const result = compare(sourceLike, canonical);
  assert.equal(result.equal, true, JSON.stringify(result.unauthorizedDifferences));
  assert.equal(result.authorizedDifferences.filter(({ category }) => category === 'deterministic-metadata-date').length, 2);
  assert.equal(canonical.properties.definition.triggers.Recurrence.recurrence.frequency, 'Minute');
  assert.equal(canonical.properties.definition.triggers.Recurrence.evaluatedRecurrence.frequency, 'Minute');
});

test('deep contract rejects trigger, action, branch, expression, runAfter, retry and output mutations', () => {
  const source = readJson('flows/ingest-queue-west/definition.json');
  const mutations = [
    ['frequency Minute to Hour', (document) => { document.properties.definition.triggers.Recurrence.recurrence.frequency = 'Hour'; }],
    ['interval', (document) => { document.properties.definition.triggers.Recurrence.recurrence.interval = 20; }],
    ['timeZone', (document) => { document.properties.definition.triggers.Recurrence.recurrence.timeZone = 'UTC'; }],
    ['startTime', (document) => { document.properties.definition.triggers.Recurrence.recurrence.startTime = '2026-01-15T00:01:00Z'; }],
    ['operationId', (document) => { document.properties.definition.actions.Within_UK_weekday_window.actions['Get_emails_(V3)'].inputs.host.operationId = 'GetEmailsV2'; }],
    ['action scalar', (document) => { document.properties.definition.actions.Within_UK_weekday_window.actions['Get_emails_(V3)'].inputs.parameters.top = 99; }],
    ['expression operator', (document) => { document.properties.definition.actions.Within_UK_weekday_window.expression = document.properties.definition.actions.Within_UK_weekday_window.expression.replace('greaterOrEquals', 'lessOrEquals'); }],
    ['branch', (document) => { delete document.properties.definition.actions.Within_UK_weekday_window.else; }],
    ['runAfter', (document) => { document.properties.definition.actions.Within_UK_weekday_window.runAfter = { Mutated: ['Succeeded'] }; }],
    ['retry', (document) => { document.properties.definition.actions.Within_UK_weekday_window.actions['Get_emails_(V3)'].runtimeConfiguration = { retryPolicy: { type: 'fixed', count: 2 } }; }],
    ['output', (document) => { document.properties.definition.outputs = { mutated: { type: 'string', value: 'changed' } }; }],
  ];
  for (const [name, mutate] of mutations) {
    const mutated = clone(source);
    mutate(mutated);
    const result = compare(source, mutated);
    assert.equal(result.equal, false, `${name} was accepted`);
    assert.ok(result.unauthorizedDifferences.length > 0, `${name} emitted no deep diff`);
  }
});

test('repair maps must resolve to the package resource graph', () => {
  const packageManifest = readJson('flows/bootstrap-lists/package-manifest.json');
  const apisMap = readJson('flows/bootstrap-lists/apis-map.json');
  const connectionsMap = readJson('flows/bootstrap-lists/connections-map.json');
  assert.deepEqual(crosswalk.verifyRepairMapBindings({
    flowId: '00000000-0000-4000-8000-000000005001',
    packageManifest,
    apisMap,
    connectionsMap,
  }), []);
  const mutated = clone(connectionsMap);
  mutated.shared_sharepointonline = '00000000-0000-4000-8000-000000009999';
  assert.ok(crosswalk.verifyRepairMapBindings({
    flowId: '00000000-0000-4000-8000-000000005001',
    packageManifest,
    apisMap,
    connectionsMap: mutated,
  }).length > 0);
});

test('real source archives map bijectively and pass deep contracts when source access is provided', {
  skip: !process.env.ESCALATION_BEHAVIOURAL_SOURCE_ROOT,
}, () => {
  const result = crosswalk.buildSourceRepairCrosswalk({
    sourceRoot: process.env.ESCALATION_BEHAVIOURAL_SOURCE_ROOT,
    repairRoot: root,
  });
  assert.equal(result.flowSource.flows.length, 12);
  assert.equal(new Set(result.flowSource.flows.map(({ sourceArchiveSha256 }) => sourceArchiveSha256)).size, 12);
  assert.equal(result.flowSource.flows.every(({ classification }) => classification === 'PRESERVED_DEEP_CONTRACT_WITH_AUTHORIZED_SANITIZATION'), true);
  assert.equal(result.allLocalCrosswalkGatesGreen, true, JSON.stringify(result.gates));
});
