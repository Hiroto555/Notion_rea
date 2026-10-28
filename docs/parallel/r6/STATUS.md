# R6 implementation and verification

> Publication note: this is the local R6 freeze record. The user subsequently authorized publication on `codex/folio-r6-20261028`; statements below about no push/public PR describe the earlier freeze. See [the publication checkpoint](../../R6-CHECKPOINT.md). Master merging is a separate step.

Checkpoint: R6_READY_FOR_REVIEW

R5 base: ac1d2ad6d2ae6e199c7d1344360a9670703ea164. Only R6 dedicated worktrees changed. Original Notion_rea/master, H0, R4, R5 and the running R5 synthetic demo are preserved. No push, public PR, master merge, installed app changes or real user data conversion.

Implemented:
- Explicit selected legacy database conversion, preview, checked SQLite+assets copy, preserved original raw JSON/history, atomic mappings/receipt, editable migrated record Pages.
- Text/number/checkbox/date/select column creation; stable-ID rename; lossless type conversion preview. Incompatible values/dependent filters reject without partial mutation. Type changes verify a SQLite backup and increment affected record revisions.
- Durable input journal before application mutation, atomic file replacement/readback/fsync, workspace identity/checksum/generation. Save receipts distinguish acknowledged input from later input after SIGKILL.
- Startup recovery requires explicit action. Receipt lookup is query-only: unknown outcomes retain the journal for another lookup or a recovery copy. Newer source/provenance-unknown input never silently overwrites the original.
- Recovery copy retains body plus typed payload and stable copy identity; a lost copy ACK cannot duplicate the Page. Corrupt/foreign journals stay intact and block editing.
- Incomplete numeric record/filter input is retained with its verified source. Failed checkpoint writes retain their exact CAS request for explicit retry.

Boundaries:
- Durability applies after the UI says recovery checkpoint saved. Keystrokes not yet acknowledged by the checkpoint are not guaranteed after process death.
- Actual tests use owned Electron child SIGKILL and synthetic workspaces. This is not a device power-loss or arbitrary external-writer guarantee.
- Unknown original mutation receipts are not automatically replayed. The explicit recovery copy preserves input when the original outcome cannot be established.
- Automatic startup migration, real user data migration, complete workspace/assets/history disaster recovery, physical IME/native clipboard and live Notion comparisons remain outside this checkpoint.
- New legacy migration archives history; it does not claim a complete user-facing migrated record history restoration workflow.

## Fixed validation

- Integration product commit: `75f1bd86f22c01c612b3213b6385a54b36ff92f1`.
- Clean validation commit: `688b85a92323537cbfaffaa765c93d00f2b3ed02`; tree `d0cec7a39ddf84001745ddf1c64bea9d5ed8781a`.
- Application source and tests are unchanged from this fixed verification. The demo helper was corrected afterward to account for an automatically reopened record and to clean up owned child handles after normal close; only that helper differs from the fixed commit.
- Current validation checkout: `f0dcf237b6ccf0a338004b4a3c4622721fed819b`, clean. Current integration and validation `src`, `tests`, `scripts` match. The modified demo helper was separately executed to completion; the full application suite was not repeated for helper-only changes.
- Build/typecheck: PASS.
- Unit: **572/572 PASS**, 58 files, failed0/skipped0.
- E2E: **156/156 PASS**, Electron128 + Chromium component28, failed0/skipped0, workers1/retries0.
- Fixed run: 2026-10-28 07:05:09–07:14:19 UTC. Node24.20.0, macOS arm64. The E2E phase took 8.5 minutes.
- Manifest: `<workspace-root>/Folio-r6-20261028/validation/output/r6-final-verification/manifest.json`.
- Summary with full log hash: same directory `summary.json`.
- Full output: `<workspace-root>/Folio-r6-20261028/verification-run-2.log`.
- Browser report: `validation/output/playwright/report/index.html`.

The first fixed run found a stale crash journal after the old manual export/reload path. The verified export now retires the crash checkpoint, and its existing regression test passes. The final result above comes exclusively from the subsequent complete fixed run. Failed diagnostic/fixed runs remain under integration/output/r6-runs and validation/output/r6-failed-fixed-62fa219; they were not combined into a PASS.

## Scope of completion

R6's three implementation targets are complete in the isolated candidate: selected legacy migration, column add/type change, and process-crash input recovery. This does not mean every ChatGPT Web proposal or the whole Folio product is complete. The boundaries above remain explicit. Unsubmitted new-database/column-form drafts are not included in the recovery guarantee; prepared mutation identities and active Page/record/database-session input are captured.


## Demo proof

The final exercise exited0. It used only `<workspace-root>/Folio-r6-20261028/validation/output/r6-demo/data`, performed explicit legacy migration, text-to-number conversion, added a date column, saved a date, captured raw `-`, killed its owned Electron child with SIGKILL, restored that input, completed it, saved a body and verified the body after another restart. The final DB has two records and the numeric value8.

- `validation/output/r6-demo/manifest.json` and `exercise.log`.
- Screenshots: `01-migration-preview.png`, `02-type-preview.png`, `03-crash-recovery.png`, `04-restarted-record.png`, `05-final-database.png`.
- Final database screenshot visually inspected: converted values/date and saved states are visible, no clipped controls.
- Earlier demo attempts are preserved in `output/r6-demo-failed-reopen` and `output/r6-demo-complete-cleanup-failed`. These were demo-helper errors; application source/tests did not change after the accepted fixed run.

The demo can be reopened with `node scripts/r6-demo.mjs` from validation. See TRY-IT.md. Use HANDOFF.md as the concise next-round/ChatGPT Web handoff.
