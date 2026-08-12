# Fictional data and rebinding policy

Every value under `fixtures/` and every embedded seed record in the sanitized flow definitions is deterministic and fictional.

## Fixture rules

- Email addresses use `example.invalid`.
- Sites and hosts use `example.invalid`.
- IDs use `FIX-`, `DEMO-`, or deterministic placeholder UUIDs.
- Names use fictional fixture identities.
- Case records use three stable examples with non-operational amounts, dates, references, and notes.
- Vendor records use three stable fictional vendors.
- Connection maps use placeholder resource IDs and require rebinding before any import.

## What was removed

Operational mailbox payloads, spreadsheet rows, screenshots, tenant URLs, real connection IDs, personal names, organization names, runtime databases, generated logs, installer binaries, and historical evidence were not copied. The two large seed arrays were replaced as arrays, rather than attempting partial redaction of individual cells.

## What remains unproven

The local flow tests prove only that the included readable definitions execute under the supported local semantics and deterministic connector fixtures, and that the ZIP JSON matches those readable files. They do not prove connector authentication, list permissions, mailbox access, external service behavior, package import/rebind, saved-definition readback, or authenticated UAT.
