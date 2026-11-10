# R15 native-root review (source-only)

Reviewer output: `REPORT.md`. No source, test, config, or script changes were made.
Method: read-only inspection of the bounded files below. No shell, git, network,
GUI/Electron, native execution, real data, or workflows. Parent runs checks/tests/build.

## Files reviewed (bounded, not whole repo)

- `src/platform/windows/runtime-platform.ts`
- `src/platform/windows/native-probe.ts`
- `src/platform/windows/private-root.ts`
- `src/platform/windows/path-policy.ts`
- `src/platform/windows/owned-node.ts`, `owned-executor.ts`
- `src/platform/runtime-store-platform.ts`
- `src/collaboration/runtime/store.ts` (adapter hooks), `authority.ts`, `client.ts`, `main/shared-runtime-service.ts`
- `scripts/platform/windows/create-candidate-root.ps1`
- `scripts/platform/windows/probe-private-root.ps1`
- `scripts/platform/windows/{PrivateRootProbeProgram.cs,OwnedNodeJob.cs,build-native.ps1,generate-probe.mjs,native/*.csproj}`
- Comparison only: `src/sync/m3-private-root.ts` (Mac POSIX pin; not equivalent).

## Actually implemented API

`WindowsRuntimePlatform implements RuntimeStorePlatform`:
`bind(directory): string`, `assertRoot(): void`, `assertDatabase(path): void`,
`syncCreatedDatabase(path): void`, `close(): void`.
Options: `root`, `probeExecutable`, `systemRoot`, optional `untrustedTestPort` (`fs`, `probe`).
It validates canonical Windows paths, pins root/directory FILE_ID_128 + volume id from
probe evidence, pins the database on first `assertDatabase`, re-probes before/after the
created-database `fsync`, and rejects identity changes. Probe spawning uses absolute exe,
`cwd=systemRoot`, four env values (`SystemRoot/windir/TEMP/TMP`), `shell:false`,
`windowsHide:true`, bounded timeout/buffer, stderr-must-be-empty, JSON parse + strict shape.

Other implemented seams: `WindowsNativeProbe` (PowerShell `probe-private-root.ps1`),
`WindowsPrivateRoot`, `createOwnedNodeJob`/`ownedNodeArgv` + `WindowsOwnedExecutor`
(compiled `OwnedNodeJob.exe` job-object helper), `validateWindowsPath`/`assertWindowsProbe`/
`asciiCaseFold` in `path-policy.ts`.

Scripts: `create-candidate-root.ps1` pre-provisions a user+SYSTEM protected DACL with
`OICI` (0x03) on root and `clienta/clientb/server`, validates immediate parent ACL/owner,
rejects unsafe parents/reparse ancestors, writes and reads back `ownership.nonce`, and
returns `physical='NOT_RUN'`. `probe-private-root.ps1` is the source embedded into the
compiled probe by `generate-probe.mjs`; `build-native.ps1` publishes both native exes.

## Parent store hooks (present)

`RuntimeStore` accepts `platformAdapter?: RuntimeStorePlatform`:
- constructor: on win32 requires the adapter, calls `bind(directory)`, and on an existing DB
  calls `assertDatabase(path)` before header validation (store.ts:184-191);
- new DB: `mkdirSync`, `openSync(...,"wx")`, open SQLite, schema/validate, then
  `syncDirectory()` delegates to `platformAdapter.syncCreatedDatabase(path)` (store.ts:224-274);
- every `assertUsable()` calls `assertRoot()` + `assertDatabase(path)` (store.ts:295-300).
`SharedAuthority` and `SharedRuntimeClient` forward `RuntimeStoreOptions`, so the intended
integration point exists. `SharedRuntimeService.cache()` currently constructs
`new RuntimeStore(...)` with no adapter, and no production module constructs
`WindowsRuntimePlatform`; on win32 the store therefore fails `WINDOWS_PRIVATE_ADAPTER_REQUIRED`.
This is the main real integration gap, not a review of the contract itself.

## Requirement review

- Pre-provisioned private DACL: implemented at creation time. Owner=current user,
  group=current user, DACL = current + SYSTEM `FILE_ALL_ACCESS`, `SE_DACL_PROTECTED`,
  no parent inheritance. Files created inside inherit via `OICI`. No `SetSecurityInfo`
  on pre-existing objects, so no existing-ACL mutation in this path.
- Unknown-user rights on parent: `ValidateParentDacl` trusts current/SYSTEM/Administrators
  and rejects untrusted SIDs whose access mask intersects `DANGEROUS_MASK`; other SIDs may
  retain read rights. Non-granting ACE types are skipped. This is a real check, not an OS test.
- Nonce parity: nonce format `[A-Za-z0-9_-]{1,128}`, ASCII write, exact length/bytes readback,
  echoed in success. Parity with a Node caller is not implemented; no Node code invokes or
  parses `create-candidate-root.ps1`, and no random nonce provider exists in these files.
- FILE_ID pinning: root/directory/database FILE_ID_128 + volume id are compared at bind,
  assertRoot, before/after `syncCreatedDatabase` fsync. New DB is pinned only after creation
  (no pre-creation file id can exist); parent/ancestor identity is re-probed each time.
- Local fixed FS: candidate requires NTFS, `!FILE_REMOTE_DEVICE`, and serial match. Probe
  requires non-empty filesystem name, `!FILE_REMOTE_DEVICE`, serial match, but does not
  require NTFS or `DRIVE_FIXED`. Therefore "fixed local FS" is not fully proven by probe
  evidence used by `WindowsRuntimePlatform`.
- Ancestor replacement: `FinalPath` + reparse checks on every ancestor, plus path/root/file-id
  comparisons. Detection failures return an error and Node fails closed (`PROBE_*`). This is
  TOCTOU-reduced, not race-free; there is no handle-relative create/open transaction.
- Probe EXE trust/process bounds/minimal env: absolute `.exe`, non-symlink, `nlink===1`,
  spawn without shell, bounded time/output, minimal env. There is no Authenticode, publisher,
  or pinned hash/file-id check of the probe exe, and no notification if it is replaced after
  the constructor stat. Minimal env excludes `FOLIO*` by construction but is a small fixed set.
- Owned helper (`OwnedNodeJob.cs`): suspended create, job object with kill-on-close and
  active-process limit, pre-resume assignment, timeout + reaping, 64 KiB bounded captures,
  nonce echo, minimal allow-list env, canonical containment, local fixed drive, ancestor
  reparse rejection, owner/DACL checks. This is **process ownership/containment**, not a
  security sandbox; the child still has the user's ambient filesystem/network rights.

## Real gaps / known limitations

1. No production wiring of `WindowsRuntimePlatform` into `RuntimeStore` (nor `WindowsOwnedExecutor`
   / compiled probe discovery, signature pinning, or candidate-root bootstrap).
2. `create-candidate-root.ps1` and its JSON/nonce/file-id/ownership-file result are not consumed
   by any Node code; nonce parity and root/file-id pin handoff are therefore unproven end-to-end.
3. Contract drift: candidate `ValidatePrivateDacl` requires protected DACL and exact
   `FILE_ALL_ACCESS`, but probe `PrivateDacl` does not check `SE_DACL_PROTECTED`, exact access
   mask, or `OICI` inheritance flags. A directory can satisfy probe `daclPrivate=true` without
   satisfying candidate validation. Candidate also does not re-validate inheritance flags on
   existing objects, only at creation.
4. Probe exe trust is path/lstat-only; no signature or content pin. `untrustedTestPort` is a
   public option with no hard test-only guard, so injected fs/probe results must never be read
   as OS proof. All injected ports are contract checks only.
5. Local-fixed-volume proof is weaker in the probe than in the candidate (no NTFS/DRIVE_FIXED).
6. New-DB pin happens after `openSync(...,"wx")`; the root directory metadata fsync is not
   performed by `syncCreatedDatabase` (it fsyncs the DB file only). Windows directory durability
   is therefore not demonstrated. SQLite sidecars (`-wal/-shm/-journal`) are not ACL/identity
   pinned by `WindowsRuntimePlatform`; current store mode is `journal_mode=DELETE`,
   `synchronous=FULL`, not WAL. WAL durability and signed-namespace claims are not equivalent
   to the Mac/POSIX implementation and are not established here.
7. `RuntimeStore` still executes `mkdirSync(directory,{recursive:true})` after `bind`; a race
   that removes the pinned directory could recreate it with inherited (non-private) ACLs.
   Subsequent probe identity checks should fail closed, but the insecure artifact can remain.
8. Candidate failure after partial creation reports `created=true` and leaves the tree; there is
   no rollback/cleanup. `Add-Type` embedding requires Roslyn/compiler availability and a fresh
   PowerShell process for repeated use.
9. Probe/helper reviewed C# is large and native-only; compilation/behavior was not validated here.

## Verification status

- Source review: complete for the bounded files above.
- .NET/native compile: NOT_RUN here (parent states probe + OwnedNodeJob compile done;
  RootSetup embedded C# compile pending).
- Tests/lint/typecheck/build: NOT_RUN here (parent executes).
- Actual Windows OS behavior, DACL inheritance, file IDs, fsync durability, job-object
  reaping, and probe trust: NOT_RUN. `physical='NOT_RUN'` is the correct status.
- `npm run check` / `npm test` / build: NOT_RUN.
