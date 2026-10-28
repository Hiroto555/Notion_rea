# R6 explicit legacy migration lane

Worktree: `<workspace-root>/Folio-r6-20261028/migration`, branch `codex/r6-migration`, base `ac1d2ad`.

## Contract

- `shared/legacy-migration-operation.ts`: `migrationPreviewRequestSchema`, `migrationCommitRequestSchema`, `migrationResolveRequestSchema` for root's request union. `prepareLegacyMigration(preview)` creates an immutable operation identity after explicit user acceptance.
- `persistence/legacy-migration-operation.ts`: `previewLegacyMigration(store, databasePageId)`, `commitLegacyMigration(store, operation, {assetsPath, snapshotRoot})`, `resolveLegacyMigration(store, operation)`.
- The operation includes `operationId/sessionId/seq/databasePageId/revision/sourceFingerprint`. The result includes the same identity and operation SHA-256 fingerprint, status `applied/rejected/unknown`, and, when applied, owner Page, record projection, snapshot path and converted row count.
- Main owns both filesystem paths, write quiescence and dispatch. No path supplied by renderer is accepted in the request. No function is called at startup by this lane.
- `renderer/LegacyMigrationDialog.tsx` is controlled by the parent. It owns no draft, queue, operation or request. `closeBlocked` additionally keeps an unknown structural operation modal. Busy preview/apply disables close. Unknown exposes only receipt lookup, never a new apply operation.

## Storage behavior

Only the selected unregistered, live DB is converted. The preflight reads its raw current Page and history and rejects malformed/unsupported/lossy structures or values that do not fit their declared properties. Unrelated malformed legacy databases are not converted or rewritten. Existing converter calls without a scope retain their old all-database contract.

Preview changes no schema or content. Apply revalidates the exact raw source/history fingerprint. It creates a new, non-reused SQLite plus flat assets copy, uses the existing integrity and registered-asset checks, then compares all SQLite schema/table payloads and every asset's name/size/SHA-256 with the live source. Inside `BEGIN IMMEDIATE` it rechecks the selected fingerprint and full workspace/assets correspondence before conversion.

Original current bytes remain in `legacy_database_archive`; existing history bytes and IDs remain unchanged. Stable mappings use `(databasePageId, legacyRowId)`, including history-only rows. Newly materialized record Pages begin at revision 0. The selected owner revision increments once to reject stale legacy writers. Mapping, owner change, memberships, version marker and applied receipt commit in one transaction. Same operation after lost ACK or process reopen returns its recorded result without new IDs, revisions or copies. A known rollback records rejection; ambiguous/unusable connection returns unknown. Failed/incomplete snapshot directories are retained and never reused.

## Verification

Added `tests/legacy-migration-operation.test.ts`: pure preview; selected migration in v3 and mixed v4; exact unselected bytes/history preservation; SQLite/asset snapshot readback; scoped historical IDs; stale owner rejection; receipt/reopen/idempotency; changed history fingerprint; malformed and wrongly typed inputs; mid-conversion rollback; missing attachment and retained incomplete snapshot.

Source formatting and `git diff --check` completed. Typecheck/build/unit/Electron are **NOT_RUN** in this lane; root schedules those serially. Existing `record-migration`, `legacy-record-plan`, and `migration-snapshot` unit suites should run alongside the new wrapper suite.

## Evidence limits

Root must prevent all in-app SQLite and asset writes throughout the operation. SQLite's immediate transaction excludes other DB writers during conversion, but arbitrary external filesystem writers cannot be locked by this API. Copy checks detect mismatches at their observations; they do not prove exclusion of a writer after the final check. No power-loss durability, full application recovery, or real-user-data migration is claimed. SIGKILL/ACK-loss UI and restart scenarios require root's actual Electron verification. Preview/result data is not a completed migration until an applied receipt is verified and root reloads fresh sessions.

## Actual Electron scenarios prepared

Added `tests/e2e/r6-migration-fixture.ts` and `r6-migration.spec.ts` (4 cases, **NOT_RUN** in this lane). The fixture starts with v3 legacy data, adds an existing registered DB to make a mixed v4 workspace, adds a second untouched legacy DB with a colliding scoped legacy row ID, history-only rows and a registered synthetic attachment. It uses R5's isolated launch helper, which sets `FOLIO_DATA_DIR` before startup and checks Electron userData/sessionData.

The UI scenarios cover selected-only apply with raw/history/archive/SQLite/assets readback and record Editor save/restart; invalid selected values; actual post-COMMIT ACK loss with a locked modal, original operation lookup, idempotent replay and process restart; and an external owner revision change between preview and apply. The IPC gate calls the real handler first and wraps only migration commit/resolve. Existing R5/R4 tests are unchanged. SIGKILL during a transaction is still a separate integration gate; process reopen after an applied receipt is not described as that evidence.
