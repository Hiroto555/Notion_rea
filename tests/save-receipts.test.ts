import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { type SaveResult } from "../src/shared/save-contract";
import { sendReliableSave, resolveReliableSave } from "../src/renderer/reliable-save";
import { saveOperationSchema } from "../src/shared/types";

import { saveFixture } from "./fixtures/r4-save-fixture";

it("commits data and receipt atomically; same ID cannot apply twice or name another request", () => {
  const f = saveFixture();
  try {
    const operation = f.operation(), first = f.store.commitSave(operation);
    expect(first.status).toBe("applied");
    expect(f.store.commitSave(operation)).toEqual(first);
    expect(f.store.resolveSave(operation)).toEqual(first);
    expect(f.store.get(f.page.id).revision).toBe(1);
    expect(f.store.versions(f.page.id)).toHaveLength(1);
    expect(f.store.commitSave({...operation, patch: {title: "Different"}})).toMatchObject({status: "rejected"});
    expect(f.store.get(f.page.id).title).toBe("After");
  } finally {f.dispose();}
});

it("saves record title/body/three property types with one revision and pre-edit history", () => {
  const f = saveFixture();
  try {
    const doc = {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "Body"}]}]};
    const operation = {...f.operation(true), patch: {title: "Edited", doc}, values: {note: "after", count: 4, done: true}};
    const result = f.store.commitSave(operation);
    expect(result).toMatchObject({status: "applied", page: {title: "Edited", revision: 1, doc}, record: {values: operation.values, revision: 1}});
    const versions = f.store.versions(f.record.pageId);
    expect(versions).toHaveLength(1);
    expect(versions[0].title).toBe("Task");
    expect(JSON.parse(f.store.db.prepare("SELECT values_json FROM record_value_versions WHERE version_id=?").get(versions[0].id)!.values_json as string))
      .toEqual({note: "before", count: 1, done: false});
  } finally {f.dispose();}
});

it("retains a values-only edit's previous values and body in history", () => {
  const f = saveFixture();
  try {
    const operation = {...f.operation(true), patch: {}, values: {done: true}};
    expect(f.store.commitSave(operation)).toMatchObject({status: "applied", page: {revision: 1}, record: {values: {done: true}}});
    const version = f.store.versions(f.record.pageId)[0];
    expect(version.title).toBe("Task");
    expect(JSON.parse(f.store.db.prepare("SELECT values_json FROM record_value_versions WHERE version_id=?").get(version.id)!.values_json as string).done).toBe(false);
  } finally {f.dispose();}
});

it("rolls back data and history if receipt insertion fails", () => {
  const f = saveFixture();
  try {
    const operation = f.operation();
    f.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON save_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    expect(() => f.store.commitSave(operation)).toThrow(/receipt failure/);
    expect(f.store.get(f.page.id)).toEqual(f.page);
    expect(f.store.versions(f.page.id)).toHaveLength(0);
    expect(f.store.resolveSave(operation).status).toBe("unknown");
  } finally {f.dispose();}
});

it("records terminal rejection after mutation rollback and rejects stale owner/revision/schema", () => {
  const f = saveFixture();
  try {
    const operation = f.operation(true);
    f.store.db.exec("CREATE TRIGGER fail_record BEFORE UPDATE ON record_memberships BEGIN SELECT RAISE(ABORT, 'synthetic values failure'); END");
    const result = f.store.commitSave({...operation, values: {done: true}});
    expect(result.status).toBe("rejected");
    expect(f.store.get(f.record.pageId).revision).toBe(0);
    expect(f.store.versions(f.record.pageId)).toHaveLength(0);
    f.store.db.exec("DROP TRIGGER fail_record");
    expect(f.store.commitSave({...operation, values: {done: true}})).toEqual(result);
    expect(f.store.commitSave({...f.operation(true), databasePageId: f.page.id}).status).toBe("rejected");
    expect(f.store.commitSave({...f.operation(true), values: {done: "not boolean"}}).status).toBe("rejected");
    expect(f.store.commitSave({...f.operation(true), values: {missing: 1}}).status).toBe("rejected");
    f.repo.patch(f.record.pageId, f.owner.id, 0, {title: "External"});
    expect(f.store.commitSave(f.operation(true)).status).toBe("rejected");
    expect(f.store.get(f.record.pageId).title).toBe("External");
  } finally {f.dispose();}
});

it("resolves a COMMIT-completed exception from durable receipt, including after Store reopen", async () => {
  const f = saveFixture();
  try {
    const operation = f.operation();
    const exec = f.store.db.exec.bind(f.store.db);
    const spy = vi.spyOn(f.store.db, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql === "COMMIT") throw new Error("ACK missing after commit");
    });
    const result = await sendReliableSave(operation, async (request) => f.store.handle(request));
    expect(result.status).toBe("unknown");
    spy.mockRestore();
    expect(await resolveReliableSave(operation, async (request) => f.store.handle(request))).toMatchObject({status: "applied", page: {revision: 1}});
    f.store.close();
    const reopened = new Store(join(f.root, "workspace.sqlite"));
    try {
      expect(reopened.resolveSave(operation).status).toBe("applied");
      expect(reopened.commitSave(operation).status).toBe("applied");
      expect(reopened.get(f.page.id).revision).toBe(1);
    } finally {reopened.close();}
  } finally {f.dispose();}
});

it("missing receipt remains unknown, and malformed/unbound operations never write", () => {
  const f = saveFixture();
  try {
    expect(f.store.resolveSave(f.operation()).status).toBe("unknown");
    const operation = f.operation();
    for (const invalid of [{...operation, values: {done: true}}, {...operation, patch: {}}, {...operation, seq: 0}, {...operation, extra: true}]) {
      expect(saveOperationSchema.safeParse(invalid).success).toBe(false);
    }
    expect(f.store.get(f.page.id)).toEqual(f.page);
  } finally {f.dispose();}
});

it("treats corrupted ACK identity/payload as unknown without discarding input", async () => {
  const f = saveFixture();
  try {
    const operation = f.operation(), applied = f.store.commitSave(operation);
    for (const reply of [{...applied, seq: 2}, {...applied, page: {...applied.page!, title: "Wrong"}}]) {
      expect((await sendReliableSave(operation, async () => reply as SaveResult)).status).toBe("unknown");
    }
  } finally {f.dispose();}
});
