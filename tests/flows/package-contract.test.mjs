import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from '../../tools/flow-package-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
const index = readJson('flows/flow-index.json');
const validationManifest = readJson('manifests/flow-validation-manifest.json');
const packageContract = readJson('manifests/package-contract.json');
const expectedImportOrder = [
  'bootstrap-lists.zip',
  'add-columns-and-views.zip',
  'user-access-matrix.zip',
  'seed-vendors-01.zip',
  'seed-vendors-02.zip',
  'seed-cases-01.zip',
  'seed-cases-02.zip',
  'manual-move-trigger-test.zip',
  'ingest-queue-west.zip',
  'ingest-queue-north.zip',
  'ingest-queue-east.zip',
  'ingest-queue-south.zip',
];

function normalizeFlowId(value) {
  return String(value ?? '').split('/').filter(Boolean).at(-1);
}

test('package contract explicitly orders all 12 ZIPs exactly once', () => {
  assert.deepEqual(packageContract.importOrder, expectedImportOrder);
  assert.equal(new Set(packageContract.importOrder).size, 12);
  assert.deepEqual(
    [...index.flows.map(({ package: packagePath }) => path.posix.basename(packagePath))].sort(),
    [...expectedImportOrder].sort(),
  );
});

test('index, validation manifest, readable manifests, definitions, resources and ZIP paths share one flow ID', () => {
  const validationBySlug = new Map(validationManifest.flows.map((flow) => [flow.slug, flow]));
  for (const flow of index.flows) {
    const flowRoot = path.posix.dirname(flow.definition);
    const readableManifest = readJson(`${flowRoot}/flow-manifest.json`);
    const definition = readJson(flow.definition);
    const packageManifest = readJson(`${flowRoot}/package-manifest.json`);
    const packageFlowIds = Object.entries(packageManifest.resources)
      .filter(([, resource]) => resource.type === 'Microsoft.Flow/flows')
      .map(([flowId]) => flowId);
    const zipEntries = [...readZipEntries(path.join(root, flow.package), { root }).keys()];
    const zipDefinitionIds = zipEntries
      .map((entryPath) => /^Microsoft\.Flow\/flows\/([^/]+)\/definition\.json$/.exec(entryPath)?.[1])
      .filter(Boolean);
    const ids = [
      flow.flowId,
      validationBySlug.get(flow.slug)?.flowId,
      ...(readableManifest.flowAssets?.assetPaths ?? []),
      normalizeFlowId(definition.name),
      normalizeFlowId(definition.id),
      ...packageFlowIds,
      ...zipDefinitionIds,
    ];
    assert.equal(ids.length, 7, `${flow.slug}: seven ID surfaces`);
    assert.deepEqual(new Set(ids), new Set([flow.flowId]), `${flow.slug}: ${JSON.stringify(ids)}`);
  }
});

test('every required manual binding has an actionable instruction and a verifiable occurrence', () => {
  assert.ok(Array.isArray(packageContract.requiredManualBindings));
  assert.equal(packageContract.requiredManualBindings.length >= 8, true);
  assert.equal(new Set(packageContract.requiredManualBindings).size, packageContract.requiredManualBindings.length);
  for (const bindingKey of packageContract.requiredManualBindings) {
    const binding = packageContract.bindingInstructions?.[bindingKey];
    assert.equal(typeof binding?.instruction, 'string', `${bindingKey}: instruction`);
    assert.equal(binding.instruction.length >= 24, true, `${bindingKey}: actionable instruction`);
    assert.equal(Array.isArray(binding.placeholders) && binding.placeholders.length > 0, true, `${bindingKey}: placeholders`);
    assert.equal(Array.isArray(binding.occurrencePaths) && binding.occurrencePaths.length > 0, true, `${bindingKey}: occurrence paths`);
    for (const occurrencePath of binding.occurrencePaths) {
      assert.equal(path.isAbsolute(occurrencePath), false, `${bindingKey}: relative occurrence path`);
      const content = readFileSync(path.join(root, occurrencePath), 'utf8');
      assert.equal(binding.placeholders.some((placeholder) => content.includes(placeholder)), true, `${bindingKey}: ${occurrencePath} contains a placeholder`);
    }
  }
});
