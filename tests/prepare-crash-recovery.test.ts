import { expect, it, vi } from "vitest";
import { prepareCrashRecovery } from "../src/renderer/prepare-crash-recovery";
import { emptyCrashRecoverySnapshot, type CrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { operationFingerprint } from "../src/shared/save-contract";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import type { Request } from "../src/shared/types";
import { saveFixture } from "./fixtures/r4-save-fixture";

type Fixture = ReturnType<typeof saveFixture>;
function storeApi(f: Fixture, requests: Request[]) {
  return async <T>(request: Request): Promise<T> => {requests.push(structuredClone(request)); return f.store.handle(request) as T;};
}
function pageInput(f: Fixture, record = false): CrashRecoverySnapshot {
  const operation = f.operation(record), base = record ? f.store.get(f.record.pageId) : f.page;
  const entry = {sessionId: operation.sessionId, base, seq: 1, intents: [{seq: 1, patch: operation.patch}], operation,
    ...(record ? {record: f.record} : {})};
  return {...emptyCrashRecoverySnapshot(), ...(record ? {records: [entry]} : {pages: [entry]})};
}

it("prepares an ordinary Page after lost COMMIT ACK and retains only later input without writing it", async () => {
  const f = saveFixture();
  try {
    const input = pageInput(f), entry = input.pages[0], operation = entry.operation!;
    expect(f.store.commitSave(operation).status).toBe("applied");
    entry.seq = 2;
    entry.intents.push({seq: 2, patch: {title: "Later unsaved title", doc: {type: "doc", content: [
      {type: "paragraph", content: [{type: "text", text: "After the lost ACK"}]},
    ]}}});
    const original = structuredClone(input), requests: Request[] = [];
    const prepared = await prepareCrashRecovery(input, storeApi(f, requests));
    expect(requests.map((request) => request.type)).toEqual(["save:resolve", "load"]);
    expect(prepared.pages[0]).toMatchObject({sessionId: entry.sessionId, seq: 2, base: {revision: 1, title: "After"},
      intents: [{seq: 2, patch: {title: "Later unsaved title"}}]});
    expect(prepared.pages[0].operation).toBeUndefined();
    expect(input).toEqual(original);
    expect(f.store.get(entry.base.id)).toMatchObject({revision: 1, title: "After"});
  } finally {f.dispose();}
});

it.each(["page", "record", "database", "creation", "migration", "property"] as const)(
  "keeps an unknown %s operation query-only and preserves its original identity", async (family) => {
    const f = saveFixture();
    try {
      let input = emptyCrashRecoverySnapshot();
      if (family === "page" || family === "record") input = pageInput(f, family === "record");
      else if (family === "creation") input.creations.push(prepareDatabaseCreation("Pending creation"));
      else if (family === "database") {
        const coordinator = new DatabaseSessionCoordinator(async (request) => f.store.handle(request));
        const handle = coordinator.attach(f.owner, f.repo.databaseProjection(f.owner.id));
        coordinator.editPage(handle, {title: "Pending owner title"});
        const entry = coordinator.exportRecovery()[0];
        entry.operation = {operationId: "database-operation", sessionId: entry.sessionId, seq: entry.seq,
          command: {kind: "updateDatabase", databasePageId: entry.base.id, revision: entry.base.revision,
            patch: {title: "Pending owner title"}, settings: entry.projection.settings}};
        input.databases.push(entry);
      } else {
        const identity = {operationId: `${family}-operation`, sessionId: `${family}-session`, seq: 1};
        const operation = family === "migration" ? {...identity, databasePageId: f.owner.id, revision: f.owner.revision,
          sourceFingerprint: "0".repeat(64)} : {...identity, command: {databasePageId: f.owner.id, revision: f.owner.revision,
          change: {kind: "rename", propertyId: "note", name: "Renamed"},
          recordRevisions: [{pageId: f.record.pageId, revision: 0}], previewHash: "0".repeat(64)}};
        input.externalOperations.push({family, operation});
      }
      const requests: Request[] = [], original = structuredClone(input);
      const api = async <T>(request: Request): Promise<T> => {
        requests.push(structuredClone(request));
        if (request.type === "save:resolve" || request.type === "database:resolve") return f.store.handle(request) as T;
        const operation = (request as unknown as {operation: {operationId: string; sessionId: string; seq: number}}).operation;
        return {status: "unknown", operationId: operation.operationId, sessionId: operation.sessionId, seq: operation.seq,
          databasePageId: f.owner.id, fingerprint: await operationFingerprint(operation), message: "Receipt absent"} as T;
      };
      vi.stubGlobal("window", {folio: {request: api}});
      await expect(prepareCrashRecovery(input, api)).rejects.toThrow();
      const expected = family === "page" || family === "record" ? "save:resolve" : family === "database" || family === "creation" ? "database:resolve" : `${family}:resolve`;
      expect(requests.map((request) => request.type)).toEqual([expected]);
      expect(requests.every((request) => !request.type.endsWith(":commit"))).toBe(true);
      expect(input).toEqual(original);
      expect(f.store.get(f.page.id).revision).toBe(0);
      expect(f.store.get(f.owner.id).title).toBe("Tasks");
    } finally {vi.unstubAllGlobals(); f.dispose();}
  },
);

it("rejects a newer source after resolving an older committed receipt and does not overwrite either input", async () => {
  const f = saveFixture();
  try {
    const input = pageInput(f), original = structuredClone(input), requests: Request[] = [];
    f.store.commitSave(input.pages[0].operation!);
    f.store.update(f.page.id, 1, {title: "Newer source"});
    await expect(prepareCrashRecovery(input, storeApi(f, requests))).rejects.toThrow(/変更/);
    expect(requests.map((request) => request.type)).toEqual(["save:resolve", "load"]);
    expect(f.store.get(f.page.id)).toMatchObject({revision: 2, title: "Newer source"});
    expect(input).toEqual(original);
  } finally {f.dispose();}
});

it("refuses unverified input before any IPC, including otherwise resolvable operations", async () => {
  const f = saveFixture();
  try {
    const input = {...pageInput(f), unverifiedInputs: [{reason: "stale callback", input: {
      id: f.page.id, seq: 99, observedKnown: false, observedRevision: 0, patch: {title: "Unbound"},
    }}]};
    const requests: Request[] = [];
    await expect(prepareCrashRecovery(input, storeApi(f, requests))).rejects.toThrow(/編集画面/);
    expect(requests).toEqual([]);
    expect(input.unverifiedInputs[0].input.observedKnown).toBe(false);
  } finally {f.dispose();}
});

it("rejects an orphan raw numeric input instead of inventing its record base", async () => {
  const f = saveFixture();
  try {
    const input = {...emptyCrashRecoverySnapshot(), rawDrafts: [{scope: "record" as const, pageId: f.record.pageId, key: "count", value: "1e"}]};
    const original = structuredClone(input), requests: Request[] = [];
    await expect(prepareCrashRecovery(input, storeApi(f, requests))).rejects.toThrow(/保存元/);
    expect(requests.map((request) => request.type)).toEqual(["load"]);
    expect(input).toEqual(original);
    expect(f.repo.projection(f.record.pageId).values.count).toBe(1);
  } finally {f.dispose();}
});

it("validates the bound record before returning its raw number text for restoration", async () => {
  const f = saveFixture();
  try {
    const input = {...emptyCrashRecoverySnapshot(), records: [{sessionId: "raw-session", base: f.store.get(f.record.pageId),
      record: f.record, seq: 0, intents: []}], rawDrafts: [{scope: "record" as const, pageId: f.record.pageId, key: "count", value: "-"}]};
    const requests: Request[] = [], prepared = await prepareCrashRecovery(input, storeApi(f, requests));
    expect(requests.map((request) => request.type)).toEqual(["load", "record:read"]);
    expect(prepared.rawDrafts).toEqual(input.rawDrafts);
    expect(prepared.records[0].base.revision).toBe(0);
  } finally {f.dispose();}
});
