import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalMock } from '../../tools/flow-mock-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (relativePath, base = root) => JSON.parse(readFileSync(path.join(base, relativePath), 'utf8'));
const index = readJson('flows/flow-index.json');
const expectedActionCounts = {
  'bootstrap-lists': 6,
  'add-columns-and-views': 9,
  'user-access-matrix': 28,
  'seed-cases-01': 7,
  'seed-cases-02': 7,
  'seed-vendors-01': 7,
  'seed-vendors-02': 7,
  'manual-move-trigger-test': 2,
  'ingest-queue-west': 11,
  'ingest-queue-north': 11,
  'ingest-queue-east': 11,
  'ingest-queue-south': 11,
};

test('flow index inventories 12 readable definitions and keeps every external gate RED', () => {
  assert.equal(index.flowCount, 12);
  assert.equal(index.flows.length, 12);
  assert.equal(new Set(index.flows.map(({ slug }) => slug)).size, 12);
  for (const flow of index.flows) {
    assert.ok(readJson(flow.definition)?.properties?.definition, `${flow.slug} definition missing`);
    assert.equal(flow.externalGates.tenantImport, 'RED_EXTERNAL_GATE');
    assert.equal(flow.externalGates.tenantReadback, 'RED_EXTERNAL_GATE');
    assert.equal(flow.externalGates.authenticatedUat, 'RED_EXTERNAL_GATE');
  }
});

test('local runner reports one independent definition execution per flow', () => {
  const results = runLocalMock();
  assert.equal(results.length, 12);
  for (const result of results) {
    assert.equal(result.status, 'LOCAL_MOCK_GREEN', `${result.flow}: wrapper status`);
    assert.equal(result.validationMode, 'definition-execution', `${result.flow}: validation mode`);
    assert.equal(result.executionStatus, 'Succeeded', `${result.flow}: execution status`);
    assert.equal(result.actionCount, expectedActionCounts[result.flow], `${result.flow}: action count`);
    assert.equal(result.tenantCalls, 0, `${result.flow}: tenant calls`);
    assert.equal(result.externalGates.tenantImport, 'RED_EXTERNAL_GATE');
  }
});

test('definition mutation changes execution even when index contracts are removed', () => {
  const mutationRoot = path.join(path.dirname(root), 'mutation-flow-runner-root');
  mkdirSync(mutationRoot, { recursive: true });
  try {
    cpSync(path.join(root, 'flows'), path.join(mutationRoot, 'flows'), { recursive: true });
    cpSync(path.join(root, 'fixtures'), path.join(mutationRoot, 'fixtures'), { recursive: true });
    const mutatedIndex = readJson('flows/flow-index.json', mutationRoot);
    for (const flow of mutatedIndex.flows) {
      delete flow.sourceContract;
      delete flow.sanitizedContract;
      delete flow.contractPreserved;
    }
    writeFileSync(path.join(mutationRoot, 'flows', 'flow-index.json'), `${JSON.stringify(mutatedIndex, null, 2)}\n`, 'utf8');
    const definitionPath = path.join(mutationRoot, 'flows', 'manual-move-trigger-test', 'definition.json');
    const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
    definition.properties.definition.actions.Compose_MOVE_TRIGGER_TEST_RECEIVED.inputs = 'MUTATED_DEFINITION_OUTPUT';
    writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, 'utf8');
    const result = runLocalMock({ root: mutationRoot }).find(({ flow }) => flow === 'manual-move-trigger-test');
    assert.equal(result.outputs.Compose_MOVE_TRIGGER_TEST_RECEIVED, 'MUTATED_DEFINITION_OUTPUT');
    assert.equal(result.status, 'LOCAL_MOCK_GREEN');
  } finally {
    const resolvedMutationRoot = path.resolve(mutationRoot);
    assert.equal(resolvedMutationRoot.startsWith(`${path.resolve(path.dirname(root))}${path.sep}`), true);
    rmSync(resolvedMutationRoot, { recursive: true, force: true });
  }
});
