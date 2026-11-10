import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";
import type {
  Cut,
  DocumentState,
  Scope,
} from "../src/collaboration/runtime/contract";
import { scopeKey } from "../src/collaboration/runtime/contract";
import { initialState } from "../src/collaboration/runtime/document";
import { derivedId } from "../src/collaboration/runtime/digest";
import {
  DocumentLifecycle,
  HISTORY_NAMESPACE,
  LIFECYCLES_NAMESPACE,
  DOCUMENTS_NAMESPACE,
  META_NAMESPACE,
  HEAD_KEY,
} from "../src/collaboration/runtime/lifecycle";

class SqliteStorage implements StoragePort {
  readonly db: DatabaseSync;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(
      "CREATE TABLE kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key))",
    );
  }

  transaction<T>(work: () => T): T {
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
    return row ? (JSON.parse(row.value) as unknown) : null;
  }

  set(namespace: string, key: string, value: unknown | null): void {
    if (value === null) {
      this.db
        .prepare("DELETE FROM kv WHERE namespace=? AND key=?")
        .run(namespace, key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO kv (namespace,key,value) VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
      )
      .run(namespace, key, JSON.stringify(value));
  }

  all(namespace: string): { key: string; value: unknown }[] {
    const rows = this.db
      .prepare("SELECT key,value FROM kv WHERE namespace=? ORDER BY key")
      .all(namespace) as { key: string; value: string }[];
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value) as unknown,
    }));
  }

  blobGet(): Uint8Array | null {
    return null;
  }

  blobPut(): void {
    throw new Error("blob storage is not part of this lifecycle test");
  }

  blobDelete(): void {
    throw new Error("blob storage is not part of this lifecycle test");
  }

  close(): void {
    this.db.close();
  }
}

const HEAD_HASH = "a".repeat(64);
const HEAD: Cut = { epoch: "epoch1", seq: 7, hash: HEAD_HASH };
const OLD: Scope = {
  orgId: "org1",
  workspaceId: "ws1",
  documentId: "doc1",
  incarnationId: "inc1",
};
const OLD_DOC_KEY = "org1:ws1:doc1";
const OLD_SCOPE_KEY = "org1:ws1:doc1:inc1";

function paragraphDoc(text = "hello"): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: text ? [{ type: "text", text }] : [],
      },
    ],
  };
}

function tableDoc(): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text: "before table" }],
      },
      {
        type: "table",
        attrs: { id: "t1" },
        content: [
          {
            type: "tableRow",
            attrs: { id: "r1" },
            content: [
              {
                type: "tableCell",
                attrs: { id: "c1" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p2" },
                    content: [{ type: "text", text: "a" }],
                  },
                ],
              },
              {
                type: "tableCell",
                attrs: { id: "c2" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p3" },
                    content: [{ type: "text", text: "b" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function ids(document: Doc): string[] {
  const result: string[] = [];
  const stack = [document];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node.attrs?.id === "string") result.push(node.attrs.id);
    stack.push(...(node.content ?? []));
  }
  return result.sort();
}

function seed(
  store: SqliteStorage,
  scope: Scope,
  state: DocumentState,
  opts: { head?: Cut; lifecycle?: boolean; deleted?: boolean } = {},
): void {
  const head = opts.head ?? HEAD;
  store.transaction(() => {
    store.set(META_NAMESPACE, HEAD_KEY, head);
    store.set(DOCUMENTS_NAMESPACE, scopeKey(scope), state);
    if (opts.lifecycle !== false)
      store.set(LIFECYCLES_NAMESPACE, OLD_DOC_KEY, {
        activeIncarnation: scope.incarnationId,
        deleted: opts.deleted ?? false,
        cut: head,
      });
  });
}

describe("DocumentLifecycle", () => {
  it("trashes the active document, captures its body, and rejects the old scope for head writes", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    const state = initialState(paragraphDoc());
    seed(store, OLD, state);

    const result = store.transaction(() => lifecycle.trash(OLD));

    expect(result.cut).toEqual(HEAD);
    expect(store.get(DOCUMENTS_NAMESPACE, OLD_SCOPE_KEY)).toEqual(state);
    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toEqual({
      activeIncarnation: "inc1",
      deleted: true,
      cut: HEAD,
    });
    const history = lifecycle.history(OLD);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ scope: OLD, cut: HEAD, state });
    expect(() => lifecycle.assertActive(OLD)).toThrow("DOCUMENT_DELETED");
    expect(() => store.transaction(() => lifecycle.capture(OLD))).toThrow(
      "DOCUMENT_DELETED",
    );
    store.close();
  });

  it("does not overwrite immutable history at the same cut", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    const state = initialState(paragraphDoc("original"));
    seed(store, OLD, state);

    store.transaction(() => lifecycle.capture(OLD));
    store.transaction(() => lifecycle.capture(OLD));
    expect(lifecycle.history(OLD)).toHaveLength(1);

    const key = `${OLD_SCOPE_KEY}:${HEAD.seq}`;
    const replaced = {
      scope: OLD,
      cut: HEAD,
      state: initialState(paragraphDoc("different")),
    };
    store.set(HISTORY_NAMESPACE, key, replaced);
    const before = store.get(HISTORY_NAMESPACE, key);

    expect(() => store.transaction(() => lifecycle.capture(OLD))).toThrow(
      "HISTORY_IMMUTABLE",
    );
    expect(store.get(HISTORY_NAMESPACE, key)).toEqual(before);
    store.close();
  });

  it("restores a deleted document once into a fresh incarnation with reseeded tables", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    const source = initialState(tableDoc());
    seed(store, OLD, source);
    store.set("receipts", "receipt1", { status: "SERVER_ACCEPTED" });
    store.set("outbox", "queued1", { oldIncarnation: "inc1" });

    store.transaction(() => lifecycle.trash(OLD));
    const receiptBefore = store.get("receipts", "receipt1");
    const outboxBefore = store.get("outbox", "queued1");

    expect(() =>
      store.transaction(() => lifecycle.restore(OLD, "inc1")),
    ).toThrow("INCARNATION_REUSE");

    const next = store.transaction(() => lifecycle.restore(OLD, "inc2"));
    expect(next).toEqual({ ...OLD, incarnationId: "inc2" });

    const restored = store.get(
      DOCUMENTS_NAMESPACE,
      scopeKey(next),
    ) as DocumentState;
    expect(ids(restored.document)).toEqual(ids(source.document));
    expect(restored.tables).toEqual([
      {
        tableId: "t1",
        rowIds: ["r1"],
        columnIds: [
          derivedId("inc2", "t1", "column", "0"),
          derivedId("inc2", "t1", "column", "1"),
        ],
      },
    ]);
    expect(restored.tables[0].columnIds).not.toEqual([
      derivedId("inc1", "t1", "column", "0"),
      derivedId("inc1", "t1", "column", "1"),
    ]);
    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toEqual({
      activeIncarnation: "inc2",
      deleted: false,
      cut: HEAD,
    });
    expect(store.get(DOCUMENTS_NAMESPACE, OLD_SCOPE_KEY)).toEqual(source);
    expect(lifecycle.history(OLD)).toHaveLength(1);
    expect(store.get("receipts", "receipt1")).toEqual(receiptBefore);
    expect(store.get("outbox", "queued1")).toEqual(outboxBefore);

    expect(() => lifecycle.assertActive(OLD)).toThrow("SCOPE_NOT_ACTIVE");
    expect(() => lifecycle.assertActive(next)).not.toThrow();
    expect(() => store.transaction(() => lifecycle.capture(OLD))).toThrow(
      "SCOPE_NOT_ACTIVE",
    );
    expect(() => store.transaction(() => lifecycle.trash(OLD))).toThrow(
      "SCOPE_NOT_ACTIVE",
    );

    store.transaction(() => lifecycle.capture(next));
    expect(lifecycle.history(OLD)).toHaveLength(1);
    expect(lifecycle.history(next)).toHaveLength(1);

    const drifted: DocumentState = { ...restored, tables: [] };
    store.set(DOCUMENTS_NAMESPACE, scopeKey(next), drifted);
    expect(store.transaction(() => lifecycle.restore(OLD, "inc2"))).toEqual(
      next,
    );
    expect(store.get(DOCUMENTS_NAMESPACE, scopeKey(next))).toEqual(drifted);
    expect(() =>
      store.transaction(() => lifecycle.restore(OLD, "inc3")),
    ).toThrow("RESTORE_CONFLICT");
    expect(store.get(DOCUMENTS_NAMESPACE, "org1:ws1:doc1:inc3")).toBeNull();
    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toEqual({
      activeIncarnation: "inc2",
      deleted: false,
      cut: HEAD,
    });
    store.close();
  });

  it("requires deletion before restore and does not restore the same incarnation", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    seed(store, OLD, initialState(paragraphDoc()));

    expect(() =>
      store.transaction(() => lifecycle.restore(OLD, "inc2")),
    ).toThrow("NOT_DELETED");

    store.transaction(() => lifecycle.trash(OLD));
    expect(() =>
      store.transaction(() => lifecycle.restore(OLD, "inc1")),
    ).toThrow("INCARNATION_REUSE");
    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toMatchObject({
      activeIncarnation: "inc1",
      deleted: true,
    });
    store.close();
  });

  it("rolls back trash when the caller-owned transaction fails", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    const state = initialState(paragraphDoc());
    seed(store, OLD, state);

    expect(() =>
      store.transaction(() => {
        lifecycle.trash(OLD);
        throw new Error("stop after mutation");
      }),
    ).toThrow("stop after mutation");

    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toEqual({
      activeIncarnation: "inc1",
      deleted: false,
      cut: HEAD,
    });
    expect(
      store.get(HISTORY_NAMESPACE, `${OLD_SCOPE_KEY}:${HEAD.seq}`),
    ).toBeNull();
    expect(store.get(DOCUMENTS_NAMESPACE, OLD_SCOPE_KEY)).toEqual(state);
    store.close();
  });

  it("refuses corrupt document state and leaves the stored original untouched", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    const corrupt = {
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "x" }] },
        ],
      },
      tables: [],
      tombstones: [],
    };
    seed(store, OLD, initialState(paragraphDoc()));
    store.set(DOCUMENTS_NAMESPACE, OLD_SCOPE_KEY, corrupt);
    const before = store.get(DOCUMENTS_NAMESPACE, OLD_SCOPE_KEY);

    expect(() => store.transaction(() => lifecycle.trash(OLD))).toThrow(
      "CORRUPT_DOCUMENT",
    );
    expect(store.get(DOCUMENTS_NAMESPACE, OLD_SCOPE_KEY)).toEqual(before);
    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toMatchObject({
      deleted: false,
    });
    expect(
      store.get(HISTORY_NAMESPACE, `${OLD_SCOPE_KEY}:${HEAD.seq}`),
    ).toBeNull();
    store.close();
  });

  it("refuses a corrupt restore checkpoint without replacing it or restoring", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    seed(store, OLD, initialState(paragraphDoc()));
    store.transaction(() => lifecycle.trash(OLD));

    const key = `${OLD_SCOPE_KEY}:${HEAD.seq}`;
    const corrupt = {
      scope: OLD,
      cut: HEAD,
      state: {
        document: { type: "doc", content: [] },
        tables: [],
        tombstones: [],
      },
    };
    store.set(HISTORY_NAMESPACE, key, corrupt);
    const before = store.get(HISTORY_NAMESPACE, key);

    expect(() =>
      store.transaction(() => lifecycle.restore(OLD, "inc2")),
    ).toThrow("CORRUPT_HISTORY");
    expect(store.get(HISTORY_NAMESPACE, key)).toEqual(before);
    expect(store.get(DOCUMENTS_NAMESPACE, "org1:ws1:doc1:inc2")).toBeNull();
    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toMatchObject({
      activeIncarnation: "inc1",
      deleted: true,
    });
    store.close();
  });

  it("requires a caller-owned transaction for mutation", () => {
    const store = new SqliteStorage();
    const lifecycle = new DocumentLifecycle(store);
    seed(store, OLD, initialState(paragraphDoc()));

    expect(() => lifecycle.capture(OLD)).toThrow("TRANSACTION_REQUIRED");
    expect(() => lifecycle.trash(OLD)).toThrow("TRANSACTION_REQUIRED");
    expect(() => lifecycle.restore(OLD, "inc2")).toThrow(
      "TRANSACTION_REQUIRED",
    );
    expect(store.get(LIFECYCLES_NAMESPACE, OLD_DOC_KEY)).toMatchObject({
      deleted: false,
    });
    store.close();
  });
});
