import { randomUUID } from "node:crypto";
import type { Store } from "../persistence/store";
import {
  hasCrashRecoveryInput,
  type CrashRecoveryRead,
} from "../shared/crash-recovery";
import type {
  ConflictDecisionAction,
  ConflictDecisionPreview,
  ConflictDecisionView,
  ConflictPreviewRequest,
  WorkspaceConflictResolutionTarget,
} from "../shared/workspace-conflict-resolution";
import {
  cancelConflictDecision,
  consumedDecisionMatches,
  decisionBelongsToCurrentBinding,
  readConflictDecision,
  reserveConflictDecision,
} from "../sync/conflict-decision";
import { canonicalJson, requireCondition } from "../sync/protocol";
import type { RestartRequestResult } from "./workspace-sync-restart-request";

export type ConflictDecisionSource = {
  preview: (choice: "local" | "remote") => Omit<ConflictDecisionPreview, "id">;
  assertTarget: (target: WorkspaceConflictResolutionTarget) => void;
  hasConflict: () => boolean;
  idle: () => boolean;
  recovery: () => CrashRecoveryRead;
  windowsClosed: () => boolean;
  normalIntentClear: () => boolean;
};

/** Only main issues previews. Confirm is memory-only; no content can be
 * applied by this active-window controller. SQLite publication is windowless. */
export class WorkspaceConflictDecisionControl {
  private previewed?: ConflictDecisionPreview;
  private requested = false;

  constructor(
    private readonly store: Store,
    private readonly source: ConflictDecisionSource | undefined,
    private readonly readOnly: boolean,
    private readonly admitBytes: (bytes: number) => void = () => {},
  ) {}

  hasReservation(): boolean {
    const read = readConflictDecision(this.store.db);
    return (
      this.requested ||
      read.status === "blocked" ||
      (read.status === "ready" &&
        (read.record.state === "pending" ||
          (read.record.state === "consumed" &&
            decisionBelongsToCurrentBinding(this.store.db, read.record) &&
            !consumedDecisionMatches(this.store.db, read.record))))
    );
  }

  private reason(): ConflictDecisionView["reason"] {
    if (this.readOnly) return "read-only";
    if (!this.source) return "not-connected";
    try {
      const recovery = this.source.recovery();
      if (
        recovery.status === "blocked" ||
        (recovery.status === "ready" && !recovery.snapshot)
      )
        return "state-unavailable";
      if (
        recovery.status === "ready" &&
        hasCrashRecoveryInput(recovery.snapshot!)
      )
        return "unsaved-input";
      if (!this.source.idle() || this.source.windowsClosed()) return "busy";
      if (!this.source.normalIntentClear()) return "other-intent";
      if (!this.source.hasConflict()) return "not-connected";
      if (this.requested && this.previewed)
        this.source.assertTarget(this.previewed.target);
      return null;
    } catch {
      return "target-changed";
    }
  }

  status(): ConflictDecisionView {
    const read = readConflictDecision(this.store.db);
    const stored = read.status === "ready" ? read.record : undefined;
    const record =
      stored?.state === "consumed" &&
      !decisionBelongsToCurrentBinding(this.store.db, stored)
        ? undefined
        : stored;
    const invalidResult =
      record?.state === "consumed" &&
      !consumedDecisionMatches(this.store.db, record);
    const state = this.requested
      ? "requested"
      : read.status === "blocked" || invalidResult
        ? "blocked"
        : (record?.state ?? "idle");
    const reason =
      read.status === "blocked" || invalidResult
        ? "state-unavailable"
        : this.reason();
    return {
      state,
      decisionId: this.requested ? this.previewed!.id : (record?.id ?? null),
      choice: this.requested
        ? this.previewed!.target.choice
        : (record?.target.choice ?? null),
      canPreview: !this.hasReservation() && reason === null,
      canCancel:
        !this.readOnly && (this.requested || record?.state === "pending"),
      reason,
    };
  }

  preview(request: ConflictPreviewRequest): ConflictDecisionPreview {
    requireCondition(
      this.status().canPreview,
      "conflict-preview-unavailable",
      409,
    );
    this.previewed = undefined;
    const data = this.source!.preview(request.choice);
    requireCondition(
      data.target.operationId === request.operationId &&
        data.target.localCheckpointHash === request.expectedLocalHash &&
        data.target.remoteRevision === request.expectedRemoteRevision &&
        data.target.remoteCheckpointHash === request.expectedRemoteHash,
      "conflict-selection-stale",
      409,
    );
    const preview = { id: randomUUID(), ...data };
    this.previewed = structuredClone(preview);
    return structuredClone(preview);
  }

  confirm(id: string): ConflictDecisionAction {
    if (this.requested && this.previewed?.id === id)
      return { result: "requested", view: this.status() };
    const view = this.status();
    if (!view.canPreview || !this.previewed || this.previewed.id !== id)
      return { result: "blocked", view };
    try {
      this.source!.assertTarget(this.previewed.target);
      this.requested = true;
      return { result: "requested", view: this.status() };
    } catch {
      this.previewed = undefined;
      return { result: "blocked", view: this.status() };
    }
  }

  cancel(id: string): ConflictDecisionAction {
    if (this.readOnly) return { result: "blocked", view: this.status() };
    const read = readConflictDecision(this.store.db);
    if (read.status === "blocked")
      return { result: "blocked", view: this.status() };
    if (
      read.status === "ready" &&
      read.record.id === id &&
      read.record.state === "pending"
    ) {
      try {
        this.store.transaction(() => cancelConflictDecision(this.store.db, id));
      } catch {
        const after = readConflictDecision(this.store.db);
        if (
          after.status !== "ready" ||
          after.record.id !== id ||
          after.record.state !== "cancelled"
        )
          return { result: "blocked", view: this.status() };
      }
      if (this.previewed?.id === id) {
        this.previewed = undefined;
        this.requested = false;
      }
      return { result: "cancelled", view: this.status() };
    }
    if (this.previewed?.id === id) {
      this.previewed = undefined;
      this.requested = false;
      return { result: "cancelled", view: this.status() };
    }
    if (
      read.status === "ready" &&
      read.record.id === id &&
      read.record.state === "cancelled"
    )
      return { result: "cancelled", view: this.status() };
    return { result: "blocked", view: this.status() };
  }

  commitAfterWindowsClosed(): RestartRequestResult {
    if (!this.requested || !this.previewed) return "not-prepared";
    const selected = this.previewed;
    const safe = () => {
      requireCondition(
        !this.readOnly &&
          !!this.source &&
          this.source.windowsClosed() &&
          this.source.idle() &&
          this.source.normalIntentClear(),
        "conflict-quit-held",
        409,
      );
      const recovery = this.source!.recovery();
      requireCondition(
        recovery.status === "empty" ||
          (recovery.status === "ready" &&
            !!recovery.snapshot &&
            !hasCrashRecoveryInput(recovery.snapshot)),
        "conflict-quit-held",
        409,
      );
      this.source!.assertTarget(selected.target);
    };
    try {
      safe();
      const read = readConflictDecision(this.store.db);
      if (
        read.status === "ready" &&
        read.record.state === "pending" &&
        read.record.id === selected.id &&
        canonicalJson(read.record.target) === canonicalJson(selected.target)
      )
        return "committed";
      this.store.transaction(() => {
        safe();
        this.admitBytes(
          Buffer.byteLength(canonicalJson(selected.target)) + 8192,
        );
        safe();
        reserveConflictDecision(this.store.db, selected.id, selected.target);
      });
      return "committed";
    } catch {
      return "blocked";
    }
  }
}
