# R03 Independent Read-Only Review — large-copy transport / staging / maintenance

Status: COMPLETE (read-only audit; no source edits, no test execution; parent runs checks).

Scope: parent snapshot supplied in this worker copy. Files reviewed:
`src/main/shared-copy-transfer.ts`, `src/main/shared-runtime-service.ts`,
`src/collaboration/runtime/copy-staging.ts`, `copy.ts`, `copy-command.ts`,
`maintenance.ts`, `retention.ts`, `assets.ts`, `state-root.ts`, `digest.ts`,
`contract.ts`, `canonical.ts`, `authority.ts`, and the two worker tests.
This copy is a partial snapshot (e.g. `storage-port.ts`, `operations.ts`,
`lifecycle.ts` are referenced but absent), so only the supplied files are asserted.

Confirmed material findings (6). Nothing here is a GUI wish-list item; each has a
minimal non-GUI trigger in the code below.

---

## F1 (High) — large documents >8 MB cannot be copied even though the document limit is 20 MB

`copy.ts` canonicalises rewritten documents with the default `canonical` cap
(8,000,000 bytes) in both preview and commit:

- `src/collaboration/runtime/copy.ts:432` — `raw: canonical(rewritten.document)`
- `src/collaboration/runtime/copy.ts:632` — `const raw = canonical(rewritten.document);`

But the document limit is `MAX_DOCUMENT_BYTES = 20_000_000` (`copy.ts:77`), and
the large-copy path uses `canonical(raw, 32 * 1024 * 1024)`
(`shared-copy-transfer.ts:24`). A document whose canonical form is between
8,000,000 and 20,000,000 bytes throws `JSON_LIMIT` inside `previewSharedCopy`.

Worse, the `copyPreview` fallback (`shared-runtime-service.ts:279-283`) catches
`JSON_LIMIT`, then calls `previewSharedCopy` again, which throws the same error,
so the requested staging path is never reached.

Trigger: any source page with canonical document size 8 MB..20 MB.
Impact: the advertised 20 MB document limit is unreachable for copy.

Fix: pass `MAX_DOCUMENT_BYTES` (or a dedicated >20 MB bound) to
`canonical(rewritten.document)` at `copy.ts:432` and `:632`; keep the fallback
from re-running the already-failed preview.

## F2 (High) — transfer chunking gives a 15 MB ceiling, below the 20 MB document and 32 MB staging limits

`shared-copy-transfer.ts:12` splits at 150,000 bytes and `:30` allows at most
100 parts total: 100 × 150,000 = 15,000,000 bytes. This is below
`MAX_DOCUMENT_BYTES` (20 MB) and far below `MAX_COPY_STAGING_SOURCE_BYTES`
(32 MB, `copy-staging.ts:23`). The 100-part budget is shared across *all*
selected sources, so a multi-page selection totalling >15 MB fails too, while
`normalizeManifest` would accept up to 100 × 500 kB (50 MB) / 32 MB total.

Trigger: one page >15 MB, or e.g. three 6 MB pages selected together →
`COPY_PART_LIMIT` before any part is sent.

Fix: derive the chunk size from `MAX_COPY_STAGING_SOURCE_BYTES /
MAX_COPY_STAGING_PARTS` (~335 kB) instead of a fixed 150 kB, or give each source
its own part budget, and reject over-capacity locally with a precise error.

## F3 (Medium) — copy-preview cache leaks on every failed commit and after reconnect

`shared-runtime-service.ts` caches previews in `this.copies`
(`:275`, `:285-288`). Capacity is `this.copies.size < 4` (`:275`), but the cache
entry is deleted only on the success path (`:369`). Any throw before that —
e.g. `UNAUTHORIZED_IPC_SENDER` at `:347/:349/:352`, `STALE_SHARED_SESSION`,
`COPY_STAGE_FAILED`, `COPY_SOURCE_CHANGED`, network/provider errors — leaves the
entry in place. `connect()` (`:199-259`) also does not clear `this.copies`, so
previews from a previous connection keep occupying the four slots. Only
`close()` clears them (`:724`).

Trigger: four failed `copyCommit` calls (e.g. revoke/shared-session change or a
transient staging failure) in one session → every later `copyPreview` returns
`COPY_PREVIEW_CAPACITY` until disconnect.

Fix: delete the entry in a `finally` around the commit body, and clear
`this.copies` in `connect()`. On failure keep only what is needed for retry.

## F4 (Medium) — payload-path copy ignores the server receipt status, so a rejected copy looks successful

`shared-runtime-service.ts:333-342`:

```
if (selected.payload !== null) {
  result = await this.resources.execute(client.scope, { ...copy.commit... }, cut)
}
```

It never requires `receipt.status === "SERVER_ACCEPTED"`, unlike the staged path
where `execute` enforces it (`:351`). `SharedAuthority.submit` converts a
thrown `CollaborationError` (e.g. `COPY_FINGERPRINT_MISMATCH`, `PREVIEW_CHANGED`,
`DESTINATION_EXISTS`, `SOURCE_CHANGED`) into a `REJECTED` receipt and returns it
instead of throwing. The service then deletes the preview (`:369`) and returns
the rejected receipt as if the copy completed.

Trigger: preview a small copy, change a source page (or create the destination)
before commit; `applyCopyPayload` throws, authority returns `REJECTED`, and the
caller sees no error.

Fix: demand `SERVER_ACCEPTED` for the payload path too (same check as `:351`), or
propagate the receipt code.

## F5 (Medium) — zero-byte assets are valid in the asset store but rejected by the staging manifest

`copy-staging.ts:205-213` `checkedSize` requires `value > 0`; it is used for
asset sizes at `:351`. However `SharedAssets.stage` accepts zero-length bytes
(`assets.ts:275` only enforces a maximum) and
`shared-copy-transfer.ts:26` emits `size: a.bytes.length`, which is `0` for an
empty asset.

Trigger: a page that references a 0-byte published asset and is large enough to
use the staged path (document >850 kB payload, or any asset that busts the 850 kB
payload budget). `copy.stage.prepare` fails `INVALID_COPY_ASSET`; the small
payload path would have committed it.

Fix: give size validation a minimum parameter — asset sizes `>= 0`, part sizes
`> 0` — and keep the hash/size cross-checks.

## F6 (Medium, maintenance) — committed/prepared `copy.staging` data is never purged and is part of the authoritative root

`SharedCopyStaging` writes immutable manifest, part, and committed records
(`copy-staging.ts:697`, `:748`, `:923`) and nothing in the reviewed code removes
them. `copy.staging` is listed in the authoritative state root
(`state-root.ts:31`), and every `copy.stage.part` is an authority event whose
command payload embeds the full part `raw` (`shared-runtime-service.ts:366` →
`authority.ts:1083`). Effects:

- The full source of a large copy is stored at least twice (staging rows + event
  commands), permanently, even after the copy commits.
- Staged raw JSON keeps its `folio-asset://` references alive, so
  `buildAssetPreview`/GC (`maintenance.ts:280-285`) will retain the source's
  assets forever (conservative, but it defeats reclamation).
- Each `prepare` with a new `copyId` can grow the authoritative root without
  bound; copies are never garbage-collected.

Trigger: perform one large copy, then delete the source page; staged parts and
their asset references remain.

Fix: after a successful commit, delete the manifest/part rows for that copy
inside the same transaction (keep the small `committed` pointer for idempotency),
or exclude staging payloads from the authoritative root and root only a committed
pointer. Avoid embedding full part `raw` in `authority.events` (store the part
hash/size and the staged reference instead).

---

## Audited and found consistent (no finding)

- **Staging scope / user / writer isolation**: keys are bound to
  `binding(scope, writerId) + copyId` (`copy-staging.ts:259-291`); manifest
  records are re-validated against current `AuthContext` and `Scope`
  (`:419-458`); `stagedParts` is scoped by the writer-bound prefix (`:545-563`);
  `SharedAssets.readStaged` verifies the staged hash/size and the authority
  resolve closure additionally checks the `asset.staging.owners`
  `userId`/`deviceId` before reading (`authority.ts:1077-1081`).
- **Fingerprint before copy**: `SharedCopyStaging.commit` re-derives
  `previewSharedCopy` from the decompressed staged sources and demands equality
  with the manifest fingerprint (`copy-staging.ts:893-911`); the main path
  re-derives and compares before dispatch (`shared-runtime-service.ts:321-332`).
- **Atomic publish**: `commitSharedCopy` validates destinations, quota, asset
  hashes and document sizes before writing, and all writes run inside the
  authority transaction (`copy.ts:673-767`); an incomplete staging set fails
  before any destination is published (covered by the worker test).
- **GC retention**: reference scan walks raw JSON strings across all non-asset
  namespaces (`maintenance.ts:188-204`, `:281-285`), so documents, historical
  events, undo/receipt records, checkpoints and staged copy sources keep their
  assets; holds are merged in both preview and `assets.collect`.
- **Plan + proof gates**: collection requires a matching plan hash and cut
  (`maintenance.ts:431-443`); compaction requires a proof issued by the live
  `RetentionService` WeakMap (`retention.ts:545-611`), plus writer fencing and
  unresolved-UNKNOWN checks; `verify` rejects the live store / same path.
- **Re-auth per call**: `preview`/`collect`/`verify`/`compact` re-authenticate
  through `session`/`control` and re-check org-administrator or manage role on
  each invocation (`maintenance.ts:364-427`, `authority.ts:535-541`,
  `:1378-1412`).
- **Late authorization during staged copy**: the per-step `execute` closure
  checks `isAuthorized()` immediately before each head read and before and after
  each dispatch, and `fenceConnection` re-checks generation before every step
  (`shared-runtime-service.ts:344-368`), so a revocation between parts stops
  further dispatch.

## Notes / limits

- Not executed: `npm run check`, `npm test`, `npm run build`, any GUI/E2E. This
  worker had file tools only; all runtime claims above are static.
- F1/F2/F3/F4/F5 are absent from the supplied tests; F6 has no cleanup test.
- `copy` metadata propagation is the parent-known separate concern and is not
  counted as a new finding.
