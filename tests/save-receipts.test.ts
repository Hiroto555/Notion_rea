import { preparePageCreation } from "../src/shared/page-operation";
import { WorkspaceLimitSettings } from "../src/persistence/workspace-limit-settings";
import { onTestFinished } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { operationFingerprint, type SaveResult } from "../src/shared/save-contract";
import { sendReliableSave, resolveReliableSave } from "../src/renderer/reliable-save";
import { StorageFailureError, storageFailureMessageV1 } from "../src/renderer/private-request";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import { saveOperationSchema } from "../src/shared/types";

import { saveFixture } from "./fixtures/r4-save-fixture";

const localE = (requestType: string): Partial<StorageFailureV1> => ({
  kind: "UNCLASSIFIED", family: "REQUEST", requestType});
const typed = (requestType: string): StorageFailureV1 => ({
  version: 1, kind: "OUTCOME_UNKNOWN", family: "K", stage: "COMMIT", failureSubject: "CURRENT_ATTEMPT",
  mutationDispatch: "DISPATCHED", proofOrigin: "DISPATCH_OBSERVED", requestType,
  sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "PRIVATE_K_COMMIT_UNKNOWN"},
  sourceCauseCodes: ["PRIVATE_K_COMMIT_UNKNOWN"], causeSummaryIncomplete: false, attemptId: null,
  precondition: null, operationProgress: "PARTIAL_OR_UNKNOWN", retryAuthority: "NONE", preserve: true});

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

it("preserves a bounded typed diagnostic and degrades timer/invalid ACK/raw rejection to the local E", async () => {
  const f = saveFixture();
  try {
    const operation = f.operation();
    const failure = typed("save:commit");
    const held = await sendReliableSave(operation, async () => {throw new StorageFailureError(failure);});
    expect(held.status).toBe("unknown");
    expect(held.storageFailure).toEqual(failure);
    expect(held.message).toBe(storageFailureMessageV1(failure));
    expect(held).toMatchObject({operationId: operation.operationId, sessionId: operation.sessionId, seq: operation.seq});
    // A valid diagnostic for another request type is demoted, never trusted.
    const foreign = await sendReliableSave(operation, async () => {throw new StorageFailureError(typed("database:commit"));});
    expect(foreign.status).toBe("unknown");
    expect(foreign.storageFailure).toMatchObject(localE("save:commit"));
    // Raw rejections never leak their message, cause or path.
    const raw = await sendReliableSave(operation, async () => {throw new Error("capacity at /secret/workspace");});
    expect(raw.status).toBe("unknown");
    expect(raw.storageFailure).toMatchObject(localE("save:commit"));
    expect(raw.message).toBe(storageFailureMessageV1(raw.storageFailure!));
    expect(JSON.stringify(raw)).not.toContain("secret");
    expect(JSON.stringify(raw)).not.toContain("capacity");
    // The ACK timer is the same bounded E for the actual request type.
    const timed = await sendReliableSave(operation, async () => new Promise(() => {}), 5);
    expect(timed.status).toBe("unknown");
    expect(timed.storageFailure).toMatchObject(localE("save:commit"));
    const timedResolve = await resolveReliableSave(operation, async () => new Promise(() => {}), 5);
    expect(timedResolve.storageFailure).toMatchObject(localE("save:resolve"));
    // An invalid ACK and a malformed carried diagnostic both become the E.
    const applied = f.store.commitSave(operation);
    for (const reply of [{...applied, seq: 2}, {...applied, storageFailure: {kind: "UNCLASSIFIED"}},
      {...applied, storageFailure: typed("database:commit")}]) {
      const result = await sendReliableSave(operation, async () => reply as SaveResult);
      expect(result.status).toBe("unknown");
      expect(result.storageFailure).toMatchObject(localE("save:commit"));
    }
  } finally {f.dispose();}
});

it("normalizes an applied or rejected ACK carrying a diagnostic and keeps normal terminals", async () => {
  const f = saveFixture();
  try {
    const operation = f.operation(), applied = f.store.commitSave(operation);
    // Applied or rejected with its own failure metadata is contradictory:
    // the whole ACK is untrusted and becomes the bounded local E.
    for (const reply of [{...applied, storageFailure: typed("save:commit")},
      {...applied, status: "rejected" as const, page: undefined, storageFailure: typed("save:commit")}]) {
      const result = await sendReliableSave(operation, async () => reply as SaveResult);
      expect(result.status).toBe("unknown");
      expect(result.storageFailure).toMatchObject(localE("save:commit"));
      expect(result).toMatchObject({operationId: operation.operationId, sessionId: operation.sessionId,
        seq: operation.seq, pageId: operation.pageId, fingerprint: applied.fingerprint});
    }
    // A verified business rejection without any diagnostic keeps its
    // original wire, message and terminal meaning.
    f.store.update(f.page.id, 1, {title: "Elsewhere"});
    const stale = f.operation();
    const rejected = await sendReliableSave(stale, async (request) => f.store.handle(request));
    expect(rejected.status).toBe("rejected");
    expect(rejected.storageFailure).toBeUndefined();
  } finally {f.dispose();}
});

it("rebuilds an unknown carrier's display from the validated diagnostic, never its raw message", async () => {
  const f = saveFixture();
  try {
    const operation = f.operation(), failure = typed("save:commit");
    const result = await sendReliableSave(operation, async () => ({
      status: "unknown", operationId: operation.operationId, sessionId: operation.sessionId,
      seq: operation.seq, pageId: operation.pageId,
      fingerprint: await operationFingerprint(operation), message: "raw /secret/carrier path",
      storageFailure: failure,
    }) as SaveResult);
    expect(result.status).toBe("unknown");
    expect(result.storageFailure).toEqual(failure);
    expect(result.message).toBe(storageFailureMessageV1(failure));
    expect(JSON.stringify(result)).not.toContain("secret");
  } finally {f.dispose();}
});

it("never serializes the transient diagnostic into the operation, fingerprint or stored receipt", async () => {
  const f = saveFixture();
  try {
    const operation = f.operation();
    expect(f.store.commitSave(operation).status).toBe("applied");
    const row = f.store.db.prepare("SELECT fingerprint,result_json FROM save_receipts WHERE operation_id=?")
      .get(operation.operationId) as {fingerprint: string; result_json: string};
    expect(row.result_json).not.toContain("storageFailure");
    const resolved = f.store.resolveSave(operation);
    expect("storageFailure" in resolved).toBe(false);
    // A terminal ACK carrying its own failure metadata is contradictory: the
    // exchange normalizes it to the bounded local E for the actual request
    // and never lets a consumer clear from it. The fingerprint is still the
    // same operation identity; the field is never part of it.
    const result = await resolveReliableSave(operation, async () => ({...resolved, storageFailure: typed("save:resolve")}));
    expect(result.status).toBe("unknown");
    expect(result.fingerprint).toBe(row.fingerprint);
    expect(result.storageFailure).toMatchObject(localE("save:resolve"));
    expect(JSON.stringify(operation)).not.toContain("storageFailure");
  } finally {f.dispose();}
});

it("bounds sequential edit receipts and retains an independently unresolved full ACK", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-receipts-"));
  const store = new Store(join(dir, "workspace.sqlite"), {versionMinIntervalMs: 120_000});
  onTestFinished(() => {store.close(); rmSync(dir, {recursive: true, force: true});});
  const page = store.create(null, "page", "initial", {type: "doc", content: [
    {type: "paragraph", content: [{type: "text", text: "原稿".repeat(2000)}]},
  ]});
  const held = {operationId: randomUUID(), sessionId: randomUUID(), seq: 1, pageId: page.id,
    databasePageId: null, revision: 0, patch: {title: "held"}};
  const heldAck = store.commitSave(held);
  const sessionId = randomUUID();
  function databaseBytes() {
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return statSync(store.path).size;
  }
  let highWater = 0;
  for (let seq = 1; seq <= 450; seq++) {
    const op = {...held, sessionId, operationId: randomUUID(), revision: seq, seq, patch: {title: String(seq)}};
    const ack = store.commitSave(op);
    expect(ack.status).toBe("applied");
    if (seq === 2) expect(store.resolveSave(op)).toMatchObject({page: {title: "2", revision: 3}});
    if (seq === 225) highWater = databaseBytes();
  }
  expect(store.db.prepare("SELECT count(*) n FROM save_receipts").get()!.n).toBe(200);
  const pageSize = Number(store.db.prepare("PRAGMA page_size").get()!.page_size);
  expect(databaseBytes()).toBeLessThanOrEqual(highWater + 3 * pageSize);
  expect(store.resolveSave(held)).toEqual(heldAck);
});

it("retains a create receipt across pruning and respects an explicit workspace receipt cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "folio-receipts-"));
  const store = new Store(join(dir, "workspace.sqlite"), {maxRetainedReceipts: 2});
  onTestFinished(() => {store.close(); rmSync(dir, {recursive: true, force: true});});
  const create = preparePageCreation("only one", null);
  const created = store.commitPageOperation(create);
  const pageId = created.page!.id, sessionId = randomUUID();
  function save(seq: number) {
    expect(store.commitSave({pageId, sessionId, seq, databasePageId: null, operationId: randomUUID(),
      revision: seq - 1, patch: {title: String(seq)}}).status).toBe("applied");
  }
  for (let seq = 1; seq <= 5; seq++) save(seq);
  expect(store.commitPageOperation(create)).toEqual(created);
  expect(store.pages()).toHaveLength(1);
  const count = () => store.db.prepare("SELECT count(*) n FROM save_receipts").get()!.n;
  expect(count()).toBe(2);
  new WorkspaceLimitSettings(store.db, {}).apply(null, {maxReceiptRows: 4});
  save(6);
  save(7);
  expect(count()).toBe(4);
});
