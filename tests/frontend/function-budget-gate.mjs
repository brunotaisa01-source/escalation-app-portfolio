import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadParser() {
  try {
    return (await import('acorn')).parse;
  } catch (error) {
    const fallback = process.env.DEMO_ESCALATION_ACORN_PATH;
    if (!fallback) throw new Error(`Acorn parser is required for STRUCTURE_GATE: ${error.message}`, { cause: error });
    return (await import(pathToFileURL(fallback).href)).parse;
  }
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  }));
  return groups.flat();
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => walk(entry, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

const parse = await loadParser();
const root = path.resolve(import.meta.dirname, '..', '..', 'frontend', 'src');
const violations = [];
for (const file of await filesUnder(root)) {
  const content = await readFile(file, 'utf8');
  const ast = parse(content, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  walk(ast, (node) => {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
    const lines = node.loc.end.line - node.loc.start.line + 1;
    if (lines > 80) violations.push({ file: path.relative(root, file), name: node.id?.name ?? '<anonymous>', lines, start: node.loc.start.line });
  });
}
assert.deepEqual(violations, [], `Non-generated functions exceed 80 lines:\n${JSON.stringify(violations, null, 2)}`);
console.log(JSON.stringify({ ok: true, parsedRoot: root, functionBudget: 80 }, null, 2));
