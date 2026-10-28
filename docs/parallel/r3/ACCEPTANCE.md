# Round 3 acceptance

Each line remains NOT_RUN until evidenced against a fixed commit/build. Fixture-only UI is not live-storage acceptance.

- Migration: duplicate legacy row IDs across databases and collision with Page ID, duplicate/trashed DB and history-only rows; mapping is stable on retry; forced failure rolls back mapping/pages/version; unknown schema and history remain byte-for-byte intact; old app rejects new DB and old snapshot opens with its matching assets.
- Persistence: one canonical Page per record; title, doc, values and view changes survive restart; stale revision rejects; property ACK cannot overwrite pending doc; no stale whole-rows writes.
- History: known legacy DB snapshot restore reconciles historical membership/title/values while retaining migrated/new bodies and later records; unknown history is untouched and stops.
- Lifecycle: database and record trash/restore, records under deleted databases, independent database and record duplication, correct membership/order and IDs.
- UX: table/board/calendar/gallery open the same full-page record; search, internal links/backlinks, Editor and revision behavior match ordinary pages; focus/navigation and save errors remain accessible.
- Recovery: isolated backup and pending-edit recovery of record with attachment into a second isolated workspace; relevant metadata, references and assets preserved.
- Editor: multiple blocks, nested selection, copy/cut/paste including errors, undo/redo and reopen for normal/record pages. Physical IME is separately NOT_RUN unless physically tested.
- UI: 960/1024/1440, light/dark, keyboard/focus, overflow and save state; Notion observation and Folio tests recorded separately, unobserved comparison UNKNOWN.
- Scale: report conditions and samples at 1,000 and 10,000 records for load/view/search/input/save; no 100,000-row comfort claim.
- Validation: isolated check, all unit, build, all E2E with retries=0 and fixed build/source, review hygiene and isolated packaged startup. Record failed attempts, exit codes and hashes.
