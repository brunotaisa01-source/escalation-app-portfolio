import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..', '..');
const launcherPath = process.env.DEMO_LAUNCHER_UNDER_TEST
  ?? path.join(root, 'frontend', 'launcher', 'escalation-launcher.js');
const launcherSource = readFileSync(launcherPath, 'utf8');
const launcherUrl = 'https://example.invalid/sites/DemoPortal/fixtures/escalation/frontend/escalation-launcher.js';
const hostUrl = 'https://example.invalid/sites/DemoPortal/SitePages/AP-HUB.aspx';

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.id = '';
    this.dataset = {};
    this.src = '';
    this.async = false;
    this.onload = null;
    this.onerror = null;
    this.textContent = '';
  }

  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] ?? null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) return this.appendChild(child);
    child.parentNode = this;
    this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...children) {
    [...this.children].forEach((child) => this.removeChild(child));
    children.forEach((child) => this.appendChild(child));
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  cloneNode(deep = false) {
    const clone = new Element(this.tagName);
    clone.id = this.id;
    clone.dataset = { ...this.dataset };
    clone.textContent = this.textContent;
    if (deep) this.children.forEach((child) => clone.appendChild(child.cloneNode(true)));
    return clone;
  }

  getBoundingClientRect() {
    const bodyIndex = this.parentNode?.tagName === 'body' ? this.parentNode.children.indexOf(this) : 0;
    return { top: bodyIndex * 492 };
  }
}

class FakeDocument {
  constructor() {
    this.body = new Element('body');
    this.head = new Element('head');
    this.currentScript = { src: launcherUrl };
    this.title = 'SharePoint host';
  }

  createElement(tagName) { return new Element(tagName); }
  importNode(node, deep) { return node.cloneNode(deep); }
  getElementById(id) { return find(this.body, (node) => node.id === id) ?? find(this.head, (node) => node.id === id); }
  querySelector(selector) {
    if (selector === '[data-demo-escalation-owned="root"]') {
      return find(this.body, (node) => node.dataset.demoEscalationOwned === 'root');
    }
    return null;
  }
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function shellDocument() {
  const shell = new FakeDocument();
  shell.title = 'Demo Escalation Workbench';
  const main = shell.createElement('main');
  main.id = 'main-content';
  const appRoot = shell.createElement('div');
  appRoot.id = 'app-root';
  appRoot.textContent = 'Loading escalation workbench';
  main.appendChild(appRoot);
  shell.body.appendChild(main);
  return shell;
}

function createHarness({ failBundleFallback = false } = {}) {
  const document = new FakeDocument();
  const originalHeader = document.createElement('header');
  originalHeader.id = 'sharepoint-header';
  const originalPage = document.createElement('div');
  originalPage.id = 'sharepoint-page';
  document.body.appendChild(originalHeader);
  document.body.appendChild(originalPage);
  const previousConfig = { previous: true };
  const history = [{ stage: 'requested', message: 'Native host requested launcher' }];
  const window = {
    location: new URL(hostUrl),
    DEMO_ESCALATION_CONFIG: previousConfig,
    DEMO_ESCALATION_LAUNCHER_STATUS: { stage: 'requested', message: 'Native host requested launcher', history },
  };
  const errors = [];
  const context = {
    document,
    window,
    URL,
    DOMParser: class { parseFromString() { return shellDocument(); } },
    fetch: async (url) => {
      if (url.includes('/index.html')) return { ok: true, text: async () => '<html></html>' };
      if (failBundleFallback) return { ok: false, status: 500, statusText: 'simulated failure', text: async () => '' };
      return { ok: true, text: async () => 'window.__bundleFallbackRan = true;' };
    },
    console: { error: (...args) => errors.push(args.join(' ')), info: () => {} },
    Date,
    Function,
  };
  window.console = context.console;
  return { context, document, window, errors, originalHeader, originalPage, previousConfig };
}

async function flush(count = 4) {
  for (let index = 0; index < count; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function execute(harness) {
  vm.runInNewContext(launcherSource, harness.context);
  await flush();
}

test('launcher replaces SharePoint body instead of appending Escalation below it', async () => {
  const harness = createHarness();
  await execute(harness);

  const ownedRoot = harness.document.querySelector('[data-demo-escalation-owned="root"]');
  assert.ok(ownedRoot);
  assert.deepEqual(harness.document.body.children, [ownedRoot]);
  assert.equal(harness.document.body.firstChild, ownedRoot);
  assert.equal(ownedRoot.getBoundingClientRect().top, 0);
  assert.equal(harness.originalHeader.parentNode, null);
  assert.equal(harness.originalPage.parentNode, null);
});

test('bundle failure restores original SharePoint body, title, and config', async () => {
  const harness = createHarness({ failBundleFallback: true });
  await execute(harness);

  const bundle = harness.document.getElementById('demo-escalation-bundle');
  assert.ok(bundle);
  bundle.onerror(new Error('simulated tag failure'));
  await flush();

  assert.deepEqual(harness.document.body.children, [harness.originalHeader, harness.originalPage]);
  assert.equal(harness.document.title, 'SharePoint host');
  assert.equal(harness.window.DEMO_ESCALATION_CONFIG, harness.previousConfig);
  assert.equal(harness.window.DEMO_ESCALATION_LAUNCHER_STATUS.stage, 'error');
  assert.match(harness.window.DEMO_ESCALATION_LAUNCHER_STATUS.message, /assets\/app\.js|simulated failure/i);
});

test('launcher reclaims exclusive body ownership after delayed host navigation', async () => {
  const harness = createHarness();
  await execute(harness);

  const bundle = harness.document.getElementById('demo-escalation-bundle');
  const lateHostNode = harness.document.createElement('div');
  lateHostNode.id = 'late-sharepoint-navigation-node';
  harness.document.body.appendChild(lateHostNode);
  bundle.onload();

  const ownedRoot = harness.document.querySelector('[data-demo-escalation-owned="root"]');
  assert.ok(ownedRoot);
  assert.deepEqual(harness.document.body.children, [ownedRoot]);
  assert.equal(harness.window.DEMO_ESCALATION_LAUNCHER_STATUS.stage, 'app-root-present');
});

test('launcher reports requested through app-root-present in deterministic order', async () => {
  const harness = createHarness();
  await execute(harness);

  const bundle = harness.document.getElementById('demo-escalation-bundle');
  assert.equal(typeof bundle.onload, 'function');
  bundle.onload();

  const status = harness.window.DEMO_ESCALATION_LAUNCHER_STATUS;
  assert.equal(status.stage, 'app-root-present');
  assert.deepEqual(
    status.history.map((entry) => entry.stage),
    ['requested', 'launcher-loaded', 'shell-loaded', 'bundle-loaded', 'app-root-present'],
  );
});
