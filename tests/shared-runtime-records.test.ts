import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Doc, Property } from "../src/shared/types";
import {
  CollaborationError,
  type Json,
  type ResourceCommand,
  type Scope,
} from "../src/collaboration/runtime/contract";
import {
  applyRecords,
  readRecords,
} from "../src/collaboration/runtime/records";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";

class TestStore implements StoragePort {
  readonly db: DatabaseSync;
  private readonly failOnce = new Map<string, number>();

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      "CREATE TABLE kv(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))",
    );
  }

  failNext(namespace: string): void {
    this.failOnce.set(namespace, (this.failOnce.get(namespace) ?? 0) + 1);
  }

  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(namespace: string, key: string): unknown | null {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE namespace=? AND key=?")
      .get(namespace, key) as { value: string } | undefined;
    return row === undefined ? null : JSON.parse(row.value);
  }

  set(namespace: string, key: string, value: unknown | null): void {
    const remaining = this.failOnce.get(namespace) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) this.failOnce.delete(namespace);
      else this.failOnce.set(namespace, remaining - 1);
      throw new Error("injected write failure");
    }
    if (value === null) {
      this.db
        .prepare("DELETE FROM kv WHERE namespace=? AND key=?")
        .run(namespace, key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO kv(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
      )
      .run(namespace, key, JSON.stringify(value));
  }

  all(namespace: string): { key: string; value: unknown }[] {
    const rows = this.db
      .prepare("SELECT key,value FROM kv WHERE namespace=? ORDER BY key")
      .all(namespace) as { key: string; value: string }[];
    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
  }

  blobGet(): Uint8Array | null {
    return null;
  }

  blobPut(): void {}

  blobDelete(): void {}

  close(): void {
    this.db.close();
  }
}

type View = {
  databases: {
    id: string;
    revision: number;
    properties: Property[];
    deleted: boolean;
  }[];
  records: {
    id: string;
    databaseId: string;
    revision: number;
    title: string;
    values: Record<string, string | number | boolean>;
    deleted: boolean;
  }[];
  pages: { id: string; parentId: string | null; order: number }[];
  document: { document: Doc; tables: unknown[]; tombstones: string[] } | null;
};

const scope = (over: Partial<Scope> = {}): Scope => ({
  orgId: "org",
  workspaceId: "ws",
  documentId: "rec1",
  incarnationId: "inc1",
  ...over,
});

const document = (text = "hello"): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text }],
    },
  ],
});

const properties: Property[] = [
  { id: "text", name: "Text", type: "text" },
  { id: "number", name: "Number", type: "number" },
  {
    id: "select",
    name: "Select",
    type: "select",
    options: ["todo", "doing", "done"],
  },
  { id: "date", name: "Date", type: "date" },
  { id: "checkbox", name: "Checkbox", type: "checkbox" },
];

function command(action: string, payload: unknown): ResourceCommand {
  return { kind: "resource", action, payload: payload as Json };
}

function run(
  store: TestStore,
  s: Scope,
  action: string,
  payload: unknown,
): Json {
  return store.transaction(() =>
    applyRecords(store, s, command(action, payload)),
  );
}

function view(store: TestStore, s: Scope): View {
  return readRecords(store, s) as unknown as View;
}

function createDatabase(store: TestStore, s: Scope, databaseId = "db1"): void {
  run(store, s, "db.create", {
    databaseId,
    revision: 0,
    properties,
  });
}

function createRecord(
  store: TestStore,
  s: Scope,
  values: Record<string, string | number | boolean> = {
    text: "hello",
    number: 12.5,
    select: "doing",
    date: "2026-11-10",
    checkbox: true,
  },
  databaseId = "db1",
  doc: Doc = document(),
): void {
  run(store, s, "record.create", {
    databaseId,
    revision: 0,
    title: "Record",
    values,
    document: doc,
  });
}

function failure(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    return "Error: " + (error instanceof Error ? error.message : String(error));
  }
  throw new Error("Expected an error");
}

describe("shared runtime records", () => {
  it("creates records with all five property types and stores the checked document", () => {
    const store = new TestStore();
    const s = scope();
    createDatabase(store, s);
    createRecord(store, s);

    const first = view(store, s);
    expect(first.databases).toHaveLength(1);
    expect(first.databases[0]).toMatchObject({
      id: "db1",
      revision: 0,
      deleted: false,
    });
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({
      id: "rec1",
      databaseId: "db1",
      revision: 0,
      title: "Record",
      deleted: false,
    });
    expect(first.records[0].values).toEqual({
      text: "hello",
      number: 12.5,
      select: "doing",
      date: "2026-11-10",
      checkbox: true,
    });
    expect(first.pages).toEqual([
      { id: "db1", parentId: null, order: 0 },
      { id: "rec1", parentId: null, order: 1 },
    ]);
    expect(first.document?.document).toEqual(document());

    const stored = first.document;
    run(store, s, "record.patch", {
      databaseId: "db1",
      revision: 0,
      schemaRevision: 0,
      title: "Updated",
      values: { select: "done", number: null },
    });
    const second = view(store, s);
    expect(second.records[0]).toMatchObject({
      revision: 1,
      title: "Updated",
      values: {
        text: "hello",
        select: "done",
        date: "2026-11-10",
        checkbox: true,
      },
    });
    expect(second.records[0].values).not.toHaveProperty("number");
    expect(second.document).toEqual(stored);
  });

  it("refuses invalid payloads and values without mutating caller input or the store", () => {
    const store = new TestStore();
    const s = scope();
    createDatabase(store, s);

    const bad = (
      values: unknown,
      documentValue: unknown = document(),
    ): Json => ({
      databaseId: "db1",
      revision: 0,
      title: "Bad",
      values: values as Json,
      document: documentValue as Json,
    });

    const cases: [string, Json, string][] = [
      [
        "unknown field",
        {
          databaseId: "db1",
          revision: 0,
          title: "Bad",
          values: {},
          document: document(),
          extra: true,
        } as unknown as Json,
        "UNKNOWN_PAYLOAD_FIELD",
      ],
      ["raw object", bad({ text: { value: "x" } }), "INVALID_VALUE"],
      ["invalid select", bad({ select: "missing" }), "INVALID_VALUE"],
      ["invalid date", bad({ date: "2026-02-30" }), "INVALID_VALUE"],
      ["unsafe number", bad({ number: Infinity }), "INVALID_VALUE"],
      ["nan number", bad({ number: NaN }), "INVALID_VALUE"],
      ["raw checkbox", bad({ checkbox: "true" }), "INVALID_VALUE"],
      ["unknown property", bad({ legacy: "x" }), "UNKNOWN_PROPERTY"],
    ];

    for (const [label, payload, code] of cases) {
      const before = JSON.stringify(payload);
      expect(
        failure(() => run(store, s, "record.create", payload)),
        label,
      ).toBe(code);
      expect(JSON.stringify(payload)).toBe(before);
      expect(view(store, s).records).toHaveLength(0);
    }

    expect(
      failure(() =>
        run(
          store,
          s,
          "record.create",
          bad({}, { type: "doc", content: [{ type: "paragraph" }] }),
        ),
      ),
    ).toMatch(/^UNSUPPORTED_DOCUMENT/);
    expect(view(store, s).records).toHaveLength(0);
  });

  it("enforces owner, record revision and schema revision preconditions", () => {
    const store = new TestStore();
    const s = scope();
    createDatabase(store, s);
    createRecord(store, s);

    expect(
      failure(() =>
        run(store, s, "record.patch", {
          databaseId: "other",
          revision: 0,
          schemaRevision: 0,
          title: "No",
        }),
      ),
    ).toBe("OWNER_MISMATCH");
    expect(
      failure(() =>
        run(store, s, "record.patch", {
          databaseId: "db1",
          revision: 9,
          schemaRevision: 0,
          title: "No",
        }),
      ),
    ).toBe("STALE_RECORD");
    expect(
      failure(() =>
        run(store, s, "record.patch", {
          databaseId: "db1",
          revision: 0,
          schemaRevision: 9,
          title: "No",
        }),
      ),
    ).toBe("STALE_SCHEMA");

    const incompatible = properties.map((property) =>
      property.id === "select" ? { ...property, options: ["todo"] } : property,
    );
    expect(
      failure(() =>
        run(store, s, "db.schema", {
          databaseId: "db1",
          revision: 0,
          properties: incompatible,
        }),
      ),
    ).toBe("SCHEMA_VALUE_LOSS");
    expect(view(store, s).databases[0].revision).toBe(0);
    expect(view(store, s).records[0].values.select).toBe("doing");

    const changedType = properties.map((property) =>
      property.id === "text"
        ? { ...property, type: "number" as const }
        : property,
    );
    expect(
      failure(() =>
        run(store, s, "db.schema", {
          databaseId: "db1",
          revision: 0,
          properties: changedType,
        }),
      ),
    ).toBe("SCHEMA_VALUE_LOSS");

    run(store, s, "db.schema", {
      databaseId: "db1",
      revision: 0,
      properties: [...properties, { id: "extra", name: "Extra", type: "text" }],
    });
    expect(view(store, s).databases[0].revision).toBe(1);
    expect(
      failure(() =>
        run(store, scope({ documentId: "rec2" }), "record.create", {
          databaseId: "db1",
          revision: 0,
          title: "Stale owner",
          values: {},
          document: document(),
        }),
      ),
    ).toBe("STALE_DATABASE");

    expect(
      failure(() =>
        run(store, s, "record.patch", {
          databaseId: "db1",
          revision: 0,
          schemaRevision: 0,
          title: "Old schema",
        }),
      ),
    ).toBe("STALE_SCHEMA");

    run(store, s, "record.patch", {
      databaseId: "db1",
      revision: 0,
      schemaRevision: 1,
      title: "First",
    });
    expect(view(store, s).records[0].revision).toBe(1);
    expect(
      failure(() =>
        run(store, s, "record.patch", {
          databaseId: "db1",
          revision: 0,
          schemaRevision: 1,
          title: "ABA",
        }),
      ),
    ).toBe("STALE_RECORD");
    expect(view(store, s).records[0].title).toBe("First");
  });

  it("rolls back every write when creation fails at a later namespace", () => {
    const store = new TestStore();
    const s = scope();
    createDatabase(store, s);
    store.failNext("documents");
    expect(failure(() => createRecord(store, s))).toBe(
      "Error: injected write failure",
    );
    const after = view(store, s);
    expect(after.records).toHaveLength(0);
    expect(after.pages).toEqual([{ id: "db1", parentId: null, order: 0 }]);
    expect(after.document).toBeNull();

    expect(
      failure(() =>
        applyRecords(
          store,
          s,
          command("record.create", {
            databaseId: "db1",
            revision: 0,
            title: "Record",
            values: {},
            document: document(),
          }),
        ),
      ),
    ).toBe("TRANSACTION_REQUIRED");
    expect(view(store, s).records).toHaveLength(0);
  });

  it("moves pages without cycles, self-parenting or changing record ownership", () => {
    const store = new TestStore();
    const s = scope({ documentId: "a" });
    store.transaction(() => {
      store.set("pages", "org:ws:a", { id: "a", parentId: null, order: 0 });
      store.set("pages", "org:ws:b", { id: "b", parentId: "a", order: 0 });
      store.set("pages", "org:ws:c", { id: "c", parentId: null, order: 1 });
      store.set("pages", "org:ws:d", { id: "d", parentId: "b", order: 0 });
    });

    expect(
      failure(() =>
        run(store, s, "page.move", { parentId: "a", beforeId: null }),
      ),
    ).toBe("MOVE_CYCLE");
    expect(
      failure(() =>
        run(store, s, "page.move", { parentId: null, beforeId: "a" }),
      ),
    ).toBe("MOVE_CYCLE");
    expect(
      failure(() =>
        run(store, s, "page.move", { parentId: "b", beforeId: null }),
      ),
    ).toBe("MOVE_CYCLE");
    expect(
      failure(() =>
        run(store, s, "page.move", { parentId: null, beforeId: "d" }),
      ),
    ).toBe("BEFORE_NOT_SIBLING");
    expect(
      failure(() =>
        run(store, s, "page.move", { parentId: "missing", beforeId: null }),
      ),
    ).toBe("PARENT_MISSING");

    run(store, scope({ documentId: "c" }), "page.move", {
      parentId: null,
      beforeId: "a",
    });
    expect(
      view(store, s).pages.filter((page) => page.parentId === null),
    ).toEqual([
      { id: "c", parentId: null, order: 0 },
      { id: "a", parentId: null, order: 1 },
    ]);

    const recordScope = scope({ documentId: "rec1" });
    createDatabase(store, recordScope);
    createRecord(store, recordScope);
    run(store, recordScope, "page.move", { parentId: null, beforeId: null });
    const after = view(store, recordScope);
    expect(after.records[0].databaseId).toBe("db1");
    expect(after.document?.document).toEqual(document());
    expect(after.pages.find((page) => page.id === "rec1")?.parentId).toBeNull();
  });

  it("keeps identical IDs in different workspaces separate", () => {
    const store = new TestStore();
    const a = scope({ orgId: "orgA", workspaceId: "wsA", documentId: "rec1" });
    const b = scope({ orgId: "orgB", workspaceId: "wsB", documentId: "rec1" });
    createDatabase(store, a);
    createDatabase(store, b);
    createRecord(
      store,
      a,
      { text: "alpha", number: 1, select: "todo", date: "", checkbox: false },
      "db1",
      document("alpha body"),
    );
    createRecord(
      store,
      b,
      { text: "beta", number: 2, select: "done", date: "", checkbox: true },
      "db1",
      document("beta body"),
    );

    expect(view(store, a).records[0].values.text).toBe("alpha");
    expect(view(store, b).records[0].values.text).toBe("beta");
    expect(view(store, a).records).toHaveLength(1);
    expect(view(store, b).records).toHaveLength(1);
    expect(view(store, a).document?.document).toEqual(document("alpha body"));
    expect(view(store, b).document?.document).toEqual(document("beta body"));
  });

  it("uses tombstones and restores metadata without replacing the document body", () => {
    const store = new TestStore();
    const s = scope();
    createDatabase(store, s);
    createRecord(store, s);
    const storedDocument = view(store, s).document;

    expect(
      failure(() =>
        run(store, s, "record.trash", { databaseId: "db1", revision: 5 }),
      ),
    ).toBe("STALE_RECORD");
    run(store, s, "record.trash", { databaseId: "db1", revision: 0 });
    expect(view(store, s).records[0]).toMatchObject({
      revision: 1,
      deleted: true,
    });

    expect(
      failure(() =>
        run(store, s, "record.patch", {
          databaseId: "db1",
          revision: 1,
          schemaRevision: 0,
          title: "Deleted",
        }),
      ),
    ).toBe("RECORD_DELETED");
    expect(
      failure(() =>
        run(store, s, "record.create", {
          databaseId: "db1",
          revision: 0,
          title: "Reuse",
          values: {},
          document: document(),
        }),
      ),
    ).toBe("ID_EXISTS");
    expect(
      failure(() => run(store, s, "record.restore", { revision: 9 })),
    ).toBe("STALE_RECORD");
    expect(
      failure(() =>
        run(store, s, "record.restore", { databaseId: "other", revision: 1 }),
      ),
    ).toBe("OWNER_MISMATCH");

    run(store, s, "record.restore", { databaseId: "db1", revision: 1 });
    const restored = view(store, s);
    expect(restored.records[0]).toMatchObject({ revision: 2, deleted: false });
    expect(restored.document).toEqual(storedDocument);
    expect(
      failure(() => run(store, s, "record.restore", { revision: 2 })),
    ).toBe("RECORD_NOT_DELETED");
  });

  it("returns detached JSON projections", () => {
    const store = new TestStore();
    const s = scope();
    createDatabase(store, s);
    createRecord(store, s);
    const first = view(store, s);
    first.records[0].title = "mutated";
    first.databases[0].properties.length = 0;
    first.pages.length = 0;
    if (first.document) first.document.document.content = [];

    const second = view(store, s);
    expect(second.records[0].title).toBe("Record");
    expect(second.databases[0].properties).toHaveLength(5);
    expect(second.pages).toHaveLength(2);
    expect(second.document?.document).toEqual(document());
  });

  it("rejects schema changes on trashed databases and duplicate creates", () => {
    const store = new TestStore();
    const s = scope();
    store.transaction(() => {
      store.set("databases", "org:ws:db1", {
        id: "db1",
        revision: 3,
        properties,
        deleted: true,
      });
    });
    expect(
      failure(() =>
        run(store, s, "db.schema", {
          databaseId: "db1",
          revision: 3,
          properties,
        }),
      ),
    ).toBe("DATABASE_DELETED");
    expect(failure(() => createDatabase(store, s))).toBe("ID_EXISTS");
  });
});
