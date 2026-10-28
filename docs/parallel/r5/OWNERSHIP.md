# R5 ownership and acceptance

Base: R4 integration `23f47c9ccd24376174bac170a43f5a794377d1a5`; its product/test source equals fixed validated R4 `f3c4dd1e5e2734a98c2242814b989beefd58160d`. New R5 worktrees keep all R4 checkouts and synthetic demo intact.

| Owner | Sole writer | Deliverable |
|---|---|---|
| A0 integration | App.tsx, LiveRecordDatabase.tsx, new creation UI, scripts/config, aggregate STATUS | Explicit DB creation, row add, owner/session and navigation integration |
| A1 core | shared contracts/types, persistence/main IPC, new renderer database coordinator/reliable operation, related unit | Atomic receipt for create DB/row/settings, unknown resolution, fixed owner revision |
| A2 views | DatabaseSettingsPanel and dedicated CSS, FilterBuilder, controlled readonly DatabasePresentation; related tests | Parent-controlled view/filter/sort/group UI, immediate intents and stable IDs |
| A7 QA | dedicated r5 Electron fixtures/specs/report | Real App save/restart and fault-injection tests |

Four simultaneous agents; heavy build/unit/Electron run scheduled by A0 and not overlapped. Dependencies copied as regular private files per worktree. Existing folio-agent guard stays enabled with unique branch/port/data/cache.

R5 acceptance: create a new registered DB through explicit UI without converting existing legacy rows; add a record, open/edit title/body/basic properties, restart and reread; create/rename/switch views and save filter/sort/group settings through real IPC; preserve settings/create identity across pending/unknown, navigation, result lookup and delayed ACK; reject stale owner revisions. New DB/record receipts must prevent duplicates after lost post-COMMIT ACK. Settings and owner Page edits share one parent-owned session and revision lineage.

No push, public PR, master merge, real-user-data access or automatic legacy DB conversion. R4 full results remain separately recorded. R5 final fixed commit gets build/typecheck, full unit and full E2E. Physical IME/live Notion comparison stay explicitly separate from synthetic tests.
