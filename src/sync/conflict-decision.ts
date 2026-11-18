import { normalApplyBlocks } from "./normal-apply-journal";
import { legacyApplyIntentPresent } from "./legacy-apply-intent";
import { dirname } from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  conflictResolutionTargetSchema,
  type WorkspaceConflictResolutionTarget,
} from "../shared/workspace-conflict-resolution";
import {
  canonicalJson,
  hashCheckpoint,
  parseCommit,
  requireCondition,
} from "./protocol";

/** Private local settings: excluded from checkpoints; generic setting IPC is
 * allowlisted and cannot write this key. Retain the last terminal result until
 * an explicit new reservation replaces it by CAS; cancellation never deletes. */
export const CONFLICT_DECISION_KEY = "folio.sync.conflict-decision.v1";
const base = {
  format: z.literal("folio-conflict-decision/v1"),
  id: z.string().uuid(),
  target: conflictResolutionTargetSchema,
  createdAt: z.number().int().nonnegative().safe(),
};
const resultSchema = z.discriminatedUnion("choice", [
  z
    .object({
      choice: z.literal("local"),
      operationId: z.string().uuid(),
      checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      choice: z.literal("remote"),
      revision: z.number().int().positive().safe(),
      checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
const schema = z.discriminatedUnion("state", [
  z.object({ ...base, state: z.literal("pending") }).strict(),
  z.object({ ...base, state: z.literal("cancelled") }).strict(),
  z
    .object({ ...base, state: z.literal("consumed"), result: resultSchema })
    .strict(),
]);
export type ConflictDecisionRecord = z.infer<typeof schema>;
export type ConflictDecisionResult = z.infer<typeof resultSchema>;
export type ConflictDecisionRead =
  | { status: "empty" }
  | { status: "blocked" }
  | { status: "ready"; record: ConflictDecisionRecord; raw: string };

export function readConflictDecision(db: DatabaseSync): ConflictDecisionRead {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(CONFLICT_DECISION_KEY);
    if (!row) return { status: "empty" };
    requireCondition(
      typeof row.value === "string" && Buffer.byteLength(row.value) <= 8192,
      "invalid-conflict-decision",
    );
    const record = schema.parse(JSON.parse(row.value as string));
    requireCondition(
      row.value === canonicalJson(record, 8192),
      "invalid-conflict-decision",
    );
    if (record.state === "consumed")
      requireCondition(
        record.result.choice === record.target.choice &&
          (record.result.choice === "local"
            ? record.result.checkpointHash ===
              record.target.latestCheckpointHash
            : record.result.revision === record.target.remoteRevision &&
              record.result.checkpointHash ===
                record.target.remoteCheckpointHash),
        "invalid-conflict-decision-result",
      );
    return { status: "ready", record, raw: row.value as string };
  } catch {
    return { status: "blocked" };
  }
}

function writeCas(
  db: DatabaseSync,
  previous: ConflictDecisionRead,
  next: ConflictDecisionRecord,
): void {
  requireCondition(db.isTransaction, "conflict-decision-transaction-required");
  requireCondition(previous.status !== "blocked", "invalid-conflict-decision");
  const raw = canonicalJson(schema.parse(next), 8192);
  const result =
    previous.status === "empty"
      ? db
          .prepare(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
          )
          .run(CONFLICT_DECISION_KEY, raw)
      : db
          .prepare("UPDATE settings SET value=? WHERE key=? AND value=?")
          .run(raw, CONFLICT_DECISION_KEY, previous.raw);
  requireCondition(result.changes === 1, "conflict-decision-changed", 409);
}

function assertNormalClear(db: DatabaseSync): void {
  requireCondition(db.isTransaction, "conflict-decision-transaction-required");
  const file = db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file;
  requireCondition(!normalApplyBlocks(db) && (typeof file !== "string" || !file || !legacyApplyIntentPresent(dirname(file))), "normal-apply-present",409);
}
export function reserveConflictDecision(
  db: DatabaseSync,
  id: string,
  target: WorkspaceConflictResolutionTarget,
): void {
  assertNormalClear(db);
  const previous = readConflictDecision(db);
  requireCondition(
    previous.status === "empty" ||
      (previous.status === "ready" &&
        previous.record.state !== "pending" &&
        previous.record.id !== id),
    "conflict-decision-present",
    409,
  );
  writeCas(db, previous, {
    format: "folio-conflict-decision/v1",
    id,
    target,
    createdAt: Date.now(),
    state: "pending",
  });
}

export function assertPendingConflictDecision(
  db: DatabaseSync,
  id: string,
  target: WorkspaceConflictResolutionTarget,
): void {
  const read = readConflictDecision(db);
  requireCondition(
    read.status === "ready" &&
      read.record.state === "pending" &&
      read.record.id === id &&
      canonicalJson(read.record.target) === canonicalJson(target),
    "conflict-decision-changed",
    409,
  );
}

export function completeConflictDecision(
  db: DatabaseSync,
  id: string,
  target: WorkspaceConflictResolutionTarget,
  result: ConflictDecisionResult,
): void {
  assertNormalClear(db);
  assertPendingConflictDecision(db, id, target);
  const previous = readConflictDecision(db) as Extract<
    ConflictDecisionRead,
    { status: "ready" }
  >;
  requireCondition(result.choice === target.choice, "invalid-conflict-choice");
  requireCondition(
    result.choice === "local"
      ? result.checkpointHash === target.latestCheckpointHash
      : result.revision === target.remoteRevision &&
          result.checkpointHash === target.remoteCheckpointHash,
    "invalid-conflict-decision-result",
  );
  writeCas(db, previous, { ...previous.record, state: "consumed", result });
}

export function cancelConflictDecision(db: DatabaseSync, id: string): void {
  const previous = readConflictDecision(db);
  requireCondition(
    previous.status === "ready" &&
      previous.record.id === id &&
      previous.record.state === "pending",
    "conflict-decision-changed",
    409,
  );
  if (previous.status === "ready")
    writeCas(db, previous, { ...previous.record, state: "cancelled" });
}

/** A terminal marker is never replayed. Check its durable evidence before
 * reporting success or allowing normal startup transfers to resume. */
export function consumedDecisionMatches(
  db: DatabaseSync,
  record: ConflictDecisionRecord,
): boolean {
  if (record.state !== "consumed") return false;
  try {
    const row = db
      .prepare(
        "SELECT chosen FROM workspace_sync_conflicts WHERE operation_id=?",
      )
      .get(record.target.operationId);
    if (row?.chosen !== record.target.choice) return false;
    if (record.result.choice === "local") {
      const queued = db
        .prepare(
          "SELECT commit_json FROM workspace_sync_outbox WHERE operation_id=?",
        )
        .get(record.result.operationId);
      if (!queued) return false;
      const commit = parseCommit(JSON.parse(String(queued.commit_json)));
      return (
        commit.operationId === record.result.operationId &&
        commit.checkpointHash === record.result.checkpointHash &&
        commit.baseRevision === record.target.remoteRevision &&
        commit.workspaceId === record.target.workspaceId &&
        commit.clientId === record.target.clientId &&
        commit.serverEpoch === record.target.serverEpoch
      );
    }
    return db
      .prepare(
        "SELECT checkpoint_json FROM workspace_sync_archives WHERE operation_id=? AND kind='conflict-remote'",
      )
      .all(record.target.operationId)
      .some(
        (row) =>
          hashCheckpoint(JSON.parse(String(row.checkpoint_json))) ===
          record.target.remoteCheckpointHash,
      );
  } catch {
    return false;
  }
}

export function decisionBelongsToCurrentBinding(
  db: DatabaseSync,
  record: ConflictDecisionRecord,
): boolean {
  try {
    const state = db
      .prepare(
        "SELECT workspace_id,client_id,binding_id,server_epoch FROM workspace_sync_state WHERE singleton=1",
      )
      .get();
    return (
      !!state &&
      state.workspace_id === record.target.workspaceId &&
      state.client_id === record.target.clientId &&
      state.binding_id === record.target.bindingId &&
      state.server_epoch === record.target.serverEpoch
    );
  } catch {
    return false;
  }
}
