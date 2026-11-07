import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
import { finishWorkspaceQuit } from "../src/main/workspace-quit";
import {
  WorkspaceSyncRestartControl,
  WorkspaceSyncRestartCoordinator,
  type WorkspaceSyncRestartSource,
} from "../src/main/workspace-sync-restart-coordinator";
import { WorkspaceSyncIntentFile, type SyncApplyTarget } from "../src/main/workspace-sync-intent";
import { emptyCrashRecoverySnapshot, type CrashRecoveryRead } from "../src/shared/crash-recovery";
import { requestSchema } from "../src/shared/types";
import { hashCheckpoint, type Change, type Checkpoint } from "../src/sync/protocol";
import type { WorkspaceSyncStatus } from "../src/sync/workspace-store";

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-lv4-restart-coordinator-")));
  roots.push(root);
  const checkpoint: Checkpoint = {
    format: "folio-checkpoint/v1",
    name: "checkpoint",
    version: 1,
    payload: {},
    assets: [],
  };
  const checkpointHash = hashCheckpoint(checkpoint);
  const target: SyncApplyTarget = {
    workspaceId: "workspace",
    clientId: "client",
    bindingId: "binding",
    serverEpoch: "epoch",
    revision: 2,
    checkpointHash,
  };
  const incoming: Change = {
    revision: 2,
    clientId: "other-client",
    operationId: "operation",
    fingerprint: "f".repeat(64),
    checkpointHash,
    checkpoint,
  };
  const initialStatus: WorkspaceSyncStatus = {
    receivedCursor: 2,
    appliedRevision: 1,
    generation: 4,
    cleanGeneration: 4,
    pending: false,
    conflict: false,
  };
  const state: {
    target: SyncApplyTarget | null;
    incoming: Change | null;
    status: WorkspaceSyncStatus;
    running: boolean;
    gateIdle: boolean;
    recovery: CrashRecoveryRead;
    windowsClosed: boolean;
  } = {
    target,
    incoming,
    status: initialStatus,
    running: false,
    gateIdle: true,
    recovery: {status: "empty", generation: 0},
    windowsClosed: false,
  };
  const source: WorkspaceSyncRestartSource = {
    target: () => state.target,
    status: () => state.status,
    incoming: () => state.incoming,
    running: () => state.running,
    gateIdle: () => state.gateIdle,
    recovery: () => state.recovery,
    windowsClosed: () => state.windowsClosed,
  };
  const file = new WorkspaceSyncIntentFile(root);
  return {root, file, target, incoming, initialStatus, state, source};
}

it("uses only the main-selected target and publishes nothing until windows close", () => {
  const f = fixture();
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, f.source);

  expect(coordinator.status()).toEqual({
    available: true,
    state: "idle",
    scheduled: false,
    targetRevision: 2,
    canRequest: true,
    canCancel: false,
    reason: null,
  });
  const requested = coordinator.requestRestart();
  expect(requested.result).toBe("prepared");
  expect(requested.view).toMatchObject({
    state: "requested",
    targetRevision: 2,
    canRequest: false,
    canCancel: true,
  });
  expect(f.file.read()).toEqual({status: "empty"});
  expect(coordinator.requestRestart().result).toBe("blocked");
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  expect(f.file.read()).toEqual({status: "empty"});

  const cancelled = coordinator.cancelRestart();
  expect(cancelled.result).toBe("cancelled");
  expect(cancelled.view).toMatchObject({state: "idle", canRequest: true, canCancel: false});
  expect(f.file.read()).toEqual({status: "empty"});
});

it("keeps unsaved input out of the request and refuses to prepare", () => {
  const f = fixture();
  const snapshot = emptyCrashRecoverySnapshot();
  snapshot.rawDrafts.push({scope: "record", pageId: "page", key: "count", value: "42"});
  f.state.recovery = {status: "ready", generation: 1, snapshot};
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, f.source);

  expect(coordinator.status()).toMatchObject({
    available: true,
    state: "idle",
    targetRevision: null,
    canRequest: false,
    reason: "unsaved-changes",
  });
  expect(coordinator.requestRestart().result).toBe("blocked");
  expect(f.file.read()).toEqual({status: "empty"});
});

it("cancels a prepared request without deleting later unsaved input", () => {
  const f = fixture();
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, f.source);
  expect(coordinator.requestRestart().result).toBe("prepared");
  const snapshot = emptyCrashRecoverySnapshot();
  snapshot.rawDrafts.push({scope: "database", pageId: "database", key: "title", value: "未保存"});
  const recovery: CrashRecoveryRead = {status: "ready", generation: 2, snapshot};
  f.state.recovery = recovery;

  expect(coordinator.status()).toMatchObject({state: "requested", canCancel: true});
  expect(coordinator.cancelRestart().result).toBe("cancelled");
  expect(f.state.recovery).toBe(recovery);
  expect(f.file.read()).toEqual({status: "empty"});
});

it("commits only after windows close and fresh matching safety checks", () => {
  const f = fixture();
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, f.source);
  expect(coordinator.requestRestart().result).toBe("prepared");

  f.state.windowsClosed = true;
  const snapshot = emptyCrashRecoverySnapshot();
  snapshot.rawDrafts.push({scope: "record", pageId: "page", key: "late", value: "keep"});
  f.state.recovery = {status: "ready", generation: 1, snapshot};
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  f.state.recovery = {status: "empty", generation: 0};
  f.state.running = true;
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  f.state.running = false;
  f.state.gateIdle = false;
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  expect(f.file.read()).toEqual({status: "empty"});
  f.state.gateIdle = true;
  f.state.status = {...f.initialStatus, pending: true};
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  f.state.status = {...f.initialStatus, conflict: true};
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  f.state.status = f.initialStatus;
  f.state.target = {...f.target, revision: 3};
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  expect(f.file.read()).toEqual({status: "empty"});

  f.state.target = f.target;
  expect(coordinator.commitAfterWindowsClosed()).toBe("committed");
  expect(f.file.read()).toEqual({status: "ready", target: f.target});
  expect(coordinator.status()).toMatchObject({
    state: "committed",
    scheduled: true,
    targetRevision: 2,
    canRequest: false,
    canCancel: true,
  });

  expect(coordinator.cancelRestart().result).toBe("cancelled");
  expect(f.file.read()).toEqual({status: "empty"});
});

it("does not replace an existing next-start intent", () => {
  const f = fixture();
  f.file.create(f.target);
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, f.source);

  expect(coordinator.status()).toMatchObject({
    state: "idle",
    scheduled: true,
    targetRevision: 2,
    canRequest: false,
    canCancel: false,
    reason: "intent-present",
  });
  expect(coordinator.requestRestart().result).toBe("blocked");
  expect(f.file.read()).toEqual({status: "ready", target: f.target});
});

it("fails closed for running sync, changed targets and unreadable safety state", () => {
  const f = fixture();
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, f.source);

  f.state.running = true;
  expect(coordinator.status()).toMatchObject({canRequest: false, reason: "sync-active"});
  f.state.running = false;
  f.state.gateIdle = false;
  expect(coordinator.status()).toMatchObject({canRequest: false, reason: "sync-active"});
  expect(coordinator.requestRestart().result).toBe("blocked");
  f.state.gateIdle = true;
  f.state.incoming = {...f.incoming, clientId: f.target.clientId};
  expect(coordinator.status()).toMatchObject({canRequest: false, reason: "target-changed"});
  f.state.incoming = {...f.incoming, checkpointHash: "b".repeat(64)};
  expect(coordinator.status()).toMatchObject({canRequest: false, reason: "target-changed"});
  expect(coordinator.requestRestart().result).toBe("blocked");
  expect(f.file.read()).toEqual({status: "empty"});

  const unreadable = new WorkspaceSyncRestartCoordinator(f.file, {
    ...f.source,
    status: () => {throw new Error("unavailable");},
  });
  expect(unreadable.status()).toMatchObject({canRequest: false, reason: "state-unavailable"});
  expect(unreadable.requestRestart().result).toBe("blocked");
});

it("reports unavailable controls without a coordinator", () => {
  const readOnly = new WorkspaceSyncRestartControl(undefined, true);
  expect(readOnly.status()).toEqual({available: false, reason: "read-only"});
  expect(readOnly.request()).toEqual({
    result: "unavailable",
    view: {available: false, reason: "read-only"},
  });
  expect(readOnly.cancel()).toEqual({
    result: "unavailable",
    view: {available: false, reason: "read-only"},
  });
  expect(readOnly.commitAfterWindowsClosed()).toBe("not-prepared");

  const disconnected = new WorkspaceSyncRestartControl(undefined, false);
  expect(disconnected.status()).toEqual({available: false, reason: "not-connected"});
});

it("does not accept a renderer-selected restart target", () => {
  expect(requestSchema.safeParse({type: "sync:restartRequest"}).success).toBe(true);
  expect(requestSchema.safeParse({type: "sync:restartRequest", target: {revision: 1}}).success).toBe(false);
  expect(requestSchema.safeParse({type: "sync:restartCancel", clientId: "other"}).success).toBe(false);
});

it("refuses both ordinary prepare and final commit while a conflict reservation exists", () => {
  const f = fixture(); let clear = false;
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, {...f.source, otherIntentClear: () => clear});
  expect(coordinator.requestRestart().result).toBe("blocked");
  expect(coordinator.status()).toMatchObject({canRequest: false, reason: "intent-present"});
  clear = true; expect(coordinator.requestRestart().result).toBe("prepared");
  f.state.windowsClosed = true; clear = false;
  expect(coordinator.commitAfterWindowsClosed()).toBe("blocked");
  expect(f.file.read()).toEqual({status: "empty"});
});

it("holds quit while a workspace write remains and commits only after it finishes", async () => {
  const f = fixture(), gate = new WorkspaceSyncGate();
  const coordinator = new WorkspaceSyncRestartCoordinator(f.file, {...f.source, gateIdle: () => gate.isIdle()});
  expect(coordinator.requestRestart().result).toBe("prepared");
  let release!: () => void;
  const write = gate.write(() => new Promise<void>((resolve) => {release = resolve;}));
  f.state.windowsClosed = true;
  const preventQuit = vi.fn(), reopenWindow = vi.fn(), closeStore = vi.fn();
  const options = {commitRestart: () => coordinator.commitAfterWindowsClosed(), preventQuit, reopenWindow, closeStore};
  expect(finishWorkspaceQuit(options)).toBe("held");
  expect(f.file.read()).toEqual({status: "empty"});
  expect(preventQuit).toHaveBeenCalledOnce();
  expect(reopenWindow).toHaveBeenCalledOnce();
  expect(closeStore).not.toHaveBeenCalled();
  release(); await write;
  expect(finishWorkspaceQuit(options)).toBe("quit");
  expect(f.file.read()).toEqual({status: "ready", target: f.target});
  expect(closeStore).toHaveBeenCalledOnce();
});
