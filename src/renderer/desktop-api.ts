import type {
  AppApi,
  CapabilitiesReadPort,
  ConflictDecisionPort,
  EditingPort,
  OriginalReadPort,
  RawSalvageResult,
  ReadOnlyAppApi,
  RecordReadSnapshot,
  RecoverySalvagePort,
  StorageReadPort,
  StructurePort,
  SyncControlPort,
  WorkspaceConflictPort,
  WorkspaceReadPort,
} from "../shared/app-api";
import type {
  DatabaseOperation,
  DatabaseOperationResult,
  DatabaseReadSnapshot,
} from "../shared/database-operation";
import type {
  LegacyMigrationOperation,
  LegacyMigrationPreview,
  LegacyMigrationResult,
} from "../shared/legacy-migration-operation";
import type {
  PropertyChange,
  PropertyOperation,
  PropertyOperationResult,
  PropertyPreviewResult,
} from "../shared/property-operation";
import type { SaveOperation, SaveResult } from "../shared/save-contract";
import type {
  SyncConnectionAction,
  SyncConnectionInput,
  SyncConnectionView,
  SyncRetentionView,
  TransferMaintenanceEntry,
  TransferMaintenanceView,
  TransferReleasePlanView,
  TransferReleaseResult,
} from "../shared/sync-management";
import type { StartupStatus } from "../shared/startup-status";
import {
  parseDesktopCapabilities,
  type DesktopCapabilities,
} from "../shared/desktop-capabilities";
import type { StoragePressureSnapshot } from "../shared/storage-pressure";
import type {
  WorkspaceSyncRestartAction,
  WorkspaceSyncRestartView,
  WorkspaceSyncView,
  WorkspaceSyncWorkspaceStatus,
} from "../shared/workspace-sync-view";
import type {
  WorkspaceConflictCandidateSnapshot,
  WorkspaceConflictCandidateTarget,
  WorkspaceConflictView,
} from "../shared/workspace-conflict-view";
import type {
  ConflictDecisionAction,
  ConflictDecisionPreview,
  ConflictDecisionView,
  ConflictPreviewRequest,
} from "../shared/workspace-conflict-resolution";
import type { SharedRuntimeAPI } from "../shared/shared-runtime-ipc";
import {
  isDocument,
  type DatabaseProjection,
  type FolioAPI,
  type Request,
  type Snapshot,
} from "../shared/types";
import { isLosslessDatabaseData } from "../database/strict-database";
import {
  createDiagnosticRequest,
  StorageFailureError,
  toStorageFailureError,
  unclassifiedRequestFailure,
} from "./private-request";

/** Desktop-shell compatibility transport for the generic callers that have
 * not migrated to a purpose port yet. It is only the existing v1 diagnostic
 * lane, never the legacy channel and never part of the common API. */
export type DesktopCompatibility = {
  request<T>(request: Request): Promise<T>;
};
export type DesktopRootBindings = {
  readonly readOnly: ReadOnlyAppApi;
  readonly writable: AppApi;
  readonly compatibility: DesktopCompatibility;
};

/** A purpose response that fails its own plain-data/type-structure check
 * closes to the same bounded local E as any other unprovable outcome — never
 * a resend, a fallback or an empty success. */
function invalidPurposeReply(requestType: string): StorageFailureError {
  return new StorageFailureError(unclassifiedRequestFailure(requestType));
}

/** Read one own enumerable data property set without ever executing an
 * accessor and without letting a proxy trap escape raw. Non-plain carriers —
 * a foreign prototype, symbol keys, accessor or non-enumerable entries — are
 * not the wire shape and fail closed. */
function ownRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    // Null-prototype dictionary built by defineProperty: an own `__proto__`
    // data key must stay an own data property — assigning it on a `{}` would
    // invoke the inherited setter and smuggle the payload into the prototype,
    // letting inherited values satisfy required fields and hiding them from
    // enumeration. Legal own `__proto__: <data>` values are preserved as-is.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.getOwnPropertyNames(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (
        !desc ||
        !desc.enumerable ||
        !("value" in desc) ||
        desc.get !== undefined ||
        desc.set !== undefined
      )
        return null;
      Object.defineProperty(out, key, {
        value: desc.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** A dense array of own enumerable data elements, read by descriptor only. */
function ownArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const names = Object.getOwnPropertyNames(value);
    const lengthDesc = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDesc || !("value" in lengthDesc)) return null;
    const length = lengthDesc.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      names.length !== length + 1
    )
      return null;
    const out: unknown[] = new Array(length);
    for (const name of names) {
      if (name === "length") continue;
      if (!/^(0|[1-9]\d*)$/.test(name)) return null;
      const index = Number(name);
      if (String(index) !== name || index >= length) return null;
      const desc = Object.getOwnPropertyDescriptor(value, name);
      if (
        !desc ||
        !desc.enumerable ||
        !("value" in desc) ||
        desc.get !== undefined ||
        desc.set !== undefined
      )
        return null;
      out[index] = desc.value;
    }
    return out;
  } catch {
    return null;
  }
}

/** Prove a tree contains only own plain data before any deeper predicate —
 * which may legitimately read properties — runs on it. Functions are not wire
 * data: a callable `then` would turn the resolved value into a thenable the
 * promise machinery assimilates, and any other callable field is equally not
 * something a real transport can carry. Iterative enter/exit frames keep the
 * active ancestor chain separate from completed nodes: a re-entry into an
 * active ancestor is a true cycle and fails closed, while a second reference
 * to an already validated node — the producer's shared Page/settings arrays —
 * is a legal DAG edge accepted once and never re-walked. The original value
 * and its reference structure are inspected only, never normalized or cloned.
 * No size cap is imposed on the payload itself. */
function ownPlainData(value: unknown): boolean {
  const stack: [exit: boolean, node: unknown][] = [[false, value]];
  const active = new Set<object>();
  const completed = new Set<object>();
  try {
    while (stack.length) {
      const [exit, node] = stack.pop()!;
      if (exit) {
        active.delete(node as object);
        completed.add(node as object);
        continue;
      }
      if (node === null || typeof node !== "object") {
        if (typeof node === "function") return false;
        continue;
      }
      if (completed.has(node)) continue;
      if (active.has(node)) return false;
      active.add(node);
      stack.push([true, node]);
      if (Array.isArray(node)) {
        if (ownArray(node) === null) return false;
        for (let index = 0; index < node.length; index += 1) {
          const desc = Object.getOwnPropertyDescriptor(node, String(index));
          stack.push([false, desc!.value]);
        }
      } else {
        const record = ownRecord(node);
        if (record === null) return false;
        for (const key of Object.keys(record)) {
          stack.push([false, record[key]]);
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Sync DTOs are closed wire shapes: every own enumerable key must be one of
 * the producer's declared fields, including optional slots the producer may
 * leave present-but-undefined. Extra foreign metadata fails closed. */
function hasOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

const time = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The wire shape Store.load can actually produce, asserted on a carrier that
 * decodeSnapshot already proved to be own plain data. The required primitive
 * and nullable metadata is what decodeRow spreads onto every read — a
 * quarantined Page keeps it too, so it is asserted before the documentError
 * early return. A Page carrying documentError is a legal quarantined read:
 * the document, schemaVersion and width that caused the quarantine stay
 * preserved verbatim and are never inspected, and the store already nulled a
 * malformed database — the quarantine is never strengthened into a
 * whole-workspace failure. A healthy Page must satisfy the same field and
 * document checks the store applies before it would call the page healthy,
 * and a healthy database must be the existing lossless DatabaseData shape. */
function snapshotPage(value: unknown): boolean {
  const page = ownRecord(value);
  if (page === null) return false;
  if (typeof page.id !== "string" || page.id.length === 0) return false;
  if (
    page.parentId !== null &&
    (typeof page.parentId !== "string" || page.parentId.length === 0)
  )
    return false;
  if (
    typeof page.title !== "string" ||
    typeof page.icon !== "string" ||
    typeof page.cover !== "string"
  )
    return false;
  if (page.kind !== "page" && page.kind !== "database") return false;
  if (typeof page.favorite !== "boolean") return false;
  if (typeof page.position !== "number" || !Number.isFinite(page.position))
    return false;
  if (
    typeof page.revision !== "number" ||
    !Number.isSafeInteger(page.revision) ||
    page.revision < 0
  )
    return false;
  if (!time(page.createdAt) || !time(page.updatedAt)) return false;
  if (page.deletedAt !== null && !time(page.deletedAt)) return false;
  if (page.database !== null && ownRecord(page.database) === null)
    return false;
  if (page.documentError !== undefined)
    return typeof page.documentError === "string";
  if (page.schemaVersion !== undefined && page.schemaVersion !== 1)
    return false;
  if (
    page.width !== undefined &&
    page.width !== "standard" &&
    page.width !== "wide"
  )
    return false;
  if (page.recoveredFrom !== undefined) {
    const recovered = ownRecord(page.recoveredFrom);
    if (
      recovered === null ||
      typeof recovered.pageId !== "string" ||
      !time(recovered.recoveredAt)
    )
      return false;
  }
  if (page.database !== null && !isLosslessDatabaseData(page.database))
    return false;
  return isDocument(page.doc);
}

function snapshotRecord(value: unknown): boolean {
  const record = ownRecord(value);
  if (record === null) return false;
  if (
    typeof record.pageId !== "string" ||
    record.pageId.length === 0 ||
    typeof record.databasePageId !== "string" ||
    record.databasePageId.length === 0
  )
    return false;
  if (
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0
  )
    return false;
  if (typeof record.title !== "string" || typeof record.icon !== "string")
    return false;
  if (record.deletedAt !== null && !time(record.deletedAt)) return false;
  const values = ownRecord(record.values);
  if (values === null) return false;
  for (const key of Object.keys(values)) {
    const cell = values[key];
    if (
      typeof cell !== "string" &&
      typeof cell !== "boolean" &&
      !(typeof cell === "number" && Number.isFinite(cell))
    )
      return false;
  }
  return true;
}

/** startup:status is own plain data with the existing mode discriminant and
 * optional string messages; anything else fails closed instead of letting a
 * malformed value steer the root branch. */
function decodeStartupStatus(value: unknown): StartupStatus {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    (record.mode !== "writable" && record.mode !== "readOnly") ||
    (record.message !== undefined && typeof record.message !== "string") ||
    (record.experimentalSharedUi !== undefined && typeof record.experimentalSharedUi !== "boolean") ||
    (record.syncMessage !== undefined &&
      typeof record.syncMessage !== "string")
  )
    throw invalidPurposeReply("startup:status");
  return value as StartupStatus;
}

/** load must carry the existing Snapshot envelope: a pages array of the read
 * shapes above, a settings string map, and the optional records /
 * recordDatabaseIds collections with their existing element types. Validation
 * inspects structure only — no defaults, sorting, filtering, rewriting or
 * per-page quarantine tightening — and returns the original value. */
function decodeSnapshot(value: unknown): Snapshot {
  const record = ownRecord(value);
  if (record === null || !ownPlainData(value))
    throw invalidPurposeReply("load");
  const pages = ownArray(record.pages);
  if (pages === null) throw invalidPurposeReply("load");
  for (const page of pages) {
    if (!snapshotPage(page)) throw invalidPurposeReply("load");
  }
  const settings = ownRecord(record.settings);
  if (settings === null) throw invalidPurposeReply("load");
  for (const key of Object.keys(settings)) {
    if (typeof settings[key] !== "string") throw invalidPurposeReply("load");
  }
  if (record.records !== undefined) {
    const records = ownArray(record.records);
    if (records === null) throw invalidPurposeReply("load");
    for (const entry of records) {
      if (!snapshotRecord(entry)) throw invalidPurposeReply("load");
    }
  }
  if (record.recordDatabaseIds !== undefined) {
    const ids = ownArray(record.recordDatabaseIds);
    if (ids === null) throw invalidPurposeReply("load");
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0)
        throw invalidPurposeReply("load");
    }
  }
  return value as Snapshot;
}

/** DatabaseProjection.settings is the owner Page's database minus its rows.
 * The store applies the same lossless check to the full database on every
 * write, so the read side re-proves exactly that shape — legacy single-view
 * data stays accepted and no normalizer, default or size cap is added. A
 * settings object carrying its own rows key can never come from the producer
 * and fails closed; a thrown check fails the same way as a false one. */
function databaseSettingsShape(value: unknown): boolean {
  const settings = ownRecord(value);
  if (settings === null || Object.hasOwn(settings, "rows")) return false;
  try {
    return isLosslessDatabaseData({ ...settings, rows: [] });
  } catch {
    return false;
  }
}

/** The DatabaseProjection the record store emits: settings without rows, the
 * owner revision and every membership projection — trashed records stay
 * included because the read-only viewer must still offer restore. When
 * ownerId is given, every record must belong to that exact owner; that is the
 * request binding, never a substitute for the caller's captured owner check. */
function databaseProjectionShape(value: unknown, ownerId?: string): boolean {
  const projection = ownRecord(value);
  if (projection === null) return false;
  if (!databaseSettingsShape(projection.settings)) return false;
  const records = ownArray(projection.records);
  if (records === null) return false;
  for (const record of records) {
    if (!snapshotRecord(record)) return false;
    if (ownerId !== undefined && ownRecord(record)?.databasePageId !== ownerId)
      return false;
  }
  const revision = projection.revision;
  return (
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0
  );
}

/** database:read is the atomic owner snapshot: the requested Page must be the
 * payload owner and every projected record must belong to it. Deeper owner,
 * revision and settings consistency stays with the session attach fence. */
function decodeDatabaseReadSnapshot(
  value: unknown,
  databasePageId: string,
): DatabaseReadSnapshot {
  const snapshot = ownRecord(value);
  const page = ownRecord(snapshot?.page);
  if (
    snapshot === null ||
    page === null ||
    !ownPlainData(value) ||
    !snapshotPage(snapshot.page) ||
    page.kind !== "database" ||
    !databaseProjectionShape(snapshot.database, databasePageId) ||
    page.id !== databasePageId
  )
    throw invalidPurposeReply("database:read");
  return value as DatabaseReadSnapshot;
}

/** database:load returns the same projection shape with every record bound
 * to the requested owner; the viewer keeps its own all-records owner fence. */
function decodeDatabaseProjection(
  value: unknown,
  databasePageId: string,
): DatabaseProjection {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !databaseProjectionShape(value, databasePageId)
  )
    throw invalidPurposeReply("database:load");
  return value as DatabaseProjection;
}

/** record:read is the atomic Page + membership pair: both halves must carry
 * the requested pageId. The payload's owner is data for the caller's
 * captured-owner validator, never an authority installed here. */
function decodeRecordRead(value: unknown, pageId: string): RecordReadSnapshot {
  const snapshot = ownRecord(value);
  const page = ownRecord(snapshot?.page);
  if (
    snapshot === null ||
    page === null ||
    !ownPlainData(value) ||
    !snapshotPage(snapshot.page) ||
    page.kind !== "page" ||
    !snapshotRecord(snapshot.record) ||
    page.id !== pageId ||
    ownRecord(snapshot.record)?.pageId !== pageId
  )
    throw invalidPurposeReply("record:read");
  return value as RecordReadSnapshot;
}

/** Non-empty own identifier the producers echo back from the operation. */
const identifier = (value: unknown): boolean =>
  typeof value === "string" && value.length > 0;

/** Every operation receipt carries the producer's SHA-256 operation hash. */
const hexFingerprint = (value: unknown): boolean =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Operation seq is a positive safe integer; owner revisions and producer
 * counts are non-negative safe integers. */
const safeSeq = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const safeCount = (value: unknown): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const operationStatus = (value: unknown): boolean =>
  value === "applied" || value === "rejected" || value === "unknown";

/** Record cell / FilterValue payloads the producers can carry. */
const scalarCell = (value: unknown): boolean =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/** Fields every save/database/structural receipt echoes from the operation:
 * status union, identity, session, seq, fingerprint and an optional message. */
function receiptIdentity(record: Record<string, unknown>): boolean {
  return (
    operationStatus(record.status) &&
    identifier(record.operationId) &&
    identifier(record.sessionId) &&
    safeSeq(record.seq) &&
    hexFingerprint(record.fingerprint) &&
    (record.message === undefined || typeof record.message === "string")
  );
}

/** DatabaseProperty wire shape: id/name plus the five-type union and an
 * optional string options list. */
function propertyShape(value: unknown): boolean {
  const property = ownRecord(value);
  if (property === null) return false;
  if (!identifier(property.id) || typeof property.name !== "string") return false;
  if (
    property.type !== "text" &&
    property.type !== "number" &&
    property.type !== "checkbox" &&
    property.type !== "date" &&
    property.type !== "select"
  )
    return false;
  if (property.options !== undefined) {
    const options = ownArray(property.options);
    if (options === null || options.some((entry) => typeof entry !== "string"))
      return false;
  }
  return true;
}

/** The five-member change union carried by property previews and commands. */
function propertyChangeShape(value: unknown): boolean {
  const change = ownRecord(value);
  if (change === null) return false;
  if (change.kind === "add") return propertyShape(change.property);
  if (change.kind === "rename")
    return identifier(change.propertyId) && typeof change.name === "string";
  if (change.kind === "remove") return identifier(change.propertyId);
  if (change.kind === "reorder") {
    const propertyIds = ownArray(change.propertyIds);
    return propertyIds !== null && propertyIds.every((entry) => identifier(entry));
  }
  if (change.kind === "changeType") {
    const type = change.type;
    if (
      !identifier(change.propertyId) ||
      (type !== "text" && type !== "number" && type !== "checkbox" &&
        type !== "date" && type !== "select")
    )
      return false;
    if (change.options === undefined) return true;
    const options = ownArray(change.options);
    return options !== null && options.every((entry) => typeof entry === "string");
  }
  return false;
}

/** A completed preview's frozen command: owner, baseline revision, the change,
 * per-record revisions and the preview hash. */
function propertyCommandShape(value: unknown): boolean {
  const command = ownRecord(value);
  if (command === null) return false;
  if (!identifier(command.databasePageId) || !safeCount(command.revision))
    return false;
  if (!propertyChangeShape(command.change)) return false;
  const recordRevisions = ownArray(command.recordRevisions);
  if (recordRevisions === null) return false;
  for (const entry of recordRevisions) {
    const item = ownRecord(entry);
    if (item === null || !identifier(item.pageId) || !safeCount(item.revision))
      return false;
  }
  return hexFingerprint(command.previewHash);
}

/** Per-view/per-record preview issue with its required message. */
function propertyIssueShape(value: unknown): boolean {
  const issue = ownRecord(value);
  if (issue === null || typeof issue.message !== "string") return false;
  return (
    (issue.pageId === undefined || typeof issue.pageId === "string") &&
    (issue.title === undefined || typeof issue.title === "string") &&
    (issue.viewId === undefined || typeof issue.viewId === "string")
  );
}

/** One previewed record change: page identity, deletion marker, the optional
 * before/after scalar cells and the changed flag. */
function propertyValueChangeShape(value: unknown): boolean {
  const change = ownRecord(value);
  if (change === null) return false;
  if (
    !identifier(change.pageId) ||
    typeof change.title !== "string" ||
    typeof change.deleted !== "boolean" ||
    typeof change.changed !== "boolean"
  )
    return false;
  return (
    (change.before === undefined || scalarCell(change.before)) &&
    (change.after === undefined || scalarCell(change.after))
  );
}

/** Migration preflight issue: owning page id, optional version row, reason. */
function migrationIssueShape(value: unknown): boolean {
  const issue = ownRecord(value);
  return (
    issue !== null &&
    identifier(issue.pageId) &&
    typeof issue.reason === "string" &&
    (issue.versionId === undefined ||
      (typeof issue.versionId === "number" &&
        Number.isSafeInteger(issue.versionId) &&
        issue.versionId >= 0))
  );
}

/** The verified pre-change property backup descriptor the producer emits. */
function propertyBackupShape(value: unknown): boolean {
  const backup = ownRecord(value);
  return (
    backup !== null &&
    identifier(backup.path) &&
    hexFingerprint(backup.sha256) &&
    backup.verified === true
  );
}

/** One applied record pair: full record Page plus its membership projection. */
function recordPairShape(value: unknown): boolean {
  const pair = ownRecord(value);
  return (
    pair !== null && snapshotPage(pair.page) && snapshotRecord(pair.record)
  );
}

/** save:commit/save:resolve echo the retained operation's receipt fields plus
 * the optional applied Page and record projection. Structural check only —
 * operation/fingerprint matching stays with the reliable exchange. */
function decodeSaveResult(
  value: unknown,
  requestType: "save:commit" | "save:resolve",
): SaveResult {
  const result = ownRecord(value);
  if (
    result === null ||
    !ownPlainData(value) ||
    !receiptIdentity(result) ||
    !identifier(result.pageId) ||
    (result.page !== undefined && !snapshotPage(result.page)) ||
    (result.record !== undefined && !snapshotRecord(result.record))
  )
    throw invalidPurposeReply(requestType);
  return value as SaveResult;
}

/** database:commit/database:resolve carry the same receipt fields, the
 * command-kind union and the optional Page/record/projection payload. */
function decodeDatabaseOperationResult(
  value: unknown,
  requestType: "database:commit" | "database:resolve",
): DatabaseOperationResult {
  const result = ownRecord(value);
  if (
    result === null ||
    !ownPlainData(value) ||
    !receiptIdentity(result) ||
    (result.commandKind !== "createDatabase" &&
      result.commandKind !== "createRecord" &&
      result.commandKind !== "updateDatabase") ||
    (result.page !== undefined && !snapshotPage(result.page)) ||
    (result.record !== undefined && !snapshotRecord(result.record)) ||
    (result.database !== undefined &&
      !databaseProjectionShape(result.database))
  )
    throw invalidPurposeReply(requestType);
  return value as DatabaseOperationResult;
}

/** migration:preview is read-only preflight data: owner id, title, revision,
 * source fingerprint, applicability, the two record counts and issues. */
function decodeMigrationPreview(value: unknown): LegacyMigrationPreview {
  const preview = ownRecord(value);
  const issues = ownArray(preview?.issues);
  if (
    preview === null ||
    issues === null ||
    !ownPlainData(value) ||
    !identifier(preview.databasePageId) ||
    typeof preview.title !== "string" ||
    !safeCount(preview.revision) ||
    !hexFingerprint(preview.sourceFingerprint) ||
    typeof preview.canApply !== "boolean" ||
    !safeCount(preview.currentRecords) ||
    !safeCount(preview.historicalRecords) ||
    issues.some((issue) => !migrationIssueShape(issue))
  )
    throw invalidPurposeReply("migration:preview");
  return value as LegacyMigrationPreview;
}

/** migration:commit/migration:resolve echo the receipt fields and owner id
 * plus the optional applied Page/projection, snapshot path and row count. The
 * wire result never carries a diagnostic: an own storageFailure slot is
 * foreign metadata, so the whole reply closes to this actual request type's
 * bounded E instead of reaching the exchange as a receipt. */
function decodeMigrationResult(
  value: unknown,
  requestType: "migration:commit" | "migration:resolve",
): LegacyMigrationResult {
  const result = ownRecord(value);
  if (
    result === null ||
    Object.hasOwn(result, "storageFailure") ||
    !ownPlainData(value) ||
    !receiptIdentity(result) ||
    !identifier(result.databasePageId) ||
    (result.page !== undefined && !snapshotPage(result.page)) ||
    (result.database !== undefined &&
      !databaseProjectionShape(result.database)) ||
    (result.snapshotPath !== undefined &&
      typeof result.snapshotPath !== "string") ||
    (result.records !== undefined && !safeCount(result.records))
  )
    throw invalidPurposeReply(requestType);
  return value as LegacyMigrationResult;
}

/** property:preview carries the ok flag, the optional frozen command and
 * property, the per-record changes, issue/warning lists, both counts and the
 * backup requirement flag — including the business-false issue form. */
function decodePropertyPreviewResult(value: unknown): PropertyPreviewResult {
  const preview = ownRecord(value);
  const changes = ownArray(preview?.changes);
  const issues = ownArray(preview?.issues);
  const warnings = ownArray(preview?.warnings);
  if (
    preview === null ||
    changes === null ||
    issues === null ||
    warnings === null ||
    !ownPlainData(value) ||
    typeof preview.ok !== "boolean" ||
    (preview.command !== undefined && !propertyCommandShape(preview.command)) ||
    (preview.property !== undefined && !propertyShape(preview.property)) ||
    changes.some((entry) => !propertyValueChangeShape(entry)) ||
    issues.some((entry) => !propertyIssueShape(entry)) ||
    warnings.some((entry) => !propertyIssueShape(entry)) ||
    !safeCount(preview.recordCount) ||
    !safeCount(preview.changedCount) ||
    typeof preview.requiresBackup !== "boolean"
  )
    throw invalidPurposeReply("property:preview");
  return value as PropertyPreviewResult;
}

/** property:commit/property:resolve echo the receipt fields, the change-kind
 * union and owner id plus the optional Page/projection/record-pairs/backup.
 * Like the migration receipt the wire result never carries a diagnostic: an
 * own storageFailure slot is foreign metadata rejected as this request
 * type's bounded E rather than stripped into an apparent success. */
function decodePropertyOperationResult(
  value: unknown,
  requestType: "property:commit" | "property:resolve",
): PropertyOperationResult {
  const result = ownRecord(value);
  const records =
    result === null || result.records === undefined
      ? null
      : ownArray(result.records);
  if (
    result === null ||
    Object.hasOwn(result, "storageFailure") ||
    !ownPlainData(value) ||
    !receiptIdentity(result) ||
    (result.commandKind !== "add" &&
      result.commandKind !== "rename" &&
      result.commandKind !== "changeType" &&
      result.commandKind !== "remove" &&
      result.commandKind !== "reorder") ||
    !identifier(result.databasePageId) ||
    (result.page !== undefined && !snapshotPage(result.page)) ||
    (result.database !== undefined &&
      !databaseProjectionShape(result.database)) ||
    (result.records !== undefined &&
      (records === null || records.some((entry) => !recordPairShape(entry)))) ||
    (result.backup !== undefined && !propertyBackupShape(result.backup))
  )
    throw invalidPurposeReply(requestType);
  return value as PropertyOperationResult;
}

const optionalIdentifier = (value: unknown): boolean =>
  value === undefined || identifier(value);
const nullableString = (value: unknown): boolean =>
  value === null || typeof value === "string";
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

function workspaceSyncStatusShape(value: unknown): value is WorkspaceSyncWorkspaceStatus {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "receivedCursor",
      "appliedRevision",
      "generation",
      "cleanGeneration",
      "pending",
      "conflict",
    ]) &&
    safeCount(record.receivedCursor) &&
    safeCount(record.appliedRevision) &&
    safeCount(record.generation) &&
    safeCount(record.cleanGeneration) &&
    typeof record.pending === "boolean" &&
    typeof record.conflict === "boolean"
  );
}

function workspaceSyncViewShape(value: unknown): boolean {
  const record = ownRecord(value);
  if (record === null) return false;
  if (record.available === false)
    return (
      hasOnlyKeys(record, ["available", "reason"]) &&
      (record.reason === "not-connected" || record.reason === "read-only")
    );
  if (record.available !== true) return false;
  return (
    hasOnlyKeys(record, [
      "available",
      "connection",
      "running",
      "lastSuccessAt",
      "lastError",
      "workspace",
    ]) &&
    (record.connection === "connected" ||
      record.connection === "connecting" ||
      record.connection === "disconnected") &&
    typeof record.running === "boolean" &&
    nullableString(record.lastSuccessAt) &&
    nullableString(record.lastError) &&
    (record.workspace === null || workspaceSyncStatusShape(record.workspace))
  );
}

const workspaceSyncRestartReason = (value: unknown): boolean =>
  value === null ||
  value === "no-staged-target" ||
  value === "target-changed" ||
  value === "unsaved-changes" ||
  value === "recovery-blocked" ||
  value === "sync-active" ||
  value === "workspace-changed" ||
  value === "conflict" ||
  value === "intent-present" ||
  value === "intent-blocked" ||
  value === "legacy-intent" ||
  value === "state-unavailable";

function workspaceSyncRestartViewShape(value: unknown): boolean {
  const record = ownRecord(value);
  if (record === null) return false;
  if (record.available === false)
    return (
      hasOnlyKeys(record, ["available", "reason"]) &&
      (record.reason === "not-connected" || record.reason === "read-only")
    );
  if (record.available !== true) return false;
  return (
    hasOnlyKeys(record, [
      "available",
      "state",
      "reservationId",
      "scheduled",
      "targetRevision",
      "canRequest",
      "canCancel",
      "reason",
    ]) &&
    (record.state === "idle" ||
      record.state === "requested" ||
      record.state === "committed" ||
      record.state === "uncertain") &&
    optionalIdentifier(record.reservationId) &&
    typeof record.scheduled === "boolean" &&
    (record.targetRevision === null || safeCount(record.targetRevision)) &&
    typeof record.canRequest === "boolean" &&
    typeof record.canCancel === "boolean" &&
    workspaceSyncRestartReason(record.reason)
  );
}

function workspaceSyncRestartActionShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, ["result", "view"]) &&
    (record.result === "prepared" ||
      record.result === "cancelled" ||
      record.result === "not-prepared" ||
      record.result === "blocked" ||
      record.result === "unavailable") &&
    workspaceSyncRestartViewShape(record.view)
  );
}

function decodeWorkspaceSyncView(
  value: unknown,
  requestType: "sync:status" | "sync:run",
): WorkspaceSyncView {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !workspaceSyncViewShape(value)
  )
    throw invalidPurposeReply(requestType);
  return value as WorkspaceSyncView;
}

function decodeWorkspaceSyncRestartView(
  value: unknown,
  requestType: "sync:restartStatus",
): WorkspaceSyncRestartView {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !workspaceSyncRestartViewShape(value)
  )
    throw invalidPurposeReply(requestType);
  return value as WorkspaceSyncRestartView;
}

function decodeWorkspaceSyncRestartAction(
  value: unknown,
  requestType: "sync:restartRequest" | "sync:restartCancel",
): WorkspaceSyncRestartAction {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !workspaceSyncRestartActionShape(value)
  )
    throw invalidPurposeReply(requestType);
  return value as WorkspaceSyncRestartAction;
}

function syncConnectionTargetShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, ["baseUrl", "workspaceId", "clientId", "mode"]) &&
    identifier(record.baseUrl) &&
    identifier(record.workspaceId) &&
    identifier(record.clientId) &&
    (record.mode === "publish" ||
      record.mode === "join" ||
      record.mode === "recover")
  );
}

const syncConnectionReason = (value: unknown): boolean =>
  value === null ||
  value === "read-only" ||
  value === "recovery-copy-held" ||
  value === "secure-store-unavailable" ||
  value === "identity-changed" ||
  value === "recovery-copy-required" ||
  value === "busy" ||
  value === "intent-present" ||
  value === "conflict" ||
  value === "invalid-input" ||
  value === "outcome-unknown" ||
  value === "local-error";

function syncConnectionViewShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "state",
      "revision",
      "target",
      "hasCredential",
      "reason",
    ]) &&
    (record.state === "unconfigured" ||
      record.state === "configured" ||
      record.state === "pending-restart" ||
      record.state === "disabled" ||
      record.state === "held") &&
    (record.revision === null || identifier(record.revision)) &&
    (record.target === null || syncConnectionTargetShape(record.target)) &&
    typeof record.hasCredential === "boolean" &&
    syncConnectionReason(record.reason)
  );
}

function syncConnectionActionShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, ["outcome", "view"]) &&
    (record.outcome === "saved" ||
      record.outcome === "disabled" ||
      record.outcome === "held" ||
      record.outcome === "outcome-unknown") &&
    syncConnectionViewShape(record.view)
  );
}

function decodeSyncConnectionView(
  value: unknown,
  requestType: "sync:connectionStatus",
): SyncConnectionView {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !syncConnectionViewShape(value)
  )
    throw invalidPurposeReply(requestType);
  return value as SyncConnectionView;
}

function decodeSyncConnectionAction(
  value: unknown,
  requestType:
    | "sync:connectionResolve"
    | "sync:connectionConfigure"
    | "sync:connectionDisable",
): SyncConnectionAction {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !syncConnectionActionShape(value)
  )
    throw invalidPurposeReply(requestType);
  return value as SyncConnectionAction;
}

function decodeSyncConnectionActionOrNull(
  value: unknown,
): SyncConnectionAction | null {
  if (value === null) return null;
  return decodeSyncConnectionAction(value, "sync:connectionResolve");
}

function retentionBucketShape(
  value: unknown,
  keys: readonly string[],
): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, keys) &&
    keys.every((key) =>
      key === "held"
        ? typeof record[key] === "boolean"
        : safeCount(record[key]),
    )
  );
}

function decodeSyncRetentionView(
  value: unknown,
  requestType: "sync:retentionStatus",
): SyncRetentionView {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, ["queue", "backups", "held"]) ||
    (record.queue !== null &&
      !retentionBucketShape(record.queue, [
        "rows",
        "bytes",
        "maxRows",
        "maxBytes",
        "held",
      ])) ||
    (record.backups !== null &&
      !retentionBucketShape(record.backups, [
        "generations",
        "bytes",
        "held",
      ])) ||
    !nullableString(record.held)
  )
    throw invalidPurposeReply(requestType);
  return value as SyncRetentionView;
}

const transferEntryState = (value: unknown): boolean =>
  value === "active" ||
  value === "blocked" ||
  value === "completed" ||
  value === "releasing" ||
  value === "empty-scope" ||
  value === "unknown";

function transferMaintenanceEntryShape(value: unknown): value is TransferMaintenanceEntry {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "entryId",
      "scopeHash",
      "assetId",
      "bytes",
      "offset",
      "state",
      "currentScope",
      "canRelease",
      "reason",
      "operationId",
    ]) &&
    identifier(record.entryId) &&
    identifier(record.scopeHash) &&
    (record.assetId === null || typeof record.assetId === "string") &&
    safeCount(record.bytes) &&
    safeCount(record.offset) &&
    transferEntryState(record.state) &&
    typeof record.currentScope === "boolean" &&
    typeof record.canRelease === "boolean" &&
    nullableString(record.reason) &&
    optionalIdentifier(record.operationId)
  );
}

function decodeTransferMaintenanceView(
  value: unknown,
  requestType: "sync:transferInventory",
): TransferMaintenanceView {
  const record = ownRecord(value);
  const entries = ownArray(record?.entries);
  if (
    record === null ||
    entries === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, [
      "entries",
      "nextCursor",
      "usedBytes",
      "overLimit",
      "held",
    ]) ||
    entries.some((entry) => !transferMaintenanceEntryShape(entry)) ||
    !nullableString(record.nextCursor) ||
    !safeCount(record.usedBytes) ||
    typeof record.overLimit !== "boolean" ||
    !nullableString(record.held)
  )
    throw invalidPurposeReply(requestType);
  return value as TransferMaintenanceView;
}

function decodeTransferReleasePlanView(
  value: unknown,
  requestType: "sync:transferPlan",
): TransferReleasePlanView {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, ["operationId", "entry", "expiresAt"]) ||
    !identifier(record.operationId) ||
    !transferMaintenanceEntryShape(record.entry) ||
    !time(record.expiresAt)
  )
    throw invalidPurposeReply(requestType);
  return value as TransferReleasePlanView;
}

function decodeTransferReleaseResult(
  value: unknown,
  requestType: "sync:transferRelease" | "sync:transferResolve",
): TransferReleaseResult {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, [
      "operationId",
      "outcome",
      "releasedBytes",
      "reason",
    ]) ||
    !identifier(record.operationId) ||
    (record.outcome !== "released" &&
      record.outcome !== "held" &&
      record.outcome !== "outcome-unknown") ||
    !safeCount(record.releasedBytes) ||
    !nullableString(record.reason)
  )
    throw invalidPurposeReply(requestType);
  return value as TransferReleaseResult;
}

/** pageSource is the stored original source text verbatim — an empty
 * document is a legal value and is never treated as a failure or filled.
 * Anything else, including an absent value slot, fails closed. */
function decodePageSource(value: unknown): string {
  if (typeof value !== "string") throw invalidPurposeReply("pageSource");
  return value;
}

/** export returns the authorized destination display path, or null when the
 * picker is cancelled; anything else fails closed. */
function decodeExportPath(value: unknown): string | null {
  if (value !== null && typeof value !== "string")
    throw invalidPurposeReply("export");
  return value;
}

/** storage:rawSalvage returns the closed three-field partial-output
 * descriptor, or null when the picker is cancelled. */
function decodeRawSalvageResult(value: unknown): RawSalvageResult | null {
  if (value === null) return null;
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, ["directory", "files", "bytes"]) ||
    !identifier(record.directory) ||
    !safeCount(record.files) ||
    !safeCount(record.bytes)
  )
    throw invalidPurposeReply("storage:rawSalvage");
  return value as RawSalvageResult;
}

/** storage:pressure carries the producer's snapshot: the ready/blocked/
 * unknown state union, the ISO checkedAt string, a nullable availableBytes
 * and the two byte counts, plus the optional fixed reason code. */
function decodeStoragePressure(value: unknown): StoragePressureSnapshot {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, [
      "state",
      "checkedAt",
      "availableBytes",
      "reserveBytes",
      "additionalBytes",
      "reason",
    ]) ||
    (record.state !== "ready" &&
      record.state !== "blocked" &&
      record.state !== "unknown") ||
    typeof record.checkedAt !== "string" ||
    (record.availableBytes !== null && !safeCount(record.availableBytes)) ||
    !safeCount(record.reserveBytes) ||
    !safeCount(record.additionalBytes) ||
    (record.reason !== undefined && typeof record.reason !== "string")
  )
    throw invalidPurposeReply("storage:pressure");
  return value as StoragePressureSnapshot;
}

/** Candidate summaries are closed producer shapes: the local candidate always
 * carries its checkpoint hash while the remote head may legitimately carry a
 * null hash (revision-0 head). Each field is asserted independently; stale
 * identity matching stays with the caller's exact target. */
function conflictCandidateSummaryShape(
  value: unknown,
  side: "local" | "remote",
): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "side",
      "revision",
      "checkpointHash",
      "pages",
      "assets",
      "bytes",
    ]) &&
    record.side === side &&
    safeCount(record.revision) &&
    (side === "local"
      ? hexFingerprint(record.checkpointHash)
      : record.checkpointHash === null ||
        hexFingerprint(record.checkpointHash)) &&
    safeCount(record.pages) &&
    safeCount(record.assets) &&
    safeCount(record.bytes)
  );
}

/** The inspection's status subset mirrors the producer's read-state fields —
 * five own keys only, never the sync view's conflict flag. */
function conflictInspectionStatusShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "receivedCursor",
      "appliedRevision",
      "generation",
      "cleanGeneration",
      "pending",
    ]) &&
    safeCount(record.receivedCursor) &&
    safeCount(record.appliedRevision) &&
    safeCount(record.generation) &&
    safeCount(record.cleanGeneration) &&
    typeof record.pending === "boolean"
  );
}

function conflictInspectionShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "operationId",
      "localGeneration",
      "status",
      "local",
      "remote",
    ]) &&
    identifier(record.operationId) &&
    safeCount(record.localGeneration) &&
    conflictInspectionStatusShape(record.status) &&
    conflictCandidateSummaryShape(record.local, "local") &&
    conflictCandidateSummaryShape(record.remote, "remote")
  );
}

/** Archive summaries keep the producer's nullable descriptor fields: an
 * unverifiable archive still reports id/identity/kind/createdAt/bytes. */
function conflictArchiveSummaryShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "id",
      "operationId",
      "kind",
      "createdAt",
      "checkpointHash",
      "pages",
      "assets",
      "bytes",
      "valid",
    ]) &&
    safeCount(record.id) &&
    identifier(record.operationId) &&
    typeof record.kind === "string" &&
    time(record.createdAt) &&
    (record.checkpointHash === null ||
      hexFingerprint(record.checkpointHash)) &&
    (record.pages === null || safeCount(record.pages)) &&
    (record.assets === null || safeCount(record.assets)) &&
    (record.bytes === null || safeCount(record.bytes)) &&
    typeof record.valid === "boolean"
  );
}

function workspaceConflictViewShape(value: unknown): boolean {
  const record = ownRecord(value);
  if (record === null) return false;
  if (record.available === false)
    return (
      hasOnlyKeys(record, ["available", "reason"]) &&
      (record.reason === "not-connected" || record.reason === "read-only")
    );
  if (record.available !== true) return false;
  const archives = ownArray(record.archives);
  return (
    hasOnlyKeys(record, [
      "available",
      "conflict",
      "archives",
      "archiveCount",
    ]) &&
    (record.conflict === null || conflictInspectionShape(record.conflict)) &&
    archives !== null &&
    archives.every((entry) => conflictArchiveSummaryShape(entry)) &&
    safeCount(record.archiveCount)
  );
}

function decodeWorkspaceConflictView(value: unknown): WorkspaceConflictView {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !workspaceConflictViewShape(value)
  )
    throw invalidPurposeReply("sync:conflict");
  return value as WorkspaceConflictView;
}

/** sync:conflictCandidate returns the exact candidate snapshot: side union,
 * revision, nullable checkpoint hash/JSON and the byte count — an absent
 * checkpoint is legal data, never a failure to synthesize. */
function decodeWorkspaceConflictCandidateSnapshot(
  value: unknown,
): WorkspaceConflictCandidateSnapshot {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, [
      "operationId",
      "side",
      "revision",
      "checkpointHash",
      "checkpointJson",
      "bytes",
    ]) ||
    !identifier(record.operationId) ||
    (record.side !== "local" && record.side !== "remote") ||
    !safeCount(record.revision) ||
    (record.checkpointHash !== null &&
      !hexFingerprint(record.checkpointHash)) ||
    (record.checkpointJson !== null &&
      typeof record.checkpointJson !== "string") ||
    !safeCount(record.bytes)
  )
    throw invalidPurposeReply("sync:conflictCandidate");
  return value as WorkspaceConflictCandidateSnapshot;
}

/** sync:conflictExport returns the authorized destination display path, or
 * null when the picker is cancelled; anything else fails closed and is never
 * resent or turned into a receipt. */
function decodeConflictExportPath(value: unknown): string | null {
  if (value !== null && typeof value !== "string")
    throw invalidPurposeReply("sync:conflictExport");
  return value;
}

const conflictChoice = (value: unknown): boolean =>
  value === "local" || value === "remote";

const conflictDecisionReason = (value: unknown): boolean =>
  value === null ||
  value === "read-only" ||
  value === "not-connected" ||
  value === "unsaved-input" ||
  value === "busy" ||
  value === "other-intent" ||
  value === "target-changed" ||
  value === "state-unavailable";

function conflictDecisionViewShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "state",
      "decisionId",
      "choice",
      "canPreview",
      "canCancel",
      "reason",
    ]) &&
    (record.state === "idle" ||
      record.state === "requested" ||
      record.state === "pending" ||
      record.state === "consumed" ||
      record.state === "cancelled" ||
      record.state === "blocked") &&
    (record.decisionId === null || identifier(record.decisionId)) &&
    (record.choice === null || conflictChoice(record.choice)) &&
    typeof record.canPreview === "boolean" &&
    typeof record.canCancel === "boolean" &&
    conflictDecisionReason(record.reason)
  );
}

function decodeConflictDecisionView(
  value: unknown,
  requestType: "sync:conflictDecisionStatus",
): ConflictDecisionView {
  if (
    ownRecord(value) === null ||
    !ownPlainData(value) ||
    !conflictDecisionViewShape(value)
  )
    throw invalidPurposeReply(requestType);
  return value as ConflictDecisionView;
}

/** The resolution target's identity fields follow the producer's own id
 * alphabet; the six counters and three hash slots are exactly as emitted. */
const conflictIdentityId = (value: unknown): boolean =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

function conflictResolutionTargetShape(value: unknown): boolean {
  const record = ownRecord(value);
  return (
    record !== null &&
    hasOnlyKeys(record, [
      "version",
      "choice",
      "workspaceId",
      "clientId",
      "bindingId",
      "serverEpoch",
      "operationId",
      "localRevision",
      "localCheckpointHash",
      "remoteRevision",
      "remoteCheckpointHash",
      "conflictGeneration",
      "generation",
      "cleanGeneration",
      "appliedRevision",
      "receivedCursor",
      "latestCheckpointHash",
    ]) &&
    record.version === 1 &&
    conflictChoice(record.choice) &&
    conflictIdentityId(record.workspaceId) &&
    conflictIdentityId(record.clientId) &&
    conflictIdentityId(record.bindingId) &&
    conflictIdentityId(record.serverEpoch) &&
    conflictIdentityId(record.operationId) &&
    safeCount(record.localRevision) &&
    hexFingerprint(record.localCheckpointHash) &&
    safeCount(record.remoteRevision) &&
    (record.remoteCheckpointHash === null ||
      hexFingerprint(record.remoteCheckpointHash)) &&
    safeCount(record.conflictGeneration) &&
    safeCount(record.generation) &&
    safeCount(record.cleanGeneration) &&
    safeCount(record.appliedRevision) &&
    safeCount(record.receivedCursor) &&
    hexFingerprint(record.latestCheckpointHash)
  );
}

/** sync:conflictPreview carries the issued preview id, the frozen resolution
 * target, both checkpoint JSON slots and the two latest-content counts. */
function decodeConflictDecisionPreview(
  value: unknown,
): ConflictDecisionPreview {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, [
      "id",
      "target",
      "latestCheckpointJson",
      "remoteCheckpointJson",
      "latestPages",
      "latestAssets",
    ]) ||
    !identifier(record.id) ||
    !conflictResolutionTargetShape(record.target) ||
    typeof record.latestCheckpointJson !== "string" ||
    (record.remoteCheckpointJson !== null &&
      typeof record.remoteCheckpointJson !== "string") ||
    !safeCount(record.latestPages) ||
    !safeCount(record.latestAssets)
  )
    throw invalidPurposeReply("sync:conflictPreview");
  return value as ConflictDecisionPreview;
}

/** sync:conflictConfirm/sync:conflictCancel echo the result union plus the
 * current decision view — the view itself must be the producer's own shape. */
function decodeConflictDecisionAction(
  value: unknown,
  requestType: "sync:conflictConfirm" | "sync:conflictCancel",
): ConflictDecisionAction {
  const record = ownRecord(value);
  if (
    record === null ||
    !ownPlainData(value) ||
    !hasOnlyKeys(record, ["result", "view"]) ||
    (record.result !== "requested" &&
      record.result !== "cancelled" &&
      record.result !== "blocked") ||
    !conflictDecisionViewShape(record.view)
  )
    throw invalidPurposeReply(requestType);
  return value as ConflictDecisionAction;
}

/** The preload exposes the shared bridge as the existing SharedRuntimeAPI or
 * leaves it absent; anything that is not an object with a callable request is
 * treated as unavailable and passed through untouched as undefined. */
function boundSharedRuntime(
  bridge: Pick<FolioAPI, "requestDiagnostic" | "shared">,
): SharedRuntimeAPI | undefined {
  try {
    const shared = bridge.shared;
    if (shared === undefined || shared === null || typeof shared !== "object")
      return undefined;
    return typeof shared.request === "function" ? shared : undefined;
  } catch {
    return undefined;
  }
}

/** One-time desktop root factory. It never invokes the bridge, never falls
 * back to the legacy channel and never throws synchronously on a missing or
 * old preload: every method and the compatibility transport fail closed as a
 * bounded E at the actual call. The bridge itself is neither wrapped nor
 * cloned; the shared object keeps its identity. */
export function createDesktopRootBindings(
  bridge: Pick<FolioAPI, "requestDiagnostic" | "shared"> | undefined,
): DesktopRootBindings {
  const request = createDiagnosticRequest(
    bridge === undefined
      ? undefined
      : (input: Request) => bridge.requestDiagnostic(input),
  );
  const workspace: WorkspaceReadPort = {
    startupStatus: () =>
      request<unknown>({ type: "startup:status" })
        .then(decodeStartupStatus)
        .catch((error: unknown) => {
          throw toStorageFailureError(error, "startup:status");
        }),
    load: () =>
      request<unknown>({ type: "load" })
        .then(decodeSnapshot)
        .catch((error: unknown) => {
          throw toStorageFailureError(error, "load");
        }),
    readDatabase: (databasePageId: string) =>
      request<DatabaseReadSnapshot>(
        { type: "database:read", databasePageId },
        (value: unknown) => decodeDatabaseReadSnapshot(value, databasePageId),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "database:read");
      }),
    loadDatabase: (databasePageId: string) =>
      request<DatabaseProjection>(
        { type: "database:load", databasePageId },
        (value: unknown) => decodeDatabaseProjection(value, databasePageId),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "database:load");
      }),
    readRecord: (pageId: string) =>
      request<RecordReadSnapshot>(
        { type: "record:read", pageId },
        (value: unknown) => decodeRecordRead(value, pageId),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "record:read");
      }),
  };
  const editing: EditingPort = {
    commitSave: (operation: SaveOperation) =>
      request<SaveResult>({ type: "save:commit", operation }, (value: unknown) =>
        decodeSaveResult(value, "save:commit"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "save:commit");
      }),
    resolveSave: (operation: SaveOperation) =>
      request<SaveResult>({ type: "save:resolve", operation }, (value: unknown) =>
        decodeSaveResult(value, "save:resolve"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "save:resolve");
      }),
    commitDatabase: (operation: DatabaseOperation) =>
      request<DatabaseOperationResult>(
        { type: "database:commit", operation },
        (value: unknown) => decodeDatabaseOperationResult(value, "database:commit"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "database:commit");
      }),
    resolveDatabase: (operation: DatabaseOperation) =>
      request<DatabaseOperationResult>(
        { type: "database:resolve", operation },
        (value: unknown) => decodeDatabaseOperationResult(value, "database:resolve"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "database:resolve");
      }),
  };
  const structure: StructurePort = {
    previewMigration: (databasePageId: string) =>
      request<LegacyMigrationPreview>(
        { type: "migration:preview", databasePageId },
        decodeMigrationPreview,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "migration:preview");
      }),
    previewProperty: (
      databasePageId: string,
      revision: number,
      change: PropertyChange,
    ) =>
      request<PropertyPreviewResult>(
        { type: "property:preview", databasePageId, revision, change },
        decodePropertyPreviewResult,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "property:preview");
      }),
    commitMigration: (operation: LegacyMigrationOperation) =>
      request<LegacyMigrationResult>(
        { type: "migration:commit", operation },
        (value: unknown) => decodeMigrationResult(value, "migration:commit"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "migration:commit");
      }),
    resolveMigration: (operation: LegacyMigrationOperation) =>
      request<LegacyMigrationResult>(
        { type: "migration:resolve", operation },
        (value: unknown) => decodeMigrationResult(value, "migration:resolve"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "migration:resolve");
      }),
    commitProperty: (operation: PropertyOperation) =>
      request<PropertyOperationResult>(
        { type: "property:commit", operation },
        (value: unknown) => decodePropertyOperationResult(value, "property:commit"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "property:commit");
      }),
    resolveProperty: (operation: PropertyOperation) =>
      request<PropertyOperationResult>(
        { type: "property:resolve", operation },
        (value: unknown) => decodePropertyOperationResult(value, "property:resolve"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "property:resolve");
      }),
  };
  const sync: SyncControlPort = {
    status: () =>
      request<WorkspaceSyncView>({ type: "sync:status" }, (value: unknown) =>
        decodeWorkspaceSyncView(value, "sync:status"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:status");
      }),
    restartStatus: () =>
      request<WorkspaceSyncRestartView>(
        { type: "sync:restartStatus" },
        (value: unknown) => decodeWorkspaceSyncRestartView(value, "sync:restartStatus"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:restartStatus");
      }),
    restartRequest: () =>
      request<WorkspaceSyncRestartAction>(
        { type: "sync:restartRequest" },
        (value: unknown) => decodeWorkspaceSyncRestartAction(value, "sync:restartRequest"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:restartRequest");
      }),
    restartCancel: (reservationId?: string) =>
      request<WorkspaceSyncRestartAction>(
        reservationId === undefined
          ? { type: "sync:restartCancel" }
          : { type: "sync:restartCancel", reservationId },
        (value: unknown) => decodeWorkspaceSyncRestartAction(value, "sync:restartCancel"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:restartCancel");
      }),
    run: () =>
      request<WorkspaceSyncView>({ type: "sync:run" }, (value: unknown) =>
        decodeWorkspaceSyncView(value, "sync:run"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:run");
      }),
    connectionStatus: () =>
      request<SyncConnectionView>({ type: "sync:connectionStatus" }, (value: unknown) =>
        decodeSyncConnectionView(value, "sync:connectionStatus"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:connectionStatus");
      }),
    transferInventory: (cursor?: string) =>
      request<TransferMaintenanceView>(
        cursor === undefined
          ? { type: "sync:transferInventory" }
          : { type: "sync:transferInventory", cursor },
        (value: unknown) => decodeTransferMaintenanceView(value, "sync:transferInventory"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:transferInventory");
      }),
    retention: () =>
      request<SyncRetentionView>({ type: "sync:retentionStatus" }, (value: unknown) =>
        decodeSyncRetentionView(value, "sync:retentionStatus"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:retentionStatus");
      }),
    connectionResolve: (requestId: string) =>
      request<SyncConnectionAction | null>(
        { type: "sync:connectionResolve", requestId },
        decodeSyncConnectionActionOrNull,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:connectionResolve");
      }),
    connectionConfigure: (input: SyncConnectionInput) =>
      request<SyncConnectionAction>(
        { type: "sync:connectionConfigure", input },
        (value: unknown) => decodeSyncConnectionAction(value, "sync:connectionConfigure"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:connectionConfigure");
      }),
    connectionDisable: (requestId: string, expectedRevision: string | null) =>
      request<SyncConnectionAction>(
        { type: "sync:connectionDisable", requestId, expectedRevision },
        (value: unknown) => decodeSyncConnectionAction(value, "sync:connectionDisable"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:connectionDisable");
      }),
    transferPlan: (entryId: string) =>
      request<TransferReleasePlanView>(
        { type: "sync:transferPlan", entryId },
        (value: unknown) => decodeTransferReleasePlanView(value, "sync:transferPlan"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:transferPlan");
      }),
    transferRelease: (operationId: string) =>
      request<TransferReleaseResult>(
        { type: "sync:transferRelease", operationId },
        (value: unknown) => decodeTransferReleaseResult(value, "sync:transferRelease"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:transferRelease");
      }),
    transferResolve: (operationId: string) =>
      request<TransferReleaseResult>(
        { type: "sync:transferResolve", operationId },
        (value: unknown) => decodeTransferReleaseResult(value, "sync:transferResolve"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:transferResolve");
      }),
  };
  const original: OriginalReadPort = {
    exportWorkspaceMarkdown: () => request<string | null>({type: "exportWorkspaceMarkdown"}, decodeExportPath)
      .catch((error: unknown) => { throw toStorageFailureError(error, "exportWorkspaceMarkdown"); }),
    readOriginal: (pageId: string) =>
      request<string>({ type: "pageSource", id: pageId }, decodePageSource).catch(
        (error: unknown) => {
          throw toStorageFailureError(error, "pageSource");
        },
      ),
    exportOriginal: (input: { name: string; content: string }) =>
      request<string | null>(
        {
          type: "export",
          name: input.name,
          format: "json",
          content: input.content,
        },
        decodeExportPath,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "export");
      }),
  };
  const recovery: RecoverySalvagePort = {
    salvageRaw: () =>
      request<RawSalvageResult | null>(
        { type: "storage:rawSalvage" },
        decodeRawSalvageResult,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "storage:rawSalvage");
      }),
  };
  /** The capability table is descriptive metadata: any acquisition or
   * validation failure closes to the fixed null (information unavailable)
   * through the existing strict parser — never an all-provided table, never
   * a fabricated success. */
  const capabilities: CapabilitiesReadPort = {
    read: () =>
      request<DesktopCapabilities | null>(
        { type: "desktop:capabilities" },
        (value: unknown) => parseDesktopCapabilities(value),
      ).catch(() => null),
  };
  const storage: StorageReadPort = {
    readPressure: () =>
      request<StoragePressureSnapshot>(
        { type: "storage:pressure" },
        decodeStoragePressure,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "storage:pressure");
      }),
  };
  const decision: ConflictDecisionPort = {
    status: () =>
      request<ConflictDecisionView>(
        { type: "sync:conflictDecisionStatus" },
        (value: unknown) =>
          decodeConflictDecisionView(value, "sync:conflictDecisionStatus"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:conflictDecisionStatus");
      }),
    preview: (input: ConflictPreviewRequest) =>
      request<ConflictDecisionPreview>(
        {
          type: "sync:conflictPreview",
          choice: input.choice,
          operationId: input.operationId,
          expectedLocalHash: input.expectedLocalHash,
          expectedRemoteRevision: input.expectedRemoteRevision,
          expectedRemoteHash: input.expectedRemoteHash,
        },
        decodeConflictDecisionPreview,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:conflictPreview");
      }),
    confirm: (previewId: string) =>
      request<ConflictDecisionAction>(
        { type: "sync:conflictConfirm", previewId },
        (value: unknown) =>
          decodeConflictDecisionAction(value, "sync:conflictConfirm"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:conflictConfirm");
      }),
    cancel: (decisionId: string) =>
      request<ConflictDecisionAction>(
        { type: "sync:conflictCancel", decisionId },
        (value: unknown) =>
          decodeConflictDecisionAction(value, "sync:conflictCancel"),
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:conflictCancel");
      }),
  };
  const conflict: WorkspaceConflictPort = {
    inspect: () =>
      request<WorkspaceConflictView>(
        { type: "sync:conflict" },
        decodeWorkspaceConflictView,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:conflict");
      }),
    readCandidate: (target: WorkspaceConflictCandidateTarget) =>
      request<WorkspaceConflictCandidateSnapshot>(
        {
          type: "sync:conflictCandidate",
          operationId: target.operationId,
          side: target.side,
          expectedRevision: target.expectedRevision,
          expectedCheckpointHash: target.expectedCheckpointHash,
        },
        decodeWorkspaceConflictCandidateSnapshot,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:conflictCandidate");
      }),
    exportCandidate: (target: WorkspaceConflictCandidateTarget) =>
      request<string | null>(
        {
          type: "sync:conflictExport",
          operationId: target.operationId,
          side: target.side,
          expectedRevision: target.expectedRevision,
          expectedCheckpointHash: target.expectedCheckpointHash,
        },
        decodeConflictExportPath,
      ).catch((error: unknown) => {
        throw toStorageFailureError(error, "sync:conflictExport");
      }),
    decision,
  };
  const readOnly: ReadOnlyAppApi = { workspace, original, recovery, capabilities };
  const writable: AppApi = {
    workspace,
    original,
    recovery,
    capabilities,
    editing,
    structure,
    sync,
    shared: bridge === undefined ? undefined : boundSharedRuntime(bridge),
    storage,
    conflict,
  };
  return { readOnly, writable, compatibility: { request } };
}
