# Complete flow catalog

All twelve flow definitions are included twice: as readable JSON under `flows/<slug>/` and as sanitized package archives under `packages/<slug>.zip`. The package archives retain the native entry layout (`manifest.json`, flow manifest, API map, connection map, and definition) with placeholder identifiers.

| Flow | Trigger | Actions | Branches | Expressions | `runAfter` | Explicit retry policy |
|---|---:|---:|---:|---:|---:|---:|
| `bootstrap-lists` | 1 manual | 6 | 2 | 8 | 3 | 0 |
| `add-columns-and-views` | 1 manual | 9 | 3 | 10 | 5 | 0 |
| `user-access-matrix` | 1 manual | 28 | 11 | 24 | 17 | 0 |
| `seed-cases-01` | 1 manual | 7 | 2 | 36 | 4 | 0 |
| `seed-cases-02` | 1 manual | 7 | 2 | 36 | 4 | 0 |
| `seed-vendors-01` | 1 manual | 7 | 2 | 13 | 4 | 0 |
| `seed-vendors-02` | 1 manual | 7 | 2 | 13 | 4 | 0 |
| `manual-move-trigger-test` | 1 mailbox trigger | 2 | 0 | 0 | 1 | 0 |
| `ingest-queue-west` | 1 recurrence | 11 | 4 | 15 | 6 | 0 |
| `ingest-queue-north` | 1 recurrence | 11 | 4 | 15 | 6 | 0 |
| `ingest-queue-east` | 1 recurrence | 11 | 4 | 15 | 6 | 0 |
| `ingest-queue-south` | 1 recurrence | 11 | 4 | 15 | 6 | 0 |

Counting convention: actions are recursive action nodes; branches are `Foreach`, `If`, or `Scope` nodes; expressions are strings beginning with `@` or containing `@{`; and `runAfter` is the number of dependency edges with recorded terminal statuses. These are the same conventions used by the deep crosswalk.

## Flow-by-flow behavior

- `bootstrap-lists` initializes list definitions and field definitions, then iterates them through connector actions. Site and list bindings are placeholders.
- `add-columns-and-views` initializes view, view-field, and index definitions and applies each collection through connector actions.
- `user-access-matrix` performs list, principal, and role preflight; validates approved binding shapes; applies access changes; validates the result; and retains compensation/reset and termination branches.
- `seed-cases-01` and `seed-cases-02` initialize dry-run and seed payload variables, filter embedded fixture records, check lookup/deduplication state, and iterate case writes.
- `seed-vendors-01` and `seed-vendors-02` use the same dry-run, lookup, and iteration boundaries for the fictional vendor reference fixture.
- `manual-move-trigger-test` retains its mailbox trigger and terminal success path, but its mailbox and connection bindings are placeholders.
- The four `ingest-queue-*` flows retain their recurrence window, query, iteration, conditional, connector, wait, and termination branches. Queue labels, mailbox addresses, site paths, and resource identifiers are fictional.

The included canonical definitions contain no explicit `retryPolicy` nodes; the recorded count is therefore zero for every flow. The executor nevertheless supports fixture-driven retry/error outcomes, and mutation tests cover retry/error handoff behavior. Existing `runAfter`, conditional, scope, compensation, and termination structures are executed locally from the definitions.

## External gates

For every flow, the following remain `RED_EXTERNAL_GATE` in the flow and validation manifests:

1. Import into a real automation environment.
2. Rebind the imported package to approved tenant connections and resources.
3. Read back the saved definition and connection bindings.
4. Run authenticated end-to-end UAT.

None of these gates is claimed as executed.
