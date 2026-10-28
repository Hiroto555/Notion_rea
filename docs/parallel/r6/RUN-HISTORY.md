# R6 verification history

All runs were local and serial, E2E workers=1/retries=0, synthetic FOLIO_DATA_DIR only.

| Run | Result | Action |
|---|---|---|
| Initial focused unit (06:36 UTC) | 66/70 passed; 4 failed | Fixed record membership vs Page hierarchy and shared JSON aliases |
| Focused unit (06:42 UTC) | 70/70 passed | Migration/property/recovery core and prior migration checks |
| First actual App check (06:45 UTC) | Interrupted after initial failures | Initial recovery status incorrectly appeared pending; corrected initialization |
| Reload check (06:46 UTC) | Interrupted after reproduced failures | Measured same-renderer reload blocked by main will-navigate; permitted only exact trusted renderer URL |
| R6 combined (06:52 UTC) | 16/17 passed | Migration4 and SIGKILL recovery8 passed; all but five-type column scenario passed |
| Column follow-up (06:54 UTC) | 4/5 passed | Dialog margin cascade left control outside viewport; increased selector specificity and bounded scroll height |


| Final targeted schema/retry (06:56 UTC) | 7/7 passed | Five-type viewport and durable retry/re-preview verified |
| First fixed 62fa219 | Build PASS, unit572 PASS; E2E interrupted after one failure | Manual export/reload left a stale crash checkpoint; preserved run, fixed cleanup |
| Existing failing scenario after fix (07:04 UTC) | 1/1 passed | Old manual export/recovery/restart preserves document IDs and content |
| Final fixed 688b85a (07:05–07:14 UTC) | Build PASS; unit572/572; E2E156/156; fail0/skip0 | Clean commit, all gates executed serially; accepted |

The final validation result is from one complete run. It is not a sum of partial passes. E2E156 consists of actual Electron128 and browser component28, and includes R6's 19 added scenarios (migration4 + schema5 + crash recovery8 + structural retry2).

Final demo: initial helper attempted to open a record already reopened in full mode; the next helper completed assertions but failed cleanup by calling Playwright process() after close. Both attempts are preserved. Only the helper was corrected; the third fresh exercise exited0 with all assertions and cleanup completed. No application/test code changed after fixed688b85a.
