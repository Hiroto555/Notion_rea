import { SyncError } from "../sync/protocol";
import { safeSyncErrorCode } from "./workspace-sync-errors";
import type { WorkspaceConflictArchiveSummary, WorkspaceConflictCandidateSnapshot,
  WorkspaceConflictCandidateTarget, WorkspaceConflictInspection } from "../shared/workspace-conflict-view";
import type { Change } from "../sync/protocol";
import type { SyncApplyTarget } from "./workspace-sync-intent";
import type { ConflictDecisionPreview, WorkspaceConflictResolutionTarget } from "../shared/workspace-conflict-resolution";

/** The active-window service may transfer changes, but never applies them. */
export interface WorkspaceSyncTransport<Status> {
  status(): Status | null;
  sendPending(): Promise<unknown>;
  receiveAndStage(): Promise<unknown>;
  conflictInspection?(): WorkspaceConflictInspection | null;
  conflictArchives?(limit?: number): {archives: WorkspaceConflictArchiveSummary[]; total: number};
  conflictCandidate?(target: WorkspaceConflictCandidateTarget): WorkspaceConflictCandidateSnapshot;
  restartTarget?(): SyncApplyTarget | null;
  stagedChange?(): Change | null;
  readLastSuccess?(): string | null;
  recordLastSuccess?(at: string): void;
  shouldRecordSuccess?(): boolean;
  conflictResolutionPreview?(choice: "local" | "remote"): Omit<ConflictDecisionPreview, "id">;
  assertConflictResolutionTarget?(target: WorkspaceConflictResolutionTarget): void;
}

export type WorkspaceSyncConnectionState =
  | "connected"
  | "connecting"
  | "disconnected";

/** Opens a transfer-only connection. It must not apply workspace content. */
export type WorkspaceSyncConnector<Status> = () => Promise<
  WorkspaceSyncTransport<Status>
>;

export type WorkspaceSyncServiceStatus<Status> = {
  /** Null until a manual/startup pass has opened a transport. */
  workspace: Status | null;
  connection: WorkspaceSyncConnectionState;
  running: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
};

/**
 * Main-process coordinator. Simultaneous manual/automatic requests share a
 * single pass so they cannot produce competing outbox operations. A missing
 * transport is opened at most once per pass and only when the caller asks for
 * a transfer; there is no background retry. This class deliberately has no
 * method for applying a checkpoint to the workspace.
 */
export class WorkspaceSyncService<Status> {
  private transport: WorkspaceSyncTransport<Status> | undefined;
  private inFlight: Promise<WorkspaceSyncServiceStatus<Status>> | undefined;
  private connecting: Promise<WorkspaceSyncTransport<Status>> | undefined;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private suspended = false;

  constructor(
    transport: WorkspaceSyncTransport<Status> | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly connector?: WorkspaceSyncConnector<Status>,
  ) {
    this.transport = transport;
    if (transport) this.restoreLastSuccess(transport);
  }

  /** A service that will connect only after an explicit transfer request. */
  static reconnect<Status>(
    connector: WorkspaceSyncConnector<Status>,
    now: () => Date = () => new Date(),
  ): WorkspaceSyncService<Status> {
    return new WorkspaceSyncService<Status>(undefined, now, connector);
  }

  status(): WorkspaceSyncServiceStatus<Status> {
    return {
      workspace: this.transport?.status() ?? null,
      connection: this.connectionState(),
      running: this.inFlight !== undefined,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  conflictInspection() { return this.transport?.conflictInspection?.(); }
  conflictArchives() { return this.transport?.conflictArchives?.(20); }
  conflictCandidate(target: WorkspaceConflictCandidateTarget) { return this.transport?.conflictCandidate?.(target); }
  /** Local disable stops new network work. An already sent POST may settle;
   * its durable outbox/receipt is retained for later reconciliation. */
  suspend(): void { this.suspended = true; this.lastError = "sync-disabled"; }
  isSuspended(): boolean { return this.suspended; }
  restartTarget() { return this.suspended ? null : this.transport?.restartTarget?.() ?? null; }
  stagedChange() { return this.suspended ? null : this.transport?.stagedChange?.() ?? null; }
  conflictResolutionPreview(choice: "local" | "remote") {
    if (this.suspended) throw new SyncError("sync-disabled", 409);
    const preview = this.transport?.conflictResolutionPreview?.(choice);
    if (!preview) throw new Error("sync-not-connected");
    return preview;
  }
  assertConflictResolutionTarget(target: WorkspaceConflictResolutionTarget) {
    if (this.suspended) throw new SyncError("sync-disabled", 409);
    if (!this.transport?.assertConflictResolutionTarget) throw new Error("sync-not-connected");
    this.transport.assertConflictResolutionTarget(target);
  }

  sync(): Promise<WorkspaceSyncServiceStatus<Status>> {
    if (this.inFlight) return this.inFlight;
    // Yield once so inFlight is set even if a transport throws synchronously.
    const run = Promise.resolve().then(async () => {
      try {
        this.assertActive();
        const transport = await this.transportForPass();
        this.assertActive();
        await transport.sendPending();
        this.assertActive();
        await transport.receiveAndStage();
        this.assertActive();
        if (transport.shouldRecordSuccess?.() !== false) {
          this.lastSuccessAt = this.now().toISOString();
          // The transfer already succeeded. A local history write failure must
          // not turn it into a failed transfer or discard pending data.
          try {transport.recordLastSuccess?.(this.lastSuccessAt);} catch { /* in-memory time remains */ }
        }
        this.lastError = null;
      } catch (error) {
        // Arbitrary errors may contain URLs or secrets; only expose a bounded
        // protocol code, never raw exception text or credentials.
        this.lastError = safeSyncErrorCode(error);
      } finally {
        this.inFlight = undefined;
      }
      return this.status();
    });
    this.inFlight = run;
    return run;
  }

  private connectionState(): WorkspaceSyncConnectionState {
    if (this.suspended) return "disconnected";
    if (this.transport) return "connected";
    // A pending manual pass is reported as connecting even before its first
    // microtask starts the connector.
    if (this.connecting || (this.inFlight && this.connector)) return "connecting";
    return "disconnected";
  }

  private assertActive(): void {
    if (this.suspended) throw new SyncError("sync-disabled", 409);
  }

  private restoreLastSuccess(transport: WorkspaceSyncTransport<Status>): void {
    try {
      const value = transport.readLastSuccess?.();
      if (typeof value === "string" && value.length === 24) {
        const date = new Date(value);
        if (Number.isFinite(date.getTime()) && date.toISOString() === value) this.lastSuccessAt = value;
      }
    } catch { /* History is advisory; transfers remain available. */ }
  }

  private async transportForPass(): Promise<WorkspaceSyncTransport<Status>> {
    if (this.transport) return this.transport;
    if (!this.connector) throw new SyncError("sync-not-connected", 409);
    if (!this.connecting) {
      // Concurrent requests share both the connector attempt and its result.
      this.connecting = this.connector()
        .then((transport) => {
          this.transport = transport;
          this.restoreLastSuccess(transport);
          return transport;
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    return this.connecting;
  }
}
