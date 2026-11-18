import { z } from "zod";

/** An explicit decision names both saved candidates AND the current local
 * content. "local" means this latest saved content, not the older candidate.
 * This is a stale-state guard, not authorization or a restart intent. */
export type WorkspaceConflictResolutionTarget = Readonly<{
  version: 1;
  choice: "local" | "remote";
  workspaceId: string;
  clientId: string;
  bindingId: string;
  serverEpoch: string;
  operationId: string;
  localRevision: number;
  localCheckpointHash: string;
  remoteRevision: number;
  remoteCheckpointHash: string | null;
  conflictGeneration: number;
  generation: number;
  cleanGeneration: number;
  appliedRevision: number;
  receivedCursor: number;
  latestCheckpointHash: string;
}>;

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
export const conflictResolutionTargetSchema: z.ZodType<WorkspaceConflictResolutionTarget> =
  z
    .object({
      version: z.literal(1),
      choice: z.enum(["local", "remote"]),
      workspaceId: id,
      clientId: id,
      bindingId: id,
      serverEpoch: id,
      operationId: id,
      localRevision: count,
      localCheckpointHash: hash,
      remoteRevision: count,
      remoteCheckpointHash: hash.nullable(),
      conflictGeneration: count,
      generation: count,
      cleanGeneration: count,
      appliedRevision: count,
      receivedCursor: count,
      latestCheckpointHash: hash,
    })
    .strict();

export type ConflictDecisionPreview = {
  id: string;
  target: WorkspaceConflictResolutionTarget;
  latestCheckpointJson: string;
  remoteCheckpointJson: string | null;
  latestPages: number;
  latestAssets: number;
};

export type ConflictPreviewRequest = {
  choice: "local" | "remote";
  operationId: string;
  expectedLocalHash: string;
  expectedRemoteRevision: number;
  expectedRemoteHash: string | null;
};

export type ConflictDecisionView = {
  state:
    "idle" | "requested" | "pending" | "consumed" | "cancelled" | "blocked";
  decisionId: string | null;
  choice: "local" | "remote" | null;
  canPreview: boolean;
  canCancel: boolean;
  reason:
    | "read-only"
    | "not-connected"
    | "unsaved-input"
    | "busy"
    | "other-intent"
    | "target-changed"
    | "state-unavailable"
    | null;
};

export type ConflictDecisionAction = {
  result: "requested" | "cancelled" | "blocked";
  view: ConflictDecisionView;
};
