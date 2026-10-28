# Round 3 Editor — implementation and verification

- Branch `r3/editor`; fetched start master `bd0f1e753258b8f29c3a436753f3bad9a1f84b16`, shared contract `c6ced9c906dbce1a0df1375b63d4d627f4fdb021`, setup `e7aaab05ce18c00abbef7ad347b28f41552c49c6`, implementation `dca33afd13200112ec1648161bd69a71c5ac0830`.
- All edits are in `src/editor/**`, new Editor-only tests and this report. Core-owned shared types, App, persistence, DB UI and Fidelity files were not changed. No other branch was integrated and no push/master merge occurred.

## Implemented

Top-level block selection and drag sources use document-scoped IDs and resolve current contiguous positions before acting; missing/discontiguous IDs reject, and drop targets are resolved from current IDs. Shift-selection of nested sibling blocks supports contiguous movement/duplication/deletion with schema validation; ancestors and descendants cannot be selected together in this UI. Selected top-level blocks and sibling list items can be copied/cut as a validated internal payload with HTML/plain-text fallbacks. Cut only removes content after preparing a valid document and successfully writing all clipboard formats. Same-document, same-editor cut token is retained for five minutes, is consumed after successful insertion, and preserves IDs only if none currently exist. Copy, second paste, expired token, undo of cut and untrusted payloads get fresh subtree IDs. Copy/cut within the editor and window blur invalidate the prior token. Cross-page cut paste is refused: clipboard contents remain available, and cross-document atomic movement remains unimplemented. Cross-page copying generates new IDs. Insertion validates the resulting schema, document and size and checks every inserted root for content loss before dispatch. Document identity comes from the shared `documentId` prop; no separate save queue was added.

## Results

Dedicated data/cache/tmp and shared repository test lock used; launcher commands used `env -u ELECTRON_RUN_AS_NODE`. No real user workspace or clipboard was used. Complete local logs remain in ignored `output/agent-workspace/logs/`.

| Attempt | Result |
| --- | --- |
| check `73ea7d5f`, `5f2d40f5`, `e6ffb4b0` | exit 0 |
| test `0bd568c7` | exit 0, 4/4 targeted clipboard tests |
| build `99236b4d` | exit 0; Vite chunk warnings |
| E2E `259c6d9e` | exit 0, 2/2 synthetic clipboard tests, retries=0, earlier source |
| check `487b0249` | exit 2: two newly referenced helpers were omitted from the import; fixed |
| check `c75fd000`, `dc806418`, `de250068`, `dffb9530` | exit 0 after applicable fixes |
| test `4e89bf0e` | exit 0, 11/11 targeted selection/identity tests |
| build `b92aee40`, `ac95588a`, `cdca4421` | exit 0; Vite chunk warnings |
| test `2ecce80f`, `e149c95d` | exit 0, 7/7 targeted at their respective source states |
| E2E `7283b23f` | exit 1 (SIGTERM): while waiting for the live Fidelity test lock, this process was intentionally interrupted to apply an additional cross-page cut guard; the lock was acquired just before the signal and the test started. This was not a product assertion result. |
| E2E `ab7c75e9` | exit 0, 9/9, retries=0: new synthetic clipboard tests (3), existing editor identity (4), existing drag matrix (2). The source was unchanged when implementation commit was made. |
| full test `9f2644d7` | exit 0, 96/96 against implementation commit |
| test `d9bd5d32` | exit 0, 7/7 targeted clipboard tests including a synthetic image reference, internal page link and bold mark |

Source Git tree at tested implementation: `6a9a6e070024f716a59fc4df5a90a62e0e49e1e4`. Source SHA-256: Editor.tsx `5207eb4771d6922457e5943d7a349fc5ec1a29efe91e5943e96f6d30f4c130e0`, blocks.ts `992e9a4107c3a8be5750a2955b0c7b291d4d9d4684e2185e470438230246b29c`, block-clipboard.ts `77002b2e5fe6a0d5debb674ecbddc1534b17f6801eccabd92a1ad1d9e09ea686`. Tested build SHA-256: main `66c28834f663b6537f80b9d3613790ec723761e2b0e24de0ad39d705ab8274a5`, renderer JS `9def227ec7fc226e3a454d9e36444d4f6340753d59863f4f4f696823bc78d2d1`, CSS `dc131258cddf2c4edb30ac3acd4a84fb8cb8a677c34302cd32277c72b579a5d6`.

## Unfinished and limits

- Native OS clipboard copy/cut/paste and OS clipboard preservation were not exercised; Electron tests use synthetic ClipboardEvent/DataTransfer. The ability to observe every possible clipboard overwrite by another process is not established; token invalidation is conservative on editor clipboard actions and window blur.
- Nested clipboard supports list-item siblings inside bullet/ordered/task lists. Other nested structures are explicitly refused for clipboard operations. Last remaining list children cannot all be cut/deleted. Cross-document cut is deliberately refused pending an atomic two-document contract. Parent/descendant simultaneous selection is prevented rather than converted to an ancestor selection.
- Individual insertion failure paths, image/link clipboard handling through actual Electron and attachment bytes, nested-selection Undo/Redo end-to-end, physical Japanese IME, 1,000-block performance under the new operations and DB record integration remain NOT_RUN. Full end-to-end suite was not rerun; the 9 targeted existing/new cases above were run.
- Fidelity and Notion comparison are not claimed. No record page exists in this standalone branch: integration must test the same Editor through Core's Page and PendingEdits paths.

## Follow-up review fixes (verification pending)

Follow-up implementation `0bbbb062df78da78c754956bbab8fa4dea1eb50d` and test correction `bccf50d1900079408890da54e7f525210795ef6b` address static review: reject grouped nested drag without moving a partial selection, resolve Shift selection endpoints by current ID, preserve nested block and hard-break plain-text boundaries through `textOf`, require matching custom/HTML/plain clipboard write readback before deletion, and reject direct block/clipboard/toolbar mutations when the editor reports read-only or content-error state. An original cut token is consumed on the first successful paste of that payload even when ID collisions required fresh IDs, so later deletion cannot reactivate it.

The cut token now expires upon observing a **different** clipboard payload: clipboard replacement is evidence that the old cut token is no longer eligible. The malformed-other-payload test was separated from the token-retry case accordingly; the new retry test uses the **same** payload with a deliberately failing insertion transaction, then checks that the valid retry still preserves IDs. Separate tests assert both replacement invalidation and cut → Undo → fresh paste → remove original → second paste. Additional synthetic Electron cases cover grouped drag rejection, text/plain line breaks, silently dropped HTML/plain formats and read-only behavior. These new tests and the content-error-specific pathway have not yet run; Core will verify after its running E2E has released the shared lock. The synthetic insertion fault does not by itself establish every ProseMirror insertion failure mode. Real OS clipboard semantics remain NOT_RUN.
