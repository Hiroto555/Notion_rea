import type { DatabaseSync } from "node:sqlite";
import { exportBackup, restoreBackup, type RuntimeBackup } from "./backup";
import { canonical } from "./canonical";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  safeCounter,
  sameScope,
  scopeKey,
  wellFormed,
  type Cut,
  type DocumentState,
  type Scope,
  type TableMetadata,
} from "./contract";
import { digest } from "./digest";
import type { StoragePort } from "./storage-port";

const EVENTS = "authority.events";
const PREFIX = "authority.prefix";
const ATTEMPTS = "authority.attempts";
const INTENTS = "authority.intents";
const QUEUE = "client.queue";
const DEVICES = "identity.devices";
const SESSIONS = "identity.sessions";
const HEAD_NAMESPACE = "meta";
const HEAD_KEY = "head";
export const RETENTION_CHECKPOINT_NAMESPACE = "authority.checkpoint";
export const RETENTION_CHECKPOINT_KEY = "current";
const ARCHIVE_EVENTS = "authority.archive.events";

const MAX_EVENTS = 100_000;
const MAX_SCOPES = 10_000;
const MAX_FENCES = 100_000;
const MAX_QUEUE_ENTRIES = 100_000;
const MAX_EVENT_BYTES = 8_000_000;
const MAX_STATE_BYTES = 2_000_000;
const MAX_CHECKPOINT_BYTES = 4_000_000;

export type RetentionInspection = Readonly<{
  eventRows: number;
  attemptRows: number;
  intentRows: number;
  queueEntries: number;
  unknownAttempts: number;
  bytes: number;
}>;

export type RetentionCheckpointScope = Readonly<{
  scope: Scope;
  state: DocumentState;
}>;

export type RetentionCheckpoint = Readonly<{
  v: 1;
  hash: string;
  body: Readonly<{
    v: 1;
    kind: "json";
    cut: Cut;
    previous: Readonly<{ hash: string; cut: Cut }> | null;
    scopes: RetentionCheckpointScope[];
    archive: Readonly<{
      backupHash: string;
      removed: number;
      eventDigest: string;
      fromSeq: number;
      throughSeq: number;
    }>;
    authorityStateHash: string | null;
    writerFences: string[];
  }>;
}>;

export type BackupVerification = Readonly<{
  v: 1;
  backupHash: string;
  cut: Cut;
  restoreEpoch: string;
  restoreCut: Cut;
}>;

export type CompactResult = Readonly<{
  removed: number;
  checkpointHash: string;
  cut: Cut;
}>;

type IssuedProof = Readonly<{
  cut: Cut;
  snapshotHash: string;
}>;

type ParsedEvent = Readonly<{
  key: string;
  seq: number;
  epoch: string;
  previousHash: string;
  hash: string;
  scope: Scope;
  writerId: string;
  state: DocumentState | null;
  authorityStateHash: string | null;
}>;

type QueueUnknown = Readonly<{ attemptId: string; base: Cut }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, code: string): Record<string, unknown> {
  demand(isRecord(value), code);
  return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;
}

function array(value: unknown, code: string): unknown[] {
  demand(Array.isArray(value), code);
  return value as unknown[];
}

function hashText(value: unknown, code: string): string {
  demand(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), code);
  return value as string;
}

function validateCut(value: unknown, code = "INVALID_CUT"): Cut {
  const entry = record(value, code);
  return {
    epoch: identifier(field(entry, "epoch")),
    seq: safeCounter(field(entry, "seq")),
    hash: hashText(field(entry, "hash"), code),
  };
}

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function parseScope(value: unknown, code = "INVALID_SCOPE"): Scope {
  const entry = record(value, code);
  return {
    orgId: identifier(field(entry, "orgId")),
    workspaceId: identifier(field(entry, "workspaceId")),
    documentId: identifier(field(entry, "documentId")),
    incarnationId: identifier(field(entry, "incarnationId")),
  };
}

function parseTableMetadata(value: unknown, code: string): TableMetadata {
  const entry = record(value, code);
  return {
    tableId: identifier(field(entry, "tableId")),
    rowIds: array(field(entry, "rowIds"), code).map((row) => identifier(row)),
    columnIds: array(field(entry, "columnIds"), code).map((column) =>
      identifier(column),
    ),
  };
}

function parseState(
  value: unknown,
  maxBytes: number,
  code: string,
): DocumentState {
  safeCanonical(value, maxBytes, code);
  const entry = record(value, code);
  const document = field(entry, "document");
  demand(isRecord(document) && typeof document.type === "string", code);
  const tables = array(field(entry, "tables"), code).map((table) =>
    parseTableMetadata(table, code),
  );
  const tombstones = array(field(entry, "tombstones"), code).map((item) =>
    identifier(item),
  );
  return {
    document: document as unknown as DocumentState["document"],
    tables,
    tombstones,
  };
}

function safeCanonical(value: unknown, maxBytes: number, code: string): string {
  try {
    return canonical(value, maxBytes);
  } catch (error) {
    if (error instanceof CollaborationError && error.code === "JSON_LIMIT")
      throw new CollaborationError(code);
    throw error;
  }
}

function padSeq(seq: number): string {
  return String(seq).padStart(16, "0");
}

function computeEventHash(input: {
  seq: number;
  epoch: string;
  previousHash: string;
  scope: Scope;
  intentId: string;
  attemptId: string;
  writerId: string;
  command: Record<string, unknown>;
  appliedText: Record<string, unknown> | null;
  appliedBefore?: DocumentState;
  state: DocumentState | null;
  status: string;
  code: string | null;
  resultHash: string;
  intentHash?: string;
  attemptHash?: string;
  authorityStateHash?: string | null;
}): string {
  const body: Record<string, unknown> = {
    seq: input.seq,
    epoch: input.epoch,
    previousHash: input.previousHash,
    scope: input.scope,
    intentId: input.intentId,
    attemptId: input.attemptId,
    writerId: input.writerId,
    command: input.command,
    appliedText: input.appliedText,
    state: input.state,
    status: input.status,
    code: input.code,
    resultHash: input.resultHash,
  };
  if (input.appliedBefore !== undefined) body.appliedBefore = input.appliedBefore;
  if (input.intentHash !== undefined) body.intentHash = input.intentHash;
  if (input.attemptHash !== undefined) body.attemptHash = input.attemptHash;
  if (
    input.authorityStateHash !== undefined &&
    input.authorityStateHash !== null
  )
    body.authorityStateHash = input.authorityStateHash;
  return digest(body);
}

function parseEvent(key: string, value: unknown): ParsedEvent {
  safeCanonical(value, MAX_EVENT_BYTES, "EVENT_LIMIT");
  const entry = record(value, "EVENT_DRIFT");
  const seq = safeCounter(field(entry, "seq"));
  demand(key === padSeq(seq), "EVENT_DRIFT");
  const epoch = identifier(field(entry, "epoch"));
  const previousHash = hashText(field(entry, "previousHash"), "EVENT_DRIFT");
  const hash = hashText(field(entry, "hash"), "EVENT_DRIFT");
  const authorityStateHashRaw = field(entry, "authorityStateHash");
  const authorityStateHash =
    authorityStateHashRaw === undefined || authorityStateHashRaw === null
      ? null
      : hashText(authorityStateHashRaw, "EVENT_DRIFT");
  const scope = parseScope(field(entry, "scope"), "EVENT_DRIFT");
  const intentId = identifier(field(entry, "intentId"));
  const attemptId = identifier(field(entry, "attemptId"));
  const writerId = identifier(field(entry, "writerId"));
  const command = record(field(entry, "command"), "EVENT_DRIFT");
  demand(typeof field(command, "kind") === "string", "EVENT_DRIFT");
  const appliedRaw = field(entry, "appliedText");
  const appliedText =
    appliedRaw === null ? null : record(appliedRaw, "EVENT_DRIFT");
  const stateRaw = field(entry, "state");
  const state =
    stateRaw === null
      ? null
      : parseState(stateRaw, MAX_STATE_BYTES, "EVENT_DRIFT");
  const receiptRaw = record(field(entry, "receipt"), "EVENT_DRIFT");
  const statusValue = field(receiptRaw, "status");
  demand(
    statusValue === "SERVER_ACCEPTED" ||
      statusValue === "REJECTED" ||
      statusValue === "INVALIDATED",
    "EVENT_DRIFT",
  );
  const status = statusValue as "SERVER_ACCEPTED" | "REJECTED" | "INVALIDATED";
  const codeValue = field(receiptRaw, "code");
  demand(
    codeValue === null ||
      (typeof codeValue === "string" && wellFormed(codeValue)),
    "EVENT_DRIFT",
  );
  const code = codeValue as string | null;
  const resultHash = hashText(field(receiptRaw, "resultHash"), "EVENT_DRIFT");
  const intentHash = hashText(field(receiptRaw, "intentHash"), "EVENT_DRIFT");
  const attemptHash = hashText(field(receiptRaw, "attemptHash"), "EVENT_DRIFT");
  const receiptScope = parseScope(field(receiptRaw, "scope"), "EVENT_DRIFT");
  demand(sameScope(receiptScope, scope), "EVENT_DRIFT");
  demand(identifier(field(receiptRaw, "intentId")) === intentId, "EVENT_DRIFT");
  demand(
    identifier(field(receiptRaw, "attemptId")) === attemptId,
    "EVENT_DRIFT",
  );
  demand(identifier(field(receiptRaw, "writerId")) === writerId, "EVENT_DRIFT");
  const receiptCut = validateCut(field(receiptRaw, "cut"), "EVENT_DRIFT");
  demand(
    receiptCut.epoch === epoch &&
      receiptCut.seq === seq &&
      receiptCut.hash === hash,
    "EVENT_DRIFT",
  );
  const appliedBefore = field(entry, "appliedBefore") === undefined ? undefined : parseState(field(entry, "appliedBefore"), MAX_STATE_BYTES, "EVENT_DRIFT");
  const hashInput = {
    ...(appliedBefore === undefined ? {} : {appliedBefore}),
    seq,
    epoch,
    previousHash,
    scope,
    intentId,
    attemptId,
    writerId,
    command,
    appliedText,
    state,
    status,
    code,
    resultHash,
    authorityStateHash,
  };
  const expected = computeEventHash({ ...hashInput, intentHash, attemptHash });
  const legacy = computeEventHash(hashInput);
  demand(
    (authorityStateHash === null ? legacy : expected) === hash,
    "EVENT_DRIFT",
  );
  return {
    key,
    seq,
    epoch,
    previousHash,
    hash,
    scope,
    writerId,
    state,
    authorityStateHash,
  };
}

function readEvents(store: StoragePort): ParsedEvent[] {
  const entries = store.all(EVENTS);
  demand(entries.length <= MAX_EVENTS, "RESOURCE_LIMIT");
  return entries.map((entry) => parseEvent(entry.key, entry.value));
}

function chainedEvents(
  store: StoragePort,
  epoch: string,
  base: Cut,
): ParsedEvent[] {
  const events = readEvents(store)
    .filter((event) => event.epoch === epoch)
    .sort((left, right) => left.seq - right.seq);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const previous = index === 0 ? base : events[index - 1];
    demand(event.seq === previous.seq + 1, "EVENT_CHAIN_DRIFT");
    demand(event.previousHash === previous.hash, "EVENT_CHAIN_DRIFT");
  }
  return events;
}

function parseCheckpoint(value: unknown): RetentionCheckpoint {
  safeCanonical(value, MAX_CHECKPOINT_BYTES, "CHECKPOINT_LIMIT");
  const entry = record(value, "CHECKPOINT_DRIFT");
  demand(field(entry, "v") === 1, "CHECKPOINT_DRIFT");
  const hash = hashText(field(entry, "hash"), "CHECKPOINT_DRIFT");
  const body = record(field(entry, "body"), "CHECKPOINT_DRIFT");
  demand(digest(body) === hash, "CHECKPOINT_DRIFT");
  demand(
    field(body, "v") === 1 && field(body, "kind") === "json",
    "CHECKPOINT_DRIFT",
  );
  const cut = validateCut(field(body, "cut"), "CHECKPOINT_DRIFT");
  const previousRaw = field(body, "previous");
  let previous: Readonly<{ hash: string; cut: Cut }> | null = null;
  if (previousRaw !== null) {
    const previousEntry = record(previousRaw, "CHECKPOINT_DRIFT");
    previous = {
      hash: hashText(field(previousEntry, "hash"), "CHECKPOINT_DRIFT"),
      cut: validateCut(field(previousEntry, "cut"), "CHECKPOINT_DRIFT"),
    };
  }
  const scopes = array(field(body, "scopes"), "CHECKPOINT_DRIFT").map(
    (item) => {
      const scopeEntry = record(item, "CHECKPOINT_DRIFT");
      return {
        scope: parseScope(field(scopeEntry, "scope"), "CHECKPOINT_DRIFT"),
        state: parseState(
          field(scopeEntry, "state"),
          MAX_STATE_BYTES,
          "CHECKPOINT_DRIFT",
        ),
      };
    },
  );
  demand(scopes.length <= MAX_SCOPES, "CHECKPOINT_LIMIT");
  const archive = record(field(body, "archive"), "CHECKPOINT_DRIFT");
  const fences = array(field(body, "writerFences"), "CHECKPOINT_DRIFT").map(
    (id) => identifier(id),
  );
  demand(fences.length <= MAX_FENCES, "CHECKPOINT_LIMIT");
  const authorityStateHashRaw = field(body, "authorityStateHash");
  const authorityStateHash =
    authorityStateHashRaw === undefined || authorityStateHashRaw === null
      ? null
      : hashText(authorityStateHashRaw, "CHECKPOINT_DRIFT");
  return {
    v: 1,
    hash,
    body: {
      v: 1,
      kind: "json",
      cut,
      previous,
      scopes,
      archive: {
        backupHash: hashText(field(archive, "backupHash"), "CHECKPOINT_DRIFT"),
        removed: safeCounter(field(archive, "removed")),
        eventDigest: hashText(
          field(archive, "eventDigest"),
          "CHECKPOINT_DRIFT",
        ),
        fromSeq: safeCounter(field(archive, "fromSeq")),
        throughSeq: safeCounter(field(archive, "throughSeq")),
      },
      authorityStateHash,
      writerFences: fences,
    },
  };
}

export function readRetentionCheckpoint(
  store: StoragePort,
): RetentionCheckpoint | null {
  const value = store.get(
    RETENTION_CHECKPOINT_NAMESPACE,
    RETENTION_CHECKPOINT_KEY,
  );
  return value === null ? null : parseCheckpoint(value);
}

function assertWriterFenced(store: StoragePort, writerId: string): void {
  const devices = store.all(DEVICES);
  let known = false;
  for (const entry of devices) {
    const value = record(entry.value, "STORAGE_DRIFT");
    const status = field(value, "status");
    demand(status === "active" || status === "revoked", "STORAGE_DRIFT");
    if (identifier(field(value, "writerId")) !== writerId) continue;
    known = true;
    demand(status === "revoked", "WRITER_NOT_FENCED");
  }
  demand(known, "WRITER_NOT_FENCED");
  for (const entry of store.all(SESSIONS)) {
    const value = record(entry.value, "STORAGE_DRIFT");
    const status = field(value, "status");
    demand(status === "active" || status === "revoked", "STORAGE_DRIFT");
    if (identifier(field(value, "writerId")) !== writerId) continue;
    demand(status === "revoked", "WRITER_NOT_FENCED");
  }
}

function readQueueUnknowns(store: StoragePort): QueueUnknown[] {
  const entries = store.all(QUEUE);
  demand(entries.length <= MAX_QUEUE_ENTRIES, "QUEUE_LIMIT");
  const found: QueueUnknown[] = [];
  const states = new Set([
    "PREPARED",
    "UNKNOWN",
    "REJECTED",
    "INVALIDATED",
    "ACCEPTED",
  ]);
  for (const entry of entries) {
    const value = record(entry.value, "CLIENT_QUEUE_DRIFT");
    demand(field(value, "v") === 1, "CLIENT_QUEUE_DRIFT");
    const attempts = array(field(value, "attempts"), "CLIENT_QUEUE_DRIFT");
    for (const item of attempts) {
      const attemptEntry = record(item, "CLIENT_QUEUE_DRIFT");
      const state = field(attemptEntry, "state");
      demand(
        typeof state === "string" && states.has(state),
        "CLIENT_QUEUE_DRIFT",
      );
      const attempt = record(
        field(attemptEntry, "attempt"),
        "CLIENT_QUEUE_DRIFT",
      );
      const base = validateCut(field(attempt, "base"), "CLIENT_QUEUE_DRIFT");
      if (state !== "UNKNOWN") continue;
      found.push({
        attemptId: identifier(field(attempt, "attemptId")),
        base,
      });
    }
  }
  return found;
}

function numberField(row: unknown, key: string): number {
  const entry = record(row, "STORAGE_DRIFT");
  const raw = field(entry, key);
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  demand(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "STORAGE_DRIFT",
  );
  return value;
}

function databaseBytes(db: DatabaseSync): number {
  const pages = numberField(
    db.prepare("PRAGMA page_count").get(),
    "page_count",
  );
  const size = numberField(db.prepare("PRAGMA page_size").get(), "page_size");
  return pages * size;
}

export class RetentionService {
  private readonly issued = new WeakMap<object, IssuedProof>();

  constructor(private readonly store: StoragePort) {}

  inspect(): RetentionInspection {
    return {
      eventRows: this.store.all(EVENTS).length,
      attemptRows: this.store.all(ATTEMPTS).length,
      intentRows: this.store.all(INTENTS).length,
      queueEntries: this.store.all(QUEUE).length,
      unknownAttempts: readQueueUnknowns(this.store).length,
      bytes: databaseBytes(this.store.db),
    };
  }

  verifyBackup(
    cutInput: Cut,
    destination: StoragePort,
    newEpoch: string,
    artifact?: RuntimeBackup,
  ): BackupVerification {
    const cut = validateCut(cutInput);
    const epoch = identifier(newEpoch);
    return this.store.transaction(() => {
      const snapshot = artifact ?? exportBackup(this.store);
      demand(sameCut(validateCut(snapshot.head), cut), "STALE_CUT");
      if (artifact) {
        const head = validateCut(this.store.get("meta", "head"));
        const prefix = this.store.get(PREFIX, cut.epoch + ":" + cut.seq);
        demand(cut.epoch === head.epoch && cut.seq <= head.seq && prefix && sameCut(validateCut(prefix), cut), "BACKUP_PREFIX_MISMATCH");
      }
      const restored = restoreBackup(snapshot, destination, epoch);
      demand(sameCut(restored.oldCut, cut), "STALE_CUT");
      demand(restored.hash === snapshot.hash, "BACKUP_HASH_MISMATCH");
      const head = validateCut(
        destination.get(HEAD_NAMESPACE, HEAD_KEY),
        "RESTORE_MISMATCH",
      );
      demand(sameCut(head, restored.newCut), "RESTORE_MISMATCH");
      const recordValue = record(
        destination.get(HEAD_NAMESPACE, "restore"),
        "RESTORE_MISMATCH",
      );
      demand(
        field(recordValue, "backupHash") === snapshot.hash,
        "RESTORE_MISMATCH",
      );
      demand(
        sameCut(
          validateCut(field(recordValue, "originalCut"), "RESTORE_MISMATCH"),
          cut,
        ),
        "RESTORE_MISMATCH",
      );
      demand(field(recordValue, "epoch") === epoch, "RESTORE_MISMATCH");
      demand(
        field(recordValue, "requiresReauthorization") === true,
        "RESTORE_MISMATCH",
      );
      const verification: BackupVerification = {
        v: 1,
        backupHash: snapshot.hash,
        cut: { ...cut },
        restoreEpoch: epoch,
        restoreCut: { ...restored.newCut },
      };
      Object.freeze(verification);
      this.issued.set(
        verification,
        Object.freeze({
          cut: Object.freeze({ ...cut }),
          snapshotHash: snapshot.hash,
        }),
      );
      return verification;
    });
  }

  compact(cutInput: Cut, verification: BackupVerification): CompactResult {
    const cut = validateCut(cutInput);
    return this.store.transaction(() => {
      const issued =
        typeof verification === "object" && verification !== null
          ? this.issued.get(verification)
          : undefined;
      if (issued === undefined)
        throw new CollaborationError("BACKUP_NOT_VERIFIED");
      demand(sameCut(issued.cut, cut), "BACKUP_NOT_VERIFIED");

      const head = validateCut(
        this.store.get(HEAD_NAMESPACE, HEAD_KEY),
        "HEAD_MISSING",
      );
      demand(head.epoch === cut.epoch, "STALE_EPOCH");
      demand(cut.seq <= head.seq, "STALE_CUT");

      const checkpoint = readRetentionCheckpoint(this.store);
      const active =
        checkpoint !== null && checkpoint.body.cut.epoch === head.epoch
          ? checkpoint
          : null;
      let base: Cut;
      if (active) {
        base = active.body.cut;
        demand(base.seq <= cut.seq, "STALE_CUT");
        const proofRow = this.store.get(PREFIX, `${base.epoch}:${base.seq}`);
        demand(proofRow !== null, "PREFIX_PROOF_MISSING");
        demand(
          sameCut(validateCut(proofRow, "PREFIX_PROOF_MISSING"), base),
          "PREFIX_PROOF_MISSING",
        );
        if (active.body.previous !== null) {
          const prior = active.body.previous.cut;
          const priorProof = this.store.get(
            PREFIX,
            `${prior.epoch}:${prior.seq}`,
          );
          demand(priorProof !== null, "CHECKPOINT_DRIFT");
          demand(
            sameCut(validateCut(priorProof, "CHECKPOINT_DRIFT"), prior),
            "CHECKPOINT_DRIFT",
          );
        }
      } else {
        const proofRow = this.store.get(PREFIX, `${head.epoch}:0`);
        demand(proofRow !== null, "PREFIX_PROOF_MISSING");
        const genesis = validateCut(proofRow, "PREFIX_PROOF_MISSING");
        demand(
          genesis.epoch === head.epoch && genesis.seq === 0,
          "PREFIX_PROOF_MISSING",
        );
        base = genesis;
      }

      const events = chainedEvents(this.store, head.epoch, base);
      const prefix = events.filter((event) => event.seq <= cut.seq);
      const suffix = events.filter((event) => event.seq > cut.seq);
      demand(prefix.length > 0, "NO_CHANGES");
      const boundary = prefix[prefix.length - 1]!;
      demand(
        boundary.seq === cut.seq && boundary.hash === cut.hash,
        "EVENT_CHAIN_DRIFT",
      );
      if (suffix.length > 0) {
        const last = suffix[suffix.length - 1]!;
        demand(
          last.seq === head.seq && last.hash === head.hash,
          "EVENT_CHAIN_DRIFT",
        );
      } else {
        demand(
          boundary.seq === head.seq && boundary.hash === head.hash,
          "EVENT_CHAIN_DRIFT",
        );
      }

      const writers = [
        ...new Set(prefix.map((event) => event.writerId)),
      ].sort();
      for (const writer of writers) assertWriterFenced(this.store, writer);
      for (const fenced of active?.body.writerFences ?? [])
        assertWriterFenced(this.store, fenced);

      for (const unknown of readQueueUnknowns(this.store)) {
        if (unknown.base.epoch === head.epoch && unknown.base.seq < cut.seq)
          throw new CollaborationError("UNRESOLVED_UNKNOWN_ATTEMPT");
      }

      const scopes = new Map<string, RetentionCheckpointScope>();
      for (const entry of active?.body.scopes ?? [])
        scopes.set(scopeKey(entry.scope), {
          scope: entry.scope,
          state: clone(entry.state),
        });
      for (const event of prefix) {
        if (event.state === null) continue;
        const key = scopeKey(event.scope);
        if (!scopes.has(key))
          demand(scopes.size < MAX_SCOPES, "CHECKPOINT_LIMIT");
        scopes.set(key, { scope: event.scope, state: clone(event.state) });
      }
      const ordered = [...scopes.values()].sort((left, right) =>
        scopeKey(left.scope).localeCompare(scopeKey(right.scope)),
      );

      const fences = [
        ...new Set([...(active?.body.writerFences ?? []), ...writers]),
      ].sort();
      demand(fences.length <= MAX_FENCES, "CHECKPOINT_LIMIT");

      const fromSeq = base.seq + 1;
      const throughSeq = cut.seq;
      const archiveDigest = digest({
        epoch: cut.epoch,
        fromSeq,
        throughSeq,
        events: prefix.map((event) => ({ key: event.key, hash: event.hash })),
      });
      const body: RetentionCheckpoint["body"] = {
        v: 1,
        kind: "json",
        cut: { ...cut },
        previous: active
          ? { hash: active.hash, cut: clone(active.body.cut) }
          : null,
        scopes: ordered,
        archive: {
          backupHash: issued.snapshotHash,
          removed: prefix.length,
          eventDigest: archiveDigest,
          fromSeq,
          throughSeq,
        },
        authorityStateHash:
          boundary.authorityStateHash ??
          active?.body.authorityStateHash ??
          null,
        writerFences: fences,
      };
      const stored: RetentionCheckpoint = { v: 1, hash: digest(body), body };
      safeCanonical(stored, MAX_CHECKPOINT_BYTES, "CHECKPOINT_LIMIT");

      this.store.set(
        RETENTION_CHECKPOINT_NAMESPACE,
        RETENTION_CHECKPOINT_KEY,
        stored,
      );
      for (const event of prefix) {
        const value = this.store.get(EVENTS, event.key);
        if (value !== null)
          this.store.set(ARCHIVE_EVENTS, event.epoch + ":" + event.key, value);
        this.store.set(EVENTS, event.key, null);
      }
      return {
        removed: prefix.length,
        checkpointHash: stored.hash,
        cut: { ...cut },
      };
    });
  }
}
