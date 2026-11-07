import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, hashCheckpoint, requireCondition, identifier as parseIdentifier } from "./protocol";
import {
  consumedDecisionMatches,
  decisionBelongsToCurrentBinding,
  readConflictDecision,
} from "./conflict-decision";

export const NORMAL_APPLY_KEY = "folio.sync.normal-apply.v1";

const identifier = z.string().refine(value => {try {parseIdentifier(value);return true;}catch{return false;}});
const digest = z.string().regex(/^[a-f0-9]{64}$/);

const targetSchema = z
  .object({
    workspaceId: identifier,
    clientId: identifier,
    bindingId: identifier,
    serverEpoch: identifier,
    revision: z.number().int().positive().safe(),
    checkpointHash: digest,
  })
  .strict();

const resultSchema = z
  .object({
    revision: z.number().int().positive().safe(),
    checkpointHash: digest,
  })
  .strict();

const base = {
  format: z.literal("folio-normal-apply/v1"),
  id: z.string().uuid(),
  target: targetSchema,
  createdAt: z.number().int().nonnegative().safe(),
};

const schema = z.discriminatedUnion("state", [
  z.object({ ...base, state: z.literal("pending") }).strict(),
  z.object({ ...base, state: z.literal("cancelled") }).strict(),
  z
    .object({ ...base, state: z.literal("consumed"), result: resultSchema })
    .strict(),
]);

export type NormalApplyRecord = z.infer<typeof schema>;

export type NormalApplyRead =
  | { status: "empty" }
  | { status: "blocked" }
  | { status: "ready"; record: NormalApplyRecord; raw: string };

export function readNormalApply(db: DatabaseSync): NormalApplyRead {
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(NORMAL_APPLY_KEY);
    if (!row) return { status: "empty" };
    requireCondition(
      typeof row.value === "string" && Buffer.byteLength(row.value) <= 8192,
      "invalid-normal-apply",
    );
    const record = schema.parse(JSON.parse(row.value as string));
    requireCondition(
      row.value === canonicalJson(record, 8192),
      "invalid-normal-apply",
    );
    if (record.state === "consumed")
      requireCondition(
        record.result.revision === record.target.revision &&
          record.result.checkpointHash === record.target.checkpointHash,
        "invalid-normal-apply-result",
      );
    return { status: "ready", record, raw: row.value as string };
  } catch {
    return { status: "blocked" };
  }
}

function belongsToCurrentBinding(db: DatabaseSync, record: NormalApplyRecord): boolean {
  try {
    const state = db
      .prepare(
        "SELECT workspace_id,client_id,binding_id,server_epoch FROM workspace_sync_state WHERE singleton=1",
      )
      .get() as
      | {
          workspace_id: string;
          client_id: string;
          binding_id: string;
          server_epoch: string;
        }
      | undefined;
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

function conflictDecisionBlocks(db: DatabaseSync): boolean {
  const decision = readConflictDecision(db);
  if (decision.status === "blocked") return true;
  if (decision.status === "empty") return false;
  if (decision.record.state === "pending") return true;
  if (
    decision.record.state === "consumed" &&
    decisionBelongsToCurrentBinding(db, decision.record) &&
    !consumedDecisionMatches(db, decision.record)
  )
    return true;
  return false;
}

function writeCas(
  db: DatabaseSync,
  previous: NormalApplyRead,
  next: NormalApplyRecord,
): void {
  requireCondition(db.isTransaction, "normal-apply-transaction-required");
  requireCondition(previous.status !== "blocked", "invalid-normal-apply");
  const raw = canonicalJson(schema.parse(next), 8192);
  const result =
    previous.status === "empty"
      ? db
          .prepare(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
          )
          .run(NORMAL_APPLY_KEY, raw)
      : db
          .prepare("UPDATE settings SET value=? WHERE key=? AND value=?")
          .run(raw, NORMAL_APPLY_KEY, previous.raw);
  requireCondition(result.changes === 1, "normal-apply-changed", 409);
}

export function reserveNormalApply(
  db: DatabaseSync,
  record: NormalApplyRecord,
): void {
  requireCondition(db.isTransaction, "normal-apply-transaction-required");
  const parsed = schema.parse(record);
  requireCondition(parsed.state === "pending", "normal-apply-must-be-pending");
  const previous = readNormalApply(db);
  requireCondition(previous.status !== "blocked", "invalid-normal-apply");
  requireCondition(
    !conflictDecisionBlocks(db),
    "normal-apply-conflict-decision-active",
    409,
  );
  requireCondition(
    previous.status === "empty" ||
      (previous.status === "ready" &&
        previous.record.state !== "pending" &&
        previous.record.id !== parsed.id &&
        !(
          previous.record.state === "consumed" &&
          belongsToCurrentBinding(db, previous.record) &&
          !normalApplyResultMatches(db, previous.record)
        )),
    "normal-apply-present",
    409,
  );
  writeCas(db, previous, parsed);
}

export function assertPendingNormalApply(
  db: DatabaseSync,
  expected: NormalApplyRecord,
): void {
  const parsed = schema.parse(expected);
  requireCondition(parsed.state === "pending", "normal-apply-must-be-pending");
  const read = readNormalApply(db);
  requireCondition(
    read.status === "ready" &&
      read.record.state === "pending" &&
      read.raw === canonicalJson(parsed, 8192),
    "normal-apply-changed",
    409,
  );
}

export function completeNormalApply(
  db: DatabaseSync,
  expected: NormalApplyRecord,
): void {
  requireCondition(db.isTransaction, "normal-apply-transaction-required");
  assertPendingNormalApply(db, expected);
  requireCondition(
    !conflictDecisionBlocks(db),
    "normal-apply-conflict-decision-active",
    409,
  );
  const previous = readNormalApply(db) as Extract<
    NormalApplyRead,
    { status: "ready" }
  >;
  writeCas(db, previous, {
    ...previous.record,
    state: "consumed",
    result: {
      revision: previous.record.target.revision,
      checkpointHash: previous.record.target.checkpointHash,
    },
  });
}

export function cancelNormalApply(
  db: DatabaseSync,
  expected: NormalApplyRecord,
): void {
  requireCondition(db.isTransaction, "normal-apply-transaction-required");
  assertPendingNormalApply(db, expected);
  const previous = readNormalApply(db) as Extract<
    NormalApplyRead,
    { status: "ready" }
  >;
  writeCas(db, previous, { ...previous.record, state: "cancelled" });
}

export function normalApplyResultMatches(
  db: DatabaseSync,
  record: NormalApplyRecord,
): boolean {
  if (record.state !== "consumed") return false;
  try {
    const applied = db
      .prepare(
        "SELECT revision,checkpoint_json FROM workspace_sync_applied WHERE singleton=1",
      )
      .get() as
      | { revision: number; checkpoint_json: string }
      | undefined;
    if (!applied) return false;
    if (applied.revision < record.result.revision) return false;
    if (applied.revision === record.result.revision) {
      return (
        hashCheckpoint(JSON.parse(applied.checkpoint_json)) ===
        record.result.checkpointHash
      );
    }
    const inbox = db
      .prepare("SELECT change_json FROM workspace_sync_inbox WHERE revision=?")
      .get(record.result.revision) as
      | { change_json: string }
      | undefined;
    if (!inbox) return false;
    const change = JSON.parse(inbox.change_json) as {
      revision?: unknown;
      checkpointHash?: unknown;
      checkpoint?: unknown;
    };
    return (
      change.revision === record.result.revision &&
      typeof change.checkpointHash === "string" &&
      change.checkpointHash === record.result.checkpointHash &&
      hashCheckpoint(change.checkpoint as Parameters<typeof hashCheckpoint>[0]) === record.result.checkpointHash
    );
  } catch {
    return false;
  }
}

export function normalApplyBlocks(db: DatabaseSync): boolean {
  const read = readNormalApply(db);
  if (read.status === "blocked") return true;
  if (read.status === "empty") return false;
  if (read.record.state === "pending") return true;
  if (read.record.state !== "consumed") return false;
  try {
    const state=db.prepare("SELECT workspace_id,client_id,binding_id,server_epoch FROM workspace_sync_state WHERE singleton=1").get();
    if(!state)return true;
    if(!belongsToCurrentBinding(db,read.record))return false;
  } catch {return true;}
  return !normalApplyResultMatches(db, read.record);
}
