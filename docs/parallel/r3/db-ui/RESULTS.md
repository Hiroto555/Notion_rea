# Round 3 DB UI — implementation and evidence

- Owner: DB UI (lane C)
- Branch: `r3/db-ui`
- Worktree: `Folio-r3-db-ui`
- Remote master: `bd0f1e753258b8f29c3a436753f3bad9a1f84b16`
- Contract: `c6ced9c906dbce1a0df1375b63d4d627f4fdb021`
- Lane setup (excluded from the feature commit): `2ec249d17f3d272856b791cc412ba88634e99fdf`
- Feature commit: **not created** — the shared Git index write is blocked by the
  harness sandbox; the working-tree changes are retained (see "Local commit")
- Push / master merge: **not performed**

## Read this first: live storage is not connected

This lane delivers the **contract-shaped UI and its fixture/component tests**. The
real record IPC is not connected:

- `requestSchema` still has no `record:*` / `database:settings` commands.
  `RecordRequest` remains a reserved wire shape.
- `App.tsx` (Core-owned) still imports the legacy `Database` component and saves
  the whole v2 `DatabaseData` through the old `onChange` route. The new
  `DatabasePresentation` is exported but **not mounted by App yet**.
- The Playwright harness (`tests/db-ui/harness.tsx`) supplies in-memory
  contract-shaped callbacks. A pass there proves the display/interaction
  behavior against the contract shape, **not live SQLite persistence, restart,
  search/link navigation or Core's PendingEdits**.
- The legacy whole-rows route must not be used for migrated records; Core must
  mount `DatabasePresentation` and disable the legacy path before record storage
  is enabled.

## Coordinator review (Round 3) and resolution

The integration review raised two blocking concerns; both were acted on before
the final validation:

1. **Cell drafts were not handed to Core until blur** and could be lost on
   navigation/unmount. Now every title/property change calls
   `callbacks.patchRecord(pageId, revision, patch)` immediately (including text
   and number cells), with a local display buffer only. The harness asserts the
   patch exists before Enter/blur and that Escape sends a revert patch to the
   value captured when the edit began. A failed patch is retained for explicit
   retry. **Residual blocker:** durable ownership of a rejected pending patch
   across unmount/recovery must be Core's (see [HANDOFF.md](HANDOFF.md) B1).
2. **Settings used to rebase a stale full settings snapshot onto a locally
   bumped revision.** That is removed. The UI now queues semantic intents
   (active view, view patch, view CRUD, property add) and applies them to the
   newest canonical settings/revision before each write. A harness test injects
   an external settings update while a write is in flight and verifies the
   external filter is preserved and the retried rename is applied. Same-field
   concurrent merges and the full-settings wire shape remain Core risks
   ([HANDOFF.md](HANDOFF.md) B3).

The concrete integration blockers and residual risks are in
[HANDOFF.md](HANDOFF.md). This report does not claim that Core's unsaved-state
ownership is implemented; App/IPC are still Core-owned and unconnected.

### Additional review (second pass) and resolution

1. **Optimistic view re-evaluation changed new ids.** `addView` and
   `duplicateView` intents now carry the generated id; optimistic application,
   retry and queued follow-up edits use the same view id. Add/duplicate are
   idempotent when the id already exists; delete is a no-op if absent; move
   carries a base order and is a no-op if already applied. Harness test:
   "an optimistic view keeps its id through a failed add and queued rename".
2. **Empty-cell Escape confused null and absent.** Cell baselines now record
   `{present, value}`; an untouched absent cell produces **no** patch, while a
   value that may have reached Core produces a delete (`null`) on Escape.
   Helpers and unit tests cover `present:false` vs `false`/`0`/`""`.
3. **A failed patch could disappear when another patch succeeded.** Failures
   are merged and cleared **per cell** (title + each property key). A successful
   title save no longer erases a failed status change; the unsaved indicator
   counts outstanding cells. Harness test:
   "a failed cell stays retryable after another cell succeeds".
4. **Filter/view-name drafts could be lost on unmount.** They are no longer
   blur drafts: every change is sent as a semantic settings intent immediately.
   Harness test: "filter and view-name edits are sent before navigation without
   blur". Residual: an intent still queued behind an in-flight settings ACK at
   unmount is component-local (HANDOFF B3; view metadata only).
5. **Same-field settings rebase could overwrite external changes.** Each view
   patch carries the field values the user saw and checks them against the
   canonical settings before applying. A same-field external change is surfaced
   as a conflict with a "変更を破棄" action; it is not overwritten. Different
   fields still rebase safely. Harness test:
   "a same-field external change is reported instead of overwritten".
   Same-field _merging_ remains a Core/contract item (semantic settings
   command), recorded in HANDOFF B3.

### Third review (view/filter/sort ids, delete target, failed-cell generations)

1. **A fixed view id was not enough: copied filter/sort ids could change on
   retry.** `stableCopiedView` now remaps every copied filter node and sort rule
   id deterministically from the new view id (`viewId:filter:path`,
   `viewId:sort:index`). Optimistic application and retry produce identical ids,
   so a queued filter/sort patch does not report a false conflict. Unit test
   plus a harness test that queues a sort edit on a failed new view.
2. **`deleteView` could delete a view that changed after the user saw it.**
   The delete intent now carries the complete target view snapshot and
   compare-and-swaps it. An absent view remains an idempotent no-op; a changed
   target is a conflict. Harness test: "deleting a view is rejected after the
   same view changed externally".
3. **An older failed patch could be retried after a newer same-cell edit was in
   flight.** Each cell now has a generation counter. Sending a new patch clears
   that cell's older failure synchronously and advances the generation; stale
   success/failure callbacks are ignored. A retry before the new ACK cannot send
   the old value. Harness test: "a newer cell edit supersedes an older failed
   patch before its ACK".
4. **Settings intents queued behind an in-flight ACK can still be lost at
   unmount.** Filter/view-name changes are sent per change, but the coalescing
   window is component-local. This is an **integration blocker** until Core owns
   a settings queue/flush contract (HANDOFF B3), not a claim of durable view
   settings.

## Contract conflict to resolve

`AGENT_TASK.md` says "全画面を必須とし、契約にあるpeekも実装する". The shared
`docs/parallel/r3/CONTRACT.md` says **"Full-page record opening is required;
peek is not adopted in this round."** The Core lane task also makes peek
conditional on the shared contract adopting it. This lane followed the shared
contract: full-page record opening is implemented and exercised; no peek
navigation mode is claimed or wired. If the coordinator wants peek in Round 3,
it needs a contract update first (and Core's record-page composition), because
peek/full must share the same unsaved draft owned by Core.

## Implemented

### `src/database/DatabasePresentation.tsx` (new contract surface)

- Props: `{ value: DatabaseProjection, callbacks: DatabaseCallbacks }`
  (`DatabasePresentationProps`) plus optional `databasePageId` and `className`
  for UI-only memory keying. The projection is read-only; no rows are written.
- Four views over the same projection and page identities:
  - table (inline title/property editing, grouping, row actions)
  - board (group columns, drag and drop, column add)
  - gallery (optional grouping)
  - calendar (month navigation, date property, drop-to-date, add-on-day)
- Every view opens records through `callbacks.openRecord(pageId)`; a record is
  never identified by a legacy row id.
- Filter text, nested `FilterBuilder` conditions, multiple sorts, grouping and
  grouping direction, view switch/create/rename/duplicate/delete/move,
  property creation, and active-view selection all go through
  `callbacks.updateSettings(revision, settings)`.
  - `settingsWithoutRows` strips `rows` before every write; tests assert that
    no `updateSettings` payload has a `rows` key and no `patchRecord` payload
    contains a rows snapshot.
  - Settings writes are single-flight **semantic intents**, not stale full
    settings snapshots. An intent is applied to the newest known canonical
    settings/revision (including a newer parent projection) before sending. If
    the projection advances while a write is in flight, the next intent is
    rebased onto the newer canonical settings rather than reusing old bytes
    with a locally bumped revision.
  - View patches carry the field values the user saw (compare-and-swap); a
    same-field external change becomes a visible conflict instead of a silent
    overwrite, with an explicit "変更を破棄". View create/duplicate intents
    carry deterministic view **and copied filter/sort** ids, so optimistic
    follow-up edits keep their identity through retries. Delete carries the
    full target view snapshot and rejects a changed target; an absent view is an
    idempotent no-op. Move uses a base order and is a no-op if already applied.
  - This is a view-settings coalescer, **not** a record/Editor autosave queue;
    record content is patched through Core's callback and revision. A failed
    intent batch stays retryable. Filter text and view name are sent on every
    change (no blur draft).
  - Failure keeps the optimistic settings/draft visible, shows an alert, and
    offers an explicit retry.
- Record lifecycle: `createRecord` (auto-opens the created record after ACK),
  `duplicateRecord`, `trashRecord`, `restoreRecord`. Busy/ACK/error are shown;
  the projection remains the source of displayed records.
  - A deleted record's `deletedAt` hides it from the four views and lists it in
    the "ゴミ箱のレコード" disclosure with restore.
- Inline cell edits:
  - **every** title/property change calls `patchRecord` immediately, before
    Enter/blur, so Core receives the edit even if the DB unmounts. Select,
    date, checkbox and text/number all use the same path.
  - patches carry `pageId` and the last observed `revision`; the UI keeps the
    typed draft visible until the acknowledged projection reflects it. Blur
    never holds an unsent draft; it only ends the local edit baseline.
  - Escape uses a presence-aware baseline: an untouched absent cell writes
    nothing; after a value the revert is a delete (`null`), not an ambiguous
    empty/null write. It cannot undo a patch Core already accepted.
  - on rejection the draft and **per-cell** failed patches are retained; a
    successful save of a different cell does not clear them. Each cell has a
    generation: a newer same-cell edit supersedes the old failure synchronously
    and stale callbacks are ignored. A user-initiated "未保存の変更を再試行"
    retries only the outstanding cells with the current revision. The failed
    cells are component-local; Core must retain them across unmount
    ([HANDOFF.md](HANDOFF.md) B1).
  - no whole-rows write exists in this path.
- Filtered-out open record decision: opening a record is Core/App navigation;
  changing a filter never closes or rewrites the open record. On returning, a
  filtered-out record simply has no visible row and receives no focus jump.
  This is documented and covered by the harness test.
- Focus/scroll:
  - each table/card origin carries `data-record-origin=pageId`;
    `openRecord` remembers the origin and Core can call
    `focusRecordOrigin(pageId)` on back.
  - while the renderer stays alive, the DB also restores the origin focus once
    on remount, and remembers scroll position per `(databasePageId, viewId)`.
  - Escape closes the filter/property panel; Enter/Tab behavior is documented
    in the record surface below.
- Board group direction: the legacy screen forced `asc`. The new surface uses
  the saved `groupBy.direction` and exposes `グループの並び順` (asc/desc).
  The legacy one-line fix is in `Database.tsx` and is verified in the actual
  Electron app (see evidence).

### `src/database/RecordPage.tsx` (display-only record page)

- Full-page display component for Core's single Editor:
  - acknowledged `RecordProjection` + Core-owned unsaved `RecordDraft`
  - title, typed properties (`PropertyField`), body slot (`body`), save state
    (`saving`/`saved`/`error`), explicit retry
  - read-only reasons: `trashed`, `database-trashed`, `document-error`
  - trash/restore/duplicate actions, disabled while read-only
  - Escape calls `onBack` (unless composing, an open native select, or a nested
    dialog); Enter in the title hands focus to the body slot (or the first
    property when no `focusBody`); Tab uses normal DOM order
  - no state is persisted by this component; Core owns navigation, PendingEdits,
    the Editor, errors and recovery.
- `RecordPage` is not mounted by App yet (Core owns App); the harness composes
  it with a body slot and demonstrates save failure/retry/read-only/trash.

### Supporting files

- `src/database/PropertyField.tsx`: shared typed property control.
- `src/database/database-ui.ts`: display derivation (filter/sort/group-only
  local v2 copy), settings transforms, typed cell patches, draft helpers,
  UI-only scroll/focus memory.
- `src/database/database.css`: lane-owned CSS (all classes prefixed `r3-`).
  Shared `styles.css` / `Modal.tsx` were not modified.
- `src/database/Database.tsx`: re-exports the new surface and keeps the legacy
  component (now marked deprecated) so App keeps compiling until Core connects
  the contract. Legacy board direction fixed there.

## Changed files

```
M  src/database/Database.tsx
A  src/database/DatabasePresentation.tsx
A  src/database/PropertyField.tsx
A  src/database/RecordPage.tsx
A  src/database/database-ui.ts
A  src/database/database.css
A  tests/database-ui.test.ts
A  tests/db-ui/harness.tsx
A  tests/db-ui/index.html
A  tests/e2e/db-ui.spec.ts
A  tests/e2e/db-ui-legacy.spec.ts
A  docs/parallel/r3/db-ui/RESULTS.md
```

Not changed: `src/renderer/App.tsx`, `src/renderer/styles.css`,
`src/renderer/Modal.tsx`, `src/database/model.ts`, `src/shared/types.ts`,
`src/persistence/**`, `src/main/**`, `src/preload/**`, package manifests,
other worktrees.

## Validation ledger

All commands were run through
`env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs ...` from this
worktree, with the shared test lock, `retries=0`, and isolated
data/cache/tmp/logs under `output/agent-workspace/`.

| #   | Command                                                                            | Exit | Result                                                                                                                   | Log                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `check` (initial)                                                                  | 0    | PASS                                                                                                                     | `output/agent-workspace/logs/2026-10-27T07-14-58-550Z-check-7346269a.log`                                                                                                  |
| 2   | `test` (new helpers)                                                               | 0    | 112/112 (24 new)                                                                                                         | `output/agent-workspace/logs/2026-10-27T07-18-55-813Z-test-25f6691b.log`                                                                                                   |
| 3   | `test:e2e db-ui.spec.ts` (attempt 1)                                               | 1    | 5 failed (draft/title display, add-sort precondition, Enter focus expectation, collapsed trash, save-state timing)       | `output/agent-workspace/logs/2026-10-27T07-24-18-381Z-test-e2e-ca59a402.log`                                                                                               |
| 4   | `test:e2e db-ui.spec.ts` (attempt 2)                                               | 1    | 9 passed, 1 selector collision (`保存を失敗させる` vs `設定の保存を失敗させる`)                                          | `output/agent-workspace/logs/2026-10-27T07-29-30-953Z-test-e2e-50a07eeb.log`                                                                                               |
| 5   | `test:e2e db-ui.spec.ts` (attempt 3)                                               | 0    | 10/10                                                                                                                    | `output/agent-workspace/logs/2026-10-27T07-32-18-082Z-test-e2e-64312aa7.log`                                                                                               |
| 6   | `build` (first pass)                                                               | 0    | PASS, chunk-size warnings only                                                                                           | `output/agent-workspace/logs/2026-10-27T07-33-24-401Z-build-32785c64.log`                                                                                                  |
| 7   | `test:e2e database-v2.spec.ts` (workspace sandbox)                                 | 1    | Electron Chromium `sandbox initialization failed: Operation not permitted`; product not at fault                         | `output/agent-workspace/logs/2026-10-27T07-34-36-905Z-test-e2e-67cd6dff.log`                                                                                               |
| 8   | legacy board E2E, **pre-fix** (host approval)                                      | 1    | Reproduced the bug in the real app: expected `[完了, 進行中, 未着手, 未設定]`, received `[未着手, 進行中, 完了, 未設定]` | `output/agent-workspace/logs/2026-10-27T07-46-01-524Z-test-e2e-257583d5.log` and `output/playwright/results/db-ui-legacy-legacy-board--87b58--descending-group-direction/` |
| 9   | legacy board E2E, **post-fix** (host approval)                                     | 0    | 1/1 PASS                                                                                                                 | `output/agent-workspace/logs/2026-10-27T07-48-50-598Z-test-e2e-df0c05d1.log`                                                                                               |
| 10  | `test` (full, attempt 1)                                                           | 1    | 109/112; three **existing** `recovery.test.ts` cases hit the 5s per-test timeout under load                              | `output/agent-workspace/logs/2026-10-27T07-54-43-774Z-test-85336af3.log`                                                                                                   |
| 11  | `test` (full, attempt 2)                                                           | 0    | 112/112                                                                                                                  | `output/agent-workspace/logs/2026-10-27T08-04-55-408Z-test-e74db5c7.log`                                                                                                   |
| 12  | `build` (final source/build fixed before E2E)                                      | 0    | PASS                                                                                                                     | `output/agent-workspace/logs/2026-10-27T08-05-24-905Z-build-c2d85cce.log`                                                                                                  |
| 13  | `test:e2e db-ui.spec.ts` (11 tests)                                                | 0    | 11/11                                                                                                                    | `output/agent-workspace/logs/2026-10-27T08-05-36-420Z-test-e2e-672e741e.log`                                                                                               |
| 14  | `test:e2e` (full, host approval, retries=0)                                        | 0    | **63/63 PASS** (11.6m)                                                                                                   | `output/agent-workspace/logs/2026-10-27T08-09-14-755Z-test-e2e-39764665.log`                                                                                               |
| 15  | `test:e2e db-ui.spec.ts` (after adding 960/1024/1440 assertions; test-only change) | 0    | 11/11                                                                                                                    | `output/agent-workspace/logs/2026-10-27T08-23-46-335Z-test-e2e-9bb45827.log`                                                                                               |
| 16  | `test:e2e db-ui.spec.ts` after the review refactor (attempt 1)                     | 1    | 9 passed, 3 failed: title Escape baseline, filter text compare against the draft view, rebase test read too early        | `output/agent-workspace/logs/2026-10-27T08-38-45-462Z-test-e2e-2ba24c9f.log`                                                                                               |
| 17  | `test:e2e db-ui.spec.ts` after refactor (attempt 2)                                | 1    | 10 passed, 2 failed: title Escape still used `record.title`; rebase test read before the retry ACK                       | `output/agent-workspace/logs/2026-10-27T08-43-27-449Z-test-e2e-86c3748a.log`                                                                                               |
| 18  | `test:e2e db-ui.spec.ts --grep rebased` (instrumented diagnosis)                   | 1    | Confirmed the retry `updateSettings(21, …)` was still delayed when the test read the projection; not a product race      | `output/agent-workspace/logs/2026-10-27T08-41-56-615Z-test-e2e-9655b123.log`                                                                                               |
| 19  | `test` (full) after refactor, attempt 1                                            | 1    | 111/112; one existing `recovery.test.ts` 5s timeout under load                                                           | `output/agent-workspace/logs/2026-10-27T08-47-16-367Z-test-2e94c2c9.log`                                                                                                   |
| 20  | `test` (full) after refactor, attempt 2                                            | 1    | 111/112; same existing recovery timeout                                                                                  | `output/agent-workspace/logs/2026-10-27T08-47-52-041Z-test-868c2f41.log`                                                                                                   |
| 21  | `test` (full) after refactor, attempt 3                                            | 0    | 112/112                                                                                                                  | `output/agent-workspace/logs/2026-10-27T08-48-37-222Z-test-22488480.log`                                                                                                   |
| 22  | `build` after refactor                                                             | 0    | PASS; dist hashes **identical** to the build used by full E2E 63/63 (new surface JS is still tree-shaken)                | `output/agent-workspace/logs/2026-10-27T08-46-46-179Z-build-8c9178a9.log`                                                                                                  |
| 23  | `test:e2e db-ui.spec.ts` final (12 tests)                                          | 0    | 12/12, includes immediate-handoff, Escape-revert and external-rebase tests                                               | `output/agent-workspace/logs/2026-10-27T08-45-32-034Z-test-e2e-dfedaa89.log`                                                                                               |
| 24  | `test:e2e` **final** full suite (51 existing + 12 DB UI + 1 legacy)                | 0    | **64/64 PASS** (8.2m), retries=0, same fixed dist as step 22                                                             | `output/agent-workspace/logs/2026-10-27T08-57-53-080Z-test-e2e-9a2232d0.log`                                                                                               |
| 25  | `check` after the second review fixes                                              | 0    | PASS                                                                                                                     | `output/agent-workspace/logs/2026-10-27T09-44-08-081Z-check-6791e95d.log`                                                                                                  |
| 26  | `test database-ui` (unit helpers, 31 tests)                                        | 0    | 31/31                                                                                                                    | `output/agent-workspace/logs/2026-10-27T09-36-17-752Z-test-3f2b08db.log`                                                                                                   |
| 27  | `test:e2e db-ui.spec.ts` after the second review fixes (18 tests)                  | 0    | 18/18; all review regressions covered                                                                                    | `output/agent-workspace/logs/2026-10-27T09-44-15-859Z-test-e2e-4961b462.log`                                                                                               |
| 28  | `test` (full) after the second review fixes, attempt 1                             | 1    | 118/119; one existing `recovery.test.ts` 5s timeout under load                                                           | `output/agent-workspace/logs/2026-10-27T09-38-14-924Z-test-6a1642e7.log`                                                                                                   |
| 29  | `test` (full) after the second review fixes, attempt 2                             | 0    | **119/119**                                                                                                              | `output/agent-workspace/logs/2026-10-27T09-38-59-827Z-test-93f2ca0a.log`                                                                                                   |
| 30  | `build` after the second review fixes                                              | 0    | PASS; dist hashes **identical** to the 64/64 full-E2E build (new surface JS still tree-shaken)                           | `output/agent-workspace/logs/2026-10-27T09-38-36-634Z-build-788d462b.log`                                                                                                  |
| 31  | `check` after the third review fixes                                               | 0    | PASS                                                                                                                     | `output/agent-workspace/logs/2026-10-27T10-09-29-361Z-check-a4f8e8b7.log`                                                                                                  |
| 32  | `test database-ui` (unit helpers, 34 tests)                                        | 0    | 34/34                                                                                                                    | `output/agent-workspace/logs/2026-10-27T10-07-08-418Z-test-6810b3bc.log`                                                                                                   |
| 33  | `test:e2e db-ui.spec.ts` after the third review fixes (21 tests)                   | 0    | 21/21; includes filter/sort-id, delete-target and failed-cell generation regressions                                     | `output/agent-workspace/logs/2026-10-27T10-10-07-921Z-test-e2e-ad07c4f9.log`                                                                                               |
| 34  | `test` (full) after the third review fixes                                         | 0    | **122/122**                                                                                                              | `output/agent-workspace/logs/2026-10-27T10-07-30-686Z-test-5dc933d6.log`                                                                                                   |
| 35  | `build` after the third review fixes                                               | 0    | PASS; dist hashes **identical** to the 64/64 full-E2E build (new surface JS still tree-shaken)                           | `output/agent-workspace/logs/2026-10-27T10-07-11-009Z-build-c4f9405b.log`                                                                                                  |

Notes on failed attempts:

- First harness run failure 1 exposed a real bug: the table title display read
  `record.values.title` instead of `record.title`. Fixed and covered by the
  inline-edit harness test.
- First harness run failure 2 was a test precondition: the primary sort must be
  set before "複数並べ替えを追加" creates the second rule. Fixed in the test,
  not by weakening the UI behavior.
- First harness run failure 3 was an expectation mismatch: Core's `focusBody`
  handoff deliberately moves Enter from the title to the body, not the first
  property.
- First harness run failure 4 needed the trash `<details>` to be opened before
  its restore button is exposed.
- First harness run failure 5 was timing: the injected delay was shorter than
  the assertion round-trip.
- Second harness run's only failure was a selector collision:
  `保存を失敗させる` also matched `設定の保存を失敗させる`; the test now uses an
  exact checkbox name.
- Full unit attempt 1's three timeouts are in existing recovery tests, not in
  the new lane test; no test was skipped or weakened. The rerun passed.
- Full E2E ran against the fixed build from step 12. Step 15 only strengthens
  the test file (adds 960/1024/1440 overflow assertions); product source and
  dist were not changed between steps 12–15.
- After the coordinator review, step 16 failure 1 was a real baseline bug: the
  title Escape path still used the latest acknowledged title instead of the
  captured pre-edit value. Step 17 confirmed the corrected version. Failure 2
  was the settings commit comparing against the live draft view (it skipped
  the write and the filter vanished); fixed by comparing committed settings.
  The rebase test failure was test timing: the retry ACK is delayed, and the
  test read the projection as soon as the error alert disappeared. It now polls
  for the retry result. None of these was hidden or skipped.
- Steps 19–20 are the existing recovery-test 5s timeout under load again; step
  21 passes the same source. This is a pre-existing load sensitivity, not a
  lane test failure.
- Step 24 supersedes the earlier full-suite run (step 14) and includes the
  reworked 12-test DB UI harness. It uses the identical final dist hashes below.
- `git add` for the feature commit was attempted after validation and failed
  with exit 128 (`index.lock: Operation not permitted`). Per the instruction not
  to extend permissions or bypass the Git boundary, no workaround was used and
  no commit/push/merge was attempted. The files remain in the working tree.

- The final app dist (steps 30/35) is byte-identical to the dist used by the
  64/64 full E2E (step 24), because the unmounted presentation JS is still
  tree-shaken. The 64/64 run therefore still exercises the same application
  bytes (51 app tests + 12 harness + 1 legacy at that time).
- The second and third reviews added harness and unit regressions. The final
  targeted DB UI harness is 21/21 and the full unit suite is 122/122. The full
  suite would now be 73 tests (51 + 21 + 1) and was **not** re-run because the
  app dist is unchanged; the additional evidence is the targeted 21/21 harness
  run. This is stated rather than implied.
- The earlier one-shot host approval was only for Electron/Chromium E2E; the
  final harness runs use ordinary Chromium and require no host access. No Git
  permission was escalated.
- Settings intents that remain queued behind an in-flight ACK at unmount are
  still an integration blocker (HANDOFF B3). They are view metadata, never
  record content.

### Fixture / harness environment qualification

- The harness is a **Chromium + Vite** component harness, not the Electron app.
  `@playwright/test` 1.64 expects Chromium revision 1248, which is not installed
  in the local Playwright cache; the spec discovers the newest installed
  Chromium (`chromium-1234` here) or `FOLIO_TEST_CHROMIUM`, without changing
  repo dependencies. This is a test-environment adaptation, not a product
  change.
- The Electron app cannot start its Chromium subprocess inside the DSH
  workspace-write file sandbox (`sandbox initialization failed: Operation not
permitted`). The Electron runs above therefore used the documented one-shot
  host approval; no permanent sandbox change was made and no product code was
  altered to bypass it.
- `db-ui.spec.ts` starts an isolated Vite server on a free port and reuses the
  isolated Vite cache. The full E2E suite is serialized by the shared lock.

## Acceptance mapping (fixture evidence vs live evidence)

| Acceptance (Round 3)                                     | Status in this lane                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Same record opened from table/board/calendar/gallery     | PASS in fixture harness: same `pageId`, title, values and body slot across all four views                           |
| Title/value editing reflected in all views               | PASS in fixture: record-page and inline edits update the shared projection                                          |
| Close/reopen, app restart, search/link direct navigation | Close/reopen PASS in fixture; **restart/search/link NOT_RUN** because App/IPC are not connected                     |
| Failure/conflict keeps edits; read-only not overwritten  | PARTIAL: fixture retains the draft/patch and retry works; durable ownership across unmount is **Core's B1 blocker** |
| Cell edit reaches Core before blur/unmount               | PASS in fixture: `patchRecord` is called on change, asserted before Enter/blur                                      |
| External settings change is not overwritten              | PASS in fixture: in-flight write rejects, retry rebases the intent onto external settings (HANDOFF B3)              |
| Focus/keyboard                                           | PASS in fixture: Enter title→body, Escape back, origin focus restored, table scroll preserved, Tab order            |
| Board direction bug                                      | Reproduced in real Electron app before the fix; fixed and PASS after                                                |
| Core joint E2E                                           | **NOT_RUN** — Core has not connected App/IPC; this is an integration step                                           |
| Persistence/history/lifecycle/recovery                   | **NOT_RUN for live data**; UI callback behavior only                                                                |
| Physical IME                                             | **NOT_RUN** (synthetic keyboard only)                                                                               |
| Notion comparison                                        | **UNKNOWN / not performed**                                                                                         |

## Integration requests to Core

1. Mount `DatabasePresentation` in `App.tsx` with a real
   `{ value, callbacks }` (`DatabasePresentationProps`); remove the legacy
   `Database` import and disable the whole-rows save route for migrated records.
2. Provide a stable owning database id to the surface. The shared
   `DatabaseProjection` currently has no `databasePageId`; this lane accepts an
   optional `databasePageId` prop and otherwise falls back to the first
   record's membership (empty databases collide on `unknown-database`). A
   follow-up contract addition is preferable.
3. Implement the callbacks with Core's PendingEdits/queue:
   - `patchRecord` is now called per change; it must serialize/coalesce per
     record, return a projection without a doc snapshot, retain rejected
     pending patches across navigation/unmount, and reject stale revisions
     without losing drafts (HANDOFF B1).
   - `updateSettings` receives rows-free settings built from semantic intents
     and rebased on the newest projection. It must validate/normalize settings,
     reject any `rows` payload, enforce the revision and return the canonical
     projection. Same-field concurrent patches still need Core review (HANDOFF
     B3).
   - Lifecycle callbacks remain atomic in Core; they return projection (void for
     trash).
4. Compose the record page: fetch the Page by `pageId`, mount exactly one
   `Editor` with `documentId=pageId` in `RecordPage`'s `body` slot, and pass
   `readOnly` (`trashed` / `database-trashed` / `document-error`) plus a
   Core-owned `draft`. Wire `onBack` to App navigation and call
   `focusRecordOrigin(pageId)` when returning (or rely on the DB's one-shot
   memory).
5. Decide peek explicitly. This round's shared contract excludes it; if
   adopted later, the peek and full page must render from the same Core draft.
6. Remove the temporary legacy `Database` export once App is switched; keep the
   one-line board-direction behavior in the new surface (already covered).

## Remaining work / limits

- No live save, migration, restart, search/link, history, recovery or packaged
  startup was verified for the new UI.
- **Durable unsaved-record ownership is still Core's blocker:** the UI now
  hands every change to Core immediately and keeps failures per cell with
  generations, but a rejected patch is still retried from component state and
  is lost on unmount unless Core retains it. See [HANDOFF.md](HANDOFF.md) B1.
- **Settings intents are component-local until acknowledged:** queued intents
  can be lost if the database unmounts mid-flight. They are view metadata, not
  record content, but Core should own/cancel them if that matters. See
  [HANDOFF.md](HANDOFF.md) B3.
- Record page icon editing is not offered: `RecordPatch` is title/values only.
  Page icon/doc patching remains Core's contract.
- `Date`/property values are not normalized beyond Core's validated projection;
  invalid dates are displayed as empty browser inputs.
- Drag-and-drop is HTML5 DnD; keyboard users can change the same property in the
  record page. Drag reordering inside a group is not implemented (status/date
  values change only).
- Focus/scroll memory is UI-only, renderer-lifetime state keyed by the owning
  database id; restart resets it. Empty databases need `databasePageId`.
- Error toasts auto-clear; failed edits persist until acknowledged or retried.
- Not measured: 1,000/10,000 record scale, physical IME, Notion parity and
  pixel screenshots. The harness covers 960/1024/1440/390 overflow plus
  light/dark; the existing app-level UI 2.0 E2E covers 960/1024/1440 shell
  metrics (not the unmounted DB surface).
- Existing `recovery.test.ts` 5s timeouts recurred under system load on three
  separate full unit runs (steps 10, 19, 20); every rerun of the unchanged
  source passed (112/112). No test was skipped, weakened or retried
  automatically. This is a pre-existing load sensitivity outside this lane.
- **Bundle caveat:** because App.tsx does not mount `DatabasePresentation`
  yet, Rollup tree-shakes its JS out of `dist/renderer/assets/index-C4Amjt4C.js`;
  only the dedicated `r3-` CSS side effect is included. The harness compiles
  the new surface from source through Vite. The Electron full-suite pass
  exercises the legacy DB screen and the rest of the app; the new DB surface
  evidence is the harness above. At Core integration the JS will enter the
  bundle and this hash will change.

## Source / build hashes (final tree before the feature commit)

```
src/database/Database.tsx            82e8cc9b3d2bae5fae61186a4a4daba239f9c50856f66a44054a2250ae08dd1d
src/database/DatabasePresentation.tsx aacb63b95ca21a0495177e9987c930c7b2c13129974fab7b7a9fc67a642d4fe1
src/database/RecordPage.tsx          3e6801deb6d837eac25752af67a43f1b8b31f60146b25756e95d0cb45f7dc3f5
src/database/PropertyField.tsx       a4fa5b14e91c3a1fc81d81bee87a4b7cc87c78de896141eca5681c38a7c5f62f
src/database/database-ui.ts          1aa1b0a6547f61035bd18a69dbb854b1c82c17b4ad1fd20ddff38dc6e2edd9b3
src/database/database.css            e5dda2d209c24d65a48f3747f568f8a97ea0a0012a2bd755026e04e0b9c96213
tests/database-ui.test.ts            47f1b58044e1f302dfa3dc222ce4633fdb90a80e1d1985f9e156e3da90ba1993
tests/db-ui/harness.tsx              7de0eaf2d81cc55d710dd4488961091d317a63bd467a3148c63be9aa59513c0a
tests/db-ui/index.html               d09f6d85c0830a0668e4d185eb82b722ff7f71b7a6ce4b80c7b28cf36ddbb259
tests/e2e/db-ui.spec.ts              c098c998beeee6e3cb55ebe85bc6d2768041a74b320365f1eb54bb4dabb134a6
tests/e2e/db-ui-legacy.spec.ts       e86b76fca3dd8f109166865caf7fe601ae956f94058918bb944da9c6e107ec2b

dist/main.cjs                        66c28834f663b6537f80b9d3613790ec723761e2b0e24de0ad39d705ab8274a5
dist/preload.cjs                     3e39ba8560acf6abee58233896192a26f313dc2402abf82ad260650b42f1fc26
dist/renderer/assets/index-C4Amjt4C.js  26595a1545ec1aa86bde8db5d61eec94cf36f3b624cf06df24d4acbedefc9dd5
dist/renderer/assets/index-BuQDUNHI.css bb2474bff432a11539b54c7a9d1745e19d89d34766aa6a4c536cdfe04fb7d51d
```

Environment: macOS 26.6.2 arm64 / Node v24.20.0 / npm 11.19.0 / Electron 45.0.0 /
Vite 7.3.7 / Vitest 3.2.7 / Playwright 1.64.1.

## Local commit — blocked by the workspace boundary

- **Feature commit SHA: none.** The working tree retains the complete change set.
- Attempt: `git add <lane files>` → exit 128
  ```
  fatal: Unable to create
  '<workspace-root>/Notion_rea/.git/worktrees/Folio-r3-db-ui/index.lock':
  Operation not permitted
  ```
- This is the shared Git directory being outside the writable workspace, as
  anticipated in the lane instructions. No permission escalation, bypass,
  reset, stash or cleanup was used. No push, PR, master merge or other worktree
  edit was performed.
- A host-authorized session can commit the retained files (the intended set is
  listed in "Changed files"). `docs/parallel/r3/db-ui/RESULTS.md` and
  `HANDOFF.md` are part of that set.
