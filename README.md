# Escalation App -- public sanitized pack

This is a local, executable, public-sanitized Escalation application repair candidate. It retains the included frontend entrypoints, service boundaries, flow definitions, package interfaces, fixtures, and local runtime behavior. Operational records, tenant identifiers, live connection bindings, personal data, screenshots, workbooks, mailbox exports, runtime databases, caches, and historical evidence are not included.

All data in this pack is deterministic and fictional. The flow packages are rebindable templates: connector API labels and Power Automate definition structure are retained, while URLs, IDs, connection references, names, emails, and embedded seed rows use placeholders.

For the portfolio overview, contribution scope and AI-assisted engineering context, see [PORTFOLIO_CONTEXT.md](PORTFOLIO_CONTEXT.md).

## Start here

1. Read [docs/README.md](docs/README.md).
2. Read [docs/SETUP.md](docs/SETUP.md) for local install, tests, and build commands.
3. Read [docs/FLOW_CATALOG.md](docs/FLOW_CATALOG.md) for the flow-by-flow contract map.
4. Read [docs/FICTIONAL_DATA.md](docs/FICTIONAL_DATA.md) before using any fixture.
5. Review [manifests/validation-manifest.json](manifests/validation-manifest.json) and [flows/flow-index.json](flows/flow-index.json).

## Local status boundary

All GREEN labels in this pack are local evidence only. The validation manifest records the exact commands and scopes. Tenant import, connection rebinding, saved-definition readback, and authenticated UAT remain `RED_EXTERNAL_GATE`.

The compatibility command `tools/flow-mock-runner.mjs` never calls a tenant. It invokes the independent definition executor, traverses the included trigger/actions/branches/expressions/`runAfter` graph, applies fixture connector responses and retry outcomes, and reports the preserved `LOCAL_MOCK_GREEN` interface only after definition execution succeeds. It does not copy `sourceContract`, `sanitizedContract`, or `contractPreserved` fields from the index into its result.

## Layout

- `frontend/` -- browser entrypoint, launcher, source modules, styles, and package scripts.
- `tests/frontend/` -- frontend contract and behavior tests.
- `flows/<slug>/` -- readable sanitized package entries for each complete flow.
- `packages/<slug>.zip` -- sanitized package archive with the original flow-package entry layout.
- `fixtures/flow-runs/` -- deterministic local trigger fixtures; no tenant calls.
- `tools/flow-definition-runner.mjs` -- definition-driven executor and validator.
- `tools/flow-mock-runner.mjs` -- compatibility wrapper for all 12 definition executions.
- `tools/flow-package-parity.mjs` -- deep readable JSON versus ZIP parity and deterministic ZIP generation.
- `tools/public-sanitization-scan.mjs` -- fail-closed regression scanner for identity, source labels, paths, IDs, email, secrets, encoding, controls, generated assets, and ZIP entry paths/content.
- `tests/flows/` -- execution, mutation, ID/binding/import-order, package parity, and external-gate tests.
- `manifests/` -- frontend/package contracts and validation manifests.

No publication, repository mutation, tenant import, tenant readback, or UAT is part of this pack.

## Complete local execution

The complete local path is documented in [PROJECT.md](PROJECT.md) and [docs/E2E_RUNBOOK.md](docs/E2E_RUNBOOK.md). It executes all twelve definitions and applies their evaluated connector effects to the same fake storage used by ETL, query/KPI behavior, dashboard counts, export, and handoff. Any tenant import, rebind, readback, or authenticated UAT remains an explicit external RED gate.

## Exact dependency list

The frontend has nine direct development dependencies. The package manifest keeps compatible ranges, while the lockfile records the exact resolved versions:

- `@eslint/js` `^10.0.1` -> `10.0.1`
- `@types/node` `^26.2.0` -> `26.2.0`
- `acorn` `^8.15.0` -> `8.18.0`
- `eslint` `^10.8.1` -> `10.8.1`
- `fflate` `^0.8.2` -> `0.8.3`
- `globals` `^17.9.0` -> `17.9.0`
- `typescript` `^7.0.2` -> `7.0.2`
- `webpack` `^5.99.9` -> `5.109.2`
- `webpack-cli` `^6.0.1` -> `6.0.1`

The lockfile also records every transitive package version. Use Node.js 20+ and npm 10+; validation used Node.js `24.18.0` and npm `10.9.4`.

Install from `frontend/` with `npm.cmd ci --ignore-scripts --no-audit --no-fund`. Do not package the resulting `node_modules/`; it is excluded dependency-install noise.
