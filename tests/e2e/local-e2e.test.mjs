import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalE2E } from '../../tools/local-e2e.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const goldenCsvBytes = readFileSync(path.join(root, 'tests', 'e2e', 'fixtures', 'local-export.golden.csv'));
const goldenCsv = goldenCsvBytes.toString('utf8');
const GOLDEN_CSV_SHA256 = '9cc9eb542919d45936b1d82aa53b87afaa754f3aa4eb6106619d8afbad241693';

test('deterministic local path runs bootstrap, ETL, query, dashboard, export, and handoff', async () => {
  const result = await runLocalE2E();
  assert.equal(result.mode, 'local-e2e-mock');
  assert.equal(result.tenantCalls, 0);
  assert.deepEqual(result.sequence, [
    'bootstrap-lists', 'add-columns-and-views', 'user-access-matrix',
    'seed-cases-01', 'seed-cases-02', 'seed-vendors-01', 'seed-vendors-02',
    'manual-move-trigger-test', 'ingest-queue-west', 'ingest-queue-north',
    'ingest-queue-east', 'ingest-queue-south', 'dashboard-query', 'open-query',
    'csv-export', 'handoff-output',
  ]);
  assert.equal(result.storage.cases, 7);
  assert.equal(result.storage.vendors, 3);
  assert.equal(result.storage.etlRows, 4);
  assert.equal(result.storage.flowExecutions, 12);
  assert.equal(result.dashboard.total, 7);
  assert.equal(result.dashboard.openTotal, 6);
  assert.equal(result.handoff.rowCount, 7);
  assert.equal(result.handoff.utf8Bom, true);
  assert.equal(result.flowResults.filter((flow) => flow.status === 'LOCAL_MOCK_GREEN').length, 12);
  assert.equal(result.externalGates.tenantImport, 'RED_EXTERNAL_GATE');
  assert.equal(result.externalGates.tenantReadback, 'RED_EXTERNAL_GATE');
  assert.equal(result.externalGates.authenticatedUat, 'RED_EXTERNAL_GATE');
});

test('local ETL validation and deduplication stay deterministic', async () => {
  const first = await runLocalE2E();
  const second = await runLocalE2E();
  assert.deepEqual(first.storage, second.storage);
  assert.deepEqual(first.dashboard, second.dashboard);
  assert.deepEqual(first.query, second.query);
});

test('explicit deterministicNow produces golden-identical CSV bytes across different wall-clock dates', async () => {
  const deterministicNow = '2026-01-15T12:00:00Z';
  const first = await runLocalE2E({
    deterministicNow,
    clock: () => new Date('2026-02-01T00:00:00Z'),
    includeCsv: true,
  });
  const second = await runLocalE2E({
    deterministicNow,
    clock: () => new Date('2031-09-30T23:59:59Z'),
    includeCsv: true,
  });
  assert.notEqual(first.observedWallClock, second.observedWallClock);
  assert.equal(first.csv, second.csv);
  assert.deepEqual(Buffer.from(first.csv, 'utf8'), goldenCsvBytes);
  assert.equal(first.csv, goldenCsv);
  assert.equal(createHash('sha256').update(goldenCsvBytes).digest('hex'), GOLDEN_CSV_SHA256);
  assert.equal(first.handoff.csvSha256, GOLDEN_CSV_SHA256);
  assert.equal(second.handoff.csvSha256, GOLDEN_CSV_SHA256);
});

test('definition mutation changes exported state instead of being masked by preloaded expected data', async () => {
  const definitionPath = path.join(root, 'flows', 'seed-cases-01', 'definition.json');
  const mutated = JSON.parse(readFileSync(definitionPath, 'utf8'));
  mutated.properties.definition.actions.Initialize_seed_payload.inputs.variables[0].value.records[0][20] = 'Fixture Owner 99';
  const result = await runLocalE2E({
    includeCsv: true,
    definitionOverrides: new Map([['seed-cases-01', mutated]]),
  });
  assert.match(result.csv, /Fixture Owner 99/u);
  assert.equal(result.storage.flowExecutions, 12);
  assert.equal(result.storage.connectorEffects > 0, true);
});
