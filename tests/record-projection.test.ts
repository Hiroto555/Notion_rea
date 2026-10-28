import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import type { DatabaseProjection } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(resolve("output/record-projection-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const database = store.create(null, "database", "Database");
  const first = store.create(null, "page", "First");
  const second = store.create(null, "page", "Second");
  const repo = new RecordRepository(store);
  store.transaction(() => {
    repo.createSchema();
    repo.registerDatabase(database.id);
    repo.attachForMigration(first.id, database.id, 0, { status: "active" });
    repo.attachForMigration(second.id, database.id, 1, { status: "trashed" });
  });
  const lifecycle = new RecordLifecycle(store);
  return {
    root,
    store,
    database,
    first,
    second,
    repo,
    lifecycle,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("includes independent trash in the projection while normal views filter it, then preserves identity and values on restore", () => {
  const f = fixture();
  try {
    f.store.handle({ type: "record:trash", pageId: f.second.id, revision: 0 });
    const loaded = f.store.handle({
      type: "database:load",
      databasePageId: f.database.id,
    }) as DatabaseProjection;
    expect(loaded.records.map((record) => record.pageId)).toEqual([
      f.first.id,
      f.second.id,
    ]);
    const active = loaded.records.filter((record) => record.deletedAt === null);
    const trash = loaded.records.filter((record) => record.deletedAt !== null);
    expect(active.map((record) => record.pageId)).toEqual([f.first.id]);
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({
      pageId: f.second.id,
      databasePageId: f.database.id,
      revision: 1,
      values: { status: "trashed" },
    });
    expect(trash[0].deletedAt).not.toBeNull();
    const restored = f.store.handle({
      type: "record:restore",
      pageId: f.second.id,
      revision: trash[0].revision,
    });
    expect(restored).toMatchObject({
      pageId: f.second.id,
      revision: 2,
      deletedAt: null,
      values: { status: "trashed" },
    });
    const after = f.repo.databaseProjection(f.database.id);
    expect(
      after.records
        .filter((record) => record.deletedAt === null)
        .map((record) => record.pageId),
    ).toEqual([f.first.id, f.second.id]);
    expect(
      after.records.filter((record) => record.deletedAt !== null),
    ).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

it("fails closed for a trashed owner, preserving independent trash after the owner is restored", () => {
  const f = fixture();
  try {
    f.lifecycle.trashRecord(f.second.id, 0);
    f.lifecycle.trashDatabase(f.database.id, 0);
    expect(() => f.repo.databaseProjection(f.database.id)).toThrow(
      "データベースを開けません",
    );
    expect(() =>
      f.store.handle({ type: "database:load", databasePageId: f.database.id }),
    ).toThrow("データベースを開けません");
    expect(() => f.lifecycle.restoreRecord(f.second.id, 1)).toThrow(
      "owning database",
    );
    f.lifecycle.restoreDatabase(f.database.id, 1);
    const records = f.repo.databaseProjection(f.database.id).records;
    expect(
      records.find((record) => record.pageId === f.first.id)?.deletedAt,
    ).toBeNull();
    expect(
      records.find((record) => record.pageId === f.second.id)?.deletedAt,
    ).not.toBeNull();
    expect(
      records.find((record) => record.pageId === f.second.id)?.revision,
    ).toBe(1);
    const restored = f.lifecycle.restoreRecord(f.second.id, 1);
    expect(restored.deletedAt).toBeNull();
    expect(restored.values).toEqual({ status: "trashed" });
  } finally {
    f.dispose();
  }
});
