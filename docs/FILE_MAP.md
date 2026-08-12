# File map

| Area | Path | Contract preserved |
|---|---|---|
| Browser shell | `frontend/public/index.html` | App root and stable UI landmarks |
| Launcher | `frontend/launcher/escalation-launcher.js` | Same-origin HTTPS shell, ownership, rollback, and bundle loading |
| Browser entrypoint | `frontend/src/index.js` | Module entrypoint |
| Domain logic | `frontend/src/domain/` | IDs, status policy, dates, filtering, vendor matching |
| Services | `frontend/src/services/` | Query, transport, pagination, export, save, and reference boundaries |
| UI | `frontend/src/ui/` | Workbench, editor, filters, paging, save, KPI, and vendor flows |
| Frontend contracts | `manifests/frontend-contract.json` and `manifests/schema.json` | UI and field contract shapes |
| Flow source | `flows/<slug>/` | Readable package entries for all 12 flows |
| Flow packages | `packages/<slug>.zip` | Deep JSON parity with each readable canonical definition/package entry |
| Flow fixtures | `fixtures/flow-runs/` | Deterministic trigger inputs, connector outputs, error/retry states, and expected status |
| Definition executor | `tools/flow-definition-runner.mjs` | No-tenant definition traversal and validation |
| Compatibility runner | `tools/flow-mock-runner.mjs` | Preserved local runner interface backed by definition execution |
| Flow/package tests | `tests/flows/` | Execution, mutation, parity, ID, import-order, binding, and external-gate checks |
| Sanitization regression | `tools/public-sanitization-scan.mjs` and `tests/security/` | Text and ZIP personal-identity/absolute-path scan plus catching mutations |

The source was intentionally not copied wholesale: operational archives, binary evidence, caches, historical snapshots, and tenant-bound artifacts are excluded from this pack.

The functional layers are present: browser UI, launcher, domain rules, service/query contracts, fake backend/storage adapter, ETL validation and loaders, twelve flow definitions and ZIPs, independent local definition executor, end-to-end runner, fixtures, tests, and handoff output contracts. Runtime outputs are generated only in the caller's execution workspace and are not shipped in this destination. This inventory does not imply successful tenant import or runtime behavior.
