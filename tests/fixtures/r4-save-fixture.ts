import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../src/persistence/store";
import { RecordRepository } from "../../src/persistence/record-repository";
import type { SaveOperation } from "../../src/shared/save-contract";

export function saveFixture() {
  const root = mkdtempSync(resolve("output/save-receipts-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const page = store.create(null, "page", "Ordinary");
  let owner = store.create(null, "database", "Tasks");
  owner = store.update(owner.id, owner.revision, {database: {...owner.database!, properties: [
    {id: "note", name: "Note", type: "text"}, {id: "count", name: "Count", type: "number"},
    {id: "done", name: "Done", type: "checkbox"},
  ]}});
  const repo = new RecordRepository(store);
  store.transaction(() => {repo.createSchema(); repo.registerDatabase(owner.id);});
  const record = repo.create(owner.id, "Task", {note: "before", count: 1, done: false});
  const operation = (recordSave = false): SaveOperation => ({operationId: randomUUID(), sessionId: randomUUID(), seq: 1,
    pageId: recordSave ? record.pageId : page.id, databasePageId: recordSave ? owner.id : null,
    revision: 0, patch: {title: "After"}});
  return {root, store, page, owner, repo, record, operation,
    dispose() {store.close(); rmSync(root, {recursive: true, force: true});}};
}
