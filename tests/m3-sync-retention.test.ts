import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSyncRetentionAdmission,
  CLIENT_RETENTION_LIMITS,
  inspectSyncRetention,
  SERVER_RETENTION_LIMITS,
  type SyncRetentionLimits,
} from "../src/sync/sync-retention";
import { SyncError } from "../src/sync/protocol";

const SERVER_SCHEMA = `
  CREATE TABLE checkpoint_changes (
    workspace_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    change_json TEXT NOT NULL,
    PRIMARY KEY(workspace_id, revision)
  );
  CREATE TABLE checkpoint_operations (
    workspace_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    commit_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY(workspace_id, client_id, operation_id)
  );
`;

const CLIENT_SCHEMA = `
  CREATE TABLE workspace_sync_outbox (
    operation_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    generation INTEGER NOT NULL,
    commit_json TEXT NOT NULL,
    result_json TEXT
  );
  CREATE TABLE workspace_sync_inbox (
    revision INTEGER PRIMARY KEY,
    change_json TEXT NOT NULL,
    skip_apply INTEGER NOT NULL CHECK(skip_apply IN (0, 1))
  );
  CREATE TABLE workspace_sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    local_commit_json TEXT NOT NULL,
    remote_result_json TEXT NOT NULL,
    local_generation INTEGER NOT NULL,
    local_checkpoint_json TEXT NOT NULL,
    chosen TEXT CHECK(chosen IS NULL OR chosen IN ('local', 'remote')),
    chosen_at INTEGER
  );
  CREATE TABLE workspace_sync_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

const databases: DatabaseSync[] = [];

function open(schema: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  databases.push(db);
  return db;
}

function captureError(run: () => void): SyncError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    return error as SyncError;
  }
  throw new Error("expected SyncError");
}

function expectSyncError(run: () => void, code: string): SyncError {
  const error = captureError(run);
  expect(error.code).toBe(code);
  expect(error.status).toBe(409);
  return error;
}

function seedServer(db: DatabaseSync): void {
  db.prepare("INSERT INTO checkpoint_changes VALUES(?,?,?)").run("w", 1, "abc");
  db.prepare("INSERT INTO checkpoint_changes VALUES(?,?,?)").run("w", 2, "de");
  db.prepare("INSERT INTO checkpoint_operations VALUES(?,?,?,?,?,?)").run(
    "w",
    "c",
    "op",
    "fingerprint",
    "abcd",
    "ef",
  );
}

function seedClient(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO workspace_sync_outbox(operation_id,fingerprint,generation,commit_json,result_json) VALUES(?,?,?,?,?)",
  ).run("op1", "f", 1, "abcd", "ef");
  db.prepare(
    "INSERT INTO workspace_sync_outbox(operation_id,fingerprint,generation,commit_json,result_json) VALUES(?,?,?,?,NULL)",
  ).run("op2", "f", 2, "x");
  db.prepare(
    "INSERT INTO workspace_sync_inbox(revision,change_json,skip_apply) VALUES(?,?,?)",
  ).run(1, "abc", 0);
  db.prepare(
    "INSERT INTO workspace_sync_conflicts(operation_id,local_commit_json,remote_result_json,local_generation,local_checkpoint_json) VALUES(?,?,?,?,?)",
  ).run("op1", "zz", "yyy", 1, "w");
  db.prepare(
    "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
  ).run("op1", "conflict-local", "qqq", 1);
}

function changes(db: DatabaseSync): unknown {
  return db.prepare("SELECT total_changes() AS value").get();
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("inspectSyncRetention", () => {
  it("measures the actual server tables and columns without JSON parsing", () => {
    const db = open(SERVER_SCHEMA);
    seedServer(db);

    expect(inspectSyncRetention(db, "server")).toEqual({
      rows: 3,
      bytes: 11,
      maxRows: SERVER_RETENTION_LIMITS.maxRows,
      maxBytes: SERVER_RETENTION_LIMITS.maxBytes,
      held: false,
    });
  });

  it("measures the actual client outbox, inbox, conflicts and archives columns", () => {
    const db = open(CLIENT_SCHEMA);
    seedClient(db);

    expect(inspectSyncRetention(db, "client")).toEqual({
      rows: 5,
      bytes: 19,
      maxRows: CLIENT_RETENTION_LIMITS.maxRows,
      maxBytes: CLIENT_RETENTION_LIMITS.maxBytes,
      held: false,
    });
  });

  it("treats the exact cap as healthy and lower caps as held", () => {
    const db = open(SERVER_SCHEMA);
    seedServer(db);

    expect(
      inspectSyncRetention(db, "server", { maxRows: 3, maxBytes: 11 }),
    ).toMatchObject({ rows: 3, bytes: 11, maxRows: 3, maxBytes: 11, held: false });
    expect(
      inspectSyncRetention(db, "server", { maxRows: 2, maxBytes: 11 }).held,
    ).toBe(true);
    expect(
      inspectSyncRetention(db, "server", { maxRows: 3, maxBytes: 10 }).held,
    ).toBe(true);
  });

  it("accepts only positive limits that lower the fixed defaults", () => {
    const db = open(SERVER_SCHEMA);
    seedServer(db);
    const invalid: unknown[] = [
      { maxRows: 0, maxBytes: 1 },
      { maxRows: 1, maxBytes: 0 },
      { maxRows: -1, maxBytes: 1 },
      { maxRows: 1, maxBytes: -1 },
      { maxRows: 1.5, maxBytes: 1 },
      { maxRows: 1, maxBytes: 1.5 },
      { maxRows: Number.NaN, maxBytes: 1 },
      { maxRows: 1, maxBytes: Number.POSITIVE_INFINITY },
      { maxRows: SERVER_RETENTION_LIMITS.maxRows + 1, maxBytes: 1 },
      { maxRows: 1, maxBytes: SERVER_RETENTION_LIMITS.maxBytes + 1 },
      { maxRows: 1 },
      { maxBytes: 1 },
      null,
      [],
    ];

    for (const limits of invalid) {
      expectSyncError(
        () =>
          inspectSyncRetention(
            db,
            "server",
            limits as SyncRetentionLimits,
          ),
        "sync-retention-unknown",
      );
    }
  });

  it("cannot raise the client cap above its own default", () => {
    const db = open(CLIENT_SCHEMA);
    seedClient(db);
    expectSyncError(
      () =>
        inspectSyncRetention(db, "client", {
          maxRows: CLIENT_RETENTION_LIMITS.maxRows + 1,
          maxBytes: CLIENT_RETENTION_LIMITS.maxBytes,
        }),
      "sync-retention-unknown",
    );
  });

  it("reports unknown for missing tables and missing actual columns", () => {
    const empty = open("");
    expectSyncError(
      () => inspectSyncRetention(empty, "server"),
      "sync-retention-unknown",
    );

    const partialServer = open(
      "CREATE TABLE checkpoint_changes(workspace_id TEXT, revision INTEGER, change_json TEXT)",
    );
    expectSyncError(
      () => inspectSyncRetention(partialServer, "server"),
      "sync-retention-unknown",
    );

    const wrongColumn = open(`
      CREATE TABLE checkpoint_changes(workspace_id TEXT, revision INTEGER, change TEXT);
      CREATE TABLE checkpoint_operations(commit_json TEXT, result_json TEXT);
    `);
    expectSyncError(
      () => inspectSyncRetention(wrongColumn, "server"),
      "sync-retention-unknown",
    );

    const partialClient = open(
      CLIENT_SCHEMA.replace(/CREATE TABLE workspace_sync_archives[\s\S]*?\);/, ""),
    );
    expectSyncError(
      () => inspectSyncRetention(partialClient, "client"),
      "sync-retention-unknown",
    );
  });
});

describe("assertSyncRetentionAdmission", () => {
  it("admits exact projected caps and rejects row or byte overflow", () => {
    const db = open(SERVER_SCHEMA);
    seedServer(db);
    const exact: SyncRetentionLimits = { maxRows: 3, maxBytes: 11 };

    expect(() =>
      assertSyncRetentionAdmission(db, "server", { rows: 0, bytes: 0 }, exact),
    ).not.toThrow();
    expectSyncError(
      () =>
        assertSyncRetentionAdmission(
          db,
          "server",
          { rows: 1, bytes: 0 },
          exact,
        ),
      "sync-retention-held",
    );
    expectSyncError(
      () =>
        assertSyncRetentionAdmission(
          db,
          "server",
          { rows: 0, bytes: 1 },
          exact,
        ),
      "sync-retention-held",
    );
  });

  it("rejects invalid additional amounts as unknown", () => {
    const db = open(SERVER_SCHEMA);
    seedServer(db);
    const invalid: unknown[] = [
      null,
      [],
      {},
      { rows: -1, bytes: 0 },
      { rows: 0, bytes: -1 },
      { rows: 1.5, bytes: 0 },
      { rows: 0, bytes: 1.5 },
      { rows: Number.NaN, bytes: 0 },
      { rows: 0, bytes: Number.POSITIVE_INFINITY },
      { rows: Number.MAX_SAFE_INTEGER + 1, bytes: 0 },
      { rows: "1", bytes: 0 },
      { rows: 0, bytes: "1" },
    ];

    for (const additional of invalid) {
      expectSyncError(
        () =>
          assertSyncRetentionAdmission(
            db,
            "server",
            additional as { rows: number; bytes: number },
          ),
        "sync-retention-unknown",
      );
    }
  });

  it("reports unknown instead of overflowing on projected totals", () => {
    const db = open(SERVER_SCHEMA);
    seedServer(db);

    expectSyncError(
      () =>
        assertSyncRetentionAdmission(db, "server", {
          rows: Number.MAX_SAFE_INTEGER,
          bytes: 0,
        }),
      "sync-retention-unknown",
    );
    expectSyncError(
      () =>
        assertSyncRetentionAdmission(db, "server", {
          rows: 0,
          bytes: Number.MAX_SAFE_INTEGER,
        }),
      "sync-retention-unknown",
    );
  });

  it("never writes, deletes or alters unknown data and tables", () => {
    const db = open(SERVER_SCHEMA);
    seedServer(db);
    db.exec(
      "CREATE TABLE unrelated(secret TEXT); INSERT INTO unrelated VALUES('keep-me');",
    );
    const beforeChanges = changes(db);
    const beforeServer = {
      changes: db.prepare("SELECT * FROM checkpoint_changes ORDER BY revision").all(),
      operations: db
        .prepare("SELECT * FROM checkpoint_operations ORDER BY operation_id")
        .all(),
      unrelated: db.prepare("SELECT * FROM unrelated").all(),
      schema: db
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
        .all(),
    };

    inspectSyncRetention(db, "server");
    expectSyncError(
      () =>
        assertSyncRetentionAdmission(
          db,
          "server",
          { rows: 1, bytes: 0 },
          { maxRows: 3, maxBytes: 11 },
        ),
      "sync-retention-held",
    );

    expect(changes(db)).toEqual(beforeChanges);
    expect(
      db.prepare("SELECT * FROM checkpoint_changes ORDER BY revision").all(),
    ).toEqual(beforeServer.changes);
    expect(
      db.prepare("SELECT * FROM checkpoint_operations ORDER BY operation_id").all(),
    ).toEqual(beforeServer.operations);
    expect(db.prepare("SELECT * FROM unrelated").all()).toEqual(
      beforeServer.unrelated,
    );
    expect(
      db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
    ).toEqual(beforeServer.schema);
  });

  it("keeps unknown-table failures read-only", () => {
    const db = open("CREATE TABLE unknown_data(value TEXT); INSERT INTO unknown_data VALUES('x')");
    const before = changes(db);

    expectSyncError(
      () =>
        assertSyncRetentionAdmission(db, "server", { rows: 0, bytes: 0 }),
      "sync-retention-unknown",
    );

    expect(changes(db)).toEqual(before);
    expect(db.prepare("SELECT * FROM unknown_data").all()).toEqual([
      { value: "x" },
    ]);
  });
});
