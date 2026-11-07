/** Renderer-safe status; credentials and raw server responses are excluded. */
export type WorkspaceSyncConnection =
  | "connected"
  | "connecting"
  | "disconnected";

export type WorkspaceSyncWorkspaceStatus = {
  receivedCursor: number;
  appliedRevision: number;
  generation: number;
  cleanGeneration: number;
  pending: boolean;
  conflict: boolean;
};

export type WorkspaceSyncView =
  | {available: false; reason: "not-connected" | "read-only"}
  | {available: true; connection: WorkspaceSyncConnection; running: boolean;
      lastSuccessAt: string | null; lastError: string | null;
      workspace: WorkspaceSyncWorkspaceStatus | null};

export type WorkspaceSyncRestartReason =
  | "no-staged-target" | "target-changed" | "unsaved-changes" | "recovery-blocked"
  | "sync-active" | "workspace-changed" | "conflict" | "intent-present"
  | "intent-blocked" | "state-unavailable";

export type WorkspaceSyncRestartView =
  | {available: false; reason: "not-connected" | "read-only"}
  | {available: true; state: "idle" | "requested" | "committed" | "uncertain";
      scheduled: boolean; targetRevision: number | null; canRequest: boolean;
      canCancel: boolean; reason: WorkspaceSyncRestartReason | null};

export type WorkspaceSyncRestartActionResult =
  "prepared" | "cancelled" | "not-prepared" | "blocked" | "unavailable";
export type WorkspaceSyncRestartAction = {
  result: WorkspaceSyncRestartActionResult;
  view: WorkspaceSyncRestartView;
};
