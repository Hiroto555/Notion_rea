# R09 Windows native static review

Status: static review only. No shell, Node, PowerShell, C# build, network, GUI, Electron or real data was run.
Nothing here is Windows OS evidence. Owned output: this `REPORT.md` only; reviewed files were read-only inputs.

## Scope / owned files (reviewed, not modified)

- `scripts/platform/windows/probe-private-root.ps1`
- `scripts/platform/windows/OwnedNodeJob.cs`
- `src/platform/windows/path-policy.ts`
- `src/platform/windows/private-root.ts`
- `src/platform/windows/owned-node.ts`
- `src/platform/credential-provider.ts`

Cross-read: `runtime/{contract,canonical}.ts`, `src/sync/{m3-private-root,private-ledger,secret-record-file,secret-store}.ts`,
`src/main/{index,shared-runtime-service}.ts`.

## Implemented API (actual exports)
- `path-policy.ts`: `validateWindowsPath(path, root) -> {canonical, relative}`; `assertWindowsProbe(probe)`.
- `private-root.ts`: `WindowsPrivateRoot.assert(path, root)`; `windowsPowerShellCommand(path, root)`;
  constants `WINDOWS_PROBE_*` and trust-boundary string.
- `owned-node.ts`: `ownedNodeArgv(options) -> readonly string[5]`; `createOwnedNodeJob(options, executorPort)`;
  `OwnedNodeOptions/Result/ExecutorPort` types; 300 s, 64 KiB limits.
- `credential-provider.ts`: `CredentialProvider.seal(scope, secret) -> Uint8Array`,
  `open(scope, bytes) -> string`, `describe()`; `CredentialError` with fixed codes.
- Native: PowerShell emits one compressed JSON probe record (9 fields) and exits 0/1.
  `OwnedNodeJob.cs` is a 5-arg CLI (`nodeExe, ownedScript, tempRoot, nonce, timeoutMs`) emitting one JSON outcome.

## Integration points

- `WindowsPrivateRoot` needs an adapter that runs `windowsPowerShellCommand`, kills the process tree on
  timeout, enforces `WINDOWS_PROBE_MAX_OUTPUT_BYTES`, parses JSON and passes it to `assert`.
  **No such adapter exists in this copy** (no importer of `private-root.ts`/`windowsPowerShellCommand`).
- `createOwnedNodeJob` needs an executor that launches the compiled `OwnedNodeJob` with `ownedNodeArgv`.
  **No executor/adapter exists** (no importer of `owned-node.ts`).
- `CredentialProvider` is wired: `src/main/index.ts:272` into `SharedRuntimeService`;
  sealed ciphertext used at `shared-runtime-service.ts:29` and `:39`.
- **Windows native filesystem file ledger actual adapter is MISSING.** `pinPrivateRoot` hard-fails on
  `win32` (`m3-private-root.ts:28`); `secret-record-file.ts:180` also rejects `win32`; `PrivateLedger`
  relies on POSIX `uid/nlink/O_NOFOLLOW` (`private-ledger.ts:23-28,49`). The Windows modules provide only
  path policy, a probe contract and an owned-process helper, not an open/read/write/atomic-rename ledger.
  Therefore Windows durable-file claims are **NOT_RUN**, not merely unbuilt.

## Findings
### Blocking for real Windows use

1. **Injected probe is not OS evidence.** `WindowsPrivateRoot.assert` (`private-root.ts:26-51`) trusts any
   injected function. `assertWindowsProbe` (`path-policy.ts:93-111`) checks field shape only.
   Counterexample: `() => ({daclPrivate:true,fileId:"x",linkCount:1,localFilesystem:true,ownerSid:"a",
   platform:"win32",reparsePoint:false,sid:"a",volumeId:"x"})` passes. Call this contract-test only.

2. **Probe timeout does not stop work.** `private-root.ts:31-39` races a timer; the probe promise/child is
   never cancelled. Counterexample: probe spawns `powershell.exe` that hangs; `PROBE_TIMEOUT` returns while
   PowerShell keeps running. Output limit `WINDOWS_PROBE_MAX_OUTPUT_BYTES` (`:7`) is never enforced here.

3. **`tempRoot` and script are not private.** `OwnedNodeJob.cs:133-149` only requires existing dir/file and
   no reparse/device on that single object; it never checks DACL, owner, ancestors, hardlinks or volume.
   Counterexample: `tempRoot=C:\Users\Public` (world-writable), `ownedScript` a hardlink to attacker code;
   validation passes and `CreateProcess` (`:284`) runs it. `CanonicalRegularFile` does not check
   `NumberOfLinks`; `CanonicalDirectory` does not walk ancestors for junctions.

4. **Validation/use TOCTOU and path-based launch.** `OwnedNodeJob.cs:117-128,142-149` validate paths, then
   `CreateProcess` opens by name at `:284`. Counterexample: swap `nodeExe`/`ownedScript` after validation,
   before spawn; no handle-based image/script binding exists.

5. **Handle inheritance is broad.** `CreateProcess(..., bInheritHandles:true, ...)` at
   `OwnedNodeJob.cs:284` without a `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. Only the three pipe read ends are
   made non-inheritable (`:263-266`). Counterexample: any other inheritable handle in the helper (file,
   event, another pipe) is duplicated into the untrusted node process. Use an explicit handle list.

6. **`activeJob` use-after-close race.** Control handler reads the raw handle (`OwnedNodeJob.cs:462-468`)
   while `finally` clears and closes it (`:355-359`) with no lock/refcount. Counterexample: Ctrl-Close
   arrives during teardown; `TerminateJobObject` may run on a closed/recycled handle value.

### High
7. **Probe reopens the target instead of pinning one handle.** `probe-private-root.ps1:573-596,643-650`
   opens with `OPEN_REPARSE_POINT`, closes it, reopens without no-follow, then separately reopens for owner
   and DACL. `DeletePending` from `FILE_STANDARD_INFO` is read (`:84`) but never checked. Counterexample:
   mark file delete-pending/hold a delete handle between opens; probe may accept a name that is or becomes
   absent. Also `reparsePoint=false` is a literal (`:665`), not a final recheck.

8. **Root DACL/owner are never verified.** `probe-private-root.ps1:641-650` checks owner/private DACL only
   for `finalTarget`. Counterexample: `Root=C:\Users\Public`, target has owner-only DACL; probe returns
   valid although the root allowing the swap is world-writable. Root must be probed identically to target.

9. **Drive-letter locality is insufficient.** `ValidateLocalFixed` (`:547-557`) calls
   `GetDriveTypeW(Path.GetPathRoot(path))`. Counterexample: `C:\mnt` is a mount point for a removable/mounted
   volume; `C:\` is `DRIVE_FIXED`, so `localFilesystem=true` is reported for non-fixed storage.

10. **Object-ACE SID offset is wrong for partial GUIDs.** `:524-529` always uses offset 44 for
    `ACCESS_ALLOWED_OBJECT_ACE`; with `Flags=0/1/2` the SID is at 12/28/28. `aceSize` and the SID's own
    length are not validated before `SidToString` (`:381-396`), so parsing can read past an ACE into the next
    ACL bytes. Current effect is fail-closed rejection, but the parser is unsound.

11. **Unicode case-folding for containment.** `path-policy.ts:69` uses `toLowerCase()`. Counterexample:
    `C:\root\K` vs base `C:\root\u212A` (Kelvin sign) compare equal in JS, while NTFS ordinal upcase treats
    them as distinct names; containment can be accepted for a different directory. Restrict segments to
    ASCII or use the Windows ordinal upcase rule, never Unicode lowercase.

12. **Post-execution failures are reported `NOT_RUN`.** `owned-node.ts:113-116,156-161,209-216` maps
    `TIMEOUT`, `NOT_EXITED`, `ORPHAN_PROCESS`, `EXECUTOR_FAILED`, `INVALID_RESULT` to `NOT_RUN` after the
    helper may already have run. Counterexample: executor launches node then throws on read; result says
    `NOT_RUN` although work happened, contradicting W0 "missing receipt is not proof of not-applied".
    Add an INDETERMINATE/FAILED status and keep process/ownership facts.

13. **PASS ignores child exit status.** `owned-node.ts:163-182` accepts any non-negative exit code as `PASS`.
    Counterexample: node crashes with exit 1 → `status:"PASS"`. Define PASS as ownership-only or require 0.

14. **Environment leaks to the untrusted node.** `OwnedNodeJob.cs:284` passes `lpEnvironment=null`, so the
    child inherits the helper's full environment. Counterexample: `FOLIO_*` token/secret variables become
    readable by the owned script. Pass a minimal filtered environment.

15. **PowerShell command is PATH/relative-path sensitive (policy still honored).**
    `private-root.ts:61-73` uses `powershell.exe` from PATH and a relative `-File` script path. No
    `-ExecutionPolicy Bypass` is present, so machine policy (including unsigned/AllSigned restrictions) is
    honored as required; keep it that way. Use an absolute system PowerShell path and absolute script path,
    and validate the caller-controlled cwd.

16. **Probe/caller path binding is absent.** `private-root.ts:32` sends raw `path,root`, not
    `validated.canonical`; the return record does not echo path/root. `path-policy.ts:108-109` only requires
    non-empty `fileId`/`volumeId`. Counterexample: probe result can describe a different file and still pass.
    Actual adapter must bind an OS file id/volume id and canonical path to the same open handle.

### Medium / limitations
- `OwnedNodeJob.cs` sets only `KILL_ON_JOB_CLOSE` (`:247-252`); no `ActiveProcessLimit`, memory or CPU limit,
  so a child can fan out processes for up to 300 s. `TerminateProcess` results are ignored (`:309,326-333`).
- `ReadProcessCount` may return 0 immediately after `TerminateJobObject` without reaping wait (`:340-345`),
  and on timeout the count is discarded by the `TIMEOUT` mapping above.
- `OwnedNodeJob` reserved names miss superscript device aliases (`COM¹` etc., `:194-214`); `Quote` is correct
  for the strings accepted.
- `credential-provider.ts` is sound at contract level: canonical envelope, scope-hash binding, ciphertext
  copy, encrypt/decrypt round trip, fixed error codes, no mutation on failure. Minor: `detectAsync`/
  `detectLegacy` (`:326-346`) use property access, so a throwing getter escapes as a non-`CredentialError`;
  `seal` is async-only (`:364-365`) and `describe()` honestly reports `verified:false` (`:432-439`).
  On win32 `index.ts` deliberately does not pass `getSelectedStorageBackend`, so DPAPI selection is not
  independently verified; DPAPI OS-user protection itself is NOT_RUN on Windows.
- No tests exist for these files in this copy (`tests/` is empty here). Therefore contract tests are NOT_RUN.

## Verification status (must not be upgraded)
| Item | Status |
|---|---|
| TypeScript contract/unit tests for these modules | NOT_RUN (parent runs; no test files in this copy) |
| Native C# build / `Add-Type` compile / PowerShell parse | NOT_RUN (no build executed) |
| Windows OS behavior (DACL, reparse, hardlink, Job Object, DPAPI) | NOT_RUN (macOS host) |
| Source-injected probe (`WindowsPrivateRoot` with stub) | contract shape only, NOT actual OS |
| Windows file ledger actual adapter | MISSING by construction (`m3-private-root.ts:28`, `secret-record-file.ts:180`) |

Completion claim: static review only; no native file is qualified for Windows until the blocking items above
have real OS tests and the missing ledger/executor adapters exist.
