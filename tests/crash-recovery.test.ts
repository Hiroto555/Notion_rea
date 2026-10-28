import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { CrashRecoveryFile, crashRecoveryWorkspaceId } from "../src/persistence/crash-recovery-file";
import { createRecoveryCopy } from "../src/persistence/crash-recovery-copy";
import { emptyCrashRecoverySnapshot, hasCrashRecoveryInput, validateCrashRecoverySnapshot, type CrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import { resolveReliableSave } from "../src/renderer/reliable-save";
import { resolveDatabaseOperation } from "../src/renderer/reliable-database-operation";
import { readDatabaseSnapshot, commitDatabaseOperation } from "../src/persistence/database-operations";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { saveFixture } from "./fixtures/r4-save-fixture";

function journalFixture() {
  const directory = mkdtempSync(resolve("output/r6-recovery-")), store = new Store(join(directory, "workspace.sqlite"));
  const workspaceId = crashRecoveryWorkspaceId(store), path = join(directory, "recovery.json");
  const file = new CrashRecoveryFile(path, workspaceId);
  return {directory, store, workspaceId, path, file, dispose() {store.close(); rmSync(directory, {recursive: true, force: true});}};
}
function rawSnapshot(value = "-"): CrashRecoverySnapshot {
  return {...emptyCrashRecoverySnapshot(), rawDrafts: [{scope: "record", pageId: "record", key: "count", value}]};
}
function barrier() {let release!: () => void; const promise = new Promise<void>((resolve) => {release = resolve;}); return {release, promise};}

it("persists canonical bounded checkpoints with workspace identity and idempotent generation ACK recovery", () => {
  const f = journalFixture();
  try {
    expect(f.file.read()).toEqual({status: "empty", generation: 0});
    expect(crashRecoveryWorkspaceId(f.store)).toBe(f.workspaceId);
    f.file.write(0, rawSnapshot());
    const reopened = new CrashRecoveryFile(f.path, f.workspaceId);
    expect(reopened.read()).toMatchObject({status: "ready", generation: 1, snapshot: rawSnapshot()});
    expect(reopened.write(0, rawSnapshot()).generation).toBe(1);
    expect(() => reopened.write(0, rawSnapshot("2"))).toThrow(/generation/);
    expect(reopened.write(1, emptyCrashRecoverySnapshot()).generation).toBe(2);
    expect(reopened.read().snapshot).toEqual(emptyCrashRecoverySnapshot());
  } finally {f.dispose();}
});

it("preserves corrupt and foreign journal bytes and blocks their overwrite", () => {
  const f = journalFixture();
  try {
    f.file.write(0, rawSnapshot());
    const good = readFileSync(f.path, "utf8"), foreign = new CrashRecoveryFile(f.path, "different-workspace");
    expect(foreign.read().status).toBe("blocked");
    expect(() => foreign.write(0, emptyCrashRecoverySnapshot())).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(good);
    const corrupt = good.replace('"value":"-"', '"value":"9"');
    writeFileSync(f.path, corrupt);
    expect(f.file.read().status).toBe("blocked");
    expect(() => f.file.write(1, rawSnapshot())).toThrow(/checksum/);
    expect(readFileSync(f.path, "utf8")).toBe(corrupt);
  } finally {f.dispose();}
});

it("retains the prior checkpoint when staging fsync fails and resolves an ACK lost after rename", () => {
  const f = journalFixture();
  try {
    f.file.write(0, rawSnapshot());
    const failed = new CrashRecoveryFile(f.path, f.workspaceId, {operations: {fsyncSync() {throw new Error("disk sync failed");}}});
    expect(() => failed.write(1, rawSnapshot("2"))).toThrow(/disk sync/);
    expect(f.file.read()).toMatchObject({generation: 1, snapshot: rawSnapshot()});
    let syncs = 0;
    const native = new CrashRecoveryFile(f.path, f.workspaceId);
    const fs = requireFs();
    const ackLost = new CrashRecoveryFile(f.path, f.workspaceId, {operations: {fsyncSync(fd) {if (++syncs === 3) throw new Error("directory sync ACK lost"); fs.fsyncSync(fd);}}});
    expect(() => ackLost.write(1, rawSnapshot("3"))).toThrow(/ACK lost/);
    expect(native.write(1, rawSnapshot("3"))).toMatchObject({generation: 2, snapshot: rawSnapshot("3")});
  } finally {f.dispose();}
});

// A namespace import keeps the fault-injection wrapper away from its own seam.
import * as nativeFs from "node:fs";
function requireFs() {return nativeFs;}

it("validates session, sequence, operation content and raw JSON without discarding malformed input", () => {
  const f = saveFixture();
  try {
    const session = new EditSessionCoordinator(async (request) => f.store.handle(request));
    const handle = session.attach(f.store.get(f.record.pageId), f.record); session.edit(handle, {title: "Draft"});
    const snapshot = {...emptyCrashRecoverySnapshot(), records: session.exportRecovery()};
    expect(validateCrashRecoverySnapshot(snapshot)).toEqual(snapshot);
    snapshot.records[0].operation = {...f.operation(true), sessionId: handle.sessionId, patch: {title: "Different"}};
    expect(() => validateCrashRecoverySnapshot(snapshot)).toThrow(/captured input/);
    const wrong = rawSnapshot(); (wrong.rawDrafts[0] as any).value = undefined;
    expect(() => validateCrashRecoverySnapshot(wrong)).toThrow(/JSON/);
    expect(() => validateCrashRecoverySnapshot({...rawSnapshot(), schemaVersion: 2})).toThrow();
  } finally {f.dispose();}
});

it("waits for the operation-bearing durable checkpoint before sending, and retains later input across recreation", async () => {
  const f = saveFixture(), held = barrier(), entered = barrier();
  try {
    let commits = 0, captured = emptyCrashRecoverySnapshot();
    const session = new EditSessionCoordinator(async (request) => {if (request.type === "save:commit") commits++; return f.store.handle(request);},
      {beforeSend: async () => {captured = {...emptyCrashRecoverySnapshot(), records: session.exportRecovery()}; entered.release(); await held.promise;}});
    const handle = session.attach(f.store.get(f.record.pageId), f.record);
    session.edit(handle, {title: "First"}); const flushing = session.flush(handle.pageId); await entered.promise;
    expect(commits).toBe(0); expect(captured.records[0].operation?.operationId).toBeTruthy();
    session.edit(handle, {}, {count: 17});
    captured = {...emptyCrashRecoverySnapshot(), records: session.exportRecovery()};
    const recovered = new EditSessionCoordinator(async (request) => f.store.handle(request));
    recovered.restoreRecovery(captured.records[0], f.repo.readSnapshot(handle.pageId));
    await recovered.flush(handle.pageId);
    expect(recovered.get(handle.pageId)?.state).toBe("unknown"); expect(commits).toBe(0);
    held.release(); await flushing;
  } finally {held.release(); f.dispose();}
});

it("resolves a committed record after restart, removes only acknowledged input and saves the later draft", async () => {
  const f = saveFixture();
  try {
    const session = new EditSessionCoordinator(async (request) => {const result = f.store.handle(request); if (request.type === "save:commit") throw new Error("killed after COMMIT"); return result;});
    const handle = session.attach(f.store.get(f.record.pageId), f.record);
    session.edit(handle, {title: "Committed title"}); await session.flush(handle.pageId);
    session.edit(handle, {doc: {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "Later body"}]}]}}, {count: 42});
    const journal = new CrashRecoveryFile(join(f.root, "recovery.json"), crashRecoveryWorkspaceId(f.store));
    journal.write(0, {...emptyCrashRecoverySnapshot(), records: session.exportRecovery()});
    const entry = journal.read().snapshot!.records[0], op = entry.operation!;
    const resolved = await resolveReliableSave(op, async (request) => f.store.handle(request));
    const requests: string[] = [], restarted = new EditSessionCoordinator(async (request) => {requests.push(request.type); return f.store.handle(request);});
    restarted.restoreRecovery(entry, f.repo.readSnapshot(handle.pageId), resolved);
    expect(restarted.get(handle.pageId)).toMatchObject({state: "pending", page: {title: "Committed title", revision: 1}, record: {values: {count: 42}}});
    expect(restarted.exportRecovery()[0].intents).toHaveLength(1);
    await restarted.flush(handle.pageId);
    expect(requests).toEqual(["save:commit"]);
    expect(f.store.get(handle.pageId).revision).toBe(2);
    expect(f.repo.projection(handle.pageId).values.count).toBe(42);
  } finally {f.dispose();}
});

it("never promotes an old receipt onto a newer source, and preserves conflict input in one idempotent copy", async () => {
  const f = saveFixture();
  try {
    const session = new EditSessionCoordinator(async (request) => {const result = f.store.handle(request); if (request.type === "save:commit") throw new Error("lost"); return result;});
    const handle = session.attach(f.page); session.edit(handle, {title: "Local"}); await session.flush(f.page.id);
    const entry = session.exportRecovery()[0];
    f.store.update(f.page.id, 1, {title: "Newer external"});
    const result = await resolveReliableSave(entry.operation!, async (request) => f.store.handle(request));
    const restarted = new EditSessionCoordinator(async (request) => f.store.handle(request));
    expect(() => restarted.restoreRecovery(entry, {page: f.store.get(f.page.id)}, result)).toThrow(/変更/);
    const input = {title: "Recovered Local", doc: entry.base.doc, sourcePageId: entry.base.id, payload: entry};
    const copy = createRecoveryCopy(f.store, "stable-recovery-id", input);
    expect(createRecoveryCopy(f.store, "stable-recovery-id", input).id).toBe(copy.id);
    expect(() => createRecoveryCopy(f.store, "stable-recovery-id", {...input, title: "Different"})).toThrow(/different/);
    expect(f.store.get(f.page.id).title).toBe("Newer external");
    expect(JSON.stringify(copy.doc)).toContain("Local");
    expect(copy.kind).toBe("page"); expect(copy.parentId).toBeNull();
  } finally {f.dispose();}
});

it("keeps missing receipts query-only across restart, including database creation and raw number drafts", async () => {
  const f = saveFixture();
  try {
    const session = new EditSessionCoordinator(async () => {throw new Error("not delivered");});
    const handle = session.attach(f.page); session.edit(handle, {title: "Unsent"}); await session.flush(f.page.id);
    const entry = session.exportRecovery()[0], creation = prepareDatabaseCreation("Never resend this creation");
    const snapshot = {...rawSnapshot("1e"), pages: [entry], creations: [creation]};
    expect(validateCrashRecoverySnapshot(snapshot)).toEqual(snapshot);
    const result = await resolveReliableSave(entry.operation!, async (request) => f.store.handle(request));
    expect(result.status).toBe("unknown");
    const requests: string[] = [], restarted = new EditSessionCoordinator(async (request) => {requests.push(request.type); return f.store.handle(request);});
    restarted.restoreRecovery(entry, {page: f.store.get(f.page.id)}, result);
    await restarted.flush(f.page.id); await restarted.resolve(f.page.id);
    expect(requests).toEqual(["save:resolve"]);
    expect(restarted.exportRecovery()[0].operation).toEqual(entry.operation);
    expect(f.store.get(f.page.id).title).toBe("Ordinary");
  } finally {f.dispose();}
});

it("resumes DB settings after a committed owner ACK and preserves following record creation without duplicates", async () => {
  const f = journalFixture();
  try {
    const created = commitDatabaseOperation(f.store, prepareDatabaseCreation("Tasks"));
    const session = new DatabaseSessionCoordinator(async (request) => {const result = f.store.handle(request); if (request.type === "database:commit") throw new Error("killed"); return result;});
    const handle = session.attach(created.page!, created.database!), view = created.database!.settings.views[0];
    session.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {name: view.name}, patch: {name: "Recovered view"}});
    await session.flush(handle.pageId); session.createRecord(handle, "Queued row");
    f.file.write(0, {...emptyCrashRecoverySnapshot(), databases: session.exportRecovery()});
    const entry = f.file.read().snapshot!.databases[0];
    const result = await resolveDatabaseOperation(entry.operation!, async (request) => f.store.handle(request));
    const restarted = new DatabaseSessionCoordinator(async (request) => f.store.handle(request));
    restarted.restoreRecovery(entry, readDatabaseSnapshot(f.store, handle.pageId), result);
    expect(restarted.exportRecovery()[0].intents).toHaveLength(1);
    await restarted.flush(handle.pageId);
    expect(readDatabaseSnapshot(f.store, handle.pageId).database.records).toHaveLength(1);
    expect(f.store.get(handle.pageId).database!.views[0].name).toBe("Recovered view");
  } finally {f.dispose();}
});

it("rolls back a recovery copy when its durable deduplication receipt cannot be written", () => {
  const f = journalFixture();
  try {
    createRecoveryCopy(f.store, "setup", {title: "First", payload: {text: "first"}});
    const before = f.store.load().pages.length;
    f.store.db.exec("CREATE TRIGGER fail_copy BEFORE INSERT ON crash_recovery_copies BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
    expect(() => createRecoveryCopy(f.store, "failed", {title: "Do not duplicate", payload: {text: "keep"}})).toThrow(/receipt failed/);
    expect(f.store.load().pages).toHaveLength(before);
  } finally {f.dispose();}
});

it("retains unverified callback provenance as copy-only input without inventing a current editor base", () => {
  const f = journalFixture();
  try {
    const input = {id: "page-from-old-session", seq: 9, observedKnown: false, observedRevision: 0,
      patch: {title: "Old-screen input"}, recoveryKind: "record", expectedOwnerId: "prior-owner"};
    const snapshot = {...emptyCrashRecoverySnapshot(), unverifiedInputs: [{reason: "stale editor session", input}]};
    expect(hasCrashRecoveryInput(snapshot)).toBe(true);
    f.file.write(0, snapshot);
    const restored = f.file.read().snapshot!;
    expect(restored.pages).toEqual([]); expect(restored.records).toEqual([]);
    expect(restored.unverifiedInputs).toEqual(snapshot.unverifiedInputs);
    const copy = createRecoveryCopy(f.store, "unverified-copy", {title: "Recovered input", payload: restored});
    expect(JSON.stringify(copy.doc)).toContain("observedKnown");
    expect(JSON.stringify(copy.doc)).toContain("Old-screen input");
    expect(f.store.load().pages.some((page) => page.id === input.id)).toBe(false);
  } finally {f.dispose();}
});

it("rejects unbounded or lossy unverified input while accepting older snapshots without that optional field", () => {
  expect(validateCrashRecoverySnapshot(emptyCrashRecoverySnapshot())).toEqual(emptyCrashRecoverySnapshot());
  expect(() => validateCrashRecoverySnapshot({...emptyCrashRecoverySnapshot(), unverifiedInputs: [{reason: "missing"}]})).toThrow();
  expect(() => validateCrashRecoverySnapshot({...emptyCrashRecoverySnapshot(),
    unverifiedInputs: Array.from({length: 1001}, () => ({reason: "unbound", input: {text: "keep"}}))})).toThrow();
  expect(() => validateCrashRecoverySnapshot({...emptyCrashRecoverySnapshot(),
    unverifiedInputs: [{reason: "unsupported", input: {value: Number.NaN}}]})).toThrow();
});

it("preserves finite numeric values and JSON zero normalization while keeping sequence bounds strict", async () => {
  const f = saveFixture();
  try {
    const session = new EditSessionCoordinator(async (request) => f.store.handle(request));
    const handle = session.attach(f.store.get(f.record.pageId), f.record);
    session.edit(handle, {}, {count: 1e20});
    const journal = new CrashRecoveryFile(join(f.root, "recovery.json"), crashRecoveryWorkspaceId(f.store));
    journal.write(0, {...emptyCrashRecoverySnapshot(), records: session.exportRecovery()});
    expect(journal.read().snapshot!.records[0].intents[0].values!.count).toBe(1e20);
    session.edit(handle, {}, {count: -0});
    journal.write(1, {...emptyCrashRecoverySnapshot(), records: session.exportRecovery()});
    const entry = journal.read().snapshot!.records[0];
    expect(Object.is(entry.intents[1].values!.count, 0)).toBe(true);
    const restarted = new EditSessionCoordinator(async (request) => f.store.handle(request));
    restarted.restoreRecovery(entry, f.repo.readSnapshot(handle.pageId));
    await restarted.flush(handle.pageId);
    expect(f.repo.projection(handle.pageId).values.count).toBe(0);
    expect(() => validateCrashRecoverySnapshot({...emptyCrashRecoverySnapshot(), records: [{...entry, seq: 1e20}]})).toThrow();
  } finally {f.dispose();}
});
