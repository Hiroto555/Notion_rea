import { describe, expect, it } from "vitest";
import { compareConflictRecords } from "../src/renderer/conflict-record-comparison";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";

const membership = (
  pageId: string,
  databasePageId: string,
  position: number,
  values: unknown,
) => [pageId, databasePageId, position, JSON.stringify(values)];

const checkpoint = (rows: unknown[][], overrides: Record<string, {title: string; deletedAt: number | null}> = {}) => {
  const ids = [...new Set(rows.map((row) => row[0]).filter((id): id is string => typeof id === "string"))];
  const pages = ids.map((id) => [id, JSON.stringify({id, ...(overrides[id] ?? {title: id, deletedAt: null})})]);
  return JSON.stringify({ payload: { tables: { record_memberships: rows, pages } } });
};

describe("conflict record comparison", () => {
  it("compares actual persisted record checkpoints without changing the store", () => {
    const root = mkdtempSync(join(tmpdir(), "folio-record-comparison-"));
    const store = new Store(join(root, "workspace.sqlite"));
    try {
      const sync = new WorkspaceSyncStore(store, {workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch"});
      sync.enable("publish", () => {});
      const database = store.create(null, "database", "Projects");
      const records = new RecordRepository(store);
      const record = records.create(database.id, "Work", {status: "draft"});
      const before = JSON.stringify(buildWorkspaceCheckpoint(store.db));
      records.patch(record.pageId, database.id, record.revision, {values: {status: "done"}});
      const after = JSON.stringify(buildWorkspaceCheckpoint(store.db));
      const result = compareConflictRecords(before, after);
      expect(result.totalChanged).toBe(1);
      expect(result.differences[0]).toMatchObject({pageId: record.pageId,
        local: {databasePageId: database.id, values: '{"status":"draft"}'},
        remote: {databasePageId: database.id, values: '{"status":"done"}'}});
      expect(JSON.stringify(buildWorkspaceCheckpoint(store.db))).toBe(after);
      records.patch(record.pageId, database.id, store.get(record.pageId).revision, {title: "Renamed"});
      const renamed = JSON.stringify(buildWorkspaceCheckpoint(store.db));
      expect(compareConflictRecords(after, renamed).differences[0]).toMatchObject({
        local: {title: "Work", deletedAt: null}, remote: {title: "Renamed", deletedAt: null},
      });
      store.handle({type: "record:trash", pageId: record.pageId, revision: store.get(record.pageId).revision});
      const trashed = JSON.stringify(buildWorkspaceCheckpoint(store.db));
      expect(compareConflictRecords(renamed, trashed).differences[0]).toMatchObject({
        local: {title: "Renamed", deletedAt: null}, remote: {title: "Renamed", deletedAt: expect.any(Number)},
      });
    } finally {store.close(); rmSync(root, {recursive: true, force: true});}
  });
  it("detects added, deleted, changed, moved and unchanged memberships", () => {
    const left = checkpoint([
      membership("p1", "db-a", 0, { title: "same" }),
      membership("p2", "db-a", 1, { title: "moved position" }),
      membership("p3", "db-a", 2, { title: "moved database" }),
      membership("p4", "db-a", 3, { title: "deleted" }),
      membership("p5", "db-a", 4, { title: "old", score: 1 }),
      membership("p7", "db-b", 0, { title: "same elsewhere" }),
    ]);
    const right = checkpoint([
      membership("p1", "db-a", 0, { title: "same" }),
      membership("p2", "db-a", 2, { title: "moved position" }),
      membership("p3", "db-b", 0, { title: "moved database" }),
      membership("p5", "db-a", 4, { title: "new", score: 1 }),
      membership("p6", "db-b", 1, { title: "added" }),
      membership("p7", "db-b", 0, { title: "same elsewhere" }),
    ]);

    const result = compareConflictRecords(left, right);
    expect(result.totalChanged).toBe(5);
    expect(result.differences.map(({ pageId }) => pageId)).toEqual([
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    const byPage = new Map(
      result.differences.map(
        (difference) => [difference.pageId, difference] as const,
      ),
    );
    expect(byPage.get("p2")).toMatchObject({
      change: "changed",
      moved: false,
      local: { databasePageId: "db-a", position: 1 },
      remote: { databasePageId: "db-a", position: 2 },
    });
    expect(byPage.get("p3")).toMatchObject({
      change: "changed",
      moved: true,
      local: { databasePageId: "db-a", position: 2 },
      remote: { databasePageId: "db-b", position: 0 },
    });
    expect(byPage.get("p4")).toMatchObject({
      change: "deleted",
      local: { databasePageId: "db-a", position: 3 },
      remote: null,
    });
    expect(byPage.get("p5")).toMatchObject({
      change: "changed",
      moved: false,
      local: { valuesTruncated: false },
      remote: { valuesTruncated: false },
    });
    expect(byPage.get("p6")).toMatchObject({
      change: "added",
      moved: false,
      local: null,
      remote: { databasePageId: "db-b", position: 1 },
    });
    expect(result.groups).toEqual([
      { databasePageId: "db-a", totalChanged: 4 },
      { databasePageId: "db-b", totalChanged: 2 },
    ]);
  });

  it("bounds excerpts and entries while reporting the full count and groups", () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      membership(
        String(index).padStart(2, "0"),
        "db-a",
        0,
        { note: "x".repeat(501) },
      ),
    );
    const result = compareConflictRecords(checkpoint(rows), checkpoint([]));
    expect(result.totalChanged).toBe(51);
    expect(result.differences).toHaveLength(50);
    expect(result.differences[0].local).toMatchObject({
      valuesTruncated: true,
    });
    expect(result.differences[0].local?.values).toHaveLength(500);
    expect(result.groups).toEqual([
      { databasePageId: "db-a", totalChanged: 51 },
    ]);
    expect(result.groupsTruncated).toBe(false);
  });

  it("ignores JSON property insertion order while comparing the same values", () => {
    const local = checkpoint([membership("p1", "db-a", 0, {first: 1, second: 2})]);
    const remote = checkpoint([membership("p1", "db-a", 0, {second: 2, first: 1})]);
    expect(compareConflictRecords(local, remote).totalChanged).toBe(0);
  });

  it("compares trash state rather than treating different trash timestamps as different visible states", () => {
    const rows = [membership("p1", "db-a", 0, {first: 1})];
    const local = checkpoint(rows, {p1: {title: "Title", deletedAt: 1}});
    const remote = checkpoint(rows, {p1: {title: "Title", deletedAt: 2}});
    expect(compareConflictRecords(local, remote).totalChanged).toBe(0);
  });

  it("fails closed on malformed checkpoints, rows, identities and values", () => {
    const valid = membership("p1", "db-a", 0, { title: "x" });
    expect(() => compareConflictRecords("{}", checkpoint([]))).toThrow();
    expect(() =>
      compareConflictRecords(checkpoint([["p1", "db-a", 0]]), checkpoint([])),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([valid, membership("p1", "db-a", 1, { title: "y" })]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([membership("", "db-a", 0, {})]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([["p1", 7, 0, "{}"]]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([["p1", "db-a", -1, "{}"]]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([["p1", "db-a", 1.5, "{}"]]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([["p1", "db-a", 0, "not json"]]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([["p1", "db-a", 0, "[]"]]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([["p1", "db-a", 0, JSON.stringify({ nested: {} })]]),
        checkpoint([]),
      ),
    ).toThrow();
    expect(() =>
      compareConflictRecords(
        checkpoint([["p1", "db-a", 0, 42]]),
        checkpoint([]),
      ),
    ).toThrow();
  });
});
