import { expect, it, vi } from "vitest";
import { ConflictDecisionModel } from "../src/renderer/conflict-decision-model";
import {
  conflictDecisionRefreshKey,
  createRefreshCoordinator,
} from "../src/renderer/WorkspaceConflictDecisionControls";
import type { Request } from "../src/shared/types";
import type { WorkspaceConflictInspection } from "../src/shared/workspace-conflict-view";
import type { ConflictDecisionView } from "../src/shared/workspace-conflict-resolution";

const conflict: WorkspaceConflictInspection = {
  operationId: "operation-1",
  localGeneration: 3,
  status: {
    receivedCursor: 4,
    appliedRevision: 3,
    generation: 3,
    cleanGeneration: 2,
    pending: true,
  },
  local: {
    side: "local",
    revision: 3,
    checkpointHash: "a".repeat(64),
    pages: 1,
    assets: 0,
    bytes: 100,
  },
  remote: {
    side: "remote",
    revision: 2,
    checkpointHash: "b".repeat(64),
    pages: 1,
    assets: 0,
    bytes: 100,
  },
};

const unavailable: ConflictDecisionView = {
  state: "idle",
  decisionId: null,
  choice: null,
  canPreview: false,
  canCancel: false,
  reason: "not-connected",
};
const available: ConflictDecisionView = {
  ...unavailable,
  canPreview: true,
  reason: null,
};

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

it("keys a refresh on the conflict identity, not on unrelated renders", () => {
  expect(conflictDecisionRefreshKey(null)).toBeNull();
  const key = conflictDecisionRefreshKey(conflict);
  expect(key).not.toBeNull();
  expect(conflictDecisionRefreshKey(structuredClone(conflict))).toBe(key);
  expect(
    conflictDecisionRefreshKey({
      ...conflict,
      remote: { ...conflict.remote, revision: 3 },
    }),
  ).not.toBe(key);
  expect(
    conflictDecisionRefreshKey({
      ...conflict,
      status: { ...conflict.status, generation: 4 },
    }),
  ).not.toBe(key);
  expect(
    conflictDecisionRefreshKey({
      ...conflict,
      operationId: "operation-2",
    }),
  ).not.toBe(key);
});

it("serializes status refreshes and coalesces requests made while one is in flight", async () => {
  const pending: Array<() => void> = [];
  const refresh = vi.fn(
    () => new Promise<void>((resolve) => pending.push(resolve)),
  );
  const coordinator = createRefreshCoordinator(refresh);

  coordinator.request();
  coordinator.request();
  coordinator.request();
  expect(refresh).toHaveBeenCalledTimes(1);

  pending.shift()!();
  await settle();
  expect(refresh).toHaveBeenCalledTimes(2);

  pending.shift()!();
  await settle();
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("stops queued work after disposal", async () => {
  const pending: Array<() => void> = [];
  const refresh = vi.fn(
    () => new Promise<void>((resolve) => pending.push(resolve)),
  );
  const coordinator = createRefreshCoordinator(refresh);

  coordinator.request();
  coordinator.request();
  coordinator.dispose();
  coordinator.request();
  pending.shift()!();
  await settle();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("replaces the mount-time unavailable status when the conflict later appears", async () => {
  let call = 0;
  let resolveUnavailable!: (view: ConflictDecisionView) => void;
  const first = new Promise<ConflictDecisionView>((resolve) => {
    resolveUnavailable = resolve;
  });
  const request = vi.fn((value: Request) => {
    if (value.type !== "sync:conflictDecisionStatus")
      return Promise.reject(new Error("unexpected IPC"));
    call++;
    return call === 1 ? first : Promise.resolve(available);
  });
  const model = new ConflictDecisionModel(
    request as <T>(request: Request) => Promise<T>,
    () => true,
    () => {},
  );
  const coordinator = createRefreshCoordinator(() => model.refresh());

  coordinator.request();
  expect(model.snapshot().view).toBeNull();

  coordinator.request();
  expect(request).toHaveBeenCalledTimes(1);

  resolveUnavailable(unavailable);
  await settle();
  await settle();
  expect(request).toHaveBeenCalledTimes(2);
  expect(model.snapshot().view).toEqual(available);
});
