import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import { StorageFailureError, storageFailureMessageV1 } from "../src/renderer/private-request";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { operationFingerprint } from "../src/shared/save-contract";
import { commitDatabaseOperation, readDatabaseSnapshot } from "../src/persistence/database-operations";
import { emptyDatabase, type Request } from "../src/shared/types";

const base = (overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 => ({
  version: 1, kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST", failureSubject: "UNIDENTIFIED",
  mutationDispatch: "UNPROVEN", proofOrigin: "NONE", requestType: "database:commit", sourceOutcome: null,
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
  sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"], causeSummaryIncomplete: false, attemptId: "b".repeat(32)});

function fixture() {
  const root = mkdtempSync(resolve("output/r5-database-session-")), store = new Store(join(root, "workspace.sqlite"));
  const {rows: _rows, ...settings} = emptyDatabase();
  const created = commitDatabaseOperation(store, prepareDatabaseCreation("Tasks", null, settings));
  return {store, owner: created.page!, projection: created.database!, dispose() {store.close(); rmSync(root, {recursive: true, force: true});}};
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {release = resolve;});
  return {release, promise};
}

it("serializes owner title, semantic settings, record creation and later settings using acknowledged revisions", async () => {
  const f = fixture();
  try {
    const coordinator = new DatabaseSessionCoordinator(async (request) => f.store.handle(request));
    const handle = coordinator.attach(f.owner, f.projection), view = f.projection.settings.views[0];
    coordinator.editPage(handle, {title: "Renamed"});
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {filterText: ""}, patch: {filterText: "needle"}});
    const createdSeq = coordinator.createRecord(handle, "New record", {});
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {name: view.name}, patch: {name: "Saved view"}});
    expect(coordinator.get(f.owner.id)).toMatchObject({page: {title: "Renamed"}, projection: {settings: {filter: "needle"}}});
    await coordinator.flush(f.owner.id);
    const current = coordinator.get(f.owner.id)!;
    expect(current).toMatchObject({state: "saved", page: {title: "Renamed", revision: 3}, projection: {revision: 3}});
    expect(current.projection.records).toHaveLength(1);
    expect(current.lastResult).toMatchObject({seq: createdSeq, commandKind: "createRecord", page: {title: "New record"}});
    expect(readDatabaseSnapshot(f.store, f.owner.id).database.settings.views[0]).toMatchObject({filterText: "needle", name: "Saved view"});
    expect(coordinator.hasUnsaved()).toBe(false);
  } finally {f.dispose();}
});

it("keeps later title/settings inputs while an earlier settings ACK is delayed and the view is reopened", async () => {
  const f = fixture();
  try {
    const held = barrier(), entered = barrier();
    let commits = 0;
    const coordinator = new DatabaseSessionCoordinator(async (request) => {
      const result = f.store.handle(request);
      if (request.type === "database:commit" && ++commits === 1) {entered.release(); await held.promise;}
      return result;
    });
    const handle = coordinator.attach(f.owner, f.projection), view = f.projection.settings.views[0];
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {name: view.name}, patch: {name: "First"}});
    const saving = coordinator.flush(f.owner.id);
    await entered.promise;
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {name: "First"}, patch: {name: "Later"}});
    coordinator.editPage(handle, {title: "Later owner"});
    const remote = readDatabaseSnapshot(f.store, f.owner.id);
    expect(coordinator.attach(remote.page, remote.database)).toBe(handle);
    expect(coordinator.get(f.owner.id)?.projection.settings.views[0].name).toBe("Later");
    held.release(); await saving;
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "saved", page: {title: "Later owner", revision: 3}});
    expect(f.store.get(f.owner.id).database!.views[0].name).toBe("Later");
  } finally {f.dispose();}
});

it("resolves a lost record-create ACK without duplicate row and only then saves queued owner input", async () => {
  const f = fixture();
  try {
    let commits = 0;
    const coordinator = new DatabaseSessionCoordinator(async (request) => {
      const result = f.store.handle(request);
      if (request.type === "database:commit" && ++commits === 1) throw new Error("ACK lost");
      return result;
    });
    const handle = coordinator.attach(f.owner, f.projection);
    coordinator.createRecord(handle, "One row");
    await coordinator.flush(f.owner.id);
    expect(coordinator.get(f.owner.id)?.state).toBe("unknown");
    coordinator.editPage(handle, {title: "After resolution"});
    await coordinator.flush(f.owner.id);
    expect(commits).toBe(1);
    expect(coordinator.hasUnsaved()).toBe(true);
    await coordinator.resolve(f.owner.id);
    expect(commits).toBe(2);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "saved", page: {title: "After resolution"}, lastResult: {commandKind: "createRecord"}});
    expect(readDatabaseSnapshot(f.store, f.owner.id).database.records).toHaveLength(1);
  } finally {f.dispose();}
});

it("retains unknown settings drafts across navigation and does not resend when receipt is absent", async () => {
  const f = fixture();
  try {
    const requests: Request[] = [];
    const coordinator = new DatabaseSessionCoordinator(async (request) => {
      requests.push(request);
      if (request.type === "database:commit") throw new Error("Never delivered");
      return f.store.handle(request);
    });
    const handle = coordinator.attach(f.owner, f.projection), view = f.projection.settings.views[0];
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {filterText: ""}, patch: {filterText: "Unsaved filter"}});
    await coordinator.flush(f.owner.id);
    coordinator.attach(f.owner, f.projection);
    await coordinator.resolve(f.owner.id);
    await coordinator.flush(f.owner.id);
    expect(requests.map((request) => request.type)).toEqual(["database:commit", "database:resolve"]);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "unknown", projection: {settings: {filter: "Unsaved filter"}}});
    expect(f.store.get(f.owner.id).revision).toBe(0);
  } finally {f.dispose();}
});

it("does not rebase settings onto an external owner revision and retains the local intent", async () => {
  const f = fixture();
  try {
    const coordinator = new DatabaseSessionCoordinator(async (request) => f.store.handle(request));
    const handle = coordinator.attach(f.owner, f.projection), view = f.projection.settings.views[0];
    f.store.update(f.owner.id, 0, {title: "External"});
    const remote = readDatabaseSnapshot(f.store, f.owner.id);
    coordinator.attach(remote.page, remote.database);
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {name: view.name}, patch: {name: "Local draft"}});
    await coordinator.flush(f.owner.id);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "conflict", projection: {revision: 0}});
    expect(coordinator.get(f.owner.id)!.projection.settings.views[0].name).toBe("Local draft");
    expect(f.store.get(f.owner.id).title).toBe("External");
    expect(f.store.get(f.owner.id).database!.views[0].name).toBe(view.name);
    expect(coordinator.hasUnsaved()).toBe(true);
  } finally {f.dispose();}
});

it("refuses an ACK that unexpectedly replaces the owner body while saving only view settings", async () => {
  const f = fixture();
  try {
    const coordinator = new DatabaseSessionCoordinator(async (request) => {
      const result = f.store.handle(request) as any;
      if (request.type === "database:commit") return {...result, page: {...result.page,
        doc: {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "Unrequested body"}]}]}}};
      return result;
    });
    const handle = coordinator.attach(f.owner, f.projection), view = f.projection.settings.views[0];
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {name: view.name}, patch: {name: "Draft name"}});
    await coordinator.flush(f.owner.id);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "unknown", page: {doc: f.owner.doc}});
    expect(coordinator.hasUnsaved()).toBe(true);
    await coordinator.resolve(f.owner.id);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "saved", page: {doc: f.owner.doc}});
  } finally {f.dispose();}
});

it("latches a checkpoint failure before dispatch and clears it only on applied proof", async () => {
  const f = fixture();
  try {
    const requests: Request[] = [];
    const failure = checkpoint();
    const coordinator = new DatabaseSessionCoordinator(async (request) => {requests.push(request); return f.store.handle(request);},
      {beforeSend: async () => {throw new StorageFailureError(failure);}});
    const handle = coordinator.attach(f.owner, f.projection), view = f.projection.settings.views[0];
    coordinator.editSettings(handle, {kind: "viewPatch", viewId: view.id, base: {filterText: ""}, patch: {filterText: "Held filter"}});
    await coordinator.flush(f.owner.id);
    // Zero commits reached the store; the lane is unknown with the checkpoint diagnostic.
    expect(requests).toEqual([]);
    const held = coordinator.get(f.owner.id)!;
    expect(held).toMatchObject({state: "unknown", storageFailure: failure});
    expect(held.error).toBe(storageFailureMessageV1(failure));
    // The view is a bounded copy; mutating it cannot corrupt the latch.
    (held.storageFailure as unknown as Record<string, unknown>).kind = "MUTATED";
    expect(coordinator.get(f.owner.id)!.storageFailure).toEqual(failure);
    // A diagnostic-less resolve keeps the operation and the first diagnostic.
    await coordinator.resolve(f.owner.id);
    expect(requests.map((request) => request.type)).toEqual(["database:resolve"]);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "unknown", storageFailure: failure});
    // The exact applied proof clears operation and diagnostic together.
    commitDatabaseOperation(f.store, held.operation!);
    await coordinator.resolve(f.owner.id);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "saved", storageFailure: undefined, operation: undefined});
    expect(JSON.stringify(coordinator.exportRecovery(true))).not.toContain("storageFailure");
  } finally {f.dispose();}
});

it("shows only the fixed safe diagnostic text when the checkpoint throws a raw error", async () => {
  const f = fixture();
  try {
    const coordinator = new DatabaseSessionCoordinator(async (request) => f.store.handle(request),
      {beforeSend: async () => {throw new Error("capacity at /secret/workspace");}});
    const handle = coordinator.attach(f.owner, f.projection);
    coordinator.editPage(handle, {title: "Held owner"});
    await coordinator.flush(f.owner.id);
    const view = coordinator.get(f.owner.id)!;
    expect(view.state).toBe("unknown");
    expect(view.storageFailure).toMatchObject({kind: "UNCLASSIFIED", family: "REQUEST", requestType: "database:commit"});
    // The lane error is rebuilt from the validated latched kind, never the
    // raw caught message or path.
    expect(view.error).toBe(storageFailureMessageV1(view.storageFailure!));
    expect(view.error).not.toContain("secret");
  } finally {f.dispose();}
});

it("a terminal receipt carrying a diagnostic can never settle the lane applied or conflict", async () => {
  const f = fixture();
  try {
    for (const status of ["applied", "rejected"] as const) {
      const coordinator = new DatabaseSessionCoordinator(async (request) => {
        if (request.type === "database:commit") {
          const real = f.store.handle(request) as {page: object; database: object};
          // Fully valid content, but the terminal ACK still carries its own
          // failure metadata: contradictory, so it can never clear the lane.
          return {...real, status, operationId: request.operation.operationId,
            sessionId: request.operation.sessionId, seq: request.operation.seq,
            commandKind: request.operation.command.kind,
            fingerprint: await operationFingerprint(request.operation),
            storageFailure: typed("database:commit")};
        }
        return f.store.handle(request);
      });
      const handle = coordinator.attach(f.owner, f.projection);
      coordinator.editPage(handle, {title: `Held ${status}`});
      await coordinator.flush(f.owner.id);
      const view = coordinator.get(f.owner.id)!;
      expect(view.state, status).toBe("unknown");
      expect(view.operation, status).toBeDefined();
      // The normalized local E is the lane diagnostic; its display is the
      // fixed safe text.
      expect(view.storageFailure, status).toMatchObject(
        {kind: "UNCLASSIFIED", family: "REQUEST", requestType: "database:commit"});
      expect(view.error, status).toBe(storageFailureMessageV1(view.storageFailure!));
    }
  } finally {f.dispose();}
});

it("an unknown carrier without a diagnostic shows only the fixed safe line", async () => {
  const f = fixture();
  try {
    const coordinator = new DatabaseSessionCoordinator(async (request) => {
      if (request.type === "database:commit") return {status: "unknown",
        operationId: request.operation.operationId, sessionId: request.operation.sessionId,
        seq: request.operation.seq, commandKind: request.operation.command.kind,
        fingerprint: await operationFingerprint(request.operation), message: "raw /secret/wire"};
      return f.store.handle(request);
    });
    const handle = coordinator.attach(f.owner, f.projection);
    coordinator.editPage(handle, {title: "Held owner"});
    await coordinator.flush(f.owner.id);
    const view = coordinator.get(f.owner.id)!;
    expect(view.state).toBe("unknown");
    expect(view.storageFailure).toBeUndefined();
    expect(view.error).toBe("画面内に未保存入力を保持しています。新しい保存は確認できていません。");
    expect(view.error).not.toContain("secret");
  } finally {f.dispose();}
});

it("latches a typed transport failure on the lane and keeps it through a diagnostic-less resolve", async () => {
  const f = fixture();
  try {
    const failure = typed("database:commit");
    const coordinator = new DatabaseSessionCoordinator(async (request) => {
      if (request.type === "database:commit") throw new StorageFailureError(failure);
      return f.store.handle(request);
    });
    const handle = coordinator.attach(f.owner, f.projection);
    coordinator.editPage(handle, {title: "Held owner"});
    await coordinator.flush(f.owner.id);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "unknown", storageFailure: failure});
    expect(f.store.get(f.owner.id).title).toBe("Tasks");
    // A diagnostic-less resolve keeps the operation and the first diagnostic.
    await coordinator.resolve(f.owner.id);
    expect(coordinator.get(f.owner.id)).toMatchObject({state: "unknown", storageFailure: failure});
  } finally {f.dispose();}
});
