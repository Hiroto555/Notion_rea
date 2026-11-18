import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { prepareCrashRecovery } from "../src/renderer/prepare-crash-recovery";
import { createPurposeBridges } from "../src/renderer/purpose-bridge";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import {
  privateRequestFailureReply,
  privateRequestSuccessReply,
} from "../src/main/private-request-envelope";
import { unclassifiedRequestFailure } from "../src/renderer/private-request";
import {
  commitPropertyOperation,
  previewPropertyOperation,
  resolvePropertyOperation,
} from "../src/persistence/property-operations";
import { resolveLegacyMigration } from "../src/persistence/legacy-migration-operation";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import type { DatabaseOperationResult } from "../src/shared/database-operation";
import { preparePageCreation } from "../src/shared/page-operation";
import { preparePropertyOperation } from "../src/shared/property-operation";
import {
  emptyCrashRecoverySnapshot,
  type CrashRecoverySnapshot,
  type DatabaseSessionRecovery,
  type EditSessionRecovery,
} from "../src/shared/crash-recovery";
import { versionDocument } from "../src/shared/rich-document";
import type { EditingPort, StructurePort } from "../src/shared/app-api";
import type { Request } from "../src/shared/types";
import { saveFixture } from "./fixtures/r4-save-fixture";

type Fixture = ReturnType<typeof saveFixture>;

function diagnosticLane(
  f: Fixture,
  held: () => Error | null = () => null,
  overrides: {resolveSave?: EditingPort["resolveSave"]} = {},
) {
  const sent: Request[] = [];
  const editingCalls: string[] = [];
  const structureCalls: string[] = [];
  const readCalls: string[] = [];
  const invoke = async (request: Request) => {
    sent.push(structuredClone(request));
    try {
      let value: unknown;
      switch (request.type) {
        case "load":
        case "save:resolve":
        case "database:resolve":
        case "page:resolve":
        case "record:read":
        case "database:read":
          value = f.store.handle(request);
          break;
        default:
          throw new Error(`unexpected ${request.type}`);
      }
      return privateRequestSuccessReply({value, requestType: request.type});
    } catch (original) {
      return privateRequestFailureReply({original, requestType: request.type});
    }
  };
  const bindings = createDesktopRootBindings({
    requestDiagnostic: createPrivateRequestPreload(invoke).requestDiagnostic,
  });
  const editing: EditingPort = {
    commitSave: async (operation) => {
      editingCalls.push("commitSave");
      return f.store.handle({type: "save:commit", operation}) as never;
    },
    resolveSave: async (operation) => {
      editingCalls.push(`resolveSave:${operation.databasePageId === null ? "page" : "record"}`);
      if (overrides.resolveSave) return overrides.resolveSave(operation);
      return f.store.handle({type: "save:resolve", operation}) as never;
    },
    commitDatabase: async (operation) => {
      editingCalls.push("commitDatabase");
      return f.store.handle({type: "database:commit", operation}) as never;
    },
    resolveDatabase: async (operation) => {
      editingCalls.push(`resolveDatabase:${operation.command.kind}`);
      return f.store.handle({type: "database:resolve", operation}) as never;
    },
  };
  const unused = async () => {
    throw new Error("unused structural port");
  };
  const structure: StructurePort = {
    previewMigration: unused,
    previewProperty: unused,
    commitMigration: unused,
    resolveMigration: async (operation) => {
      structureCalls.push("resolveMigration");
      return resolveLegacyMigration(f.store, operation);
    },
    commitProperty: async (operation) => {
      structureCalls.push("commitProperty");
      return commitPropertyOperation(f.store, operation);
    },
    resolveProperty: async (operation) => {
      structureCalls.push("resolveProperty");
      return resolvePropertyOperation(f.store, operation);
    },
  };
  const bridges = createPurposeBridges({editing, structure});
  return {
    sent,
    editingCalls,
    structureCalls,
    readCalls,
    ports: {
      recordSend: (request: Request) => {
        const error = held();
        if (error) throw error;
        return bridges.save(request);
      },
      databaseSend: (request: Request) => {
        const error = held();
        if (error) throw error;
        return bridges.database(request);
      },
      structuralSend: (request: Request) => {
        const error = held();
        if (error) throw error;
        return bridges.structural(request);
      },
      readRecord: (pageId: string) => {
        const error = held();
        if (error) throw error;
        readCalls.push(`record:${pageId}`);
        return bindings.writable.workspace.readRecord(pageId);
      },
      readDatabase: (databasePageId: string) => {
        const error = held();
        if (error) throw error;
        readCalls.push(`database:${databasePageId}`);
        return bindings.writable.workspace.readDatabase(databasePageId);
      },
    },
    api: async <T>(request: Request): Promise<T> => {
      const error = held();
      if (error) throw error;
      return bindings.compatibility.request<T>(request);
    },
  };
}

function recoveryFixture() {
  const f = saveFixture();
  const richDoc = versionDocument({
    type: "doc",
    content: [
      {
        type: "callout",
        attrs: {id: "phase-c-callout", tone: "warning"},
        content: [
          {
            type: "paragraph",
            attrs: {id: "phase-c-text"},
            content: [{type: "text", text: "復旧しても原文を保持する"}],
          },
        ],
      },
    ],
  });
  const laterDoc = structuredClone(richDoc);
  laterDoc.content![0].attrs!.tone = "tip";

  const pageBase = f.page;
  const recordBasePage = f.store.get(f.record.pageId);
  const recordBaseProjection = f.record;
  const pageSaveOperation = f.operation(false);
  const recordSaveOperation = {...f.operation(true), patch: {title: "After", doc: richDoc}};
  expect(f.store.commitSave(pageSaveOperation).status).toBe("applied");
  expect(f.store.commitSave(recordSaveOperation).status).toBe("applied");

  const pageCreateOperation = preparePageCreation("Recovered ordinary", null);
  expect(f.store.commitPageOperation(pageCreateOperation).status).toBe("applied");

  const {rows: _ownerRows, ...ownerSettings} = f.owner.database!;
  const creationOperation = prepareDatabaseCreation("Recovered DB", null, ownerSettings);
  const created = f.store.handle({type: "database:commit", operation: creationOperation}) as DatabaseOperationResult;
  expect(created.status).toBe("applied");
  const databaseBase = created.page!;
  const databaseProjection = created.database!;
  const databaseUpdateOperation = {
    operationId: crypto.randomUUID(),
    sessionId: "phase-c-database-session",
    seq: 1,
    command: {
      kind: "updateDatabase" as const,
      databasePageId: databaseBase.id,
      revision: databaseBase.revision,
      patch: {title: "Recovered DB title"},
      settings: databaseProjection.settings,
    },
  };
  const databaseUpdated = f.store.handle({type: "database:commit", operation: databaseUpdateOperation}) as DatabaseOperationResult;
  expect(databaseUpdated.status).toBe("applied");

  const ownerNow = f.store.get(f.owner.id);
  const preview = previewPropertyOperation(f.store, {
    type: "property:preview",
    databasePageId: f.owner.id,
    revision: ownerNow.revision,
    change: {kind: "rename", propertyId: "note", name: "Renamed note"},
  });
  expect(preview.ok).toBe(true);
  const propertyOperation = preparePropertyOperation(preview.command!);
  expect(commitPropertyOperation(f.store, propertyOperation).status).toBe("applied");

  const pageEntry: EditSessionRecovery = {
    sessionId: pageSaveOperation.sessionId,
    base: pageBase,
    seq: 1,
    intents: [{seq: 1, patch: pageSaveOperation.patch}],
    operation: pageSaveOperation,
  };
  const recordEntry: EditSessionRecovery = {
    sessionId: recordSaveOperation.sessionId,
    base: recordBasePage,
    record: recordBaseProjection,
    seq: 2,
    intents: [
      {seq: 1, patch: recordSaveOperation.patch},
      {seq: 2, patch: {title: "Later record", doc: laterDoc}},
    ],
    operation: recordSaveOperation,
  };
  const databaseEntry: DatabaseSessionRecovery = {
    sessionId: databaseUpdateOperation.sessionId,
    base: databaseBase,
    projection: databaseProjection,
    seq: 1,
    intents: [{kind: "page", seq: 1, patch: {title: "Recovered DB title"}}],
    operation: databaseUpdateOperation,
  };
  const snapshot: CrashRecoverySnapshot = {
    ...emptyCrashRecoverySnapshot(),
    pages: [pageEntry],
    records: [recordEntry],
    databases: [databaseEntry],
    creations: [creationOperation],
    rawDrafts: [
      {scope: "record", pageId: recordBasePage.id, key: "count", value: "1e"},
      {scope: "database", pageId: databaseBase.id, key: JSON.stringify(["view", "filter"]), value: "1e"},
    ],
    externalOperations: [{family: "property", operation: propertyOperation}],
    pageOperations: [pageCreateOperation],
  };
  return {
    f,
    snapshot,
    richDoc,
    laterDoc,
    recordPageId: recordBasePage.id,
    databasePageId: databaseBase.id,
    ownerId: f.owner.id,
  };
}

describe("prepareCrashRecovery purpose ports", () => {
  it("routes all six DB touchpoints through purpose ports while ordinary lanes stay on compat", async () => {
    const {f, snapshot, richDoc, recordPageId, databasePageId} = recoveryFixture();
    try {
      const lane = diagnosticLane(f);
      const original = structuredClone(snapshot);
      const prepared = await prepareCrashRecovery(snapshot, lane.api, lane.ports);
      expect(snapshot).toEqual(original);
      expect(prepared.creations).toEqual([]);
      expect(prepared.externalOperations).toEqual([]);
      expect(prepared.pageOperations).toEqual([]);
      expect(prepared.pages[0].operation).toBeUndefined();
      expect(prepared.records[0].operation).toBeUndefined();
      expect(prepared.databases[0].operation).toBeUndefined();
      expect(prepared.records[0].intents).toEqual([snapshot.records[0].intents[1]]);
      expect(prepared.records[0].base.doc).toEqual(richDoc);
      expect(prepared.databases[0].base.title).toBe("Recovered DB title");
      expect(prepared.rawDrafts).toEqual(snapshot.rawDrafts);
      expect(lane.editingCalls).toEqual([
        "resolveDatabase:createDatabase",
        "resolveSave:record",
        "resolveDatabase:updateDatabase",
      ]);
      expect(lane.structureCalls).toEqual(["resolveProperty"]);
      expect(lane.readCalls).toEqual([`record:${recordPageId}`, `database:${databasePageId}`]);
      expect(lane.sent.map((request) => request.type)).toEqual([
        "page:resolve",
        "save:resolve",
        "load",
        "record:read",
        "database:read",
      ]);
      expect(lane.sent.some((request) => request.type.endsWith(":commit"))).toBe(false);
      const pageSave = lane.sent.find((request): request is Extract<Request, {type: "save:resolve"}> => request.type === "save:resolve");
      expect(pageSave?.operation.databasePageId).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it("keeps omitted ports on the generic lane and rejects partial bundles before any query", async () => {
    const {f, snapshot} = recoveryFixture();
    try {
      const lane = diagnosticLane(f);
      const legacyInput: CrashRecoverySnapshot = {
        ...snapshot,
        pages: [],
        pageOperations: [],
        externalOperations: [],
      };
      const prepared = await prepareCrashRecovery(legacyInput, lane.api);
      expect(prepared.records[0].operation).toBeUndefined();
      expect(prepared.databases[0].operation).toBeUndefined();
      expect(lane.editingCalls).toEqual([]);
      expect(lane.structureCalls).toEqual([]);
      expect(lane.sent.map((request) => request.type)).toEqual([
        "database:resolve",
        "save:resolve",
        "database:resolve",
        "load",
        "record:read",
        "database:read",
      ]);

      const invalid = [
        null,
        {},
        {...lane.ports, recordSend: 1},
        {...lane.ports, readDatabase: undefined},
      ];
      for (const ports of invalid) {
        const fresh = diagnosticLane(f);
        await expect(prepareCrashRecovery(snapshot, fresh.api, ports as never)).rejects.toThrow();
        expect(fresh.sent).toEqual([]);
        expect(fresh.editingCalls).toEqual([]);
        expect(fresh.structureCalls).toEqual([]);
        expect(fresh.readCalls).toEqual([]);
      }
    } finally {
      f.dispose();
    }
  });

  it("re-reads the latch after each helper fingerprint await so a held send invokes nothing", async () => {
    const record = recoveryFixture();
    try {
      let held: Error | null = null;
      const lane = diagnosticLane(record.f, () => held);
      const input: CrashRecoverySnapshot = {...emptyCrashRecoverySnapshot(), records: [record.snapshot.records[0]]};
      const pending = prepareCrashRecovery(input, lane.api, lane.ports);
      held = new Error("latched during record fingerprint");
      await expect(pending).rejects.toThrow();
      expect(lane.editingCalls).toEqual([]);
      expect(lane.sent).toEqual([]);
      expect(lane.readCalls).toEqual([]);
      held = null;
      const prepared = await prepareCrashRecovery(input, lane.api, lane.ports);
      expect(prepared.records[0].operation).toBeUndefined();
      expect(lane.editingCalls).toEqual(["resolveSave:record"]);
      expect(lane.sent.map((request) => request.type)).toEqual(["load", "record:read"]);
    } finally {
      record.f.dispose();
    }

    const database = recoveryFixture();
    try {
      let held: Error | null = null;
      const lane = diagnosticLane(database.f, () => held);
      const input: CrashRecoverySnapshot = {...emptyCrashRecoverySnapshot(), creations: [database.snapshot.creations[0]]};
      const pending = prepareCrashRecovery(input, lane.api, lane.ports);
      held = new Error("latched during database fingerprint");
      await expect(pending).rejects.toThrow();
      expect(lane.editingCalls).toEqual([]);
      expect(lane.sent).toEqual([]);
      held = null;
      const prepared = await prepareCrashRecovery(input, lane.api, lane.ports);
      expect(prepared.creations).toEqual([]);
      expect(lane.editingCalls).toEqual(["resolveDatabase:createDatabase"]);
      expect(lane.sent.map((request) => request.type)).toEqual(["load"]);
    } finally {
      database.f.dispose();
    }

    const structural = recoveryFixture();
    try {
      let held: Error | null = null;
      const lane = diagnosticLane(structural.f, () => held);
      const input: CrashRecoverySnapshot = {...emptyCrashRecoverySnapshot(), externalOperations: structural.snapshot.externalOperations};
      const pending = prepareCrashRecovery(input, lane.api, lane.ports);
      held = new Error("latched during structural fingerprint");
      await expect(pending).rejects.toThrow(/latched during structural fingerprint|確認/);
      expect(lane.structureCalls).toEqual([]);
      expect(lane.sent).toEqual([]);
      held = null;
      const prepared = await prepareCrashRecovery(input, lane.api, lane.ports);
      expect(prepared.externalOperations).toEqual([]);
      expect(lane.structureCalls).toEqual(["resolveProperty"]);
      expect(lane.sent.map((request) => request.type)).toEqual(["load"]);
    } finally {
      structural.f.dispose();
    }
  });

  it("blocks fresh record and database reads when the latch lands after load", async () => {
    for (const kind of ["record", "database"] as const) {
      const {f, snapshot, recordPageId, databasePageId} = recoveryFixture();
      try {
        let held: Error | null = null;
        const lane = diagnosticLane(f, () => held);
        const input: CrashRecoverySnapshot = kind === "record"
          ? {...emptyCrashRecoverySnapshot(), records: [snapshot.records[0]]}
          : {...emptyCrashRecoverySnapshot(), databases: [snapshot.databases[0]]};
        const api = async <T>(request: Request): Promise<T> => {
          const result = await lane.api<T>(request);
          if (request.type === "load") held = new Error("latched after load");
          return result;
        };
        await expect(prepareCrashRecovery(input, api, lane.ports)).rejects.toThrow("latched after load");
        expect(lane.readCalls).toEqual([]);
        expect(lane.sent.map((request) => request.type)).toEqual(["load"]);
        expect(lane.editingCalls).toEqual(kind === "record" ? ["resolveSave:record"] : ["resolveDatabase:updateDatabase"]);
        expect(recordPageId).toBeTruthy();
        expect(databasePageId).toBeTruthy();
      } finally {
        f.dispose();
      }
    }
  });

  it("rejects and preserves input when a fresh record or database source moved", async () => {
    const record = recoveryFixture();
    try {
      record.f.store.updateRecordPage(record.recordPageId, record.ownerId, 1, {title: "Changed after receipt"});
      const lane = diagnosticLane(record.f);
      const input: CrashRecoverySnapshot = {...emptyCrashRecoverySnapshot(), records: [record.snapshot.records[0]]};
      const original = structuredClone(input);
      await expect(prepareCrashRecovery(input, lane.api, lane.ports)).rejects.toThrow(/変更|一致/);
      expect(lane.readCalls).toEqual([`record:${record.recordPageId}`]);
      expect(lane.sent.map((request) => request.type)).toEqual(["load", "record:read"]);
      expect(input).toEqual(original);
    } finally {
      record.f.dispose();
    }

    const database = recoveryFixture();
    try {
      database.f.store.update(database.databasePageId, 1, {title: "Changed owner"});
      const lane = diagnosticLane(database.f);
      const input: CrashRecoverySnapshot = {...emptyCrashRecoverySnapshot(), databases: [database.snapshot.databases[0]]};
      const original = structuredClone(input);
      await expect(prepareCrashRecovery(input, lane.api, lane.ports)).rejects.toThrow(/変更|一致/);
      expect(lane.readCalls).toEqual([`database:${database.databasePageId}`]);
      expect(lane.sent.map((request) => request.type)).toEqual(["load", "database:read"]);
      expect(input).toEqual(original);
    } finally {
      database.f.dispose();
    }
  });

  it("keeps an unknown record receipt query-only and preserves later input", async () => {
    const {f, recordPageId, ownerId} = recoveryFixture();
    try {
      const currentPage = f.store.get(recordPageId);
      const currentRecord = f.repo.projection(recordPageId);
      const operation = {...f.operation(true), revision: currentPage.revision, patch: {title: "Unknown title"}};
      const entry: EditSessionRecovery = {
        sessionId: operation.sessionId,
        base: currentPage,
        record: currentRecord,
        seq: 2,
        intents: [
          {seq: 1, patch: operation.patch},
          {seq: 2, patch: {title: "Later unknown"}},
        ],
        operation,
      };
      const input: CrashRecoverySnapshot = {...emptyCrashRecoverySnapshot(), records: [entry]};
      const original = structuredClone(input);
      const lane = diagnosticLane(f);
      await expect(prepareCrashRecovery(input, lane.api, lane.ports)).rejects.toThrow(/確認できません|保持/);
      expect(lane.editingCalls).toEqual(["resolveSave:record"]);
      expect(lane.readCalls).toEqual([]);
      expect(lane.sent).toEqual([]);
      expect(input).toEqual(original);
      expect(ownerId).toBe(f.owner.id);
    } finally {
      f.dispose();
    }
  });

  it("rejects a foreign storage diagnostic carried by a record receipt", async () => {
    const {f, recordPageId} = recoveryFixture();
    try {
      const currentPage = f.store.get(recordPageId);
      const currentRecord = f.repo.projection(recordPageId);
      const operation = {...f.operation(true), revision: currentPage.revision, patch: {title: "Foreign carrier"}};
      const validUnknown = f.store.resolveSave(operation);
      const foreign = {...validUnknown, storageFailure: unclassifiedRequestFailure("database:resolve")};
      const lane = diagnosticLane(f, () => null, {resolveSave: async () => foreign});
      const entry: EditSessionRecovery = {
        sessionId: operation.sessionId,
        base: currentPage,
        record: currentRecord,
        seq: 1,
        intents: [{seq: 1, patch: operation.patch}],
        operation,
      };
      const input: CrashRecoverySnapshot = {...emptyCrashRecoverySnapshot(), records: [entry]};
      const original = structuredClone(input);
      await expect(prepareCrashRecovery(input, lane.api, lane.ports)).rejects.toThrow(/一致|確認/);
      expect(lane.editingCalls).toEqual(["resolveSave:record"]);
      expect(lane.readCalls).toEqual([]);
      expect(lane.sent).toEqual([]);
      expect(input).toEqual(original);
    } finally {
      f.dispose();
    }
  });
});

describe("App recovery port wiring", () => {
  const root = resolve(__dirname, "..");
  const source = readFileSync(resolve(root, "src/renderer/App.tsx"), "utf8");
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function* walk(node: ts.Node): Generator<ts.Node> {
    yield node;
    for (const child of node.getChildren()) yield* walk(child);
  }
  const nodes = [...walk(file)];

  it("passes a complete guarded purpose bundle to the actual prepare call", () => {
    const calls = nodes.filter((node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(file) === "prepareCrashRecovery");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.arguments).toHaveLength(3);
    expect(call.arguments[1].getText(file)).toBe("recoveryGuardedRequest");
    const ports = call.arguments[2];
    expect(ts.isObjectLiteralExpression(ports)).toBe(true);
    const properties = ts.isObjectLiteralExpression(ports) ? ports.properties : [];
    expect(properties.map((property) => ts.isPropertyAssignment(property) ? property.name.getText(file) : "").sort()).toEqual([
      "databaseSend", "readDatabase", "readRecord", "recordSend", "structuralSend",
    ]);
    const initializer = (name: string) => {
      const property = properties.find((item) =>
        ts.isPropertyAssignment(item) && item.name.getText(file) === name);
      expect(property && ts.isPropertyAssignment(property)).toBe(true);
      return (property as ts.PropertyAssignment).initializer;
    };
    const sends = ["recordSend", "databaseSend", "structuralSend"] as const;
    const targets: Record<(typeof sends)[number], string> = {
      recordSend: "purpose.save(",
      databaseSend: "purpose.database(",
      structuralSend: "purpose.structural(",
    };
    for (const name of sends) {
      const init = initializer(name);
      expect(ts.isArrowFunction(init) || ts.isFunctionExpression(init)).toBe(true);
      const fn = init as ts.ArrowFunction | ts.FunctionExpression;
      expect(fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false).toBe(false);
      const text = init.getText(file);
      expect(text).toContain("latchedRecoveryError()");
      expect(text).toContain("throw held");
      expect(text.indexOf("latchedRecoveryError()")).toBeLessThan(text.indexOf(targets[name]));
      expect([...walk(init)].some((node) => ts.isAwaitExpression(node))).toBe(false);
    }
    const readRecord = initializer("readRecord");
    const readDatabase = initializer("readDatabase");
    expect(readRecord.getText(file)).toContain("appApi.workspace.readRecord(");
    expect(readDatabase.getText(file)).toContain("appApi.workspace.readDatabase(");
    for (const init of [readRecord, readDatabase]) {
      expect(init.getText(file)).toContain("latchedRecoveryError()");
      expect(init.getText(file)).toContain("throw held");
      expect([...walk(init)].some((node) => ts.isAwaitExpression(node))).toBe(false);
    }
  });
});
