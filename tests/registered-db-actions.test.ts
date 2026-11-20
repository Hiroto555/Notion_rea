import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { Store } from "../src/persistence/store";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { emptyDatabase, type Page } from "../src/shared/types";
import { createPageTree } from "../src/renderer/page-tree";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import { readDatabaseSnapshot } from "../src/persistence/database-operations";
import { RecordRepository } from "../src/persistence/record-repository";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "folio-db-actions-"));
  const store = new Store(join(directory, "workspace.sqlite"));
  onTestFinished(() => {store.close(); rmSync(directory, {recursive: true, force: true});});
  const {rows: _, ...settings} = emptyDatabase();
  const owner = store.handle({type: "database:commit", operation: prepareDatabaseCreation("Tasks", null, settings)}) as {page: Page};
  const repo = new RecordRepository(store);
  const row = repo.create(owner.page.id, "Item", {});
  return {store, owner: owner.page, row, repo};
}

it("moves a registered database and its containing folder only with a matching revision", () => {
  const {store, owner, row} = fixture();
  const folder = store.create(null, "page", "Folder");
  const other = store.create(null, "page", "Other");
  const tree = createPageTree(store.pages(), new Set([row.pageId]), new Set([owner.id]), true);
  expect(tree.destination(owner.id, folder.id, "inside")).toEqual({parentId: folder.id, beforeId: null});
  expect(tree.destination(folder.id, owner.id, "inside")).toBeNull();
  expect(() => store.move(owner.id, folder.id, null, 7)).toThrow(/版/);
  expect(store.move(owner.id, folder.id, null, owner.revision)).toMatchObject({parentId: folder.id, revision: 1});
  expect(store.move(folder.id, other.id, null, folder.revision).parentId).toBe(other.id);
  expect(() => store.move(row.pageId, null, null, 0)).toThrow(/レコード/);
});

it("settles record edits before detaching and reloads the current database after trash, restore and history", async () => {
  const {store, owner, row, repo} = fixture();
  const sessions = new EditSessionCoordinator(async req => store.handle(req));
  const databases = new DatabaseSessionCoordinator(async req => store.handle(req));
  const snapshot = readDatabaseSnapshot(store, owner.id);
  const db = databases.attach(snapshot.page, snapshot.database);
  databases.editPage(db, {favorite: true, title: "Edited"});
  expect(() => databases.detachClean(owner.id)).toThrow(/未保存/);
  await databases.flushAll();
  const handle = sessions.attach(store.get(row.pageId), row);
  sessions.edit(handle, {title: "edited row"});
  expect(() => sessions.detachCleanOwner(owner.id)).toThrow(/未保存/);
  await sessions.flushAll();
  const version = store.versions(owner.id)[0];
  const saved = store.handle({type: "restoreVersion", id: owner.id, versionId: version.id, revision: 1}) as Page;
  expect(saved).toMatchObject({title: "Tasks", favorite: true, revision: 2});
  store.handle({type: "trash", id: owner.id, revision: 2});
  sessions.detachCleanOwner(owner.id);
  databases.detachClean(owner.id);
  expect(sessions.get(row.pageId)).toBeUndefined();
  store.handle({type: "restore", id: owner.id, revision: 3});
  const current = readDatabaseSnapshot(store, owner.id);
  databases.attach(current.page, current.database);
  expect(databases.get(owner.id)?.page.revision).toBe(4);
  expect(repo.projection(row.pageId).title).toBe("edited row");
  const copy = () => store.handle({type: "duplicate", id: owner.id, revision: 4}) as Page;
  expect(copy().position).not.toBe(copy().position);
});

it("binds row copy, trash and history to the displayed owner and revision", () => {
  const {store, owner, row, repo} = fixture();
  const copy = store.handle({type: "record:duplicate", pageId: row.pageId, databasePageId: owner.id, revision: 0}) as typeof row;
  expect(copy.pageId).not.toBe(row.pageId);
  expect(() => store.handle({type: "record:trash", pageId: row.pageId, databasePageId: "other", revision: 0})).toThrow();
  repo.patch(row.pageId, owner.id, 0, {title: "after"});
  const versionId = store.versions(row.pageId)[0].id;
  expect(() => store.handle({type: "restoreVersion", id: row.pageId, databasePageId: "other", versionId, revision: 1})).toThrow();
  expect(store.handle({type: "restoreVersion", id: row.pageId, databasePageId: owner.id, versionId, revision: 1}))
    .toMatchObject({title: "Item", revision: 2});
  store.handle({type: "record:trash", pageId: copy.pageId, databasePageId: owner.id, revision: 0});
  expect(repo.projection(copy.pageId).deletedAt).not.toBeNull();
});
