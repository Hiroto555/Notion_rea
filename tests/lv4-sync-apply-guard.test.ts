import { expect, it } from "vitest";
import { checkSyncApplyTarget } from "../src/main/workspace-sync-apply-guard";
import { emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { hashCheckpoint, type Change, type Checkpoint } from "../src/sync/protocol";
const checkpoint: Checkpoint = {format: "folio-checkpoint/v1", name: "test", version: 1, payload: {}, assets: []};
const hash = hashCheckpoint(checkpoint);
const identity = {workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch"};
const target = {...identity, revision: 1, checkpointHash: hash};
const incoming: Change = {revision: 1, checkpoint, checkpointHash: hash, clientId: "other", operationId: "op", fingerprint: "b".repeat(64)};
const input = {target, identity, incoming, status: {receivedCursor: 1, appliedRevision: 0, generation: 1, cleanGeneration: 1, pending: false, conflict: false}, recovery: {status: "empty" as const, generation: 0}};
it("requires an exact, contiguous, hash-verified staged target and clean workspace", () => {
  expect(checkSyncApplyTarget(input)).toBe("ready");
  expect(checkSyncApplyTarget({...input, identity: {...identity, serverEpoch: "new"}})).toBe("target-changed");
  expect(checkSyncApplyTarget({...input, target: {...target, revision: 2}})).toBe("target-changed");
  expect(checkSyncApplyTarget({...input, incoming: {...incoming, checkpoint: {...checkpoint, name: "modified"}}})).toBe("target-changed");
  expect(checkSyncApplyTarget({...input, status: {...input.status, pending: true}})).toBe("workspace-changed");
  expect(checkSyncApplyTarget({...input, status: {...input.status, generation: 2}})).toBe("workspace-changed");
});
it("blocks unreadable or retained recovery input before applying", () => {
  expect(checkSyncApplyTarget({...input, recovery: {status: "blocked", generation: 0}})).toBe("recovery-input");
  const snapshot = emptyCrashRecoverySnapshot(); snapshot.rawDrafts.push({scope: "record", pageId: "p", key: "k", value: "pending"});
  expect(checkSyncApplyTarget({...input, recovery: {status: "ready", generation: 1, snapshot}})).toBe("recovery-input");
  expect(checkSyncApplyTarget({...input, recovery: {status: "ready", generation: 1, snapshot: emptyCrashRecoverySnapshot()}})).toBe("ready");
});
