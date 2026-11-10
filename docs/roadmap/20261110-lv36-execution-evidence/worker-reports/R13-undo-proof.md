# R13 undo proof — report

## Owned files

- `tests/shared-runtime-undo-proof.test.ts`
- `REPORT.md`

No input, helper, contract, or source file was edited.

## Test harness actually used

- Real `SharedAuthority` on a fresh temp directory (`mkdtemp`), therefore real `RuntimeStore` SQLite (application id/version validated).
- Real loopback HTTP via `createSharedHttpServer(authority)` and `HttpSharedProvider` (no mocked server, no fabricated receipts).
- Real identity bootstrap and editor onboarding (`bootstrap` → `invite` → `join` → `grant`).
- Real `SharedRuntimeClient` / `LocalHistory` for positive undo/redo and client queue/reconcile.
- Table/column/row metadata, timestamps, cuts and receipts all come from the actual server snapshot/events.
- The only fault injection is one client-side `LostAckProvider` that delegates the real HTTP submit, then discards the already-committed receipt once. Authority `afterCommit` / `beforeCommit` hooks are the real public hooks.

## Covered cases

Positive:
1. 2x2 marked table, row delete, then client `historyStep("undo")`: restored row content/marks, fresh non-tombstoned IDs, old IDs remain tombstoned, and another writer's later column is preserved with an empty restored intersection.
2. Row insert → undo → redo: redo emits `table.row.restore` backed by the delete receipt/witness.
3. Column delete → other writer inserts a row → undo: column content restored for original rows, added row preserved with empty new cell.

Adversarial:
4. Changed `sourceRow` with the same `undoOf` → `UNDO_SOURCE_MISMATCH`.
5. Foreign writer restore → `UNDO_PROOF_MISSING`; foreign token impersonating the owner writer → `WRITER_MISMATCH`.
6. Rejected delete (`TABLE_ROW_MIN`) stores no witness; restoring it → `UNDO_PROOF_MISSING`.
7. Restore base earlier than the delete receipt → `UNDO_BASE_MISMATCH`.
8. Fresh ID equal to a live row and to a tombstone → `ID_COLLISION`; a later legal restore still succeeds (proof not consumed).
9. Same restore `Attempt` twice returns the identical receipt and materializes once.
10. Second logical restore with same `undoOf`, different IDs → `UNDO_ALREADY_USED`.
11. Committed restore with a lost acknowledgement, authority close/reopen: receipt exists, one materialization, repeated submit returns the same receipt and adds no event.
12. `beforeCommit` failure rolls back the restore; witness remains unused and the same attempt succeeds on retry.
13. Real lost HTTP acknowledgement leaves the intent `UNKNOWN`, raw intent retained (`entries()` and `recover()`), `canWrite()` false; `reconcile()` recovers the receipt and writes remain enabled.
14. Stale block delete against a concurrent `KEEP` insert below the intent base → `DELETE_CONFLICT`; raw rejected intent retained; latest-base delete of another block succeeds.
15. Text own-undo after a remote prefix insertion: only the locally applied `"HI"` is replaced with `"hello"`, final text `"Rhello world"`.
16. Undo of deleted marked text → `HISTORY_UNSUPPORTED`, state/sequence unchanged, remaining `KEEP` marks not flattened, deleted `BOLD` not reinserted unmarked.

## Actual APIs relied on

- `SharedAuthority.submit` / `receipt` / `snapshot` / `head` / `store`
- `createSharedHttpServer`, `HttpSharedProvider`, `SharedRuntimeClient`, `LocalHistory`
- `table-commands` restore paths (`table.row.restore`, `table.column.restore`)
- `undo-witness`, `delete-conflict`, `document`, `canonical`, `contract`

## Proof holes / limitations found (independent of helper mirrors)

1. `delete-conflict.ts` does not flag the structural events themselves: a concurrent `table.row.insert` is not checked for `table.column.delete`, and a concurrent `table.column.insert` is not checked for `table.row.delete`. A later text edit inside the newly created intersection is caught indirectly because its paragraph ID is in the target set, but the structural event alone is accepted. The tests do not claim this hole is closed; it is a residual structural-conflict gap, not covered by the required `KEEP` block case.
2. Witnesses are stored under `authority.undo` forever. There is no retention, GC, audit projection, or capacity accounting for them; they are outside the event/prefix/attempt retention summaries.
3. Restore proof binds writer, scope, delete cut, and source template, but does not independently prove that every intervening accepted event was evaluated. Safety relies entirely on the narrow checks in `applyTable` plus `delete-conflict`.
4. `validateRestoreWitness` allows a restore base at any same-epoch seq `>=` the delete receipt; it does not require the restore base to be the latest observed cut. Conflicts with later edits are therefore deferred to the command-specific checks, not the witness.
5. `LocalHistory.textInverse` intentionally refuses marked-range deletion (`HISTORY_UNSUPPORTED`) instead of restoring mark structure. This avoids flattening but means a common undo case is lost.
6. `historyStep` always refreshes over the network before undo/redo, so offline undo/redo is unavailable even with local history present.
7. Client lost-ACK recovery is query-and-confirm only; there is no blind resend and no unreceipted second attempt. This is correct for the contract but leaves an unknown entry blocking new writes until `reconcile()`/`invalidate()`.
8. The unique-ID/tombstone guarantee for restores is enforced by `applyTable` + `LocalHistory` allocation. The tests verify the observable result; they cannot prove there is no future caller path that supplies a colliding fresh ID with a matching witness (the witness template intentionally ignores `newRowId`).
9. `LocalHistory` builds the restore template from its local `entry.before`, while the authority witness captures the row/column at delete-apply time. If a remote writer changes the deleted row/column between the client snapshot and the delete submission, the canonical templates differ and undo fails closed with `UNDO_SOURCE_MISMATCH` even though the delete itself was accepted. Safe, but it shifts server-captured proof into a local-state equality check.
10. Restore replay after a lost ACK is idempotent only by `attemptId`/`intentId`. A caller that creates a new logical restore for the same delete is refused by `usedBy`, which is the intended single-use behavior.

## Not run

- Worker did not execute shell/test/build. Parent must run `npm run check` and the test file.
- No GUI/browser/Electron/native/clipboard/E2E was started. GUI/E2E is `NOT_RUN`.
- No real multi-host network, crash/kill-at-commit, or power-loss durability is claimed.
