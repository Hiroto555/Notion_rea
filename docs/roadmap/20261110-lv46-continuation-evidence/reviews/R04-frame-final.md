# R04 frame/final read-only review

Status: independent READ-ONLY review of the files present in this isolated worker copy.
No source edits, no test execution, no shell/git/network/GUI/Electron/browser/clipboard.
`npm run check` / `npm test` / GUI: **NOT RUN** (parent owns checks; GUI never requested).
This is not a certification of the full editor or GUI.

Owned artifact: this `REPORT.md` only.

## What was inspected

Only files actually present here: `src/editor/shared-frame-step.ts`,
`src/editor/shared-projection.ts`, `src/editor/Editor.tsx`, `src/editor/block-identity.ts`,
`src/editor/simple-table.ts`, `src/collaboration/runtime/{block-frame,editor-plan,
editor-batch,pm-move,local-history,delete-conflict,authority,document,canonical,contract,
digest,wire}.ts`, `src/shared/{types,editor-schema}.ts`, and the four `tests/*.test.ts`
files. Other modules referenced by these files are absent from this copy; per task they are
not treated as findings.

## Confirmed good (spot-check only, not a substitute for parent tests)

- `block-frame.ts:162-179` replaces each retain placeholder with the *current* subtree from
  `range`, so remote text/marks/children in a retained block are carried, not reverted.
- Dropped range ids are tombstoned (`block-frame.ts:271-281,336-340`); new ids are checked
  against outside ids, range ids and existing tombstones (`313-324`).
- `editor-batch.ts:26-41` re-validates each atom's source against the trusted basis that has
  been advanced by the earlier atoms before applying to current (per-atom basis binding).
- `pm-move.ts` resolves the source by id at apply time (latest subtree) and installs
  inclusive retained-boundary mapping; the existing focused tests exercise this.
- `Editor.tsx:280-292` applies projection with `addToHistory:false`, `preventUpdate`, and a
  `folio.shared.projection` meta that `onUpdate` ignores (`271-274`), so projection does not
  echo or clear native history. A projection throw happens before dispatch.
- `shared-frame-step.ts:353-357` now uses inclusive retained boundaries; not re-reported.

## Findings (max 5; confirmed in present source)

### P1 — `block.frame` can silently discard concurrent remote inline edits inside a dropped subtree

`block-frame.ts:283-294` CASes a dropped id against the trusted basis using only
`observed.node.type` and `observed.node.attrs` — it never compares text/marks/children.
Separately, `delete-conflict.ts:43-48` returns immediately for `block.frame` because it only
computes a `target` set for `block.delete`/table deletes/trash. So the usual delete-conflict
witness never runs for a frame, and the event that carries the remote text edit is not seen.

Minimal counterexample (normal lowering, single unwrap that also deletes one item):
- basis: `doc(bulletList L[ item I1[p1 "one"], item I2[p2 "two"], item I3[p3 "three"] ])`
- current: same doc, but p2 text is `"two REMOTE"` (accepted remote edit after basis)
- command (what `planFrames`/`lowerEditorDocument` emits for target
  `doc(p1 "one", p3 "three")`): `beforeIds:["L"]`, `retainIds:["p1","p3"]`,
  `after:[paragraph p1, paragraph p3]`.
- `applyBlockFrame` keeps p1/p3 live, computes `droppedIds = {L,I1,I2,p2,I3}`. For `p2`,
  basis/current type and attrs match, so the CAS passes, the frame is accepted, and
  `"two REMOTE"` is erased with no `DELETE_CONFLICT`.

This violates "a destructive intent must not silently erase edits its author never
observed": the same deletion through `block.delete` *is* caught by `assertDeleteBase`
(`delete-conflict.ts:49-77`), but the frame path is not.

Precise fix (either is sufficient, both is better):
1. In `applyBlockFrame`, compare each dropped id's full subtree between basis and current,
   *excluding subtrees rooted at a retained id* (retained live nodes are intentionally
   allowed to differ). Example helper: recursively compare type/attrs/text/marks and
   children, returning true when a child id is in `retainedSet` (skip that child). Fail
   `DELETE_CONFLICT` on any other difference. A naive full `canonical` compare would wrongly
   reject the legitimate "unwrap list while p1 has remote text" case, so the retained-skip
   is required.
2. Extend `assertDeleteBase` so `block.frame` computes
   `target = ids(before-range in state) \ retainedSubtrees(state, retainIds)` and then runs
   the existing per-event loop. That catches remote `appliedText`/`inline`/move/reinsert
   events whose `blockId`/ids land in the dropped, non-retained part.
Add a regression test with the counterexample above expecting `DELETE_CONFLICT`.

### P2 — Reparenting one descendant into a new container while keeping the old container fails closed (HOLD), not data loss

`editor-plan.ts:907-943` maps every old id under a new wrapper to its current *direct child*
via `directChildUnder` (line 801-815). If that direct child still exists in the target (the
old container is kept), the whole surviving container becomes a frame source. The `after`
slice (`973`) then contains only the wrapper, and `frameRetainIds` (`822-869`) only retains
ids present in that slice. Survivors that stay in the old container are therefore tombstoned
by the frame even though the target keeps them; the later structural reconcile must insert
them again.

Minimal counterexample:
- before: `doc(bulletList L[ item I1[p1], item I2[p2] ])`
- target: `doc(bulletList L[ item I1[p1] ], bulletList L2[ item I2'[p2] ])`
- `planFrames` groups source `L` -> new `L2`, emits `beforeIds:["L"]`,
  `retainIds:["p2"]`, `after:[L2 ...]` (`frameRetainIds` cannot see `p1` because `p1` is not
  in the `after` slice). `applyBlockFrame` tombstones `L`, `I1`, `p1`, `I2`; reconcile then
  needs to re-insert `L`/`p1`, which are now tombstoned.

Server result: the batch is rejected/held (`TOMBSTONED_ID` from the re-insert, or
`EDITOR_PLAN_MISMATCH`); the stored document is unchanged because the whole attempt runs in
the command savepoint and `applyBlock` semantics do not silently reuse tombstones. This is a
functional gap, not confirmed corruption.

Editor result on the same shape: `detectWrap` (`shared-projection.ts:174-221`) skips this
because `rootEntries` requires `located.parentId === parentId` for every old id, so no frame
is produced; `syncContainer` then tries to insert the new target container whose subtree
contains the still-existing `p2` and throws `PROJECTION_UNRESOLVED_MOVE`
(`shared-projection.ts:81-85`). `Editor.tsx:291` catches that, marks the editor invalid and
read-only. Again a HOLD, not a corrupted document.

Conclusion on the known boundary: normal legal reparent-while-keeping-container commands
**fail closed (explicit HOLD/REJECT), they do not lose data**. This is an unimplemented
narrow case, not a preservation violation. Do not generalize this into "reject all frames".

Precise fix:
- `editor-plan.planFrames`: when a candidate source direct child still exists at `parentId`
  in `target`, do not frame that surviving container. Emit `block.move` atoms for the
  descendants that move into the new container (insert the new container/skeleton first,
  then move the old ids), or restrict the frame to the minimal span that is actually
  replaced. Also make `frameRetainIds` retain every id that survives anywhere in the target
  inside the replaced range, not only ids present in the `after` slice.
- `shared-projection`: when a new target container's subtree references old ids that still
  exist elsewhere, first move those identified subtrees into the new container with
  `moveStep` (create the container skeleton first) instead of throwing
  `PROJECTION_UNRESOLVED_MOVE`; or run a reparent-aware frame planner that includes move
  steps. Keep the final `tr.doc.eq(target)` gate.

### P2 — `FolioFrameStep.apply` can return a document with duplicate ids; `FRAME_ID_COLLISION` is too permissive

`shared-frame-step.ts:177-183` skips the collision check for any id in `retainedSubtreeIds`,
i.e. for every descendant of a retained live node. But a separate brand-new template node may
carry one of those same old ids. `embed` (`148-165`) only substitutes the *top-level* retained
ids, so the template's extra node survives while the live retained subtree still contains the
same id.

Minimal counterexample (unique, valid target):
- current: `doc(blockquote Q[ paragraph p1 "a", paragraph X "b" ])`
- target: `doc(blockquote L[ blockquote Q[ paragraph p1 "a" ], paragraph X "b" ])`
  (`L` is new; `X` was moved out of `Q` while `Q` is also wrapped by `L`)
- `detectWrap` chooses `L`, `rootEntries` = `[Q]`, so `retainedIds=[Q]`,
  `template=[L(Q, X)]`. `Q` is embedded from the live doc (still containing `X`), and the
  template's separate `X` is inserted too. The collision check skips `X` because it is a
  descendant of retained `Q`, so `apply` succeeds with two `X` ids.

`projectSharedDocument`'s final `tr.doc.eq(target)` (`shared-projection.ts:139`) converts this
to `PROJECTION_TARGET_MISMATCH` before dispatch, so through the editor this is currently a
HOLD, not corruption; but `FolioFrameStep` itself is a registered `Step` and can yield a
non-unique document to any other caller.

Precise fix:
- Make the collision rule exact: only ids belonging to the *live retained node actually
  embedded at that placeholder* may be exempt. Any other template id that already exists in
  the source doc must fail `FRAME_ID_COLLISION`, even if it is a descendant of a retained
  node. Concretely, track the set of ids supplied by each embedded retained node and remove
  only those from a global "already present" set; a template-only node reusing one must fail.
- In `detectWrap`, if an old id inside the new wrapper is not a direct child at the wrapper's
  target parent (e.g. `X` currently inside retained `Q`), do not put it in the wrapper
  template as a new node: either move it first with a move step or skip this frame candidate.
- Add a focused test asserting `apply` fails (`FRAME_ID_COLLISION`) for the example above.

## Not reported as findings

- Missing modules (e.g. `block-commands`, `rich-inline`, `rich-document`, client/http, main)
  are absent from this isolated copy; I did not treat their absence as a defect and could not
  execute their paths.
- No GUI/Electron/browser/E2E, clipboard, native dialog or real-data behavior was exercised.
- Move `shape` rejection on concurrent descendant insertion (`pm-move.ts:75-76`) is
  conservative fail-closed behavior; not counted as a violation here.
- I did not re-report the already-fixed inclusive retained-boundary association in
  `shared-frame-step.ts`.
