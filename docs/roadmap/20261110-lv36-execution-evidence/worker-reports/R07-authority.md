# R07 authority review report

Status: implementation and tests written. **NOT_RUN**: this worker had no shell/test/build execution. All pass/fail statements below are untested until the parent runs `npm test` / `npm run check`.

## Owned files

- `tests/shared-runtime-authority-adversarial.test.ts`
- `REPORT.md`

No input, helper, contract, runtime source, config, or data file was edited.

## Actual reviewed API

- `SharedAuthority`: bootstrap, head, proof, verify, snapshot, receipt, submit, invalidate, createDocument, grant, createWorkspace, invite, acceptInvite, revokeMember, handoff, workspaces, records, projection, backup, restoreInto, close.
- `RuntimeStore`: shared SQLite format (`shared-runtime.sqlite`, application id `0x464c5352`, user_version `1003`), transactions, records/blobs, format validation.
- `IdentityAuthority`: bootstrap/invite/accept/authenticate/recover/revokeDevice; session+device generation binding.
- `WorkspacePolicy` / `OrganizationService`: org membership, workspace roles, last-owner guards, revocation.
- `DocumentLifecycle`: trash/restore/history/restore seeds.
- `SharedAssets`: staging/publish/read/hold/collect (no caller auth parameter).
- `SharedProjection`: search/backlinks/exportDocument/rebuild.
- `backup.ts`: export/restore/hash validation/session invalidation.
- `provider-port.ts`: interfaces only; no concrete `SharedProvider` implementation exists to exercise.

## Tests written (real temp SQLite, no fake port)

- Legal: bootstrap, snapshot, text submit, receipt, proof, reopen persistence.
- Isolation: foreign org, workspace without role, writer/device mismatch, second device of same user, cross-user receipt.
- Epoch/prefix: foreign epoch, forged hash, future seq, caller input unchanged on refusal.
- Replay: attemptId payload replacement, intentId dedup without re-apply, intentId command replacement.
- ACK loss: `afterCommit` throw then receipt dedup/reopen/re-submit; `beforeCommit` throw then full rollback; `invalidate` exactly once.
- Current revocation: member revocation blocks submit/receipt/proof/snapshot/workspaces/projection; device revocation invalidates token; asset boundary gap.
- Lifecycle: trash, write rejection, restore into new incarnation, old-scope rejection, history, reopen between trash/restore, restore-never-deleted refusal, resource-command lifecycle bypass, incarnation takeover.
- Backup: non-admin refusal, tamper/hash refusal, stale epoch, non-empty destination, session invalidation, restored-authority reopen.
- Projection: authority document visibility/export.
- Physical format: private-format DB rejected by shared store; wrong shared version rejected; wrong shared schema rejected; shared DB rejected by private application-id guard.

The shared-authority constructor path was read, not executed. No missing import or obviously unresolved dependency was found; the first legal test exercises construction, bootstrap, verify, reopen. If the parent sees a constructor failure, the exact thrown code should be captured from that test and from `SharedAuthority` construction.

Tests whose names start with `CONFIRMED DEFECT` / `CONFIRMED GAP` assert the current defective behavior so they reproduce the finding against unfixed source. Once a defect is fixed, the corresponding test must be changed to assert the correct behavior.

## Confirmed defects (source + line, reproduced by tests)

1. **Asset operations have no authentication or authorization boundary.**
   `src/collaboration/runtime/authority.ts:34` exposes `readonly assets`; `:40` constructs `SharedAssets` with only the store. `src/collaboration/runtime/assets.ts:269,331,400,415,445` accept only `Scope`/data, never `AuthContext` or token. Any holder of an org/workspace scope can stage, publish, read, hold, release, or collect after member/device revocation, while `authenticate` at `authority.ts:49` is private. Covered by "CONFIRMED GAP: asset read and write have no caller authentication or revocation boundary".

2. **Resource commands bypass the active-lifecycle check.**
   `src/collaboration/runtime/authority.ts:100-104`: the `resource` branch calls `this.resource(...)` directly, while only the `else` branch calls `this.lifecycle.assertActive(...)` at `:103`. Records actions (`db.create`, `record.*`, `page.move`, from `records.ts:646-668`) therefore succeed on trashed or inactive incarnations. `records()` at `authority.ts:133` also does not check lifecycle. Covered by "CONFIRMED DEFECT: resource commands bypass the active-lifecycle check".

3. **`document.create` can replace the active incarnation of an existing document.**
   `src/collaboration/runtime/authority.ts:125-127`: the guard is only `!store.get("documents", key)` for the exact new scope, then `doclifecycles` is overwritten with the new `activeIncarnation`. Public `createDocument` at `:84` lets any editor pass a new incarnation for the same `documentId`, making the previous incarnation `SCOPE_NOT_ACTIVE`. Covered by "CONFIRMED DEFECT: document.create replaces the active incarnation without a lifecycle guard".

4. **`SharedProjection` reads a different namespace/key shape than the authority writes.**
   `authority.ts:134` creates projection over the same store. `projection.ts:21` uses namespace `records`; `projection.ts:355` reads `store.get("records", scopeKey(target))` and `projection.ts:80` requires four-part `org:workspace:document:incarnation` keys. The authority stores `DocumentState` under namespace `documents` (`authority.ts:97,105,126`), while records rows use three-part keys (`records.ts:75-77`). Result: `search` sees no shared documents and `exportDocument` throws `DOCUMENT_MISSING` for a document that `snapshot` returns. Covered by "CONFIRMED DEFECT: projection cannot read documents stored by the authority".

5. **Backup restore never writes the new-epoch genesis prefix, so the restored authority cannot reopen.**
   `backup.ts:324-334` creates `newCut = {epoch, seq:0}`; `backup.ts:364-367` writes records and `meta.head` but never writes `authority.prefix` for `epoch + ":0"`. Old-epoch prefix rows are copied while old-epoch events are ignored by `authority.ts:57`. `SharedAuthority.verify` at `authority.ts:59` demands `prefix(0, head.epoch)`, so construction after restore throws `CORRUPT_GENESIS`. Covered by "CONFIRMED DEFECT: a restored authority cannot reopen because the new-epoch genesis prefix is missing". Session revocation during restore itself works (`identity.sessions` becomes `revoked`).

## Integration points required

- Wrap or remove `SharedAuthority.assets`; asset calls need token + current policy/lifecycle authorization, not a bare `Scope`.
- Enforce active lifecycle for record/resource commands, or explicitly define a deleted-document record policy and test it.
- Guard `document.create` against an existing lifecycle/documentId; new incarnations should go through `lifecycle.restore` or an explicit admin rotation.
- Make projection consume the authority's `documents` store/`DocumentState` shape, or provide a projection adapter; align `records` namespace/key semantics.
- On restore, write `authority.prefix` for the new epoch at seq 0 (and any other genesis metadata required by `verify`) before setting `meta.head`.
- Provider: implement a concrete authenticated `SharedProvider`; only `SharedAuthorityEndpoint`-shaped methods exist today.

## Unverified / known limitations

- No test was executed. GUI/E2E was not attempted.
- Provider implementation absent; only authority endpoint methods were exercised for revocation.
- Operations/upgrade/fence paths (`operations.ts`) were not exercised; they are separate from authority submit/receipt.
- `invalidate` authorizes `"read"` (`authority.ts:114`), not `"write"`: a user downgraded to viewer can still close their own old attempt. Recorded as a concern, not asserted as a defect.
- `SharedAssets.collect` reads `meta`/`head` keys equal to `org:workspace` (`assets.ts:459-460`), while authority head is `meta/head`; no production caller was found, so integration correctness is untested.
- Backup restore does not prove the copied event chain against the restored head; only the tested genesis failure is asserted.
- Cross-device receipt read for the same `userId` succeeds (`authority.ts:88` checks `userId`, not writer). Treated as observed behavior, not asserted as a defect.
- Restored-authority functional behavior beyond construction cannot be tested until defect 5 is fixed.
