import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { commitDatabaseOperation } from "../src/persistence/database-operations";
import { prepareDatabaseCreation, type DatabaseOperation } from "../src/shared/database-operation";
import { operationFingerprint } from "../src/shared/save-contract";
import { emptyDatabase, type DatabaseSettings } from "../src/shared/types";
import { sendDatabaseOperation, resolveDatabaseOperation as resolveRemote } from "../src/renderer/reliable-database-operation";
import {
  retainDatabaseCreationFailure,
  settleDatabaseCreation,
  type DatabaseCreationPending,
} from "../src/renderer/database-creation-state";
import { StorageFailureError, storageFailureMessageV1 } from "../src/renderer/private-request";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";

const local = (overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 => ({
  version: 1, kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST", failureSubject: "UNIDENTIFIED",
  mutationDispatch: "UNPROVEN", proofOrigin: "NONE", requestType: "database:commit", sourceOutcome: null,
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
  sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"], causeSummaryIncomplete: false, attemptId: "b".repeat(32)});

function fixture() {
  const root = mkdtempSync(resolve("output/u7-database-creation-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const {rows: _rows, ...settings} = emptyDatabase();
  const dbSettings: DatabaseSettings = {...settings, properties: [
    {id: "note", name: "メモ", type: "text"}, {id: "estimate", name: "見積", type: "number"},
    {id: "done", name: "完了", type: "checkbox"}]};
  const pending = (operation: DatabaseOperation): DatabaseCreationPending => ({operation, state: "saving"});
  return {root, store, settings: dbSettings, pending,
    dispose() {store.close(); rmSync(root, {recursive: true, force: true});}};
}

it("App wires the production database-creation state for the standalone slot", () => {
  const source = readFileSync(resolve("src/renderer/App.tsx"), "utf8");
  expect(source).toContain('from "./database-creation-state"');
  expect(source).toContain("settleDatabaseCreation(pending, result)");
  expect(source).toContain("retainDatabaseCreationFailure(databaseCreation.current, operation, error)");
  // The recovery snapshot still exports only the operation, never the diagnostic.
  expect(source).toContain("snapshot.creations.push(databaseCreation.current.operation)");
});

it("a failed checkpoint before dispatch keeps the same operation unknown with its diagnostic", () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Tasks", null, f.settings);
    const pending = f.pending(operation);
    const failure = checkpoint();
    expect(retainDatabaseCreationFailure(pending, operation, new StorageFailureError(failure))).toEqual(failure);
    expect(pending).toMatchObject({state: "unknown", storageFailure: failure});
    expect(pending.error).toBe(storageFailureMessageV1(failure));
    // The same operation stays pending; nothing else was created or resent.
    expect(pending.operation).toBe(operation);
    // A stale slot for another operation touches nothing.
    const stale = prepareDatabaseCreation("Stale", null, f.settings);
    expect(retainDatabaseCreationFailure(pending, stale, new StorageFailureError(typed("database:commit")))).toBeUndefined();
    expect(pending).toMatchObject({state: "unknown", storageFailure: failure});
    // A later plain failure keeps the first valid diagnostic.
    expect(retainDatabaseCreationFailure(pending, operation, new Error("raw /secret"))).toEqual(failure);
    expect(pending.storageFailure).toEqual(failure);
  } finally {f.dispose();}
});

it("a typed transport failure keeps the pending slot unknown until applied proof", async () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Tasks", null, f.settings);
    const pending = f.pending(operation);
    const failure = typed("database:commit");
    const refused = await sendDatabaseOperation(operation, async () => {throw new StorageFailureError(failure);});
    expect(refused.status).toBe("unknown");
    expect(refused.storageFailure).toEqual(failure);
    expect(settleDatabaseCreation(pending, refused)).toMatchObject({kind: "retained", storageFailure: failure});
    expect(pending).toMatchObject({state: "unknown", storageFailure: failure, operation});
    expect(f.store.pages()).toHaveLength(0);
    // A diagnostic-less resolve keeps operation and first diagnostic.
    const queries: string[] = [];
    const plain = await resolveRemote(operation, async (request) => {queries.push(request.type); return f.store.handle(request);});
    expect(queries).toEqual(["database:resolve"]);
    expect(plain.status).toBe("unknown");
    expect(settleDatabaseCreation(pending, plain)).toMatchObject({kind: "retained", storageFailure: failure});
    expect(pending.storageFailure).toEqual(failure);
    // The operation is never regenerated or resent; only the exact applied
    // proof hands the created page back for the caller's completion flow.
    expect(commitDatabaseOperation(f.store, operation).status).toBe("applied");
    const applied = await resolveRemote(operation, async (request) => f.store.handle(request));
    const settled = settleDatabaseCreation(pending, applied);
    expect(settled).toMatchObject({kind: "applied", page: {title: "Tasks", kind: "database"}});
    expect(f.store.pages()).toHaveLength(1);
    // A result for another operation is stale and touches nothing.
    expect(settleDatabaseCreation(pending, {...applied, operationId: "other-id"})).toEqual({kind: "stale"});
  } finally {f.dispose();}
});

it("a contradictory terminal receipt carrying a diagnostic keeps the slot unknown", async () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Tasks", null, f.settings);
    const pending = f.pending(operation);
    const first = checkpoint();
    pending.storageFailure = first;
    pending.state = "unknown";
    const applied = commitDatabaseOperation(f.store, operation);
    // Applied or rejected carrying its own failure metadata is contradictory:
    // the slot stays unknown and the first latched diagnostic always wins.
    for (const carried of [{...applied, storageFailure: typed("database:commit")},
      {...applied, status: "rejected" as const, storageFailure: typed("database:commit")}]) {
      expect(settleDatabaseCreation(pending, carried)).toMatchObject({kind: "retained", storageFailure: first});
      expect(pending).toMatchObject({state: "unknown", storageFailure: first, operation});
      expect(pending.error).toBe(storageFailureMessageV1(first));
    }
    // Through the real exchange the same contradiction is already a bounded
    // local E; the slot still keeps its first diagnostic and pending input.
    const viaWire = await sendDatabaseOperation(operation, async () => ({...applied, storageFailure: typed("database:commit")}));
    expect(viaWire.status).toBe("unknown");
    expect(settleDatabaseCreation(pending, viaWire)).toMatchObject({kind: "retained", storageFailure: first});
    expect(pending.operation).toBe(operation);
    // An unknown resolve carrying no diagnostic keeps the fixed safe text;
    // a carrier message is never shown.
    expect(settleDatabaseCreation(pending, {...viaWire, storageFailure: undefined, message: "raw /secret"}))
      .toMatchObject({kind: "retained", storageFailure: first});
    expect(pending.error).toBe(storageFailureMessageV1(first));
    expect(pending.error).not.toContain("secret");
  } finally {f.dispose();}
});

it("an unknown resolve without any diagnostic or latch shows only the fixed safe text", async () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Tasks", null, f.settings);
    const pending = f.pending(operation);
    const raw = await sendDatabaseOperation(operation, async () => ({status: "unknown",
      operationId: operation.operationId, sessionId: operation.sessionId, seq: operation.seq,
      commandKind: operation.command.kind, fingerprint: await operationFingerprint(operation),
      message: "raw /secret/carrier"}));
    expect(raw.status).toBe("unknown");
    expect(raw.storageFailure).toBeUndefined();
    expect(settleDatabaseCreation(pending, raw)).toMatchObject({kind: "retained", storageFailure: undefined});
    expect(pending.state).toBe("unknown");
    expect(pending.error).toContain("画面内に未保存入力を保持しています。新しい保存は確認できていません。");
    expect(pending.error).not.toContain("secret");
  } finally {f.dispose();}
});

it("a verified business rejection keeps its original meaning and no diagnostic is invented", async () => {
  const f = fixture();
  try {
    const operation = prepareDatabaseCreation("Invalid", "missing-parent", f.settings);
    const pending = f.pending(operation);
    const rejected = await sendDatabaseOperation(operation, async (request) => f.store.handle(request));
    expect(rejected.status).toBe("rejected");
    expect(settleDatabaseCreation(pending, rejected)).toEqual({kind: "business-rejected"});
    expect(pending).toMatchObject({state: "rejected"});
    expect(pending.storageFailure).toBeUndefined();
    expect(f.store.pages()).toHaveLength(0);
    // The pending slot is the only diagnostic home: the operation itself is
    // exactly what the recovery snapshot's creations list would serialize.
    expect(JSON.stringify(pending.operation)).not.toContain("storageFailure");
  } finally {f.dispose();}
});
