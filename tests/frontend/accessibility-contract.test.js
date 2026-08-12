import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const indexSource = readFileSync(path.join(root, 'frontend', 'public', 'index.html'), 'utf8');
const appSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'app.js'), 'utf8');
const viewSource = readFileSync(path.join(root, 'frontend', 'src', 'ui', 'workbench-view.js'), 'utf8');
const uiSource = `${appSource}\n${viewSource}`;
const styleSource = readFileSync(path.join(root, 'frontend', 'src', 'styles.css'), 'utf8');

test('equivalent static accessibility assertions cover the release shell when axe is unavailable', () => {
  assert.match(indexSource, /<html[^>]+lang="en"/i);
  assert.match(indexSource, /<a[^>]+href="#main-content"[^>]*>Skip to main content<\/a>/i);
  assert.match(indexSource, /<main[^>]+id="main-content"/i);
  assert.match(uiSource, /role="status" aria-live="polite"/);
  assert.match(uiSource, /aria-label="Case pagination"/);
  assert.match(uiSource, /aria-haspopup="dialog"/);
  assert.match(uiSource, /<label for="vendor-search">Find vendor<\/label>/);
  assert.match(uiSource, /for="field-\$\{field\}"/);
  assert.match(uiSource, /\['Status', 'Priority', 'ActionType', 'APOwner', 'Entity'\]\.includes\(field\)/);
  assert.match(styleSource, /:focus-visible/);
  assert.doesNotMatch(styleSource, /outline\s*:\s*none/);
});
