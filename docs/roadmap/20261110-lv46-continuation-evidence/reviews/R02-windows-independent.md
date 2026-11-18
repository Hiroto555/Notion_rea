# R02 independent readonly review — Windows native private ledger

Scope: audit only (no source changes). Reviewed `scripts/platform/windows/*`,
`src/platform/windows/*`, `src/sync/private-platform.ts`,
`src/sync/private-ledger.ts`, `src/sync/m3-private-root.ts`, and the two tests.
No shell, no git, no network; no GUI/Electron/browser/clipboard/dialogs and no
Windows-native execution was performed. All "PASS" language below is source
reasoning only; Windows runtime behaviour is **NOT_RUN**.

Trust boundary: the injected `untrustedTestPort` is explicitly a contract fake,
not OS/filesystem acceptance. Nothing here should be read as a Windows OS pass.

## Critical findings (confirmed from code paths)

### F1 — Create proof is not bound to the file that was created (swap race)
Location: `scripts/platform/windows/PrivateRootProbeProgram.cs:24-34`;
consumed by `src/platform/windows/runtime-platform.ts:634-645,570-589`.

The `FileStream` create handle is disposed at line 27, then proof is fetched by
path (`FolioWindowsProbe.Run(args[0], args[1], sid)`, line 32). No file id is
captured from the create handle, and the only cross-check at line 33 compares
`rootFileId`/`volumeId`/`canonicalRoot` (the **root** directory), not the target
file. `WindowsRuntimePlatform.createExclusiveDurably` then pins whatever
`evidence.fileId` the reopened path produced (`#recordFileEvidence`).

Minimal counterexample: process creates empty `C:\Private\connections.sqlite`
(lines 25-27, flushed and closed). Before line 31, a same-user/admin actor
renames it and moves a prepared file with the same name and inherited private
DACL into place. The post-create probe passes (owner/DACL/one link/no reparse/
local volume) and the program emits the replacement's `fileId`; Node pins the
replacement and `PrivateLedger` opens the attacker file. The DACL/link/reparse
checks are specifically meant to stop same-user tampering, so this defeats the
stated proof.

Fix: read `FILE_ID_INFO` from the create handle (or hold it open) and compare it
to the post-proof, or re-open with `FILE_FLAG_OPEN_REPARSE_POINT` and require the
same `FILE_ID_INFO` on both handles.

### F2 — Residual file from an uncertain create is adopted by the next attempt; UNKNOWN is collapsed
Location: `PrivateRootProbeProgram.cs:24-30,41`;
`src/platform/windows/runtime-platform.ts:634-645`.

If `Flush(true)`/dispose fails after `CreateNew` succeeded, or any post-create
step fails, line 41 prints the single generic `WINDOWS_PRIVATE_ROOT_UNSAFE` and
`exit 1`. Node maps that to `PROBE_EXIT`; the fact that a file may already exist
with unknown durability is lost. On retry the same path hits
`FileMode.CreateNew` -> `ErrorFileExists` (lines 28-30), probes the leftover
file, and **returns success**. So a create whose durability was never confirmed
is silently accepted on the next attempt, with no UNKNOWN marker and no
distinction between "created now" and "left over from a failed attempt".

Fix: on a failed/uncertain create, emit a typed UNKNOWN result (do not fold into
`PROBE_EXIT`), record the intended path/attempt, and do not let a later create
treat a pre-existing file as durable without an explicit, separate reopen path.

### F3 — Required-hash gate is bypassed by `untrustedTestPort`; executable pin skipped
Location: `src/platform/windows/private-ledger-native.ts:51-55`;
`src/platform/windows/runtime-platform.ts:308-353,403-405`.

`storeOptions` requires `expectedHash` **or** `untrustedTestPort`. In the
injected branch, `#executablePin` is set only when `expectedHash !== undefined`
(lines 349-352); otherwise it stays `undefined`, and `#assertExecutable()`
returns immediately (403-405). Therefore `probeExecutable` is never lstat'd,
hash-pinned, or re-checked. The production factory cannot distinguish a test
construction from a production wiring that accidentally supplies a test port.

Minimal counterexample:
`createWindowsPrivatePlatform({root:"C:\\P", probeExecutable:"C:\\tmp\\evil.exe",
systemRoot:"C:\\Windows", databaseName:"connections.sqlite",
untrustedTestPort:{probe:{probe:()=>validEvidence}}})` constructs successfully
with no hash and never validates the executable. The "requires expected hash"
test only covers the no-port case and gives false confidence.

Fix: require `expectedHash` unconditionally in the production factory; gate the
injected port behind an explicit non-production flag that also forbids `win32`;
and when a port is injected, still pin the executable if `probeExecutable` is
used.

### F4 — Arbitrary ledger name is not supported end-to-end; error type breaks the sync contract
Location: `src/sync/private-ledger.ts:30-43`;
`src/platform/windows/runtime-platform.ts:236-246,563-568`;
`src/sync/private-platform.ts:195-235,276-298`.

`WindowsRuntimePlatform` freezes a single `databaseName` at construction
(default `shared-runtime.sqlite`), and `#assertNamedPath` rejects any relative
name that differs. `PrivateLedger` independently takes `name` and joins it to
the bound root; nothing derives one from the other. Building the platform with
the default and then using `connections.sqlite` fails with
`WINDOWS_DATABASE_PATH`. The advertised "arbitrary ledger filename" only works
if every caller manually keeps `databaseName` in sync, and `WINDOWS_PRIVATE_PORT_GAP`
(`private-platform.ts:211-212`) still states the platform only handles
`shared-runtime.sqlite`, which is now stale.

Also a validation mismatch: `DATABASE_NAME_PATTERN` accepts `con.sqlite`
(`/^[a-z0-9][a-z0-9_-]{0,62}\.sqlite$/`) while `validateWindowsPath` rejects it
as a reserved device name, so a "valid" option fails later with a different
code. And `PrivateLedger`'s name regex disallows leading digits/underscore that
the Windows pattern accepts.

Additionally the Windows port throws `CollaborationError` (all `fail()` calls in
`runtime-platform.ts`) while `PrivatePlatform` methods and `PrivateLedger`
callers/tests are written against `SyncError`. A failure such as
`WINDOWS_DATABASE_PATH` therefore escapes `expectCode(...SyncError...)` and the
sync error contract.

Fix: derive `databaseName` from the ledger name (or accept the name per call),
share one validation rule, update the gap constant, and translate native errors
to `SyncError` at the `WindowsPrivatePlatform` boundary.

### F5 — Emptiness/sidecar/durability proofs are not identity-bound or retained
Location: `src/platform/windows/runtime-platform.ts:591-602,604-616,626-645,647-693`.

- `#assertFileAt` does `lstat` (line 595) and then a **separate** path-based probe
  (line 596), returning the earlier `stat`. `assertEmptyFile` decides emptiness
  from that `stat.size` (line 631). If the file is swapped between the two
  calls, `stat.size` can describe the old empty file while `evidence.fileId`
  pins a different (non-empty) file. The empty check and the identity proof can
  then disagree.
- `createExclusiveDurably` (634-645) never checks size/emptiness after create,
  and never calls `syncCreatedDatabase`; that method (666-693) is dead code in
  the ledger path. `PrivateLedger` only calls `assertEmptyFile` inside the
  schema branch after `DatabaseSync` is already open (`private-ledger.ts:43-57`).
- `#assertSidecars` (647-664) proves each sidecar but never stores its
  `fileId`/`volumeId`; only the main DB is recorded in `#filePins`. A sidecar
  replaced with another private-looking file after the one-shot assertion at
  `private-ledger.ts:42` is never detected (no sidecar re-check at read/
  transaction time).

Fix: take size and identity from one handle (or lstat before and after a probe
and require both stable), make create assert empty + sync durably before
returning, and pin sidecar ids and re-validate them at open/read boundaries.

## Additional (non-critical) note — close failure not retryable
`WindowsPrivatePlatform.close()` sets `closed = true` before delegating
(`private-platform.ts:300-304`), and `PrivateLedger.close()` sets its flag before
`platform.close()` (`private-ledger.ts:201-220`). If the runtime close throws,
both are now closed, so a retry returns early and never re-attempts the close,
potentially leaking native handles in an injected runtime.

## Verification status and interface gaps
- Windows native create/probe: **NOT_RUN** (no Windows execution permitted).
- POSIX `PrivateLedger` paths and injected-port contract tests were read, not
  run by this worker; parent runs `npm run check` / `npm test`.
- Missing from this isolated copy (referenced but absent, so not audited and
  likely parent/base-owned): `src/platform/windows/private-root.ts`
  (`WINDOWS_PROBE_MAX_OUTPUT_BYTES`, `WINDOWS_PROBE_TIMEOUT_MS`),
  `src/platform/runtime-store-platform.ts`, `src/sync/protocol.ts`,
  `src/sync/sqlite-guard.ts`, `src/persistence/durable-file.ts`. If any are also
  absent from the merged tree, `tsc` fails at `runtime-platform.ts:19-22`.
- No source files were modified.
