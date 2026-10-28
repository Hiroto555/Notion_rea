# R4 ownership and starting point

H0: `af9132ea405212a76d3b2c88f76c1b57cb98a3b9`, tree `bbfa2e91b103062f6bf1eaea8bf5f0408d8bcaf9`.
The independent clone uses `--no-local`; original repository, existing worktrees and H0 remain untouched.

| Role | Sole writer | Integration boundary |
|---|---|---|
| A0 | App.tsx, Editor registration, UI adapters, package/lock/config, aggregate evidence | Real app and navigation |
| A1 | persistence, shared save types, main/preload, pending/coordinators, their unit tests | Receipt and session contract |
| A2 | database/RecordPage.tsx, dedicated record CSS/tests | Controlled record surface and body slot |
| A5 | renderer/styles.css, theme tokens | Shared appearance |
| A3 | PropertyField and controlled database cells | Parent-owned drafts and commands |
| A4 | Editor commands and relevant tests | Existing Editor and save adapter |
| A7 | E2E, fixtures, scenario/evidence ledger | No production edits |

Four concurrent agents maximum. Install/build/large unit/Electron runs are scheduled by A0; Electron uses one worker and retries=0. No shared writable node_modules between worktrees. All app runs use synthetic FOLIO_DATA_DIR, which also selects the Electron userData directory before startup.

Save port: immutable operation with operationId/sessionId/seq/pageId/owner/revision/patch/values; applied/rejected/unknown responses. Missing receipt remains unknown. Existing Page PendingEdits and recovery remain, with explicit operation tracking. Record edits share one App-lifetime coordinator.

Record UI: existing RecordPage, mode side/full, parent close/mode callbacks, existing Editor slot. Mode changes preserve the subtree. The integration owns origin focus/scroll and draft lifetimes.

Push, public PR, master merge, user workspace migration and changes to original checkouts are outside this run. H0 full unit/E2E remains NOT_RUN; new runs are recorded separately.

R4 execution: A0/A1/A2/A5 started in four available slots. After the shared appearance work, the appearance slot completed A3 then A4; the record UI slot completed A7. A6 remains next-wave work. Roles and simultaneous agent count are separate. Each completed role has its own A1/A2/A3/A4/A5/A7 report.
