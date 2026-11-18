import type { WorkspaceSyncView } from "../shared/workspace-sync-view";
import type { WorkspaceSyncStatus } from "../sync/workspace-store";
import type { WorkspaceConflictCandidateTarget, WorkspaceConflictView } from "../shared/workspace-conflict-view";
import { requireCondition } from "../sync/protocol";
import { WorkspaceSyncGate } from "./workspace-sync-gate";
import { WorkspaceSyncService } from "./workspace-sync-service";

/** Keeps transfer and workspace write ownership in main. Never applies content.
 * A configured but disconnected service reconnects only inside a gated,
 * authorized transfer request. */
export class WorkspaceSyncControl {
  constructor(private readonly service: WorkspaceSyncService<WorkspaceSyncStatus> | undefined,
    private readonly gate: WorkspaceSyncGate, private readonly readOnly: boolean) {}
  status(): WorkspaceSyncView {
    if (this.readOnly) return {available: false, reason: "read-only"};
    if (!this.service) return {available: false, reason: "not-connected"};
    return {available: true, ...this.service.status()};
  }
  conflict(): WorkspaceConflictView {
    if (this.readOnly) return {available: false, reason: "read-only"};
    const conflict = this.service?.conflictInspection();
    const archives = this.service?.conflictArchives();
    if (conflict === undefined || archives === undefined) return {available: false, reason: "not-connected"};
    return {available: true, conflict, archives: archives.archives, archiveCount: archives.total};
  }
  conflictCandidate(target: WorkspaceConflictCandidateTarget) {
    requireCondition(!this.readOnly, "read-only", 409);
    const result = this.service?.conflictCandidate(target);
    requireCondition(result !== undefined, "not-connected", 409);
    return result;
  }
  async transfer(beforeStart: () => void = () => {}): Promise<WorkspaceSyncView> {
    if (this.readOnly || !this.service) return this.status();
    const service = this.service;
    await this.gate.sync(() => {beforeStart(); return service.sync();});
    return this.status();
  }
}
