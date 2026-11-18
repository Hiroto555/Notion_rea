import {
  CollaborationError,
  identifier,
  safeCounter,
  wellFormed,
  type AuthContext,
  type Cut,
  type Scope,
} from "./contract";
import type { StoragePort } from "./storage-port";

/**
 * The on-disk SQLite format is deliberately unchanged. Protocol versions are
 * logical metadata stored in this module's own namespaces, not PRAGMA values.
 */
export const BASE_STORAGE_FORMAT = 1003;
export const BASE_PROTOCOL_VERSION = 1003;
export const SUPPORTED_TARGET_VERSION = 1004;

export const OPERATIONS_NAMESPACES = {
  backups: "operations.backups",
  upgrades: "operations.upgrades",
  fences: "operations.fences",
  verifications: "backup.verifications",
} as const;

const RUNTIME_NAMESPACES = {
  meta: "meta",
  headKey: "head",
  events: "authority.events",
  documents: "documents",
  intents: "authority.intents",
  attempts: "authority.attempts",
  prefix: "authority.prefix",
} as const;

const HASH = /^[a-f0-9]{64}$/;
const EVENT_KEY = /^[0-9]{16}$/;
const RECEIPT_STATUSES = new Set([
  "SERVER_ACCEPTED",
  "REJECTED",
  "INVALIDATED",
]);
const UPGRADE_STATUSES = new Set(["ACTIVE", "COMMITTED", "RECOVERY_REQUIRED"]);

type JsonObject = Record<string, unknown>;
type UpgradeStatus = "ACTIVE" | "COMMITTED" | "RECOVERY_REQUIRED";

type UpgradeState = {
  storageFormat: number;
  protocolCurrent: number;
  protocolTarget: number;
  status: UpgradeStatus;
  backupHash: string;
};

type FenceState = {
  readOnly: boolean;
  protocolTarget: number;
  backupHash: string;
};

type BackupRecord = { hash: string; cut: Cut };
type VerificationRecord = { backupHash: string; cut: Cut };

type StoredEvent = {
  seq: number;
  intentId: string;
  writerId: string;
  scope: Scope;
  status: string;
  code: string | null;
};

export type BackupSummary = { hash: string; cut: Cut; verified: boolean };

export type RetentionSummary = {
  events: number;
  intents: number;
  attempts: number;
  prefixes: number;
  verifications: number;
};

export type Overview = {
  cut: Cut;
  documents: number;
  recordBytes: number;
  blobBytes: number;
  pending: number;
  backups: BackupSummary[];
  retention: RetentionSummary;
  status: "READY" | "PRESSURE" | "RECOVERY_REQUIRED";
};

export type AuditEvent = {
  seq: number;
  intentId: string;
  writerId: string;
  scope: Scope;
  status: string;
  code: string | null;
};

export type MigrationContext = Readonly<{
  store: StoragePort;
  orgId: string;
  storageFormat: number;
  fromProtocol: number;
  toProtocol: number;
  backupHash: string;
}>;

export type MigrationRunner = (context: MigrationContext) => void;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function object(value: unknown, code: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  return value as JsonObject;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  code: string,
): JsonObject {
  const raw = object(value, code);
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  )
    fail(code);
  return raw;
}

function text(value: unknown, code: string, maximum = 128): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !wellFormed(value)
  )
    fail(code);
  return value;
}

function hash(value: unknown, code = "INVALID_HASH"): string {
  if (typeof value !== "string" || !HASH.test(value)) fail(code);
  return value;
}

function boolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function checkCut(value: unknown, code: string): Cut {
  const raw = exactObject(value, ["epoch", "seq", "hash"], code);
  return {
    epoch: identifier(raw.epoch),
    seq: safeCounter(raw.seq),
    hash: hash(raw.hash, code),
  };
}

function checkScope(value: unknown, code: string): Scope {
  const raw = exactObject(
    value,
    ["orgId", "workspaceId", "documentId", "incarnationId"],
    code,
  );
  return {
    orgId: identifier(raw.orgId),
    workspaceId: identifier(raw.workspaceId),
    documentId: identifier(raw.documentId),
    incarnationId: identifier(raw.incarnationId),
  };
}

function checkAuth(value: unknown): AuthContext {
  const raw = object(value, "INVALID_AUTH");
  return {
    userId: identifier(raw.userId),
    deviceId: identifier(raw.deviceId),
    writerId: identifier(raw.writerId),
    sessionId: identifier(raw.sessionId),
  };
}

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function readHead(store: StoragePort): Cut {
  const value = store.get(RUNTIME_NAMESPACES.meta, RUNTIME_NAMESPACES.headKey);
  if (value === null) fail("HEAD_MISSING");
  return checkCut(value, "CORRUPT_HEAD");
}

function parseUpgrade(value: unknown): UpgradeState {
  const raw = exactObject(
    value,
    [
      "storageFormat",
      "protocolCurrent",
      "protocolTarget",
      "status",
      "backupHash",
    ],
    "CORRUPT_UPGRADE",
  );
  const storageFormat = safeCounter(raw.storageFormat);
  if (storageFormat !== BASE_STORAGE_FORMAT) fail("CORRUPT_UPGRADE");
  const protocolCurrent = safeCounter(raw.protocolCurrent);
  const protocolTarget = safeCounter(raw.protocolTarget);
  const status = raw.status;
  if (typeof status !== "string" || !UPGRADE_STATUSES.has(status))
    fail("CORRUPT_UPGRADE");
  const backupHash = hash(raw.backupHash, "CORRUPT_UPGRADE");
  if (status === "COMMITTED") {
    if (protocolCurrent !== protocolTarget) fail("CORRUPT_UPGRADE");
    if (protocolCurrent < BASE_PROTOCOL_VERSION) fail("CORRUPT_UPGRADE");
  } else if (
    protocolCurrent !== BASE_PROTOCOL_VERSION ||
    protocolTarget !== SUPPORTED_TARGET_VERSION
  ) {
    fail("CORRUPT_UPGRADE");
  }
  return {
    storageFormat,
    protocolCurrent,
    protocolTarget,
    status: status as UpgradeStatus,
    backupHash,
  };
}

function readUpgrade(store: StoragePort, orgId: string): UpgradeState | null {
  const value = store.get(OPERATIONS_NAMESPACES.upgrades, orgId);
  return value === null ? null : parseUpgrade(value);
}

function readUpgradeStates(store: StoragePort): UpgradeState[] {
  return store.all(OPERATIONS_NAMESPACES.upgrades).map((row) => {
    identifier(row.key);
    return parseUpgrade(row.value);
  });
}

function parseFence(value: unknown): FenceState {
  const raw = exactObject(
    value,
    ["readOnly", "protocolTarget", "backupHash"],
    "CORRUPT_FENCE",
  );
  const protocolTarget = safeCounter(raw.protocolTarget);
  if (protocolTarget !== SUPPORTED_TARGET_VERSION) fail("CORRUPT_FENCE");
  return {
    readOnly: boolean(raw.readOnly, "CORRUPT_FENCE"),
    protocolTarget,
    backupHash: hash(raw.backupHash, "CORRUPT_FENCE"),
  };
}

function readFence(store: StoragePort, orgId: string): FenceState | null {
  const value = store.get(OPERATIONS_NAMESPACES.fences, orgId);
  return value === null ? null : parseFence(value);
}

function allFences(store: StoragePort): FenceState[] {
  return store.all(OPERATIONS_NAMESPACES.fences).map((row) => {
    identifier(row.key);
    return parseFence(row.value);
  });
}

function parseVerification(value: unknown): VerificationRecord {
  const raw = exactObject(
    value,
    ["backupHash", "epoch", "cut"],
    "CORRUPT_VERIFICATION",
  );
  const backupHash = hash(raw.backupHash, "CORRUPT_VERIFICATION");
  const cut = checkCut(raw.cut, "CORRUPT_VERIFICATION");
  const epoch = identifier(raw.epoch);
  if (epoch !== cut.epoch) fail("CORRUPT_VERIFICATION");
  return { backupHash, cut };
}

function readVerifications(store: StoragePort): VerificationRecord[] {
  return store
    .all(OPERATIONS_NAMESPACES.verifications)
    .map((row) => parseVerification(row.value));
}

function verifiedBy(
  verifications: readonly VerificationRecord[],
  backupHash: string,
  cut: Cut,
): boolean {
  return verifications.some(
    (record) => record.backupHash === backupHash && sameCut(record.cut, cut),
  );
}

function parseBackup(value: unknown): BackupRecord {
  const raw = exactObject(value, ["hash", "cut"], "CORRUPT_BACKUP");
  return {
    hash: hash(raw.hash, "CORRUPT_BACKUP"),
    cut: checkCut(raw.cut, "CORRUPT_BACKUP"),
  };
}

function readOrgBackups(
  store: StoragePort,
  orgId: string,
  verifications: readonly VerificationRecord[],
): BackupSummary[] {
  const prefix = orgId + ":";
  const backups: BackupSummary[] = [];
  for (const row of store.all(OPERATIONS_NAMESPACES.backups)) {
    if (!row.key.startsWith(prefix)) continue;
    const suffix = row.key.slice(prefix.length);
    const record = parseBackup(row.value);
    if (record.hash !== suffix) fail("ROW_KEY_MISMATCH");
    backups.push({
      hash: record.hash,
      cut: record.cut,
      verified: verifiedBy(verifications, record.hash, record.cut),
    });
  }
  backups.sort((left, right) => left.hash.localeCompare(right.hash));
  return backups;
}

function checkDocumentState(value: unknown): void {
  const raw = object(value, "CORRUPT_DOCUMENT");
  const document = object(raw.document, "CORRUPT_DOCUMENT");
  if (typeof document.type !== "string") fail("CORRUPT_DOCUMENT");
  if (!Array.isArray(raw.tables) || !Array.isArray(raw.tombstones))
    fail("CORRUPT_DOCUMENT");
}

function countDocuments(store: StoragePort, orgId: string): number {
  let count = 0;
  for (const row of store.all(RUNTIME_NAMESPACES.documents)) {
    const parts = row.key.split(":");
    if (parts.length !== 4) fail("ROW_KEY_MISMATCH");
    for (const part of parts) identifier(part);
    if (parts[0] !== orgId) continue;
    checkDocumentState(row.value);
    count++;
  }
  return count;
}

function parseEvent(
  seqKey: string,
  value: unknown,
): StoredEvent & {
  epoch: string;
} {
  const raw = object(value, "CORRUPT_EVENT");
  const seq = safeCounter(raw.seq);
  if (!EVENT_KEY.test(seqKey) || Number(seqKey) !== seq)
    fail("ROW_KEY_MISMATCH");
  const epoch = identifier(raw.epoch);
  const scope = checkScope(raw.scope, "CORRUPT_EVENT");
  const intentId = identifier(raw.intentId);
  const writerId = identifier(raw.writerId);
  hash(raw.previousHash, "CORRUPT_EVENT");
  const eventHash = hash(raw.hash, "CORRUPT_EVENT");
  const receipt = object(raw.receipt, "CORRUPT_EVENT");
  const cut = checkCut(receipt.cut, "CORRUPT_EVENT");
  if (cut.seq !== seq || cut.epoch !== epoch || cut.hash !== eventHash)
    fail("CORRUPT_EVENT");
  if (identifier(receipt.intentId) !== intentId) fail("CORRUPT_EVENT");
  if (identifier(receipt.writerId) !== writerId) fail("CORRUPT_EVENT");
  const status = text(receipt.status, "CORRUPT_EVENT", 64);
  if (!RECEIPT_STATUSES.has(status)) fail("CORRUPT_EVENT");
  const code =
    receipt.code === null ? null : text(receipt.code, "CORRUPT_EVENT", 128);
  return { seq, epoch, intentId, writerId, scope, status, code };
}

function readOrgEvents(
  store: StoragePort,
  orgId: string,
  epoch: string,
): StoredEvent[] {
  const events: (StoredEvent & { epoch: string })[] = [];
  for (const row of store.all(RUNTIME_NAMESPACES.events)) {
    const event = parseEvent(row.key, row.value);
    if (event.epoch !== epoch) continue;
    if (event.scope.orgId !== orgId) continue;
    events.push(event);
  }
  events.sort((left, right) => left.seq - right.seq);
  for (let index = 1; index < events.length; index++)
    if (events[index - 1].seq === events[index].seq)
      fail("DUPLICATE_EVENT_SEQ");
  return events;
}

function ownedKeyCount(
  store: StoragePort,
  namespace: string,
  orgId: string,
): number {
  const prefix = orgId + ":";
  let count = 0;
  for (const row of store.all(namespace))
    if (row.key.startsWith(prefix)) count++;
  return count;
}

function countPending(store: StoragePort, orgId: string): number {
  const terminal = new Set<string>();
  for (const row of store.all(RUNTIME_NAMESPACES.attempts)) {
    const raw = object(row.value, "CORRUPT_ATTEMPT");
    const attempt = object(raw.attempt, "CORRUPT_ATTEMPT");
    const intent = object(attempt.intent, "CORRUPT_ATTEMPT");
    const scope = checkScope(intent.scope, "CORRUPT_ATTEMPT");
    if (scope.orgId !== orgId) continue;
    const writerId = identifier(intent.writerId);
    const intentId = identifier(intent.intentId);
    const receipt = object(raw.receipt, "CORRUPT_ATTEMPT");
    const status = text(receipt.status, "CORRUPT_ATTEMPT", 64);
    if (!RECEIPT_STATUSES.has(status)) fail("CORRUPT_ATTEMPT");
    if (status !== "SERVER_ACCEPTED") terminal.add(writerId + ":" + intentId);
  }

  let pending = 0;
  for (const row of store.all(RUNTIME_NAMESPACES.intents)) {
    const parts = row.key.split(":");
    if (parts.length !== 6) fail("ROW_KEY_MISMATCH");
    for (const part of parts) identifier(part);
    if (parts[0] !== orgId) continue;
    const raw = object(row.value, "CORRUPT_INTENT");
    if (raw.accepted !== null) continue;
    const writerId = identifier(parts[4]);
    const intentId = identifier(parts[5]);
    if (terminal.has(writerId + ":" + intentId)) continue;
    pending++;
  }
  return pending;
}

function prefixCount(store: StoragePort, epoch: string): number {
  const prefix = epoch + ":";
  let count = 0;
  for (const row of store.all(RUNTIME_NAMESPACES.prefix))
    if (row.key.startsWith(prefix)) count++;
  return count;
}

function sqlBytes(value: unknown, code: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    fail(code);
  return number;
}

function recordBytes(store: StoragePort): number {
  const row = store.db
    .prepare(
      "SELECT COALESCE(SUM(LENGTH(CAST(raw AS BLOB))),0) AS bytes FROM runtime_records",
    )
    .get() as Record<string, unknown> | undefined;
  return sqlBytes(row?.bytes, "CORRUPT_CAPACITY");
}

function blobBytes(store: StoragePort): number {
  const row = store.db
    .prepare(
      "SELECT COALESCE(SUM(LENGTH(bytes)),0) AS bytes FROM runtime_blobs",
    )
    .get() as Record<string, unknown> | undefined;
  return sqlBytes(row?.bytes, "CORRUPT_CAPACITY");
}

function capacityPressure(store: StoragePort): boolean {
  try {
    const used = store.db.prepare("PRAGMA page_count").get() as
      Record<string, unknown> | undefined;
    const maximum = store.db.prepare("PRAGMA max_page_count").get() as
      Record<string, unknown> | undefined;
    const usedPages = sqlBytes(used?.page_count, "CORRUPT_CAPACITY");
    const maxPages = sqlBytes(maximum?.max_page_count, "CORRUPT_CAPACITY");
    if (maxPages <= 0) return true;
    return usedPages / maxPages >= 0.9;
  } catch {
    return true;
  }
}

function checkUpgradeConsistency(
  upgrade: UpgradeState | null,
  fence: FenceState | null,
): void {
  if (upgrade === null) return;
  if (upgrade.status === "COMMITTED") {
    if (fence !== null) fail("CORRUPT_UPGRADE");
    return;
  }
  if (fence === null || fence.readOnly !== true) fail("CORRUPT_UPGRADE");
  if (fence.backupHash !== upgrade.backupHash) fail("CORRUPT_UPGRADE");
}

export class RuntimeOperations {
  constructor(
    private readonly store: StoragePort,
    private readonly authorize: (
      auth: AuthContext,
      orgId: string,
      action: "audit" | "manage",
    ) => void,
    private readonly migrationRunner?: MigrationRunner,
  ) {
    if (typeof authorize !== "function") fail("INVALID_AUTHORIZER");
    if (migrationRunner !== undefined && typeof migrationRunner !== "function")
      fail("INVALID_MIGRATION_RUNNER");
  }

  overview(auth: AuthContext, orgId: string): Overview {
    const checked = checkAuth(auth);
    const org = identifier(orgId);
    this.authorize(checked, org, "audit");
    return this.store.transaction(() => {
      const cut = readHead(this.store);
      const upgrade = readUpgrade(this.store, org);
      const fence = readFence(this.store, org);
      checkUpgradeConsistency(upgrade, fence);
      const events = readOrgEvents(this.store, org, cut.epoch);
      const verifications = readVerifications(this.store);
      const status =
        upgrade?.status === "RECOVERY_REQUIRED" ||
        (upgrade === null && fence?.readOnly === true)
          ? "RECOVERY_REQUIRED"
          : upgrade?.status === "ACTIVE" ||
              fence?.readOnly === true ||
              capacityPressure(this.store)
            ? "PRESSURE"
            : "READY";
      return {
        cut,
        documents: countDocuments(this.store, org),
        recordBytes: recordBytes(this.store),
        blobBytes: blobBytes(this.store),
        pending: countPending(this.store, org),
        backups: readOrgBackups(this.store, org, verifications),
        retention: {
          events: events.length,
          intents: ownedKeyCount(this.store, RUNTIME_NAMESPACES.intents, org),
          attempts: ownedKeyCount(this.store, RUNTIME_NAMESPACES.attempts, org),
          prefixes: prefixCount(this.store, cut.epoch),
          verifications: verifications.length,
        },
        status,
      };
    });
  }

  audit(
    auth: AuthContext,
    orgId: string,
    afterSeq = 0,
    limit = 100,
  ): { cut: Cut; events: AuditEvent[] } {
    const checked = checkAuth(auth);
    const org = identifier(orgId);
    const after = safeCounter(afterSeq);
    const maximum = safeCounter(limit);
    if (maximum > 1000) fail("INVALID_LIMIT");
    this.authorize(checked, org, "audit");
    return this.store.transaction(() => {
      const cut = readHead(this.store);
      const events = readOrgEvents(this.store, org, cut.epoch)
        .filter((event) => event.seq > after)
        .slice(0, maximum)
        .map((event) => ({
          seq: event.seq,
          intentId: event.intentId,
          writerId: event.writerId,
          scope: event.scope,
          status: event.status,
          code: event.code,
        }));
      return { cut, events };
    });
  }

  recordBackup(
    auth: AuthContext,
    orgId: string,
    backup: { hash: string; cut: Cut; verified: boolean },
  ): void {
    const checked = checkAuth(auth);
    const org = identifier(orgId);
    const raw = exactObject(
      backup,
      ["hash", "cut", "verified"],
      "INVALID_BACKUP",
    );
    const backupHash = hash(raw.hash);
    const cut = checkCut(raw.cut, "INVALID_BACKUP");
    const verified = boolean(raw.verified, "INVALID_BACKUP");
    this.authorize(checked, org, "manage");
    this.store.transaction(() => {
      const verifications = readVerifications(this.store);
      if (verified && !verifiedBy(verifications, backupHash, cut))
        fail("BACKUP_VERIFICATION_REQUIRED");
      this.store.set(OPERATIONS_NAMESPACES.backups, org + ":" + backupHash, {
        hash: backupHash,
        cut,
      });
    });
  }

  planUpgrade(
    auth: AuthContext,
    orgId: string,
    target: number,
  ): {
    current: number;
    target: number;
    canWrite: boolean;
    requiresBackup: boolean;
  } {
    const checked = checkAuth(auth);
    const org = identifier(orgId);
    const requested = safeCounter(target);
    this.authorize(checked, org, "manage");
    return this.store.transaction(() => {
      const state = readUpgrade(this.store, org);
      const fence = readFence(this.store, org);
      const current = state?.protocolCurrent ?? BASE_PROTOCOL_VERSION;
      if (requested === current) fail("NOT_AN_UPGRADE");
      if (
        current !== BASE_PROTOCOL_VERSION ||
        requested !== SUPPORTED_TARGET_VERSION
      )
        fail("UNSUPPORTED_UPGRADE");
      return {
        current,
        target: requested,
        canWrite:
          fence?.readOnly !== true &&
          state?.status !== "ACTIVE" &&
          state?.status !== "RECOVERY_REQUIRED",
        requiresBackup: requested > current,
      };
    });
  }

  beginUpgrade(
    auth: AuthContext,
    orgId: string,
    target: number,
    backupHash: string,
  ): void {
    const checked = checkAuth(auth);
    const org = identifier(orgId);
    const requested = safeCounter(target);
    const backup = hash(backupHash);
    this.authorize(checked, org, "manage");
    this.store.transaction(() => {
      const state = readUpgrade(this.store, org);
      const current = state?.protocolCurrent ?? BASE_PROTOCOL_VERSION;
      if (
        current !== BASE_PROTOCOL_VERSION ||
        requested !== SUPPORTED_TARGET_VERSION
      )
        fail("UNSUPPORTED_UPGRADE");
      if (state?.status === "RECOVERY_REQUIRED")
        fail("UPGRADE_RECOVERY_REQUIRED");
      if (state?.status === "ACTIVE") fail("UPGRADE_ALREADY_ACTIVE");
      const fence = readFence(this.store, org);
      if (fence?.readOnly === true) fail("WRITER_FENCED");

      const head = readHead(this.store);
      const backupRecord = this.store.get(
        OPERATIONS_NAMESPACES.backups,
        org + ":" + backup,
      );
      if (backupRecord === null) fail("BACKUP_MISSING");
      const record = parseBackup(backupRecord);
      if (record.hash !== backup) fail("CORRUPT_BACKUP");
      const verifications = readVerifications(this.store);
      if (!verifiedBy(verifications, backup, record.cut))
        fail("BACKUP_NOT_VERIFIED");
      if (!sameCut(record.cut, head)) fail("STALE_BACKUP");

      this.store.set(OPERATIONS_NAMESPACES.upgrades, org, {
        storageFormat: BASE_STORAGE_FORMAT,
        protocolCurrent: current,
        protocolTarget: requested,
        status: "ACTIVE",
        backupHash: backup,
      });
      this.store.set(OPERATIONS_NAMESPACES.fences, org, {
        readOnly: true,
        protocolTarget: requested,
        backupHash: backup,
      });
    });
  }

  finishUpgrade(auth: AuthContext, orgId: string, success: boolean): void {
    const checked = checkAuth(auth);
    const org = identifier(orgId);
    const outcome = boolean(success, "INVALID_UPGRADE_OUTCOME");
    this.authorize(checked, org, "manage");
    this.store.transaction(() => {
      const state = readUpgrade(this.store, org);
      if (state === null || state.status !== "ACTIVE")
        fail("NO_ACTIVE_UPGRADE");
      if (outcome) {
        const runner = this.migrationRunner;
        if (runner === undefined) fail("MIGRATION_REQUIRED");
        runner({
          store: this.store,
          orgId: org,
          storageFormat: state.storageFormat,
          fromProtocol: state.protocolCurrent,
          toProtocol: state.protocolTarget,
          backupHash: state.backupHash,
        });
        this.store.set(OPERATIONS_NAMESPACES.upgrades, org, {
          storageFormat: state.storageFormat,
          protocolCurrent: state.protocolTarget,
          protocolTarget: state.protocolTarget,
          status: "COMMITTED",
          backupHash: state.backupHash,
        });
        this.store.set(OPERATIONS_NAMESPACES.fences, org, null);
        return;
      }
      this.store.set(OPERATIONS_NAMESPACES.upgrades, org, {
        storageFormat: state.storageFormat,
        protocolCurrent: state.protocolCurrent,
        protocolTarget: state.protocolTarget,
        status: "RECOVERY_REQUIRED",
        backupHash: state.backupHash,
      });
      this.store.set(OPERATIONS_NAMESPACES.fences, org, {
        readOnly: true,
        protocolTarget: state.protocolTarget,
        backupHash: state.backupHash,
      });
    });
  }

  assertWriter(version: number): void {
    const requested = safeCounter(version);
    const states = readUpgradeStates(this.store);
    const fences = allFences(this.store);
    for (const state of states)
      if (state.status === "RECOVERY_REQUIRED") fail("RECOVERY_REQUIRED");
    for (const state of states)
      if (state.status === "ACTIVE") fail("WRITER_FENCED");
    for (const fence of fences) if (fence.readOnly) fail("WRITER_FENCED");
    let current = BASE_PROTOCOL_VERSION;
    if (states.length > 0) {
      const versions = new Set(states.map((state) => state.protocolCurrent));
      if (versions.size !== 1) fail("WRITER_VERSION_MISMATCH");
      current = [...versions][0];
    }
    if (requested !== current) fail("WRITER_VERSION_MISMATCH");
  }
}
