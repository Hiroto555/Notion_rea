import {
  BASE_PROTOCOL_VERSION,
  BASE_STORAGE_FORMAT,
  OPERATIONS_NAMESPACES,
  SUPPORTED_TARGET_VERSION,
  type MigrationContext,
} from "./operations";
import { checkedState } from "./document";
import { rememberEditorVersions } from "./editor-versions";
import { digest } from "./digest";
import {
  CollaborationError,
  type Cut,
  type DocumentState,
  type Scope,
  demand,
  identifier,
  safeCounter,
  scopeKey,
} from "./contract";
import type { StoragePort } from "./storage-port";

/**
 * Logical protocol metadata. The physical SQLite user_version stays 1003.
 * The parent binds this namespace into the state root and wires
 * migrateEditorProtocol into RuntimeOperations as its migrationRunner.
 */
export const PROTOCOL_NAMESPACE = "operations.protocol";
export const RUNTIME_PROTOCOL_VERSION = SUPPORTED_TARGET_VERSION;
export const RUNTIME_MINIMUM_WRITER = SUPPORTED_TARGET_VERSION;
export const RUNTIME_PROTOCOL_FEATURES = [
  "editor.batch",
  "editor.rich-inline",
  "editor.inline-patch",
  "editor.inline-mark",
  "editor.block-frame",
  "editor.block-format",
] as const;

const HASH = /^[a-f0-9]{64}$/;
const MAX_DOCUMENTS = 100_000;
const UPGRADE_STATUSES = new Set(["ACTIVE", "COMMITTED", "RECOVERY_REQUIRED"]);
const STORAGE_FORMAT = BASE_STORAGE_FORMAT;

export type RuntimeProtocolStatus =
  | "LEGACY"
  | "FENCED"
  | "ACTIVE"
  | "COMMITTED"
  | "RECOVERY_REQUIRED";

export type RuntimeProtocol = Readonly<{
  storageFormat: typeof STORAGE_FORMAT;
  protocol: 1003 | 1004;
  features: string[];
  status: RuntimeProtocolStatus;
}>;

type JsonObject = Record<string, unknown>;

type UpgradeState = Readonly<{
  storageFormat: number;
  protocolCurrent: number;
  protocolTarget: number;
  status: "ACTIVE" | "COMMITTED" | "RECOVERY_REQUIRED";
  backupHash: string;
}>;

type FenceState = Readonly<{
  readOnly: boolean;
  protocolTarget: number;
  backupHash: string;
}>;

type SelectedDocument = Readonly<{
  key: string;
  scope: Scope;
  state: DocumentState;
  hash: string;
}>;

type ProtocolRow = Readonly<{
  baselineCut: Cut;
  documentHashes: Record<string, string>;
}>;

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

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function readHead(store: StoragePort): Cut {
  const value = store.get("meta", "head");
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
  if (storageFormat !== STORAGE_FORMAT) fail("CORRUPT_UPGRADE");
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
    status: status as UpgradeState["status"],
    backupHash,
  };
}

function readUpgrade(store: StoragePort, orgId: string): UpgradeState | null {
  const value = store.get(OPERATIONS_NAMESPACES.upgrades, orgId);
  return value === null ? null : parseUpgrade(value);
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

function parseVerificationBackupHash(value: unknown): {
  backupHash: string;
  cut: Cut;
} {
  const raw = exactObject(
    value,
    ["backupHash", "epoch", "cut"],
    "CORRUPT_VERIFICATION",
  );
  const backupHash = hash(raw.backupHash, "CORRUPT_VERIFICATION");
  const cut = checkCut(raw.cut, "CORRUPT_VERIFICATION");
  if (identifier(raw.epoch) !== cut.epoch) fail("CORRUPT_VERIFICATION");
  return { backupHash, cut };
}

function assertTrustedBackup(
  store: StoragePort,
  orgId: string,
  backupHash: string,
  head: Cut,
): void {
  const raw = store.get(
    OPERATIONS_NAMESPACES.backups,
    orgId + ":" + backupHash,
  );
  if (raw === null) fail("BACKUP_MISSING");
  const record = exactObject(raw, ["hash", "cut"], "CORRUPT_BACKUP");
  const declared = hash(record.hash, "CORRUPT_BACKUP");
  if (declared !== backupHash) fail("CORRUPT_BACKUP");
  const cut = checkCut(record.cut, "CORRUPT_BACKUP");
  if (!sameCut(cut, head)) fail("STALE_BACKUP");
  const verified = store
    .all(OPERATIONS_NAMESPACES.verifications)
    .some((row) => {
      const proof = parseVerificationBackupHash(row.value);
      return proof.backupHash === backupHash && sameCut(proof.cut, cut);
    });
  if (!verified) fail("BACKUP_NOT_VERIFIED");
}

function checkDocumentMetadata(
  value: DocumentState,
  code = "CORRUPT_DOCUMENT",
): DocumentState {
  if (!Array.isArray(value.tables) || !Array.isArray(value.tombstones))
    fail(code);
  const tableIds = new Set<string>();
  for (const raw of value.tables) {
    const table = exactObject(
      raw,
      ["tableId", "rowIds", "columnIds"],
      code,
    );
    const tableId = identifier(table.tableId);
    if (tableIds.has(tableId)) fail(code);
    tableIds.add(tableId);
    if (!Array.isArray(table.rowIds) || !Array.isArray(table.columnIds))
      fail(code);
    const rowIds = new Set<string>();
    for (const rowId of table.rowIds) {
      const checked = identifier(rowId);
      if (rowIds.has(checked)) fail(code);
      rowIds.add(checked);
    }
    const columnIds = new Set<string>();
    for (const columnId of table.columnIds) {
      const checked = identifier(columnId);
      if (columnIds.has(checked)) fail(code);
      columnIds.add(checked);
    }
  }
  const tombstones = new Set<string>();
  for (const item of value.tombstones) {
    const checked = identifier(item);
    if (tombstones.has(checked)) fail(code);
    tombstones.add(checked);
  }
  return value;
}

function selectOrgDocuments(
  store: StoragePort,
  orgId: string,
): SelectedDocument[] {
  const selected: SelectedDocument[] = [];
  for (const row of store.all("documents")) {
    const parts = row.key.split(":");
    if (parts.length !== 4) fail("ROW_KEY_MISMATCH");
    const [org, workspaceId, documentId, incarnationId] = parts.map((part) =>
      identifier(part),
    );
    if (org !== orgId) continue;
    const scope: Scope = { orgId, workspaceId, documentId, incarnationId };
    const state = checkedState(checkDocumentMetadata(row.value as DocumentState));
    selected.push({
      key: scopeKey(scope),
      scope,
      state,
      hash: digest(state),
    });
    if (selected.length > MAX_DOCUMENTS) fail("DOCUMENT_LIMIT");
  }
  selected.sort((left, right) => left.key.localeCompare(right.key));
  return selected;
}

function parseProtocolRow(value: unknown, orgId: string): ProtocolRow {
  const raw = exactObject(
    value,
    ["v", "protocol", "minimumWriter", "features", "baselineCut", "documentHashes"],
    "CORRUPT_PROTOCOL",
  );
  if (raw.v !== 1) fail("CORRUPT_PROTOCOL");
  if (raw.protocol !== RUNTIME_PROTOCOL_VERSION) fail("CORRUPT_PROTOCOL");
  if (raw.minimumWriter !== RUNTIME_MINIMUM_WRITER) fail("CORRUPT_PROTOCOL");
  if (!Array.isArray(raw.features)) fail("CORRUPT_PROTOCOL");
  if (
    raw.features.length !== RUNTIME_PROTOCOL_FEATURES.length ||
    !raw.features.every(
      (feature, index) => feature === RUNTIME_PROTOCOL_FEATURES[index],
    )
  )
    fail("CORRUPT_PROTOCOL");
  const baselineCut = checkCut(raw.baselineCut, "CORRUPT_PROTOCOL");
  const rawHashes = object(raw.documentHashes, "CORRUPT_PROTOCOL");
  if (Object.getOwnPropertySymbols(rawHashes).length !== 0)
    fail("CORRUPT_PROTOCOL");
  const entries = Object.entries(rawHashes);
  if (entries.length > MAX_DOCUMENTS) fail("CORRUPT_PROTOCOL");
  const documentHashes: Record<string, string> = {};
  for (const [key, value] of entries) {
    const parts = key.split(":");
    if (parts.length !== 4) fail("CORRUPT_PROTOCOL");
    const checked = parts.map((part) => identifier(part));
    if (checked[0] !== orgId) fail("CORRUPT_PROTOCOL");
    documentHashes[key] = hash(value, "CORRUPT_PROTOCOL");
  }
  return { baselineCut, documentHashes };
}

function assertBaselineProof(store: StoragePort, baseline: Cut): void {
  const raw = store.get(
    "authority.prefix",
    baseline.epoch + ":" + baseline.seq,
  );
  if (raw === null) fail("PREFIX_PROOF_MISSING");
  if (!sameCut(checkCut(raw, "PREFIX_PROOF_MISSING"), baseline))
    fail("PREFIX_PROOF_MISSING");
}

/**
 * The real 1003 -> 1004 runner. It runs inside RuntimeOperations'
 * finishUpgrade transaction; a validation fault therefore rolls back every
 * editor/protocol write and leaves the ACTIVE fence in place.
 */
export function migrateEditorProtocol(context: MigrationContext): void {
  const checked = object(context, "INVALID_MIGRATION_CONTEXT");
  const store = checked.store as StoragePort;
  if (
    !store ||
    typeof store.get !== "function" ||
    typeof store.all !== "function" ||
    typeof store.set !== "function" ||
    typeof store.transaction !== "function"
  )
    fail("INVALID_MIGRATION_CONTEXT");
  const orgId = identifier(checked.orgId);
  if (checked.storageFormat !== STORAGE_FORMAT)
    fail("STORAGE_FORMAT_MISMATCH");
  if (checked.fromProtocol !== BASE_PROTOCOL_VERSION)
    fail("UNSUPPORTED_UPGRADE");
  if (checked.toProtocol !== SUPPORTED_TARGET_VERSION)
    fail("UNSUPPORTED_UPGRADE");
  const backupHash = hash(checked.backupHash, "INVALID_HASH");

  store.transaction(() => {
    const head = readHead(store);
    const upgrade = readUpgrade(store, orgId);
    if (upgrade === null || upgrade.status !== "ACTIVE")
      fail("NO_ACTIVE_UPGRADE");
    if (
      upgrade.storageFormat !== STORAGE_FORMAT ||
      upgrade.protocolCurrent !== BASE_PROTOCOL_VERSION ||
      upgrade.protocolTarget !== SUPPORTED_TARGET_VERSION ||
      upgrade.backupHash !== backupHash
    )
      fail("UPGRADE_MISMATCH");

    const fence = readFence(store, orgId);
    if (fence === null || fence.readOnly !== true) fail("WRITER_NOT_FENCED");
    if (
      fence.protocolTarget !== SUPPORTED_TARGET_VERSION ||
      fence.backupHash !== backupHash
    )
      fail("FENCE_MISMATCH");

    assertTrustedBackup(store, orgId, backupHash, head);

    const documents = selectOrgDocuments(store, orgId);

    rememberEditorVersions(store, head);

    const documentHashes: Record<string, string> = {};
    for (const document of documents)
      documentHashes[document.key] = document.hash;

    store.set(PROTOCOL_NAMESPACE, orgId, {
      v: 1,
      protocol: RUNTIME_PROTOCOL_VERSION,
      minimumWriter: RUNTIME_MINIMUM_WRITER,
      features: [...RUNTIME_PROTOCOL_FEATURES],
      baselineCut: {
        epoch: head.epoch,
        seq: head.seq,
        hash: head.hash,
      },
      documentHashes,
    });
  });
}

/**
 * Read-side negotiation. A missing protocol row always means legacy 1003,
 * even when a read-only fence exists; it never pretends a migration happened.
 */
export function readRuntimeProtocol(
  store: StoragePort,
  orgId: string,
): RuntimeProtocol {
  if (
    !store ||
    typeof store.get !== "function" ||
    typeof store.all !== "function"
  )
    fail("INVALID_STORAGE");
  const org = identifier(orgId);
  const upgrade = readUpgrade(store, org);
  const fence = readFence(store, org);
  const raw = store.get(PROTOCOL_NAMESPACE, org);

  if (raw === null) {
    if (upgrade !== null) {
      if (upgrade.status === "COMMITTED") fail("CORRUPT_PROTOCOL");
      demand(
        upgrade.protocolCurrent === BASE_PROTOCOL_VERSION &&
          upgrade.protocolTarget === SUPPORTED_TARGET_VERSION,
        "CORRUPT_UPGRADE",
      );
      if (
        fence === null ||
        fence.readOnly !== true ||
        fence.backupHash !== upgrade.backupHash
      )
        fail("CORRUPT_UPGRADE");
      return {
        storageFormat: STORAGE_FORMAT,
        protocol: BASE_PROTOCOL_VERSION,
        features: [],
        status: upgrade.status,
      };
    }
    return {
      storageFormat: STORAGE_FORMAT,
      protocol: BASE_PROTOCOL_VERSION,
      features: [],
      status: fence?.readOnly === true ? "FENCED" : "LEGACY",
    };
  }

  const protocol = parseProtocolRow(raw, org);
  if (upgrade === null) fail("CORRUPT_PROTOCOL");
  if (upgrade.protocolTarget !== SUPPORTED_TARGET_VERSION)
    fail("CORRUPT_PROTOCOL");
  assertBaselineProof(store, protocol.baselineCut);
  const head = readHead(store);

  if (upgrade.status === "COMMITTED") {
    if (
      upgrade.protocolCurrent !== SUPPORTED_TARGET_VERSION ||
      upgrade.protocolTarget !== SUPPORTED_TARGET_VERSION
    )
      fail("CORRUPT_PROTOCOL");
    if (fence !== null) fail("CORRUPT_PROTOCOL");
    if (head.epoch === protocol.baselineCut.epoch) {
      if (head.seq < protocol.baselineCut.seq) fail("CORRUPT_PROTOCOL");
    } else {
      const restore = store.get("meta", "restore") as {epoch?: unknown; requiresReauthorization?: unknown} | null;
      // A rooted restore preserves the immutable old baseline and its prefix.
      // New credentials and the new realm genesis bind the inherited protocol.
      if (!restore || restore.epoch !== head.epoch || restore.requiresReauthorization !== true) fail("CORRUPT_PROTOCOL");
    }
    return {
      storageFormat: STORAGE_FORMAT,
      protocol: SUPPORTED_TARGET_VERSION,
      features: [...RUNTIME_PROTOCOL_FEATURES],
      status: "COMMITTED",
    };
  }

  if (upgrade.status === "ACTIVE") {
    if (
      upgrade.protocolCurrent !== BASE_PROTOCOL_VERSION ||
      upgrade.protocolTarget !== SUPPORTED_TARGET_VERSION
    )
      fail("CORRUPT_PROTOCOL");
    if (
      fence === null ||
      fence.readOnly !== true ||
      fence.protocolTarget !== SUPPORTED_TARGET_VERSION ||
      fence.backupHash !== upgrade.backupHash
    )
      fail("CORRUPT_PROTOCOL");
    if (!sameCut(head, protocol.baselineCut)) fail("CORRUPT_PROTOCOL");
    return {
      storageFormat: STORAGE_FORMAT,
      protocol: SUPPORTED_TARGET_VERSION,
      features: [...RUNTIME_PROTOCOL_FEATURES],
      status: "ACTIVE",
    };
  }

  // A protocol row never survives a RECOVERY_REQUIRED transition because the
  // outer finishUpgrade transaction rolls it back.
  fail("CORRUPT_PROTOCOL");
}
