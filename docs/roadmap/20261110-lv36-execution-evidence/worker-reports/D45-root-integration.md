# D45 root integration report

## Owned outputs
- `src/collaboration/runtime/authority.ts`
- `src/collaboration/runtime/retention.ts`
- `src/collaboration/runtime/backup.ts`
- `src/collaboration/runtime/http-provider.ts`
- `tests/shared-runtime-root-integration.test.ts`
- `src/collaboration/runtime/state-root.ts` (scope extension from parent follow-up)
- `REPORT.md`

## Implemented API / behaviour

### state-root.ts (scope-extension edit)
- `AUTHORITATIVE_NAMESPACES` now additionally includes `authority.attempts`, `authority.intents`, `authority.undo`, `operations.fences`, `operations.upgrades`.
- Deliberately excluded: `authority.events`, `authority.prefix`, `authority.checkpoint`, `authority.archive.events`, `history`, `client.queue`, `meta.head`, `meta.state-root`, and other non-authoritative side tables. `meta.role`, `meta.primary-org`, `meta.restore`, `meta.restore-authorization` remain included.
- Nested `{epoch,seq,hash}` objects are normalised to `hash:""` so provisional cuts do not create a hash cycle.

### authority.ts
- Constructor sets `meta.role` first, then calls `createRuntimeGenesis(...)` only for a genuinely fresh store, all inside one transaction with `verify()`; failures roll back atomically and reject with `UNROOTED_AUTHORITY` instead of migrating.
- `readAuthorityGenesis` validates `meta.genesis` shape/format/source hash and the genesis prefix proof.
- `verify()` validates genesis ↔ head epoch, checkpoint-aware event chain, every event `authorityStateHash`, `meta.state-root`, and the CURRENT persisted authoritative state via `assertRuntimeStateRoot` (docs, records/values, roles, identity, assets, attempts/intents/undo).
- `runtimeEventHash` now binds `receipt.intentHash` and `receipt.attemptHash` in addition to status/code/resultHash and `authorityStateHash`.
- `commit()` ordering: provisional lifecycle cut → provisional attempt/intent records → provisional undo witness cut → `authorityStateRoot` → event hash → final receipt/attempt/intent/witness/lifecycle cuts → `meta.state-root`. Because cuts are normalised, the root is unchanged between provisional and final writes.
- `restoreInto` passes an authorization callback into `restoreBackup`, so the new genesis is created after fencing and after the new operator is authorised.

### retention.ts
- Checkpoint body stores `authorityStateHash` (latest pruned root); parser accepts it (legacy `null` compatible).
- Event hash recomputation includes `authorityStateHash`; for rooted events it also requires `receipt.intentHash`/`attemptHash`. Pre-rooting events without `authorityStateHash` are validated with the legacy formula for compatibility with existing retention fixtures.
- Compaction archives pruned events into `authority.archive.events` (`<epoch>:<seqKey>`) before deleting active seq keys; quota failures roll back with the store’s existing limit error.
- Suffix/current-head proof verification is preserved.

### backup.ts
- `exportBackup` validates rooted evidence when `meta.genesis` exists (genesis/prefix, event chain, root binding, blobs) so `backup.hash` binds the rooted head.
- `restoreBackup` writes raw source records, validates rooted evidence BEFORE any authorization, then fences sessions/devices, expires pending invites, removes old recovery material, archives old-epoch active events into `authority.archive.events`, writes `meta.restore` + `meta.restore-authorization`, and creates the new genesis with `sourceHash = backup.hash`.
- Generic restore (retention `verifyBackup`) uses the same path without an authorization callback.
- `decodeBase64` replaced the nested-repetition regex with a linear anchored character class plus padding count and exact re-encoding, preserving strict acceptance while avoiding V8 `RangeError` on multi-MiB base64.

### http-provider.ts
- Event validation recomputes the event hash including optional `authorityStateHash` and now `receipt.intentHash`/`receipt.attemptHash`.

## Integration points
- Authority commit ↔ state-root normalisation for provisional cuts (doclifecycles, attempts, intents, undo witness).
- Retention checkpoint ↔ authority `verify()` base selection.
- Backup export/restore ↔ rooted genesis, restore metadata, and archive namespace.
- HTTP event validation ↔ authority event hash formula.

## Tests added (`tests/shared-runtime-root-integration.test.ts`)
- Legit bootstrap and restart.
- Accepted and rejected events binding `authorityStateHash` to `meta.state-root`.
- Retention checkpoint root + surviving suffix + reopen.
- Full rooted restore/new key/archive continuity.
- Negative: tampered documents, record values, workspace roles, identity, changed root meta only, unrooted legacy store.
- Negative: tampered attempt receipt record, tampered intent dedup record, tampered undo witness with intact head; positive committed-witness restart and backup/restore with undo evidence.
- Negative: exported backup payload changed with recomputed outer hash fails rooted restore before authorization callback.
- Positive: 9 MiB asset backup validates without base64 recursion failure.
- Manual genesis conflict.

## Unverified / known limitations
- Parent runs `npm run check`, tests and build; this worker did not execute them (no shell per task).
- Legacy compatibility: `SharedAuthority` rejects unrooted stores, but `exportBackup`/`restoreBackup` keep a legacy path so existing fake-store retention tests still operate; rooted backups are strictly validated.
- Root includes `operations.fences` and `operations.upgrades`; `operations.backups` and `backup.verifications` remain excluded as non-authoritative operation journals (no authoritative cut side effects observed in the read APIs).
- GUI/browser/Electron/clipboard/native workflows were NOT_RUN.
