import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveTarget } from "../src/shared/conflict-recovery";
import {
  listConflictArchives,
  readConflictArchive,
} from "../src/sync/conflict-archive-catalog";
import {
  hashCheckpoint,
  MAX_CHECKPOINT_BYTES,
  type Checkpoint,
} from "../src/sync/protocol";
import { WORKSPACE_CONTENT_TABLES } from "../src/sync/workspace-checkpoint";

const databases: DatabaseSync[] = [];

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length > 0) {const db=databases.pop()!;if(db.isOpen)db.close();}
});

const STATE_SCHEMA = `CREATE TABLE workspace_sync_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  server_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL,
  clean_generation INTEGER NOT NULL,
  applied_revision INTEGER NOT NULL,
  received_cursor INTEGER NOT NULL,
  suppress_triggers INTEGER NOT NULL CHECK(suppress_triggers IN (0,1))
)`;

const ARCHIVE_SCHEMA = `CREATE TABLE workspace_sync_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

function checkpoint(name = "folio-workspace"): Checkpoint {
  const tables = Object.fromEntries(
    WORKSPACE_CONTENT_TABLES.map((table) => [table, []]),
  );
  return {
    format: "folio-checkpoint/v1",
    name,
    version: 1,
    payload: { tables },
    assets: [],
  } as Checkpoint;
}

function insertState(
  db: DatabaseSync,
  identity = {
    workspaceId: "workspace-a",
    clientId: "client-a",
    bindingId: "binding-a",
    serverEpoch: "epoch-a",
  },
): void {
  db.prepare(
    `INSERT INTO workspace_sync_state(
      singleton,schema_version,workspace_id,client_id,binding_id,server_epoch,
      generation,clean_generation,applied_revision,received_cursor,suppress_triggers
    ) VALUES(1,1,?,?,?,?,0,0,0,0,0)`,
  ).run(
    identity.workspaceId,
    identity.clientId,
    identity.bindingId,
    identity.serverEpoch,
  );
}

function insertArchive(
  db: DatabaseSync,
  value: Checkpoint | string,
  options: { operationId?: string; kind?: string; createdAt?: number } = {},
): number {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const result = db
    .prepare(
      "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
    )
    .run(
      options.operationId ?? "operation-" + Math.random().toString(16).slice(2),
      options.kind ?? "conflict-local",
      json,
      options.createdAt ?? 1,
    );
  return Number(result.lastInsertRowid);
}

function archiveDatabase(): DatabaseSync {
  const db = database();
  db.exec(STATE_SCHEMA);
  db.exec(ARCHIVE_SCHEMA);
  insertState(db);
  return db;
}

function validTarget(db: DatabaseSync): ArchiveTarget {
  const page = listConflictArchives(db, { limit: 1 });
  const target = page.items[0].target;
  if (target === null) throw new Error("expected a valid target");
  return target;
}

describe("conflict archive catalog", () => {
  it("returns an empty page without a state table and blocks an invalid state", () => {
    const empty = database();
    expect(listConflictArchives(empty)).toEqual({
      items: [],
      next: null,
      total: 0,
    });

    const missingRow = database();
    missingRow.exec(STATE_SCHEMA);
    expect(() => listConflictArchives(missingRow)).toThrow(/invalid-sync-state/);

    const invalid = database();
    invalid.exec(STATE_SCHEMA);
    insertState(invalid, {
      workspaceId: "",
      clientId: "client-a",
      bindingId: "binding-a",
      serverEpoch: "epoch-a",
    });
    expect(() => listConflictArchives(invalid)).toThrow(/invalid-sync-state/);
  });

  it("pages newest-first with a stable anchor and keyset cursor", () => {
    const db = archiveDatabase();
    for (let index = 1; index <= 5; index += 1) {
      insertArchive(db, checkpoint(), {
        operationId: "operation-" + index,
        createdAt: index,
      });
    }

    const first = listConflictArchives(db, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([5, 4]);
    expect(first.total).toBe(5);
    expect(first.next).toEqual({ anchor: 5, before: 4 });

    insertArchive(db, checkpoint(), {
      operationId: "operation-new",
      createdAt: 6,
    });
    const second = listConflictArchives(db, {
      limit: 2,
      cursor: first.next!,
    });
    expect(second.items.map((item) => item.id)).toEqual([3, 2]);
    expect(second.next).toEqual({ anchor: 5, before: 2 });

    const third = listConflictArchives(db, {
      limit: 2,
      cursor: second.next!,
    });
    expect(third.items.map((item) => item.id)).toEqual([1]);
    expect(third.next).toBeNull();
  });

  it("uses a 50 row default and accepts at most 100 rows", () => {
    const db = archiveDatabase();
    for (let index = 1; index <= 55; index += 1) {
      insertArchive(db, checkpoint(), { operationId: "operation-" + index });
    }
    const defaults = listConflictArchives(db);
    expect(defaults.items).toHaveLength(50);
    expect(defaults.next).toEqual({ anchor: 55, before: 6 });
    expect(listConflictArchives(db, { limit: 100 }).items).toHaveLength(55);

    expect(() => listConflictArchives(db, { limit: 0 })).toThrow(
      /invalid-archive-limit/,
    );
    expect(() => listConflictArchives(db, { limit: 101 })).toThrow(
      /invalid-archive-limit/,
    );
    expect(() => listConflictArchives(db, { limit: 1.5 })).toThrow(
      /invalid-archive-limit/,
    );
    expect(() =>
      listConflictArchives(db, {
        cursor: { anchor: 1, before: 1, extra: true } as never,
      }),
    ).toThrow();
  });

  it("isolates broken and oversized rows instead of failing the page", () => {
    const db = archiveDatabase();
    const validOne = insertArchive(db, checkpoint(), { operationId: "valid-1" });
    const broken = insertArchive(db, "{", { operationId: "broken" });
    const huge = insertArchive(db, "x".repeat(MAX_CHECKPOINT_BYTES + 1), {
      operationId: "huge",
    });
    const validTwo = insertArchive(db, checkpoint(), { operationId: "valid-2" });

    const page = listConflictArchives(db, { limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([
      validTwo,
      huge,
      broken,
      validOne,
    ]);
    expect(page.total).toBe(4);

    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get(validOne)).toMatchObject({
      valid: true,
      pages: 0,
      assets: 0,
      attachmentStatus: "not-checked",
      target: {
        operationId: "valid-1",
        checkpointHash: hashCheckpoint(checkpoint()),
      },
    });
    expect(byId.get(broken)).toMatchObject({
      valid: false,
      target: null,
      reason: "invalid-archive-checkpoint",
    });
    expect(byId.get(huge)).toMatchObject({
      valid: false,
      target: null,
      reason: "checkpoint-too-large",
    });
    expect(byId.get(huge)!.bytes).toBe(MAX_CHECKPOINT_BYTES + 1);
  });

  it("reads an exact target and returns the original checkpoint", () => {
    const db = archiveDatabase();
    insertArchive(db, checkpoint(), {
      operationId: "operation-read",
      kind: "conflict-remote",
      createdAt: 123,
    });
    const target = validTarget(db);

    const snapshot = readConflictArchive(db, target);
    expect(snapshot.target).toEqual(target);
    expect(snapshot.checkpoint).toEqual(checkpoint());
    expect(hashCheckpoint(snapshot.checkpoint)).toBe(target.checkpointHash);
    expect(target).toMatchObject({
      id: 1,
      operationId: "operation-read",
      kind: "conflict-remote",
      createdAt: 123,
    });
    expect(target.source).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects every target tuple mismatch, unknown id and changed source", () => {
    const db = archiveDatabase();
    insertArchive(db, checkpoint(), {
      operationId: "operation-read",
      kind: "conflict-local",
      createdAt: 10,
    });
    const target = validTarget(db);

    const mismatches: ArchiveTarget[] = [
      { ...target, source: "0".repeat(64) },
      { ...target, id: target.id + 1 },
      { ...target, operationId: "other-operation" },
      { ...target, kind: "other-kind" },
      { ...target, createdAt: target.createdAt + 1 },
      { ...target, checkpointHash: "0".repeat(64) },
    ];
    for (const mismatch of mismatches) {
      expect(() => readConflictArchive(db, mismatch)).toThrow();
    }

    db.prepare(
      "UPDATE workspace_sync_state SET server_epoch=? WHERE singleton=1",
    ).run("epoch-b");
    expect(() => readConflictArchive(db, target)).toThrow(
      /archive-source-mismatch/,
    );
    const refreshed = validTarget(db);
    expect(refreshed.source).not.toBe(target.source);
    expect(readConflictArchive(db, refreshed).checkpoint).toEqual(checkpoint());
  });

  it("rejects metadata changes and invalid replacement after listing", () => {
    const db = archiveDatabase();
    const id = insertArchive(db, checkpoint(), {
      operationId: "operation-read",
      createdAt: 10,
    });
    const target = validTarget(db);

    db.prepare("UPDATE workspace_sync_archives SET kind=? WHERE id=?").run(
      "changed-kind",
      id,
    );
    expect(() => readConflictArchive(db, target)).toThrow(
      /archive-target-mismatch/,
    );

    db.prepare(
      "UPDATE workspace_sync_archives SET kind=?,checkpoint_json=? WHERE id=?",
    ).run("conflict-local", "{", id);
    expect(() => readConflictArchive(db, target)).toThrow(
      /invalid-archive-checkpoint/,
    );
  });

  it("works inside an existing read transaction without writing", () => {
    const db = archiveDatabase();
    insertArchive(db, checkpoint(), { operationId: "operation-read" });
    const target = validTarget(db);
    const before = {
      state: db.prepare("SELECT * FROM workspace_sync_state").all(),
      archives: db.prepare("SELECT * FROM workspace_sync_archives").all(),
    };

    db.exec("BEGIN");
    try {
      expect(listConflictArchives(db).items).toHaveLength(1);
      expect(readConflictArchive(db, target).target).toEqual(target);
    } finally {
      db.exec("ROLLBACK");
    }
    expect(db.isTransaction).toBe(false);
    expect({
      state: db.prepare("SELECT * FROM workspace_sync_state").all(),
      archives: db.prepare("SELECT * FROM workspace_sync_archives").all(),
    }).toEqual(before);
  });
});

it("never reuses an unknown read snapshot after COMMIT and ROLLBACK both fail",()=>{
 const db=archiveDatabase();insertArchive(db,checkpoint());const exec=db.exec.bind(db);
 const spy=vi.spyOn(db,"exec").mockImplementation((sql:string)=>{
  if(sql==="COMMIT" || sql==="ROLLBACK")throw new Error("injected transaction cleanup failure");return exec(sql);
 });
 expect(()=>listConflictArchives(db)).toThrow("archive-connection-reopen-required");
 spy.mockRestore();
 expect(()=>listConflictArchives(db)).toThrow("archive-connection-reopen-required");
});
