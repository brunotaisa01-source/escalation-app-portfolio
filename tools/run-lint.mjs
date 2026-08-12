import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(packRoot, "frontend", "package.json"));
const { ESLint } = require("eslint");

const eslint = new ESLint({
  cwd: packRoot,
  overrideConfigFile: path.join(packRoot, "eslint.config.js"),
});

const results = await eslint.lintFiles([
  "frontend/src/**/*.js",
  "frontend/launcher/**/*.js",
  "frontend/webpack.config.cjs",
  "runtime/**/*.mjs",
  "tools/**/*.mjs",
  "tests/**/*.js",
  "tests/**/*.mjs",
]);
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);

if (output) {
  process.stdout.write(output);
}

const errorCount = results.reduce((total, result) => total + result.errorCount, 0);
const warningCount = results.reduce((total, result) => total + result.warningCount, 0);
console.log(`Linted ${results.length} files: ${errorCount} errors, ${warningCount} warnings.`);

if (errorCount > 0) {
  process.exitCode = 1;
}
