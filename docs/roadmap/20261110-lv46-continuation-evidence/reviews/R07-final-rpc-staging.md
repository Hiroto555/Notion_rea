# R07 independent final RPC / staging review

Status: READONLY source review, final parent fixes re-read. No source edits, no tests/check/build, no GUI/network. This report is the only review artifact written. Parent owns execution evidence.

## Result

No unresolved confirmed P1/P2 finding in the requested latest slice after the parent fixes observed during this review. This is source-level review, not runtime acceptance or Level certification.

## Findings raised and rechecked

1. **Resolved — accepted Undo/Redo losing LocalHistory.pending.** `client.ts` now defers history clearing via `historyResetPending` until after definitive `finishHistory`. The error catch no longer calls `history.reject()` while `pendingHistory` exists. Accepted receipt + post-write read failure stays reconcilable.
2. **Resolved — accepted own history overwritten by the next write.** `canWrite` and `submit` fence on `pendingHistory`; a second immutable attempt is not created while exact own accepted history is unresolved.
3. **Resolved during R07 — Undo poisoning unresolved normal-save history.** Counterexample: save A succeeds; B receives accepted receipt then refresh fails; calling Undo previously created LocalHistory.pending(A) before submit refused pendingHistory(B), so reconcile(B).record failed HISTORY_PENDING. Latest `historyStep` checks `!pendingHistory` before `open` or LocalHistory mutation (`client.ts:248`).
4. **Resolved — fetched event not bound to accepted receipt cut.** `http-provider.ts:179-181` now checks cut epoch/seq/hash plus event/receipt scope, writer and intent/attempt IDs before recomputing the event hash. `authority.ts:711-712` recomputes event hash, checks receipt-cut coherence and requires its known prefix/current epoch through assertBase. A body with a recomputed hash but unchanged old receipt cannot pass.
5. **Corrected test oracle.** The 900k test initially combined a text replacement and full-paragraph bold into one logical inline operation while asserting a sub-1k single patch/mark representation. Latest test uses four small tail-character edits followed by a separate full bold operation. This matches the supported compact representation and still tests actual large-page edits + mark action + fresh open. No test result is asserted here.

## Requested gate checks

- `state` returns authorized current active document and head with no historical events, in one store transaction. Incremental snapshot still validates prior epoch/monotonic cut and the exact previous prefix. Fallback is a read-only path limited to RESPONSE_TOO_LARGE; Http state compatibility fallback only accepts definitive STATE_UNSUPPORTED/NOT_FOUND. No auth/network fallback licensing writes was found.
- Peer snapshots omit rejected commands and all copy.stage.* private staging commands. `acceptedEvent` is current authenticated originating-writer + exact scope + accepted only. Current document becomes visible after final publication. No direct unpublished-source leak found in this slice.
- UNKNOWN is marked before send; reconcile queries receipts without resend. A failed post-receipt read keeps the exact pending history and durable attempt. New writes are fenced until resolution.
- Staging prepare reserves all declared part bytes globally before accepting raw parts and limits active uncommitted manifests to eight / total reserved source bytes to 32MiB. Every part must match the immutable declared index/hash/size; duplicates do not extend the reservation. This bounds this source-staging path, not all database/asset/audit growth.
- Explicit abandon requires original writer-derived base key, full stored actor/scope match and exact manifest hash; refuses committed copies; deletes only that copy's part prefix and keeps immutable manifest + abandoned tombstone. Prepare, stagePart, inspect and commit cannot reactivate that ID because the latter paths use readManifest's abandoned gate. Repeating abandon is safe. A delayed final commit either wins first (abandon rejects) or follows the tombstone (commit rejects), under serialized authority transactions; final publication logic is unchanged.
- Record metadata resolution now processes all selected database entries before selected records independent of selection order. Actual commit separately orders database writes before record writes and remaps database/property IDs. Unselected database requirement remains.

## Limits / non-claims

- Event-cache/history truncation on a real response/mapping capacity boundary intentionally loses older Undo availability; it does not mutate persisted attempts or stored content. Do not label unlimited history.
- Manifest reservations do not promise a 32MiB copy will fit the overall 64MiB physical Store after immutable event/attempt/audit overhead. Abandon removes staged source parts, not all retained audit data or binary uploads.
- Endpoint abandon exists at the authority resource route. This review does not claim a dedicated GUI cancellation flow.
- GUI, actual Windows/DPAPI/Keychain, physical-device acceptance: NOT_RUN.

Reviewed at 2026-11-10T14:11:56.625902+00:00 UTC.
