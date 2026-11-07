import { canonicalJson } from "../sync/protocol";
import type { SyncApplyIntentRead, SyncApplyTarget } from "./workspace-sync-intent";

export type RestartIntentPort = {read(): SyncApplyIntentRead; create(target: SyncApplyTarget): void;
  legacyBlocked?():boolean; prepare?(target: SyncApplyTarget): void; pending?(): {id:string;target:SyncApplyTarget} | undefined; cancelStored?(expectedId:string): boolean;
  cancelIfMatches(target: SyncApplyTarget): "removed" | "absent" | "different"};
export type RestartObservation = {
  target: SyncApplyTarget | null;
  /** Main, not renderer, must establish these conditions. */
  clean: boolean;
  idle: boolean;
  windowsClosed: boolean;
};
export type RestartRequestState = "none" | "prepared" | "committed" | "uncertain";
export type RestartRequestResult = "prepared" | "committed" | "cancelled" | "not-prepared" | "blocked";

/** In-memory intent selection until all windows have actually closed. This is
 * a lifecycle seam, not an Electron event handler: a host must hold exclusive
 * workspace ownership and supply fresh observations when committing. */
export class WorkspaceSyncRestartRequest {
  private target?: SyncApplyTarget;
  private publication: "none" | "committed" | "uncertain" = "none";
  constructor(private readonly file: RestartIntentPort, private readonly observe: () => RestartObservation) {}

  state(): RestartRequestState {
    if (this.publication !== "none") return this.publication;
    return this.target ? "prepared" : "none";
  }
  selectedTarget(): SyncApplyTarget | undefined {
    return this.target ? structuredClone(this.target) : undefined;
  }

  prepare(): RestartRequestResult {
    if (this.target) return "blocked";
    try {
      const current = this.observe();
      if (!current.target || !current.clean || !current.idle || current.windowsClosed || this.file.read().status !== "empty") return "blocked";
      this.target = structuredClone(current.target);
      this.file.prepare?.(this.target);
      return "prepared";
    } catch {return "blocked";}
  }

  commitAfterWindowsClosed(): RestartRequestResult {
    if (!this.target) return "not-prepared";
    if (this.publication !== "none") return "blocked";
    try {
      const current = this.observe();
      if (!current.windowsClosed || !current.clean || !current.idle || !current.target ||
          canonicalJson(current.target) !== canonicalJson(this.target)) return "blocked";
    } catch {return "blocked";}
    try {
      this.file.create(this.target);
      this.publication = "committed";
      return "committed";
    } catch {
      // A failed fsync/readback can leave the name published. Cancellation
      // must inspect it, not assume the write failed before publication.
      this.publication = "uncertain";
      return "blocked";
    }
  }

  cancel(): RestartRequestResult {
    if (!this.target) return "not-prepared";
    if (this.publication !== "none") {
      try {if (this.file.cancelIfMatches(this.target) === "different") return "blocked";}
      catch {return "blocked";}
    }
    this.target = undefined;
    this.publication = "none";
    return "cancelled";
  }
}
