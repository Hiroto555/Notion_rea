import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  NORMAL_APPLY_KEY,
  assertPendingNormalApply,
  cancelNormalApply,
  completeNormalApply,
  normalApplyBlocks,
  normalApplyResultMatches,
  readNormalApply,
  reserveNormalApply,
  type NormalApplyRecord,
} from "../src/sync/normal-apply-journal";
import {
  CONFLICT_DECISION_KEY,
  completeConflictDecision,
  reserveConflictDecision,
} from "../src/sync/conflict-decision";
import type { WorkspaceConflictResolutionTarget } from "../src/shared/workspace-conflict-resolution";
import { canonicalJson, hashCheckpoint } from "../src/sync/protocol";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workspace_sync_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, binding_id TEXT NOT NULL, server_epoch TEXT NOT NULL);
    CREATE TABLE workspace_sync_applied(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, checkpoint_json TEXT NOT NULL);
    CREATE TABLE workspace_sync_inbox(revision INTEGER PRIMARY KEY, change_json TEXT NOT NULL);
    CREATE TABLE workspace_sync_conflicts(operation_id TEXT PRIMARY KEY, chosen TEXT);
    CREATE TABLE workspace_sync_outbox(operation_id TEXT PRIMARY KEY, commit_json TEXT);
    CREATE TABLE workspace_sync_archives(id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, kind TEXT NOT NULL, checkpoint_json TEXT NOT NULL);
  `);
  return db;
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function target(overrides: Partial<NormalApplyRecord["target"]> = {}) {
  return {
    workspaceId: "ws1",
    clientId: "client1",
    bindingId: "binding1",
    serverEpoch: "epoch1",
    revision: 5,
    checkpointHash: HASH_A,
    ...overrides,
  };
}

function pending(overrides: Partial<NormalApplyRecord> = {}): NormalApplyRecord {
  return {
    format: "folio-normal-apply/v1",
    id: randomUUID(),
    createdAt: 1,
    target: target(),
    state: "pending",
    ...overrides,
  } as NormalApplyRecord;
}

function consumed(
  revision: number,
  checkpointHash: string,
): Extract<NormalApplyRecord,{state:"consumed"}> {
  return {
    format: "folio-normal-apply/v1",
    id: randomUUID(),
    createdAt: 1,
    target: {
      workspaceId: "ws1",
      clientId: "client1",
      bindingId: "binding1",
      serverEpoch: "epoch1",
      revision,
      checkpointHash,
    },
    state: "consumed",
    result: { revision, checkpointHash },
  };
}

function conflictTarget(
  overrides: Partial<WorkspaceConflictResolutionTarget> = {},
): WorkspaceConflictResolutionTarget {
  return {
    version: 1,
    choice: "local",
    workspaceId: "ws1",
    clientId: "client1",
    bindingId: "binding1",
    serverEpoch: "epoch1",
    operationId: "op1",
    localRevision: 1,
    localCheckpointHash: HASH_A,
    remoteRevision: 1,
    remoteCheckpointHash: null,
    conflictGeneration: 0,
    generation: 1,
    cleanGeneration: 0,
    appliedRevision: 0,
    receivedCursor: 0,
    latestCheckpointHash: HASH_A,
    ...overrides,
  };
}

function checkpointJson(): string {
  return JSON.stringify({
    format: "folio-checkpoint/v1",
    name: "ws1",
    version: 1,
    payload: {},
    assets: [],
  });
}
const APPLIED_HASH = hashCheckpoint(JSON.parse(checkpointJson()));

function setBinding(db: DatabaseSync, bindingId = "binding1"): void {
  db.prepare(
    "INSERT INTO workspace_sync_state(singleton,workspace_id,client_id,binding_id,server_epoch) VALUES(1,'ws1','client1',?,'epoch1')",
  ).run(bindingId);
}

function setApplied(db: DatabaseSync, revision: number, json: string): void {
  db.prepare(
    "INSERT INTO workspace_sync_applied(singleton,revision,checkpoint_json) VALUES(1,?,?)",
  ).run(revision, json);
}

describe("normal-apply-journal", () => {
  it("exposes the fixed journal key", () => {
    expect(NORMAL_APPLY_KEY).toBe("folio.sync.normal-apply.v1");
  });

  it("reads empty when nothing is stored", () => {
    expect(readNormalApply(makeDb())).toEqual({ status: "empty" });
  });

  it("reports blocked for a corrupted value", () => {
    const db = makeDb();
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
      NORMAL_APPLY_KEY,
      "{not json",
    );
    expect(readNormalApply(db)).toEqual({ status: "blocked" });
  });

  it("reports blocked for a non-canonical value", () => {
    const db = makeDb();
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
      NORMAL_APPLY_KEY,
      JSON.stringify(pending()),
    );
    expect(readNormalApply(db)).toEqual({ status: "blocked" });
  });

  it("reports blocked when a consumed result does not equal the target", () => {
    const db = makeDb();
    const record = consumed(5, HASH_A);
    (record.result as { revision: number }).revision = 4;
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
      NORMAL_APPLY_KEY,
      JSON.stringify(record),
    );
    expect(readNormalApply(db)).toEqual({ status: "blocked" });
  });

  it("reports blocked when the stored value exceeds the 8KiB budget", () => {
    const db = makeDb();
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
      NORMAL_APPLY_KEY,
      JSON.stringify({ format: "folio-normal-apply/v1", pad: "x".repeat(9000) }),
    );
    expect(readNormalApply(db)).toEqual({ status: "blocked" });
  });

  it("requires a transaction to reserve", () => {
    const db = makeDb();
    expect(() => reserveNormalApply(db, pending())).toThrow(
      /normal-apply-transaction-required/,
    );
  });

  it("stores a pending record with a new id", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    expect(readNormalApply(db)).toMatchObject({
      status: "ready",
      record: { id: record.id, state: "pending" },
    });
  });

  it("rejects a non-pending reservation", () => {
    const db = makeDb();
    tx(db, () => {
      expect(() =>
        reserveNormalApply(
          db,
          { ...pending(), state: "cancelled" } as NormalApplyRecord,
        ),
      ).toThrow(/normal-apply-must-be-pending/);
    });
  });

  it("rejects a second pending reservation", () => {
    const db = makeDb();
    tx(db, () => reserveNormalApply(db, pending()));
    tx(db, () => {
      expect(() => reserveNormalApply(db, pending())).toThrow(
        /normal-apply-present/,
      );
    });
  });

  it("rejects reusing an old id after a terminal", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => cancelNormalApply(db, record));
    tx(db, () => {
      expect(() => reserveNormalApply(db, record)).toThrow(
        /normal-apply-present/,
      );
    });
  });

  it("CAS-replaces a cancelled terminal with a new id", () => {
    const db = makeDb();
    const first = pending();
    tx(db, () => reserveNormalApply(db, first));
    tx(db, () => cancelNormalApply(db, first));
    const second = pending();
    tx(db, () => reserveNormalApply(db, second));
    expect(readNormalApply(db)).toMatchObject({
      status: "ready",
      record: { id: second.id, state: "pending" },
    });
  });

  it("does not silently replace an unverified consumed record", () => {
    const db = makeDb();
    setBinding(db);
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => completeNormalApply(db, record));
    expect(readNormalApply(db)).toMatchObject({
      status: "ready",
      record: { state: "consumed" },
    });
    tx(db, () => {
      expect(() => reserveNormalApply(db, pending())).toThrow(
        /normal-apply-present/,
      );
    });
  });

  it("replaces a consumed record that is verified against applied state", () => {
    const db = makeDb();
    setBinding(db);
    setApplied(db, 5, checkpointJson());
    const record = pending({ target: target({ checkpointHash: APPLIED_HASH }) });
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => completeNormalApply(db, record));
    expect(normalApplyResultMatches(db, consumed(5, APPLIED_HASH))).toBe(true);
    tx(db, () => reserveNormalApply(db, pending()));
    expect(readNormalApply(db)).toMatchObject({
      status: "ready",
      record: { state: "pending" },
    });
  });

  it("rejects reserve when a conflict decision is pending", () => {
    const db = makeDb();
    tx(db, () => {
      reserveConflictDecision(db, randomUUID(), conflictTarget());
      expect(() => reserveNormalApply(db, pending())).toThrow(
        /normal-apply-conflict-decision-active/,
      );
    });
  });

  it("rejects reserve when the conflict decision is blocked", () => {
    const db = makeDb();
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
      CONFLICT_DECISION_KEY,
      "not canonical",
    );
    tx(db, () => {
      expect(() => reserveNormalApply(db, pending())).toThrow(
        /normal-apply-conflict-decision-active/,
      );
    });
  });

  it("rejects reserve when a same-binding consumed decision does not match", () => {
    const db = makeDb();
    setBinding(db);
    tx(db, () => {
      const id = randomUUID();
      const decision = conflictTarget();
      reserveConflictDecision(db, id, decision);
      completeConflictDecision(db, id, decision, {
        choice: "local",
        operationId: randomUUID(),
        checkpointHash: HASH_A,
      });
      expect(() => reserveNormalApply(db, pending())).toThrow(
        /normal-apply-conflict-decision-active/,
      );
    });
  });

  it("is not blocked by a consumed decision in a different binding", () => {
    const db = makeDb();
    setBinding(db, "binding2");
    tx(db, () => {
      const id = randomUUID();
      const decision = conflictTarget();
      reserveConflictDecision(db, id, decision);
      completeConflictDecision(db, id, decision, {
        choice: "local",
        operationId: randomUUID(),
        checkpointHash: HASH_A,
      });
      reserveNormalApply(db, pending());
    });
    expect(readNormalApply(db)).toMatchObject({
      status: "ready",
      record: { state: "pending" },
    });
  });

  it("asserts an exact pending record and rejects a mismatch", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => assertPendingNormalApply(db, record));
    tx(db, () => {
      expect(() =>
        assertPendingNormalApply(
          db,
          { ...record, target: target({ revision: 9 }) } as NormalApplyRecord,
        ),
      ).toThrow(/normal-apply-changed/);
    });
  });

  it("completes a pending record with a result equal to the target", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => completeNormalApply(db, record));
    const read = readNormalApply(db);
    expect(read).toMatchObject({
      status: "ready",
      record: {
        state: "consumed",
        result: {
          revision: record.target.revision,
          checkpointHash: record.target.checkpointHash,
        },
      },
    });
  });

  it("rejects complete outside a transaction and on a mismatch", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    expect(() => completeNormalApply(db, record)).toThrow(
      /normal-apply-transaction-required/,
    );
    tx(db, () => {
      expect(() =>
        completeNormalApply(
          db,
          { ...record, target: target({ revision: 9 }) } as NormalApplyRecord,
        ),
      ).toThrow(/normal-apply-changed/);
    });
  });

  it("rejects consume when a conflict decision is pending", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => {
      // Simulate a pre-existing incompatible record without bypassing a real guard.
      db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(CONFLICT_DECISION_KEY,
        canonicalJson({format:"folio-conflict-decision/v1",id:randomUUID(),createdAt:1,target:conflictTarget(),state:"pending"}));
      expect(() => completeNormalApply(db, record)).toThrow(
        /normal-apply-conflict-decision-active/,
      );
    });
  });

  it("cancels a pending record regardless of the conflict decision", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => {
      // Simulate a pre-existing incompatible record without bypassing a real guard.
      db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(CONFLICT_DECISION_KEY,
        canonicalJson({format:"folio-conflict-decision/v1",id:randomUUID(),createdAt:1,target:conflictTarget(),state:"pending"}));
      cancelNormalApply(db, record);
    });
    expect(readNormalApply(db)).toMatchObject({
      status: "ready",
      record: { state: "cancelled" },
    });
  });

  it("rejects cancel for a mismatched record", () => {
    const db = makeDb();
    const record = pending();
    tx(db, () => reserveNormalApply(db, record));
    tx(db, () => {
      expect(() =>
        cancelNormalApply(
          db,
          { ...record, target: target({ revision: 9 }) } as NormalApplyRecord,
        ),
      ).toThrow(/normal-apply-changed/);
    });
  });

  it("matches an applied checkpoint equal to the result revision", () => {
    const db = makeDb();
    setApplied(db, 5, checkpointJson());
    expect(normalApplyResultMatches(db, consumed(5, APPLIED_HASH))).toBe(true);
    expect(normalApplyResultMatches(db, consumed(5, HASH_B))).toBe(false);
  });

  it("returns false when the applied revision is before the result", () => {
    const db = makeDb();
    setApplied(db, 3, checkpointJson());
    expect(normalApplyResultMatches(db, consumed(5, APPLIED_HASH))).toBe(false);
  });

  it("uses the saved inbox hash when the applied revision is ahead", () => {
    const db = makeDb();
    setApplied(db, 6, checkpointJson());
    db.prepare(
      "INSERT INTO workspace_sync_inbox(revision,change_json) VALUES(?,?)",
    ).run(
      5,
      JSON.stringify({
        revision: 5,
        clientId: "client1",
        operationId: "op1",
        fingerprint: HASH_A,
        checkpointHash: APPLIED_HASH,
        checkpoint: JSON.parse(checkpointJson()),
      }),
    );
    expect(normalApplyResultMatches(db, consumed(5, APPLIED_HASH))).toBe(true);
    expect(normalApplyResultMatches(db, consumed(5, HASH_B))).toBe(false);
  });

  it("returns false when there is no applied row", () => {
    const db = makeDb();
    expect(normalApplyResultMatches(db, consumed(5, HASH_A))).toBe(false);
  });

  it("normalApplyBlocks reflects empty, blocked and consumed states", () => {
    const empty = makeDb();
    expect(normalApplyBlocks(empty)).toBe(false);

    const corrupt = makeDb();
    corrupt
      .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .run(NORMAL_APPLY_KEY, "{bad");
    expect(normalApplyBlocks(corrupt)).toBe(true);

    const pendingDb = makeDb();
    tx(pendingDb, () => reserveNormalApply(pendingDb, pending()));
    expect(normalApplyBlocks(pendingDb)).toBe(true);

    const unverified = makeDb();
    tx(unverified, () => {
      const record = pending();
      reserveNormalApply(unverified, record);
      completeNormalApply(unverified, record);
    });
    expect(normalApplyBlocks(unverified)).toBe(true);

    const verified = makeDb();
    setBinding(verified);
    setApplied(verified, 5, checkpointJson());
    tx(verified, () => {
      const record = pending({ target: target({ checkpointHash: APPLIED_HASH }) });
      reserveNormalApply(verified, record);
      completeNormalApply(verified, record);
    });
    expect(normalApplyBlocks(verified)).toBe(false);
  });
});
