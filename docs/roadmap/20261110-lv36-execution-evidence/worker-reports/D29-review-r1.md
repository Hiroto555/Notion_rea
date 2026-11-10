# D29 — Bounded independent audit (Lv3/Lv4 existing code)

Owned output: this `REPORT.md` only. No source, test, contract, helper, config, git, shell, network, GUI, or real-data edits were made. No checks/tests/build run here; parent executes regression.

## Scope actually read

- `src/main/sync-connection-vault.ts` (192 lines, full)
- `src/sync/secret-record-file.ts` (505 lines, full)
- `src/sync/private-ledger.ts` (94 lines, full)
- `src/sync/m3-private-root.ts` (180 lines, full, direct dependency of ledger)
- `scripts/package.mjs` (44 lines, full)
- `package.json` (script/dependency context only)
- `docs/LEVEL3-STATUS.json`, `docs/QUIET-TESTING.ja.md`, `docs/QUIET-IMPLEMENTATION.ja.md`
- `W0.md` (frozen contract)

Not read: runtime/*, other sync/*, main wiring, IPC/preload, test suites. No broad source sweep per task bound.

## Implemented API (as observed)

- `SyncConnectionVault`: `view/configure/disable/resolve/load/markActivated`. Configure seals token into profile JSON stored via `PrivateLedger`; `load` unseals. `PrivateLedger` is a 2-table private SQLite (`m3_private_identity`, `m3_private_records`), key/value ≤64 KiB, ≤4096 rows, ≤8 MiB, journal DELETE, `synchronous=FULL`.
- `SecretRecordFilePersistence`: `read/write/delete`; single hard-link file per SHA-256(key) name, mode 0600 in a 0700 dir, O_NOFOLLOW, fstat/lstat identity rechecks, fsync of file+dir.
- `package.mjs`: `dist` + notices + minimal package.json → `@electron/packager` → `release/`.
- Necessary integration points: main must supply `forbiddenRoots`, `safeStorage`, `assertWorkspaceAllowed`, `workspaceIdentity`; `markActivated` must follow a verified restart; `resolve`/`load` callers must tolerate thrown `SyncError`/`ZodError` (see D1).

## Existing accepted Level 3 vs actual Mac acceptance

- `docs/LEVEL3-STATUS.json:3-6` pins evidence to commit `db7bf1a…` dated 2026-11-05. That is a prior accepted snapshot, not evidence for the current tree.
- The same file records GUI PASS (57 files / 212 tests) and `level4: NOT_REACHED` (`:14,18`). It does **not** establish current-machine acceptance.
- `docs/QUIET-TESTING.ja.md:33` states the Mac acceptance path is **NOT_RUN**; `:43` states GitHub Actions is **NOT_RUN**. `docs/QUIET-IMPLEMENTATION.ja.md:25` says the audited stage was Level 2 with Level 3 partial — this directly contradicts `LEVEL3-STATUS.json:5-6`.
- Conclusion: treat `confirmedLevel: 3` as historical acceptedLevel3. Actual NotRun: current Mac acceptance, Linux CI, cross-device sync, Windows, physical IME/pickers (`LEVEL3-STATUS.json:16`), installed-app replacement (`:19`).

## Residual code defects (specific)

- **D1 — Inconsistent failure contract in vault.** `resolve` (`sync-connection-vault.ts:165-172`), `load` (`:173-183`), `markActivated` (`:184-191`) have no `try/catch`, unlike `view/configure/disable`. Corrupt JSON, `ZodError`, `SecretStoreError`, `connection-stale`, or `private-ledger-*` escapes as a raw throw. Callers get neither the `SyncConnectionAction` reason vocabulary nor guaranteed "original input retained on refusal" behavior. Exact repro: write invalid JSON to the profile key, call `resolve` → `ZodError` escapes; corrupt ciphertext, call `load` → `SecretStoreError` escapes.
- **D2 — Unconfigured vault can be reported as "held".** `describe` checks the secure-storage backend whenever `!profile || profile.enabled` (`:65-68`). With no profile configured, a headless/Linux host without a backend shows `state:"held", reason:"secure-store-unavailable"` instead of `unconfigured`. `view()` (`:103-106`) thus reports a failure state for an app that never configured sync. Likely a residual UI-state defect, not a security one.
- **D3 — No cryptographic erasure on disable.** `disable` sets `ciphertext:null` (`:154-159`), but `PrivateLedger` runs `journal_mode=DELETE` with no `PRAGMA secure_delete=ON` (`private-ledger.ts:32`). Old ciphertext bytes can persist in freelist pages or prior journal content. `SecretRecordFilePersistence.delete` is unconditionally unsupported (`secret-record-file.ts:407-410`), so there is no secure-delete path at all. Residual for credential rotation/device revocation.
- **D4 — Misleading error classification on identity failures.** `binding()` folds "no `process.getuid`", wrong uid, multi-link, symlink, and non-canonical path into `connection-identity-changed` 409 (`:39-42`). On unsupported platforms this looks like tampering, and the reason maps to `identity-changed` (`:77`). Should be a distinct `unsupported-platform`/`held` reason so operators do not chase a false identity incident.
- **D5 — Unvalidated `baseUrl` normalization path.** `new URL(input.baseUrl).origin` (`:123`) throws native `TypeError`; `reason()` (`:71-80`) has no branch for it, so it degrades to `local-error` rather than `invalid-input`. Whether the schema blocks this first is outside the files read, but the vault has no local guard.
- **D6 — `assertExistingWorkspaceBinding` can leak raw fs errors.** `realpathSync(path)` at `:91` and `lstatSync(sidecar)` handling (`:92-96`) map only ENOENT and some `SyncError`s; e.g. EACCES/ENOTDIR yield native errors that `reason()` maps to `local-error`, not `identity-changed`/`workspace-binding-mismatch`. Adversarial case: unreadable workspace directory.
- **D7 — Post-write close failure misreported.** `secret-record-file.ts:390-393` clears `descriptor` before `closeSync`; if `closeSync` throws, catch sees `undefined` and reports `write-failed` although the record and directory fsync may already have succeeded. Caller cannot tell applied from not-applied; the comment at `:397-399` only covers retained partial files.
- **D8 — `view()` swallows ledger corruption into `held`.** `:103-106` converts every failure (including `private-ledger-invalid`) into `held` without distinguishing "backend unavailable" from "vault structurally corrupt". Operator cannot tell whether to retry or escalate.
- **D9 — Packaging risk: `node:sqlite` under Electron 45.** `private-ledger.ts:3` imports `node:sqlite`. `package.mjs` bundles only `dist` + `package.json` (`:12-26`) and does not verify that the target Electron runtime exposes `node:sqlite`; `prune:false` (`:37`) also does not add `node_modules`. If the built `dist` externalizes any dependency, the packaged app will fail at first ledger open. Not proven from these files; parent should confirm the built main is self-contained.
- **D10 — Package script silently drops icon.** `package.mjs:38-40` uses `existsSync`; a missing `assets/icon.icns` packages successfully with no icon and no error. Silent artifact regression.
- **D11 — Docs contradiction.** `QUIET-IMPLEMENTATION.ja.md:25` (Level 2 / Level 3 partial) vs `LEVEL3-STATUS.json:5-6` (Level 3 PASS) are both current docs with no superseding note on the former. Residual documentation defect; affects any automated status read.
- **D12 — Gate bypass surfaces remain.** `QUIET-TESTING.ja.md:35` explicitly lists r8/r9 screenshot and demo/verify scripts as outside the opt-in gate. This is documented, but is a standing residual for "GUI never started" claims.

## Windows migration boundaries (explicit)

- `secret-record-file.ts:180-183`: hard fail on `win32`, and the module depends on `O_NOFOLLOW`/`O_DIRECTORY` which are unavailable there. Entire secure-record backend must be replaced (DPAPI/CNG + ACL-verified directory), not ported.
- `m3-private-root.ts:28-38`: rejects `win32`; model assumes POSIX uid, directory mode 0700, ancestor mode bits, sticky bit, `nlink===1`. No Windows ACL equivalent. Every `PrivateLedger` consumer, including the connection vault and `connection::"private-ledger"`, fails closed on Windows.
- `sync-connection-vault.ts:39-40`: requires `process.getuid` and `stat.uid` equality; on Windows `getuid` is absent, so configure/view/load all return 409 `connection-identity-changed`. This is a fail-closed but misleading boundary (see D4).
- `sync-connection-vault.ts:45`: binding hash includes `stat.birthtimeNs`; Windows/FS-dependent birthtime fidelity is unproven, so binding stability across copies is unverified.
- `scripts/package.mjs:31-32`: platform/arch hard-coded `darwin`/`arm64`; no win32 target, no Windows metadata, no signing/notarization step. Windows distribution is simply not produced.
- Summary: Windows is a supported-nothing boundary today. Level 3 scope is explicitly `Local SQLite, single owner, currently supported single-window product paths` (`LEVEL3-STATUS.json:7`); Windows would require a new secret-store and identity/ACL design, not a config flag.

## Unverified / known limitations

- No execution of `npm run check`, `npm test`, `npm run build`, packaging, or any adversarial harness; all findings are static.
- Current Mac acceptance, Linux CI, cross-device sync, reconnect/conflict/recovery, attachment/delete/restore, and old-version refusal remain `NOT_RUN`.
- `node:sqlite` availability in the packaged Electron 45 binary is unconfirmed (D9).
- Runtime coordination (`src/collaboration/runtime/*`) and IPC wiring were out of this task's read bound; integration assumptions above are from type signatures only.
- Regression suggestions for parent: corrupt-profile → `resolve/load/markActivated` throw behavior (D1); unconfigured+missing-backend view (D2); disable then raw-page scan for surviving ciphertext (D3); injected `closeSync` failure in `SecretRecordFilePersistence.write` (D7); package with icon removed (D10).
