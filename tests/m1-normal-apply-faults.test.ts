import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { WorkspaceSyncIntentJournal } from "../src/main/normal-apply-intent";
import { applyRestartIntent } from "../src/main/workspace-sync-restart";
import { WorkspaceSyncRestartCoordinator } from "../src/main/workspace-sync-restart-coordinator";
import { runStartupWorkspaceSyncDetailed } from "../src/main/workspace-sync-startup";
import { Store } from "../src/persistence/store";
import type { WorkspaceConflictResolutionTarget } from "../src/shared/workspace-conflict-resolution";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import {
  CONFLICT_DECISION_KEY,
  completeConflictDecision,
  reserveConflictDecision,
} from "../src/sync/conflict-decision";
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
  canonicalJson,
  hashCheckpoint,
  type Checkpoint,
} from "../src/sync/protocol";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

type Identity = {
  workspaceId: string;
  clientId: string;
  bindingId: string;
  serverEpoch: string;
};

type ApplyTarget = NormalApplyRecord["target"];

const digest = (value: number): string =>
  value.toString(16).padStart(64, "0").slice(-64);

const identity = (overrides: Partial<Identity> = {}): Identity => ({
  workspaceId: "ws1",
  clientId: "client1",
  bindingId: "bind1",
  serverEpoch: "epoch1",
  ...overrides,
});

const applyTarget = (
  revision = 2,
  checkpointHash = digest(2),
  overrides: Partial<Identity> = {},
): ApplyTarget => ({
  ...identity(overrides),
  revision,
  checkpointHash,
});

const checkpoint = (name = "ws1", version = 1): Checkpoint => ({
  format: "folio-checkpoint/v1",
  name,
  version,
  payload: { tables: {} },
  assets: [],
});

const pendingRecord = (
  target: ApplyTarget = applyTarget(),
  id = randomUUID(),
  createdAt = 1,
): NormalApplyRecord => ({
  format: "folio-normal-apply/v1",
  id,
  createdAt,
  target,
  state: "pending",
});

const consumedRecord = (
  target: ApplyTarget = applyTarget(),
  id = randomUUID(),
  createdAt = 1,
): NormalApplyRecord => ({
  format: "folio-normal-apply/v1",
  id,
  createdAt,
  target,
  state: "consumed",
  result: {
    revision: target.revision,
    checkpointHash: target.checkpointHash,
  },
});

const conflictTarget = (
  overrides: Partial<WorkspaceConflictResolutionTarget> = {},
): WorkspaceConflictResolutionTarget => ({
  version: 1,
  choice: "local",
  ...identity(),
  operationId: "op1",
  localRevision: 1,
  localCheckpointHash: digest(1),
  remoteRevision: 2,
  remoteCheckpointHash: digest(2),
  conflictGeneration: 1,
  generation: 1,
  cleanGeneration: 1,
  appliedRevision: 1,
  receivedCursor: 2,
  latestCheckpointHash: digest(1),
  ...overrides,
});

const conflictRecord = (
  target: WorkspaceConflictResolutionTarget,
  id = randomUUID(),
) => ({
  format: "folio-conflict-decision/v1",
  id,
  target,
  createdAt: 1,
  state: "pending",
});

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function insertSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}

function writeApplied(
  db: DatabaseSync,
  revision: number,
  value: Checkpoint,
): void {
  db.prepare(
    "INSERT INTO workspace_sync_applied(singleton,revision,checkpoint_json) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,checkpoint_json=excluded.checkpoint_json",
  ).run(revision, canonicalJson(value));
}

function writeInbox(
  db: DatabaseSync,
  revision: number,
  value: Checkpoint,
): void {
  const change = {
    revision,
    clientId: "client1",
    operationId: `op${revision}`,
    fingerprint: digest(revision),
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
  db.prepare(
    "INSERT INTO workspace_sync_inbox(revision,change_json,skip_apply) VALUES(?,?,0) ON CONFLICT(revision) DO UPDATE SET change_json=excluded.change_json",
  ).run(revision, canonicalJson(change));
}

function appliedRow(
  db: DatabaseSync,
): { revision: number; checkpoint_json: string } | undefined {
  return db
    .prepare(
      "SELECT revision,checkpoint_json FROM workspace_sync_applied WHERE singleton=1",
    )
    .get() as { revision: number; checkpoint_json: string } | undefined;
}

function readyRecord(
  db: DatabaseSync,
): Extract<ReturnType<typeof readNormalApply>, { status: "ready" }> {
  const read = readNormalApply(db);
  if (read.status !== "ready") throw new Error("expected a ready record");
  return read;
}

function memoryDb(target: ApplyTarget = applyTarget()): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE workspace_sync_state(
      singleton INTEGER PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      server_epoch TEXT NOT NULL
    );
    CREATE TABLE workspace_sync_applied(
      singleton INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL,
      checkpoint_json TEXT NOT NULL
    );
    CREATE TABLE workspace_sync_inbox(
      revision INTEGER PRIMARY KEY,
      change_json TEXT NOT NULL,
      skip_apply INTEGER NOT NULL
    );
    CREATE TABLE workspace_sync_conflicts(
      operation_id TEXT PRIMARY KEY,
      chosen TEXT
    );
    CREATE TABLE workspace_sync_outbox(
      operation_id TEXT PRIMARY KEY,
      commit_json TEXT NOT NULL
    );
    CREATE TABLE workspace_sync_archives(
      operation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL
    );
  `);
  transaction(db, () => {
    db.prepare(
      "INSERT INTO workspace_sync_state(singleton,workspace_id,client_id,binding_id,server_epoch) VALUES(1,?,?,?,?)",
    ).run(
      target.workspaceId,
      target.clientId,
      target.bindingId,
      target.serverEpoch,
    );
  });
  return db;
}

class FaultStore extends Store {
  fault: "before" | "after" | null = null;

  private appliedRevision(): number | null {
    try {
      const row = this.db
        .prepare(
          "SELECT revision FROM workspace_sync_applied WHERE singleton=1",
        )
        .get() as { revision: number } | undefined;
      return row?.revision ?? null;
    } catch {
      return null;
    }
  }

  override transaction<T>(work: () => T): T {
    if (this.fault === null) return super.transaction(work);
    const before = this.appliedRevision();
    let fireAfter = false;
    try {
      const value = super.transaction(() => {
        const result = work();
        if (this.fault !== null && this.appliedRevision() !== before) {
          if (this.fault === "before") {
            this.fault = null;
            throw new Error("fault-before-commit");
          }
          fireAfter = true;
        }
        return result;
      });
      if (fireAfter && this.fault === "after") {
        this.fault = null;
        throw new Error("fault-after-commit");
      }
      return value;
    } catch (error) {
      if (this.fault === "before" || this.fault === "after") this.fault = null;
      throw error;
    }
  }
}

function journalStore(target: ApplyTarget = applyTarget()): {
  directory: string;
  store: FaultStore;
} {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-normal-apply-fault-"),
  );
  const store = new FaultStore(join(directory, "workspace.sqlite"));
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_state(
      singleton INTEGER PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      server_epoch TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_sync_applied(
      singleton INTEGER PRIMARY KEY,
      revision INTEGER NOT NULL,
      checkpoint_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_sync_inbox(
      revision INTEGER PRIMARY KEY,
      change_json TEXT NOT NULL,
      skip_apply INTEGER NOT NULL
    );
  `);
  store.transaction(() => {
    store.db
      .prepare(
        "INSERT INTO workspace_sync_state(singleton,workspace_id,client_id,binding_id,server_epoch) VALUES(1,?,?,?,?)",
      )
      .run(
        target.workspaceId,
        target.clientId,
        target.bindingId,
        target.serverEpoch,
      );
  });
  return { directory, store };
}

type Loopback = {
  root: string;
  stores: Store[];
  closeServer: () => Promise<void>;
  device: (name: string) => {
    directory: string;
    store: FaultStore;
    workspaceId: string;
    clientId: string;
    bindingId: string;
    token: string;
    baseUrl: string;
    canApply: () => boolean;
  };
};

async function withLoopback(run: (loopback: Loopback) => Promise<void>): Promise<void> {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-normal-apply-loopback-"),
  );
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  let closed = false;
  const closeServer = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  const device = (name: string) => {
    const directory = join(root, name);
    mkdirSync(directory);
    mkdirSync(join(directory, "assets"));
    const store = new FaultStore(join(directory, "workspace.sqlite"));
    stores.push(store);
    const clientId = randomUUID();
    const bindingId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    server.registerDevice({ workspaceId, ownerId, clientId, token });
    return {
      directory,
      store,
      workspaceId,
      clientId,
      bindingId,
      token,
      baseUrl: server.url,
      canApply: () => true,
    };
  };
  try {
    await run({ root, stores, closeServer, device });
  } finally {
    await closeServer();
    for (const store of stores) {
      try {
        store.close();
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function prepareRemoteApply(
  a: ReturnType<Loopback["device"]>,
  b: ReturnType<Loopback["device"]>,
): Promise<{
  pageId: string;
  journal: WorkspaceSyncIntentJournal;
  target: ApplyTarget;
  recordId: string;
}> {
  const page = a.store.create(null, "page", "received");
  const publisher = await openWorkspaceSync({ ...a, mode: "publish" });
  await publisher.sendPending();
  const receiver = await openWorkspaceSync({ ...b, mode: "join" });
  await receiver.receiveAndStage();
  const target = receiver.restartTarget();
  if (!target) throw new Error("expected a staged restart target");
  const journal = new WorkspaceSyncIntentJournal(b.directory, b.store);
  journal.prepare(target);
  journal.create(target);
  const pending = journal.pending();
  if (!pending) throw new Error("expected a pending normal apply record");
  return { pageId: page.id, journal, target, recordId: pending.id };
}

describe("normal apply journal", () => {
  it("normal pending and conflict pending each reject the other reservation", () => {
    const db = memoryDb();
    try {
      const normal = pendingRecord();
      transaction(db, () => reserveNormalApply(db, normal));
      expect(() =>
        transaction(db, () =>
          reserveConflictDecision(db, randomUUID(), conflictTarget()),
        ),
      ).toThrow("normal-apply-present");

      transaction(db, () => cancelNormalApply(db, normal));
      transaction(db, () =>
        reserveConflictDecision(db, randomUUID(), conflictTarget()),
      );
      expect(() =>
        transaction(db, () => reserveNormalApply(db, pendingRecord())),
      ).toThrow("normal-apply-conflict-decision-active");
    } finally {
      db.close();
    }
  });

  it("each pending journal rejects the other journal's consume", () => {
    const db = memoryDb();
    try {
      const normal = pendingRecord();
      transaction(db, () => reserveNormalApply(db, normal));
      const target = conflictTarget();
      const conflictId = randomUUID();
      insertSetting(
        db,
        CONFLICT_DECISION_KEY,
        canonicalJson(conflictRecord(target, conflictId), 8192),
      );

      expect(() =>
        transaction(db, () => completeNormalApply(db, normal)),
      ).toThrow("normal-apply-conflict-decision-active");
      expect(() =>
        transaction(db, () =>
          completeConflictDecision(db, conflictId, target, {
            choice: "local",
            operationId: randomUUID(),
            checkpointHash: target.latestCheckpointHash,
          }),
        ),
      ).toThrow("normal-apply-present");
      expect(readyRecord(db).record.id).toBe(normal.id);
      expect(readyRecord(db).record.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  it("cancel rejects a different id and still cancels its own pending record beside a conflict", () => {
    const db = memoryDb();
    try {
      const normal = pendingRecord();
      transaction(db, () => reserveNormalApply(db, normal));
      expect(() =>
        transaction(db, () =>
          cancelNormalApply(db, { ...normal, id: randomUUID() }),
        ),
      ).toThrow("normal-apply-changed");

      insertSetting(
        db,
        CONFLICT_DECISION_KEY,
        canonicalJson(conflictRecord(conflictTarget()), 8192),
      );
      transaction(db, () => cancelNormalApply(db, normal));
      const read = readyRecord(db);
      expect(read.record.id).toBe(normal.id);
      expect(read.record.state).toBe("cancelled");
    } finally {
      db.close();
    }
  });

  it("reserve replaces only terminal records and CAS rejects any changed expected bytes", () => {
    const db = memoryDb();
    try {
      const first = pendingRecord();
      transaction(db, () => reserveNormalApply(db, first));
      transaction(db, () => cancelNormalApply(db, first));

      const second = pendingRecord(applyTarget(3, digest(3)));
      transaction(db, () => reserveNormalApply(db, second));
      expect(() =>
        transaction(db, () =>
          assertPendingNormalApply(db, {
            ...second,
            createdAt: second.createdAt + 1,
          }),
        ),
      ).toThrow("normal-apply-changed");
      expect(() =>
        transaction(db, () =>
          reserveNormalApply(db, pendingRecord(applyTarget(4, digest(4)))),
        ),
      ).toThrow("normal-apply-present");
    } finally {
      db.close();
    }

    const consumedDb = memoryDb();
    try {
      const consumed = pendingRecord();
      transaction(consumedDb, () => reserveNormalApply(consumedDb, consumed));
      transaction(consumedDb, () => completeNormalApply(consumedDb, consumed));
      const read = readyRecord(consumedDb);
      expect(read.record.state).toBe("consumed");
      expect(normalApplyResultMatches(consumedDb, read.record)).toBe(false);
      expect(() =>
        transaction(consumedDb, () =>
          reserveNormalApply(consumedDb, pendingRecord(applyTarget(3, digest(3)))),
        ),
      ).toThrow("normal-apply-present");
      expect(readyRecord(consumedDb).record.id).toBe(consumed.id);
    } finally {
      consumedDb.close();
    }
  });

  it("result evidence uses applied history and inbox, not the current edited content", () => {
    const db = memoryDb();
    try {
      const cp2 = checkpoint("ws1", 2);
      const cp3 = checkpoint("ws1", 3);
      const target = applyTarget(2, hashCheckpoint(cp2));
      const record = consumedRecord(target);
      insertSetting(db, NORMAL_APPLY_KEY, canonicalJson(record, 8192));

      writeApplied(db, 3, cp3);
      writeInbox(db, 2, cp2);
      expect(normalApplyResultMatches(db, record)).toBe(true);
      expect(normalApplyBlocks(db)).toBe(false);

      db.prepare("DELETE FROM workspace_sync_inbox WHERE revision=2").run();
      expect(normalApplyResultMatches(db, record)).toBe(false);
      expect(normalApplyBlocks(db)).toBe(true);

      writeApplied(db, 1, checkpoint("ws1", 1));
      expect(normalApplyResultMatches(db, record)).toBe(false);

      writeApplied(db, 2, cp2);
      expect(normalApplyResultMatches(db, record)).toBe(true);
      writeApplied(db, 2, cp3);
      expect(normalApplyResultMatches(db, record)).toBe(false);

      insertSetting(
        db,
        NORMAL_APPLY_KEY,
        canonicalJson(
          consumedRecord(applyTarget(2, digest(2), { bindingId: "bind2" })),
          8192,
        ),
      );
      expect(normalApplyBlocks(db)).toBe(false);

      insertSetting(db, NORMAL_APPLY_KEY, "{");
      expect(readNormalApply(db).status).toBe("blocked");
      expect(normalApplyBlocks(db)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("normal apply transaction faults", () => {
  it("a fault before COMMIT keeps the pending record and applies atomically on the same id", () => {
    const { directory, store } = journalStore();
    let reopened: Store | undefined;
    try {
      const cp2 = checkpoint("ws1", 2);
      const record = pendingRecord(applyTarget(2, hashCheckpoint(cp2)));
      transaction(store.db, () => reserveNormalApply(store.db, record));
      store.fault = "before";
      expect(() =>
        store.transaction(() => {
          writeApplied(store.db, 2, cp2);
          completeNormalApply(store.db, record);
        }),
      ).toThrow("fault-before-commit");
      store.close();

      reopened = new Store(join(directory, "workspace.sqlite"));
      const afterFault = readyRecord(reopened.db);
      expect(afterFault.record.id).toBe(record.id);
      expect(afterFault.record.state).toBe("pending");
      expect(appliedRow(reopened.db)).toBeUndefined();

      const reopenedDb = reopened.db;
      transaction(reopenedDb, () => {
        writeApplied(reopenedDb, 2, cp2);
        completeNormalApply(reopenedDb, record);
      });
      const consumed = readyRecord(reopened.db);
      expect(consumed.record.id).toBe(record.id);
      expect(consumed.record.state).toBe("consumed");
      expect(normalApplyResultMatches(reopened.db, consumed.record)).toBe(true);
      expect(normalApplyBlocks(reopened.db)).toBe(false);
    } finally {
      if (reopened) reopened.close();
      else store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("a fault after COMMIT persists consumed and applied together for reopen reconciliation", () => {
    const { directory, store } = journalStore();
    let reopened: Store | undefined;
    try {
      const cp2 = checkpoint("ws1", 2);
      const record = pendingRecord(applyTarget(2, hashCheckpoint(cp2)));
      transaction(store.db, () => reserveNormalApply(store.db, record));
      store.fault = "after";
      expect(() =>
        store.transaction(() => {
          writeApplied(store.db, 2, cp2);
          completeNormalApply(store.db, record);
        }),
      ).toThrow("fault-after-commit");

      const committed = readyRecord(store.db);
      expect(committed.record.id).toBe(record.id);
      expect(committed.record.state).toBe("consumed");
      expect(normalApplyResultMatches(store.db, committed.record)).toBe(true);
      expect(appliedRow(store.db)?.revision).toBe(2);
      store.close();

      reopened = new Store(join(directory, "workspace.sqlite"));
      const read = readyRecord(reopened.db);
      expect(read.record.id).toBe(record.id);
      expect(read.record.state).toBe("consumed");
      expect(normalApplyResultMatches(reopened.db, read.record)).toBe(true);
      expect(normalApplyBlocks(reopened.db)).toBe(false);
    } finally {
      if (reopened) reopened.close();
      else store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("normal apply product path", () => {
  it("rolls content and consumed back together before COMMIT, then applies on retry", async () => {
    await withLoopback(async (loopback) => {
      const a = loopback.device("a");
      const b = loopback.device("b");
      const { pageId, journal, target, recordId } = await prepareRemoteApply(a, b);
      await loopback.closeServer();

      b.store.fault = "before";
      const failed = await applyRestartIntent({
        directory: b.directory,
        sync: { ...b, store: b.store },
        readRecovery: () => ({ status: "empty", generation: 0 }),
      });
      expect(failed).toBe("blocked");
      expect(journal.pending()?.id).toBe(recordId);
      expect(b.store.pages()).toEqual([]);
      const state = b.store.db
        .prepare(
          "SELECT applied_revision FROM workspace_sync_state WHERE singleton=1",
        )
        .get() as { applied_revision: number };
      expect(state.applied_revision).toBe(0);

      const retried = await applyRestartIntent({
        directory: b.directory,
        sync: { ...b, store: b.store },
        readRecovery: () => ({ status: "empty", generation: 0 }),
      });
      expect(retried).toBe("applied");
      expect(b.store.get(pageId).title).toBe("received");
      expect(readyRecord(b.store.db).record.id).toBe(recordId);
      expect(readyRecord(b.store.db).record.state).toBe("consumed");
      expect(journal.read()).toEqual({ status: "empty" });
      expect(target.revision).toBe(1);
    });
  });

  it("keeps content and consumed atomic after COMMIT and reconciles by reopen without replay", async () => {
    await withLoopback(async (loopback) => {
      const a = loopback.device("a");
      const b = loopback.device("b");
      const { pageId, target, recordId } = await prepareRemoteApply(a, b);
      await loopback.closeServer();

      b.store.fault = "after";
      const unknown = await applyRestartIntent({
        directory: b.directory,
        sync: { ...b, store: b.store },
        readRecovery: () => ({ status: "empty", generation: 0 }),
      });
      expect(unknown).toBe("blocked");
      expect(readyRecord(b.store.db).record.id).toBe(recordId);
      expect(readyRecord(b.store.db).record.state).toBe("consumed");
      expect(normalApplyResultMatches(b.store.db, readyRecord(b.store.db).record)).toBe(true);
      expect(b.store.get(pageId).title).toBe("received");

      const index = loopback.stores.indexOf(b.store);
      if (index >= 0) loopback.stores.splice(index, 1);
      b.store.close();
      const reopened = new Store(join(b.directory, "workspace.sqlite"));
      loopback.stores.push(reopened);
      const read = readyRecord(reopened.db);
      expect(read.record.id).toBe(recordId);
      expect(read.record.state).toBe("consumed");
      expect(normalApplyBlocks(reopened.db)).toBe(false);

      const reconciled = await applyRestartIntent({
        directory: b.directory,
        sync: { ...b, store: reopened },
        readRecovery: () => ({ status: "empty", generation: 0 }),
      });
      expect(reconciled).toBe("already-applied");
      expect(reopened.get(pageId).title).toBe("received");
      expect(reopened.pages()).toHaveLength(1);
      const applied = appliedRow(reopened.db);
      expect(applied).toBeDefined();
      expect(hashCheckpoint(JSON.parse(applied!.checkpoint_json) as Checkpoint)).toBe(
        target.checkpointHash,
      );
    });
  });
});

describe("cold restart coordination", () => {
  it("does not reuse a stale UUID to cancel a newer reservation", () => {
    const { directory, store } = journalStore();
    try {
      const journal = new WorkspaceSyncIntentJournal(directory, store);
      const aTarget = applyTarget(2, digest(2));
      journal.prepare(aTarget);
      journal.create(aTarget);
      const aId = journal.pending()?.id;
      if (!aId) throw new Error("expected reservation A");
      const coordinator = new WorkspaceSyncRestartCoordinator(journal, undefined);
      const aStatus = coordinator.status();
      if (!aStatus.available) throw new Error("expected available reservation A");
      expect(aStatus.reservationId).toBe(aId);
      expect(aStatus.canCancel).toBe(true);

      expect(journal.cancelStored(aId)).toBe(true);
      const bTarget = applyTarget(3, digest(3));
      journal.prepare(bTarget);
      journal.create(bTarget);
      const bId = journal.pending()?.id;
      if (!bId) throw new Error("expected reservation B");
      expect(bId).not.toBe(aId);

      expect(coordinator.cancelRestart(aId).result).toBe("blocked");
      expect(journal.pending()?.id).toBe(bId);
      const bStatus = coordinator.status();
      if (!bStatus.available) throw new Error("expected available reservation B");
      expect(bStatus.reservationId).toBe(bId);
      expect(coordinator.cancelRestart(bId).result).toBe("cancelled");
      expect(journal.pending()).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("shows blocked without sync settings for a legacy sidecar or a corrupt record", () => {
    const { directory, store } = journalStore();
    try {
      const journal = new WorkspaceSyncIntentJournal(directory, store);
      const coordinator = new WorkspaceSyncRestartCoordinator(journal, undefined);
      writeFileSync(join(directory, ".folio-sync-apply-intent"), "{}");
      expect(journal.read()).toEqual({ status: "blocked" });
      expect(coordinator.status()).toMatchObject({
        available: true,
        canRequest: false,
        reason: "legacy-intent",
      });
      rmSync(join(directory, ".folio-sync-apply-intent"));

      insertSetting(store.db, NORMAL_APPLY_KEY, "{");
      expect(readNormalApply(store.db).status).toBe("blocked");
      expect(journal.read()).toEqual({ status: "blocked" });
      expect(coordinator.status()).toMatchObject({
        available: true,
        canRequest: false,
        reason: "intent-blocked",
      });
      expect(journal.pending()).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("startup reconnect", () => {
  it("does not offer a manual reconnect around a mismatched consumed result", async () => {
    await withLoopback(async (loopback) => {
      const b = loopback.device("b");
      const publisher = await openWorkspaceSync({ ...b, mode: "publish" });
      await publisher.sendPending();
      await loopback.closeServer();

      const env = {
        FOLIO_SYNC_ENABLED: "1",
        FOLIO_DATA_DIR: b.directory,
        FOLIO_SYNC_URL: b.baseUrl,
        FOLIO_SYNC_WORKSPACE: b.workspaceId,
        FOLIO_SYNC_CLIENT: b.clientId,
        FOLIO_SYNC_BINDING: b.bindingId,
        FOLIO_SYNC_TOKEN: b.token,
      };
      const readRecovery = () => ({ status: "empty" as const, generation: 0 });
      const first = await runStartupWorkspaceSyncDetailed(b.store, readRecovery, env);
      expect(first.reconnect).toBeTypeOf("function");

      const row = b.store.db
        .prepare(
          "SELECT workspace_id,client_id,binding_id,server_epoch FROM workspace_sync_state WHERE singleton=1",
        )
        .get() as {
        workspace_id: string;
        client_id: string;
        binding_id: string;
        server_epoch: string;
      };
      const state: Identity = {
        workspaceId: row.workspace_id,
        clientId: row.client_id,
        bindingId: row.binding_id,
        serverEpoch: row.server_epoch,
      };
      const target: ApplyTarget = {
        ...state,
        revision: 5,
        checkpointHash: digest(5),
      };
      insertSetting(
        b.store.db,
        NORMAL_APPLY_KEY,
        canonicalJson(consumedRecord(target), 8192),
      );
      expect(normalApplyBlocks(b.store.db)).toBe(true);
      expect(() => first.reconnect!()).toThrow("reconnect-held");

      const second = await runStartupWorkspaceSyncDetailed(b.store, readRecovery, env);
      expect(second.reconnect).toBeUndefined();
      expect(second.opened).toBeUndefined();
      expect(second.message).toContain("blocked");
    });
  });
});
