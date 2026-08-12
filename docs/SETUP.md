# Setup and usage

## Prerequisites

- Node.js 20 or newer.
- npm available as `npm.cmd` on Windows.
- Python 3.11+ is optional and is not needed for the frontend or flow tests.

## Install

From this directory:

```powershell
Set-Location frontend
npm.cmd ci --ignore-scripts --no-audit --no-fund
```

The install creates local development dependencies from the lockfile. Do not copy `node_modules` into a distribution archive; it is excluded packaging noise.

## Test and build

```powershell
npm.cmd test
npm.cmd run test:flows
npm.cmd run test:e2e
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

`npm.cmd test` runs the frontend, flow, package parity, mutation, and sanitization regression suites. The flow suite executes every readable definition with deterministic connector fixtures, checks all twelve ZIPs against their readable canonical JSON, and asserts that tenant gates remain RED. `typecheck` is TypeScript `checkJs` over the scope declared in `frontend/jsconfig.json`; `lint` covers frontend source/launcher, runtime, tools, and tests. The build writes the browser bundle to `frontend/dist/`.

## Local mock execution

```powershell
node tools/flow-mock-runner.mjs
```

The command emits JSON with one compatibility `LOCAL_MOCK_GREEN` result per flow after the independent definition executor traverses the definition and fixture responses. It does not use credentials, network access, a browser session, or a tenant, and it does not use index contract fields as execution results.

## Runtime binding

`frontend/src/config/runtime-config.example.js` is deliberately unbound. To exercise the SharePoint adapter, inject a configuration object using the documented field mapping and placeholder-safe site/list values. A real connection, authenticated readback, or UAT is outside this pack and remains an external RED gate.

## Full local path

From the `frontend/` directory:

```powershell
npm.cmd run e2e
```

This executes all twelve readable definitions in index order. Exact connector fixtures drive triggers, actions, branches, expressions, `runAfter`, failures/retries, and outputs; evaluated successful calls mutate the same fake storage used by the dashboard and CSV. The two seed pairs deduplicate to three case and three vendor rows, and the four recurrence definitions add four ETL rows/cases. It never calls a network connector and does not write runtime output into the pack.

To write handoff evidence to a caller-controlled directory, set `ESCALATION_E2E_OUTPUT_ROOT` before the command:

```powershell
$env:ESCALATION_E2E_OUTPUT_ROOT = '.\scratch\escalation-e2e'
npm.cmd run e2e
```

The local E2E path uses `runtime/fake-connector.mjs`, not the network adapter. A real connection, authenticated readback, or UAT is outside this pack and remains an external RED gate.
