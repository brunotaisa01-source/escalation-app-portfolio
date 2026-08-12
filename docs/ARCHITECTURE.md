# Architecture and validation map

This document gives a visual map of the public Escalation App pack. It is documentation only: the application logic, flow definitions, fixtures, package layout and tests are unchanged.

For the cross-repository view, see the [portfolio architecture map](PORTFOLIO_MAP.md).

## Runtime flow

```mermaid
flowchart LR
  F["Synthetic trigger fixtures\nfixtures/flow-runs"] --> D["12 readable flow definitions\nflows/"]
  Z["Sanitized ZIP packages\npackages/"] <--> P["Readable/ZIP parity checks"]
  D --> E["Independent definition executor\ntools/flow-definition-runner.mjs"]
  E --> C["Local fake connector\nruntime/fake-connector.mjs"]
  C --> S["Shared local state\nlists, ETL rows, snapshots"]
  S --> Q["Service and query contracts\nfilters, paging, KPIs"]
  Q --> U["Frontend workbench\nfrontend/"]
  U --> O["CSV export and handoff output"]
  E --> R["Branches, expressions, runAfter, retry/error paths"]
  D --> P
  Z --> P
```

The local executor evaluates the included definitions against deterministic fixtures. The resulting state is then consumed by the same local ETL, query, dashboard and export path. No network connector or tenant is required for this local flow.

## Test and status flow

```mermaid
flowchart LR
  A["Frontend contract and behavior tests"] --> M["Validation manifest"]
  B["Flow execution, mutation and ZIP parity tests"] --> M
  C["Security and sanitization regression tests"] --> M
  D["Local E2E: definitions -> state -> ETL -> query -> dashboard -> export"] --> M
  E["Lint, typecheck, build and browser smoke"] --> M
  M --> G["GREEN_LOCAL\nlocal evidence only"]
  X["Tenant import, rebind, readback and authenticated UAT\nnot exercised in this pack"] --> R["RED_EXTERNAL_GATE"]
```

`GREEN_LOCAL` means that the recorded local command and scope passed. It does not prove connector authentication, tenant permissions, cloud import, saved-definition readback or authenticated UAT. The external items remain explicitly `RED_EXTERNAL_GATE` in the manifests.

## Main entrypoints

- `frontend/package.json` is the authoritative JavaScript command list.
- `tools/flow-definition-runner.mjs` is the independent local definition executor.
- `tools/flow-mock-runner.mjs` preserves the compatibility wrapper for all twelve definitions.
- `tools/local-e2e.mjs` exercises the shared local state through export and handoff.
- `manifests/validation-manifest.json` records the latest local evidence and remaining external gates.
