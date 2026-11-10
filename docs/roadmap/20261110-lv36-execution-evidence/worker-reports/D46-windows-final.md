# D46 Windows final report

## Owned files

- `src/platform/windows/runtime-platform.ts`
- `src/collaboration/runtime/store.ts`
- `scripts/platform/windows/OwnedNodeJob.cs`
- `src/platform/windows/candidate.ts`
- `tests/windows-candidate.test.ts`
- `REPORT.md`

No input/helper/contract files were edited.

## Implemented API

- `WindowsRuntimePlatform`:
  - `expectedHash` SHA-256 pin for the compiled native probe. Hash is re-read and validated on every helper call; initial `dev/ino/size/mtime` identity is pinned and rechecked.
  - `expectedRoot` / `expectedDirectory` evidence IDs are compared during `bind`, so candidate manifest IDs and native probe evidence must agree.
  - Existing `-wal`, `-shm`, `-journal` sidecars are fail-closed preflighted with lstat plus native probe owner/DACL/root/container checks before database pinning.
  - Injected filesystem/probe ports remain explicitly untrusted; the production native adapter still refuses non-Windows hosts.
- `RuntimeStore`:
  - With `platformAdapter`, the pinned root is not recreated; `mkdir(recursive)` is skipped for the native-root path.
  - `closed` / `poisoned` are checked before OS probes, preserving an existing UNKNOWN error.
  - `close()` always calls the platform adapter cleanup in `finally`.
  - POSIX pin/root behavior is otherwise unchanged.
- `OwnedNodeJob.cs`:
  - `RightsAllowWrite` recognizes `WRITE_DAC` (`0x40000`) and `WRITE_OWNER` (`0x80000`), keeps known read-only masks non-writable, and treats empty/unknown rights tokens as fail-closed writable.
  - `[SupportedOSPlatform("windows")]`, initialized attribute-list cleanup, and job `ActiveProcessLimit = 8` are retained.
- `candidate.ts`:
  - `parseWindowsCandidateManifest(raw, expectedPaths)` strictly consumes the actual `create-candidate-root.ps1` JSON shape (`root`, `nonce`, `directories[]`, `ownershipPath`, IDs, etc.), rejects extra fields, substituted paths/nonces/IDs, and requires the exact `clienta`/`clientb`/`server` children.
  - `assertWindowsCandidateEvidence` checks native probe shape plus manifest file/root/volume/owner agreement.
  - `createWindowsCandidate` validates injected evidence but returns `NOT_RUN`; it never converts injected ports into Windows physical PASS.
  - `openWindowsCandidateStores` constructs real `WindowsRuntimePlatform` instances into `RuntimeStore` options and opens real authority/client `RuntimeStore` objects for `server`, `clienta`, `clientb`.

## Integration points

- The strict loader needs parent-supplied expected root/nonce/child/ownership paths.
- Production store creation needs the parent-trusted build manifest values: `systemRoot`, `probeExecutable`, and `expectedHash`.
- Actual PS1 field is `directories`, not a separate `children` field; the loader consumes the emitted `directories` array without inventing fields.

## Unverified / limitations

- No Windows execution, GUI, Electron, native probe build, or C# compile was run in this worker; parent must compile C# and run checks/tests/build.
- All Windows runtime/candidate behavior is unverified against a real Windows host. Tests use injected untrusted ports only.
- `ownership.nonce` bytes are represented by the manifest path/ID; the factory does not re-read the file contents because no trusted native file-read port is exposed.
- The main Windows desktop entry point was not changed and remains fail-closed until private vault ports exist.
- Sidecar probing may fail closed on transient SQLite journal/WAL/SHM files; this is intentional but unverified on real Windows.
- Because `RuntimeStore` still rejects `platformAdapter` off `win32`, candidate store opening is only executable on Windows; off-Windows creation returns `NATIVE_PLATFORM_MISMATCH`.
