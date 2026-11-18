# Restore Operator Report

## Owned files

- `src/collaboration/runtime/restore-operator.ts`
- `tests/shared-runtime-restore-operator.test.ts`
- `REPORT.md`

## Implemented API

```ts
export async function runRestoreOperator(
  args: string[],
  options: RuntimeStoreOptions = {},
): Promise<{ state: "restored"; close(): Promise<void> }>;
```

- Accepts only the eight required flags: `--root`, `--org`, `--token-file`,
  `--backup`, `--destination`, `--epoch`, `--device`,
  `--credentials-output`.
- Rejects URLs, positional values, unknown flags, repeated flags, missing
  values, `--token`, and `--key` arguments as `INVALID_ARGUMENT`.
- Fails closed on native Windows with
  `WINDOWS_RESTORE_OPERATOR_UNSUPPORTED`.
- Preflights the source root without creating it: private canonical directory,
  existing shared-runtime SQLite header/version/application id, and an explicit
  read-only `meta.role === "authority"` check.
- Reads the token file with an O_NOFOLLOW descriptor, `nlink === 1`, owner
  `0600`, size <= 8 KiB, before/after `fstat`/`lstat` identity, strict
  `{token, recoveryKey?}` fields, and shared `wellFormed` validation.
- Reads the backup with a pinned descriptor, size <= 256 MiB,
  `validateRuntimeBackup` SHA-256 validation, and exact canonical raw text.
- Requires a new destination directory with a canonical private `0700` parent;
  creates the destination non-recursively on its canonical path and rejects
  every existing destination, including empty directories.
- Places credentials outside both the source root and destination in both
  containment directions, rejects any existing output before mutation, and
  writes with `writeNewFileDurably` as exclusive `0600` with parent sync.
- Runs `recoveryStatus` as the fresh current-organization admin check, then
  `SharedAuthority.restoreInto` inside the outer destination transaction.
- After the nested restore transaction, creates `IdentityAuthority(destination)`,
  calls `recover(orgId, result.recoveryKey, device)`, and re-runs
  `createRuntimeGenesis(destination, epoch, backup.hash)` so the fresh auth
  session is bound into the restored genesis.
- Writes the recovered operator credentials inside the same outer transaction,
  reads them back, and removes the new credentials file if durability,
  readback, or commit fails.

## Integration points for the parent

- Route `runSharedServer` command `restore` to
  `runRestoreOperator(args.slice(1), storeOptions)`.
- Let `main` emit `{"state":"restored"}` for a handle whose `url` is absent and
  call `close()` as usual.
- No GUI, server listener, or process signal handling is started here.

## Verification and limitations

- Source code and adversarial tests were written, but no checks, tests, build,
  or GUI runs were executed by this worker. Test status is `NOT_RUN` here; the
  parent owns execution.
- The operator does not reopen the destination itself after commit; the tests
  reopen it with `SharedAuthority`, verify the genesis/head, authenticate the
  new token, use the new recovery key, and confirm the historical source token
  and recovery key do not work in the fresh realm.
- A destination created before the restore transaction is removed when
  destination preparation or `RuntimeStore` opening fails. Destination content
  is left in place if the restore transaction itself fails, because a commit
  outcome can be unknown. The source authority and all external inputs are not
  written.
- Source-role preflight uses a read-only `node:sqlite` probe in addition to the
  shared runtime header check. A foreign but header-compatible database with a
  missing or bad `runtime_records` schema is rejected as
  `NOT_SHARED_RUNTIME_FORMAT`; a valid shared database with a non-authority
  role is rejected as `WRONG_STORE_ROLE`.
