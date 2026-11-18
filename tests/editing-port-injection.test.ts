import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  privateRequestFailureReply,
  privateRequestSuccessReply,
} from "../src/main/private-request-envelope";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import { saveBridge } from "../src/renderer/purpose-bridge";
import { StorageFailureError } from "../src/renderer/private-request";
import {
  resolveReliableSave,
  sendReliableSave,
} from "../src/renderer/reliable-save";
import { saveFixture } from "./fixtures/r4-save-fixture";
import { Store } from "../src/persistence/store";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { emptyDatabase, type Request } from "../src/shared/types";
import type { SaveOperation, SaveResult } from "../src/shared/save-contract";
import type { DatabaseOperation } from "../src/shared/database-operation";

const read = (path: string) => readFileSync(resolve(path), "utf8");

/** Real preload + real v1 envelope around a synchronous dispatch, exactly the
 * shape main produces: success value slot or a bounded failure diagnostic. */
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
      return privateRequestFailureReply({ original, requestType: request.type });
    }
  });
  const bindings = createDesktopRootBindings({
    requestDiagnostic: preload.requestDiagnostic,
  });
  return { bindings, sent };
}

async function safeE(promise: Promise<unknown>, requestType: string) {
  const error = await promise.then(
    () => {
      throw new Error(`${requestType} unexpectedly succeeded`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(StorageFailureError);
  const diagnostic = (error as StorageFailureError).storageFailure;
  expect(diagnostic.kind).toBe("UNCLASSIFIED");
  expect(diagnostic.requestType).toBe(requestType);
  expect(diagnostic.preserve).toBe(true);
}

const saveOperationFixture = (f: ReturnType<typeof saveFixture>): SaveOperation => ({
  operationId: "op-editing-save",
  sessionId: "session-editing",
  seq: 1,
  pageId: f.record.pageId,
  databasePageId: f.owner.id,
  revision: 0,
  patch: { title: "Port title" },
});

function databaseFixture() {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/editing-db-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const { rows: _rows, ...settings } = emptyDatabase();
  return {
    root,
    store,
    settings,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("EditingPort over the real lane", () => {
  it("commits and resolves a save through exactly one invoke per call", async () => {
    const f = saveFixture();
    try {
      const { bindings, sent } = lane((request) =>
        f.store.handle(request),
      );
      const operation = saveOperationFixture(f);
      const result = await bindings.writable.editing.commitSave(operation);
      expect(result.status).toBe("applied");
      expect(result.page!.title).toBe("Port title");
      expect(result.page).toEqual(f.store.get(f.record.pageId));
      const resolved = await bindings.writable.editing.resolveSave(operation);
      expect(resolved.status).toBe("applied");
      expect(resolved).toEqual(result);
      expect(sent.map((request) => request.type)).toEqual([
        "save:commit",
        "save:resolve",
      ]);
      expect(sent[0]).toMatchObject({ operation });
      expect(bindings.readOnly.workspace).toBe(bindings.writable.workspace);
      expect(Object.keys(bindings.readOnly).sort()).toEqual([
        "capabilities",
        "original",
        "recovery",
        "workspace",
      ]);
    } finally {
      f.dispose();
    }
  });

  it("commits create/update database commands and resolves their receipts", async () => {
    const f = databaseFixture();
    try {
      const { bindings, sent } = lane((request) =>
        f.store.handle(request),
      );
      const creation = prepareDatabaseCreation("Editing DB", null, f.settings);
      const created = await bindings.writable.editing.commitDatabase(creation);
      expect(created.status).toBe("applied");
      expect(created.page!.kind).toBe("database");
      expect(created.database!.records).toEqual([]);

      const update: DatabaseOperation = {
        operationId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        seq: 1,
        command: {
          kind: "updateDatabase",
          databasePageId: created.page!.id,
          revision: created.page!.revision,
          patch: { title: "Updated via port" },
          settings: created.database!.settings,
        },
      };
      const updated = await bindings.writable.editing.commitDatabase(update);
      expect(updated.status).toBe("applied");
      expect(updated.page!.title).toBe("Updated via port");

      const record: DatabaseOperation = {
        operationId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        seq: 1,
        command: {
          kind: "createRecord",
          databasePageId: created.page!.id,
          revision: updated.page!.revision,
          title: "Row via port",
          values: {},
        },
      };
      const inserted = await bindings.writable.editing.commitDatabase(record);
      expect(inserted.status).toBe("applied");
      expect(inserted.record!.pageId).toBe(inserted.page!.id);
      expect(inserted.database!.records).toHaveLength(1);

      const resolved = await bindings.writable.editing.resolveDatabase(record);
      expect(resolved).toEqual(inserted);
      const missing = await bindings.writable.editing.resolveDatabase(
        prepareDatabaseCreation("Never sent", null, f.settings),
      );
      expect(missing.status).toBe("unknown");
      expect(missing.page).toBeUndefined();
      expect(missing.database).toBeUndefined();
      expect(missing.record).toBeUndefined();
      expect(sent.map((request) => request.type)).toEqual([
        "database:commit",
        "database:commit",
        "database:commit",
        "database:resolve",
        "database:resolve",
      ]);
    } finally {
      f.dispose();
    }
  });

  it("preserves rejected and unknown business results verbatim, message included", async () => {
    const f = saveFixture();
    try {
      const { bindings } = lane((request) => f.store.handle(request));
      const stale: SaveOperation = {
        ...saveOperationFixture(f),
        revision: 99,
      };
      const rejected = await bindings.writable.editing.commitSave(stale);
      expect(rejected.status).toBe("rejected");
      expect(typeof rejected.message).toBe("string");
      expect(rejected.page).toBeUndefined();
      const missing = await bindings.writable.editing.resolveSave({
        ...saveOperationFixture(f),
        operationId: "op-never-sent",
      });
      expect(missing.status).toBe("unknown");
      expect(typeof missing.message).toBe("string");
    } finally {
      f.dispose();
    }
  });

  it("keeps a legal DAG in the producer result instead of cloning it", async () => {
    const f = saveFixture();
    try {
      const shared = [{ name: "alpha" }];
      const value = {
        status: "rejected",
        operationId: "op-dag",
        sessionId: "s",
        seq: 1,
        pageId: "p",
        databasePageId: "db",
        fingerprint: "a".repeat(64),
        message: "business rejected",
        storageFailure: { first: shared, second: shared },
      };
      const { bindings } = lane(() => value);
      const result = await bindings.writable.editing.resolveSave(
        saveOperationFixture(f),
      );
      expect(result).toEqual(value);
      const detail = (result as SaveResult & { storageFailure: unknown })
        .storageFailure as { first: unknown; second: unknown };
      expect(detail.first).toBe(detail.second);
    } finally {
      f.dispose();
    }
  });
});

describe("EditingPort synchronous result validation", () => {
  it.each([
    ["a non-object", 42],
    ["an array", []],
    ["a cycle", null],
    ["a getter", null],
    ["an own thenable", null],
    ["a foreign prototype", null],
    ["a missing fingerprint", { status: "applied" }],
    ["a non-hex fingerprint", { status: "applied", fingerprint: "z".repeat(64) }],
    ["a zero seq", null],
    ["an unknown status", null],
  ])(
    "fails closed to UNCLASSIFIED for %s without touching the store",
    async (label, _value) => {
      const fixture = saveFixture();
      try {
        const base = {
          status: "applied",
          operationId: "op-x",
          sessionId: "s",
          seq: 1,
          pageId: "p",
          databasePageId: "db",
          fingerprint: "a".repeat(64),
        };
        let value: unknown;
        if (label === "a cycle") {
          value = { ...base };
          (value as Record<string, unknown>).self = value;
        } else if (label === "a getter") {
          value = {};
          Object.defineProperty(value, "status", {
            enumerable: true,
            get: () => "applied",
          });
        } else if (label === "an own thenable") {
          value = { ...base, then: () => undefined };
        } else if (label === "a foreign prototype") {
          const foreign: Record<string, unknown> = Object.create({
            inherited: true,
          });
          Object.assign(foreign, base);
          value = foreign;
        } else if (label === "a zero seq") {
          value = { ...base, seq: 0 };
        } else if (label === "an unknown status") {
          value = { ...base, status: "done" };
        } else {
          value = _value;
        }
        const { sent, bindings } = lane(() => value);
        await safeE(
          bindings.writable.editing.commitSave(saveOperationFixture(fixture)),
          "save:commit",
        );
        expect(sent).toHaveLength(1);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("fails closed when the producer itself throws", async () => {
    const { bindings } = lane(() => {
      throw new Error("store blew up /secret/path");
    });
    const f = saveFixture();
    try {
      await safeE(
        bindings.writable.editing.commitSave(saveOperationFixture(f)),
        "save:commit",
      );
    } finally {
      f.dispose();
    }
  });

  it("fails closed with zero invokes when no diagnostic bridge exists", async () => {
    const bindings = createDesktopRootBindings(undefined);
    const f = saveFixture();
    try {
      await safeE(
        bindings.writable.editing.commitDatabase(
          prepareDatabaseCreation("No bridge"),
        ),
        "database:commit",
      );
      await safeE(
        bindings.writable.structure.commitMigration(
          {} as never,
        ),
        "migration:commit",
      );
    } finally {
      f.dispose();
    }
  });

  it("leaves semantic mismatches to the exchange layer instead of the decoder", async () => {
    const f = saveFixture();
    try {
      const operation = saveOperationFixture(f);
      // A structurally valid receipt for a different operation: the decoder
      // accepts the shape; sendReliableSave's fingerprint check marks unknown.
      const alien: SaveResult = {
        status: "applied",
        operationId: "different-op",
        sessionId: operation.sessionId,
        seq: operation.seq,
        pageId: operation.pageId,
        fingerprint: "b".repeat(64),
        page: f.store.get(f.record.pageId),
        record: f.record,
      };
      const { bindings } = lane(() => alien);
      const result = await sendReliableSave(
        operation,
        saveBridge(bindings.writable.editing),
      );
      expect(result.status).toBe("unknown");
    } finally {
      f.dispose();
    }
  });

  it("round-trips a full record edit through the bridge and coordinator seam", async () => {
    const f = saveFixture();
    try {
      const { bindings, sent } = lane((request) => f.store.handle(request));
      const operation: SaveOperation = {
        ...saveOperationFixture(f),
        patch: { title: "Resolved" },
      };
      const committed = await sendReliableSave(
        operation,
        saveBridge(bindings.writable.editing),
      );
      expect(committed.status).toBe("applied");
      const resolved = await resolveReliableSave(
        operation,
        saveBridge(bindings.writable.editing),
      );
      expect(resolved.status).toBe("applied");
      expect(sent.map((request) => request.type)).toEqual([
        "save:commit",
        "save:resolve",
      ]);
    } finally {
      f.dispose();
    }
  });
});

describe("EditingPort wiring invariants", () => {
  const appApi = read("src/shared/app-api.ts");
  const desktop = read("src/renderer/desktop-api.ts");
  const bridge = read("src/renderer/purpose-bridge.ts");
  const structural = read("src/renderer/structural-operation.ts");

  it("keeps the shared API free of transport concepts", () => {
    for (const marker of [
      "export interface EditingPort",
      "commitSave(operation: SaveOperation): Promise<SaveResult>",
      "resolveDatabase(operation: DatabaseOperation): Promise<DatabaseOperationResult>",
      "export interface StructurePort",
      "readonly editing: EditingPort",
      "readonly structure: StructurePort",
    ])
      expect(appApi).toContain(marker);
    expect(appApi).not.toMatch(/\bRequest\b/);
    expect(appApi).not.toMatch(/channel|credential|handle/i);
  });

  it("builds every adapter tag once from the shared diagnostic request closure", () => {
    for (const marker of [
      '"save:commit", operation',
      '"save:resolve", operation',
      '"database:commit", operation',
      '"database:resolve", operation',
      '"migration:preview", databasePageId',
      '"migration:commit", operation',
      '"migration:resolve", operation',
      '"property:preview", databasePageId',
      '"property:commit", operation',
      '"property:resolve", operation',
      "decodeSaveResult",
      "decodeDatabaseOperationResult",
      "decodeMigrationPreview",
      "decodeMigrationResult",
      "decodePropertyPreviewResult",
      "decodePropertyOperationResult",
      "const editing: EditingPort",
      "const structure: StructurePort",
    ])
      expect(desktop).toContain(marker);
    expect(desktop).not.toContain("window.folio");
  });

  it("keeps the bridge free of awaits, fingerprints, timers and pre-validation", () => {
    for (const marker of [
      'request.type === "save:commit"',
      'request.type === "save:resolve"',
      'request.type === "database:commit"',
      'request.type === "database:resolve"',
      'request.type === "migration:commit"',
      'request.type === "migration:resolve"',
      'request.type === "property:commit"',
      'request.type === "property:resolve"',
    ])
      expect(bridge).toContain(marker);
    expect(bridge).not.toContain("await ");
    expect(bridge).not.toContain("operationFingerprint");
    expect(bridge).not.toContain("setTimeout");
    expect(bridge).not.toContain("window.folio");
  });

  it("keeps the structural exchange backward compatible with a default window lane", () => {
    expect(structural).toContain("export type StructuralTransport");
    expect(structural).toContain("window.folio.request(request)");
    expect(structural).toContain("send(request)");
    expect(structural).toContain("send: StructuralTransport");
  });
});
