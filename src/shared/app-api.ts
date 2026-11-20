import type { StartupStatus } from "./startup-status";
import type { SharedRuntimeAPI } from "./shared-runtime-ipc";
import type { DesktopCapabilities } from "./desktop-capabilities";
import type { StoragePressureSnapshot } from "./storage-pressure";
import type {
  DatabaseOperation,
  DatabaseOperationResult,
  DatabaseReadSnapshot,
} from "./database-operation";
import type {
  LegacyMigrationOperation,
  LegacyMigrationPreview,
  LegacyMigrationResult,
} from "./legacy-migration-operation";
import type {
  PropertyChange,
  PropertyOperation,
  PropertyOperationResult,
  PropertyPreviewResult,
} from "./property-operation";
import type { SaveOperation, SaveResult } from "./save-contract";
import type {
  SyncConnectionAction,
  SyncConnectionInput,
  SyncConnectionView,
  SyncRetentionView,
  TransferMaintenanceView,
  TransferReleasePlanView,
  TransferReleaseResult,
} from "./sync-management";
import type {
  WorkspaceSyncRestartAction,
  WorkspaceSyncRestartView,
  WorkspaceSyncView,
} from "./workspace-sync-view";
import type {
  WorkspaceConflictCandidateSnapshot,
  WorkspaceConflictCandidateTarget,
  WorkspaceConflictView,
} from "./workspace-conflict-view";
import type {
  ConflictDecisionAction,
  ConflictDecisionPreview,
  ConflictDecisionView,
  ConflictPreviewRequest,
} from "./workspace-conflict-resolution";
import type {
  DatabaseProjection,
  Page,
  RecordProjection,
  Snapshot,
} from "./types";

/** Atomic record Page + membership projection pair produced by one
 * record:read snapshot. The caller still binds it to its own captured owner
 * through the existing owner-bound validator; this type carries no authority. */
export type RecordReadSnapshot = { page: Page; record: RecordProjection };

/** Purpose-scoped workspace read port. Each method issues exactly one fixed
 * discriminant through the bound adapter and returns the existing response
 * type; no arbitrary payload or host surface crosses this boundary. */
export interface WorkspaceReadPort {
  startupStatus(): Promise<StartupStatus>;
  load(): Promise<Snapshot>;
  /** Registered database owner Page plus its settings/record projection. */
  readDatabase(databasePageId: string): Promise<DatabaseReadSnapshot>;
  /** Read-only database projection for the registered-record viewer. */
  loadDatabase(databasePageId: string): Promise<DatabaseProjection>;
  /** Atomic record Page + membership projection for one record Page. */
  readRecord(pageId: string): Promise<RecordReadSnapshot>;
}

/** Purpose-scoped write port for the record Page save lane and the owner
 * database command lane. Each method issues exactly one fixed discriminant
 * through the bound adapter — a commit once for a fresh send and a lookup-only
 * resolve for the same retained identity — and returns the existing result
 * type. Operation/result consistency stays with the caller's exchange. */
export interface EditingPort {
  commitSave(operation: SaveOperation): Promise<SaveResult>;
  resolveSave(operation: SaveOperation): Promise<SaveResult>;
  commitDatabase(operation: DatabaseOperation): Promise<DatabaseOperationResult>;
  resolveDatabase(operation: DatabaseOperation): Promise<DatabaseOperationResult>;
}

/** Purpose-scoped port for the migration/property structural lanes. Previews
 * read a fresh baseline; commit/resolve carry the exact retained operation.
 * Each method issues one fixed discriminant and returns the existing result
 * type; no generic payload crosses this boundary. */
export interface StructurePort {
  previewMigration(databasePageId: string): Promise<LegacyMigrationPreview>;
  previewProperty(
    databasePageId: string,
    revision: number,
    change: PropertyChange,
  ): Promise<PropertyPreviewResult>;
  commitMigration(operation: LegacyMigrationOperation): Promise<LegacyMigrationResult>;
  resolveMigration(operation: LegacyMigrationOperation): Promise<LegacyMigrationResult>;
  commitProperty(operation: PropertyOperation): Promise<PropertyOperationResult>;
  resolveProperty(operation: PropertyOperation): Promise<PropertyOperationResult>;
}

/** Purpose-scoped sync status and management port. Each method issues one
 * fixed discriminant through the bound adapter and returns the existing
 * response type; no generic payload crosses this boundary. */
export interface SyncControlPort {
  status(): Promise<WorkspaceSyncView>;
  restartStatus(): Promise<WorkspaceSyncRestartView>;
  restartRequest(): Promise<WorkspaceSyncRestartAction>;
  restartCancel(reservationId?: string): Promise<WorkspaceSyncRestartAction>;
  run(): Promise<WorkspaceSyncView>;
  connectionStatus(): Promise<SyncConnectionView>;
  transferInventory(cursor?: string): Promise<TransferMaintenanceView>;
  retention(): Promise<SyncRetentionView>;
  connectionResolve(requestId: string): Promise<SyncConnectionAction | null>;
  connectionConfigure(input: SyncConnectionInput): Promise<SyncConnectionAction>;
  connectionDisable(
    requestId: string,
    expectedRevision: string | null,
  ): Promise<SyncConnectionAction>;
  transferPlan(entryId: string): Promise<TransferReleasePlanView>;
  transferRelease(operationId: string): Promise<TransferReleaseResult>;
  transferResolve(operationId: string): Promise<TransferReleaseResult>;
}

/** Partial raw-salvage output descriptor. A successful salvage reports the
 * chosen destination and the counts actually written; it is not a complete
 * restorable backup, a persistent hold or an operation outcome. */
export type RawSalvageResult = {
  directory: string;
  files: number;
  bytes: number;
};

/** Purpose-scoped original-document read and external-export port for the
 * read-only surface. readOriginal returns the stored source verbatim —
 * including an empty document — without treating empty as failure or
 * filling it. exportOriginal carries only the display name and UTF-8
 * content; the format is fixed to JSON by the port and the result is the
 * authorized destination display path, or null when the picker is
 * cancelled. Neither method writes the original. */
export interface OriginalReadPort {
  exportWorkspaceMarkdown(): Promise<string | null>;
  readOriginal(pageId: string): Promise<string>;
  exportOriginal(input: {
    name: string;
    content: string;
  }): Promise<string | null>;
}

/** Purpose-scoped port for the raw diagnostic salvage. The result is the
 * partial-output descriptor above, or null when the picker is cancelled.
 * It issues exactly one fixed discriminant per call. */
export interface RecoverySalvagePort {
  salvageRaw(): Promise<RawSalvageResult | null>;
}

/** Purpose-scoped read of the descriptive desktop-capability table. A null
 * result means the information could not be obtained; it is never an
 * authority, never availability proof and never an operation result. */
export interface CapabilitiesReadPort {
  read(): Promise<DesktopCapabilities | null>;
}

/** Writable-only storage observation port. Each call issues one fixed
 * discriminant and returns the producer's snapshot — ready, blocked or
 * unknown, with availableBytes nullable exactly as produced. */
export interface StorageReadPort {
  readPressure(): Promise<StoragePressureSnapshot>;
}

/** Purpose-scoped port for the four conflict-decision lanes. status reads the
 * current reservation view, preview takes the existing exact preview input,
 * and confirm/cancel name the same retained preview/decision id. Each method
 * issues exactly one fixed discriminant and returns the existing response
 * type; an unknown outcome is re-read through status, never resent. */
export interface ConflictDecisionPort {
  status(): Promise<ConflictDecisionView>;
  preview(request: ConflictPreviewRequest): Promise<ConflictDecisionPreview>;
  confirm(previewId: string): Promise<ConflictDecisionAction>;
  cancel(decisionId: string): Promise<ConflictDecisionAction>;
}

/** Purpose-scoped conflict inspection/read/export port plus its decision
 * subset. readCandidate/exportCandidate carry the exact observed
 * operation/side/revision/hash target; export returns the authorized
 * destination display path or null when the picker is cancelled — never a
 * resend, a receipt or a hold. */
export interface WorkspaceConflictPort {
  inspect(): Promise<WorkspaceConflictView>;
  readCandidate(
    target: WorkspaceConflictCandidateTarget,
  ): Promise<WorkspaceConflictCandidateSnapshot>;
  exportCandidate(
    target: WorkspaceConflictCandidateTarget,
  ): Promise<string | null>;
  readonly decision: ConflictDecisionPort;
}

export interface ReadOnlyAppApi {
  readonly workspace: WorkspaceReadPort;
  readonly original: OriginalReadPort;
  readonly recovery: RecoverySalvagePort;
  readonly capabilities: CapabilitiesReadPort;
}

export interface AppApi extends ReadOnlyAppApi {
  readonly editing: EditingPort;
  readonly structure: StructurePort;
  readonly sync: SyncControlPort;
  readonly shared: SharedRuntimeAPI | undefined;
  readonly storage: StorageReadPort;
  readonly conflict: WorkspaceConflictPort;
}
