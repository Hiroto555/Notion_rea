import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  privateRequestFailureReply,
  privateRequestSuccessReply,
} from "../src/main/private-request-envelope";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import {
  createPurposeBridges,
  databaseBridge,
  saveBridge,
  structuralBridge,
} from "../src/renderer/purpose-bridge";
import { StorageFailureError } from "../src/renderer/private-request";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import {
  resolveDatabaseOperation,
  sendDatabaseOperation,
} from "../src/renderer/reliable-database-operation";
import { saveFixture } from "./fixtures/r4-save-fixture";
import { readDatabaseSnapshot } from "../src/persistence/database-operations";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { emptyDatabase, type Request } from "../src/shared/types";
import type { EditingPort, StructurePort } from "../src/shared/app-api";
import type { SaveOperation } from "../src/shared/save-contract";
import type { DatabaseOperation } from "../src/shared/database-operation";
import type { LegacyMigrationOperation } from "../src/shared/legacy-migration-operation";
import type { PropertyOperation } from "../src/shared/property-operation";
import { Store } from "../src/persistence/store";

const saveOperation = {
  operationId: "op-save",
  sessionId: "session-1",
  seq: 1,
  pageId: "page-1",
  databasePageId: null,
  revision: 0,
  patch: { title: "T" },
} as unknown as SaveOperation;
const databaseOperation = {
  operationId: "op-database",
} as unknown as DatabaseOperation;
const migrationOperation = {
  databasePageId: "db-1",
} as unknown as LegacyMigrationOperation;
const propertyOperation = {
  command: { databasePageId: "db-1" },
} as unknown as PropertyOperation;

/** Each fake method returns a distinct promise so a test can prove the bridge
 * returns the port call itself — no wrapper, queue or re-validation. */
function recorder<T extends object>(names: string[]) {
  const calls: { method: string; input: unknown }[] = [];
  const returns = new Map<string, Promise<unknown>>();
  const port = {} as Record<string, (input: unknown) => Promise<unknown>>;
  for (const name of names) {
    returns.set(name, Promise.resolve(`echo:${name}`));
    port[name] = (input) => {
      calls.push({ method: name, input });
      return returns.get(name)!;
    };
  }
  return { port: port as unknown as T, calls, returns };
}

const editingNames = [
  "commitSave",
  "resolveSave",
  "commitDatabase",
  "resolveDatabase",
];
const structureNames = [
  "previewMigration",
  "previewProperty",
  "commitMigration",
  "resolveMigration",
  "commitProperty",
  "resolveProperty",
];

function editing() {
  return recorder<EditingPort>(editingNames);
}
function structure() {
  return recorder<StructurePort>(structureNames);
}

async function expectRefused(
  promise: Promise<unknown>,
  requestType: string,
) {
  const error = await promise.then(
    () => {
      throw new Error("wrong-family request was not refused");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(StorageFailureError);
  expect((error as StorageFailureError).storageFailure.requestType).toBe(
    requestType,
  );
}

/** A real preload and v1 envelope around a synchronous store-side dispatch,
 * so the whole adapter path — decoder, port, bridge — is exercised. */
function lane(handle: (request: Request) => unknown) {
  const sent: Request[] = [];
  const preload = createPrivateRequestPreload(async (request) => {
    sent.push(request);
    try {
      return privateRequestSuccessReply({
        value: handle(request),
        requestType: request.type,
      });
    } catch (original) {
      return privateRequestFailureReply({
        original,
        requestType: request.type,
      });
    }
  });
  const bindings = createDesktopRootBindings({
    requestDiagnostic: preload.requestDiagnostic,
  });
  return { bindings, sent, bridges: createPurposeBridges(bindings.writable) };
}

describe("purpose bridge tag map", () => {
  it("forwards every canonical tag to exactly its own port method, returning that call", () => {
    const edit = editing(), struct = structure();
    const bridges = createPurposeBridges({
      editing: edit.port,
      structure: struct.port,
    });
    expect(bridges.save({ type: "save:commit", operation: saveOperation }))
      .toBe(edit.returns.get("commitSave"));
    expect(bridges.save({ type: "save:resolve", operation: saveOperation }))
      .toBe(edit.returns.get("resolveSave"));
    expect(
      bridges.database({
        type: "database:commit",
        operation: databaseOperation,
      }),
    ).toBe(edit.returns.get("commitDatabase"));
    expect(
      bridges.database({
        type: "database:resolve",
        operation: databaseOperation,
      }),
    ).toBe(edit.returns.get("resolveDatabase"));
    expect(
      bridges.structural({
        type: "migration:commit",
        operation: migrationOperation,
      }),
    ).toBe(struct.returns.get("commitMigration"));
    expect(
      bridges.structural({
        type: "migration:resolve",
        operation: migrationOperation,
      }),
    ).toBe(struct.returns.get("resolveMigration"));
    expect(
      bridges.structural({
        type: "property:commit",
        operation: propertyOperation,
      }),
    ).toBe(struct.returns.get("commitProperty"));
    expect(
      bridges.structural({
        type: "property:resolve",
        operation: propertyOperation,
      }),
    ).toBe(struct.returns.get("resolveProperty"));
    expect(edit.calls.map((call) => call.method)).toEqual(editingNames);
    expect(struct.calls.map((call) => call.method)).toEqual([
      "commitMigration",
      "resolveMigration",
      "commitProperty",
      "resolveProperty",
    ]);
    expect(edit.calls[0]!.input).toBe(saveOperation);
    expect(struct.calls[0]!.input).toBe(migrationOperation);
  });

  it("treats a legitimate resolve as in-family on every bridge", async () => {
    const edit = editing(), struct = structure();
    await saveBridge(edit.port)({
      type: "save:resolve",
      operation: saveOperation,
    });
    await databaseBridge(edit.port)({
      type: "database:resolve",
      operation: databaseOperation,
    });
    await structuralBridge(struct.port)({
      type: "migration:resolve",
      operation: migrationOperation,
    });
    await structuralBridge(struct.port)({
      type: "property:resolve",
      operation: propertyOperation,
    });
    expect(edit.calls.map((call) => call.method)).toEqual([
      "resolveSave",
      "resolveDatabase",
    ]);
    expect(struct.calls.map((call) => call.method)).toEqual([
      "resolveMigration",
      "resolveProperty",
    ]);
  });

  it.each([
    { type: "database:commit", operation: databaseOperation },
    { type: "database:resolve", operation: databaseOperation },
    { type: "migration:commit", operation: migrationOperation },
    { type: "migration:resolve", operation: migrationOperation },
    { type: "property:commit", operation: propertyOperation },
    { type: "property:resolve", operation: propertyOperation },
    { type: "migration:preview", databasePageId: "db-1" },
    {
      type: "property:preview",
      databasePageId: "db-1",
      revision: 0,
      change: { kind: "rename", propertyId: "p", name: "n" },
    },
    { type: "load" },
    { type: "record:read", pageId: "p" },
  ] as Request[])(
    "the save bridge refuses %s without invoking any port method",
    async (request) => {
      const edit = editing();
      await expectRefused(saveBridge(edit.port)(request), request.type);
      expect(edit.calls).toEqual([]);
    },
  );

  it.each([
    { type: "save:commit", operation: saveOperation },
    { type: "save:resolve", operation: saveOperation },
    { type: "migration:commit", operation: migrationOperation },
    { type: "property:resolve", operation: propertyOperation },
    { type: "database:read", databasePageId: "db-1" },
  ] as Request[])(
    "the database bridge refuses %s without invoking any port method",
    async (request) => {
      const edit = editing();
      await expectRefused(databaseBridge(edit.port)(request), request.type);
      expect(edit.calls).toEqual([]);
    },
  );

  it.each([
    { type: "save:commit", operation: saveOperation },
    { type: "database:resolve", operation: databaseOperation },
    { type: "migration:preview", databasePageId: "db-1" },
    {
      type: "property:preview",
      databasePageId: "db-1",
      revision: 0,
      change: { kind: "rename", propertyId: "p", name: "n" },
    },
    { type: "load" },
  ] as Request[])(
    "the structural bridge refuses %s without invoking any port method",
    async (request) => {
      const struct = structure();
      await expectRefused(structuralBridge(struct.port)(request), request.type);
      expect(struct.calls).toEqual([]);
    },
  );

  it("never inspects the operation and names the actual received tag", async () => {
    const edit = editing();
    await expectRefused(
      saveBridge(edit.port)({ type: "record:read", pageId: "x" } as Request),
      "record:read",
    );
    expect(edit.calls).toEqual([]);
  });
});

describe("purpose bridge over the real lane", () => {
  it("drives a real EditSessionCoordinator through saveBridge, the v1 envelope and a disposable store", async () => {
    const f = saveFixture();
    try {
      const { sent, bridges, bindings } = lane((request) =>
        f.store.handle(request),
      );
      const coordinator = new EditSessionCoordinator(bridges.save);
      const handle = coordinator.attach(
        f.store.get(f.record.pageId),
        f.record,
      );
      coordinator.edit(handle, { title: "Purpose lane" });
      await coordinator.flush(handle.pageId);
      expect(coordinator.get(handle.pageId)).toMatchObject({
        state: "saved",
        page: { title: "Purpose lane", revision: 1 },
      });
      expect(f.store.get(f.record.pageId).title).toBe("Purpose lane");
      expect(sent.map((request) => request.type)).toEqual(["save:commit"]);
      expect(bindings.readOnly.workspace).toBe(bindings.writable.workspace);
    } finally {
      f.dispose();
    }
  });

  it("keeps commit→resolve sequencing through saveBridge when the first ACK is lost", async () => {
    const f = saveFixture();
    try {
      let commits = 0;
      const { sent, bridges } = lane((request) => {
        const result = f.store.handle(request);
        if (request.type === "save:commit" && ++commits === 1)
          throw new Error("ACK lost");
        return result;
      });
      const coordinator = new EditSessionCoordinator(bridges.save);
      const handle = coordinator.attach(
        f.store.get(f.record.pageId),
        f.record,
      );
      coordinator.edit(handle, { title: "Committed" });
      await coordinator.flush(handle.pageId);
      expect(coordinator.get(handle.pageId)?.state).toBe("unknown");
      await coordinator.resolve(handle.pageId);
      expect(coordinator.get(handle.pageId)?.state).toBe("saved");
      expect(sent.map((request) => request.type)).toEqual([
        "save:commit",
        "save:resolve",
      ]);
    } finally {
      f.dispose();
    }
  });

  it("drives a real DatabaseSessionCoordinator and the standalone create lane through databaseBridge", async () => {
    const root = mkdtempSync(resolve("output/purpose-db-"));
    const store = new Store(join(root, "workspace.sqlite"));
    try {
      const { sent, bridges } = lane((request) => store.handle(request));
      const { rows: _rows, ...settings } = emptyDatabase();
      const created = await sendDatabaseOperation(
        prepareDatabaseCreation("Purpose DB", null, settings),
        bridges.database,
      );
      expect(created.status).toBe("applied");
      const coordinator = new DatabaseSessionCoordinator(bridges.database);
      const snapshot = readDatabaseSnapshot(store, created.page!.id);
      const handle = coordinator.attach(snapshot.page, snapshot.database);
      coordinator.editPage(handle, { title: "Renamed via purpose" });
      await coordinator.flush(created.page!.id);
      expect(coordinator.get(created.page!.id)).toMatchObject({
        state: "saved",
        page: { title: "Renamed via purpose" },
      });
      const resolve = await resolveDatabaseOperation(
        prepareDatabaseCreation("Missing op", null, settings),
        bridges.database,
      );
      expect(resolve.status).toBe("unknown");
      expect(sent.map((request) => request.type)).toEqual([
        "database:commit",
        "database:commit",
        "database:resolve",
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
