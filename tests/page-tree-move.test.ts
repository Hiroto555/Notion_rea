import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { Store } from "../src/persistence/store";
import {
  createPageTree,
  type PageDropPosition,
} from "../src/renderer/page-tree";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";
import type { Doc } from "../src/shared/types";

const workspaces: Store[] = [];
const versions = [3, 4, 5] as const;

function makeStore(version: (typeof versions)[number] = 3) {
  const directory = mkdtempSync(join(tmpdir(), "folio-page-tree-move-"));
  const store = new Store(join(directory, "workspace.sqlite"));
  workspaces.push(store);
  if (version === 4) {
    store.transaction(() => {
      new RecordRepository(store).createSchema();
      markRecordStoreVersion(store.db);
    });
  } else if (version === 5) {
    new WorkspaceSyncStore(store, {
      workspaceId: "workspace",
      clientId: "client",
      bindingId: "binding",
      serverEpoch: "epoch",
    }).enable("publish", () => {});
  }
  expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
    version,
  );
  return store;
}

afterEach(() => {
  for (const store of workspaces.splice(0)) {
    store.close();
    rmSync(dirname(store.path), { recursive: true, force: true });
  }
});

function row(store: Store, id: string) {
  return store.db.prepare("SELECT data,body FROM pages WHERE id=?").get(id) as {
    data: string;
    body: string;
  };
}

function allRows(store: Store) {
  return store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all();
}

function liveOrder(store: Store, parentId: string | null = null) {
  const { pages, records } = store.load();
  const recordIds = new Set(records?.map((record) => record.pageId));
  return pages
    .filter(
      (page) =>
        page.parentId === parentId &&
        page.deletedAt === null &&
        !recordIds.has(page.id),
    )
    .map((page) => page.id);
}

const doc: Doc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "編集中の本文" }] },
  ],
};

it.each(versions)(
  "v%i reorders only the source and preserves the sibling's revision, timestamp and original bytes",
  (version) => {
    const store = makeStore(version);
    const a = store.create(null, "page", "A", doc);
    const b = store.create(null, "page", "B", doc);
    const child = store.create(b.id);
    const future = ',"future":{"id":9007199254740993}}';
    store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(row(store, a.id).data.slice(0, -1) + future, a.id);
    const before = row(store, a.id);
    const childBefore = row(store, child.id);

    expect(store.move(b.id, null, a.id)).toMatchObject({
      id: b.id,
      doc,
      revision: b.revision + 1,
    });
    expect(liveOrder(store)).toEqual([b.id, a.id]);
    expect(store.get(a.id)).toMatchObject({
      revision: a.revision,
      updatedAt: a.updatedAt,
      doc,
    });
    expect(row(store, a.id)).toEqual(before);
    expect(row(store, child.id)).toEqual(childBefore);
    expect(store.versions(b.id)).toEqual([]);
  },
);

it("accepts a v3 save receipt from the editing session opened before a sibling was moved", () => {
  const store = makeStore();
  const editing = store.create(null, "page", "A");
  const moved = store.create(null, "page", "B");
  const operation = {
    operationId: "edit-a",
    sessionId: "open-a",
    seq: 1,
    pageId: editing.id,
    databasePageId: null,
    revision: editing.revision,
    patch: { doc },
  };

  store.handle({
    type: "move",
    id: moved.id,
    parentId: null,
    beforeId: editing.id,
  });
  const result = store.handle({ type: "save:commit", operation });
  expect(result).toMatchObject({
    status: "applied",
    page: { id: editing.id, doc, revision: editing.revision + 1 },
  });
  expect(store.resolveSave(operation)).toEqual(result);
  expect(store.versions(editing.id)).toMatchObject([{ doc: editing.doc }]);
  expect(liveOrder(store)).toEqual([moved.id, editing.id]);
  expect(
    store.commitSave({
      ...operation,
      operationId: "stale-edit-b",
      pageId: moved.id,
      revision: moved.revision,
    }),
  ).toMatchObject({
    status: "rejected",
    message: expect.stringContaining("競合"),
  });
});

it("reserves a v3 trash position through reorder and restore, then allows a record-schema move", () => {
  const store = makeStore();
  const trashed = store.create(null, "page", "Trash");
  const a = store.create(null, "page", "A");
  const b = store.create(null, "page", "B");
  store.trash(trashed.id);
  const before = row(store, trashed.id);

  store.move(b.id, null, a.id);
  expect(row(store, trashed.id)).toEqual(before);
  store.restore(trashed.id);
  expect(store.get(trashed.id).position).toBe(trashed.position);
  expect(new Set(store.pages().map((page) => page.position)).size).toBe(3);
  expect(liveOrder(store)).toEqual([trashed.id, b.id, a.id]);

  store.transaction(() => {
    new RecordRepository(store).createSchema();
    markRecordStoreVersion(store.db);
  });
  store.move(a.id, null, b.id);
  expect(liveOrder(store)).toEqual([trashed.id, a.id, b.id]);
});

it("moves v3 legacy JSON without rounding unknown numeric tokens or rewriting its search body", () => {
  const store = makeStore();
  const a = store.create(null, "page", "A");
  const b = store.create(null, "page", "B", doc);
  const future =
    '"future":{"id":9007199254740993,"negativeZero":-0,"wide":1e400}';
  const original = row(store, b.id);
  // Older writable Pages can lack schemaVersion and database. Unknown fields
  // do not have to survive a JavaScript number round-trip to be moved.
  const legacy = original.data
    .replace('"schemaVersion":1,', "")
    .replace('"database":null,', "");
  store.db
    .prepare("UPDATE pages SET data=? WHERE id=?")
    .run(" " + legacy.slice(0, -1) + "," + future + "} ", b.id);

  expect(store.move(b.id, null, a.id)).toMatchObject({
    id: b.id,
    doc,
    revision: b.revision + 1,
  });
  const saved = row(store, b.id);
  expect(saved.data).toContain(future);
  expect(saved.data).not.toContain('"database":');
  expect(saved.data).not.toContain('"schemaVersion":');
  expect(saved.body).toBe(original.body);
});

it("moves into free v3 slots around legacy ties but refuses to insert between tied live siblings", () => {
  const store = makeStore();
  const a = store.create(null, "page", "A");
  const b = store.create(null, "page", "B");
  const mover = store.create(null, "page", "Mover");
  store.write({ ...b, position: a.position });
  const [first, second] = liveOrder(store);
  const ties = [row(store, a.id), row(store, b.id)];

  store.move(mover.id, null, first);
  expect(liveOrder(store)).toEqual([mover.id, first, second]);
  expect([row(store, a.id), row(store, b.id)]).toEqual(ties);
  const before = allRows(store);
  expect(() => store.move(mover.id, null, second)).toThrow(/並び順/);
  expect(allRows(store)).toEqual(before);
});

it("does not mistake a v3 source tied with its successor for a no-op", () => {
  const store = makeStore();
  const a = store.create(null, "page", "A");
  const b = store.create(null, "page", "B");
  store.write({ ...b, position: a.position });
  const [first, second] = liveOrder(store);

  expect(store.move(first, null, second).position).toBeLessThan(a.position);
  expect(store.get(second).position).toBe(a.position);
});

it("can move before a v3 live anchor whose position is shared only with trash", () => {
  const store = makeStore();
  const trashed = store.create(null, "page", "Trash");
  const target = store.create(null, "page", "Target");
  const mover = store.create(null, "page", "Mover");
  store.trash(trashed.id);
  store.write({ ...target, position: trashed.position });
  const before = allRows(store).filter((page) => page.id !== mover.id);

  expect(store.move(mover.id, null, target.id).position).toBeLessThan(
    trashed.position,
  );
  expect(liveOrder(store)).toEqual([mover.id, target.id]);
  expect(allRows(store).filter((page) => page.id !== mover.id)).toEqual(before);
});

it("fails without writing when adjacent v3 positions leave no representable slot", () => {
  const store = makeStore();
  const a = store.create(null, "page", "A");
  const b = store.create(null, "page", "B");
  const mover = store.create(null, "page", "Mover");
  store.write({ ...b, position: a.position + Number.EPSILON });
  const before = allRows(store);

  expect(() => store.move(mover.id, null, b.id)).toThrow(/並び順に空き/);
  expect(allRows(store)).toEqual(before);
});

it("does not append a v3 Page at the integer limit where a subsequent create would tie", () => {
  const store = makeStore();
  const mover = store.create(null, "page", "Mover");
  const anchor = store.create(null, "page", "Anchor");
  store.write({ ...anchor, position: Number.MAX_SAFE_INTEGER });
  const before = allRows(store);

  expect(() => store.move(mover.id, null, null)).toThrow(/並び順に空き/);
  expect(allRows(store)).toEqual(before);
});

it("refuses an ambiguous v3 placement key without changing the original", () => {
  const store = makeStore();
  const a = store.create(null, "page", "A");
  const b = store.create(null, "page", "B");
  const raw = row(store, b.id).data.slice(0, -1) + ',"pos\\u0069tion":3}';
  store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, b.id);
  const before = allRows(store);

  expect(() => store.move(b.id, null, a.id)).toThrow(/原本/);
  expect(allRows(store)).toEqual(before);
});

it.each(versions)(
  "v%i leaves equivalent live order untouched and still moves across parents",
  (version) => {
    const store = makeStore(version);
    const a = store.create(null, "page", "A");
    const hidden = store.create(null, "page", "Trash");
    const b = store.create(null, "page", "B");
    const tail = store.create(null, "page", "Trash at end");
    store.trash(hidden.id);
    store.trash(tail.id);
    const before = allRows(store);

    expect(store.move(a.id, null, b.id)).toEqual(a);
    expect(store.move(b.id, null, null)).toEqual(b);
    expect(allRows(store)).toEqual(before);
    expect(store.move(b.id, a.id, null)).toMatchObject({
      parentId: a.id,
      revision: b.revision + 1,
    });
    expect(liveOrder(store, a.id)).toEqual([b.id]);
  },
);

it.each(versions)(
  "v%i rejects self and descendant destinations without writes",
  (version) => {
    const store = makeStore(version);
    const a = store.create(null, "page", "A");
    const child = store.create(a.id);
    const before = allRows(store);

    expect(() => store.move(a.id, a.id, null)).toThrow(/子孫/);
    expect(() => store.move(a.id, child.id, null)).toThrow(/子孫/);
    expect(() => store.move(a.id, null, a.id)).toThrow(/移動先/);
    expect(allRows(store)).toEqual(before);
  },
);

it.each([4, 5] as const)(
  "v%i keeps registered anchors and rejects protected or lossy source Pages",
  (version) => {
    const store = makeStore(version);
    const owner = store.create(null, "database", "Registered");
    const a = store.create(null, "page", "A");
    const record = new RecordRepository(store).create(
      owner.id,
      "Record",
      {},
    ).pageId;
    const ownerBefore = row(store, owner.id);
    const recordBefore = row(store, record);
    const memberBefore = store.db
      .prepare("SELECT * FROM record_memberships")
      .all();

    expect(() => store.move(record, null, a.id)).toThrow(/レコード/);
    expect(() => store.move(owner.id, null, a.id)).toThrow(/データベース/);
    expect(() => store.move(a.id, owner.id, null)).toThrow(/データベース/);
    expect(() => store.move(a.id, owner.id, record)).toThrow(/レコード/);
    store.move(a.id, null, owner.id);
    expect(liveOrder(store)).toEqual([a.id, owner.id]);

    const raw =
      row(store, a.id).data.slice(0, -1) + ',"future":9007199254740993}';
    store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, a.id);
    expect(() => store.move(a.id, null, null)).toThrow(/原本/);
    expect(row(store, a.id).data).toBe(raw);
    expect(row(store, owner.id)).toEqual(ownerBefore);
    expect(row(store, record)).toEqual(recordBefore);
    expect(store.db.prepare("SELECT * FROM record_memberships").all()).toEqual(
      memberBefore,
    );
  },
);

it("applies tree drop destinations through the move request with a registered sibling anchor", () => {
  const store = makeStore(4);
  const parent = store.create(null, "page", "Parent");
  const target = store.create(parent.id, "page", "Target");
  const owner = store.create(parent.id, "database", "Registered anchor");
  const nested = store.create(target.id, "page", "Nested");
  const source = store.create(null, "page", "Source", doc);
  const original = [owner, target, nested].map(({ id }) => row(store, id));

  function drop(targetId: string, position: PageDropPosition) {
    const { pages, records, recordDatabaseIds } = store.load();
    const destination = createPageTree(
      pages,
      new Set(records?.map(({ pageId }) => pageId)),
      new Set(recordDatabaseIds),
    ).destination(source.id, targetId, position);
    if (!destination) throw new Error("Invalid test drop");
    return store.handle({ type: "move", id: source.id, ...destination });
  }

  drop(target.id, "before");
  expect(liveOrder(store, parent.id)).toEqual([source.id, target.id, owner.id]);
  drop(target.id, "after");
  expect(liveOrder(store, parent.id)).toEqual([target.id, source.id, owner.id]);
  drop(owner.id, "after");
  expect(liveOrder(store, parent.id)).toEqual([target.id, owner.id, source.id]);
  drop(target.id, "inside");
  expect(liveOrder(store, target.id)).toEqual([nested.id, source.id]);
  expect(store.get(source.id)).toMatchObject({
    doc,
    parentId: target.id,
    revision: source.revision + 4,
  });
  expect([owner, target, nested].map(({ id }) => row(store, id))).toEqual(
    original,
  );
});

it.each(versions)(
  "v%i rolls back the Page and trigger writes after a fault during move",
  (version) => {
    const store = makeStore(version);
    const a = store.create(null, "page", "A");
    const b = store.create(null, "page", "B");
    const before = allRows(store);
    // FAIL leaves earlier changes in the statement pending in the transaction.
    store.db.exec(`
    CREATE TRIGGER fail_move AFTER UPDATE ON pages WHEN new.id='${b.id}'
    BEGIN
      INSERT INTO settings(key,value) VALUES('move-fault','pending');
      SELECT RAISE(FAIL,'synthetic move fault');
    END
  `);
    const syncState = () =>
      version === 5
        ? store.db.prepare("SELECT generation FROM workspace_sync_state").get()
        : undefined;
    const generation = syncState();

    expect(() => store.move(b.id, null, a.id)).toThrow(/synthetic move fault/);
    expect(store.db.isTransaction).toBe(false);
    expect(allRows(store)).toEqual(before);
    expect(
      store.db
        .prepare("SELECT value FROM settings WHERE key='move-fault'")
        .get(),
    ).toBeUndefined();
    expect(syncState()).toEqual(generation);

    store.db.exec("DROP TRIGGER fail_move");
    expect(store.move(b.id, null, a.id).position).toBeLessThan(a.position);
  },
);
