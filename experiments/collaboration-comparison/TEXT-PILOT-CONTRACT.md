# C text-only main-connection prototype contract v2

This isolated Node experiment connects the main preparation service to a bounded
ProseMirror text lane. It does not register Electron IPC, activate the ordinary
editor, provide production authentication, or establish full Lv5 adoption.

## Identity and wire contract

Scope is `{workspaceId, documentId, incarnationId}`. Identifiers, including epoch,
are strings matching the main preparation contract: `[A-Za-z0-9_-]{1,128}`.
The client session also carries `sessionId`, `actorId`, `deviceId` and a safe,
nonnegative integer `generation`. The eventual host must derive trusted identity;
the authority's actor argument and constructor allowlist are test fixtures.

`TextAuthority(file, {scope, epoch, document, actors})` exposes
`submit(actorId, envelope, hooks)`, `snapshot(actorId)`,
`receipt(actorId, operationId)` and `close()`.

An envelope has exactly `{operationId, deviceId, scope, epoch, baseVersion, steps}`.
The actor is supplied separately. An accepted receipt has exactly
`{status: 'SERVER_ACCEPTED', operationId, fingerprint, epoch, scope, version,
steps, clientID: deviceId}`. Fingerprint is
`SHA256(canonicalJson({actorId, envelope}))`; there is one accepted format.
Version counts accepted steps. Duplicate identity and payload return the identical
receipt; conflicting reuse, wrong scope/epoch and stale baseVersion are refused.

A snapshot contains `{scope, epoch, seed, document, version, steps, clientIDs}`.
It includes the complete bounded step log and one device ID per step. Clients
verify identity, immutable seed, replayed document and the already known log prefix.

## Supported edits and limits

Only `replace` steps with keys `stepType/from/to/slice` are admitted. Both positions
must be safe integers in the same existing textblock and outside surrogate pairs.
A slice may contain only `content/openStart/openEnd`; opens must be zero when
present. Missing or empty content represents deletion. Inserted nodes have exactly
`type: 'text'` and nonempty, well-formed `text`. Supplied marks, including empty
marks arrays, are unsupported. Existing marks outside replaced text remain intact.

The ordered non-text node type/attribute/ID signature must remain unchanged.
Moves, split/join, table-shape, block/attribute/mark changes and unknown fields are
refused. Full rich documents remain valid, including their IDs and root metadata.
Shared document input uses the main parser's conservative integer-only JSON subset.

Limits are 32 steps per envelope, 256 total accepted steps, 1 MiB canonical
envelope, and 2,000,000 UTF-8 bytes per document. Serialized log/head/operation
rows and each delivered snapshot are separately limited to 8,000,000 bytes. The
immutable seed metadata is separate from the row budget. No physical SQLite file
size or compaction guarantee is inferred from these logical limits.

## Durability and client behavior

SQLite application_id is `0x464c5450`, user_version is 1002. A single
`BEGIN IMMEDIATE` transaction commits step log, derived head and receipt with
`synchronous=FULL`. Reopen verifies metadata, exact schema, log replay, receipt
coverage and canonical receipt fields. Private/foreign files are refused before
journal/schema writes. Prototype format migration is not provided.

`beforeCommit` and `afterCommit` are synchronous fault-injection hooks. The former
rolls back on failure. The latter reports UNKNOWN after the receipt is committed.
Dedicated Node SIGKILL tests cover both boundaries; they do not prove power-loss
behavior.

`TextClient({session, snapshot, stage})` exposes `state()`, `document()`,
`insert(text, pos)`, `flush(authority, hooks)`, `receive(snapshot)`, `undo()`,
`redo()`, `pending()` and `close()`. It uses one collab/history stack and the actual
rich-structure guard. Remote changes do not become new local history or drafts.

Before applying local input, the synchronous `stage(raw)` callback retains a
`{kind: 'LOCAL_INTENT', operationId, session, baseVersion, steps, beforeDocument}`
record. Before submitting a wire attempt, it retains that exact envelope's bytes
under a separate operation ID. These are raw history/quarantine records, not an
accepted outbox. No automatic replay is performed.

Uncertain outcomes retain the original wire operation as UNKNOWN. A later flush
queries its receipt first and checks exact identity/fingerprint/steps/version.
An absent receipt blocks resend, new IDs and new edits. Definite-rejection recovery
is also deliberately unsupported. A rebase that drops unconfirmed steps is refused
while the previous state and raw intent remain available.

Automatic client-state reconstruction after restart, durable intent/receipt
mapping and pruning, production roles/revocation, provider networking, compaction,
ordinary editor integration, GUI/IME and physical multi-Mac acceptance remain
unimplemented or NOT_RUN. This contract does not certify V07-V09 completion.
