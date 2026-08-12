import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(packRoot, 'manifests', 'frontend-contract.json'), 'utf8'));
const launcherPath = path.resolve(packRoot, manifest.target.launcherPath);
const shellPath = path.resolve(packRoot, manifest.target.shellPath);
const bundlePath = path.resolve(packRoot, manifest.target.bundlePath);

function activeBundlePath(launcherSource) {
  const match = launcherSource.match(/bundle\.src\s*=\s*baseUrl\s*\+\s*["']([^"']+)["']/);
  assert.ok(match, 'active root launcher declares a literal same-folder bundle path');
  return match[1].split('?')[0];
}

test('pack-relative launcher loads the canonical assets/app.js bundle', () => {
  assert.ok(existsSync(launcherPath), `active launcher exists: ${launcherPath}`);
  const launcher = readFileSync(launcherPath, 'utf8');
  assert.equal(activeBundlePath(launcher), 'assets/app.js');
  assert.ok(launcher.includes(String.raw`frontend\/escalation-launcher\.js$/i`));
  assert.doesNotMatch(launcher, /\/Escalation\/frontend\/launcher\/escalation-launcher/);
});

test('pack-relative bundle selected by the launcher contains Duplicate', () => {
  const launcher = readFileSync(launcherPath, 'utf8');
  assert.equal(activeBundlePath(launcher), path.posix.relative('frontend/dist', manifest.target.bundlePath));
  assert.ok(existsSync(bundlePath), `active bundle exists: ${bundlePath}`);
  const bundle = readFileSync(bundlePath, 'utf8');
  for (const status of ['Action Required', 'In Progress', 'Closed', 'Duplicate']) {
    assert.ok(bundle.includes(status), `active bundle contains governed status ${status}`);
  }
});

test('publishable payload contract enumerates the canonical three pack-relative files', () => {
  assert.deepEqual(
    [manifest.target.bundlePath, manifest.target.launcherPath, manifest.target.shellPath].sort(),
    ['frontend/dist/assets/app.js', 'frontend/dist/index.html', 'frontend/launcher/escalation-launcher.js'],
  );
  for (const asset of [bundlePath, launcherPath, shellPath]) assert.ok(existsSync(asset), `publishable asset exists: ${asset}`);
});
