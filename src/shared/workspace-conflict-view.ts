export type WorkspaceConflictSide = "local" | "remote";

export type WorkspaceConflictCandidateSummary = {
  side: WorkspaceConflictSide;
  revision: number;
  checkpointHash: string | null;
  pages: number;
  assets: number;
  bytes: number;
};

export type WorkspaceConflictInspection = {
  operationId: string;
  localGeneration: number;
  status: {
    receivedCursor: number;
    appliedRevision: number;
    generation: number;
    cleanGeneration: number;
    pending: boolean;
  };
  local: WorkspaceConflictCandidateSummary & {
    side: "local";
    checkpointHash: string;
  };
  remote: WorkspaceConflictCandidateSummary & { side: "remote" };
};

export type WorkspaceConflictArchiveSummary = {
  id: number;
  operationId: string;
  kind: string;
  createdAt: number;
  checkpointHash: string | null;
  pages: number | null;
  assets: number | null;
  bytes: number | null;
  valid: boolean;
};

export type WorkspaceConflictView =
  | { available: false; reason: "not-connected" | "read-only" }
  | {
      available: true;
      conflict: WorkspaceConflictInspection | null;
      archives: WorkspaceConflictArchiveSummary[];
      archiveCount: number;
    };

export type WorkspaceConflictCandidateTarget = {
  operationId: string;
  side: WorkspaceConflictSide;
  expectedRevision: number;
  expectedCheckpointHash: string | null;
};

export type WorkspaceConflictCandidateSnapshot = {
  operationId: string;
  side: WorkspaceConflictSide;
  revision: number;
  checkpointHash: string | null;
  checkpointJson: string | null;
  bytes: number;
};

export type WorkspaceConflictPreservation = {
  operationId: string;
  side: WorkspaceConflictSide;
  revision: number;
  checkpointHash: string | null;
  archiveId: number;
  created: boolean;
};
