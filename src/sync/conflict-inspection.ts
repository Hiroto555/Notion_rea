import type {
  WorkspaceConflictArchiveSummary,
  WorkspaceConflictCandidateSummary,
  WorkspaceConflictInspection,
  WorkspaceConflictSide,
} from "../shared/workspace-conflict-view";
import {
  canonicalJson,
  fingerprintCommit,
  hashCheckpoint,
  MAX_CHECKPOINT_BYTES,
  parseCheckpoint,
  parseCommit,
  parseResult,
  requireCondition,
  type Checkpoint,
  type Commit,
  type CommitResult,
} from "./protocol";
import { validateWorkspaceCheckpoint } from "./workspace-checkpoint";

export type StoredConflictRow = {
  id: number;
  operation_id: string;
  local_commit_json: string;
  remote_result_json: string;
  local_generation: number;
  local_checkpoint_json: string;
  chosen: string | null;
  chosen_at: number | null;
};

export type StoredArchiveRow = {
  id: number;
  operation_id: string;
  kind: string;
  checkpoint_json: string;
  created_at: number;
};

type ConflictHeadResult = Extract<CommitResult, { status: "conflict" }>;

export type ValidatedConflict = {
  operation: Commit;
  result: ConflictHeadResult;
  localCheckpoint: Checkpoint;
  localCheckpointHash: string;
  remoteCheckpoint: Checkpoint | null;
  remoteCheckpointHash: string | null;
};

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(code);
  }
}

function parseStored<T>(code: string, parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new Error(code);
  }
}

export function validateConflictRecord(row: StoredConflictRow): ValidatedConflict {
  requireCondition(row.chosen === null, "invalid-conflict-choice-state");
  const operation = parseStored("invalid-conflict-operation", () =>
    parseCommit(parseJson(row.local_commit_json, "invalid-conflict-operation")),
  );
  const result = parseStored("invalid-conflict-result", () =>
    parseResult(parseJson(row.remote_result_json, "invalid-conflict-result")),
  ) as CommitResult;
  requireCondition(result.status === "conflict", "invalid-conflict-result");
  const conflictResult = result as ConflictHeadResult;
  requireCondition(
    row.operation_id === operation.operationId &&
      conflictResult.operationId === operation.operationId &&
      conflictResult.fingerprint === fingerprintCommit(operation) &&
      conflictResult.workspaceId === operation.workspaceId &&
      conflictResult.clientId === operation.clientId &&
      conflictResult.serverEpoch === operation.serverEpoch,
    "invalid-conflict-identity",
  );
  const localCheckpoint = parseStored("invalid-conflict-checkpoint", () =>
    parseCheckpoint(
      parseJson(row.local_checkpoint_json, "invalid-conflict-checkpoint"),
    ),
  );
  requireCondition(
    canonicalJson(localCheckpoint) === canonicalJson(operation.checkpoint) &&
      hashCheckpoint(localCheckpoint) === operation.checkpointHash &&
      validateWorkspaceCheckpoint(localCheckpoint),
    "invalid-conflict-checkpoint",
  );
  const remoteCheckpoint = conflictResult.head.checkpoint;
  if (conflictResult.head.revision === 0)
    requireCondition(
      remoteCheckpoint === null && conflictResult.head.checkpointHash === null,
      "invalid-conflict-head",
    );
  else
    requireCondition(
      remoteCheckpoint !== null &&
        conflictResult.head.checkpointHash !== null &&
        hashCheckpoint(remoteCheckpoint) ===
          conflictResult.head.checkpointHash &&
        validateWorkspaceCheckpoint(remoteCheckpoint),
      "invalid-conflict-head",
    );
  return {
    operation,
    result: conflictResult,
    localCheckpoint,
    localCheckpointHash: operation.checkpointHash,
    remoteCheckpoint,
    remoteCheckpointHash: conflictResult.head.checkpointHash,
  };
}

function checkpointSummary(
  side: WorkspaceConflictSide,
  revision: number,
  checkpointHash: string | null,
  checkpoint: Checkpoint | null,
): WorkspaceConflictCandidateSummary {
  const tables: Record<string, unknown> = checkpoint
    ? ((
        checkpoint.payload as unknown as {
          tables?: Record<string, unknown>;
        }
      ).tables ?? {})
    : {};
  const pages = Array.isArray(tables.pages) ? tables.pages.length : 0;
  return {
    side,
    revision,
    checkpointHash,
    pages,
    assets: checkpoint ? checkpoint.assets.length : 0,
    bytes: checkpoint
      ? Buffer.byteLength(canonicalJson(checkpoint, MAX_CHECKPOINT_BYTES))
      : 0,
  };
}

export function inspectValidatedConflict(
  conflict: ValidatedConflict,
  status: WorkspaceConflictInspection["status"],
  localGeneration: number,
): WorkspaceConflictInspection {
  return {
    operationId: conflict.operation.operationId,
    localGeneration,
    status,
    local: checkpointSummary(
      "local",
      conflict.operation.baseRevision,
      conflict.localCheckpointHash,
      conflict.localCheckpoint,
    ) as WorkspaceConflictInspection["local"],
    remote: checkpointSummary(
      "remote",
      conflict.result.head.revision,
      conflict.remoteCheckpointHash,
      conflict.remoteCheckpoint,
    ) as WorkspaceConflictInspection["remote"],
  };
}

export function inspectArchiveRecord(
  row: StoredArchiveRow,
): WorkspaceConflictArchiveSummary {
  const bytes = Buffer.byteLength(row.checkpoint_json);
  try {
    const checkpoint = parseCheckpoint(
      parseJson(row.checkpoint_json, "invalid-archive-checkpoint"),
    );
    requireCondition(
      validateWorkspaceCheckpoint(checkpoint),
      "invalid-archive-checkpoint",
    );
    const summary = checkpointSummary(
      "local",
      0,
      hashCheckpoint(checkpoint),
      checkpoint,
    );
    return {
      id: row.id,
      operationId: row.operation_id,
      kind: row.kind,
      createdAt: row.created_at,
      checkpointHash: summary.checkpointHash,
      pages: summary.pages,
      assets: summary.assets,
      bytes: Buffer.byteLength(canonicalJson(checkpoint, MAX_CHECKPOINT_BYTES)),
      valid: true,
    };
  } catch {
    return {
      id: row.id,
      operationId: row.operation_id,
      kind: row.kind,
      createdAt: row.created_at,
      checkpointHash: null,
      pages: null,
      assets: null,
      bytes,
      valid: false,
    };
  }
}
