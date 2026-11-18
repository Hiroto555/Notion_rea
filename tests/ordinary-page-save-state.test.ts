import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { PendingEdits } from "../src/renderer/pending-edits";
import { sendReliableSave, resolveReliableSave } from "../src/renderer/reliable-save";
import {
  retainOrdinaryPageFailure,
  settleOrdinaryPageSave,
  type OrdinaryPageSaveState,
} from "../src/renderer/ordinary-page-save-state";
import { StorageFailureError } from "../src/renderer/private-request";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import { operationFingerprint, type SaveOperation, type SaveResult } from "../src/shared/save-contract";
import { saveFixture } from "./fixtures/r4-save-fixture";

const local = (overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 => ({
  version: 1, kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST", failureSubject: "UNIDENTIFIED",
  mutationDispatch: "UNPROVEN", proofOrigin: "NONE", requestType: "save:commit", sourceOutcome: null,
  sourceCauseCodes: [], causeSummaryIncomplete: true, attemptId: null, precondition: null,
  operationProgress: "PARTIAL_OR_UNKNOWN", retryAuthority: "NONE", preserve: true, ...overrides});
const typed = (requestType: string): StorageFailureV1 => local({kind: "OUTCOME_UNKNOWN", family: "K", stage: "COMMIT",
  failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "DISPATCHED", proofOrigin: "DISPATCH_OBSERVED",
  requestType, sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "PRIVATE_K_COMMIT_UNKNOWN"},
  sourceCauseCodes: ["PRIVATE_K_COMMIT_UNKNOWN"], causeSummaryIncomplete: false});
const checkpoint = (): StorageFailureV1 => local({kind: "PRE_DISPATCH_CAPACITY", family: "CHECKPOINT", stage: "RESERVE",
  failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN", proofOrigin: "LOCAL_ADMISSION_GUARD",
  requestType: "recovery:write",
  sourceOutcome: {source: "RECOVERY_IO", contractVersion: 3, state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED"},
  sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"], causeSummaryIncomplete: false, attemptId: "a".repeat(32)});

const state = (): OrdinaryPageSaveState => ({operations: new Map(), storageFailures: new Map()});
const operation = (pageId: string, patch: SaveOperation["patch"], seq = 1, sessionId = "page-session"): SaveOperation =>
  ({operationId: randomUUID(), sessionId, seq, pageId, databasePageId: null, revision: 0, patch});

it("App wires the production ordinary-Page save state, not a parallel validator", () => {
  const source = readFileSync(resolve("src/renderer/App.tsx"), "utf8");
  expect(source).toContain('from "./ordinary-page-save-state"');
  expect(source).toContain("pageStorageFailures");
  expect(source).toContain("settleOrdinaryPageSave(pageSaveState()");
  expect(source).toContain("retainOrdinaryPageFailure(pageSaveState()");
  // The application-lifetime operation map still exists; diagnostics only live
  // beside it, never inside the operation or the recovery snapshot.
  expect(source).toContain("pageOperations.current");
});

it("latches a checkpoint failure on the pending operation and keeps the first diagnostic", () => {
  const f = saveFixture();
  try {
    const edits = new PendingEdits();
    const seq = edits.addObservedPage(f.page.id, f.page.revision, {title: "Held input"}, true);
    const op = operation(f.page.id, edits.patch(f.page.id, seq), seq);
    const saves = state();
    saves.operations.set(f.page.id, op);
    const failure = checkpoint();
    // beforeSend refused: the checkpoint diagnostic latches without touching
    // the retained operation or the pending input. Nothing was sent.
    expect(retainOrdinaryPageFailure(saves, op, new StorageFailureError(failure))).toEqual(failure);
    expect(saves.storageFailures.get(op.operationId)).toEqual(failure);
    expect(saves.operations.get(f.page.id)).toBe(op);
    expect(edits.has(f.page.id, seq)).toBe(true);
    // A later plain failure can neither clear nor reclassify the first latch.
    expect(retainOrdinaryPageFailure(saves, op, new Error("secondary /secret/path"))).toEqual(failure);
    expect(saves.storageFailures.get(op.operationId)).toEqual(failure);
    // A failure whose error carries nothing bounded becomes a safe local E.
    const other = operation("other-page", {title: "Other"});
    saves.operations.set("other-page", other);
    const fallback = retainOrdinaryPageFailure(saves, other, new Error("raw transport /secret"));
    expect(fallback).toMatchObject({kind: "UNCLASSIFIED", family: "REQUEST", requestType: "save:commit"});
    expect(JSON.stringify(saves)).not.toContain("secret");
  } finally {f.dispose();}
});

it("keeps a typed transport failure through a diagnostic-less resolve and clears only on applied proof", async () => {
  const f = saveFixture();
  try {
    const edits = new PendingEdits();
    const seq = edits.addObservedPage(f.page.id, f.page.revision, {title: "Held input"}, true);
    const op = operation(f.page.id, edits.patch(f.page.id, seq), seq);
    const saves = state();
    saves.operations.set(f.page.id, op);
    const session = {sessionId: op.sessionId, page: f.page};
    const failure = typed("save:commit");
    // The real reliable exchange preserves the bounded diagnostic and never
    // proves the write; the same operation stays pending.
    const refused = await sendReliableSave(op, async () => {throw new StorageFailureError(failure);});
    expect(refused.status).toBe("unknown");
    expect(refused.storageFailure).toEqual(failure);
    expect(settleOrdinaryPageSave(saves, op, refused, session))
      .toMatchObject({kind: "retained", outcome: "unknown", storageFailure: failure});
    expect(saves.operations.get(f.page.id)).toBe(op);
    expect(saves.storageFailures.get(op.operationId)).toEqual(failure);
    // A resolve that finds no receipt and carries no diagnostic keeps both the
    // operation and the first diagnostic; it never sends another commit.
    const queries: string[] = [];
    const plain = await resolveReliableSave(op, async (request) => {queries.push(request.type); return f.store.handle(request);});
    expect(queries).toEqual(["save:resolve"]);
    expect(plain.status).toBe("unknown");
    expect(plain.storageFailure).toBeUndefined();
    expect(settleOrdinaryPageSave(saves, op, plain, session))
      .toMatchObject({kind: "retained", storageFailure: failure});
    expect(saves.storageFailures.get(op.operationId)).toEqual(failure);
    expect(f.store.get(f.page.id).revision).toBe(0);
    // The exact applied proof clears operation and diagnostic together.
    expect(f.store.commitSave(op).status).toBe("applied");
    const applied = await resolveReliableSave(op, async (request) => f.store.handle(request));
    expect(applied.status).toBe("applied");
    expect(settleOrdinaryPageSave(saves, op, applied, session))
      .toMatchObject({kind: "applied", page: {revision: 1, title: "Held input"}});
    expect(saves.operations.size).toBe(0);
    expect(saves.storageFailures.size).toBe(0);
    edits.ack(f.page.id, seq);
    expect(edits.hasAny(f.page.id)).toBe(false);
  } finally {f.dispose();}
});

it("a verified business rejection clears operation and diagnostic under the original conditions", async () => {
  const f = saveFixture();
  try {
    const op = operation(f.page.id, {title: "Stale"});
    const saves = state();
    saves.operations.set(f.page.id, op);
    saves.storageFailures.set(op.operationId, typed("save:commit"));
    const session = {sessionId: op.sessionId, page: f.page};
    // The owner moved on; the real commit path returns a terminal rejection.
    f.store.update(f.page.id, 0, {title: "Changed elsewhere"});
    const rejected = await sendReliableSave(op, async (request) => f.store.handle(request));
    expect(rejected.status).toBe("rejected");
    expect(settleOrdinaryPageSave(saves, op, rejected, session)).toMatchObject({kind: "business-rejected"});
    expect(saves.operations.size).toBe(0);
    expect(saves.storageFailures.size).toBe(0);
    expect(f.store.get(f.page.id).title).toBe("Changed elsewhere");
  } finally {f.dispose();}
});

it("a mismatched applied ACK or invalid diagnostic keeps the operation pending", async () => {
  const f = saveFixture();
  try {
    const op = operation(f.page.id, {title: "Held"});
    const saves = state();
    saves.operations.set(f.page.id, op);
    const applied = f.store.commitSave(op);
    expect(applied.status).toBe("applied");
    // The session base moved on: the applied ACK cannot be verified against it.
    const staleSession = {sessionId: op.sessionId, page: {...f.page, revision: 7}};
    expect(settleOrdinaryPageSave(saves, op, {...applied}, staleSession))
      .toMatchObject({kind: "retained", outcome: "mismatch"});
    expect(saves.operations.get(f.page.id)).toBe(op);
    // A result carrying a malformed diagnostic field latches nothing new.
    const corrupt = {...applied,
      storageFailure: {kind: "UNCLASSIFIED"}} as unknown as SaveResult;
    expect(settleOrdinaryPageSave(saves, op, corrupt, staleSession)).toMatchObject({kind: "retained"});
    expect(saves.storageFailures.size).toBe(0);
    expect(saves.operations.get(f.page.id)).toBe(op);
  } finally {f.dispose();}
});

it("a contradictory terminal ACK carrying a diagnostic can never clear the operation", async () => {
  const f = saveFixture();
  try {
    const op = operation(f.page.id, {title: "Held"});
    const saves = state();
    saves.operations.set(f.page.id, op);
    const first = typed("save:commit");
    saves.storageFailures.set(op.operationId, first);
    const session = {sessionId: op.sessionId, page: f.page};
    const fingerprint = await operationFingerprint(op);
    // Even a fully verified applied or rejected wire that still carries its
    // own failure metadata is contradictory: it is retained as unknown and
    // can neither remove the operation nor reclassify the first diagnostic.
    for (const status of ["applied", "rejected"] as const) {
      const carried = {status, operationId: op.operationId, sessionId: op.sessionId,
        seq: op.seq, pageId: op.pageId, fingerprint,
        ...(status === "applied" ? {page: {...f.page, revision: 1, title: "Held"}} : {}),
        storageFailure: typed("save:commit")} as SaveResult;
      expect(settleOrdinaryPageSave(saves, op, carried, session), status)
        .toMatchObject({kind: "retained", outcome: "unknown", storageFailure: first});
      expect(saves.operations.get(f.page.id), status).toBe(op);
      expect(saves.storageFailures.get(op.operationId), status).toEqual(first);
    }
    // The same terminals through the real exchange normalize to the bounded
    // local E before they can even reach the helper.
    const applied = f.store.commitSave(op);
    const viaWire = await sendReliableSave(op, async () => ({...applied, storageFailure: typed("save:commit")}) as SaveResult);
    expect(viaWire.status).toBe("unknown");
    expect(settleOrdinaryPageSave(saves, op, viaWire, session))
      .toMatchObject({kind: "retained", storageFailure: first});
    // A verified business rejection without a diagnostic keeps its original
    // clear meaning under the same conditions as before.
    const op2 = operation(f.page.id, {title: "Stale"});
    saves.operations.set(f.page.id, op2);
    f.store.update(f.page.id, 1, {title: "Elsewhere"});
    const rejected = await sendReliableSave(op2, async (request) => f.store.handle(request));
    expect(rejected.status).toBe("rejected");
    expect(settleOrdinaryPageSave(saves, op2, rejected, session)).toMatchObject({kind: "business-rejected"});
    expect(saves.operations.size).toBe(0);
    expect(saves.storageFailures.has(op2.operationId)).toBe(false);
    // The contradictory-terminal operation stays retained with its own
    // diagnostic until an applied proof arrives.
    expect(saves.storageFailures.get(op.operationId)).toEqual(first);
  } finally {f.dispose();}
});

it("a stale callback can neither latch nor settle another operation's state", () => {
  const f = saveFixture();
  try {
    const saves = state();
    const current = operation(f.page.id, {title: "Current"});
    const stale = operation(f.page.id, {title: "Stale callback"});
    saves.operations.set(f.page.id, current);
    const session = {sessionId: current.sessionId, page: f.page};
    expect(retainOrdinaryPageFailure(saves, stale, new StorageFailureError(typed("save:commit")))).toBeUndefined();
    expect(settleOrdinaryPageSave(saves, stale,
      {status: "unknown", operationId: stale.operationId, sessionId: stale.sessionId, seq: stale.seq,
        pageId: stale.pageId, fingerprint: "x".repeat(64)}, session)).toEqual({kind: "stale"});
    expect(saves.storageFailures.size).toBe(0);
    expect(saves.operations.get(f.page.id)).toBe(current);
  } finally {f.dispose();}
});
