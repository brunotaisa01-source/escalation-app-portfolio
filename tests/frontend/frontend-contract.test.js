import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const frontend = path.join(root, 'frontend');

test('frontend exposes an accessible document shell', () => {
  const html = readFileSync(path.join(frontend, 'public', 'index.html'), 'utf8');
  assert.match(html, /<main\b/);
  assert.match(html, /id=["']main-content["']/);
  assert.match(html, /skip-link/);
  assert.match(html, /lang=["']en["']/);
});

test('case service validates controlled choices and filters cases', async () => {
  const { createCaseService } = await import('../../frontend/src/services/case-service.js');
  const service = createCaseService([
    { id: 1, Title: 'Alpha', Status: 'Open', Priority: 'High', ActionType: 'Review', Entity: 'UK', APOwner: 'Owner A' },
    { id: 2, Title: 'Beta', Status: 'Closed', Priority: 'Low', ActionType: 'Follow-up', Entity: 'IE', APOwner: 'Owner B' },
  ]);
  assert.equal(service.filter({ status: 'Open' }).length, 1);
  assert.equal(service.filter({ query: 'beta' })[0].Title, 'Beta');
  assert.throws(() => service.update(1, { Status: 'Unknown' }), /Status/);
});

test('UI source uses semantic controls and live status messaging', () => {
  const source = readFileSync(path.join(frontend, 'src', 'ui', 'workbench-view.js'), 'utf8');
  assert.match(source, /aria-live/);
  assert.match(source, /<button/);
  assert.match(source, /<label/);
  const shell = readFileSync(path.join(frontend, 'public', 'index.html'), 'utf8');
  assert.match(shell, /<main/);
});

test('UI exposes exactly the approved page-size options and accessible pagination controls', () => {
  const source = readFileSync(path.join(frontend, 'src', 'ui', 'workbench-view.js'), 'utf8');
  assert.match(source, /id="page-size"/);
  assert.equal((source.match(/<option value="(?:20|50)">/g) ?? []).length, 2);
  assert.match(source, /id="previous-page"[^>]*type="button"/);
  assert.match(source, /id="next-page"[^>]*type="button"/);
  assert.match(source, /disabled/);
});

test('UI keeps list pagination at the query boundary instead of loading a full collection', () => {
  const source = readFileSync(path.join(frontend, 'src', 'ui', 'app.js'), 'utf8');
  assert.match(source, /service\.query\(request\)/);
  assert.match(source, /createConfiguredCaseService\(config, globalThis\.fetch\)/);
  assert.doesNotMatch(source, /sampleCases|MOCK-001|MOCK-002/);
  assert.doesNotMatch(source, /service\.snapshot\(\)/);
  assert.doesNotMatch(source, /service\.filter\(/);
});

test('runtime config contains no credentials and requires explicit rebinding', () => {
  const config = readFileSync(path.join(frontend, 'src', 'config', 'runtime-config.example.js'), 'utf8');
  assert.match(config, /TEMPLATE_REBIND_REQUIRED/);
  assert.match(config, /mode: 'sharepoint'/);
  assert.doesNotMatch(config, /password|clientSecret|accessToken|apiKey/i);
  assert.doesNotMatch(config, /__[A-Z][A-Z0-9_]+__/, 'runtime template must not ship placeholder tokens');
});

test('PowerShell Webpack documentation uses executable cmd shims', () => {
  const docs = readFileSync(path.join(root, 'docs', 'WEBPACK_SETUP.md'), 'utf8');
  assert.match(docs, /npm\.cmd test/);
  assert.match(docs, /npm\.cmd run build/);
  assert.match(docs, /npx\.cmd webpack --version/);
  assert.doesNotMatch(docs, /^npm (?:test|run build|install|ci)$/m);
});
