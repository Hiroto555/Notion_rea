import { afterEach, expect, it, vi } from "vitest";
import { SaveScheduler } from "../src/renderer/save-scheduler";

afterEach(() => vi.useRealTimers());
it("sends the latest of ten inputs only after 500ms idle", () => {
  vi.useFakeTimers();
  const scheduler = new SaveScheduler(), send = vi.fn();
  for (let i = 0; i < 10; i++) {
    vi.advanceTimersByTime(40);
    scheduler.schedule("a", () => send(i));
  }
  vi.advanceTimersByTime(499);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(send.mock.calls).toEqual([[9]]);
});
it("bounds continuous input at 2500ms and drains other pages exactly once", () => {
  vi.useFakeTimers();
  const scheduler = new SaveScheduler(), send = vi.fn();
  for (let i = 0; i < 10; i++) {
    scheduler.schedule("a", () => send("a", i));
    vi.advanceTimersByTime(250);
  }
  expect(send.mock.calls).toEqual([["a", 9]]);
  for (const id of ["a", "b"]) scheduler.schedule(id, () => send(id));
  scheduler.flushAll();
  vi.runAllTimers();
  expect(send.mock.calls).toEqual([["a", 9], ["a"], ["b"]]);
});

it("retains a record immediately, checkpoints once before dispatch and waits for its ACK on flushAll", async () => {
  vi.useFakeTimers();
  const { EditSessionCoordinator } = await import("../src/renderer/edit-session-coordinator");
  const { operationFingerprint } = await import("../src/shared/save-contract");
  const checkpoint = vi.fn(async () => {});
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const page = {id: "a", parentId: null, revision: 0, title: "", doc: {type: "doc", content: [{type: "paragraph"}]},
    database: null, kind: "page" as const, icon: "", cover: "", favorite: false, position: 0,
    createdAt: 1, updatedAt: 1, deletedAt: null};
  const record = {pageId: page.id, databasePageId: "db", revision: 0, values: {}, title: "", icon: "", deletedAt: null};
  const sessions = new EditSessionCoordinator(async req => {
    if (req.type !== "save:commit") throw new Error("unexpected request");
    await barrier;
    const op = req.operation;
    return {status: "applied", operationId: op.operationId, pageId: op.pageId, sessionId: op.sessionId, seq: op.seq,
      fingerprint: await operationFingerprint(op), page: {...page, title: "ab", revision: 1},
      record: {...record, title: "ab", revision: 1}};
  }, {debounceMs: 500, beforeSend: checkpoint});
  const handle = sessions.attach(page, record);
  for (const title of ["a", "ab"]) {
    sessions.edit(handle, {title});
    sessions.scheduleFlush(page.id);
  }
  expect(sessions.hasUnsaved()).toBe(true);
  expect(sessions.get(page.id)?.page.title).toBe("ab");
  expect(checkpoint).not.toHaveBeenCalled();
  const done = sessions.flushAll();
  expect(checkpoint).toHaveBeenCalledTimes(1);
  expect(sessions.hasUnsaved()).toBe(true);
  release();
  await done;
  expect(sessions.get(page.id)?.state).toBe("saved");
  expect(sessions.hasUnsaved()).toBe(false);
});
