import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const testScratch = path.resolve(process.env.ESCALATION_TEST_SCRATCH ?? tmpdir(), 'package-parity');
mkdirSync(testScratch, { recursive: true });
let parity;
let importFailure;

try {
  parity = await import('../../tools/flow-package-parity.mjs');
} catch (error) {
  importFailure = error;
}

test('package parity API is executable', () => {
  assert.equal(importFailure, undefined, importFailure?.message);
  assert.equal(typeof parity?.verifyAllPackageParity, 'function');
  assert.equal(typeof parity?.createPackageArchive, 'function');
});

test('all 12 ZIP packages deeply match their readable canonical assets', () => {
  assert.equal(typeof parity?.verifyAllPackageParity, 'function');
  const results = parity.verifyAllPackageParity(root);
  assert.equal(results.length, 12);
  assert.deepEqual(results.flatMap((result) => result.differences), []);
});

test('deep parity detects a nested metadata mutation at its JSON path', () => {
  assert.equal(typeof parity?.createPackageArchive, 'function');
  const slug = 'ingest-queue-west';
  const temporaryZip = path.join(testScratch, 'mutation-ingest-queue-west.zip');
  const definition = JSON.parse(readFileSync(path.join(root, 'flows', slug, 'definition.json'), 'utf8'));
  definition.properties.definition.actions.Within_UK_weekday_window.actions.Apply_to_each.actions
    .List_rows_present_in_a_table.metadata['FIXTURE-FILE-QUEUE-002'] = '/fixtures/mutated-placeholder';
  try {
    parity.createPackageArchive({ root, slug, outputPath: temporaryZip, overrides: { definition } });
    const result = parity.comparePackageToReadable(root, slug, { archivePath: temporaryZip });
    assert.equal(result.equal, false);
    assert.deepEqual(result.differences.map(({ entry, jsonPath }) => ({ entry, jsonPath })), [{
      entry: 'definition.json',
      jsonPath: '$.properties.definition.actions.Within_UK_weekday_window.actions.Apply_to_each.actions.List_rows_present_in_a_table.metadata.FIXTURE-FILE-QUEUE-002',
    }]);
  } finally {
    const resolvedZip = path.resolve(temporaryZip);
    assert.equal(resolvedZip.startsWith(`${testScratch}${path.sep}`), true);
    rmSync(resolvedZip, { force: true });
  }
});

test('canonical package generation is byte-deterministic with exact internal paths', () => {
  const slug = 'ingest-queue-west';
  const first = path.join(testScratch, 'deterministic-first.zip');
  const second = path.join(testScratch, 'deterministic-second.zip');
  try {
    const firstResult = parity.createPackageArchive({ root, slug, outputPath: first });
    const secondResult = parity.createPackageArchive({ root, slug, outputPath: second });
    const firstBytes = readFileSync(first);
    const secondBytes = readFileSync(second);
    assert.equal(createHash('sha256').update(firstBytes).digest('hex'), createHash('sha256').update(secondBytes).digest('hex'));
    assert.deepEqual([...parity.readZipEntries(first, { root }).keys()].sort(), [...firstResult.entries].sort());
    assert.deepEqual(firstResult.entries, secondResult.entries);
  } finally {
    rmSync(first, { force: true });
    rmSync(second, { force: true });
  }
});
