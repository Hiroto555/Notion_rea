# Explicit reclaim of fenced-writer source staging

Implemented in new `staging-maintenance.ts`, with minimal SharedAuthority control methods, strict admin actions, and existing maintain CLI routing.

- Current authenticated organization owner + workspace manage authorization is required for preview and abandon. A workspace-only owner/member is denied.
- Preview is read-only metadata: anchor scope, exact head cut, and staged scope/writer/copy/hash/bytes/part count/fenced status. It includes no source body, asset bytes, title or selected source IDs, and does not require the anchor document to remain active.
- Reclaim binds exact head, full scope, writerId, copyId and manifestHash. The original actor is recovered only from the immutable checked manifest. Every matching identity device and session must be revoked in the same org, and at least one matching original device AND session must exist. Missing identity is not a fence.
- Reclaim calls the existing actor-bound SharedCopyStaging.abandon only after that proof. Cleanup and current-caller control audit commit in one SQLite transaction. Committed copies cannot be abandoned. Stale proposals cannot mutate or create an audit event.
- Explicit repeat abandon requires the current exact cut, obtained by a fresh preview after the first command. No automatic cleanup/retry; old intents, attempts, receipts, event raw and manifest remain immutable. Only staged source part rows are removed, with an abandoned marker retained so IDs cannot be reused.
- The global 8-active/32MiB source reservation budget is released for the explicitly abandoned old copy; staged binary asset collection and historical raw retention are separate and are not claimed to be purged.

Admin actions:
- `{action:"stagingPreview",scope}`
- `{action:"stagingAbandon",scope,writerId,copyId,manifestHash,expectedCut}`

CLI through existing `maintain` route:
- Common `--root --org --token-file --action`
- `--action staging-preview --workspace --document --incarnation`
- `--action staging-abandon --workspace --document --incarnation --writer --copy-id --manifest-hash --expected-cut`
- The expected cut is canonical JSON from the preview. Root source preflight/private token rules are inherited from the existing operator.

Focused verification: `vitest run tests/shared-staging-maintenance.test.ts` **6/6 PASS**, 2.88s. Actual owned loopback HTTP, SQLite and maintain CLI invocations (no fake storage).

Positive/negative evidence:
1. Eight old reservations reject new-owner admission after real recovery; current owner explicitly reclaims one fenced copy and new preparation succeeds. Old writer event raw, intent and attempt/receipt rows compare canonically unchanged. Old-token late commit is rejected.
2. Active-writer cleanup refuses; stale exact-cut proposal refuses without part/audit mutation.
3. Ordinary organization member with workspace owner role cannot preview or abandon.
4. Inactive document anchor works; old-cut repeated cleanup refuses, fresh-preview cut permits explicit idempotent result.
5. Committed copy and mismatched manifest refuse; published copied page remains.
6. Actual maintenance CLI preview/abandon uses metadata-only results and keeps its token file unchanged.

Parent owns final typecheck/fullsuite/build. No GUI/native Windows/DPAPI/E2E, real data, push, workflow, merge or billing action was performed.
