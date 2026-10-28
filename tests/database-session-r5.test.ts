import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { commitDatabaseOperation, readDatabaseSnapshot } from "../src/persistence/database-operations";
import { emptyDatabase, type Request } from "../src/shared/types";

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
