import { hasCrashRecoveryInput, type CrashRecoveryRead } from "../shared/crash-recovery";
import type {
  WorkspaceSyncRestartAction,
  WorkspaceSyncRestartReason,
  WorkspaceSyncRestartView,
} from "../shared/workspace-sync-view";
import type { Change } from "../sync/protocol";
import type { WorkspaceSyncStatus } from "../sync/workspace-store";
import { checkStagedRestartTarget } from "./workspace-sync-apply-guard";
import type { SyncApplyTarget } from "./workspace-sync-intent";
import {
  WorkspaceSyncRestartRequest,
  type RestartObservation,
  type RestartRequestResult,
  type RestartRequestState,
  type RestartIntentPort,
} from "./workspace-sync-restart-request";

export type WorkspaceSyncRestartSource = {
  target: () => SyncApplyTarget | null;
  status: () => WorkspaceSyncStatus;
  incoming: () => Change | null;
  running: () => boolean;
  /** Main must include active and queued workspace writes and maintenance. */
  gateIdle: () => boolean;
  recovery: () => CrashRecoveryRead;
  windowsClosed: () => boolean;
  otherIntentClear?: () => boolean;
};

type Evaluation = RestartObservation & {reason: WorkspaceSyncRestartReason | null};

function cleanRecovery(recovery: CrashRecoveryRead): boolean {
  return recovery.status === "empty" ||
    (recovery.status === "ready" && !!recovery.snapshot && !hasCrashRecoveryInput(recovery.snapshot));
}

function viewState(state: RestartRequestState): Extract<WorkspaceSyncRestartView, {available: true}>["state"] {
  return state === "none" ? "idle" : state === "prepared" ? "requested" : state;
}

export class WorkspaceSyncRestartCoordinator {
  private readonly request: WorkspaceSyncRestartRequest;

  constructor(
    private readonly intentFile: RestartIntentPort,
    private readonly source: WorkspaceSyncRestartSource | undefined,
    private readonly readOnly = false,
  ) {
    this.request = new WorkspaceSyncRestartRequest(intentFile, () => this.observation());
  }

  private evaluate(): Evaluation {
    if (!this.source) throw new Error("restart-source-unavailable");
    const recovery = this.source.recovery();
    const status = this.source.status();
    const target = this.source.target();
    const idle = !this.source.running() && this.source.gateIdle();
    const windowsClosed = this.source.windowsClosed();
    const clean = cleanRecovery(recovery);
    let reason: WorkspaceSyncRestartReason | null = null;
    if (this.source.otherIntentClear?.() === false) {
      reason = "intent-present";
    } else if (recovery.status === "blocked" || (recovery.status === "ready" && !recovery.snapshot)) {
      reason = "recovery-blocked";
    } else if (!clean) {
      reason = "unsaved-changes";
    } else if (!idle) {
      reason = "sync-active";
    } else if (!target) {
      reason = "no-staged-target";
    } else {
      const check = checkStagedRestartTarget({
        target,
        status,
        recovery,
        incoming: this.source.incoming(),
      });
      if (check === "recovery-input") reason = "recovery-blocked";
      else if (check === "workspace-changed") reason = status.conflict ? "conflict" : "workspace-changed";
      else if (check === "target-changed") reason = "target-changed";
    }
    return {target: reason === null ? target : null, clean, idle, windowsClosed, reason};
  }

  private observation(): RestartObservation {
    const {target, clean, idle, windowsClosed} = this.evaluate();
    return {target, clean, idle, windowsClosed};
  }

  status(): WorkspaceSyncRestartView {
    if (this.readOnly) return {available: false, reason: "read-only"};
    const localIntent = this.intentFile.read();
    if (!this.source && !this.intentFile.pending?.() && localIntent.status !== "blocked") return {available: false, reason: "not-connected"};
    const state = this.request.state();
    const selected = this.request.selectedTarget();
    const intent = this.intentFile.read();
    let evaluation: Evaluation;
    try {
      evaluation = this.evaluate();
    } catch {
      return {
        available: true,
        reservationId: this.intentFile.pending?.()?.id,
        state: viewState(state),
        scheduled: state === "committed" || intent.status === "ready",
        targetRevision: selected?.revision ?? (intent.status === "ready" ? intent.target.revision : null),
        canRequest: false,
        canCancel: state !== "none" || !!this.intentFile.pending?.(),
        reason: localIntent.status === "blocked" ? "intent-blocked" : "state-unavailable",
      };
    }
    const scheduled = state === "committed" || intent.status === "ready";
    let reason = evaluation.reason;
    if (state === "none") {
      if (intent.status === "blocked") reason = "intent-blocked";
      else if (intent.status === "ready") reason = "intent-present";
    }
    return {
      available: true,
      reservationId: this.intentFile.pending?.()?.id,
      state: viewState(state),
      scheduled,
      targetRevision: selected?.revision ?? (intent.status === "ready" ? intent.target.revision : (evaluation.target?.revision ?? null)),
      canRequest: state === "none" && intent.status === "empty" && evaluation.reason === null,
      canCancel: state !== "none" || !!this.intentFile.pending?.(),
      reason,
    };
  }

  requestRestart(): WorkspaceSyncRestartAction {
    const view = this.status();
    if (!view.available) return {result: "unavailable", view};
    if (!view.canRequest) return {result: "blocked", view};
    const result = this.request.prepare();
    const next = this.status();
    return {result: result === "prepared" ? "prepared" : "blocked", view: next};
  }

  cancelRestart(expectedId?: string): WorkspaceSyncRestartAction {
    const view = this.status();
    if (!view.available) return {result: "unavailable", view};
    if (!view.canCancel) return {result: "not-prepared", view};
    const pendingId = this.intentFile.pending?.()?.id;
    if (pendingId && pendingId !== expectedId) return {result:"blocked",view:this.status()};
    if (this.request.state() === "none" && this.intentFile.cancelStored) {
      const cancelled = expectedId ? this.intentFile.cancelStored(expectedId) : false;
      return {result: cancelled ? "cancelled" : "blocked",view:this.status()};
    }
    const result = this.request.cancel();
    const next = this.status();
    return {
      result: result === "cancelled" ? "cancelled" : result === "blocked" ? "blocked" : "not-prepared",
      view: next,
    };
  }

  commitAfterWindowsClosed(): RestartRequestResult {
    return this.request.commitAfterWindowsClosed();
  }
}

export class WorkspaceSyncRestartControl {
  constructor(
    private readonly coordinator: WorkspaceSyncRestartCoordinator | undefined,
    private readonly readOnly: boolean,
  ) {}

  private unavailable(): WorkspaceSyncRestartView {
    return {available: false, reason: this.readOnly ? "read-only" : "not-connected"};
  }

  status(): WorkspaceSyncRestartView {
    return this.coordinator?.status() ?? this.unavailable();
  }

  request(): WorkspaceSyncRestartAction {
    const unavailable: WorkspaceSyncRestartAction = {result: "unavailable", view: this.unavailable()};
    return this.coordinator?.requestRestart() ?? unavailable;
  }

  cancel(expectedId?: string): WorkspaceSyncRestartAction {
    const unavailable: WorkspaceSyncRestartAction = {result: "unavailable", view: this.unavailable()};
    return this.coordinator?.cancelRestart(expectedId) ?? unavailable;
  }

  commitAfterWindowsClosed(): RestartRequestResult {
    return this.coordinator?.commitAfterWindowsClosed() ?? "not-prepared";
  }
}
