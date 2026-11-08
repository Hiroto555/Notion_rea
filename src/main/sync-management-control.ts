import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../persistence/store";
import { assertRecoverySyncAllowed } from "../persistence/recovery-origin";
import { hasCrashRecoveryInput, type CrashRecoveryRead } from "../shared/crash-recovery";
import type { SyncConnectionAction, SyncConnectionInput, SyncConnectionView, SyncRetentionView } from "../shared/sync-management";
import { inspectSyncRetention } from "../sync/sync-retention";
import { inspectBackupRetention } from "../sync/backup-retention";
import { readUserVersion } from "../persistence/schema-startup";
import { requireCondition } from "../sync/protocol";
import { SyncConnectionVault } from "./sync-connection-vault";
import type { WorkspaceSyncService } from "./workspace-sync-service";
import type { WorkspaceSyncStatus } from "../sync/workspace-store";
import type { WorkspaceSyncGate } from "./workspace-sync-gate";
import type { TransferMaintenanceService } from "./transfer-maintenance-service";

const empty = (): SyncConnectionView => ({state: "unconfigured", revision: null, target: null, hasCredential: false, reason: null});
export type SyncManagementOptions = {
  store: Store; readOnly: boolean; vaultDirectory: string; vault: SyncConnectionVault;
  gate: WorkspaceSyncGate; service?: WorkspaceSyncService<WorkspaceSyncStatus>;
  recovery(): CrashRecoveryRead; intentClear(): boolean; maintenance: TransferMaintenanceService;
};
/** Main-only authorization and quiet-window boundary for management IPC. */
export class SyncManagementControl {
  constructor(private readonly options: SyncManagementOptions) {}
  private allowed(): void {
    requireCondition(!this.options.readOnly, "read-only", 409);
    assertRecoverySyncAllowed(this.options.store.db);
  }
  private quiet(): void {
    this.allowed();
    requireCondition(!this.options.service?.status().running, "sync-management-busy", 409);
    requireCondition(this.options.intentClear(), "sync-management-intent", 409);
    const recovery = this.options.recovery();
    requireCondition(recovery.status === "empty" || (recovery.status === "ready" && recovery.snapshot !== undefined &&
      !hasCrashRecoveryInput(recovery.snapshot)), "sync-management-input", 409);
  }
  private held(error: unknown): SyncConnectionView {
    const code = (error as {code?: string})?.code;
    return {...empty(), state: "held", reason: code === "read-only" ? "read-only" :
      code === "recovered-workspace-sync-held" ? "recovery-copy-held" :
      code === "sync-management-busy" ? "busy" : code === "sync-management-intent" || code === "sync-management-input" ? "intent-present" : "local-error"};
  }
  status(): SyncConnectionView {
    try {
      this.allowed();
      return existsSync(this.options.vaultDirectory) ? this.options.vault.view(this.options.store.path) : empty();
    } catch (error) {return this.held(error);}
  }
  async configure(input: SyncConnectionInput): Promise<SyncConnectionAction> {
    try {
      requireCondition(this.options.gate.isIdle(), "sync-management-busy", 409); this.quiet();
      return await this.options.gate.write(() => {
        this.quiet();
        // Only an explicitly authorized save creates the external vault root.
        if (!existsSync(this.options.vaultDirectory)) mkdirSync(this.options.vaultDirectory, {mode: 0o700});
        const result = this.options.vault.configure(this.options.store.path, input);
        if (result.outcome === "saved" || result.outcome === "outcome-unknown") this.options.service?.suspend();
        return result;
      });
    } catch (error) {return {outcome: "held", view: this.held(error)};}
  }
  disable(requestId: string, expectedRevision: string | null): SyncConnectionAction {
    try {
      this.allowed();
      // Do not wait behind the transfer gate. An in-flight POST may already
      // have committed, but no subsequent send/receive pass can begin.
      this.options.service?.suspend();
      if (!existsSync(this.options.vaultDirectory)) mkdirSync(this.options.vaultDirectory, {mode: 0o700});
      return this.options.vault.disable(this.options.store.path, requestId, expectedRevision);
    } catch (error) {return {outcome: "held", view: this.held(error)};}
  }
  resolve(requestId: string): SyncConnectionAction | null {
    this.allowed();
    return existsSync(this.options.vaultDirectory) ? this.options.vault.resolve(this.options.store.path, requestId) : null;
  }
  inventory(cursor?: string) {
    this.allowed();
    return this.options.gate.write(() => {this.allowed(); return this.options.maintenance.view(cursor);});
  }
  plan(entryId: string) {
    this.quiet();
    return this.options.gate.write(() => {this.quiet(); return this.options.maintenance.plan(entryId);});
  }
  release(operationId: string) {
    this.quiet();
    return this.options.gate.write(() => {this.quiet(); return this.options.maintenance.release(operationId);});
  }
  resolveRelease(operationId: string) {
    this.allowed();
    return this.options.gate.write(() => this.options.maintenance.resolve(operationId));
  }
  retention(): SyncRetentionView {
    this.allowed();
    let held: string | null = null, queue: SyncRetentionView["queue"] = null, backups: SyncRetentionView["backups"] = null;
    try {if (readUserVersion(this.options.store.db) === 5) queue = inspectSyncRetention(this.options.store.db, "client");}
    catch {held = "sync-retention-unknown";}
    try {backups = inspectBackupRetention(dirname(this.options.store.path));}
    catch {held = "sync-backup-retention-unknown";}
    return {queue, backups, held};
  }
}
