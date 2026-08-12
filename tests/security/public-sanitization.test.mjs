import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackageArchive } from '../../tools/flow-package-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fromCodes = (...codes) => String.fromCharCode(...codes);
const testScratch = path.resolve(process.env.ESCALATION_TEST_SCRATCH ?? tmpdir(), 'security-mutations');
mkdirSync(testScratch, { recursive: true });
const mutationRoot = (suffix) => mkdtempSync(path.join(testScratch, `escalation-${suffix}-`));
let scanPublicPack;
let importFailure;

try {
  ({ scanPublicPack } = await import('../../tools/public-sanitization-scan.mjs'));
} catch (error) {
  importFailure = error;
}

test('public-pack scanner is executable', () => {
  assert.equal(importFailure, undefined, importFailure?.message);
  assert.equal(typeof scanPublicPack, 'function');
});

test('public source bytes contain no findings when the local installed dependency tree is excluded', async () => {
  assert.equal(typeof scanPublicPack, 'function');
  const findings = await scanPublicPack(root, { ignoreInstalledDependencies: true });
  assert.deepEqual(findings, []);
});

test('scanner rejects a personal token and an absolute Windows user path', async () => {
  assert.equal(typeof scanPublicPack, 'function');
  const fixtureRoot = mutationRoot('identity-path');
  const personalName = String.fromCharCode(66, 114, 117, 110, 111, 32, 100, 101, 32, 65, 108, 109, 101, 105, 100, 97, 32, 76, 111, 112, 101, 115);
  const userPath = [fromCodes(67, 58), fromCodes(85, 115, 101, 114, 115), fromCodes(112, 114, 105, 118, 97, 116, 101), fromCodes(112, 114, 111, 106, 101, 99, 116)].join('\\');
  try {
    writeFileSync(path.join(fixtureRoot, 'fixture.txt'), `${personalName}\n${userPath}\n`, 'utf8');
    const findings = await scanPublicPack(fixtureRoot);
    assert.deepEqual(findings.map(({ rule }) => rule).sort(), ['absolute-user-path', 'known-personal-token']);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('scanner rejects brand, person, email, ID, path segment and secret mutations', async () => {
  assert.equal(typeof scanPublicPack, 'function');
  const fixtureRoot = mutationRoot('policy');
  const values = [
    fromCodes(70, 83, 71),
    fromCodes(71, 101, 114, 109, 97, 110, 121),
    fromCodes(65, 108, 101, 120, 32, 77, 111, 114, 103, 97, 110),
    fromCodes(117, 115, 101, 114, 64, 101, 120, 97, 109, 112, 108, 101, 46, 99, 111, 109),
    fromCodes(49, 50, 51, 52, 53, 54, 55, 56, 45, 49, 50, 51, 52, 45, 52, 49, 50, 51, 45, 56, 49, 50, 51, 45, 49, 50, 51, 52, 53, 54, 55, 56, 57, 48, 49, 50),
    fromCodes(79, 110, 101, 68, 114, 105, 118, 101),
    fromCodes(65, 75, 73, 65, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80),
  ];
  try {
    writeFileSync(path.join(fixtureRoot, 'fixture.txt'), `${values.join('\n')}\n`, 'utf8');
    const rules = (await scanPublicPack(fixtureRoot)).map(({ rule }) => rule).sort();
    assert.deepEqual(rules, [
      'blocked-brand-label',
      'blocked-path-segment',
      'blocked-source-label',
      'non-placeholder-guid',
      'non-reserved-email',
      'secret-pattern',
      'unapproved-person-name',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('scanner rejects invalid UTF-8, forbidden controls, replacement characters and mojibake', async () => {
  assert.equal(typeof scanPublicPack, 'function');
  const fixtureRoot = mutationRoot('encoding');
  try {
    writeFileSync(path.join(fixtureRoot, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    writeFileSync(path.join(fixtureRoot, 'control.txt'), Buffer.from([65, 1, 66, 127]));
    writeFileSync(path.join(fixtureRoot, 'replacement.txt'), fromCodes(65533), 'utf8');
    writeFileSync(path.join(fixtureRoot, 'mojibake.txt'), fromCodes(67, 97, 102, 195, 169), 'utf8');
    const rules = (await scanPublicPack(fixtureRoot)).map(({ rule }) => rule).sort();
    assert.deepEqual(rules, ['forbidden-control', 'invalid-utf8', 'mojibake', 'replacement-character']);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('scanner rejects dependency artifacts and blocked filename segments', async () => {
  assert.equal(typeof scanPublicPack, 'function');
  const fixtureRoot = mutationRoot('paths');
  const dependencyRoot = path.join(fixtureRoot, 'frontend', 'node_modules', 'fixture-package');
  mkdirSync(dependencyRoot, { recursive: true });
  const blockedFilename = `${fromCodes(65, 112, 112, 68, 97, 116, 97)}.txt`;
  try {
    writeFileSync(path.join(dependencyRoot, 'fixture.txt'), 'dependency bytes', 'utf8');
    writeFileSync(path.join(fixtureRoot, blockedFilename), 'safe bytes', 'utf8');
    assert.deepEqual((await scanPublicPack(fixtureRoot)).map(({ rule }) => rule).sort(), [
      'blocked-path-segment',
      'forbidden-pack-artifact',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('scanner inspects text and entry paths inside ZIP files', async () => {
  assert.equal(typeof scanPublicPack, 'function');
  const fixtureRoot = mutationRoot('zip');
  const personalName = String.fromCharCode(66, 114, 117, 110, 111, 32, 100, 101, 32, 65, 108, 109, 101, 105, 100, 97, 32, 76, 111, 112, 101, 115);
  const definition = JSON.parse(readFileSync(path.join(root, 'flows', 'manual-move-trigger-test', 'definition.json'), 'utf8'));
  definition.properties.displayName = personalName;
  try {
    createPackageArchive({
      root,
      slug: 'manual-move-trigger-test',
      outputPath: path.join(fixtureRoot, `${fromCodes(79, 110, 101, 68, 114, 105, 118, 101)}.zip`),
      overrides: { definition },
    });
    const findings = await scanPublicPack(fixtureRoot);
    assert.equal(findings.some(({ rule }) => rule === 'blocked-path-segment'), true);
    assert.equal(findings.some(({ rule, path: findingPath }) => rule === 'known-personal-token' && findingPath.includes('!')), true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
