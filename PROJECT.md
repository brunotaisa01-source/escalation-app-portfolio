# Escalation App portfolio pack

## Purpose

This is a public-sanitized repair candidate for a generic Escalation application. It includes the frontend, service/query contracts, local backend adapter boundary, ETL/loaders, twelve automation definitions and ZIP packages, fixtures, tests, handoff output contracts, and documented interfaces. Tenant-specific branding, URLs, identifiers, live connection bindings, personal identities, operational rows, screenshots, workbooks, runtime databases, logs, and historical evidence are replaced with synthetic placeholders or excluded. Pre-generated runtime outputs are not included in the destination.

## Architecture

### Frontend

`frontend/public/index.html` is the browser shell. `frontend/launcher/escalation-launcher.js` owns same-origin shell loading, root ownership, rollback, and bundle loading. `frontend/src/index.js` starts the workbench. Domain modules contain status, date, ID, filtering, and vendor rules. Service modules contain query construction, transport, pagination, KPI coordination, save/readback boundaries, vendor lookup, export, and client traversal. UI modules contain the dashboard, filters, editor, paging, KPI, save, refresh, current-user, and vendor interactions.

### Backend and storage boundary

The production boundary is represented by the SharePoint-compatible service and query contracts in `frontend/src/services/`. The local backend substitute is `runtime/fake-connector.mjs`: it owns deterministic JSON-like list state, schema/view setup, placeholder access bindings, validation, idempotent upsert, deduplication, flow-call effects, ETL rows, storage snapshots, query, dashboard counts, and export reads. The definition executor's evaluated connector calls update this same state before query and export. No network call is made by the local path.

### ETL and loaders

The readable definitions under `flows/` are canonical for this pack. Tests prove deep JSON parity with all twelve ZIPs and execute supported trigger, action, expression, branch, `runAfter`, connector, retry/error, and terminal/handoff behavior against deterministic fixtures. Unsupported structures fail with the definition path and action path. This local evidence is not tenant-runtime evidence.

### Flows

There are twelve sanitized complete flow packages: list bootstrap, columns/views, access matrix, two case seed chunks, two vendor-reference seed chunks, a manual trigger test, and four recurrence queue flows. Each has readable JSON plus a sanitized ZIP. The package structure is retained; connection IDs and resource IDs are deterministic placeholders.

## Tools and versions

- Node.js 20 or newer and npm 10 or newer are required; validation used Node.js `24.18.0` and npm `10.9.4`.
- npm is used for dependency installation and scripts. The exact transitive dependency graph is retained in `frontend/package-lock.json`.
- Webpack 5 and webpack-cli 6 build the browser bundle.
- ESLint 10 performs a real lint pass over frontend source/launcher, runtime, tools, and tests.
- TypeScript 7 runs `checkJs` over the existing JavaScript domain modules, CSV export, and launcher scope declared in `frontend/jsconfig.json`.
- Node's built-in test runner executes JavaScript and ESM tests.
- Python 3.11+ is optional and is not required for the local runtime path.
- No cloud connector, tenant credential, browser session, database server, or external service is required for local tests.

## Prerequisites and setup

From the pack root:

```powershell
Set-Location frontend
npm.cmd ci --ignore-scripts --no-audit --no-fund
```

Direct development dependencies (manifest range -> lockfile version) are:

- `@eslint/js` `^10.0.1` -> `10.0.1`
- `@types/node` `^26.2.0` -> `26.2.0`
- `acorn` `^8.15.0` -> `8.18.0`
- `eslint` `^10.8.1` -> `10.8.1`
- `fflate` `^0.8.2` -> `0.8.3`
- `globals` `^17.9.0` -> `17.9.0`
- `typescript` `^7.0.2` -> `7.0.2`
- `webpack` `^5.99.9` -> `5.109.2`
- `webpack-cli` `^6.0.1` -> `6.0.1`

The lockfile is the exact list for all transitive packages. Do not distribute `node_modules`; it is excluded dependency-install noise from the temporary validation workspace.

## Fake data and placeholders

All records use `FIX-` or `DEMO-` identifiers, explicit `Fixture Owner NN` labels, `example.invalid` email/host values, deterministic dates, and small non-operational amounts. Flow packages use placeholder UUIDs and placeholder connection resources. The runtime config is unbound and the local connector is the default executable path. Real binding requires a separate approved integration task.

## Commands

Run from `frontend/`:

```powershell
npm.cmd test
npm.cmd run test:flows
npm.cmd run test:security
npm.cmd run test:e2e
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
npm.cmd run e2e
```

Run from the pack root:

```powershell
node tools/flow-mock-runner.mjs
node tools/local-e2e.mjs
```

`npm.cmd run e2e` prints the result and does not write into the pack. To request evidence files, set `ESCALATION_E2E_OUTPUT_ROOT` to a caller-controlled directory outside the pack; the runner then writes `local-handoff.json`, `local-storage-snapshot.json`, and `local-export.csv` there.

## Test inventory

- `tests/frontend/` covers launcher ownership/rollback, UI landmarks, accessibility contracts, services, filters, pagination, save/readback, CSV export, KPI behavior, and review regressions.
- `tests/flows/` checks all twelve definition executions, deep readable/ZIP parity, mutation failures, unique IDs, explicit import order, required binding occurrences, fixtures, and external RED gates.
- `tests/e2e/local-e2e.test.mjs` checks all twelve definitions -> shared local state -> ETL rows -> query -> dashboard -> export -> handoff, byte-identical CSV output under different wall-clock dates, and a definition mutation that must alter exported state.
- `tests/security/public-sanitization.test.mjs` scans filenames, text, generated assets, and ZIP paths/content and proves negative controls for identity, labels, paths, IDs, email, secrets, UTF-8, controls, replacement characters, mojibake, and dependency artifacts.
- `frontend/package.json` is the authoritative command list; `manifests/validation-manifest.json` records the latest repair verification evidence and remaining external gates.

## Mocks and placeholders

`runtime/fake-connector.mjs` is the storage/ETL/query mock. `tools/flow-definition-runner.mjs` is the independent local definition executor; `tools/flow-mock-runner.mjs` preserves the existing wrapper interface. `fixtures/flow-runs/` supplies one local trigger/connector fixture per flow. `frontend/src/config/runtime-config.example.js` exposes field mapping and governed catalogs without a live binding. No placeholder is a production credential.

## Limitations and external gates

Local GREEN evidence does not prove connector authentication, tenant permissions, import acceptance, rebinding, saved-definition readback, real mailbox behavior, generated cloud outputs, or authenticated UAT. Tenant import, tenant rebind, tenant readback, and authenticated UAT remain `RED_EXTERNAL_GATE`. Any scan or local gate not recorded as completed in `manifests/validation-manifest.json` must be treated as unproven.

## Public-safe use

Use this pack for code review, architecture discussion, local tests, UI inspection, flow-shape review, ETL demonstrations, and portfolio evaluation. Do not add real tenant URLs, credentials, connection IDs, personal data, mailbox exports, workbooks, screenshots, runtime evidence, or private repository metadata. Re-run the full scans after any fixture, generated asset, ZIP, or documentation change.

## Troubleshooting

- Dependency failure: verify Node.js 20+ and npm 10+, then run `npm.cmd ci --ignore-scripts --no-audit --no-fund` from `frontend/`.
- Test failure: run the failing command alone, read the first assertion failure, and preserve RED status until reproduced and fixed.
- Build failure: check `frontend/webpack.config.cjs`, dependency installation, and generated `frontend/dist/` contents.
- Flow mismatch: run `npm.cmd run test:flows` and inspect the reported definition/ZIP JSON path or action path.
- E2E count drift: inspect the readable flow definitions, `fixtures/flow-runs/`, and `runtime/fake-connector.mjs`; the E2E does not preload expected case/vendor results.
- External gate question: local mock results never clear an external RED gate.
