# R01 Independent Editor Review — REPORT

Status: FINAL. Independent READ-ONLY review. No code edits outside this file. No tests run
by this worker-shell-less copy; no claim of test pass or completion. Parent must verify.

Reviewed scope: `src/collaboration/runtime` rich editor batch path — `editor-batch.ts`,
`authority.ts` batch/cut/version handling, `editor-versions.ts`, `editor-plan.ts`,
`rich-inline.ts`, `block-commands.ts`, `block-format.ts`, `table-commands.ts`,
`delete-conflict.ts`, `local-history.ts`, `client.ts`, `pm-move.ts`, plus related
`retention.ts`/`state-root.ts`/`wire.ts` hash contracts.

Method: code-path audit only, driven by the requested risk areas (trusted base versions,
actual beforeUndo, destructive-batch protection, lowerer IDs/table metadata, own-only undo,
real PM move step). Missing helper modules in this isolated copy were treated as NOT findings
(see "Interface gap" at end).

---

## P1-1 — Retention event hash omits `appliedBefore`, so every editor batch makes events unparseable/compaction fail

Exact paths:
- Writer: `src/collaboration/runtime/authority.ts:77-101` (`runtimeEventHash` adds
  `appliedBefore` when defined); `authority.ts:779` sets `appliedBefore = clone(state)` for
  every `batch`/`inline`/`block.format`; `authority.ts:991-992` stores it on the event.
- Reader: `src/collaboration/runtime/retention.ts:209-250` (`computeEventHash`) has **no
  `appliedBefore` member**; `retention.ts:252-345` (`parseEvent`) builds `hashInput` without
  it and demands `expected === hash` (`retention.ts:329-334`).
- `retention.ts:348-352` (`readEvents`) is used by `RetentionService.compact`
  (`retention.ts:658-683`).

Trigger: any normal editor save. All rich-editor saves are `batch` commands
(`editor-plan` lowers the whole snapshot to one batch), so they all carry `appliedBefore`.

Minimal counterexample / proof steps (pseudo-TS, parent can run):
1. Bootstrap a `SharedAuthority`, snapshot scope, submit a normal accepted batch that
   contains one `inline` atom (or any `block.format`) changing text.
2. Confirm the committed `authority.events` row has an `appliedBefore` key.
3. Call `readEvents(store)` (or `authority.retention(token, orgId).compact(cut, verification)`).
4. `parseEvent` -> `computeEventHash` hashes a body without `appliedBefore`; stored `hash`
   was computed with it -> throws `EVENT_DRIFT`. Compact/archival is dead after the first
   editor batch.
Note `http-provider.checkEvent` (`http-provider.ts:179-198`) does include `appliedBefore`, so
only retention is inconsistent with the persisted chain.

Precise fix: mirror `runtimeEventHash` in retention:
- `parseEvent`: read/validate `appliedBefore` exactly like `state` (or at least
  `parseState(field(entry,"appliedBefore"), MAX_STATE_BYTES, "EVENT_DRIFT")` when present),
  reject unknown keys via the existing allowed-key check.
- `computeEventHash`: add optional `appliedBefore` and
  `if (input.appliedBefore !== undefined) body.appliedBefore = input.appliedBefore;`
- Pass it through both `expected` and legacy hash inputs.

---

## P1-2 — `detailsSummary` is a textblock to the lowerer but not to the server; toggle-summary edits are rejected

Exact paths:
- Lowerer treats it as textblock: `src/collaboration/runtime/editor-plan.ts:29-34`
  (`TEXTBLOCK_TYPES` includes `"detailsSummary"`), used by `indexBlocks`/`planJoins`/
  `planSplits`/`residualCommands` (`editor-plan.ts:71-86, 476-571, 733-773`). Summary text
  edits therefore lower to `{kind:"inline", blockId:<summaryId>, ...}` (and summary
  split/join lower to `block.split`/`block.join`).
- Server rejects them: `src/collaboration/runtime/rich-inline.ts:37` and `:437-439`
  (`TEXTBLOCK_TYPES` = paragraph/heading/codeBlock only; `NOT_TEXTBLOCK`);
  `src/collaboration/runtime/block-commands.ts:17` and `:396` same list for split/join.

Trigger: user edits text inside a Toggle/Details summary (`detailsSummary`). The generated
`inline` atom is rejected by `applyInline` -> whole batch `REJECTED`; the edit is not saved.
Splitting/joining summary blocks similarly fails.

Minimal counterexample:
```ts
const state = initialState({type:"doc",content:[{
  type:"details", attrs:{id:"d"}, content:[
    {type:"detailsSummary", attrs:{id:"s"}, content:[{type:"text",text:"a"}]},
    {type:"detailsContent", attrs:{id:"c"}, content:[{type:"paragraph",attrs:{id:"p"}}]}
  ]
}]});
const plan = lowerEditorDocument(state, /* same doc but summary text "b" */, "inc-1");
// plan.commands[0] === { kind:"inline", blockId:"s", before:[text a], after:[text b] }
applyInline(state, plan.commands[0] as any); // throws CollaborationError("NOT_TEXTBLOCK")
```
Precise fix: define one shared `TEXTBLOCK_TYPES` (include `detailsSummary`) and use it in
`editor-plan`, `rich-inline`, `block-commands`; verify split/join offsets for summary
(`inlineLength`/`splitInline`) are valid for `detailsSummary` content. If the real
`detailsSummary` content model is not inline-text, instead stop treating it as textblock in
`editor-plan` and lower its text via a supported command.

---

## P2-1 — `residualCommands` emits structural `block.format` for table rows/cells; server hard-rejects the whole batch

Exact paths:
- Plan: `src/collaboration/runtime/editor-plan.ts:733-759` compares each target node's
  type/attrs with the reply-replay state and, on any delta, emits
  `{kind:"block.format", ...}` including for `tableRow`/`tableCell`/`tableHeader`.
  Plan-side `applyFormatCommand` (`editor-plan.ts:724-731`) just assigns attrs, so lowering
  "succeeds".
- Server: `src/collaboration/runtime/block-format.ts:36,72-78,107-108` rejects
  `STRUCTURAL_TYPES = table/tableRow/tableCell/tableHeader` with `TABLE_STRUCTURAL`.
- Divergence source: server-inserted cells are minted minimal by
  `table-commands.ts:205-225` (`newCell` = `{type, attrs:{id}}`), while the lowerer preserves
  all target cell attrs (`editor-plan.ts:237-277`, `nextCell.attrs = {...cell.attrs, id}`) and
  cell type. So any target-inserted cell carrying a non-`id` attr (or header type when the
  server makes `tableCell`) produces a residual `block.format` on a `tableCell`.
  `table-commands.ts:391-408` (`strictlyEmpty`) explicitly anticipates `colspan`/`rowspan`/
  `colwidth`, so these attrs are part of the real cell shape.

Trigger: add a row/column in an existing simple table where the client cell carries any
non-`id` attr (Tiptap default `colspan`/`rowspan`/`colwidth` are typically materialized in
`node.attrs`). Lowerer plan emits `table.row.insert`/`table.column.insert` followed by a
`block.format` against the derived `tableCell`; server rejects `TABLE_STRUCTURAL`.

Minimal counterexample:
```ts
before = tableState with table t1, row r1, cell c11 {id:"col1"} paragraph p11
after  = same + row r2 with cell {type:"tableCell", attrs:{id:"c21", colspan:1, rowspan:1, colwidth:null},
                                  content:[paragraph p21]}
plan = lowerEditorDocument(before, after, "inc-1");
// commands include table.row.insert(r2), then block.format for the derived c21
// server: applyEditorBatch(before, before, plan.commands, "inc-1") -> TABLE_STRUCTURAL
```
Precise fix: make the two representations agree. Either (a) normalize inserted-cell attrs in
`remapNewCell` to exactly what `table-commands.newCell` produces (id only / schema defaults),
so residual sees no delta; or (b) carry a cell template with the table command so the server
creates the client's cell type/attrs; or (c) allow `applyBlockFormat` to update non-structural
attrs on table internals while still forbidding parent/type/child changes. Add a plan test
with a cell carrying `colspan/colwidth`.
Caveat: if the real `SimpleTable` cells never carry default non-id attrs, the conditional
trigger is only a non-null `colwidth`/`colspan`; still valid and otherwise latent.

---

## P2-2 — Own-only undo can override a concurrent remote move of the same block

Exact paths:
- Batch path (normal editor): `local-history.ts:555-564` rebuilds the inverse only from
  `entry.before`/`entry.after`; `editor-plan.ts:579-628` emits `block.move` from that diff;
  server `block-commands.ts:233-256` (`move`) has **no source-location precondition** and
  moves the block wherever it currently is.
- Legacy path: `local-history.ts:249-265` (`moveInverse`) checks only that the block still
  exists and the original anchor is present; it never verifies the block is currently where
  this entry left it.

Trigger: A moves block X from parent P to Q (accepted). B then moves X from Q to R
(accepted). A presses undo. The inverse move targets P and is applied to current state,
yanking X out of R; B's move intent/placement is silently lost (text content survives, but
the remote structural edit is destroyed). Undo is not own-only here.

Minimal counterexample:
```
A: block.move X parent=P -> Q   (entry.after has X under Q)
B: block.move X parent=Q -> R   (current has X under R)
A.undo: lowerEditorDocument(entry.after, entry.before) emits block.move X parent=P,anchor=...
        server applies to current -> X moves R -> P
```
Precise fix: add an expected source location/generation to `block.move` (wire + contract +
`move` validation): `expectedParentId`/`expectedBeforeId` (or a per-block position
generation), and reject with `HISTORY_CONFLICT`/`MOVE_CONFLICT` when current source does not
match. For legacy `moveInverse`, compare `locateNode(current, blockId)` parent/next-sibling
against `entry.after` before issuing the inverse.

---

## Things audited and found sound (no finding)

- PM move is a real native `Step`: `pm-move.ts:19-200` implements `apply/getMap/mapResult/
  invert/forEach`, deterministic JSON/`fromJSON`, shape (type+id) validation that allows text
  and mark changes, and cycle/anchor/insert-inside-source rejection. `FolioMoveStepMap`
  (`pm-move.ts:338-400`) preserves interior offsets and customizes `mapResult/forEach/invert`;
  `map`/`mapResult`/`invert` geometry is consistent for up/down moves (checked by hand). Not an
  all-reject workaround. Residual note (not ranked): `forEach` necessarily reports the move as
  an insertion+deletion range pair (it cannot encode interior-move offsets), so any consumer of
  `forEach` (rather than `map`/`mapResult`) will see moved-block interiors collapse; add a test
  if Mapping composition ever consumes this map.
- Trusted-base batch binding: `editor-batch.ts:17-38` validates each inline `before` and
  `block.format` before* against the trusted basis advanced only by prior atoms of the same
  batch; concurrent state is merged by `applyInline`/`applyBlockFormat`. Multi-atom before
  binding is correct for the lowerer's one-inline-per-block output.
- Destructive protection: `delete-conflict.ts:17-98` computes the destructive target from the
  **current** document (so remotely moved-in/inserted descendants are included) and scans
  every accepted event after `intent.base`, including atoms inside remote `batch` events.
  `editor-batch.ts:33` invokes it per atom. Remote rich text/marks/inserts/moves into a
  deleted subtree are caught.
- Actual beforeUndo: `authority.ts:779,991-992` records full server state before the batch;
  `client.ts:195-200` forwards `appliedBefore` to `LocalHistory.confirm`; `local-history.ts`
  batch inverse lowers from `entry.after` to `entry.before`, so undo/redo replay against the
  real server base and merge later remote text through `applyInline`.
- Lowerer ID hygiene: deleted ids are remapped on batch undo/redo (`local-history.ts:555-564`
  + `remapIds`); table insert cell/paragraph ids use the same derivation as
  `table-commands.newCell`; new-table column ids are seeded server-side only
  (`table-commands.seedNewTables`). No collision/duplicate-ID path found in normal flow.
- Root/cut hashing: `state-root.normalizeRecord` blanks exactly the current cut for
  attempts/intents/undo/doclifecycles; event hash includes `appliedBefore` on the authority
  and HTTP-client sides. The only mismatch found is the retention reader (P1-1).

## Interface gap (explicit; not counted as a finding)

This isolated copy omits `document.ts`, `text-intent.ts`, `storage-port.ts`, `store.ts`,
`durable-queue.ts`, `provider-port.ts`, `undo-witness.ts`, `restore-authorization.ts`,
`editor/simple-table.ts`, `editor/block-identity.ts`, etc. Therefore I could not verify the
semantics of `checkedState`/`initialState`/`locate`/`materializedState`, `rebaseText`,
restore-witness behavior, or the real `SimpleTable` cell attr defaults. This limits the
trigger certainty of P2-1 (cell attrs) and P1-2 (whether `detailsSummary` actually has inline
content), but not the code-level inconsistency itself. Missing imports alone were not treated
as findings.

NOT_RUN: GUI/Electron/browser/E2E/clipboard/native-dialog/real-data tests. No test execution.
