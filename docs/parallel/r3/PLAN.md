# Round 3 plan

1. Fix contract from current source; create isolated lane and integration worktrees with unique port/cache/data and local setup commits. Record readiness individually.
2. Core: define tested canonical membership and page/values storage, pre-migration SQLite plus assets snapshot and atomic migration, then safe commands, history, trash/duplicate, recovery and App integration. Preserve legacy and unknown bytes; never ship the old whole-row write route against migrated data.
3. Editor: document-scoped block selection, clipboard and undo; DB UI: four views and record display using fixture callbacks; Fidelity: modal/focus and responsive UI. Each lane owns only contract files and reports evidence and requests shared changes.
4. Integrate only after reviewing each SHA. Run focused joint scenarios then full check/test/build/E2E under shared lock, retries=0, fixed source/build. Verify package startup with isolated fixtures, recovery/backup and old-version boundary. Record all attempts, unrun comparisons and limitations. No push/PR/master merge without explicit Round 3 authorization.
