# R7 W0–W1 implementation record

## Boundaries

Base: `02b83806d6d08b1b2c1b70a3a8f172466d8d658e` (integrated R6). Worktree: a separate `Folio-r7-integration` checkout. The original checkout remains on its original master. All runtime validation uses synthetic data and separate Electron userData/sessionData paths.

W0 extracted only three integration seams: ranked search query, search-result rendering, and Markdown text framing. The parent owns their wiring and the existing editing lifecycle. Ten OpenCode Go workers used `opencode-go/deepseek-v4.1-flash`, variant `high`; assignments and ownership are in `OWNERSHIP.md`. Raw session exports, model verification, worker reports and parent validation logs are retained under a local evidence directory (not published).

## Resulting behavior

- The live registered DB uses `LiveRecordDatabase → DatabaseSettingsPanel → DatabaseSessionCoordinator`. View options, filters and sorts open from nearby controls; the filter expression, active chips and save/resolve states remain visible. Hidden panels stay mounted; raw numeric filter text remains parent-owned. New row and schema controls share the toolbar.
- Read-only board/gallery cards display a grapheme-bounded, escaped text excerpt from already attached record sessions. Calendar cards stay compact. No new record-fetch lane or writer was introduced. The table and record-page save lanes remain unchanged.
- Search ranks exact title, title prefix, title substring, then body/property matches with stable ordering within ranks. Transient metadata supplies escaped highlights and a window around the actual occurrence, including late matches and short Japanese queries. Stale success and failure callbacks are ignored after a newer query or dialog closure. Search still indexes the persisted workspace; pending drafts are retained separately and are not a new live search index.
- Folio Markdown exports carry a versioned, percent-encoded title comment. Import removes only the generated title wrapper matching that marker. External Markdown H1s remain body content. The current live editor body and title are exported; this is not a workspace restore format. Unsupported document sources retain the raw JSON export path.
- Record side/full switches retain the same keyed Editor and preserve pointer-origin input focus. Full record mode makes the covered document inert. Search-to-record navigation restores focus to the record title, and record close can restore a table row, board card or visible fallback.
- Page/icon/DB menus close on appropriate navigation and restore focus on Escape. A removed filter control can leave focus on the document, so DB menus also handle Escape there. Filter/sort popovers are anchored within the desktop viewport and use a bottom sheet at narrower widths.
- A visible text selection can precede ProseMirror's asynchronous `selectionchange` update. Before opening a link dialog, the active editor maps its current DOM text range through `posAtDOM` and updates only the selection, preserving its direction and excluding node selections or selections outside the editor. The captured bookmark then restores the complete range. This addressed an intermittent failure reproduced on the R6 baseline as well as during integration.
- Existing unload guards retain incomplete input; a notice now explains why quit/reload was refused. There is no automatic discard, new save protocol or main-process quit handshake.

## Contracts retained

No changes to the DB schema, shared Page persistence schema, property types, document node schema, revision/operationID contracts, save receipts, database coordinator, record coordinator, main or preload. Nested AND/OR, multiple sorts, select options, property preview/commit/resolve, post-COMMIT ACK lookup and crash recovery continue through the existing code paths. Non-table views in the live registered DB remain read-only; existing standalone presenter tests do not imply that live board DnD editing has been enabled.

## Validation interpretation

The parent reviewed and cherry-picked implementation/QA changes, adapted test interactions to the new menus, strengthened acceptance assertions, and ran the actual Electron integration. Worker reports distinguish source inspection, focused checks and unexecuted runtime scenarios. The final report in the evidence folder records exact outcomes, screenshots and limitations.

Two baseline fixture issues were addressed: a legacy-editor test assumed its evidence directory existed, and a calendar scenario depended on the current month matching a fixed seed date. An independent restart test initially assumed new DBs included select/date columns; it now adds them through the actual schema preview/commit UI before checking persistence. No assertion of input preservation was weakened.

Physical Japanese IME, prolonged daily use, real-user-data migration, large-workspace performance and full workspace restore are not established by the synthetic tests. W2 backlink/layout/restore investigations are reports only. No cloud, collaboration, AI integration, external deployment, push or merge is included.
