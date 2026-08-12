import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries } from './flow-package-parity.mjs';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const knownPersonalTokens = [
  [66, 114, 117, 110, 111, 32, 100, 101, 32, 65, 108, 109, 101, 105, 100, 97, 32, 76, 111, 112, 101, 115],
  [98, 114, 117, 110, 111, 46, 100, 101, 97, 108, 109, 101, 105, 100, 97, 108, 111, 112, 101, 115],
].map((codes) => String.fromCharCode(...codes).toLowerCase());

// Fingerprints keep prohibited labels and plausible identities out of the scanner's own bytes.
const policyFingerprints = new Map([
  ['e1b5964b5cfe6734638bec8a55cd9518861c4ab9469a47ff6d106676017d3b2d', 'blocked-brand-label'],
  ['e6cdc8393637e696aea3be4926692f0cf0edb1de1161cf44b39551d5117954b7', 'blocked-brand-label'],
  ['3b419284568841cb50b62b2d240a9effd7c026c041036c0f3bae70830bf556fc', 'blocked-brand-label'],
  ['b2c01c8a8a0d9a99f145f099a963021f010dc608a8e992bd1a2aec958b48f32d', 'blocked-source-label'],
  ['fe512809396d3fd0dd129c0a532713baa2890973c2163732e5d2209328412afe', 'blocked-source-label'],
  ['9561ec7060925885f5870d0e0bf5fbfe761a5c5f66e2561632e0810d178e4d9f', 'blocked-source-label'],
  ['748d8735530048af931c59b9a6566dfc6d39276fa049c6050f1e75d324aad8da', 'blocked-source-label'],
  ['92d79b9c57ac7303c550f1ef2b85f9fc455119df6995c7839e2400f4c5150032', 'blocked-source-label'],
  ['567781541aa1d043041ec08be14e1c519629784e3952d0d079ac87640242ba5e', 'blocked-path-segment'],
  ['4dcf07fc1ad313cf7b0df6bebc270538d66310d49a03460423fd2d42514a69fc', 'blocked-path-segment'],
  ['60705d930a9ed84f11713adba200b45771941e03d093e84bd434def563b22a4c', 'unapproved-person-name'],
  ['ace38a1e94564bc697e011846939d420bacf572dc21ed1333cd180de6a02d50d', 'unapproved-person-name'],
  ['15999420ccb4bafb1e7c7a4941770e1d8429c95a8428f57e2a2d6b92a1309f19', 'unapproved-person-name'],
  ['8e65cf41578493db759b8b8be16040cbcc0f5cd6b0aa785c272e0437abdf694e', 'unapproved-person-name'],
  ['0f7e61193f32d4da60dc1f6247859d03564d9310e93d5aa415627b3d9132c23d', 'unapproved-person-name'],
  ['dab90c8ba75072cf033fa47a0b61796ec48652b70e95b8583eb2bf90bfc7dead', 'unapproved-person-name'],
  ['488daacbc5c1cbe340cfd3f106c1b077856637c33b8657330646d7c096d9e204', 'unapproved-person-name'],
  ['6b5eae355a6d9fbc9fa2cbe63e8e30b7b9ab3d830a962b1f4811d13b745cb2ae', 'unapproved-person-name'],
]);

const absoluteUserPathPatterns = [
  /(?:[a-z]:\\|\\\\[^\\]+\\)users\\[^\\\s"']+/iu,
  /\/(?:users|home)\/[^/\s"']+/iu,
];
const emailPattern = /[\w.+-]+@([\w.-]+\.[a-z]{2,})/giu;
const guidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const placeholderGuidPattern = /^00000000-0000-4000-8000-[0-9a-f]{12}$/iu;
const secretPatterns = [
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu,
  /\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{20,}\b/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu,
];
const excludedDirectoryNames = new Set(['.cache', '.git', '.pytest_cache', '.venv', '__pycache__', 'coverage', 'node_modules', 'venv']);
const allowedHostSuffixes = [
  'eslint.org', 'github.com', 'json-schema.org', 'microsoft.com', 'npmjs.org', 'opencollective.com',
  'schema.management.azure.com', 'tidelift.com', 'webpack.js.org',
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const findingKey = ({ rule, path: findingPath }) => `${findingPath}:${rule}`;

function fingerprintFindings(text) {
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const rules = new Set();
  for (let index = 0; index < words.length; index += 1) {
    for (let size = 1; size <= 2 && index + size <= words.length; size += 1) {
      const rule = policyFingerprints.get(sha256(words.slice(index, index + size).join(' ')));
      if (rule) rules.add(rule);
    }
  }
  return rules;
}

function hasMojibake(text) {
  for (let index = 0; index < text.length - 1; index += 1) {
    const first = text.charCodeAt(index);
    const second = text.charCodeAt(index + 1);
    if ((first === 194 || first === 195) && second >= 128 && second <= 191) return true;
  }
  return false;
}

function hasForbiddenControl(text) {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 31 && ![9, 10, 13].includes(code)) || code === 127) return true;
  }
  return false;
}

function hasUnapprovedHost(text) {
  for (const match of text.matchAll(/https?:\/\/[^\s"')]+/giu)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      const allowed = ['127.0.0.1', 'localhost', 'example'].includes(host)
        || host.endsWith('.example')
        || host.endsWith('example.invalid')
        || allowedHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
      if (!allowed) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function scanText(text, relativePath) {
  const rules = fingerprintFindings(text);
  const lower = text.toLowerCase();
  if (knownPersonalTokens.some((token) => lower.includes(token))) rules.add('known-personal-token');
  if (absoluteUserPathPatterns.some((pattern) => pattern.test(text))) rules.add('absolute-user-path');
  for (const match of text.matchAll(emailPattern)) {
    const domain = match[1].toLowerCase();
    if (domain !== 'example.invalid' && !domain.endsWith('.example.invalid')) rules.add('non-reserved-email');
  }
  for (const match of text.matchAll(guidPattern)) {
    if (!placeholderGuidPattern.test(match[0])) rules.add('non-placeholder-guid');
  }
  if (secretPatterns.some((pattern) => pattern.test(text))) rules.add('secret-pattern');
  if (hasForbiddenControl(text)) rules.add('forbidden-control');
  if (text.includes(String.fromCharCode(65533))) rules.add('replacement-character');
  if (hasMojibake(text)) rules.add('mojibake');
  if (hasUnapprovedHost(text)) rules.add('unapproved-host');
  return [...rules].map((rule) => ({ rule, path: relativePath }));
}

function scanBytes(bytes, relativePath) {
  let text;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return [{ rule: 'invalid-utf8', path: relativePath }];
  }
  return scanText(text, relativePath);
}

function collectFiles(root, { ignoreInstalledDependencies = false } = {}) {
  const files = [];
  const findings = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolute).replaceAll(path.sep, '/');
      findings.push(...scanText(relativePath, relativePath));
      if (entry.isSymbolicLink()) {
        findings.push({ rule: 'forbidden-pack-artifact', path: relativePath });
      } else if (entry.isDirectory() && excludedDirectoryNames.has(entry.name.toLowerCase())) {
        if (!(ignoreInstalledDependencies && relativePath === 'frontend/node_modules')) {
          findings.push({ rule: 'forbidden-pack-artifact', path: relativePath });
        }
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        if (relativePath.toLowerCase().endsWith('.map') || relativePath.startsWith('artifacts/')) {
          findings.push({ rule: 'forbidden-pack-artifact', path: relativePath });
        }
        files.push({ absolute, relativePath });
      }
    }
  };
  visit(root);
  return { files, findings };
}

export async function scanPublicPack(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const { files, findings } = collectFiles(resolvedRoot, options);
  for (const { absolute, relativePath } of files) {
    if (relativePath.toLowerCase().endsWith('.zip')) {
      for (const [entryPath, bytes] of readZipEntries(absolute, { root: toolRoot })) {
        const locator = `${relativePath}!${entryPath}`;
        findings.push(...scanText(entryPath, locator));
        findings.push(...scanBytes(bytes, locator));
      }
    } else {
      findings.push(...scanBytes(readFileSync(absolute), relativePath));
    }
  }
  return [...new Map(findings.map((finding) => [findingKey(finding), finding])).values()]
    .sort((left, right) => findingKey(left).localeCompare(findingKey(right)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : toolRoot;
  const findings = await scanPublicPack(target);
  process.stdout.write(`${JSON.stringify({ target: path.basename(target), findings }, null, 2)}\n`);
  if (findings.length > 0) process.exitCode = 1;
}
