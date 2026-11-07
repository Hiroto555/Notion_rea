import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";

const stores: Store[] = [];
const versions = [3, 4, 5] as const;

function fixture(version: (typeof versions)[number]) {
  const root = mkdtempSync(join(tmpdir(), "folio-restore-order-"));
  const store = new Store(join(root, "workspace.sqlite"));
  stores.push(store);
  if (version === 4) {
    store.transaction(() => {
      new RecordRepository(store).createSchema();
      markRecordStoreVersion(store.db);
    });
  }
  if (version === 5) {
    new WorkspaceSyncStore(store, {
      workspaceId: "workspace",
      clientId: "client",
      bindingId: "binding",
      serverEpoch: "epoch",
    }).enable("publish", () => {});
  }
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(dirname(store.path), { recursive: true, force: true });
  }
});

function rows(store: Store) {
  return store.db
    .prepare("SELECT id,data,body FROM pages ORDER BY id")
    .all() as {
    id: string;
    data: string;
    body: string;
  }[];
}

function row(store: Store, id: string) {
  return rows(store).find((page) => page.id === id)!;
}

function positions(store: Store) {
  const { pages, records } = store.load();
  const recordIds = new Set(records?.map((record) => record.pageId));
  return pages
    .filter((page) => page.parentId === null && !recordIds.has(page.id))
    .map((page) => page.position);
}

function assertReopen(store: Store) {
  const reopened = new Store(store.path, { readOnly: true });
  try {
    expect(reopened.load()).toEqual(store.load());
    expect(
      reopened.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    ).toBe("ok");
  } finally {
    reopened.close();
  }
}

it.each(versions)(
  "v%i preserves original numeric tokens through metadata-only trash and restore",
  (version) => {
    const store = fixture(version);
    const page = store.create(null, "page", "Original metadata");
    const raw = row(store, page.id).data.replace(
      /"position":[^,]+/,
      '"position":9007199254740993',
    );
    const original =
      raw.slice(0, -1) + ',"future":{"n":9007199254740993,"wide":1e400}}';
    store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(original, page.id);

    store.trash(page.id);
    expect(row(store, page.id).data).toContain('"position":9007199254740993');
    expect(row(store, page.id).data).toContain(
      '"future":{"n":9007199254740993,"wide":1e400}',
    );
    store.restore(page.id);
    expect(row(store, page.id).data).toBe(
      original.replace('"revision":0', '"revision":2'),
    );
  },
);

it("keeps a same-parent restore's original position token when only deletion metadata changes", () => {
  const store = fixture(3);
  const page = store.create(null);
  store.trash(page.id);
  const raw = row(store, page.id).data.replace(
    /"position":[^,]+/,
    '"position":9007199254740993',
  );
  store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, page.id);

  store.restore(page.id);
  expect(row(store, page.id).data).toContain('"position":9007199254740993');
});

it.each(versions)(
  "v%i rolls back earlier trash writes when later deletion metadata is ambiguous",
  (version) => {
    const store = fixture(version);
    const parent = store.create(null);
    const child = store.create(parent.id);
    const raw = row(store, child.id).data.slice(0, -1) + ',"deletedAt":null}';
    store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, child.id);
    const before = rows(store);

    expect(() => store.trash(parent.id)).toThrow(/原本/);
    expect(rows(store)).toEqual(before);
    expect(store.db.isTransaction).toBe(false);
  },
);

it.each(versions)(
  "v%i restores a child to a free root position while preserving unknown JSON and reserved trash",
  (version) => {
    const store = fixture(version);
    const parent = store.create(null, "page", "Parent");
    const anchor = store.create(
      null,
      version === 3 ? "page" : "database",
      "Anchor",
    );
    store.write({ ...anchor, position: anchor.position + 0.5 });
    const record =
      version === 3
        ? undefined
        : new RecordRepository(store).create(anchor.id, "Protected record", {});
    const child = store.create(parent.id, "page", "Child");
    const grandchild = store.create(child.id, "page", "Grandchild");
    store.trash(parent.id);
    const trashedChild = store.get(child.id);
    const unknown =
      '"future":{"n":9007199254740993,"wide":1e400,"negativeZero":-0}';
    store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(
        row(store, child.id).data.slice(0, -1) + "," + unknown + "}",
        child.id,
      );
    const protectedIds = [
      parent.id,
      anchor.id,
      ...(record ? [record.pageId] : []),
    ];
    const otherBefore = protectedIds.map((id) => row(store, id));
    const bodyBefore = row(store, child.id).body;

    store.handle({ type: "restore", id: child.id });

    expect(store.get(child.id)).toMatchObject({
      parentId: null,
      deletedAt: null,
      revision: trashedChild.revision + 1,
      updatedAt: trashedChild.updatedAt,
      doc: child.doc,
    });
    expect(store.get(child.id).position).toBeGreaterThan(anchor.position);
    expect(store.get(grandchild.id)).toMatchObject({
      parentId: child.id,
      deletedAt: null,
    });
    expect(row(store, child.id).data).toContain(unknown);
    expect(row(store, child.id).body).toBe(bodyBefore);
    expect(protectedIds.map((id) => row(store, id))).toEqual(otherBefore);
    store.restore(parent.id);
    expect(new Set(positions(store)).size).toBe(positions(store).length);
    assertReopen(store);
  },
);

it.each(versions)(
  "v%i keeps a normal subtree's positions and separately trashed descendants",
  (version) => {
    const store = fixture(version);
    const parent = store.create(null, "page", "Parent");
    const child = store.create(parent.id, "page", "Child");
    const separate = store.create(parent.id, "page", "Separate trash");
    const grandchild = store.create(child.id, "page", "Grandchild");
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    store.trash(separate.id);
    clock.mockReturnValue(200);
    store.trash(parent.id);
    const separateBefore = row(store, separate.id);
    const targets = [parent, child, grandchild].map((page) =>
      store.get(page.id),
    );

    store.restore(parent.id);

    for (const page of targets)
      expect(store.get(page.id)).toEqual({
        ...page,
        deletedAt: null,
        revision: page.revision + 1,
      });
    expect(row(store, separate.id)).toEqual(separateBefore);
    assertReopen(store);
  },
);

it.each(versions)(
  "v%i makes retrying restore of a live page a no-op",
  (version) => {
    const store = fixture(version);
    const page = store.create(null, "page", "Live");
    store.create(page.id);
    const before = rows(store);
    const changes = store.db.prepare("SELECT total_changes() AS count").get();

    store.handle({ type: "restore", id: page.id });

    expect(rows(store)).toEqual(before);
    expect(store.db.prepare("SELECT total_changes() AS count").get()).toEqual(
      changes,
    );
  },
);

it.each(versions)(
  "v%i refuses a pre-existing same-parent tie without rewriting originals",
  (version) => {
    const store = fixture(version);
    const source = store.create(null, "page", "Source");
    const sibling = store.create(null, "page", "Sibling");
    store.trash(source.id);
    store.write({ ...store.get(source.id), position: sibling.position });
    const before = rows(store);

    expect(() => store.restore(source.id)).toThrow(/並び順/);
    expect(rows(store)).toEqual(before);
  },
);

it.each(versions)(
  "v%i rejects a detached restore when no safe tail position can advance",
  (version) => {
    const store = fixture(version);
    const parent = store.create(null, "page", "Parent");
    const child = store.create(parent.id, "page", "Child");
    store.trash(parent.id);
    store.write({ ...store.get(parent.id), position: Number.MAX_SAFE_INTEGER });
    const before = rows(store);

    expect(() => store.restore(child.id)).toThrow(/並び順に空き/);
    expect(rows(store)).toEqual(before);
  },
);

it.each(versions)(
  "v%i rolls back earlier restored Pages, trigger writes and sync generation after a later failure",
  (version) => {
    const store = fixture(version);
    const parent = store.create(null, "page", "Parent");
    const child = store.create(parent.id, "page", "Child");
    const grandchild = store.create(child.id, "page", "Grandchild");
    store.trash(parent.id);
    const before = rows(store);
    const generation = () =>
      version === 5
        ? store.db.prepare("SELECT generation FROM workspace_sync_state").get()
        : undefined;
    const syncBefore = generation();
    store.db
      .exec(`CREATE TRIGGER fail_restore AFTER UPDATE ON pages WHEN new.id='${grandchild.id}'
    BEGIN
      INSERT INTO settings(key,value) VALUES('restore-fault','pending');
      SELECT RAISE(FAIL,'synthetic restore failure');
    END`);

    expect(() => store.restore(child.id)).toThrow(/synthetic restore failure/);
    expect(store.db.isTransaction).toBe(false);
    expect(rows(store)).toEqual(before);
    expect(generation()).toEqual(syncBefore);
    expect(
      store.db
        .prepare("SELECT * FROM settings WHERE key='restore-fault'")
        .get(),
    ).toBeUndefined();
    store.db.exec("DROP TRIGGER fail_restore");
    store.restore(child.id);
    expect(store.get(child.id).parentId).toBeNull();
    expect(store.get(grandchild.id).deletedAt).toBeNull();
  },
);

it("rejects ambiguous metadata keys and unsupported original documents during restore", () => {
  for (const variant of ["duplicate", "document"] as const) {
    const store = fixture(3);
    const source = store.create(null);
    store.trash(source.id);
    const raw = row(store, source.id).data;
    const changed =
      variant === "duplicate"
        ? raw.slice(0, -1) + ',"deletedAt":1}'
        : JSON.stringify({ ...JSON.parse(raw), schemaVersion: 99 });
    store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(changed, source.id);
    const before = rows(store);
    expect(() => store.restore(source.id)).toThrow(/原本/);
    expect(rows(store)).toEqual(before);
  }
});

it.each([4, 5] as const)(
  "v%i retains generic restore protection for record ownership and partial record schemas",
  (version) => {
    const store = fixture(version);
    const parent = store.create(null);
    const owner = store.create(parent.id, "database", "Protected");
    const record = new RecordRepository(store).create(owner.id, "Record", {});
    for (const id of [parent.id, owner.id, record.pageId]) {
      const before = rows(store);
      expect(() => store.restore(id)).toThrow(/レコード/);
      expect(rows(store)).toEqual(before);
    }
    const ordinary = store.create(null);
    store.trash(ordinary.id);
    store.db.exec("PRAGMA foreign_keys=OFF; DROP TABLE record_databases");
    const before = rows(store);
    expect(() => store.restore(ordinary.id)).toThrow(/record store/);
    expect(rows(store)).toEqual(before);
  },
);
