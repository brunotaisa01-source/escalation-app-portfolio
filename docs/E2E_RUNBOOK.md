# Local end-to-end runbook

The local path is a deterministic substitute for tenant execution. It uses the same logical field names and service/query contracts, but a fake connector and JSON fixtures.

## Sequence

1. `bootstrap-lists`, `add-columns-and-views`, and `user-access-matrix` execute their definitions and apply evaluated local connector effects.
2. `seed-cases-01`, `seed-cases-02`, `seed-vendors-01`, and `seed-vendors-02` run with writes enabled; lookup outputs come from current fake state, so the second chunks take real deduplication branches.
3. `manual-move-trigger-test` executes its trigger, Compose, `runAfter`, and Terminate handoff.
4. `ingest-queue-west`, `ingest-queue-north`, `ingest-queue-east`, and `ingest-queue-south` evaluate the Europe/London weekday window and add four distinct ETL rows through their connector actions.
5. `dashboard-query` and `open-query` read the state produced by those definitions through the existing case-service contracts.
6. `csv-export` uses the existing CSV contract, formula neutralization, and injected `deterministicNow` for calendar-day age and filename generation.
7. `handoff-output` remains a contract unless the caller supplies an external output directory.

## Outputs

By default the command prints JSON and leaves the pack clean. If `ESCALATION_E2E_OUTPUT_ROOT` is set to a caller-controlled directory, it writes:

- `local-handoff.json` -- observed sequence, counts, query evidence, flow results, and external gate statuses.
- `local-storage-snapshot.json` -- fake lists, ETL rows, evaluated connector effects, flow outputs, and history.
- `local-export.csv` -- deterministic dashboard export; the golden fixture hash is asserted by `tests/e2e/local-e2e.test.mjs`.

## Expected local assertions

- Seven cases: three deduplicated seed fixtures plus four definition-driven recurrence rows.
- Three vendor-reference rows.
- Four ETL rows, six open cases, and one closed case.
- Twelve definition executions report `LOCAL_MOCK_GREEN` and are present in the exported state.
- Connector effects are observed from evaluated actions; tenant calls are derived as zero because every transport is local.
- Import, readback, and authenticated UAT remain `RED_EXTERNAL_GATE`.
- Runs with different wall clocks and the same `deterministicNow` produce byte-identical CSV output.
- Mutating a seed definition changes exported CSV, so expected data cannot mask definition drift.

## Troubleshooting

- If `npm install` fails, verify Node.js 20+ and registry access; no tenant credentials are needed.
- If a flow test reports a mismatch, inspect the definition/action path or readable/ZIP JSON path in the failure; do not update a ZIP independently of its readable canonical definition.
- If the E2E count changes, inspect the readable definitions, exact flow fixtures, and fake-state adapter for accidental drift.
- If the build cannot find dependencies, run `npm.cmd install` from `frontend/`, then retry the build.
- A local GREEN result never clears an external tenant gate.
