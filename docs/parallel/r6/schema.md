# R6 schema / columns lane

Workspace: `<workspace-root>/Folio-r6-20261028/schema`.
Branch: `codex/r6-schema`; base R5 `ac1d2ad6d2ae6e199c7d1344360a9670703ea164`.

## Implemented

- Registered database columns: add, rename, change type / select options.
- Parent-controlled form and explicit preview/apply. Stable column IDs remain
  unchanged on rename and type conversion. Form text remains visible on rejection.
- Five types: text, number, checkbox, date, select.
- Preview lists row values, rejected rows, affected views, and whether backup is
  required. Missing values remain missing. Trashed rows are checked and converted.
- Type conversion updates every belonging record's revision, including records
  with a missing target value, so an old record write cannot silently reintroduce
  the prior type. Owner revision, record values/revisions, histories and receipt
  are one transaction. Add/rename update only owner revision and schema/history.
- Type conversion requires a new SQLite backup, integrity check, exact source
  bytes readback for owner/member/record pages, SHA-256, and fsync before mutation.
  The write transaction then checks the preview again. Backup failure or any
  owner/record/membership change rejects the operation. This is a SQLite backup;
  it does not copy attachment files, which these column operations never change.
- Operation IDs share `save_receipts` collision protection with Page/database
  operations. A same-ID replay returns the original receipt; a different payload
  is rejected. Unknown resolves the same identity and does not resend.

## Contract

`src/shared/property-operation.ts` exports the three request schemas and types:

```ts
{ type: "property:preview", databasePageId, revision, change }
{ type: "property:commit", operation }
{ type: "property:resolve", operation }
```

`PropertyChange` is `add {property:{id,name,type,options?}}`,
`rename {propertyId,name}`, or `changeType {propertyId,type,options?}`.
Select requires explicit nonempty, unique options. Other types reject options.

A valid preview returns a prepared `command` containing owner identity/revision,
the change, all belonging record IDs/revisions and a hash binding exact source
bytes and the change. `preparePropertyOperation(command)` adds operation/session
IDs and seq once. Keep that complete object for commit and resolve.

Core exports `previewPropertyOperation(store, fullRequest)`,
`commitPropertyOperation(store, operation)`, `resolvePropertyOperation(store, operation)`.
Applied results include owner Page, DatabaseProjection, every `{page,record}` pair,
and verified backup metadata for type conversion. Root installs a fresh snapshot
by renderer reload only after it has blocked editing and confirmed no input.

Pure UI exports `PropertySchemaPanel`, `PropertySchemaPanelProps`,
`PropertySchemaStatus`; helpers export `PropertySchemaDraft`, `newPropertyDraft`,
`editPropertyDraft`, `propertyChangeFromDraft`. Parent owns draft/preview/status,
clears preview on draft changes, and handles `onPreview(change)`, `onApply`,
`onResolve`. No persistence queues or component-owned revision/draft were added.

## Conversion matrix

| Target | Accepted source values |
| --- | --- |
| text | Valid values of every source type; numbers and booleans use exact canonical string form |
| number | Existing finite numbers; booleans as 0/1; strings only when `String(Number(value)) === value` and finite |
| checkbox | Existing booleans; numeric 0/1; exact strings `true`/`false` |
| date | Empty string or a real Gregorian date with exact `YYYY-MM-DD` spelling; years 0001–9999 |
| select | Empty string or an existing string explicitly present in the requested options |

Missing keys stay missing for every conversion. A value that disagrees with its
current schema is rejected before conversion. Whitespace, leading-zero numbers,
rounded integers, noncanonical decimal/exponent spelling, invalid dates and
unlisted select values are rejected with row identity; no invalid value is erased.

View conditions are preserved. A filter referencing the changed column rejects
the type change with its view name, requesting a prior explicit filter change.
Sort/group references are retained with a warning that order/grouping may change.
Changing a date used by a calendar to a non-date, or removing a board's implicit
select grouping source, is rejected until that view is explicitly adjusted.

## Commits

- `6138b05`: shared request/operation/conversion contract.
- `9fd6e51`: atomic core, verified backup and controlled UI.
- `60c3e2a`: focused unit tests.
- `8be6cfc`: actual Electron app E2E cases.

## Validation and boundaries

- `git diff --check`: PASS in this lane.
- Unit/build/typecheck/Electron execution: NOT_RUN in this lane; root owns the
  serialized runtime and reports integrated results separately.
- Unit cases exercise conversion matrix, invalid source values/options/dates,
  add/rename identity preservation, missing/trashed rows, old record writes,
  owner/record/membership staleness, view dependencies, backup failure, domain and
  receipt rollback, same-ID receipt replay/collision and reopen resolution.
- Five E2E cases cover UI five-type creation, table and record-page date/select
  editing, stable rename, lossless conversions and real restart, explicit value
  and filter rejection, pre-conversion record revision rejection, post-COMMIT ACK
  loss with same-ID resolve, and a record changed after preview.
- App/main/preload/shared types/LiveRecordDatabase wiring and generic operation
  boundaries remain root-owned. This lane never edited them or another worktree.
- No R5/original/user workspace data, dependency install, heavyweight execution,
  extra agent, push or merge was used.
