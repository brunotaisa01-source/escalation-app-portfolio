import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

function loadFflate(root) {
  const requireFromFrontend = createRequire(path.join(path.resolve(root), 'frontend', 'package.json'));
  return requireFromFrontend('fflate');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function assetDescriptor(root, slug) {
  const flowRoot = path.join(path.resolve(root), 'flows', slug);
  const flowManifest = readJson(path.join(flowRoot, 'flow-manifest.json'));
  const assetPaths = flowManifest?.flowAssets?.assetPaths;
  if (!Array.isArray(assetPaths) || assetPaths.length !== 1 || typeof assetPaths[0] !== 'string') {
    throw new Error(`${slug}: flow-manifest.json must declare exactly one asset path`);
  }
  const flowId = assetPaths[0];
  return {
    flowId,
    entries: [
      { logicalName: 'manifest.json', zipPath: 'manifest.json', readablePath: path.join(flowRoot, 'package-manifest.json') },
      { logicalName: 'flow-manifest.json', zipPath: 'Microsoft.Flow/flows/manifest.json', readablePath: path.join(flowRoot, 'flow-manifest.json') },
      { logicalName: 'definition.json', zipPath: `Microsoft.Flow/flows/${flowId}/definition.json`, readablePath: path.join(flowRoot, 'definition.json') },
      { logicalName: 'apisMap.json', zipPath: `Microsoft.Flow/flows/${flowId}/apisMap.json`, readablePath: path.join(flowRoot, 'apis-map.json') },
      { logicalName: 'connectionsMap.json', zipPath: `Microsoft.Flow/flows/${flowId}/connectionsMap.json`, readablePath: path.join(flowRoot, 'connections-map.json') },
    ],
  };
}

export function readZipEntries(zipPath, { root = path.resolve(path.dirname(zipPath), '..') } = {}) {
  const { unzipSync } = loadFflate(root);
  const archive = unzipSync(new Uint8Array(readFileSync(zipPath)));
  return new Map(Object.entries(archive).map(([entryPath, bytes]) => [entryPath, Buffer.from(bytes)]));
}

function jsonPath(parent, key) {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`;
}

function collectDifferences(expected, actual, currentPath = '$', output = []) {
  if (Object.is(expected, actual)) return output;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      output.push({ jsonPath: currentPath, expected, actual });
      return output;
    }
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferences(expected[index], actual[index], jsonPath(currentPath, index), output);
    }
    return output;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) collectDifferences(expected[key], actual[key], jsonPath(currentPath, key), output);
    return output;
  }
  output.push({ jsonPath: currentPath, expected, actual });
  return output;
}

export function comparePackageToReadable(root, slug, { archivePath = path.join(root, 'packages', `${slug}.zip`) } = {}) {
  const descriptor = assetDescriptor(root, slug);
  const archiveEntries = readZipEntries(archivePath, { root });
  const expectedPaths = descriptor.entries.map(({ zipPath }) => zipPath).sort();
  const actualPaths = [...archiveEntries.keys()].filter((entryPath) => !entryPath.endsWith('/')).sort();
  const differences = [];
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    differences.push({ entry: '<archive>', jsonPath: '$entries', expected: expectedPaths, actual: actualPaths });
  }
  for (const entry of descriptor.entries) {
    const bytes = archiveEntries.get(entry.zipPath);
    if (!bytes) continue;
    let actual;
    let expected;
    try {
      actual = JSON.parse(bytes.toString('utf8'));
      expected = readJson(entry.readablePath);
    } catch (error) {
      differences.push({ entry: entry.logicalName, jsonPath: '$', expected: 'valid JSON', actual: error.message });
      continue;
    }
    for (const difference of collectDifferences(expected, actual)) {
      differences.push({ entry: entry.logicalName, ...difference });
    }
  }
  return { slug, archivePath, flowId: descriptor.flowId, equal: differences.length === 0, differences };
}

export function verifyAllPackageParity(root) {
  const flowsRoot = path.join(path.resolve(root), 'flows');
  const slugs = readdirSync(flowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => {
      try {
        assetDescriptor(root, slug);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
  return slugs.map((slug) => comparePackageToReadable(root, slug));
}

/**
 * @param {{root: string, slug: string, outputPath: string, overrides?: Record<string, unknown>}} options
 */
export function createPackageArchive({ root, slug, outputPath, overrides = {} }) {
  const descriptor = assetDescriptor(root, slug);
  const { strToU8, zipSync } = loadFflate(root);
  const overrideByLogicalName = {
    'manifest.json': overrides.packageManifest,
    'flow-manifest.json': overrides.flowManifest,
    'definition.json': overrides.definition,
    'apisMap.json': overrides.apisMap,
    'connectionsMap.json': overrides.connectionsMap,
  };
  const archive = {};
  for (const entry of descriptor.entries) {
    const value = overrideByLogicalName[entry.logicalName] ?? readJson(entry.readablePath);
    archive[entry.zipPath] = [
      strToU8(`${JSON.stringify(value, null, 2)}\n`),
      { mtime: new Date('2026-01-15T00:00:00.000Z') },
    ];
  }
  writeFileSync(outputPath, Buffer.from(zipSync(archive, { level: 9 })));
  return { outputPath, flowId: descriptor.flowId, entries: descriptor.entries.map(({ zipPath }) => zipPath) };
}
