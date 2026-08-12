import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const launcherCandidates = [
  process.env.DEMO_LAUNCHER_UNDER_TEST,
  path.join(import.meta.dirname, '..', '..', 'frontend', 'launcher', 'escalation-launcher.js'),
].filter(Boolean);
const launcherPath = launcherCandidates.find((candidate) => existsSync(candidate));
if (!launcherPath) throw new Error('No local Escalation launcher artifact is available for WebView2 contract tests');
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
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  cloneNode(deep = false) {
    const clone = new Element(this.tagName);
    clone.id = this.id;
    clone.dataset = { ...this.dataset };
    if (deep) this.children.forEach((child) => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
}

class FakeDocument {
  constructor() {
    this.body = new Element('body');
    this.head = new Element('head');
    this.currentScript = null;
    this.title = 'Host page';
  }

  createElement(tagName) {
    return new Element(tagName);
  }

  importNode(node, deep) {
    return node.cloneNode(deep);
  }

  getElementById(id) {
    return find(this.body, (node) => node.id === id) ?? find(this.head, (node) => node.id === id);
  }

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

function createShellDocument() {
  const shell = new FakeDocument();
  const main = shell.createElement('main');
  main.id = 'main-content';
  shell.body.appendChild(main);
  return shell;
}

function createHarness({ withScriptTag, fetchImpl }) {
  const document = new FakeDocument();
  document.currentScript = withScriptTag ? { src: launcherUrl } : null;
  const errors = [];
  const fetchCalls = [];
  const window = { location: new URL(hostUrl) };
  const context = {
    document,
    window,
    URL,
    DOMParser: class {
      parseFromString() { return createShellDocument(); }
    },
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return fetchImpl
        ? fetchImpl(url, options)
        : { ok: true, text: async () => '<html></html>' };
    },
    console: { error: (...args) => errors.push(args.join(' ')) },
  };
  window.console = context.console;
  return { context, document, errors, fetchCalls };
}

async function execute(harness) {
  vm.runInNewContext(launcherSource, harness.context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('raw WebView2 ExecuteScript-like execution bootstraps without document.currentScript', async () => {
  const harness = createHarness({ withScriptTag: false });

  await execute(harness);

  assert.equal(harness.errors.length, 0);
  assert.equal(harness.fetchCalls.length, 1);
  assert.match(harness.fetchCalls[0].url, /\/fixtures\/escalation\/frontend\/index\.html\?/);
  assert.equal(harness.fetchCalls[0].options.credentials, 'include');
  assert.ok(harness.document.querySelector('[data-demo-escalation-owned="root"]'));
  assert.equal(harness.document.getElementById('demo-escalation-bundle').src.startsWith('https://example.invalid/'), true);
});

test('script-tag execution remains supported', async () => {
  const harness = createHarness({ withScriptTag: true });

  await execute(harness);

  assert.equal(harness.errors.length, 0);
  assert.equal(harness.fetchCalls.length, 1);
  assert.match(harness.fetchCalls[0].url, /\/fixtures\/escalation\/frontend\/index\.html\?/);
});

test('script tag failure fails closed without fetching or executing JavaScript text', async () => {
  const harness = createHarness({
    withScriptTag: false,
    fetchImpl: async (url) => url.includes('/index.html')
      ? { ok: true, text: async () => '<html></html>' }
      : { ok: true, text: async () => 'window.__unsafeFetchedTextExecuted = true;' },
  });

  await execute(harness);
  harness.document.getElementById('demo-escalation-bundle').onerror(new Error('simulated WebView2 script load failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.errors.length, 1);
  assert.equal(harness.context.window.__unsafeFetchedTextExecuted, undefined);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.document.getElementById('demo-escalation-bundle'), null);
  assert.equal(harness.context.window.DEMO_ESCALATION_LAUNCHER_STATUS.stage, 'error');
});

test('launcher security scan rejects eval and Function-constructor execution', () => {
  assert.doesNotMatch(launcherSource, /\beval\s*\(/);
  assert.doesNotMatch(launcherSource, /\bnew\s+Function\b/);
  assert.doesNotMatch(launcherSource, /\bFunction\s*\(/);
});

test('fixed launcher keeps the approved live DEMO bindings and no mock mode', () => {
  assert.match(launcherSource, /https:\/\/example\.invalid\/sites\/DemoPortal\/fixtures\/escalation\/frontend\//);
  assert.match(launcherSource, /listTitle:\s*["']Demo Escalations["']/);
  assert.match(launcherSource, /vendorReferenceListTitle:\s*["']Demo Vendor Reference["']/);
  assert.match(launcherSource, /UniqueKey:\s*["']UniqueKey["']/);
  assert.match(launcherSource, /SourceQueue:\s*["']Source_x0020_Queue["']/);
  assert.doesNotMatch(launcherSource, /mode:\s*["']mock["']/i);
});
