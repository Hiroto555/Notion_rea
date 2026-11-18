import { expect, it } from "vitest";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { StorageFailureError, storageFailureMessageV1 } from "../src/renderer/private-request";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import { saveFixture } from "./fixtures/r4-save-fixture";
import { operationFingerprint } from "../src/shared/save-contract";
import type { Request } from "../src/shared/types";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {release = resolve;});
  return {promise, release};
}
const base = (overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 => ({
  version: 1, kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST", failureSubject: "UNIDENTIFIED",
  mutationDispatch: "UNPROVEN", proofOrigin: "NONE", requestType: "save:commit", sourceOutcome: null,
  sourceCauseCodes: [], causeSummaryIncomplete: true, attemptId: null, precondition: null,
  operationProgress: "PARTIAL_OR_UNKNOWN", retryAuthority: "NONE", preserve: true, ...overrides});
const typed = (requestType: string): StorageFailureV1 => base({kind: "OUTCOME_UNKNOWN", family: "K", stage: "COMMIT",
  failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "DISPATCHED", proofOrigin: "DISPATCH_OBSERVED",
  requestType, sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "PRIVATE_K_COMMIT_UNKNOWN"},
  sourceCauseCodes: ["PRIVATE_K_COMMIT_UNKNOWN"], causeSummaryIncomplete: false});
const checkpoint = (): StorageFailureV1 => base({kind: "PRE_DISPATCH_CAPACITY", family: "CHECKPOINT", stage: "RESERVE",
  failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN", proofOrigin: "LOCAL_ADMISSION_GUARD",
  requestType: "recovery:write",
  sourceOutcome: {source: "RECOVERY_IO", contractVersion: 3, state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED"},
  sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"], causeSummaryIncomplete: false, attemptId: "a".repeat(32)});

it("keeps later inputs and independent record sessions when an earlier ACK is delayed", async () => {
  const f = saveFixture();
  try {
    const held = barrier(), entered = barrier();
    let commits = 0;
    const coordinator = new EditSessionCoordinator(async (request) => {
      const result = f.store.handle(request);
      if (request.type === "save:commit" && ++commits === 1) {entered.release(); await held.promise;}
      return result;
    });
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "First"});
    const flush = coordinator.flush(handle.pageId);
    await entered.promise;
    coordinator.edit(handle, {doc: {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "Later body"}]}]}}, {done: true});
    const other = f.repo.create(f.owner.id, "Other", {done: false});
    const otherHandle = coordinator.attach(f.store.get(other.pageId), other);
    coordinator.edit(otherHandle, {title: "Second record"});
    await coordinator.flush(other.pageId);
    expect(coordinator.get(other.pageId)).toMatchObject({state: "saved", page: {title: "Second record"}});
    held.release();
    await flush;
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "saved", page: {title: "First", revision: 2}, record: {values: {done: true}}});
    expect(JSON.stringify(f.store.get(handle.pageId).doc)).toContain("Later body");
    expect(f.store.get(other.pageId).title).toBe("Second record");
    expect(coordinator.hasUnsaved()).toBe(false);
  } finally {f.dispose();}
});

it("retains unknown operation across close/reopen, blocks new sends and resolves before follow-up", async () => {
  const f = saveFixture();
  try {
    let commits = 0;
    const coordinator = new EditSessionCoordinator(async (request) => {
      const result = f.store.handle(request);
      if (request.type === "save:commit" && ++commits === 1) throw new Error("ACK lost");
      return result;
    });
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Committed"});
    await coordinator.flush(handle.pageId);
    expect(coordinator.get(handle.pageId)?.state).toBe("unknown");
    const operationId = coordinator.get(handle.pageId)?.operation?.operationId;
    coordinator.edit(handle, {}, {note: "typed while unknown"});
    const reopened = coordinator.attach(f.store.get(handle.pageId), f.repo.projection(handle.pageId));
    expect(reopened).toBe(handle);
    await coordinator.flush(handle.pageId);
    expect(commits).toBe(1);
    expect(coordinator.get(handle.pageId)).toMatchObject({page: {title: "Committed"}, record: {values: {note: "typed while unknown"}}, operation: {operationId}});
    expect(coordinator.hasUnsaved()).toBe(true);
    await coordinator.resolve(handle.pageId);
    expect(commits).toBe(2);
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "saved", page: {revision: 2}, record: {values: {note: "typed while unknown"}}});
    expect(coordinator.hasUnsaved()).toBe(false);
  } finally {f.dispose();}
});

it("does not turn absent receipt into permission to retry or erase the draft", async () => {
  const f = saveFixture();
  try {
    const requests: Request[] = [];
    const coordinator = new EditSessionCoordinator(async (request) => {
      requests.push(request);
      if (request.type === "save:commit") throw new Error("Disconnected before delivery");
      return f.store.handle(request);
    });
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Draft"}, {count: 99});
    await coordinator.flush(handle.pageId);
    await coordinator.resolve(handle.pageId);
    await coordinator.flush(handle.pageId);
    expect(requests.map((request) => request.type)).toEqual(["save:commit", "save:resolve"]);
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "unknown", page: {title: "Draft"}, record: {values: {count: 99}}});
    expect(f.store.get(handle.pageId).title).toBe("Task");
  } finally {f.dispose();}
});

it("binds displayed body and revision even when a newer list/read arrives before input", async () => {
  const f = saveFixture();
  try {
    const coordinator = new EditSessionCoordinator(async (request) => f.store.handle(request));
    const page = f.store.get(f.record.pageId), handle = coordinator.attach(page, f.record);
    f.repo.patch(page.id, f.owner.id, page.revision, {title: "External"});
    const latest = f.repo.readSnapshot(page.id);
    expect(coordinator.attach(latest.page, latest.record)).toBe(handle);
    expect(coordinator.get(page.id)?.baseRevision).toBe(0);
    coordinator.edit(handle, {title: "Local"});
    await coordinator.flush(page.id);
    expect(coordinator.get(page.id)).toMatchObject({state: "conflict", page: {title: "Local"}});
    expect(f.store.get(page.id).title).toBe("External");
    expect(coordinator.hasUnsaved()).toBe(true);
  } finally {f.dispose();}
});

it("times out a pending ACK as unknown and only acknowledges the bound operation", async () => {
  const f = saveFixture();
  try {
    const coordinator = new EditSessionCoordinator(async (request) => {
      const result = f.store.handle(request);
      if (request.type === "save:commit") return new Promise(() => {});
      return result;
    }, {timeoutMs: 5});
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    expect(() => coordinator.edit({...handle, sessionId: "stale"}, {title: "Wrong"})).toThrow(/セッション/);
    coordinator.edit(handle, {title: "Saved without ACK"});
    await coordinator.flush(handle.pageId);
    expect(coordinator.get(handle.pageId)?.state).toBe("unknown");
    await coordinator.resolve(handle.pageId);
    expect(coordinator.get(handle.pageId)?.state).toBe("saved");
    expect(f.store.get(handle.pageId).revision).toBe(1);
  } finally {f.dispose();}
});

it("keeps an earlier query with no receipt unknown until the original delayed request commits", async () => {
  const f = saveFixture();
  try {
    const held = barrier();
    let commits = 0;
    const coordinator = new EditSessionCoordinator(async (request) => {
      if (request.type === "save:commit") {commits++; await held.promise;}
      return f.store.handle(request);
    }, {timeoutMs: 5});
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Delayed request"});
    await coordinator.flush(handle.pageId);
    await coordinator.resolve(handle.pageId);
    expect(coordinator.get(handle.pageId)?.state).toBe("unknown");
    expect(f.store.get(handle.pageId).revision).toBe(0);
    held.release();
    await held.promise;
    await coordinator.resolve(handle.pageId);
    expect(coordinator.get(handle.pageId)?.state).toBe("saved");
    expect(f.store.get(handle.pageId).revision).toBe(1);
    expect(commits).toBe(1);
  } finally {f.dispose();}
});

it("latches a checkpoint failure before dispatch and clears it only on applied proof", async () => {
  const f = saveFixture();
  try {
    const requests: Request[] = [];
    const failure = checkpoint();
    const coordinator = new EditSessionCoordinator(async (request) => {requests.push(request); return f.store.handle(request);},
      {beforeSend: async () => {throw new StorageFailureError(failure);}});
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Held"});
    await coordinator.flush(handle.pageId);
    // Zero commits reached the store; the lane is unknown with the checkpoint diagnostic.
    expect(requests).toEqual([]);
    const held = coordinator.get(handle.pageId)!;
    expect(held).toMatchObject({state: "unknown"});
    expect(held.storageFailure).toEqual(failure);
    expect(held.error).toBe(storageFailureMessageV1(failure));
    expect(held.operation).toBeDefined();
    // Another lane is untouched, and the view is a bounded copy.
    const other = f.repo.create(f.owner.id, "Other", {});
    const otherHandle = coordinator.attach(f.store.get(other.pageId), other);
    expect(coordinator.get(other.pageId)!.storageFailure).toBeUndefined();
    (held.storageFailure as unknown as Record<string, unknown>).kind = "MUTATED";
    expect(coordinator.get(handle.pageId)!.storageFailure).toEqual(failure);
    // A diagnostic-less resolve keeps the operation and the first diagnostic.
    await coordinator.resolve(handle.pageId);
    expect(requests.map((request) => request.type)).toEqual(["save:resolve"]);
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "unknown", storageFailure: failure});
    // The exact applied proof clears operation and diagnostic together.
    f.store.commitSave(held.operation!);
    await coordinator.resolve(handle.pageId);
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "saved", storageFailure: undefined, operation: undefined});
    expect(JSON.stringify(coordinator.exportRecovery(true))).not.toContain("storageFailure");
  } finally {f.dispose();}
});

it("shows only the fixed safe diagnostic text when the checkpoint throws a raw error", async () => {
  const f = saveFixture();
  try {
    const coordinator = new EditSessionCoordinator(async (request) => f.store.handle(request),
      {beforeSend: async () => {throw new Error("capacity at /secret/workspace");}});
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Held"});
    await coordinator.flush(handle.pageId);
    const view = coordinator.get(handle.pageId)!;
    expect(view.state).toBe("unknown");
    expect(view.storageFailure).toMatchObject({kind: "UNCLASSIFIED", family: "REQUEST", requestType: "save:commit"});
    // The lane error is rebuilt from the validated latched kind, never the
    // raw caught message or path.
    expect(view.error).toBe(storageFailureMessageV1(view.storageFailure!));
    expect(view.error).not.toContain("secret");
    expect(view.operation).toBeDefined();
  } finally {f.dispose();}
});

it("keeps the first diagnostic and its fixed display through a diagnostic-less or raw resolve", async () => {
  const f = saveFixture();
  try {
    const failure = checkpoint();
    let send: "store" | "raw" = "store";
    const coordinator = new EditSessionCoordinator(async (request) => {
      if (send === "raw") throw new Error("secondary /other/path");
      return f.store.handle(request);
    }, {beforeSend: async () => {throw new StorageFailureError(failure);}});
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Held"});
    await coordinator.flush(handle.pageId);
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "unknown",
      storageFailure: failure, error: storageFailureMessageV1(failure)});
    // A diagnostic-less resolve keeps the first diagnostic and its display.
    await coordinator.resolve(handle.pageId);
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "unknown",
      storageFailure: failure, error: storageFailureMessageV1(failure)});
    // So does a secondary raw failure that reaches the resolve catch.
    send = "raw";
    await coordinator.resolve(handle.pageId);
    const held = coordinator.get(handle.pageId)!;
    expect(held.storageFailure).toEqual(failure);
    expect(held.error).toBe(storageFailureMessageV1(failure));
    expect(held.error).not.toContain("other");
  } finally {f.dispose();}
});

it("shows the fixed safe line for an unknown carrier without a diagnostic and keeps rejected messages", async () => {
  const f = saveFixture();
  try {
    const coordinator = new EditSessionCoordinator(async (request) => {
      if (request.type === "save:commit") return {status: "unknown", operationId: request.operation.operationId,
        sessionId: request.operation.sessionId, seq: request.operation.seq, pageId: request.operation.pageId,
        fingerprint: await operationFingerprint(request.operation), message: "raw /secret/wire"};
      return f.store.handle(request);
    });
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Held"});
    await coordinator.flush(handle.pageId);
    const view = coordinator.get(handle.pageId)!;
    expect(view.state).toBe("unknown");
    expect(view.storageFailure).toBeUndefined();
    expect(view.error).toBe("画面内に未保存入力を保持しています。新しい保存は確認できていません。");
    expect(view.error).not.toContain("secret");
    // A verified business rejection without a diagnostic keeps its normal
    // wire message.
    const other = f.repo.create(f.owner.id, "Other", {});
    const conflicts = new EditSessionCoordinator(async (request) => {
      if (request.type === "save:commit") return {status: "rejected", operationId: request.operation.operationId,
        sessionId: request.operation.sessionId, seq: request.operation.seq, pageId: request.operation.pageId,
        fingerprint: await operationFingerprint(request.operation), message: "保存が競合しました。"};
      return f.store.handle(request);
    });
    const otherHandle = conflicts.attach(f.store.get(other.pageId), other);
    conflicts.edit(otherHandle, {title: "Stale"});
    await conflicts.flush(other.pageId);
    expect(conflicts.get(other.pageId)).toMatchObject({state: "conflict", error: "保存が競合しました。"});
  } finally {f.dispose();}
});

it("latches a typed transport failure and advances held input only after applied proof", async () => {
  const f = saveFixture();
  try {
    const requests: Request[] = [];
    let fail = true;
    const failure = typed("save:commit");
    const coordinator = new EditSessionCoordinator(async (request) => {
      requests.push(request);
      if (fail && request.type === "save:commit") throw new StorageFailureError(failure);
      return f.store.handle(request);
    });
    const handle = coordinator.attach(f.store.get(f.record.pageId), f.record);
    coordinator.edit(handle, {title: "Maybe applied"}, {count: 7});
    await coordinator.flush(handle.pageId);
    expect(requests.map((request) => request.type)).toEqual(["save:commit"]);
    const view = coordinator.get(handle.pageId)!;
    expect(view).toMatchObject({state: "unknown", storageFailure: failure});
    expect(view.error).toBe(storageFailureMessageV1(failure));
    expect(f.store.get(handle.pageId).title).toBe("Task");
    // Later input is held: it does not resend the unknown operation.
    coordinator.edit(handle, {title: "Later"});
    await coordinator.flush(handle.pageId);
    expect(requests.map((request) => request.type)).toEqual(["save:commit"]);
    // A diagnostic-less resolve keeps operation and first diagnostic.
    await coordinator.resolve(handle.pageId);
    expect(coordinator.get(handle.pageId)).toMatchObject({state: "unknown", storageFailure: failure});
    // The exact applied proof clears both and lets the held input advance causally.
    fail = false;
    f.store.commitSave(view.operation!);
    await coordinator.resolve(handle.pageId);
    expect(requests.map((request) => request.type)).toEqual(
      ["save:commit", "save:resolve", "save:resolve", "save:commit"]);
    expect(coordinator.get(handle.pageId)).toMatchObject(
      {state: "saved", storageFailure: undefined, page: {title: "Later", revision: 2}});
  } finally {f.dispose();}
});
