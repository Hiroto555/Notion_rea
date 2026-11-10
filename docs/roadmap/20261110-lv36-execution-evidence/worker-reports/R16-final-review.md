# R16 final bounded review — shared runtime

## Owned files

- `tests/shared-runtime-final-review.test.ts`
- `REPORT.md`

No source, contract, helper, config, workflow, or real-data file was edited.

## Execution status

- Worker executed no shell, git, network destination, GUI, Electron, browser, native dialog, or clipboard action.
- `npm run check`, `npm test`, build, and GUI are **NOT_RUN** here. Parent must execute them.
- Tests use only throwaway SQLite directories under `os.tmpdir()` and loopback HTTP servers bound to `127.0.0.1`.

## Test inventory

- `organization backup authorization`: normal owner backup succeeds; organization owner without a workspace role receives `FORBIDDEN` until granted read.
- `retention facade revocation`: facade acquired before device revocation re-authenticates each call and receives `TOKEN_INVALID`; new device works.
- `UNKNOWN pending attempts block both write clients`: lost-response `UNKNOWN` blocks main and resource clients with `PENDING_INTENT_BLOCKS_WRITE`; no resend.
- `authorized backup restore and recovery reset`: fresh epoch, old token invalid, old recovery key invalid, new operator/owner and fresh key work; malformed/hash-duplicated/stale/non-empty restore inputs reject without mutation.
- `backup HTTP endpoint`: real POST export succeeds; GET, wrong content type, Origin, Cookie, query, extra body key, bad token, and non-admin member are rejected with distinct statuses; error body does not echo the token.
- `undo witness authorization`: another writer, tampered stored template, and replay are refused; original owner restore succeeds once.
- `state root tamper detection`: authoritative record tamper changes root and raises `STATE_ROOT_MISMATCH`; second genesis is refused; genesis hash tamper is detected separately.
- `IPC-visible recovery output`: connect/open/list/connections/recover outputs contain no live token, recovery key, or sealed credential material.
- `service network-await fencing`: two `it.fails` tests pin currently unsafe await behavior in `SharedRuntimeService` (see findings 1 and 2).

## Confirmed findings (actual file:line)

1. **Sender authorization is checked after connect side effects.** `src/main/shared-runtime-service.ts:26-32` awaits session/workspaces, writes the remembered sealed credential (`:29`), then installs `this.connection` and increments generation (`:31`). The final sender check is only at `:55`. If authorization flips to false during the await, the call rejects with `UNAUTHORIZED_IPC_SENDER` but the connection and cached credential remain. Test: `service network-await fencing` / sender test (`it.fails`).

2. **Open can activate after close/generation change during the network await.** `src/main/shared-runtime-service.ts:45-46` awaits `next.open()` and then assigns `this.client`/increments generation without rechecking the generation captured before the await. `close()` at `:58` cannot cancel that in-flight build. Test: `service network-await fencing` / generation test (`it.fails`).

3. **Organization backup requires read on every workspace.** `src/collaboration/runtime/authority.ts:168` authorizes organization administration, then loops every workspace and calls read authorization. An organization owner with no role on one workspace gets `FORBIDDEN`. This is enforced by the current contract; test asserts it. If recovery export is meant to be an organization-owner power, it needs a separate audited backup grant rather than workspace read.

4. **Restore writes a second user key with the wrong separator.** `src/collaboration/runtime/restore-authorization.ts:12` stores `orgId + ":" + userId`, while identity keys use `orgId + "/" + userId` (`src/collaboration/runtime/identity.ts:219-220`). The existing slash record is rewritten at `restore-authorization.ts:11`, so the authorized restored operator can recover; the extra colon row is dead state and backup noise. No bypass observed.

5. **State-root scope is limited and ignores Cut hash.** `src/collaboration/runtime/state-root.ts:25-51` covers listed domain namespaces plus selected meta keys only. `normalize` replaces a Cut hash with `""` (`:114-115`). Event chain, attempts, intents, undo witnesses, prefix, and retention checkpoints are not bound by `assertRuntimeStateRoot` (`:342-363`); the event chain is separately checked by `authority.verify` (`authority.ts:68-72`).

## Confirmed safe behavior

- Restore skips historical recovery records (`backup.ts:344`), invalidates sessions/devices/pending invites (`backup.ts:351-355`), writes new head/prefix, and `restoreInto` returns `requiresReauthorization: true` plus a fresh recovery key (`authority.ts:169`, `restore-authorization.ts:6-13`).
- `retention()` facade re-runs `authenticate(token)` on every method (`authority.ts:166`), so a revoked token cannot use a previously obtained facade.
- Main client requires zero active entries before submit (`client.ts:41`); resource client requires zero pending entries (`resource-client.ts:189`).
- Witness validation requires the original user/writer, sealed cut not after base, canonical template equality, and single use (`undo-witness.ts:24-30`; applied in `authority.ts:117-119`).
- Backup HTTP validates method, Origin, Cookie, query, content type, canonical 1 KB body, and token before calling the endpoint (`backup-http.ts:179-214`).
- IPC-visible outputs expose digests/metadata only, not raw token or sealed credential.

## Required parent integration points

- Fix `SharedRuntimeService.connect`/`open` to capture generation and sender authorization before any await and to recheck both before closing old clients, persisting credentials, or assigning `this.connection`/`this.client`; abort/close the built provider on mismatch.
- Run the full Node/Vitest suite and typecheck. The two `it.fails` tests intentionally describe safe behavior and currently pass as expected failures. Once the service is fixed they will fail as unexpected passes; convert them to normal `it` tests at that time.
- GUI/Electron/preload behavior remains **NOT_RUN**. The sender test exercises the in-process authorization callback, not a real `webContents` navigation or destroyed window.
