# R01 structure adversarial review

## Owned outputs
- `tests/shared-runtime-structure-adversarial.test.ts`
- `REPORT.md`

No source/contract/helper files were edited. Nothing was executed (no shell allowed in this worker).

## Implemented API actually used
- `applyBlock(state, command): SemanticResult` (block-commands.ts)
- `applyTable(state, command, incarnationId): SemanticResult` (table-commands.ts)
- `seedTables(state, incarnationId): DocumentState` (table-commands.ts)
- `initialState(document): DocumentState`, `locate`, `nodeText`, `checkedState`, `materializedState` (document.ts)
- `canonical(value, maxBytes?): string` (canonical.ts)
- `CollaborationError`, `identifier`, `wellFormed`, `DocumentState`, `SemanticResult`, `TableCommand` (contract.ts)
- `derivedId` is exercised only through `seedTables`; tests never recompute derived IDs.

## Integration points required by these semantics
- A raw document must pass `initialState`; a table-bearing state must pass `seedTables` before `applyTable`.
- Every successful mutation must keep `document`, `tables[].tableId/rowIds/columnIds`, and `tombstones` mutually consistent.
- Column IDs are IDs too: they must not collide with document IDs, tombstoned IDs, or future document IDs created by block commands.
- Refusal must preserve the caller's input. `applyBlock` works on a clone; `applyTable` builds new values. Tests assert JSON equality of the input state after refusal.

## Confirmed holes / minimal repro (expected-failing tests)
1. `block.insert` of a table succeeds but leaves `state.tables` empty. Repro: schemaVersion 2 paragraph document, insert a 1x1 table. Expected-failing test: “block.insert of a table keeps structural metadata consistent”. Suggested contract: either refuse table-producing block commands or update metadata; do not return a drifted state.
2. `block.delete` of a table removes the table from the document but keeps its stale metadata. Repro: `seedTables`, then delete `t1`. Expected-failing test: “block.delete of a table removes its metadata”.
3. `block.replace` paragraph→table leaves metadata missing; table→paragraph leaves stale metadata (and tombstones its rows). Expected-failing tests: replace-introducing / replace-removing table.
4. `block.insert`, `block.split`, and `block.replace` ignore the table column-ID namespace. A new block/descendant ID equal to an existing `tables[].columnIds[i]` is accepted, and the next `applyTable` fails `ID_COLLISION`. Expected-failing tests: column-ID collision on insert/split/replace.
5. `applyTable(state, null as TableCommand, ...)` throws a raw `TypeError` at `command.kind`, not `CollaborationError`. Expected-failing test: non-object command.
6. `table-commands.requireId` accepts any well-formed string ≤128 chars, while the shared `identifier` grammar is `^[A-Za-z0-9_-]{1,128}$`. Row/column IDs such as `"row id"` and `"行1"` are accepted. Expected-failing test: shared identifier grammar. This also makes later block commands (which use `identifier`) unable to address those IDs.

## Behaviours asserted as non-holes (not executed here)
- `block.replace` tombstones descendant IDs that disappear and refuses reuse by a later insert, split or replace.
- Split rejects an offset inside a surrogate pair (`SPLIT_UNICODE`) and preserves marks on both halves; join restores the marked inline sequence and tombstones the right block ID.
- Join rejects non-adjacent blocks and incompatible heading attributes.
- Table row/column insert places both metadata and document children at the same index; delete keeps row/column order and tombstones removed cells and paragraphs.
- Table delete refuses the final row/column; metadata drift, metadata row-order drift, duplicate tombstones, live/tombstone collisions and duplicate table metadata are refused.
- `seedTables` finds a table nested in `callout`; a table inside a table cell is rejected by document validation.
- `canonical` rejects accessors, hidden keys, symbols, unsafe numbers, cycles, sparse arrays and lone surrogates, while preserving raw CJK/emoji.

## Unverified / known limitations
- Tests were not executed here. `npm test` / `npm run check` / build are parent-owned; expected-failing tests above are intended to fail until the parent fixes the holes.
- No GUI/browser/Electron/native/clipboard testing was performed: `NOT_RUN`.
- Tests rely on the real TipTap schema through `initialState`; a schema-change in editor-schema can shift normalization details (for example default cell attrs), although assertions compare logical IDs/content, not raw normalized JSON.
- `checkedState`/`initialState` intentionally cap canonical input around 2 MB (`canonical(..., 2_000_000)` and `parseSharedInput`), below the 30 MB document bound; larger valid documents are out of scope for these tests.
