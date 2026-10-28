import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { commitDatabaseOperation, resolveDatabaseOperation, readDatabaseSnapshot } from "../src/persistence/database-operations";
import { prepareDatabaseCreation, type DatabaseOperation } from "../src/shared/database-operation";
import { emptyDatabase, type DatabaseSettings } from "../src/shared/types";
import { sendDatabaseOperation, resolveDatabaseOperation as resolveRemote } from "../src/renderer/reliable-database-operation";

function fixture() {
  const root = mkdtempSync(resolve("output/r5-database-operations-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const {rows: _rows, ...defaults} = emptyDatabase();
  const settings: DatabaseSettings = {...defaults, properties: [
    {id: "note", name: "メモ", type: "text"}, {id: "estimate", name: "見積", type: "number"}, {id: "done", name: "完了", type: "checkbox"},
  ]};
  const create = () => commitDatabaseOperation(store, prepareDatabaseCreation("Tasks", null, settings));
  const operation = (command: DatabaseOperation["command"]): DatabaseOperation => ({operationId: randomUUID(), sessionId: randomUUID(), seq: 1, command});
  return {root, store, settings, create, operation, dispose() {store.close(); rmSync(root, {recursive: true, force: true});}};
}

it("explicit creation initializes v4 atomically while preserving legacy rows, and leaves a v3 SQLite snapshot", () => {
  const f = fixture();
  try {
    let legacy = f.store.create(null, "database", "Legacy");
    legacy = f.store.update(legacy.id, 0, {database: {...legacy.database!, rows: [{id: "old-row", title: "Retained", values: {status: "未着手"}}]}});
    const raw = f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(legacy.id)!.data;
    const result = f.create();
    expect(result.status).toBe("applied");
    expect(result.page).toMatchObject({title: "Tasks", revision: 0, kind: "database"});
    expect(result.database).toMatchObject({revision: 0, records: [], settings: f.settings});
    expect(f.store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
    expect(f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(legacy.id)!.data).toBe(raw);
    expect(f.store.load().recordDatabaseIds).toEqual([result.page!.id]);
    const copies = readdirSync(f.root).filter((name) => name.includes(".pre-r5-records-"));
    expect(copies).toHaveLength(1);
    const snapshot = new DatabaseSync(join(f.root, copies[0]), {readOnly: true});
    try {
      expect(snapshot.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
      expect(snapshot.prepare("SELECT data FROM pages WHERE id=?").get(legacy.id)!.data).toBe(raw);
      expect(snapshot.prepare("SELECT count(*) AS n FROM pages").get()!.n).toBe(1);
    } finally {snapshot.close();}
  } finally {f.dispose();}
});

it("missing creation ACK resolves to one stable Page after reopen; same ID with different input is rejected", async () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Tasks", null, f.settings);
    const unknown = await sendDatabaseOperation(operation, async (request) => {f.store.handle(request); throw new Error("lost ACK");});
    expect(unknown.status).toBe("unknown");
    const applied = await resolveRemote(operation, async (request) => f.store.handle(request));
    expect(applied.status).toBe("applied");
    f.store.close();
    const reopened = new Store(join(f.root, "workspace.sqlite"));
    try {
      expect(commitDatabaseOperation(reopened, operation)).toEqual(applied);
      expect(reopened.pages()).toHaveLength(1);
      expect(commitDatabaseOperation(reopened, {...operation, command: {...operation.command, title: "Changed"} as typeof operation.command}).status).toBe("rejected");
      expect(reopened.get(applied.page!.id).title).toBe("Tasks");
    } finally {reopened.close();}
  } finally {f.dispose();}
});

it("receipt failure rolls back schema, version and new DB together; rejected invalid parent also leaves v3 unchanged", () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Tasks", null, f.settings);
    f.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON save_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    expect(() => commitDatabaseOperation(f.store, operation)).toThrow(/receipt failure/);
    expect(f.store.pages()).toHaveLength(0);
    expect(f.store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
    expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='record_memberships'").get()).toBeUndefined();
    expect(resolveDatabaseOperation(f.store, operation).status).toBe("unknown");
    f.store.db.exec("DROP TRIGGER fail_receipt");
    const invalid = prepareDatabaseCreation("Invalid", "missing-parent", f.settings);
    expect(commitDatabaseOperation(f.store, invalid).status).toBe("rejected");
    expect(f.store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
    expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='record_memberships'").get()).toBeUndefined();
    expect(resolveDatabaseOperation(f.store, invalid).status).toBe("rejected");
  } finally {f.dispose();}
});

it("creates a record with checked owner revision and property schema, without changing owner revision", () => {
  const f = fixture();
  try {
    const created = f.create(), owner = created.page!;
    const operation = f.operation({kind: "createRecord", databasePageId: owner.id, revision: owner.revision,
      title: "New row", values: {note: "hello", estimate: 3, done: false}});
    const result = commitDatabaseOperation(f.store, operation);
    expect(result).toMatchObject({status: "applied", page: {title: "New row", revision: 0}, record: {databasePageId: owner.id, revision: 0}, database: {revision: 0}});
    expect(commitDatabaseOperation(f.store, operation)).toEqual(result);
    expect(readDatabaseSnapshot(f.store, owner.id).database.records).toHaveLength(1);
    expect(f.store.get(owner.id)).toEqual(owner);
    for (const command of [
      {...operation.command, revision: 2},
      {...operation.command, values: {done: "wrong"}},
      {...operation.command, values: {missing: true}},
    ]) expect(commitDatabaseOperation(f.store, f.operation(command as typeof operation.command)).status).toBe("rejected");
    expect(readDatabaseSnapshot(f.store, owner.id).database.records).toHaveLength(1);
  } finally {f.dispose();}
});

it("commits owner title/body and settings with one revision, and rejects stale/schema-destroying writes", () => {
  const f = fixture();
  try {
    const created = f.create(), owner = created.page!;
    const first = f.settings.views[0];
    const settings = {...f.settings, views: f.settings.views.map((view) => ({...view, name: "Renamed", filterText: "find"})), filter: "find"};
    const doc = {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "Database notes"}]}]};
    const operation = f.operation({kind: "updateDatabase", databasePageId: owner.id, revision: 0, patch: {title: "Changed", doc}, settings});
    const result = commitDatabaseOperation(f.store, operation);
    expect(result).toMatchObject({status: "applied", page: {title: "Changed", doc, revision: 1}, database: {revision: 1, settings}});
    expect(f.store.versions(owner.id)).toHaveLength(1);
    expect(f.store.versions(owner.id)[0].database!.views[0].name).toBe(first.name);
    expect(commitDatabaseOperation(f.store, f.operation(operation.command)).status).toBe("rejected");
    const destructive = {...settings, properties: settings.properties.filter((property) => property.id !== "note")};
    expect(commitDatabaseOperation(f.store, f.operation({kind: "updateDatabase", databasePageId: owner.id, revision: 1, patch: {}, settings: destructive})).status).toBe("rejected");
    expect(f.store.get(owner.id)).toEqual(result.page);
  } finally {f.dispose();}
});

it("shares operation-ID collision protection with ordinary Page save receipts", () => {
  const f = fixture();
  try {
    const page = f.store.create(null, "page", "Page"), id = randomUUID();
    const saved = f.store.commitSave({operationId: id, sessionId: randomUUID(), seq: 1, pageId: page.id, databasePageId: null, revision: 0, patch: {title: "Saved"}});
    expect(saved.status).toBe("applied");
    expect(commitDatabaseOperation(f.store, {...prepareDatabaseCreation("DB", null, f.settings), operationId: id}).status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(1);
    expect(readdirSync(f.root).some((name) => name.includes(".pre-r5-records-"))).toBe(false);
  } finally {f.dispose();}
});

it("leaves receipt absence unknown and rejects corrupted applied ACKs", async () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Tasks", null, f.settings);
    expect(resolveDatabaseOperation(f.store, operation).status).toBe("unknown");
    const result = commitDatabaseOperation(f.store, operation);
    expect((await sendDatabaseOperation(operation, async () => ({...result, seq: 9}))).status).toBe("unknown");
    expect((await sendDatabaseOperation(operation, async () => ({...result, page: {...result.page!, title: "Wrong"}}))).status).toBe("unknown");
    expect(f.store.pages()).toHaveLength(1);
  } finally {f.dispose();}
});

it("refuses receipt resolution and reads on a poisoned connection containing an uncommitted result", () => {
  const f = fixture();
  try {
    const created = f.create(), db = f.store.db;
    const operation = f.operation({kind: "updateDatabase", databasePageId: created.page!.id, revision: 0, patch: {title: "Uncommitted"}, settings: f.settings});
    const exec = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error("synthetic transaction-control failure");
      exec(sql);
    });
    expect(() => commitDatabaseOperation(f.store, operation)).toThrow(/unknown/);
    expect(db.isTransaction).toBe(true);
    expect(db.prepare("SELECT operation_id FROM save_receipts WHERE operation_id=?").get(operation.operationId)).toBeDefined();
    expect(() => resolveDatabaseOperation(f.store, operation)).toThrow(/unusable/);
    expect(() => commitDatabaseOperation(f.store, operation)).toThrow(/unusable/);
    expect(() => readDatabaseSnapshot(f.store, created.page!.id)).toThrow(/unusable/);
    spy.mockRestore();
    db.exec("ROLLBACK");
  } finally {f.dispose();}
});

it("rejects an owner update at the revision limit before any write or receipt", () => {
  const f = fixture();
  try {
    const created = f.create(), page = f.store.write({...created.page!, revision: Number.MAX_SAFE_INTEGER});
    const operation = f.operation({kind: "updateDatabase", databasePageId: page.id, revision: page.revision, patch: {title: "Overflow"}, settings: f.settings});
    expect(() => commitDatabaseOperation(f.store, operation)).toThrow();
    expect(f.store.get(page.id)).toEqual(page);
    expect(f.store.db.prepare("SELECT operation_id FROM save_receipts WHERE operation_id=?").get(operation.operationId)).toBeUndefined();
  } finally {f.dispose();}
});
