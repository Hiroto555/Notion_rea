import { expect, it } from "vitest";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { saveFixture } from "./fixtures/r4-save-fixture";
import type { Request } from "../src/shared/types";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {release = resolve;});
  return {promise, release};
}

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
