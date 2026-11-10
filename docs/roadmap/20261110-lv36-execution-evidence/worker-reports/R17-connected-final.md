# R17 connected-final report

## Owned files
- `tests/shared-runtime-connected-final.test.ts` (new, only file changed)
- `REPORT.md` (this file)

No existing source, contracts, helpers or configs were edited.

## Actual APIs exercised
- `SharedAuthority` + `createSharedHttpServer` + `HttpSharedProvider` over a real
  loopback HTTP server and temporary SQLite stores.
- `SharedRuntimeService.handle` (`connect`, `open`, `copyPreview`, `copyCommit`,
  `assetStage`, `resource`, `assetRead`).
- `readPrivateCopySources` against a real private `Store` and private asset
  directory (0600 files).
- `SharedAuthority.submit`/`snapshot`/`head`; copy command effects in
  `documents`, `doclifecycles`, `history`, `asset`, `runtime_blobs`.
- `SharedAuthority.invite`/`acceptInvite`/`handoff`/`backup`/`restoreInto`/
  `recover`/`verify`.
- `authorityStateRoot` normalization semantics via reopen of tampered attempts.

## Test coverage (temporary data only)
1. Main `copyPreview` loads actual private Store pages/assets through
   `readPrivateCopySources`; `copyCommit` runs through the service's real
   `SharedResourceClient`/HTTP authority. Asserts accepted receipt, head equals
   receipt cut, new documents/lifecycles/history/assets, remapped block IDs and
   page link, hashed asset URLs, and the unselected private page text absent
   from the received `copy.commit` attempt command. Selected/unselected page
   rows and private asset files are byte-compared before/after.
2. Source mutation after `copyPreview` makes `copyCommit` fail with
   `COPY_SOURCE_CHANGED`; head and received submit count do not move.
3. `assetStage` (small bytes) -> `resource`/`asset.publish` -> `assetRead`
   through the main service. Stage does not advance head; publish produces the
   next cut; read returns the exact SHA-256 and bytes.
4. Immutable `attempt.base.hash` and `attempt.intent.base.hash` are rewritten
   together with their declared attempt/intent hashes, keeping head and event
   chain intact. Reopen must fail (`STATE_ROOT_MISMATCH`) because state-root
   normalization only relaxes the current commit cut.
5. Current stored `receipt.cut.hash` is changed without touching the head. Even
   though normalization blanks the current cut hash, reopen must fail
   (`CORRUPT_CUT_POINTER`) via pointer validation.
6. Backup is taken, then a new user is invited/accepted and becomes the current
   organization owner via handoff. Restoring the old backup with the new owner
   creates the new operator's identity record and a fresh recovery key. Reopen
   verifies genesis/root pointers; the old recovery key fails with
   `RECOVERY_INVALID`; the returned key recovers and the post-recovery event
   still verifies.
7. Sender-staleness regression probe: a resource operation whose sender becomes
   unauthorized during the awaited HTTP submit must not report an error after
   mutating the authoritative head.

## Confirmed defect (current source, not an old line)
`src/main/shared-runtime-service.ts:45` checks `isAuthorized()` once, then
`src/main/shared-runtime-service.ts:53` awaits `this.resources.execute(...)`,
which commits the authoritative event. Only afterwards
`src/main/shared-runtime-service.ts:79` checks `isAuthorized()` again. If the IPC
sender becomes stale during the await, `handle` rejects with
`UNAUTHORIZED_IPC_SENDER` after the head has already advanced. The same
post-commit check pattern exists for `copyCommit` (`:49` -> `:79`) and
`assetStage` (`:50` -> `:79`). This violates "no mutation on failure" for a
reported stale-sender failure. Test 7 is an ordinary red test for the resource
case until the parent fixes or changes the completion contract.

## Unverified / limitations
- Actual Windows OS, GUI/browser/Electron, native dialogs and C# execution:
  `NOT_RUN` per worker constraints.
- Tests use loopback HTTP and temporary SQLite/private files only; no real user
  data, shell, git, network egress or subprocess.
- The stale-sender probe intentionally allows either a successful receipt or a
  clean rejection with unchanged head; only "error after mutation" fails.
- Restore coverage asserts the new organization/identity owner and recovery key;
  it does not assert a newly created `workspace.roles` entry for that operator.
- `it.fails`/`skip` were not used.
