import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const dist = path.join(root, 'frontend', 'dist');
const bundlePath = path.join(dist, 'assets', 'app.js');

test('built Duplicate payload has the approved index plus assets/app.js dist shape', () => {
  const entries = readdirSync(dist, { withFileTypes: true }).map((entry) => entry.name).sort();
  assert.deepEqual(entries, ['assets', 'index.html']);
  assert.deepEqual(readdirSync(path.join(dist, 'assets')), ['app.js']);
  assert.ok(statSync(bundlePath).size > 100_000);
});

test('built bundle contains the governed Duplicate and safe terminal-field contracts', () => {
  const bundle = readFileSync(bundlePath, 'utf8');
  assert.match(bundle, /Action Required/);
  assert.match(bundle, /In Progress/);
  assert.match(bundle, /Duplicate/);
  assert.match(bundle, /Is_x0020_Closed/);
  assert.match(bundle, /Days_x0020_To_x0020_Resolve/);
  assert.match(bundle, /Mark \$\{/);
  assert.match(bundle, /as Duplicate\?/);
  assert.match(bundle, /It will leave Open and appear in Closed\./);
  assert.doesNotMatch(bundle, /Status ne 'Closed'/);
});

test('launcher resolves the approved same-root assets payload', () => {
  const launcher = readFileSync(path.join(root, 'frontend', 'launcher', 'escalation-launcher.js'), 'utf8');
  assert.match(launcher, /new URL\("\."/);
  assert.match(launcher, /assets\/app\.js/);
  assert.doesNotMatch(launcher, /dist\/escalation-workbench\.js/);
});
