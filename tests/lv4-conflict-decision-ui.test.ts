import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ConflictDecisionModel } from "../src/renderer/conflict-decision-model";
import {
  inputReadyToClose,
  type InputCloseState,
} from "../src/renderer/input-close-guard";
import type { Request } from "../src/shared/types";
import type {
  ConflictDecisionPreview,
  ConflictDecisionView,
} from "../src/shared/workspace-conflict-resolution";

const idle: ConflictDecisionView = {
  state: "idle",
  decisionId: null,
  choice: null,
  canPreview: true,
  canCancel: false,
  reason: null,
};
const request = {
  choice: "local" as const,
  operationId: "conflict",
  expectedLocalHash: "a".repeat(64),
  expectedRemoteRevision: 2,
  expectedRemoteHash: "b".repeat(64),
};
function preview(): ConflictDecisionPreview {
  return {
    id: randomUUID(),
    latestPages: 1,
    latestAssets: 0,
    latestCheckpointJson: "{}",
    remoteCheckpointJson: "{}",
    target: {
      version: 1,
      choice: "local",
      workspaceId: "workspace",
      clientId: "client",
      bindingId: "binding",
      serverEpoch: "epoch",
      operationId: "conflict",
      localRevision: 1,
      localCheckpointHash: "a".repeat(64),
      remoteRevision: 2,
      remoteCheckpointHash: "b".repeat(64),
      conflictGeneration: 1,
      generation: 2,
      cleanGeneration: 0,
      appliedRevision: 1,
      receivedCursor: 1,
      latestCheckpointHash: "c".repeat(64),
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function modelFixture() {
  const selected = preview();
  let ready = true;
  const requested: ConflictDecisionView = {
    ...idle,
    state: "requested",
    decisionId: selected.id,
    choice: "local",
    canPreview: false,
    canCancel: true,
  };
  let view = idle;
  const calls = vi.fn(async (req: Request): Promise<unknown> => {
    if (req.type === "sync:conflictDecisionStatus") return view;
    if (req.type === "sync:conflictPreview") return selected;
    if (req.type === "sync:conflictConfirm") {
      view = requested;
      return { result: "requested", view };
    }
    if (req.type === "sync:conflictCancel") {
      view = { ...idle, state: "cancelled", decisionId: selected.id };
      return { result: "cancelled", view };
    }
    throw new Error("unexpected IPC");
  });
  const changed = vi.fn();
  const model = new ConflictDecisionModel(
    calls as <T>(request: Request) => Promise<T>,
    () => ready,
    changed,
  );
  return {
    model,
    calls,
    selected,
    requested,
    changed,
    setReady: (value: boolean) => {
      ready = value;
    },
    setView: (value: ConflictDecisionView) => {
      view = value;
    },
  };
}

it("requires an explicit acknowledgement and fresh input readiness before memory-only confirmation", async () => {
  const f = modelFixture();
  await f.model.refresh();
  await f.model.review(request);
  await f.model.confirm();
  expect(
    f.calls.mock.calls.filter(([r]) => r.type === "sync:conflictConfirm"),
  ).toHaveLength(0);
  f.model.acknowledge(true);
  f.setReady(false);
  await f.model.confirm();
  expect(
    f.calls.mock.calls.filter(([r]) => r.type === "sync:conflictConfirm"),
  ).toHaveLength(0);
  f.setReady(true);
  await f.model.confirm();
  expect(f.model.snapshot()).toMatchObject({
    busy: false,
    preview: null,
    view: { state: "requested" },
  });
  expect(f.calls.mock.calls.map(([r]) => r.type)).toEqual([
    "sync:conflictDecisionStatus",
    "sync:conflictPreview",
    "sync:conflictConfirm",
  ]);
  expect(f.calls.mock.calls[2][0]).toEqual({
    type: "sync:conflictConfirm",
    previewId: f.selected.id,
  });
});

it("sends one confirmation while the first response is pending, then permits cancellation", async () => {
  const f = modelFixture();
  await f.model.refresh();
  await f.model.review(request);
  f.model.acknowledge(true);
  const result = deferred<unknown>();
  f.calls.mockImplementationOnce(() => result.promise);
  const first = f.model.confirm();
  await f.model.confirm();
  expect(
    f.calls.mock.calls.filter(([r]) => r.type === "sync:conflictConfirm"),
  ).toHaveLength(1);
  result.resolve({ result: "requested", view: f.requested });
  await first;
  await f.model.cancel();
  expect(f.model.snapshot()).toMatchObject({
    busy: false,
    view: { state: "cancelled" },
  });
  expect(f.calls.mock.calls.at(-1)?.[0]).toEqual({
    type: "sync:conflictCancel",
    decisionId: f.selected.id,
  });
});

it("ignores an older preview response when a later review has already completed", async () => {
  const f = modelFixture();
  await f.model.refresh();
  const old = deferred<unknown>(),
    newer = preview();
  f.calls
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(newer);
  const first = f.model.review(request);
  await f.model.review({ ...request, choice: "remote" });
  old.resolve(preview());
  await first;
  expect(f.model.snapshot().preview?.id).toBe(newer.id);
});

it("ignores in-flight preview responses after the owning component unmounts", async () => {
  const f = modelFixture();
  await f.model.refresh();
  const response = deferred<unknown>();
  f.calls.mockImplementationOnce(() => response.promise);
  const review = f.model.review(request);
  f.model.invalidate();
  const changes = f.changed.mock.calls.length;
  response.resolve(f.selected);
  await review;
  expect(f.changed).toHaveBeenCalledTimes(changes);
});

it("resolves an unknown confirmation by status, without another selection or apply request", async () => {
  const f = modelFixture();
  await f.model.refresh();
  await f.model.review(request);
  f.model.acknowledge(true);
  f.calls.mockRejectedValueOnce(new Error("IPC reply lost"));
  await f.model.confirm();
  expect(f.model.snapshot().unknown).toBe(true);
  const before = f.calls.mock.calls.length;
  await f.model.review(request);
  expect(f.calls).toHaveBeenCalledTimes(before);
  f.setView(f.requested);
  await f.model.refresh();
  await f.model.cancel();
  expect(f.model.snapshot()).toMatchObject({
    unknown: false,
    view: { state: "cancelled" },
  });
  expect(
    f.calls.mock.calls.filter(([r]) => r.type === "sync:conflictConfirm"),
  ).toHaveLength(1);
});

it("allows durable pending cancellation while disconnected and with retained input", async () => {
  const f = modelFixture();
  f.setReady(false);
  f.setView({ ...f.requested, state: "pending", reason: "not-connected" });
  await f.model.refresh();
  await f.model.cancel();
  expect(f.model.snapshot().view?.state).toBe("cancelled");
});

it.each(["read-only", "not-connected"] as const)(
  "sends no preview/confirm in %s state",
  async (reason) => {
    const f = modelFixture();
    f.setView({ ...idle, canPreview: false, reason });
    await f.model.refresh();
    await f.model.review(request);
    f.model.acknowledge(true);
    await f.model.confirm();
    expect(f.calls.mock.calls.map(([r]) => r.type)).toEqual([
      "sync:conflictDecisionStatus",
    ]);
  },
);

it("does not let an older status response erase a newer preview", async () => {
  const f = modelFixture();
  await f.model.refresh();
  const status = deferred<unknown>();
  f.calls.mockImplementationOnce(() => status.promise);
  const refresh = f.model.refresh();
  await f.model.review(request);
  status.resolve({ ...idle, state: "blocked", canPreview: false });
  await refresh;
  expect(f.model.snapshot().preview?.id).toBe(f.selected.id);
  expect(f.model.snapshot().view?.canPreview).toBe(true);
});

const clean: InputCloseState = {
  composing: false,
  backupBusy: false,
  pendingSaves: 0,
  retainedEdits: 0,
  unsavedSessions: false,
  numberDrafts: false,
  databasePending: false,
  retainedPageOperations: false,
  restoringPages: 0,
  structuralOperation: false,
  recoverySaved: true,
  captureError: false,
};
it("refuses an IME-only close even before any saved or recovery draft exists", () => {
  expect(inputReadyToClose(clean)).toBe(true);
  expect(inputReadyToClose({ ...clean, composing: true })).toBe(false);
});
it.each<Partial<InputCloseState>>([
  { pendingSaves: 1 },
  { retainedEdits: 1 },
  { unsavedSessions: true },
  { numberDrafts: true },
  { databasePending: true },
  { retainedPageOperations: true },
  { restoringPages: 1 },
  { structuralOperation: true },
  { recoverySaved: false },
  { captureError: true },
  { backupBusy: true },
])("retains the close veto while work remains: %j", (pending) => {
  expect(inputReadyToClose({ ...clean, ...pending })).toBe(false);
});
