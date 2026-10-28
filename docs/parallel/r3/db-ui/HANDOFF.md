# Round 3 DB UI → Core integration handoff

- Lane: DB UI, branch `r3/db-ui`, base `bd0f1e7`, contract `c6ced9c`
- Status: **UI implemented and fixture-tested; live integration is NOT complete.**
  Push, master merge and other worktrees: not touched.
- Companion evidence: [RESULTS.md](RESULTS.md)

This document lists the concrete conditions that block claiming a live Database
3 record experience. It is intentionally explicit so the integration review does
not mistake the green fixture harness for live persistence.

## Blocking items (must be resolved before integration is accepted)

### B1. Core must own unsaved record state across navigation and failure

The database surface now calls `callbacks.patchRecord(pageId, revision, patch)`
on **every change**, not on blur. The presentation component keeps a local draft
only as a display buffer and to render a retry; it is not a save queue and it is
destroyed on unmount. Failed patches are tracked **per cell** (title plus each
property key) so a successful save of a different cell does not erase an
outstanding failure. Each cell also has a generation: sending a newer value
clears that cell's older failure synchronously and stale ACKs are ignored, so an
old failed value cannot be retried after a newer edit is in flight. Escape on an
empty cell distinguishes an absent key from a null delete and does not issue a
pointless delete patch.

Required from Core:

1. `patchRecord` must be safe to call repeatedly while a previous call is in
   flight for the same record (title and property keystrokes). App's queue must
   serialize, update the revision and reapply pending patches after each ACK.
2. On rejection, Core must **retain the rejected pending patch** for retry and
   recovery/export. A UI unmount must not lose the edit. The current UI keeps
   per-cell failed patches in component state (`failedEdits`) and offers a
   retry, but navigation destroys that state; Core is the only durable owner.
3. The record page (Core-composed) must receive the unsaved title/values draft
   from Core's PendingEdits. `RecordPage` accepts `draft` + `saveState` +
   `error`; it never persists anything itself.
4. Core must not return a stale document snapshot from `patchRecord`; the
   contract says the ACK is a projection.

If Core cannot meet (1)–(4), integration must keep the database UI read-only
for those fields and say so; do not ship the current fixture-only retry as live
persistence.

### B2. App must mount the presentation surface and the record page

`App.tsx` is Core-owned and still mounts the legacy `Database`
(`{ value, onChange }`, whole-rows write). That route must not be used for
migrated records.

Required:

- Load a `DatabaseProjection` from Core's canonical storage and render:
  `<DatabasePresentation value={projection} callbacks={callbacks} databasePageId={page.id} />`
  (imported from `src/database/Database.tsx` or `DatabasePresentation.tsx`).
- Remove the legacy `Database` import and disable the whole-rows save route for
  records.
- Compose the record page with the single active Editor:
  `<RecordPage ... body={<Editor documentId={record.pageId} ... />} />`.
  `Editor` must receive `documentId=pageId` and be keyed by `pageId` per the
  contract.
- Wire `openRecord` to App navigation and `onBack` back to the owning database.
  Call `focusRecordOrigin(pageId)` after returning for deterministic focus (the
  DB also remembers the origin/scroll for the renderer lifetime).
- Provide `readOnly="trashed" | "database-trashed" | "document-error"` from
  Core. The DB projection only carries `deletedAt`; a trashed owning database
  and a malformed document are not visible to the UI unless Core passes them.
- Search, `folio-page://` links and back/forward must land on the same record
  page. These are Core integration items and remain NOT_RUN here.

### B3. Settings writes are semantic intents, but the wire contract is still full settings

The UI no longer rebases a stale full settings object onto a locally bumped
revision. It queues **semantic intents** (active view, view patch, view CRUD,
property add) and applies them to the newest canonical settings/revision before
each write. Each view patch carries the field values the user saw; if the same
field changed externally, the retry reports a conflict (with a “変更を破棄”
action) instead of overwriting it. View create/duplicate intents carry their new
view id **and remap copied filter/sort ids deterministically**, so an optimistic
view keeps the same view/filter/sort ids through a failed write and queued
filter/sort edits. Delete carries the full target view snapshot and rejects a
changed target; an absent view is an idempotent no-op. Add/duplicate are
idempotent; move carries its base order and is a no-op if already applied.
Tests cover an external different-field rebase, a same-field conflict, a failed
add/duplicate plus queued rename, a queued sort edit, a same-target delete
conflict, and a newer cell edit superseding an older failure.

Residual risks Core must validate:

- `updateSettings(revision, settings)` still transmits full settings. Core must
  reject `rows`, enforce size/shape limits and check the revision atomically.
- A view patch for `sorts`/`filter` carries the field value computed from the
  displayed view. Same-field external changes are now detected and surfaced as
  a conflict (no silent overwrite), but they are not merged. Core's revision
  check is still the final authority; a semantic command API (e.g.
  `database:settings` with view id + operation) would allow a real merge. This
  is a recommended contract follow-up, not a claim that same-field merge is
  fully solved.
- **Integration blocker (settings ownership):** filter text and view name are
  sent on **every change** (no blur draft), but the writer coalesces intents
  while a settings ACK is in flight. If the database unmounts during that
  window, the unsent intents are component-local and lost. This must
  be treated as a blocker until Core provides a settings API that either
  accepts each intent immediately into a durable queue, or exposes a
  synchronous flush/commit contract the UI can call before unmount. They are
  view metadata, never record content, but no durable view-setting claim is
  allowed until this ownership is defined. The same applies to an in-flight
  request after unmount.
- Core must return the canonical `DatabaseProjection` from `updateSettings` so
  the UI can settle its optimistic copy.

### B4. `DatabaseProjection` has no owning database id

An empty database has no record from which to infer `databasePageId`. The UI
accepts an optional `databasePageId` prop; otherwise it falls back to the first
record's membership and then to `unknown-database` (colliding UI memory between
empty databases). Core should pass the owning page id, or a follow-up contract
should add `databasePageId` to `DatabaseProjection`.

### B5. Peek is excluded by the shared contract

`CONTRACT.md` says “Full-page record opening is required; peek is not adopted in
this round.” `AGENT_TASK.md` asks to implement “契約にあるpeek”. This lane
followed the shared contract: full-page opening is implemented; no peek mode is
wired. Full and peek would have to share Core's draft. A coordinator decision
and contract update are required before implementation.

### B6. Live record acceptance remains NOT_RUN here

Not yet possible in this lane:

- restart persistence of record title/doc/values,
- search/backlink/link direct navigation,
- Core joint E2E,
- live trash/duplicate/restore with real Page identities,
- record page after a real `Editor` mount and revision conflicts,
- physical IME and Notion comparison,
- 1,000/10,000 record scale with real IPC.

The fixture harness passes only display/interaction behavior against
contract-shaped callbacks.

## What Core can rely on today

- `DatabasePresentation` consumes only `{ value, callbacks }` and never writes
  rows. Every settings write is row-free (asserted in tests).
- Four views open records with the same `pageId`; table, board, gallery and
  calendar all call `openRecord`.
- Inline edits call `patchRecord` on change with `pageId` + last observed
  revision; Escape sends a revert patch to the pre-edit present/absent state (it
  cannot undo a patch already accepted by Core; the revert is a new patch).
  Failures are kept per cell and are not cleared by unrelated successes.
- Lifecycle callbacks are invoked with `pageId`/revision and ACK errors are
  surfaced; the projection stays canonical.
- `RecordPage` is display-only: title/properties/body slot, save state, retry,
  trashed/database-trashed/document-error notices, disabled read-only controls,
  Enter title→body (`focusBody`), Escape→`onBack`, Tab order.
- Dedicated CSS is scoped under `r3-`; shared `styles.css`/`Modal.tsx` untouched.
- Board group direction follows the saved `groupBy.direction`; the legacy
  forced-asc bug was reproduced in Electron and fixed.

## Verification to rerun after integration

Use the shared test lock and `retries=0`:

```sh
env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs check
env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs test
env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs build
env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs test:e2e --retries=0
```

The fixture harness (`tests/e2e/db-ui.spec.ts`) starts its own isolated Vite
server and Chromium. Electron E2E needs the one-shot host approval in this
environment because the workspace sandbox blocks Chromium's sandbox
initialization; that is an environment limitation, not a product failure.
