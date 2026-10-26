# Validation plan

Use isolated `output/e2e-*` SQLite workspaces and real Electron windows. Never write Notion content.

1. Renderer + IPC + SQLite: title/body edit; Japanese/English text; slash and Markdown blocks; native paste; checkbox; multiple block select; DnD; undo/redo; navigation; search; subtree copy/trash/restore; close/reopen.
2. Database: change title/property; sort/filter; drag card across status groups; 42-day calendar; gallery; reopen retains rows/view.
3. Security: sandbox, context isolation, no renderer require; strict IPC operations; blocked navigation; invalid IDs and stale versions.
4. File workflows: intercept native dialog choices only in the isolated test; actual import parsing, SQLite writes, exports and attachment copies must execute. Verify exported file bytes and attachment rendering/download.
5. Load: generate 150 pages and 1,000 blocks through the real API; measure startup, page load, input-to-commit, reopen and integrity checks. This is a local reproducible sample, not a general performance guarantee.
6. Visual review: light/dark screenshots and database boards. Correct observed defects, rerun affected tests.

Unverified unless separately recorded: physical Japanese IME composition, cross-application clipboard formats beyond HTML/text, complex nested block DnD, code-signing/notarization, sync/collaboration, crash/power-loss injection, other operating systems, Notion edit fidelity.
