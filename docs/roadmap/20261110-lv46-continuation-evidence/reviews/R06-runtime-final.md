# R06 runtime final — independent READ-ONLY review

Status: FINAL (read-only review; REPORT.md is the only file written)
Mode: no edits, no tests, no shell, no GUI. This worker slice cannot be
typechecked or executed by me (missing helper modules, see "Interface gaps").
Everything below is source-level audit, not runtime proof.

## Verification status

**NOT_RUN.** I did not run `npm run check`, `npm test`, `npm run build`, or any
GUI/Electron/browser/E2E. The two test files present are read as evidence of
intent only. The 11 main tests (3 in `tests/shared-continuation-main.test.ts`,
8 in `tests/shared-editor-connection.test.ts`) import modules that are not
present in this worker copy (`http-server.ts`, `store.ts`, `wire.ts`,
`document.ts`, `editor-plan.ts`, `shared-runtime-ipc.ts`, …), so this slice
cannot compile or run them. Parent owns and runs the real checks.

## Gate audit (source-level only)

Reasonable / consistent with the requested gates:

- Immutable attempt protocol: `client.ts:159-197` and
  `resource-client.ts:176-219` negotiate protocol **before** enqueue, write the
  intent once, add one attempt, and call `markUnknown` before `submit`; there is
  no automatic resend. `durable-queue.ts:473-557` only promotes PREPARED→UNKNOWN
  and refuses `UNKNOWN_BLOCKS_RETRY`.
- Lost receipt via own Undo: `client.ts:225-243,306-320` only queries receipts;
  `finishHistory` (`client.ts:198-208`) reuses the event `appliedBefore`.
- Staged copy cleanup/idempotency: successful `commit` writes the committed
  record before deleting only `:part:` rows (`copy-staging.ts:915-930`);
  `prepare`/`stagePart`/`commit` are idempotent and immutable.
- Asset final publish before cut: `authority.ts:1127-1139` publishes staged
  assets, then stamps the provisional cut; the outer `commit` fixes the real
  hash (`authority.ts:1051-1097`).
- Migration atomicity/fence: `finishUpgrade` runs the migration runner inside the
  same transaction and only then sets COMMITTED / clears the fence
  (`operations.ts:719-762`); failure writes RECOVERY_REQUIRED
  (`authority.ts:213-217`). `readRuntimeProtocol` treats a missing row as 1003
  and requires an ACTIVE fence/backup (`protocol-migration.ts:431-530`).
- Old writer rejection: `assertWriter` rejects a version that is not the single
  current version (`operations.ts:764-780`); the test expectation at
  `tests/shared-editor-connection.test.ts:111` matches.
- Historical artifact proof / compact-after-fence: `retention.ts:549-609`
  validates prefix+restore; `compact` requires every archived writer to be
  revoked (`retention.ts:690-700`), records the checkpoint and removes only
  `authority.events` rows (`retention.ts:756-766`). `verify`/`backup` re-check the
  rooted chain (`authority.ts:330-408`, `backup.ts:186-249`).
- `appliedBefore` hashing: included in `runtimeEventHash`
  (`authority.ts:78-102`), `retention.computeEventHash` (`retention.ts:209-252`),
  `backup.rootedEvent` (`backup.ts:123-164`) and `http-provider.checkEvent`
  (`http-provider.ts:136-199`) with the same field set.
- Collect preview vs execution: `maintenance-operator.ts:56-77` requires only
  org/workspace/document/incarnation for `collect-preview`, and requires
  `--expected-cut` + `--hashes` for `collect`; `maintenance.ts:414-448` recomputes
  the plan and demands an exact match before deleting.
- Main returns a rejected copy receipt rather than pretending success:
  `shared-runtime-service.ts:353-362` returns `this.resources.execute(...)`
  unchanged (status/code flow to the UI). I do **not** count that as success.

Not proven here (owner elsewhere, or not exercised): trash/restore freshness
(`lifecycle.restore`), records/database model, real HTTP server, the private
Store, preload/App, and the actual test run.

## Confirmed findings

### P2-1 — Record copy depends on selection order (valid copy rejected)

Source: `src/collaboration/runtime/copy.ts:636-716`,
called from `previewSharedCopy` (`copy.ts:771`) and `commitSharedCopy`
(`copy.ts:1032`).

`resolveCopyMetadata` walks `entries` once. A `record` entry is resolved with
`databaseBySource.get(metadata.databaseId)` (`copy.ts:693-694`), but
`databaseBySource` is only populated when a `database` entry is seen earlier in
that same walk (`copy.ts:682-689`). Therefore a selection that lists a record
before its database fails even when both are selected.

Minimal counterexample:
`sources = [{id:"rec", metadata:{kind:"record", databaseId:"db", position:0, values:{}}}, {id:"db", metadata:{kind:"database", properties:[]}}]`
with `selectedIds = ["rec","db"]` → `RECORD_DATABASE_NOT_SELECTED`.
The same two sources with `selectedIds = ["db","rec"]` succeed. Selection order
is not semantically meaningful, and `copyCatalog`/UI order is not constrained.

Fix: two passes over `entries`: first register every `kind === "database"` entry
(build `databases`, `databaseBySource`), then resolve records. Keep the rest of
the validation identical.

### P2-2 — Abandoned/failed large-copy staging is never reclaimed and has no aggregate cap

Source: `src/collaboration/runtime/copy-staging.ts:660-701` (prepare creates a
manifest row keyed by a client-chosen `copyId`), `copy-staging.ts:703-752`
(each part is its own committed request), `copy-staging.ts:915-930` (only a
**successful** commit deletes `:part:` rows); `src/collaboration/runtime/state-root.ts:31`
includes `copy.staging` in the authoritative root; `authority.ts:1121-1139` has
no failure/abandon cleanup.

Per-copy limits are 32 MiB / 100 parts (`copy-staging.ts:23-25, 344-382, 845-847`),
but there is no per-writer or global staging quota and no TTL/abandon path. A
commit failure (wrong `manifestHash` → `COPY_MANIFEST_HASH_MISMATCH`, or a source
changed → `COPY_FINGERPRINT_MISMATCH`) happens inside the outer SQLite
transaction, so the failing commit rolls back its own writes but the previously
committed part rows remain.

Minimal counterexample: stage copy `A` (up to ~32 MiB of parts) then commit with
a bogus manifest hash; the parts survive. Repeat with copy `B`; ~64 MiB of
`copy.staging` rows remain permanently, consuming the known 64 MiB Store budget,
and every subsequent state-root/verify pass re-canonicalizes all of it.
This is resource exhaustion by an authenticated writer, not "unlimited capacity"
by design; the static per-copy constants do not bound admission.

Fix: enforce a per-writer/aggregate staging quota at `prepare`/`stagePart`, and
add an explicit abandon/expiry operation (its own transaction) that deletes the
manifest, parts and committed record for an abandoned `copyId`; optionally stop
including raw `copy.staging` parts in the authoritative root and bind only the
committed marker.

## Lower-severity observations (not counted as P1/P2)

- `authority.ts:213-217`: only `CollaborationError` from `finishUpgrade(true)`
  triggers `finishUpgrade(false)`. Any other thrown error leaves the upgrade
  ACTIVE with the fence set, and `beginUpgrade` refuses ACTIVE
  (`operations.ts:685-687`); there is no public path back to RECOVERY_REQUIRED
  except restore. Defensive gap (P3).
- `shared-runtime-service.ts:200`: the reported `rejection` code uses the last
  entry of a concatenated list, not the entry that actually has a REJECTED
  attempt. UI may show a missing/wrong rejection code (P3).
- `operations.ts:427-456`: `countPending` marks an intent terminal if *any*
  non-accepted attempt exists, so a re-authorized retry in flight is not counted
  as pending in `overview` (P3; depends on the retry UI, which is outside this
  slice).
- Integrity note: `authority.checkpoint`, `authority.archive.events`,
  `backup.verifications` and `operations.backups` are not in
  `AUTHORITATIVE_NAMESPACES` (`state-root.ts:25-53`), so `verify()` does not
  detect tampering with compacted checkpoints/archived events or forged backup
  verification rows. This appears deliberate to avoid root cycles, but means
  "immutable old raw" is retained, not root-bound.
- Copy staging `committedToManifest` (`copy-staging.ts:934-946`) validates only
  copyId/fingerprint/ids on re-prepare; a later prepare with the same ids but a
  different (still legal) part layout would return a summary from the new
  manifest even though the committed layout is the old one. No write path
  exists because `stagePart`/`commit` short-circuit on the committed record, so
  impact is a misleading summary only.

## Interface / helper gaps (explicitly not reviewed, not owned here)

Missing modules imported by the owned files (so this slice is not
self-consistent): `collaboration/runtime/store.ts`, `wire.ts`, `document.ts`,
`editor-batch.ts`, `editor-intent.ts`, `editor-plan.ts`, `endpoint-policy.ts`,
`local-history.ts`, `lifecycle.ts`, `provider-port.ts`, `storage-port.ts`,
`records.ts`, `projection.ts`, `organization.ts`, `identity.ts`, `policy.ts`,
`admin.ts`, `restore-authorization.ts`, `delete-conflict.ts`, `undo-witness.ts`,
`block-commands.ts`, `table-commands.ts`, `text-intent.ts`, `rich-inline.ts`,
`block-format.ts`, `block-frame.ts`, `http-server.ts`, `asset-provider.ts`,
`backup-provider.ts`, `src/main/shared-recovery-index.ts`,
`src/main/shared-backup-export.ts`, `src/renderer/shared/runtime-state.ts`,
`src/shared/shared-runtime-ipc.ts`, `src/platform/credential-provider.ts`,
`editor/block-identity.ts`, `editor/simple-table.ts`, `editor/callout.ts`,
`shared/validation.ts`, `collaboration/document-input.ts`.
Consequences: trash/restore freshness, record creation/position, real HTTP
transport limits (the 1 MiB request size vs 20 MiB asset staging), private
Store/checkpoint isolation, IPC schema, and credential sealing are unverified
from this slice.

## Bounded-profile notes

The known profile is treated as static caps, not an admission guarantee:
document 2 MB, sources 32 MiB / max 100 parts at 384 KiB, Store 64 MiB, outbox
20 MB. The code does not claim unlimited capacity, but P2-2 shows the aggregate
staging path is not bounded by those per-copy constants. Nothing here should be
read as "unlimited" or as a guarantee that a request will be admitted.

## Explicit non-claims

- No test, build, typecheck or GUI result is asserted by me; all are NOT_RUN.
- No edits were made outside REPORT.md.
- PASS statements above are source inspection, not execution proof.
