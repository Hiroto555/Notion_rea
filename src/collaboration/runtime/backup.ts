import { createHash } from "node:crypto";
import { canonical } from "./canonical";
import {
  clone,
  demand,
  identifier,
  safeCounter,
  wellFormed,
  type Cut,
} from "./contract";
import { assertRuntimeStateRoot, createRuntimeGenesis } from "./state-root";
import type { StoragePort } from "./storage-port";

export const BACKUP_FORMAT = "folio-shared-runtime-backup/1" as const;
const ROOTED_GENESIS_FORMAT = "folio.shared.genesis/2";
const ARCHIVE_EVENTS = "authority.archive.events";
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const HASH = /^[a-f0-9]{64}$/;

export type RuntimeBackupRecord = {
  namespace: string;
  key: string;
  value: unknown;
};
export type RuntimeBackupBlob = {
  scope: string;
  hash: string;
  base64: string;
};
export type RuntimeBackup = {
  format: typeof BACKUP_FORMAT;
  head: Cut;
  records: RuntimeBackupRecord[];
  blobs: RuntimeBackupBlob[];
  hash: string;
};
export type RestoreBackupResult = {
  oldCut: Cut;
  newCut: Cut;
  hash: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void {
  demand(Object.getOwnPropertySymbols(value).length === 0, code);
  const names = Object.getOwnPropertyNames(value);
  const actual = [...names].sort();
  const expected = [...keys].sort();
  demand(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    code,
  );
  demand(
    names.every((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return (
        descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable === true
      );
    }),
    code,
  );
}

function text(value: unknown, code: string): string {
  demand(
    typeof value === "string" && value.length > 0 && wellFormed(value),
    code,
  );
  return value;
}

function hashText(value: unknown, code: string): string {
  demand(typeof value === "string" && HASH.test(value), code);
  return value;
}

function parseCut(value: unknown): Cut {
  demand(isPlainObject(value), "INVALID_BACKUP");
  exactKeys(value, ["epoch", "seq", "hash"], "INVALID_BACKUP");
  return {
    epoch: identifier(value.epoch),
    seq: safeCounter(value.seq),
    hash: hashText(value.hash, "INVALID_BACKUP"),
  };
}

function canonicalHash(value: unknown): string {
  return createHash("sha256")
    .update(canonical(value, MAX_BACKUP_BYTES))
    .digest("hex");
}

type RootedEvent = Readonly<{
  seq: number;
  epoch: string;
  previousHash: string;
  authorityStateHash: string;
  receiptCut: Cut;
}>;

type RootedCheckpoint = Readonly<{
  cut: Cut;
  authorityStateHash: string | null;
}>;

function rootedEvent(value: unknown): RootedEvent {
  demand(isPlainObject(value), "EVENT_DRIFT");
  const entry = value as Record<string, unknown>;
  const seq = safeCounter(entry.seq);
  const epoch = identifier(entry.epoch);
  const previousHash = hashText(entry.previousHash, "EVENT_DRIFT");
  const hash = hashText(entry.hash, "EVENT_DRIFT");
  const authorityStateHash = hashText(
    entry.authorityStateHash,
    "UNROOTED_EVENT",
  );
  demand(isPlainObject(entry.receipt), "EVENT_DRIFT");
  const receipt = entry.receipt as Record<string, unknown>;
  const receiptCut = parseCut(receipt.cut);
  const expected = canonicalHash({
    ...(entry.appliedBefore === undefined ? {} : {appliedBefore: entry.appliedBefore}),
    authorityStateHash,
    seq,
    epoch,
    previousHash,
    scope: entry.scope,
    intentId: entry.intentId,
    attemptId: entry.attemptId,
    writerId: entry.writerId,
    command: entry.command,
    appliedText: entry.appliedText,
    state: entry.state,
    status: receipt.status,
    code: receipt.code,
    resultHash: receipt.resultHash,
    intentHash: receipt.intentHash,
    attemptHash: receipt.attemptHash,
  });
  demand(expected === hash, "EVENT_DRIFT");
  demand(
    receiptCut.epoch === epoch &&
      receiptCut.seq === seq &&
      receiptCut.hash === hash,
    "EVENT_DRIFT",
  );
  return { seq, epoch, previousHash, authorityStateHash, receiptCut };
}

function rootedCheckpoint(store: StoragePort): RootedCheckpoint | null {
  const raw = store.get("authority.checkpoint", "current");
  if (raw === null) return null;
  demand(isPlainObject(raw), "CHECKPOINT_DRIFT");
  const checkpoint = raw as Record<string, unknown>;
  demand(isPlainObject(checkpoint.body), "CHECKPOINT_DRIFT");
  const body = checkpoint.body as Record<string, unknown>;
  demand(
    canonicalHash(body) === hashText(checkpoint.hash, "CHECKPOINT_DRIFT"),
    "CHECKPOINT_DRIFT",
  );
  const cut = parseCut(body.cut);
  const rootValue = body.authorityStateHash;
  const authorityStateHash =
    rootValue === undefined || rootValue === null
      ? null
      : hashText(rootValue, "CHECKPOINT_DRIFT");
  return { cut, authorityStateHash };
}

function assertRootedEvidence(store: StoragePort): void {
  const genesis = store.get("meta", "genesis");
  demand(isPlainObject(genesis), "UNROOTED_AUTHORITY");
  const genesisRecord = genesis as Record<string, unknown>;
  exactKeys(
    genesisRecord,
    ["format", "epoch", "sourceHash", "authorityStateHash"],
    "UNROOTED_AUTHORITY",
  );
  demand(genesisRecord.format === ROOTED_GENESIS_FORMAT, "UNROOTED_AUTHORITY");
  const epoch = identifier(genesisRecord.epoch);
  const authorityStateHash = hashText(
    genesisRecord.authorityStateHash,
    "UNROOTED_AUTHORITY",
  );
  const sourceHash = genesisRecord.sourceHash;
  demand(
    sourceHash === null ||
      (typeof sourceHash === "string" && HASH.test(sourceHash)),
    "UNROOTED_AUTHORITY",
  );
  const genesisProof = store.get("authority.prefix", epoch + ":0");
  demand(genesisProof !== null, "GENESIS_PREFIX_MISSING");
  const genesisCut = parseCut(genesisProof);
  demand(
    genesisCut.epoch === epoch &&
      genesisCut.seq === 0 &&
      genesisCut.hash === canonicalHash(genesisRecord),
    "GENESIS_PREFIX_MISMATCH",
  );

  const head = parseCut(store.get("meta", "head"));
  demand(head.epoch === epoch, "GENESIS_HEAD_MISMATCH");
  const checkpoint = rootedCheckpoint(store);
  const active =
    checkpoint !== null && checkpoint.cut.epoch === head.epoch
      ? checkpoint
      : null;
  let previous = active === null ? genesisCut : active.cut;
  let expected = active?.authorityStateHash ?? authorityStateHash;
  const events = store
    .all("authority.events")
    .map((entry) => rootedEvent(entry.value))
    .filter((event) => event.epoch === head.epoch)
    .sort((left, right) => left.seq - right.seq);
  for (const event of events) {
    demand(
      event.seq === previous.seq + 1 && event.previousHash === previous.hash,
      "EVENT_CHAIN_DRIFT",
    );
    previous = event.receiptCut;
    expected = event.authorityStateHash;
  }
  demand(
    previous.seq === head.seq && previous.hash === head.hash,
    "CORRUPT_HEAD",
  );
  const storedRoot = store.get("meta", "state-root");
  demand(
    typeof storedRoot === "string" && storedRoot === expected,
    "STATE_ROOT_MISMATCH",
  );
  assertRuntimeStateRoot(store, expected);
}

function bytesHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytesOf(value: unknown): Uint8Array {
  demand(value instanceof Uint8Array, "INVALID_BLOB");
  return value;
}

function decodeBase64(value: unknown): Uint8Array {
  demand(
    typeof value === "string" &&
      value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(value),
    "INVALID_BASE64",
  );
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  demand((value.length - padding) % 4 !== 1, "INVALID_BASE64");
  const bytes = Buffer.from(value, "base64");
  demand(bytes.toString("base64") === value, "INVALID_BASE64");
  return new Uint8Array(bytes);
}

function addBytes(total: number, addition: number): number {
  demand(Number.isSafeInteger(addition) && addition >= 0, "INVALID_BACKUP");
  const next = total + addition;
  demand(
    Number.isSafeInteger(next) && next <= MAX_BACKUP_BYTES,
    "BACKUP_LIMIT",
  );
  return next;
}

export function validateRuntimeBackup(input: unknown): RuntimeBackup {
  demand(isPlainObject(input), "INVALID_BACKUP");
  exactKeys(
    input,
    ["format", "head", "records", "blobs", "hash"],
    "INVALID_BACKUP",
  );
  demand(input.format === BACKUP_FORMAT, "INVALID_BACKUP");
  const head = parseCut(input.head);
  demand(Array.isArray(input.records), "INVALID_BACKUP");
  demand(Array.isArray(input.blobs), "INVALID_BACKUP");
  demand(input.records.length <= MAX_RECORDS, "BACKUP_LIMIT");
  demand(input.blobs.length <= MAX_RECORDS, "BACKUP_LIMIT");

  let byteCount = 0;
  const seenRecords = new Set<string>();
  const records: RuntimeBackupRecord[] = [];
  for (const raw of input.records) {
    demand(isPlainObject(raw), "INVALID_RECORD");
    exactKeys(raw, ["namespace", "key", "value"], "INVALID_RECORD");
    const namespace = text(raw.namespace, "INVALID_RECORD");
    const key = text(raw.key, "INVALID_RECORD");
    const rowKey = namespace + "\u0000" + key;
    demand(!seenRecords.has(rowKey), "DUPLICATE_RECORD");
    seenRecords.add(rowKey);
    const encoded = canonical(raw.value, MAX_BACKUP_BYTES);
    byteCount = addBytes(
      byteCount,
      Buffer.byteLength(encoded) +
        Buffer.byteLength(namespace) +
        Buffer.byteLength(key),
    );
    records.push({ namespace, key, value: clone(raw.value) });
  }

  const seenBlobs = new Set<string>();
  const blobs: RuntimeBackupBlob[] = [];
  for (const raw of input.blobs) {
    demand(isPlainObject(raw), "INVALID_BLOB");
    exactKeys(raw, ["scope", "hash", "base64"], "INVALID_BLOB");
    const scope = text(raw.scope, "INVALID_BLOB");
    const hash = hashText(raw.hash, "INVALID_BLOB");
    const blobKey = scope + "\u0000" + hash;
    demand(!seenBlobs.has(blobKey), "DUPLICATE_BLOB");
    seenBlobs.add(blobKey);
    const bytes = decodeBase64(raw.base64);
    demand(bytesHash(bytes) === hash, "BLOB_HASH_MISMATCH");
    byteCount = addBytes(byteCount, bytes.byteLength);
    blobs.push({ scope, hash, base64: raw.base64 as string });
  }

  const declared = hashText(input.hash, "INVALID_BACKUP");
  const expected = canonicalHash({
    format: BACKUP_FORMAT,
    head,
    records,
    blobs,
  });
  demand(declared === expected, "BACKUP_HASH_MISMATCH");
  return { format: BACKUP_FORMAT, head, records, blobs, hash: expected };
}

function rowCount(store: StoragePort, table: string): number {
  const row = store.db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as unknown as { count: unknown } | undefined;
  demand(row !== undefined, "DESTINATION_UNREADABLE");
  const count = Number(row.count);
  demand(Number.isSafeInteger(count) && count >= 0, "DESTINATION_UNREADABLE");
  return count;
}

function invalidateSession(value: unknown): unknown {
  const copy = clone(value);
  if (!isPlainObject(copy)) return copy;
  copy.active = false;
  copy.revoked = true;
  if (copy.status === "active") copy.status = "revoked";
  if (copy.state === "active") copy.state = "revoked";
  if (isPlainObject(copy.credential)) {
    copy.credential.active = false;
    copy.credential.revoked = true;
    if (copy.credential.status === "active") copy.credential.status = "revoked";
    if (copy.credential.state === "active") copy.credential.state = "revoked";
  }
  return copy;
}

function revokeDevice(value: unknown): unknown {
  const copy = clone(value);
  if (!isPlainObject(copy)) return copy;
  if (
    typeof copy.deviceId !== "string" &&
    !("revoked" in copy) &&
    !("active" in copy)
  )
    return copy;
  copy.revoked = true;
  if ("active" in copy) copy.active = false;
  if (copy.status === "active") copy.status = "revoked";
  if (copy.state === "active") copy.state = "revoked";
  return copy;
}

export function exportBackup(store: StoragePort): RuntimeBackup {
  return store.transaction(() => {
    if (store.get("meta", "genesis") !== null) assertRootedEvidence(store);
    const headValue = store.get("meta", "head");
    demand(headValue !== null, "MISSING_HEAD");
    const head = parseCut(headValue);

    const namespaces = store.db
      .prepare(
        "SELECT DISTINCT namespace FROM runtime_records ORDER BY namespace",
      )
      .all() as unknown as { namespace: unknown }[];
    const records: RuntimeBackupRecord[] = [];
    let byteCount = 0;
    for (const row of namespaces) {
      const namespace = text(row.namespace, "INVALID_RECORD");
      const entries = store.all(namespace);
      for (const entry of entries) {
        demand(records.length < MAX_RECORDS, "BACKUP_LIMIT");
        const key = text(entry.key, "INVALID_RECORD");
        const encoded = canonical(entry.value, MAX_BACKUP_BYTES);
        byteCount = addBytes(
          byteCount,
          Buffer.byteLength(encoded) +
            Buffer.byteLength(namespace) +
            Buffer.byteLength(key),
        );
        records.push({ namespace, key, value: clone(entry.value) });
      }
    }
    records.sort((left, right) =>
      left.namespace < right.namespace
        ? -1
        : left.namespace > right.namespace
          ? 1
          : left.key < right.key
            ? -1
            : left.key > right.key
              ? 1
              : 0,
    );

    const blobRows = store.db
      .prepare("SELECT scope,hash FROM runtime_blobs ORDER BY scope,hash")
      .all() as unknown as { scope: unknown; hash: unknown }[];
    demand(blobRows.length <= MAX_RECORDS, "BACKUP_LIMIT");
    const blobs: RuntimeBackupBlob[] = [];
    for (const row of blobRows) {
      const scope = text(row.scope, "INVALID_BLOB");
      const hash = hashText(row.hash, "INVALID_BLOB");
      const bytes = bytesOf(store.blobGet(scope, hash));
      demand(bytesHash(bytes) === hash, "BLOB_HASH_MISMATCH");
      byteCount = addBytes(byteCount, bytes.byteLength);
      blobs.push({
        scope,
        hash,
        base64: Buffer.from(bytes).toString("base64"),
      });
    }

    const hash = canonicalHash({
      format: BACKUP_FORMAT,
      head,
      records,
      blobs,
    });
    return { format: BACKUP_FORMAT, head, records, blobs, hash };
  });
}

export function restoreBackup(
  backup: unknown,
  destination: StoragePort,
  newEpoch: string,
  beforeGenesis?: (store: StoragePort) => void,
): RestoreBackupResult {
  const parsed = validateRuntimeBackup(backup);
  const epoch = identifier(newEpoch);
  demand(epoch !== parsed.head.epoch, "EPOCH_NOT_FRESH");
  const rooted = parsed.records.some(
    (record) => record.namespace === "meta" && record.key === "genesis",
  );

  return destination.transaction(() => {
    demand(
      rowCount(destination, "runtime_records") === 0 &&
        rowCount(destination, "runtime_blobs") === 0,
      "DESTINATION_NOT_EMPTY",
    );

    const oldCut = parsed.head;

    const records: RuntimeBackupRecord[] = parsed.records.map((record) => ({
      namespace: record.namespace,
      key: record.key,
      value: clone(record.value),
    }));

    for (const blob of parsed.blobs)
      destination.blobPut(blob.scope, blob.hash, decodeBase64(blob.base64));
    for (const record of records)
      destination.set(record.namespace, record.key, record.value);

    if (rooted) assertRootedEvidence(destination);

    for (const entry of destination.all("identity.recovery"))
      destination.set("identity.recovery", entry.key, null);
    for (const entry of destination.all("identity.recovery-status"))
      destination.set("identity.recovery-status", entry.key, null);

    for (const entry of destination.all("identity.sessions"))
      destination.set(
        "identity.sessions",
        entry.key,
        invalidateSession(entry.value),
      );
    for (const entry of destination.all("identity.devices"))
      destination.set("identity.devices", entry.key, revokeDevice(entry.value));
    for (const entry of destination.all("identity.invites")) {
      const invite = entry.value;
      if (
        invite &&
        typeof invite === "object" &&
        !Array.isArray(invite) &&
        (invite as Record<string, unknown>).status === "pending"
      )
        destination.set("identity.invites", entry.key, {
          ...(invite as Record<string, unknown>),
          status: "expired",
        });
    }

    for (const entry of destination.all("authority.events")) {
      const raw = entry.value as { epoch?: unknown } | null;
      const eventEpoch =
        raw !== null && typeof raw === "object" && typeof raw.epoch === "string"
          ? raw.epoch
          : oldCut.epoch;
      destination.set(
        ARCHIVE_EVENTS,
        eventEpoch + ":" + entry.key,
        entry.value,
      );
      destination.set("authority.events", entry.key, null);
    }
    destination.set("meta", "head", null);
    destination.set("meta", "genesis", null);
    destination.set("meta", "state-root", null);

    const restoreMeta = {
      originalCut: oldCut,
      epoch,
      backupHash: parsed.hash,
      requiresReauthorization: true,
    };
    destination.set("meta", "restore", restoreMeta);
    beforeGenesis?.(destination);
    destination.set("meta", "restore-authorization", {
      reset: true,
      epoch,
      sourceHash: parsed.hash,
    });
    const newCut = createRuntimeGenesis(destination, epoch, parsed.hash);

    return { oldCut, newCut, hash: parsed.hash };
  });
}
