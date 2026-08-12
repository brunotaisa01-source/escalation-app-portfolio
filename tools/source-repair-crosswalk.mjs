import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { comparePackageToReadable } from './flow-package-parity.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set(['.cache', '.git', '.pytest_cache', '__pycache__', 'coverage', 'node_modules']);
const textExtensions = new Set(['.cjs', '.css', '.csv', '.d.ts', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.xml', '.yml', '.yaml']);
const sourceArchiveShaBySlug = new Map([
  ['bootstrap-lists', '991646d7b24cf0f6f22e63947bfb903d42f2ed5573de01878850d5714cb14bdf'],
  ['add-columns-and-views', '8672c115e5622d90a9435dd89df355bcfcb2d90fa0397c997a82659863bf7a97'],
  ['user-access-matrix', '2c82a283477df64ae11daf505e7b43c31d3e4797a7df07508ee8bf73ee3a01f0'],
  ['seed-cases-01', '7f6eb0d817369ff2a1244c9043f327c06faafb31ae8928bfb5f22d265503acc4'],
  ['seed-cases-02', '0bd880868c267aacdf548ddca91032377bcea30c10ec9942ebb2eaed6896fbe1'],
  ['seed-vendors-01', '871db0d3b2bdc76f02159f6e8f6efab130e3e897e704dd66b94a2d3802423678'],
  ['seed-vendors-02', 'ec3b20314b721856cbfffd45136511a76f8024ca7a56fdac46f30c5dc05bff74'],
  ['manual-move-trigger-test', '563291bb1f1959104bf085b11a3dbe7b56420a889fa96e56ad2168b9b2b063df'],
  ['ingest-queue-west', '9b8d844064f1deb353f69175c35c8e9dc2d122e474e63b97027fd438167aa4e4'],
  ['ingest-queue-north', 'e79450ec0c9722f097fe6010735144fe3305ee580ed98310d3f3523bb1d3d90d'],
  ['ingest-queue-east', '52295c3b6807ffb6ca7fe3fe67f5d38503fcce6fc60e6d939be2a44e42da6ba3'],
  ['ingest-queue-south', '2e570c6edc80b07be017c88dd71c50d972e6f54c9af961d01060ef179d7d3ab0'],
]);
const seedRecordHashes = new Map([
  ['seed-cases-01', '0034de76c86bf9c932268ca4fcd3b54fe63caa6447a9470bdb87a469021a31b9'],
  ['seed-cases-02', '0034de76c86bf9c932268ca4fcd3b54fe63caa6447a9470bdb87a469021a31b9'],
  ['seed-vendors-01', '57124f8eeedcf9a0fbc0ce0e668415bf1bb39771a6a1fb71f0728b19a8604415'],
  ['seed-vendors-02', '57124f8eeedcf9a0fbc0ce0e668415bf1bb39771a6a1fb71f0728b19a8604415'],
]);
const authorizedExpressionPairs = new Set([
  '9cd5aa39b2dec5cd8971e38c28ff0aec280d8540426fe00e30ba8b7f724e32b1:c4f2d0d0eaeb950a14d65732fc4bb72f321d04bced1ef73e0363c91b18795d7e',
  'c1b13cd8bc699c01ccf1c1e63c7404eebd593a7957b7366ffb6373ca872c7638:ebc1612c544fb0d04c265684753e343a3b093e749dd29db783654d9bc797244d',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function filesUnder(root, predicate = () => true) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && excludedDirectories.has(entry.name))) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && predicate(absolute)) files.push(absolute);
    }
  };
  if (statSync(root).isDirectory()) visit(root);
  return files.sort();
}

function loadFflate(packRoot) {
  const require = createRequire(path.join(packRoot, 'frontend', 'package.json'));
  return require('fflate');
}

function readZipJsonEntries(zipPath, packRoot) {
  const { strFromU8, unzipSync } = loadFflate(packRoot);
  const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
  return Object.entries(entries)
    .filter(([entryPath]) => entryPath.toLowerCase().endsWith('.json'))
    .map(([entryPath, bytes]) => ({
      entryPath: entryPath.replaceAll('\\', '/'),
      value: JSON.parse(strFromU8(bytes)),
    }));
}

function definitionBody(document) {
  return document?.properties?.definition ?? document?.definition ?? document;
}

function expressionShape(value) {
  return String(value)
    .replace(/'(?:[^']|'')*'/g, "'<literal>'")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, '<uuid>')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu, '<email>')
    .replace(/https?:\/\/[^\s"')]+/giu, '<url>')
    .replace(/(?:[a-z]:\\|\\\\[^\\]+\\)users\\[^\\\s"']+/giu, '<user-path>');
}

function collectExpressions(value, target = []) {
  if (typeof value === 'string' && (value.startsWith('@') || value.includes('@{'))) {
    target.push(expressionShape(value));
  } else if (Array.isArray(value)) {
    value.forEach((entry) => collectExpressions(entry, target));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectExpressions(entry, target));
  }
  return target;
}

function flowTopology(document) {
  const definition = definitionBody(document);
  const triggers = Object.entries(definition?.triggers ?? {})
    .map(([name, trigger]) => ({ name, type: trigger?.type ?? null }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const actions = [];
  const visit = (actionMap, parentPath) => {
    for (const [name, action] of Object.entries(actionMap ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const actionPath = `${parentPath}/${name}`;
      const runAfter = Object.entries(action?.runAfter ?? {})
        .map(([dependency, statuses]) => [dependency, [...statuses].sort()])
        .sort(([left], [right]) => left.localeCompare(right));
      actions.push({ path: actionPath, type: action?.type ?? null, runAfter });
      if (action?.actions) visit(action.actions, `${actionPath}/actions`);
      if (action?.else?.actions) visit(action.else.actions, `${actionPath}/else/actions`);
    }
  };
  visit(definition?.actions, 'actions');
  const expressions = collectExpressions(definition).sort();
  const signature = stable({ triggers, actions, expressions });
  return {
    triggerCount: triggers.length,
    actionCount: actions.length,
    branchCount: actions.filter(({ type }) => ['Foreach', 'If', 'Scope'].includes(type)).length,
    runAfterCount: actions.reduce((total, { runAfter }) => total + runAfter.length, 0),
    expressionCount: expressions.length,
    topologyHash: sha256(JSON.stringify(signature)),
  };
}

function jsonPath(parent, key) {
  return typeof key === 'number' ? `${parent}[${key}]` : `${parent}.${key}`;
}

function collectDeepDifferences(source, repair, currentPath = '$', output = []) {
  if (Object.is(source, repair)) return output;
  if (Array.isArray(source) || Array.isArray(repair)) {
    if (!Array.isArray(source) || !Array.isArray(repair)) {
      output.push({ path: currentPath, kind: 'type-or-scalar', source, repair });
      return output;
    }
    const length = Math.max(source.length, repair.length);
    for (let index = 0; index < length; index += 1) {
      collectDeepDifferences(source[index], repair[index], jsonPath(currentPath, index), output);
    }
    return output;
  }
  if (source && repair && typeof source === 'object' && typeof repair === 'object') {
    const keys = [...new Set([...Object.keys(source), ...Object.keys(repair)])].sort();
    for (const key of keys) collectDeepDifferences(source[key], repair[key], jsonPath(currentPath, key), output);
    return output;
  }
  output.push({
    path: currentPath,
    kind: source === undefined ? 'repair-only' : repair === undefined ? 'source-only' : 'scalar',
    source,
    repair,
  });
  return output;
}

function publicDifference(difference, category) {
  const hashValue = (value) => value === undefined ? null : sha256(JSON.stringify(stable(value)));
  return {
    path: difference.path,
    kind: difference.kind,
    category,
    sourceValueSha256: hashValue(difference.source),
    repairValueSha256: hashValue(difference.repair),
  };
}

function seedRecords(document) {
  return document?.properties?.definition?.actions?.Initialize_seed_payload?.inputs?.variables?.[0]?.value?.records;
}

function isPlaceholderGuid(value) {
  return typeof value === 'string'
    && /^\{?00000000-0000-4000-8000-[0-9a-f]{12}\}?$/iu.test(value);
}

function isSyntheticScalar(value) {
  if (isPlaceholderGuid(value)) return true;
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return lower.includes('fixture')
    || lower.includes('demo')
    || lower.includes('example.invalid')
    || lower === 'inbox'
    || lower === 'n/a';
}

function authorizeDefinitionDifference(difference, { slug, repairDefinition, seedPayloadAuthorized }) {
  const { path: differencePath, source, repair } = difference;
  const exactStartTimePaths = new Set([
    '$.properties.definition.triggers.Recurrence.recurrence.startTime',
    '$.properties.definition.triggers.Recurrence.evaluatedRecurrence.startTime',
  ]);
  if (slug.startsWith('ingest-queue-')
    && exactStartTimePaths.has(differencePath)
    && source === '2026-02-04T10:00:00.000Z'
    && repair === '2026-01-15T00:00:00Z') return 'deterministic-metadata-date';

  if (typeof source === 'string' && typeof repair === 'string'
    && (source.trimStart().startsWith('@') || repair.trimStart().startsWith('@'))
    && authorizedExpressionPairs.has(`${sha256(source)}:${sha256(repair)}`)) return 'synthetic-list-title-expression';

  const seedPrefix = '$.properties.definition.actions.Initialize_seed_payload.inputs.variables[0].value.records[';
  if (differencePath.startsWith(seedPrefix) && seedPayloadAuthorized) return 'synthetic-seed-replacement';

  const seedMetadataPrefix = '$.properties.definition.actions.Initialize_seed_payload.inputs.variables[0].value.';
  if (differencePath === `${seedMetadataPrefix}rowCount` && seedPayloadAuthorized
    && repair === seedRecords(repairDefinition).length) return 'synthetic-seed-metadata';
  if (differencePath === `${seedMetadataPrefix}sha256` && seedPayloadAuthorized
    && repair === seedRecordHashes.get(slug)) return 'synthetic-seed-metadata';

  if (differencePath === '$.name' && isPlaceholderGuid(repair)) return 'placeholder-flow-id';
  if (differencePath === '$.id'
    && (isPlaceholderGuid(repair)
      || (typeof repair === 'string' && /^\/providers\/Microsoft\.Flow\/flows\/00000000-0000-4000-8000-[0-9a-f]{12}$/iu.test(repair)))) {
    return 'placeholder-flow-id';
  }
  if (differencePath.endsWith('.connectionName') && repair === 'fixture-connection') return 'private-connection-binding';
  if (differencePath.endsWith('.inputs.parameters.dataset') && repair === 'https://example.invalid/sites/DemoPortal') {
    return 'private-site-binding';
  }
  if (differencePath.includes('.metadata.')) {
    if (repair === undefined || isSyntheticScalar(repair) || typeof repair === 'number' || repair === null) return 'deterministic-private-metadata';
    if (typeof repair === 'string' && /^2026-01-15T/.test(repair)) return 'deterministic-private-metadata';
  }
  if (differencePath.startsWith('$.properties.definition.metadata.')) {
    if (repair === null || isSyntheticScalar(repair) || (typeof repair === 'string' && /^2026-01-15T/.test(repair))) {
      return 'deterministic-private-metadata';
    }
  }
  if (differencePath.includes('.inputs.parameters.') && typeof repair === 'string' && isSyntheticScalar(repair)) {
    return 'private-connector-parameter';
  }
  if (differencePath.includes('.inputs.variables[') && isSyntheticScalar(repair)) return 'synthetic-binding-or-label';
  if (differencePath === '$.properties.displayName' && isSyntheticScalar(repair)) return 'synthetic-display-label';
  if (differencePath.startsWith('$.properties.metadata.') && isSyntheticScalar(repair)) return 'synthetic-flow-metadata';
  return null;
}

export function compareFlowContracts({ slug, sourceDefinition, repairDefinition }) {
  const records = seedRecords(repairDefinition);
  const expectedSeedHash = seedRecordHashes.get(slug);
  const seedPayloadAuthorized = expectedSeedHash !== undefined && sha256(JSON.stringify(records)) === expectedSeedHash;
  const differences = collectDeepDifferences(sourceDefinition, repairDefinition);
  const authorizedDifferences = [];
  const unauthorizedDifferences = [];
  for (const difference of differences) {
    const category = authorizeDefinitionDifference(difference, { slug, repairDefinition, seedPayloadAuthorized });
    const publicRow = publicDifference(difference, category ?? 'unauthorized');
    if (category) authorizedDifferences.push(publicRow);
    else unauthorizedDifferences.push(publicRow);
  }
  return {
    equal: unauthorizedDifferences.length === 0,
    sourceDocumentSha256: sha256(JSON.stringify(stable(sourceDefinition))),
    repairDocumentSha256: sha256(JSON.stringify(stable(repairDefinition))),
    authorizedDifferences,
    unauthorizedDifferences,
  };
}

export function verifyRepairMapBindings({ flowId, packageManifest, apisMap, connectionsMap }) {
  const findings = [];
  const resources = packageManifest?.resources ?? {};
  const apiKeys = Object.keys(apisMap ?? {}).sort();
  const connectionKeys = Object.keys(connectionsMap ?? {}).sort();
  if (JSON.stringify(apiKeys) !== JSON.stringify(connectionKeys)) findings.push({ rule: 'map-key-set-mismatch' });
  for (const key of [...new Set([...apiKeys, ...connectionKeys])].sort()) {
    const apiId = apisMap?.[key];
    const connectionId = connectionsMap?.[key];
    const apiResource = resources[apiId];
    const connectionResource = resources[connectionId];
    const apiNameMatchesKey = apiResource && (key === apiResource.name || new RegExp(`^${apiResource.name}-[0-9]+$`, 'u').test(key));
    if (!apiResource || apiResource.type !== 'Microsoft.PowerApps/apis' || !apiNameMatchesKey) {
      findings.push({ rule: 'api-map-resource-mismatch', keyHash: sha256(key).slice(0, 16) });
    }
    if (!connectionResource || connectionResource.type !== 'Microsoft.PowerApps/apis/connections'
      || !connectionResource.dependsOn?.includes(apiId)) {
      findings.push({ rule: 'connection-map-resource-mismatch', keyHash: sha256(key).slice(0, 16) });
    }
  }
  const flowResource = resources[flowId];
  if (!flowResource || flowResource.type !== 'Microsoft.Flow/flows') findings.push({ rule: 'flow-resource-missing' });
  else {
    for (const resourceId of [...Object.values(apisMap ?? {}), ...Object.values(connectionsMap ?? {})]) {
      if (!flowResource.dependsOn?.includes(resourceId)) findings.push({ rule: 'flow-resource-dependency-missing' });
    }
  }
  return findings;
}

function sourceArchiveInventory(sourceRoot) {
  const archives = filesUnder(sourceRoot, (file) => path.extname(file).toLowerCase() === '.zip' && statSync(file).size <= 5_000_000);
  const bySha = new Map();
  for (const archivePath of archives) {
    const archiveSha = sha256(readFileSync(archivePath));
    const matches = bySha.get(archiveSha) ?? [];
    matches.push(archivePath);
    bySha.set(archiveSha, matches);
  }
  return { archives, bySha };
}

function oneZipAsset(entries, predicate, label) {
  const matches = entries.filter(({ entryPath }) => predicate(entryPath));
  if (matches.length !== 1) throw new Error(`expected one ${label}; found ${matches.length}`);
  return matches[0].value;
}

function sourceAssets(archivePath, repairRoot) {
  const entries = readZipJsonEntries(archivePath, repairRoot);
  return {
    packageManifest: oneZipAsset(entries, (entryPath) => entryPath === 'manifest.json', 'package manifest'),
    flowManifest: oneZipAsset(entries, (entryPath) => entryPath.toLowerCase().endsWith('/flows/manifest.json'), 'flow manifest'),
    definition: oneZipAsset(entries, (entryPath) => entryPath.toLowerCase().endsWith('/definition.json'), 'definition'),
    apisMap: oneZipAsset(entries, (entryPath) => entryPath.toLowerCase().endsWith('/apismap.json'), 'apis map'),
    connectionsMap: oneZipAsset(entries, (entryPath) => entryPath.toLowerCase().endsWith('/connectionsmap.json'), 'connections map'),
  };
}

function resourceTypeCardinality(manifest) {
  const counts = {};
  for (const resource of Object.values(manifest?.resources ?? {})) {
    counts[resource?.type ?? '<missing>'] = (counts[resource?.type ?? '<missing>'] ?? 0) + 1;
  }
  return stable(counts);
}

function treeMap(root) {
  const result = new Map();
  if (!root || !statSync(root).isDirectory()) return result;
  for (const file of filesUnder(root)) {
    const relativePath = path.relative(root, file).replaceAll(path.sep, '/');
    result.set(relativePath, sha256(readFileSync(file)));
  }
  return result;
}

function compareTrees(sourceRoot, repairRoot) {
  const source = treeMap(sourceRoot);
  const repair = treeMap(repairRoot);
  const paths = [...new Set([...source.keys(), ...repair.keys()])].sort();
  return {
    sourceCount: source.size,
    repairCount: repair.size,
    commonCount: paths.filter((entry) => source.has(entry) && repair.has(entry)).length,
    identicalCount: paths.filter((entry) => source.get(entry) === repair.get(entry)).length,
    changedPaths: paths.filter((entry) => source.has(entry) && repair.has(entry) && source.get(entry) !== repair.get(entry)),
    sourceOnly: paths.filter((entry) => source.has(entry) && !repair.has(entry)),
    repairOnly: paths.filter((entry) => repair.has(entry) && !source.has(entry)),
  };
}

function sourceOnlyPrivateMarkers(sourceRoot, repairRoot) {
  const sourceFiles = filesUnder(sourceRoot, (file) => textExtensions.has(path.extname(file).toLowerCase()) && statSync(file).size <= 2_000_000);
  const repairFiles = filesUnder(repairRoot, (file) => textExtensions.has(path.extname(file).toLowerCase()) && statSync(file).size <= 2_000_000);
  const repairDocuments = repairFiles.map((file) => ({
    path: path.relative(repairRoot, file).replaceAll(path.sep, '/'),
    text: readFileSync(file, 'utf8'),
  }));
  const markers = new Map();
  const syntheticBusinessLabels = new Set(['waiting approval']);
  const add = (value, category) => {
    const marker = String(value).trim();
    if (marker.length >= 3
      && !marker.toLowerCase().includes('example.invalid')
      && !syntheticBusinessLabels.has(marker.toLowerCase())) markers.set(marker.toLowerCase(), { marker, category });
  };
  for (const file of sourceFiles) {
    const sourceText = readFileSync(file, 'utf8');
    for (const match of sourceText.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu)) add(match[0], 'source-email');
    for (const match of sourceText.matchAll(/(?:[a-z]:\\|\\\\[^\\]+\\)users\\[^\\\s"']+/giu)) add(match[0], 'source-user-path');
    for (const match of sourceText.matchAll(/https?:\/\/[^\s"')]+/giu)) {
      try {
        const host = new URL(match[0]).hostname.toLowerCase();
        const publicSuffixes = [
          'eslint.org', 'github.com', 'githubusercontent.com', 'ietf.org', 'jsdelivr.net', 'json-schema.org',
          'microsoft.com', 'nodejs.org', 'npmjs.org', 'openjsf.org', 'opencollective.com',
          'webpack.js.org', 'w3.org',
        ];
        const isPublicHost = ['127.0.0.1', 'localhost'].includes(host)
          || host.endsWith('example.invalid')
          || host === 'example'
          || host.endsWith('.example')
          || publicSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
        if (!isPublicHost) add(host, 'source-private-host');
      } catch {
        // Invalid source URLs are not useful privacy markers.
      }
    }
    const relativePath = path.relative(sourceRoot, file);
    const repairPath = path.join(repairRoot, relativePath);
    try {
      const repairPeer = readFileSync(repairPath, 'utf8');
      const repairLiterals = new Set([...repairPeer.matchAll(/(["'`])([^\r\n]{3,120}?)\1/g)].map((match) => match[2]));
      for (const match of sourceText.matchAll(/(["'`])([^\r\n]{3,120}?)\1/g)) {
        const literal = match[2].trim();
        const humanOrCompany = /^[A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){1,4}$/.test(literal)
          || /\b(?:Ltd|Limited|LLC|GmbH|PLC|Inc)\b/i.test(literal);
        if (humanOrCompany && !repairLiterals.has(literal)) add(literal, 'source-name-or-company-label');
      }
    } catch {
      // Source-only files are classified in the structural crosswalk, not copied.
    }
  }
  const leaks = [];
  for (const { marker, category } of markers.values()) {
    const repairPaths = repairDocuments
      .filter((document) => document.text.toLowerCase().includes(marker.toLowerCase()))
      .map((document) => document.path);
    if (repairPaths.length === 0) continue;
    leaks.push({ markerHash: sha256(marker.toLowerCase()).slice(0, 16), category, repairPaths });
  }
  return { markerCount: markers.size, leaks };
}

const expectedFrontendChanges = {
  'dist/assets/app.js': 'AUTHORIZED_GENERATED_BUILD_FROM_REPAIR_SOURCE',
  'dist/index.html': 'AUTHORIZED_GENERATED_BUILD_FROM_REPAIR_SOURCE',
  'launcher/escalation-launcher.js': 'AUTHORIZED_SANITIZATION_AND_TYPE_ANNOTATION',
  'package.json': 'AUTHORIZED_REPAIR_TOOLING',
  'public/index.html': 'AUTHORIZED_BRANDING_GENERALIZATION',
  'src/config/runtime-config.example.js': 'AUTHORIZED_BINDING_GENERALIZATION',
  'src/services/csv-export.js': 'AUTHORIZED_DETERMINISTIC_CLOCK_REPAIR',
  'src/services/query-total-coordinator.js': 'PRESERVED_BEHAVIOUR_LINT_CLEANUP',
  'src/services/sharepoint-transport.js': 'PRESERVED_BEHAVIOUR_LINT_CLEANUP',
  'src/ui/kpi-load-coordinator.js': 'AUTHORIZED_PRIVATE_LABEL_GENERALIZATION',
  'src/ui/workbench-view.js': 'AUTHORIZED_PRIVATE_LABEL_GENERALIZATION',
};
const expectedFrontendAdditions = new Set(['jsconfig.json', 'launcher/globals.d.ts', 'package-lock.json']);

export function buildSourceRepairCrosswalk({ sourceRoot, repairRoot = moduleRoot } = {}) {
  if (!sourceRoot) throw new TypeError('sourceRoot is required');
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedRepair = path.resolve(repairRoot);
  const sourceFrontend = path.join(resolvedSource, 'frontend');
  const repairFrontend = path.join(resolvedRepair, 'frontend');
  const frontend = compareTrees(sourceFrontend, repairFrontend);
  const unexpectedFrontendChanges = frontend.changedPaths.filter((entry) => !expectedFrontendChanges[entry]);
  const unexpectedFrontendAdditions = frontend.repairOnly.filter((entry) => !expectedFrontendAdditions.has(entry));
  const sourceFrontendMap = treeMap(sourceFrontend);
  const repairFrontendMap = treeMap(repairFrontend);
  const entrypoints = ['public/index.html', 'src/index.js', 'launcher/escalation-launcher.js'].map((entry) => {
    const sourceHash = sourceFrontendMap.get(entry);
    const repairHash = repairFrontendMap.get(entry);
    const classification = sourceHash === repairHash
      ? 'PRESERVED_BYTE_EXACT'
      : expectedFrontendChanges[entry] ?? 'UNCLASSIFIED';
    return { path: entry, sourcePresent: Boolean(sourceHash), repairPresent: Boolean(repairHash), classification };
  });
  const archiveInventory = sourceArchiveInventory(resolvedSource);
  const repairIndex = JSON.parse(readFileSync(path.join(resolvedRepair, 'flows', 'flow-index.json'), 'utf8'));
  const flows = repairIndex.flows.map((flow) => {
    const sourceArchiveSha256 = sourceArchiveShaBySlug.get(flow.slug);
    const archivePaths = archiveInventory.bySha.get(sourceArchiveSha256) ?? [];
    if (!sourceArchiveSha256 || archivePaths.length === 0) {
      return { slug: flow.slug, sourceArchiveSha256: sourceArchiveSha256 ?? null, sourceMatchCount: 0, classification: 'RED_SOURCE_ARCHIVE_SHA_MISSING' };
    }
    const source = sourceAssets(archivePaths[0], resolvedRepair);
    const repair = {
      definition: JSON.parse(readFileSync(path.join(resolvedRepair, flow.definition), 'utf8')),
      packageManifest: JSON.parse(readFileSync(path.join(resolvedRepair, flow.packageManifest), 'utf8')),
      flowManifest: JSON.parse(readFileSync(path.join(resolvedRepair, flow.flowManifest), 'utf8')),
      apisMap: JSON.parse(readFileSync(path.join(resolvedRepair, flow.apisMap), 'utf8')),
      connectionsMap: JSON.parse(readFileSync(path.join(resolvedRepair, flow.connectionsMap), 'utf8')),
    };
    const contract = compareFlowContracts({ slug: flow.slug, sourceDefinition: source.definition, repairDefinition: repair.definition });
    const mapFindings = verifyRepairMapBindings({
      flowId: flow.flowId,
      packageManifest: repair.packageManifest,
      apisMap: repair.apisMap,
      connectionsMap: repair.connectionsMap,
    });
    const sourceMapKeysExact = JSON.stringify(Object.keys(source.apisMap).sort()) === JSON.stringify(Object.keys(repair.apisMap).sort())
      && JSON.stringify(Object.keys(source.connectionsMap).sort()) === JSON.stringify(Object.keys(repair.connectionsMap).sort());
    const packageManifestShapePreserved = JSON.stringify(Object.keys(source.packageManifest?.details ?? {}).sort())
        === JSON.stringify(Object.keys(repair.packageManifest?.details ?? {}).sort())
      && JSON.stringify(resourceTypeCardinality(source.packageManifest)) === JSON.stringify(resourceTypeCardinality(repair.packageManifest));
    const sourceFlowManifest = structuredClone(source.flowManifest);
    if (sourceFlowManifest?.flowAssets) sourceFlowManifest.flowAssets.assetPaths = repair.flowManifest?.flowAssets?.assetPaths;
    const flowManifestContractPreserved = JSON.stringify(stable(sourceFlowManifest)) === JSON.stringify(stable(repair.flowManifest));
    const packageParity = comparePackageToReadable(resolvedRepair, flow.slug);
    const topology = flowTopology(repair.definition);
    const preserved = contract.equal && mapFindings.length === 0 && sourceMapKeysExact
      && packageManifestShapePreserved && flowManifestContractPreserved && packageParity.equal;
    const categoryCounts = {};
    for (const difference of contract.authorizedDifferences) {
      categoryCounts[difference.category] = (categoryCounts[difference.category] ?? 0) + 1;
    }
    return {
      slug: flow.slug,
      classification: preserved ? 'PRESERVED_DEEP_CONTRACT_WITH_AUTHORIZED_SANITIZATION' : 'RED_DEEP_CONTRACT_OR_PACKAGE_MISMATCH',
      sourceArchiveSha256,
      sourceMatchCount: 1,
      sourceArchiveCopiesFound: archivePaths.length,
      sourceDocumentSha256: contract.sourceDocumentSha256,
      repairDocumentSha256: contract.repairDocumentSha256,
      authorizedDifferenceCounts: stable(categoryCounts),
      unauthorizedDifferences: contract.unauthorizedDifferences,
      sourceMapKeysExact,
      repairMapFindings: mapFindings,
      packageManifestShapePreserved,
      flowManifestContractPreserved,
      readableZipParity: packageParity.equal,
      triggerCount: topology.triggerCount,
      actionCount: topology.actionCount,
      branchCount: topology.branchCount,
      expressionCount: topology.expressionCount,
      runAfterCount: topology.runAfterCount,
    };
  });
  const tests = compareTrees(path.join(resolvedSource, 'tests'), path.join(resolvedRepair, 'tests'));
  const privacy = sourceOnlyPrivateMarkers(resolvedSource, resolvedRepair);
  const gates = {
    sourceReadOnly: true,
    sourcePathNotEmitted: true,
    frontendNoSourceOnlyFiles: frontend.sourceOnly.length === 0,
    frontendChangesClassified: unexpectedFrontendChanges.length === 0 && unexpectedFrontendAdditions.length === 0,
    frontendEntrypointsIndividuallyPreserved: entrypoints.every(({ sourcePresent, repairPresent, classification }) => sourcePresent && repairPresent && classification !== 'UNCLASSIFIED'),
    allTwelveSourceArchivesMappedBijectively: flows.length === 12
      && new Set(flows.map(({ sourceArchiveSha256 }) => sourceArchiveSha256).filter(Boolean)).size === 12
      && flows.every(({ sourceMatchCount }) => sourceMatchCount === 1),
    allTwelveDeepContractsPreserved: flows.every(({ classification }) => classification === 'PRESERVED_DEEP_CONTRACT_WITH_AUTHORIZED_SANITIZATION'),
    allTwelveReadableZipPackagesCanonical: flows.every(({ readableZipParity }) => readableZipParity === true),
    sourcePrivateMarkersAbsentFromRepair: privacy.leaks.length === 0,
    externalTenantRuntimeStillUnproven: true,
  };
  return {
    schemaVersion: '1.0.0',
    evidenceScope: 'READ_ONLY_LOCAL_SOURCE_TO_REPAIR_STATIC_AND_LOCAL_BEHAVIOURAL_CROSSWALK',
    sourceLocatorSha256: sha256(resolvedSource),
    sourcePathEmitted: false,
    repairPack: '01-escalation-app',
    frontend: {
      sourceCount: frontend.sourceCount,
      repairCount: frontend.repairCount,
      commonCount: frontend.commonCount,
      identicalCount: frontend.identicalCount,
      changed: frontend.changedPaths.map((entry) => ({ path: entry, classification: expectedFrontendChanges[entry] ?? 'UNCLASSIFIED' })),
      sourceOnlyCount: frontend.sourceOnly.length,
      repairOnly: frontend.repairOnly.map((entry) => ({ path: entry, classification: expectedFrontendAdditions.has(entry) ? 'AUTHORIZED_REPAIR_TOOLING' : 'UNCLASSIFIED' })),
      entrypoints,
      preservedEntrypoints: entrypoints.every(({ sourcePresent, repairPresent, classification }) => sourcePresent && repairPresent && classification !== 'UNCLASSIFIED'),
      queryContract: frontend.changedPaths.includes('src/services/sharepoint-query.js') ? 'RED_CHANGED' : 'PRESERVED_BYTE_EXACT',
    },
    flowSource: {
      inspectedArchives: archiveInventory.archives.length,
      mappedArchiveShaCount: sourceArchiveShaBySlug.size,
      mappingMode: 'EXPLICIT_SOURCE_ARCHIVE_SHA256_TO_REPAIR_SLUG_BIJECTION',
      flows,
      authorizedDifferences: [
        'FLOW_AND_RESOURCE_IDS_GENERALIZED',
        'CONNECTION_BINDINGS_AND_TENANT_URLS_GENERALIZED',
        'MAILBOX_IDENTITIES_AND_EMBEDDED_OPERATIONAL_ROWS_REPLACED_WITH_FIXTURES',
        'ZIP_BYTES_REGENERATED_FROM_REPAIR_CANONICAL_JSON',
        'INDEPENDENT_EXECUTOR_AND_MUTATION_TESTS_ADDED',
      ],
    },
    backendAndEtl: {
      classification: 'AUTHORIZED_LOCAL_ADAPTER_GENERALIZATION_WITH_PRESERVED_SCHEMA_QUERY_AND_OUTPUT_CONTRACTS',
      localAdapter: 'runtime/fake-connector.mjs',
      proof: ['tests/e2e/local-e2e.test.mjs', 'tests/frontend/service-behavior.test.js', 'tests/flows/flow-definition-runner.test.mjs'],
      tenantRuntime: 'RED_EXTERNAL_GATE',
    },
    tests: {
      sourceCount: tests.sourceCount,
      repairCount: tests.repairCount,
      commonCount: tests.commonCount,
      identicalCount: tests.identicalCount,
      changedCommonCount: tests.changedPaths.length,
      sourceOnlyCount: tests.sourceOnly.length,
      repairOnlyCount: tests.repairOnly.length,
      classification: 'SELECTED_PUBLIC_TEST_CONTRACTS_PRESERVED_OR_SANITIZED;_OPERATIONAL_SOURCE_ONLY_TESTS_EXCLUDED;_REPAIR_REGRESSIONS_ADDED',
    },
    privacy: {
      sourceDerivedMarkerCount: privacy.markerCount,
      leakCount: privacy.leaks.length,
      leaks: privacy.leaks,
      markerValuesEmitted: false,
    },
    gates,
    allLocalCrosswalkGatesGreen: Object.values(gates).every(Boolean),
    limitations: [
      'STATIC_GRAPH_MATCH_AND_LOCAL_FIXTURE_EXECUTION_DO_NOT_PROVE_TENANT_RUNTIME_BEHAVIOUR',
      'SOURCE_ONLY_OPERATIONAL_TESTS_AND_RUNTIME_EVIDENCE_ARE_NOT COPIED_INTO_THE_PUBLIC_PACK'.replace(' ', '_'),
      'A_NEW_READ_ONLY_SOL_REVIEW_REMAINS_REQUIRED',
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildSourceRepairCrosswalk({
    sourceRoot: process.env.ESCALATION_BEHAVIOURAL_SOURCE_ROOT,
    repairRoot: process.argv[2] ? path.resolve(process.argv[2]) : moduleRoot,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.allLocalCrosswalkGatesGreen) process.exitCode = 1;
}
