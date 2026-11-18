# R14 native follow-up review (bounded)

Scope: independent source review of the Windows-native layer after F09/F10.
No shell, no build, no test, no OS run, no GUI, no mutations to inputs.

Owned output: this `REPORT.md` only. All reviewed files were read-only inputs.

## Files reviewed (inputs, unchanged)

- `scripts/platform/windows/OwnedNodeJob.cs` (1057 l.) / `native/OwnedNodeJob.csproj`
- `scripts/platform/windows/PrivateRootProbeProgram.cs` / `native/PrivateRootProbe.csproj`
- `scripts/platform/windows/probe-private-root.ps1` (857 l.)
- `scripts/platform/windows/generate-probe.mjs`, `build-native.ps1`
- `src/platform/windows/{native-probe,owned-executor,owned-node,path-policy,private-root}.ts`
- `src/platform/runtime-store-platform.ts`

## Actual implemented API

- `WindowsPrivateRoot.assert(path, root)` / `windowsPowerShellCommand(...)` (`private-root.ts`).
- `WindowsNativeProbe.probe(path, root)`; injectable `untrustedTestExec` (`native-probe.ts`).
- `validateWindowsPath`, `asciiCaseFold`, `assertWindowsProbe`, `WindowsProbeEvidence` (`path-policy.ts`).
- `ownedNodeArgv`, `createOwnedNodeJob` (`owned-node.ts`); `WindowsOwnedExecutor` implements
  `OwnedNodeExecutorPort` (`owned-executor.ts`).
- `RuntimeStorePlatform` is an interface only (`runtime-store-platform.ts`).
- Native helpers: `OwnedNodeJob.Main` (job-contained node launcher, JSON outcome on stdout);
  `FolioWindowsProbe.Run` + `PrivateRootProbeProgram.Main` (13-field JSON probe).

## Confirmed source-level findings (severity = source impact, all OS-unverified)

F1 P2 — broad-SID policy divergence between the two private-root checks.
`OwnedNodeJob.cs:608-625` `IsBroadSid` recognizes only WD/BU/AU/IU/AN, `S-1-1-0`,
`S-1-5-11`, `S-1-5-32-545`, `S-1-5-4`, while `probe-private-root.ps1:240-254` `UnsafeSids`
also rejects `S-1-5-7`, `S-1-5-32-546/547/555`, `S-1-15-2-1`, `S-1-15-2-2`. SDDL aliases
emitted by `ConvertSecurityDescriptorToStringSecurityDescriptorW` (e.g. `AC` for app
packages) are also not mapped. Net: one temp-root DACL can pass `OwnedNodeJob.Inspect`
but fail the probe. Owner is still pinned to the current user on both paths, so this is
not by itself a privilege escalation.
Related over-rejection: `OwnedNodeJob.cs:568-578` `HasBroadAce` treats any ACE with a
broad SID as unsafe regardless of ACE type (deny ACEs included).

F2 P2 (OS/ACL-dependent) — probe temp dir may be unwritable for standard users.
`native-probe.ts:140-147` sets `TEMP`/`TMP` to `${systemRoot}\Temp` and `cwd` to
`systemRoot`; `probe-private-root.ps1` uses `Add-Type -Language CSharp` (:31), whose
CodeDom compiler writes under `TEMP`. `C:\Windows\Temp` is normally writable only by
admins/SYSTEM, so the probe likely fails for non-admin accounts. Whether it fails depends
on host ACLs (NOT_RUN).

F3 P3 — mixed separator parity gap. `OwnedNodeJob.cs:191-192` rejects `\\` and `//` but
not mixed `\/`, while `path-policy.ts:95` uses `[\\/]{2}` and rejects mixed. The helper
accepts path shapes the TS layer rejects.

F4 P3 — nonce regex parity. `OwnedNodeJob.cs:151` uses `Regex.IsMatch("^...+$")`; .NET
`$` also matches before a trailing `\n`, unlike JS `NONCE_PATTERN` (`owned-executor.ts:18`,
`owned-node.ts:9`). Helper could accept `"nonce\n"`; downstream nonce echo compare would
still mismatch. Defense-in-depth only.

F5 P3 — native allocation leak. `OwnedNodeJob.cs:327` `Marshal.AllocHGlobal(attributeSize)`
is paired only with `DeleteProcThreadAttributeList` (:427) and never `Marshal.FreeHGlobal`.
One block leaked per helper process (short-lived).

## ABI / layout review (passes by inspection, OS NOT_RUN)

- `STARTUPINFO`/`STARTUPINFOEX`, `PROCESS_INFORMATION`, `SECURITY_ATTRIBUTES`,
  `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`, `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`
  field sizes/offsets match x64 native layout with `SIZE_T`/`ULONG_PTR` as `UIntPtr`.
  `cb = Marshal.SizeOf<STARTUPINFOEX>()` (:343) and `EXTENDED_STARTUPINFO_PRESENT` + `StartfUseStdHandles`.
- Probe `FILE_STANDARD_INFO` (22→24 padded), `FILE_ATTRIBUTE_TAG_INFO` (8),
  `FILE_ID_INFO` (8+16), `ACL_SIZE_INFORMATION` (12) layouts are consistent.
- ACE bounds (`probe-private-root.ps1:626-685`): offset vs `AclBytesInUse-4`, `aceSize`
  (ushort) and `aceOffset+aceSize` bounds, SID at offset 8, `GetLengthSid` bounded before
  `ConvertSidToStringSidW`; object/compound/callback ACE types rejected. Sound.
- Final path: `GetFinalPathNameByHandleW` with 32 KiB buffer, `\\?\`/`\??\` stripped, UNC
  rejected, case-insensitive compare against normalized expected path. Sound.

## Handle inheritance / job / env / stdout review

- Inheritance: all pipes created inheritable, then parent ends cleared (`:314-319`); explicit
  handle list is exactly `{stdinRead, stdoutWrite, stderrWrite}` with `bInheritHandles=true`
  and the pinned list freed only after `UpdateProcThreadAttribute` copies it. Correct.
- Job: create suspended → set limits (`KillOnJobClose|ActiveProcessLimit=1`) → assign → resume;
  assign/resume failure terminates; timeout terminates job, bounded wait, then polls
  `ActiveProcesses`; Ctrl handler terminates job. No confirmed source bug. OS caveat:
  `AssignProcessToJobObject` can fail when the helper itself runs inside a non-nestable job
  (environment, P2 at most).
- Env leak: launcher and helper both build whitelist-only environments
  (`owned-executor.ts:77-91,170`; `OwnedNodeJob.cs:646-679`); secret-key patterns filtered.
  No token/secret leak found.
- stdout/nonce: helper writes 11 JSON fields (`OwnedNodeJob.cs:747-773`) to raw stdout while
  child stdout is a separate pipe; Node validates plain-object shape via `canonical`, checks
  `nonce` and `ownRootNonce` both equal the request (`owned-node.ts:181-220`). Consistent.

## New probe program / managed exe

- Serializes exactly 13 fields whose names match `PROBE_KEYS` / `assertWindowsProbe`
  (`PrivateRootProbeProgram.cs:12` vs `path-policy.ts:122-126`). Correct set.
- Source is generated by `generate-probe.mjs` from the PS1 here-string and compiled with
  `PrivateRootProbeProgram.cs`; apphost enabled via `-p:UseAppHost=true`
  (`build-native.ps1:19`). Source-compatible on inspection.
- Integration gap: no caller invokes the managed probe exe. `native-probe.ts:160-214` and
  `private-root.ts:86-118` still spawn `powershell.exe -File probe-private-root.ps1`.
  "Absolute invocation" is satisfied only if a future caller passes absolute args;
  `Run` normalizes and compares final paths, so traversal is neutralized.

## Necessary integration points (not wired in this copy)

- `store.ts:184-186` requires a `RuntimeStorePlatform` adapter on win32
  (`WINDOWS_PRIVATE_ADAPTER_REQUIRED` otherwise); no Windows adapter implementation exists
  here, so the probe/job modules are not reachable from the runtime store.
- `WindowsNativeProbe` / `WindowsPrivateRoot` have no references outside their files.
- `WindowsOwnedExecutor` is consumed only through `createOwnedNodeJob`; no app caller here.
- Build entry chain: `build-native.ps1` → `generate-probe.mjs` → dotnet publish of
  `OwnedNodeJob` and `PrivateRootProbe`.

## Unverified / NOT_RUN

- Windows OS execution of helper/probe; .NET 10 cross-compile result; Add-Type under a
  restricted token; actual ACL/final-path/volume behavior; non-ASCII path behavior.
- `FILE_ID_INFO.FileId` `ByValArray` out-marshaling (`probe-private-root.ps1:116-127,312-328`):
  if the array is not populated on unmarshal, `Identity()` throws 87 and every probe fails.
  Reasoned as likely OK for `out` structs but needs an OS run.
- `net10.0` TFM (not `net10.0-windows`) relies on `System.Security.Principal.Windows`
  (`WindowsIdentity`) being in the reference pack; expected present, unverified here.
- No build/test was executed by this worker; no PASS is claimed.
