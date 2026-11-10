# R08 client/service integration tests

## Owned files

- `tests/shared-runtime-client-service.test.ts`
- `REPORT.md`

No source, helper, contract, config, or workflow files were modified.

## What the tests exercise

- Actual temp-directory `SharedAuthority` SQLite plus actual loopback HTTP server/provider.
- `SharedRuntimeService` explicit `connect`, `list`, `open`, `document`, `recover`, `refresh`, `invalidate`, `archive`, `disconnect`, `connections`, and `resume`.
- Two server-authenticated users/devices (`owner`/`owner-device`, `editor`/`editor-device`) with a granted editor role and explicit provider connections.
- Lost response after real server commit: client queue becomes `UNKNOWN`, then a same-writer close/reopen plus `reconcile` adopts the durable `SERVER_ACCEPTED` receipt without resubmitting.
- Missing receipt: repeated `reconcile` leaves the attempt `UNKNOWN`; submit call count does not increase.
- `invalidate` produces an `INVALIDATED` receipt; a late direct server submit returns that receipt without advancing head or applying the command.
- `archive` is refused while proof is absent and succeeds only after durable `REJECTED`/`INVALIDATED` proof.
- Duplicate attempt idempotency; duplicate intent with changed payload and reused attempt id with changed intent both fail `ID_REUSE`.
- Revoked device token fails with `TOKEN_INVALID` while the same workspace remains readable/writable by the other authenticated user; separate writer queues do not collide.
- Stale generation fencing for `refresh`, `document`, `recover`, `invalidate`, `archive`; unauthorized IPC sender rejection; post-disconnect navigation rejection.
- Narrow `editorTextIntent`: plain text replacement, surrogate-pair/emoji replacement, rejection of marks, multi-block edits, and structural changes; rejected draft remains in `recover`.
- Remembered connection uses an injected async credential adapter (test-local XOR transform) to seal/open a token; `connections` and `resume` complete through the normal service path.

## Implemented test-local APIs

- `FaultProvider implements SharedProvider`, delegating to a real `HttpSharedProvider`; failure modes are before any submit or after the real server submit.
- `FakeAsyncSafeStorage` implements only the injected credential adapter shape. It is test instrumentation, not an OS credential-store claim.

## Integration points

- `src/collaboration/runtime/authority.ts`
- `src/collaboration/runtime/http-server.ts`
- `src/collaboration/runtime/http-provider.ts`
- `src/collaboration/runtime/client.ts`
- `src/collaboration/runtime/editor-intent.ts`
- `src/main/shared-runtime-service.ts`
- `src/platform/credential-provider.ts`
- `src/shared/shared-runtime-ipc.ts`

## Unverified / limitations

- Tests were authored but not executed here; parent must run `npm run check` and `npm test`. Execution status: `NOT_RUN`.
- No GUI, browser, Electron, native dialog, clipboard, actual Keychain, network beyond loopback, or real user data was used.
- Credential persistence tests use a non-OS fake adapter; they do not verify Keychain/DPAPI/libsecret behavior.
- No confirmed source defects were found during test authoring.
