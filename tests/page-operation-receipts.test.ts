import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import {
  commitPageOperation,
  resolvePageOperation,
} from "../src/persistence/page-operations";
import {
  preparePageCreation,
  preparePageDuplication,
  type PageOperation,
  type PageOperationResult,
} from "../src/shared/page-operation";
import { pageOperationSchema } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(resolve("output/page-operation-"));
  const store = new Store(join(root, "workspace.sqlite"));
  return {
    root,
    store,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function insertCorruptPage(store: Store, page: {
  id: string;
  parentId: string | null;
  position: number;
}) {
  const now = Date.now();
  store.db
    .prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)")
    .run(
      page.id,
      JSON.stringify({
        id: page.id,
        schemaVersion: 1,
        parentId: page.parentId,
        title: "壊れた子",
        icon: "📄",
        cover: "",
        position: page.position,
        // decode() keeps this raw row readable only as a quarantined Page;
        // write() must refuse to copy it midway through the subtree.
        doc: { type: "doc", content: "invalid" },
        kind: "page",
        database: null,
        favorite: false,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        deletedAt: null,
      }),
      "壊れた子",
    );
}

it("commits one createPage per operation and replays the same Page after reopen", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("新しいページ", null);
    const first = commitPageOperation(f.store, operation);
    expect(first).toMatchObject({
      status: "applied",
      commandKind: "createPage",
      page: { title: "新しいページ", parentId: null, revision: 0, kind: "page" },
    });
    expect(f.store.pages()).toHaveLength(1);
    expect(commitPageOperation(f.store, operation)).toEqual(first);
    expect(resolvePageOperation(f.store, operation)).toEqual(first);
    expect(f.store.pages()).toHaveLength(1);
    f.store.close();
    const reopened = new Store(join(f.root, "workspace.sqlite"));
    try {
      expect(commitPageOperation(reopened, operation)).toEqual(first);
      expect(reopened.pages()).toHaveLength(1);
      // Same operation ID with a different command is refused, not applied.
      const changed: PageOperation = {
        ...operation,
        command: { kind: "createPage", parentId: null, title: "別のページ" },
      };
      expect(commitPageOperation(reopened, changed)).toMatchObject({
        status: "rejected",
      });
      expect(reopened.pages()).toHaveLength(1);
      expect(reopened.get(first.page!.id).title).toBe("新しいページ");
    } finally {
      reopened.close();
    }
  } finally {
    f.dispose();
  }
});

it("keeps a lost-ACK create resumable: one Page after resolve and resend", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("喪失ACK", null);
    const exec = f.store.db.exec.bind(f.store.db);
    const spy = vi.spyOn(f.store.db, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql === "COMMIT") throw new Error("lost ACK after commit");
    });
    expect(() => commitPageOperation(f.store, operation)).toThrow(/lost ACK/);
    spy.mockRestore();
    expect(f.store.pages()).toHaveLength(1);
    expect(resolvePageOperation(f.store, operation).status).toBe("applied");
    expect(commitPageOperation(f.store, operation).status).toBe("applied");
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("duplicates once, refuses a stale source revision, and never copies twice", () => {
  const f = fixture();
  try {
    const source = f.store.create(null, "page", "原本");
    const stale = preparePageDuplication(source.id, source.revision + 1);
    const rejected = commitPageOperation(f.store, stale);
    expect(rejected).toMatchObject({ status: "rejected" });
    expect(f.store.pages()).toHaveLength(1);
    expect(commitPageOperation(f.store, stale)).toEqual(rejected);
    expect(f.store.pages()).toHaveLength(1);

    const operation = preparePageDuplication(source.id, source.revision);
    const applied = commitPageOperation(f.store, operation);
    expect(applied).toMatchObject({
      status: "applied",
      commandKind: "duplicatePage",
      page: { title: "原本 のコピー", parentId: null, revision: 0 },
    });
    expect(applied.page!.id).not.toBe(source.id);
    expect(f.store.pages()).toHaveLength(2);
    expect(commitPageOperation(f.store, operation)).toEqual(applied);
    expect(f.store.pages()).toHaveLength(2);
    expect(f.store.get(source.id).revision).toBe(0);
  } finally {
    f.dispose();
  }
});

it("rolls back a partial descendant copy and its receipt, then retries exactly once", () => {
  const f = fixture();
  try {
    const source = f.store.create(null, "page", "親");
    const good = f.store.create(source.id, "page", "良い子");
    insertCorruptPage(f.store, {
      id: "bad-child",
      parentId: source.id,
      position: good.position + 1,
    });
    const operation = preparePageDuplication(source.id, source.revision);
    expect(() => commitPageOperation(f.store, operation)).toThrow();
    expect(f.store.pages()).toHaveLength(3);
    expect((f.store.db.prepare("SELECT count(*) AS n FROM save_receipts").get() as {n: number}).n).toBe(0);
    expect(resolvePageOperation(f.store, operation).status).toBe("unknown");

    f.store.db.prepare("DELETE FROM pages WHERE id=?").run("bad-child");
    const applied = commitPageOperation(f.store, operation);
    expect(applied.status).toBe("applied");
    expect(f.store.pages()).toHaveLength(4);
    expect(commitPageOperation(f.store, operation)).toEqual(applied);
    expect(f.store.pages()).toHaveLength(4);
  } finally {
    f.dispose();
  }
});

it("rolls the new Page back when its receipt cannot be stored", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("Trigger", null);
    f.store.db.exec(
      "CREATE TRIGGER fail_page_receipt BEFORE INSERT ON save_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
    );
    expect(() => commitPageOperation(f.store, operation)).toThrow(/receipt failure/);
    expect(f.store.pages()).toHaveLength(0);
    expect(resolvePageOperation(f.store, operation).status).toBe("unknown");
    f.store.db.exec("DROP TRIGGER fail_page_receipt");
    expect(commitPageOperation(f.store, operation).status).toBe("applied");
    expect(f.store.pages()).toHaveLength(1);
  } finally {
    f.dispose();
  }
});

it("records a terminal rejection for an invalid parent and replays it", () => {
  const f = fixture();
  try {
    const missing = preparePageCreation("子", "missing-parent");
    const rejected = commitPageOperation(f.store, missing);
    expect(rejected.status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(0);
    expect(commitPageOperation(f.store, missing)).toEqual(rejected);

    const parent = f.store.create(null, "page", "親");
    f.store.trash(parent.id);
    const invalid = preparePageCreation("子", parent.id);
    expect(commitPageOperation(f.store, invalid).status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(1);

    const database = f.store.create(null, "database", "DB");
    const databaseSource = preparePageDuplication(database.id, 0);
    expect(commitPageOperation(f.store, databaseSource).status).toBe("rejected");
  } finally {
    f.dispose();
  }
});

it("dispatches page:commit/page:resolve through the Store request switch", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("IPC", null);
    const applied = f.store.handle({ type: "page:commit", operation }) as PageOperationResult;
    expect(applied).toMatchObject({ status: "applied", page: { title: "IPC" } });
    expect(f.store.handle({ type: "page:resolve", operation })).toEqual(applied);
    for (const invalid of [
      { ...operation, seq: 0 },
      { ...operation, command: { kind: "createPage", parentId: null, title: "x", extra: true } },
      { ...operation, extra: true },
    ])
      expect(pageOperationSchema.safeParse(invalid).success).toBe(false);
  } finally {
    f.dispose();
  }
});
