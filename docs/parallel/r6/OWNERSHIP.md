# R6 ownership and acceptance

Base R5 integration `ac1d2ad6d2ae6e199c7d1344360a9670703ea164`. Product/tests equal validated R5 `51ff1727742a9d0510c50b380c297dd83af159cb` (unit499, E2E137). Preserve all R5 worktrees/demo and original Notion_rea/H0.

| Owner | Exclusive source | Acceptance |
|---|---|---|
| A0 integration | App, main/preload wiring, shared/types request union, LiveRecordDatabase, live cell enablement, R6 E2E/scripts/reports | Wire actual UI/IPC, serialize structural actions, fixed full verification |
| A1 recovery | new crash-recovery shared/persistence/renderer modules; coordinator export/import if needed; unit | Durable capture, actual SIGKILL/restart recovery, stable operation identity, no overwrite of newer data |
| A2 schema | new property-operation shared/persistence + controlled column panel; unit | Add/rename/change type, preview bound to source, reject lossy values, atomic revisions/receipt and verified backup |
| A7 migration | explicit legacy migration wrapper/shared schema/dialog and existing converter/snapshot helpers; unit | Selected DB only, preflight, verified SQLite+assets snapshot, atomic conversion/receipt, stable mapped IDs, original archive/history |

Separate branches, private dependency copies, ports56500–56504 and synthetic FOLIO_DATA_DIR. No push/master merge, no installed app or real userdata edits. Root alone schedules heavy build/unit/Electron; E2E worker1/retries0. New module request schemas are wired by A0, avoiding shared-file races. Unknown outcomes retain the same operation identity and resolve via receipts.

Migration is explicit, never startup automatic. Structural changes require quiescence and a modal lock, source revalidation inside transaction, then a fresh renderer snapshot. Type conversion never silently erases incompatible values. Recovery must be actionable after an actual killed process; an inspection-only export is not completion. Physical IME, arbitrary external writers/power failure and complete assets/history disaster restoration remain separately identified.
