# R06 isolation worker report

## Owned outputs

- `tests/shared-runtime-contract-adversarial.test.ts`
- `REPORT.md`

No input, helper, contract, oracle, config or source file was edited.

## Actual APIs exercised

- `src/collaboration/runtime/canonical.ts`: `canonical`
- `src/collaboration/runtime/wire.ts`: `parseCanonicalWire`, `parseScope`, `parseCut`, `parseAttempt`
- `src/collaboration/runtime/document.ts`: `initialState`, `materializedState`, `locate`, `nodeText`
- `src/collaboration/runtime/text-intent.ts`: `applyText` (for internally generated adjacent text runs)
- `src/collaboration/draft-store.ts`: `SharedDraftStore`
- `src/persistence/store.ts`: `Store`
- `src/persistence/full-backup-verify.ts`: `inspectWorkspaceSnapshot`

Adversarial coverage includes raw unknown attributes, unsafe integers and `-0`,
lone surrogates in values and keys, getters/non-enumerable/symbol properties,
sparse arrays, cycles vs shared acyclic values, depth/byte limits, non-canonical
wire spelling, duplicate JSON keys, duplicate/unknown wire fields, bad IDs,
digests and counters, duplicate/missing document IDs, surrogate-splitting text
edits, and no input mutation on refusal.

Raw initial documents are checked for lossless preservation of authored marks,
heading attributes and adjacent text nodes. Internally generated `applyText`
output is checked through `materializedState` for valid adjacent-run
materialization.

Private-store isolation uses only temporary SQLite files. Each foreign-file
refusal checks the original SHA-256 before and after the attempted open and
checks that no `-wal`, `-shm` or `-journal` sidecar was created. Covered:

- fresh private `Store` creates its private schema (application id 0, version 3)
- private `Store` refuses a synthetic shared runtime file (application id
  `0x464c5450`, `user_version` 1003), writable and read-only
- private `Store` refuses a shared-draft application identity
- `SharedDraftStore` refuses the synthetic runtime file and a private `Store` file
- `SharedDraftStore` stages/get/marks unknown a legal quarantine record
- `inspectWorkspaceSnapshot` refuses the synthetic runtime file and accepts a
  complete private v3 workspace

## Integration points / blockers

- No `RuntimeStore` source exists in this copy yet. The task says it will be
  added after merge, so schema-1003 tests use a synthetic SQLite file with the
  text-pilot application id and version 1003. A positive RuntimeStore startup
  test must be added when its actual API lands.
- No exported type or class named `fullcheckpoint` exists in this copy. The
  full-workspace checkpoint path is represented by `inspectWorkspaceSnapshot`;
  the private Store startup path is represented by `Store`. Both are covered.
- `DocumentState` and text/block transform APIs are present; this worker did not
  add or invent any coordinator/runtime store API.

## Confirmed observations

- `checkedState` in `src/collaboration/runtime/document.ts:10` prefixes the
  refusal with `UNSUPPORTED_DOCUMENT:` and then appends `parsed.code`, which is
  already `UNSUPPORTED_DOCUMENT`. Raw unsupported documents therefore produce
  `UNSUPPORTED_DOCUMENT:UNSUPPORTED_DOCUMENT`. Tests assert the required prefix
  rather than the exact doubled string.
- `materializedState` intentionally skips the `inspectSharedDocument` lossless
  comparison used by `initialState`; raw unknown attributes are refused, not
  repaired. This matches the separation between raw external input and internal
  engine output, but callers must not use it as an import boundary.

## Verification status

- Parent executes `npm test`, `npm run check` and `npm run build`; this worker
  did not run shell commands, tests or builds.
- GUI, Electron, browser, clipboard, native dialogs and real data: `NOT_RUN`.
