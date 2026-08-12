# Documentation index

This pack separates local evidence from external deployment evidence.

## Reading order

1. [SETUP.md](SETUP.md) -- installation, usage, tests, lint, typecheck, and build.
2. [FILE_MAP.md](FILE_MAP.md) -- entrypoints and pack mapping.
3. [FLOW_CATALOG.md](FLOW_CATALOG.md) -- complete flow inventory and locally tested behavior.
4. [FICTIONAL_DATA.md](FICTIONAL_DATA.md) -- fixture policy and rebinding rules.
5. [../manifests/validation-manifest.json](../manifests/validation-manifest.json) -- gate statuses and evidence paths.
6. [../flows/flow-index.json](../flows/flow-index.json) -- machine-readable flow inventory; recorded static signatures are documentary and are not executor output.

## Evidence labels

- **LOCAL GREEN** means a fresh command completed against this pack only and with the scope recorded in the validation manifest.
- **RED EXTERNAL GATE** means the check requires a real tenant, authenticated identity, approved binding, or external service and was intentionally not executed.
- **EXCLUDED** means the artifact was not copied because it contained operational or non-sanitizable data.

The pack retains public product/interface terms needed by the code, but no organization-specific tenant token, internal URL, operational mailbox, personal identity, or real row payload is retained.
