# R10 binding gates report

## Owned files

- `experiments/collaboration-comparison/next/independent-gates.test.mjs`
- `REPORT.md`

No adapter, fixture, oracle, contract, helper, config or runtime source was edited. No commands were run; all status below is `NOT_RUN` until the parent builds and executes.

## Test surface

The test imports the two existing adapters directly and does not build or bundle anything:

- `next/b/adapter.mjs` — `createHarness`, `state/doc/local/text/structure/sync/undo/redo/close/serverDoc/serverDocumentState/pendingCount/diagnostics`.
- `next/c/adapter.mjs` — `createHarness`, `state/doc/local/insertText/deleteText/moveBlock/insertBlock/replaceBlock/deleteBlock/insertTableRow/insertTableColumn/deleteTableRow/deleteTableColumn/sync/undo/redo/close/serverDoc/serverState/diagnostics`.

A local facade maps the frozen `BlockCommand`/`TableCommand` shape onto both harnesses; it does not add or discover APIs. Rejections are normalized from `diagnostics().rejected` (B) and `diagnostics().rejections` (C), and every structural rejection is checked to retain its exact raw command.

## Required oracles

- R01: concurrent `block.insert` with the same `attrs.id` must allocate the identity once, converge, keep unique IDs, and reject the loser with its raw command matching one exact input. Re-sync must be inert.
- R02 move: `block.move` with an unsynced `KEEP` edit and a bold `bc` run must keep the original block ID, the exact text `aKEEPbc`, the bold mark, and `p2`.
- R02 delete: deleting the marked block that carries unsynced `KEEP` must not silently discard that text. The only safe in-memory result is refusal of the delete with its raw command retained, the block/text/mark intact, followed by a successful ordinary delete of `p2` (so this is a specific refusal, not all-refuse).
- R03: row-first and column-first orderings must produce identical final documents, identical sorted ID sets, identical marks and identical server table metadata, not merely equal dimensions.
- R04: structural move undo by its author must restore order while keeping remote `KEEP`; per-user row/column insert undo must remove only that author's dimension; mixed text-then-structure undo must follow the author's reverse operation order.
- R05: the in-memory adapters expose `sync()` with no delivery-order/retry/transport hook, so repeated/reordered transport delivery, missing receipts and redelivery are explicitly not provable here.

## Integration points / blockers

- Both adapters require prebuilt CommonJS artifacts. `next/b/adapter.mjs` requires `experiments/collaboration-comparison/runtime/bundle.cjs` and `experiments/collaboration-comparison/runtime-semantic.cjs`; `next/c/adapter.mjs` requires `.../runtime/bundle.cjs` and `.../next/runtime-semantic.cjs`. The checked-in `build.mjs` only emits `runtime/bundle.cjs`; the two `runtime-semantic.cjs` locations are not produced by it. The parent must provide them before this file can load.
- Structural undo (R04) has no author-owned structure history in either harness: structure effects are applied or broadcast with the server/server-client identity, so the author's `undo()` currently has no structure operation to reverse. A required result needs an explicit inverse-command intent path or author-owned structure history; the current interface is insufficient. The test asserts the required result, so a current red run is expected unless the parent extends the adapters/interface.
- Delete-with-pending-text (R02) needs pending-text awareness and raw refusal/quarantine. Both harnesses currently merge or accept text before structure and have no pending-text record or raw text quarantine, so the strict gate is expected red with the current interface.
- R05 cannot be upgraded to a durable-transport gate from these adapters. It records the hole rather than skipping or xfailing it; a separate durable log/head/receipt test is required.

## Unverified

- Tests were not executed by this worker (no shell); pass/fail, lint, typecheck, build and full-suite status are `NOT_RUN`.
- GUI, Electron, browser, native dialogs, clipboard and physical multi-Mac behaviour: `NOT_RUN`.
- No conclusion of full GO is made; the parent must either fix the red gates or declare full `NO_GO`.
