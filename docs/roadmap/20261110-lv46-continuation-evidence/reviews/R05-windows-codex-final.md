# C21 / final Windows review — Codex continuation after OpenCode free exhaustion

## Implementation

- Real `recover` shared-server route invokes `runRecoveryOperator`, using the existing SharedAuthority owner-recovery operation inside one outer SQLite transaction.
- Existing private root and physical shared SQLite header are pinned/read before any authority constructor. A missing or foreign-format source is never created/migrated.
- Exact flags: `--root`, `--org`, `--recovery-key-file`, `--device`, `--credentials-output`.
- Input is a private600 raw recovery key or bootstrap two-field JSON. Output is a fresh no-clobber600 two-field `{token,recoveryKey}` in a private700, disjoint sibling directory.
- Exclusive NOFOLLOW creation, descriptor identity/hash readback, file fsync, pinned parent fsync, then immediate before-COMMIT output identity/content recheck. No unlink on any failure.
- New credentials are published before outerCOMMIT. Publication/COMMIT/ACK uncertainty returns `RECOVERY_UNKNOWN` and preserves output. No auto retry. A postCOMMIT lost ACK test reopens SQLite and authenticates the published new token, with old token invalid and only one recovery event.
- PostCOMMIT normal result reauthenticates owner and verifies the authority. Console returns state only, no secrets.
- Actual Windows recovery operator remains explicitly unsupported pending a native private credential-publication port. This is an implementation gap, separate from OS NOT_RUN.

## Independent Windows source review

Read final runtime-platform, native-probe, app-private, recovery-proof, private-platform, private-ledger, sync-connection-vault, main/index, path-policy, actual PrivateRootProbeProgram.cs and probe C# source. No native helper, DPAPI, GUI, or Windows execution was performed.

Confirmed P2 findings fixed:

1. Supplied Windows PrivatePlatform bypassed forbiddenRoots. SyncConnectionVault now rejects canonical overlapping credential/workspace paths before ledger creation or encryption, including case/drive separator variations and ancestor/equal paths. SecretRecordLedgerPersistence had the same boundary gap; it now enforces its supplied forbidden roots before native factory invocation. Injected POSIX temp contracts remain labelled non-OS evidence.
2. Native UNKNOWN/503 and ownership failure after successful SQLiteCOMMIT were reported as held/local-error. Vault now preserves explicit nativeUNKNOWN and503 as outcome-unknown, classifies completed-mutation uncertainty conservatively, and preserves the original uncertainty if close also fails. Secret ledger likewise returns typed503 uncertainty after a completed mutation. Real SQLite regression injects an ownership failure only once committed rows become visible through a separate readonly connection, then resolves the original receipt / reads immutable ciphertext without rewriting it.

P3 note sent to parent: main/index.ts SystemRoot fallback had a doubled separator; parent owns its correction.

No additional confirmed P1/P2 findings in the bounded source review. This does not certify Windows OS behavior, trusted native deployment, DPAPI, power-loss durability, or GUI behavior.

## Verification

- Recovery operator: 10/10 actual temp SQLite Node tests PASS, including server-entry route, raw/JSON key, wrong key, preexisting output, missing/foreignformat source, fsync failure rollback with private output retained, beforeCOMMIT fault, postCOMMIT ACK loss, unsafe permissions/inside-root destination.
- Combined focused run: 34/34 PASS (recovery10 + existingWindowsvault8 + newvault11 + newsecret5).
- After final uncertainty-close guard strengthening: newvault11 + newsecret5 =16/16 PASS.
- Parent owns final TypeScript check/build/full suite. No claim of those here.
- Windows, Keychain/DPAPI, GUI/Electron/browser/E2E/clipboard/dialog: NOT_RUN.
- No push/workflow/merge/realdata/billing/globalconfig action.
