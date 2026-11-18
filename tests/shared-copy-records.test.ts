import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import type { Store } from "../src/persistence/store";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";
import {
  commitSharedCopy,
  previewSharedCopy,
  type SharedCopySource,
} from "../src/collaboration/runtime/copy";
import { readRecords } from "../src/collaboration/runtime/records";
import { readPrivateCopySources } from "../src/main/shared-copy-source";

const HEAD_HASH = "a".repeat(64);
const properties = [
  { id: "name", name: "名前", type: "text" as const },
  { id: "summary", name: "概要", type: "date" as const },
  { id: "score", name: "点数", type: "number" as const },
  {
    id: "status",
    name: "状態",
    type: "select" as const,
    options: ["未着手", "進行中", "完了"],
  },
  { id: "done", name: "完了", type: "checkbox" as const },
];

function body(text: string, id: string): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id },
        content: [{ type: "text", text }],
      },
    ],
  };
}

function row(id: string, text: string, database: unknown = null, kind = "page") {
  return {
    id,
    schemaVersion: 1,
    parentId: null,
    title: `title-${id}`,
    icon: "",
    cover: "",
    position: 0,
    doc: body(text, `p-${id}`),
    kind,
    database,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    revision: 0,
    deletedAt: null,
  };
}

type Fixture = {
  store: Store;
  directory: string;
  db: DatabaseSync;
};

const cleanups: (() => void)[] = [];

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "folio-copy-records-"));
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE assets(id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
    CREATE TABLE record_databases(database_page_id TEXT PRIMARY KEY);
    CREATE TABLE record_memberships(
      page_id TEXT PRIMARY KEY,
      database_page_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      values_json TEXT NOT NULL
    );
  `);
  cleanups.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store: { db } as unknown as Store, directory, db };
}

function insertPage(db: DatabaseSync, page: unknown, id: string): void {
  db.prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)").run(
    id,
    JSON.stringify(page),
    "",
  );
}

function insertRecord(
  db: DatabaseSync,
  pageId: string,
  databaseId: string,
  position: number,
  values: Record<string, string | number | boolean>,
): void {
  db.prepare(
    "INSERT INTO record_memberships(page_id,database_page_id,position,values_json) VALUES(?,?,?,?)",
  ).run(pageId, databaseId, position, JSON.stringify(values));
}

function seeded(): Fixture {
  const value = fixture();
  insertPage(
    value.db,
    row("db1", "database body", { properties, rows: [] }, "database"),
    "db1",
  );
  value.db
    .prepare("INSERT INTO record_databases(database_page_id) VALUES(?)")
    .run("db1");
  insertPage(value.db, row("r1", "record one body"), "r1");
  insertPage(value.db, row("r2", "record two body"), "r2");
  insertRecord(value.db, "r1", "db1", 1, {
    name: "first",
    summary: "2026-11-10",
    score: 10,
    status: "進行中",
    done: false,
  });
  insertRecord(value.db, "r2", "db1", 0, {
    name: "second",
    summary: "2026-11-11",
    score: 2.5,
    status: "完了",
    done: true,
  });
  return value;
}

class TestStore implements StoragePort {
  readonly db = new DatabaseSync(":memory:");
  private readonly rows = new Map<string, Map<string, unknown>>();
  private readonly blobs = new Map<string, Map<string, Uint8Array>>();

  constructor() {
    this.db.exec("BEGIN");
    this.set("meta", "head", { epoch: "e", seq: 0, hash: HEAD_HASH });
    cleanups.push(() => {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      this.db.close();
    });
  }

  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(namespace: string, key: string): unknown | null {
    return this.rows.get(namespace)?.get(key) ?? null;
  }

  set(namespace: string, key: string, value: unknown | null): void {
    let bucket = this.rows.get(namespace);
    if (!bucket) {
      bucket = new Map();
      this.rows.set(namespace, bucket);
    }
    if (value === null) bucket.delete(key);
    else bucket.set(key, structuredClone(value));
  }

  all(namespace: string): { key: string; value: unknown }[] {
    return [...(this.rows.get(namespace)?.entries() ?? [])].map(
      ([key, value]) => ({ key, value }),
    );
  }

  blobGet(scope: string, hash: string): Uint8Array | null {
    return this.blobs.get(scope)?.get(hash)?.slice() ?? null;
  }

  blobPut(scope: string, hash: string, bytes: Uint8Array): void {
    let bucket = this.blobs.get(scope);
    if (!bucket) {
      bucket = new Map();
      this.blobs.set(scope, bucket);
    }
    bucket.set(hash, bytes.slice());
  }

  blobDelete(scope: string, hash: string): void {
    this.blobs.get(scope)?.delete(hash);
  }

  close(): void {}
}

function allocate(ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (id === undefined) throw new Error("allocation exhausted");
    index++;
    return id;
  };
}

function read(
  value: Fixture,
  ids: string[],
): SharedCopySource[] {
  return readPrivateCopySources(value.store, value.directory, ids);
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "NO_CODE";
  }
  return "NO_ERROR";
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("private copy sources for databases and records", () => {
  it("reads the selected database and both selected records with actual values", () => {
    const value = seeded();
    const sources = read(value, ["db1", "r1", "r2"]);
    expect(sources).toHaveLength(3);
    expect(sources[0]).toMatchObject({
      id: "db1",
      metadata: { kind: "database", properties },
    });
    expect(sources[1].metadata).toMatchObject({
      kind: "record",
      databaseId: "db1",
      position: 1,
      values: {
        name: "first",
        summary: "2026-11-10",
        score: 10,
        status: "進行中",
        done: false,
      },
    });
    expect(sources[2].metadata).toMatchObject({
      kind: "record",
      databaseId: "db1",
      position: 0,
      values: { name: "second", score: 2.5, status: "完了", done: true },
    });
    expect(sources[1].raw).toContain("record one body");
    expect(sources[2].raw).toContain("record two body");
  });

  it("rejects a record whose database was not explicitly selected", () => {
    const value = seeded();
    expect(failure(() => read(value, ["r1", "r2"]))).toBe(
      "COPY_SOURCE_RECORD_OUTSIDE_SELECTION",
    );
  });

  it("rejects a record from another unselected database", () => {
    const value = seeded();
    insertPage(value.db, row("db2", "other db", { properties, rows: [] }, "database"), "db2");
    value.db
      .prepare("INSERT INTO record_databases(database_page_id) VALUES(?)")
      .run("db2");
    insertPage(value.db, row("r3", "outsider body"), "r3");
    insertRecord(value.db, "r3", "db2", 0, {
      name: "outsider",
      summary: "",
      score: 1,
      status: "未着手",
      done: false,
    });
    expect(failure(() => read(value, ["db1", "r1", "r3"]))).toBe(
      "COPY_SOURCE_RECORD_OUTSIDE_SELECTION",
    );
  });

  it("refuses an unknown property value instead of stripping it", () => {
    const value = seeded();
    value.db
      .prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?")
      .run(JSON.stringify({ missing: "value" }), "r1");
    expect(failure(() => read(value, ["db1", "r1"]))).toBe("UNKNOWN_PROPERTY");
  });

  it("refuses a malformed selected record body", () => {
    const value = seeded();
    value.db.prepare("UPDATE pages SET data=? WHERE id=?").run(JSON.stringify({...row("r2", "broken"), doc:{type:"doc"}}), "r2");
    expect(failure(() => read(value, ["db1", "r1", "r2"]))).toBe(
      "UNSUPPORTED_DOCUMENT",
    );
  });
});

describe("shared copy preview and commit", () => {
  it("copies the database and records with fresh property IDs and mapped values", () => {
    const value = seeded();
    const sources = read(value, ["db1", "r1", "r2"]);
    const target = { orgId: "org1", workspaceId: "ws1" };
    const preview = previewSharedCopy(
      sources,
      ["db1", "r1", "r2"],
      target,
      allocate(["newdb", "newr1", "newr2"]),
    );
    expect(preview.databases).toHaveLength(1);
    expect(preview.records).toHaveLength(2);
    expect(preview.records[0].databaseId).toBe("newdb");
    expect(preview.records[0].position).toBe(1);
    const fresh = new Map(
      preview.databases[0].properties.map((property) => [properties.find(p => p.name === property.name)!.id, property.id]),
    );
    expect(new Set(fresh.values()).size).toBe(properties.length);
    expect(preview.records[0].values[fresh.get("name")!]).toBe("first");
    expect(preview.records[0].values[fresh.get("score")!]).toBe(10);
    expect(preview.records[0].values[fresh.get("status")!]).toBe("進行中");
    expect(preview.records[0].values[fresh.get("done")!]).toBe(false);
    expect(preview.documents[1].raw).toContain("record one body");

    const store = new TestStore();
    commitSharedCopy(store, preview, sources);
    const view = readRecords(store, preview.scopes[0]) as {
      databases: { id: string; properties: { id: string }[] }[];
      records: { id: string; databaseId: string; values: Record<string, unknown> }[];
    };
    expect(view.databases).toHaveLength(1);
    expect(view.databases[0].id).toBe("newdb");
    expect(view.databases[0].properties.map((property) => property.id)).toEqual(
      preview.databases[0].properties.map((property) => property.id),
    );
    expect(view.records).toHaveLength(2);
    expect(view.records).toContainEqual(
      expect.objectContaining({
        id: "newr1",
        databaseId: "newdb",
        values: expect.objectContaining({
          [fresh.get("name")!]: "first",
          [fresh.get("score")!]: 10,
          [fresh.get("status")!]: "進行中",
          [fresh.get("done")!]: false,
        }),
      }),
    );
    expect(store.get("documents", preview.scopes[0].incarnationId) === null).toBe(true);
  });

  it("keeps the existing page-only copy path working", () => {
    const value = fixture();
    insertPage(value.db, row("page1", "ordinary page body"), "page1");
    const sources = read(value, ["page1"]);
    expect(sources[0].metadata).toBeUndefined();
    const preview = previewSharedCopy(
      sources,
      ["page1"],
      { orgId: "org1", workspaceId: "ws1" },
      allocate(["newpage"]),
    );
    expect(preview.databases).toEqual([]);
    expect(preview.records).toEqual([]);
    const store = new TestStore();
    commitSharedCopy(store, preview, sources);
    expect(store.get("documents", `${"org1"}:${"ws1"}:${"newpage"}:${preview.scopes[0].incarnationId}`)).not.toBeNull();
    const page = store.get("pages", "org1:ws1:newpage") as { id: string };
    expect(page.id).toBe("newpage");
    expect(store.get("doclifecycles", "org1:ws1:newpage")).not.toBeNull();
  });
});


it("copies a selected record before its selected database without order-dependent rejection", () => {
 const f = seeded();
 const sources = readPrivateCopySources(f.store, f.directory, ["r1", "db1"]);
 let allocated = 0;
 const preview = previewSharedCopy(sources, ["r1", "db1"], {orgId:"org",workspaceId:"ws"}, () => "unordered-" + allocated++);
 expect(preview.records).toHaveLength(1);
 expect(preview.databases).toHaveLength(1);
});
