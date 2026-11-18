# R12 frontend/main independent review

## Owned outputs

- `tests/shared-runtime-main-fence.test.ts` (new, 6 tests)
- `REPORT.md` (this file)

No source, contract, helper, config or workflow file was edited. No shell, git, network
call, GUI/browser/Electron launch, clipboard, native dialog, delegation or real data was
used. Tests were written but **NOT RUN** by this worker; the parent must execute them.

## Actual API surface reviewed/used

- IPC service: `SharedRuntimeService.handle` — `connect|join|resume|list|connections|open|refresh|draft|document|undo|redo|reconcile|recover|invalidate|archive|disconnect|admin`
  (`src/main/shared-runtime-service.ts:33-57`). Sender callback is checked before the
  await (`:34`) and again after the switch (`:55`). Single-flight `busy` (`:34-35,56`).
- Generation fence (`src/main/shared-runtime-service.ts:19`), open replacement (`:45`),
  document base fence + raw/draft retention (`:48`).
- Main IPC sender-frame guard: `src/main/index.ts:279-283` requires the same window,
  same `webContents`, `mainFrame`, and exact `senderFrame.url`.
- Preload: only `shared.request` invokes `folio:shared`; no token getter or private save
  API is exposed there (`src/preload/index.ts:5`).
- Durable client: pre-send `markUnknown` fence, receipt confirmation, snapshot proof,
  reconcile, generation-independent queue (`src/collaboration/runtime/client.ts:40-66`).
- HTTP authority: `POST` only, canonical wire, bearer token, origin/cookie rejection,
  strict operation schemas, bounded bodies (`src/collaboration/runtime/http-server.ts:208-285`).
- Plaintext seam: `editorTextIntent` accepts one plain textblock change and refuses
  structure/multi-block (`src/collaboration/runtime/editor-intent.ts:8-27`).

## Integration points required by tests

- Real `SharedAuthority` in a private `mkdtemp` root with a valid block-id document.
- Real loopback `createSharedHttpServer(authority)` + `HttpSharedProvider` clients.
- `SharedRuntimeService` rooted in a separate temporary directory. Optional credentials
  remain undefined, so `remember`/`resume` are not exercised.
- Cleanup closes service, HTTP server, authority/client stores, then removes temp roots.

## Tests written (parent runs)

1. Sender revoked before and after the awaited `refresh`: both reject
   `UNAUTHORIZED_IPC_SENDER`; the after-await callback is proven to be called twice.
   Also stale generation rejects `STALE_SHARED_SESSION`, and the connect response does
   not contain the bearer token.
2. Stale-generation then stale-base `document` both reject; `recover` still contains the
   exact raw draft and quarantined document; the next legal plaintext submission is
   accepted and the editing raw row is cleared.
3. Authority and client stores with **identical scope ids** are role-separated:
   authority dir as client rejects `WRONG_STORE_ROLE`, client dir as authority rejects
   `WRONG_STORE_ROLE`.
4. A provider that commits then loses the acknowledgement leaves one `UNKNOWN` attempt;
   `reconcile` confirms the same attempt as `CLIENT_RECEIPT_DURABLE`/`SERVER_ACCEPTED`
   with no retry and the server state applied.
5. `editorTextIntent` accepts the one-block text edit, returns null for no change, and
   refuses heading structure and two changed textblocks.
6. HTTP authority rejects Origin (403), Cookie (400), GET (405), query (400), missing
   bearer token (401), and accepts the canonical authenticated snapshot request.

## Verified vs static vs gaps

`verified-by-written-test` above means: the assertions exist and exercise real Node
runtime code. They are not PASS until the parent runs vitest.

Static review only (no GUI/browser/Electron):

- R14 IME: during composition `change` writes only `draft` and never `document`
  (`src/renderer/shared/SharedWorkbench.tsx:16-19`). Composition end defers with a
  generation ticket (`:21`). This part matches “local draft until composition settles”.
- R13 navigation/private collision: `SharedWorkbench` is a fixed overlay rendered beside
  the still-mounted private app (`src/renderer/App.tsx:1622`,
  `src/renderer/shared/shared-workbench.css:1`). No private save API is passed to the
  shared editor, so data paths are separate. Static concern: there is no focus move,
  inert background, `aria-modal`, or focus trap, so keyboard focus can remain in the
  private editor behind the overlay. NOT GUI-verified.
- No hidden credentials / no autoactivation: connect is explicit; the view carries no
  token (`src/main/shared-runtime-service.ts:20-25`); sealing happens only with explicit
  `remember` (`:26-31`); resume uses the encrypted cache (`:40-43`). `admin` passes the
  parsed command through (`:37`) and assets remain at `authority.ts:140,150-151`; these
  frozen protocol seams were not modified.

Real code gaps (not fixed; owned source is out of scope):

1. Remote revision can still reset an active composition. `Editor` applies
   `setContent(doc)` on every `shared.revision` change without checking composition
   (`src/editor/Editor.tsx:278`), while `SharedWorkbench` accepts any resolved session
   (`SharedWorkbench.tsx:14`) and may pass a newer snapshot as `doc` (`:33`). A refresh
   or open promise started before `compositionstart` and resolved during composition can
   replace the IME document. Static concern; not reproducible without a DOM test.
2. Draft calls during composition are not serialized. Each IME `onUpdate` awaits
   `api.request({type:'draft'})` (`SharedWorkbench.tsx:17`) without an in-flight guard;
   the service is single-flight and rejects concurrent calls with `SHARED_SERVICE_BUSY`
   (`shared-runtime-service.ts:34`). The resulting error state (`SharedWorkbench.tsx:14`)
   also feeds `editable={... && !error}` (`:33`), so rapid IME updates can transiently
   disable input. Static concern / likely real gap.
3. `SharedWorkbench.request` clears `draft` on every successful request
   (`SharedWorkbench.tsx:14`), but the `list` and `reconcile` buttons are not disabled
   while a refused draft is displayed (`:31-32`). Clicking either can hide a refused
   draft from the editor; the editing and quarantine rows remain in the client store and
   are still recoverable, so this is a UI-state/retention gap, not silent data loss.
4. Overlay focus isolation described above is a real accessibility/keyboard-separation
   concern, though not a shared/private data-store collision.

## Known limitations

- No Electron preload/main frame identity test: `authorized` closure is not importable
  without Electron. Only the service callback contract and HTTP boundary were tested.
- No React/jsdom component test was added; jsdom/testing-library is not installed and
  GUI execution is forbidden here.
- Credential sealing/resume, admin and asset protocols are reviewed statically only.
- GUI/browser/Electron and real Folio data: `NOT_RUN`.
