import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  privateRequestFailureReply,
  privateRequestSuccessReply,
} from "../src/main/private-request-envelope";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import { structuralBridge } from "../src/renderer/purpose-bridge";
import {
  StorageFailureError,
  unclassifiedRequestFailure,
} from "../src/renderer/private-request";
import { exchangeStructural } from "../src/renderer/structural-operation";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import {
  commitLegacyMigration,
  previewLegacyMigration,
  resolveLegacyMigration,
  type LegacyMigrationEnvironment,
} from "../src/persistence/legacy-migration-operation";
import {
  commitPropertyOperation,
  previewPropertyOperation,
  resolvePropertyOperation,
} from "../src/persistence/property-operations";
import { commitDatabaseOperation } from "../src/persistence/database-operations";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { prepareLegacyMigration } from "../src/shared/legacy-migration-operation";
import { preparePropertyOperation } from "../src/shared/property-operation";
import { emptyDatabase, type Request } from "../src/shared/types";

const read = (path: string) => readFileSync(resolve(path), "utf8");

/** Same disposable legacy workspace shape the producer tests use: an
 * unregistered rows-based database plus a real assets directory. */
function migrationFixture() {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/structural-migration-"));
  const assetsPath = join(root, "assets"), snapshotRoot = join(root, "snapshots");
  mkdirSync(assetsPath);
  const store = new Store(join(root, "workspace.sqlite"));
  const legacy = store.create(null, "database", "Selected legacy");
  const historical = store.update(legacy.id, legacy.revision, {
    database: {
      ...legacy.database!,
      rows: [
        { id: "same-row", title: "Current row", values: { status: "進行中" } },
        { id: "history-only", title: "Historical row", values: { status: "完了" } },
      ],
    },
  });
  const current = store.update(legacy.id, historical.revision, {
    database: {
      ...historical.database!,
      rows: [
        historical.database!.rows[0],
        { id: "second-row", title: "Second row", values: { status: "未着手" } },
      ],
    },
  });
  writeFileSync(join(root, "synthetic.txt"), "structural attachment bytes");
  const environment: LegacyMigrationEnvironment = { assetsPath, snapshotRoot };
  return {
    root,
    store,
    legacy: current,
    environment,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The registered-database shape the property producer tests use. */
function propertyFixture() {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/structural-property-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const repository = new RecordRepository(store);
  const { rows: _rows, ...settings } = emptyDatabase();
  settings.properties = [
    { id: "subject", name: "対象", type: "text" },
    { id: "untouched", name: "残す列", type: "text" },
  ];
  const owner = commitDatabaseOperation(
    store,
    prepareDatabaseCreation("Structural schema fixture", null, settings),
  ).page!;
  repository.create(owner.id, "Row 0", { subject: "keep", untouched: "u" });
  return {
    root,
    store,
    repository,
    owner,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type StructuralFixture = {
  store: Store;
  environment?: LegacyMigrationEnvironment;
};

/** The exact main-process structural dispatch, over the real v1 envelope. */
function structuralLane(fixture: StructuralFixture) {
  const sent: Request[] = [], legacyCalls: string[] = [];
  const handle = (request: Request): unknown => {
    switch (request.type) {
      case "migration:preview":
        return previewLegacyMigration(fixture.store, request.databasePageId);
      case "migration:commit":
        return commitLegacyMigration(
          fixture.store,
          request.operation,
          fixture.environment!,
        );
      case "migration:resolve":
        return resolveLegacyMigration(fixture.store, request.operation);
      case "property:preview":
        return previewPropertyOperation(fixture.store, request);
      case "property:commit":
        return commitPropertyOperation(fixture.store, request.operation);
      case "property:resolve":
        return resolvePropertyOperation(fixture.store, request.operation);
      default:
        throw new Error(`unexpected ${request.type}`);
    }
  };
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
  return { bindings, sent, legacyCalls };
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

describe("StructurePort over the real lane", () => {
  it("previews, commits and resolves a legacy migration verbatim", async () => {
    const f = migrationFixture();
    try {
      const { bindings, sent, legacyCalls } = structuralLane(f);
      const direct = previewLegacyMigration(f.store, f.legacy.id);
      const preview = await bindings.writable.structure.previewMigration(
        f.legacy.id,
      );
      expect(preview).toEqual(direct);
      expect(preview.canApply).toBe(true);

      const operation = prepareLegacyMigration(preview);
      const applied = await bindings.writable.structure.commitMigration(
        operation,
      );
      expect(applied.status).toBe("applied");
      expect(applied.page!.id).toBe(f.legacy.id);
      expect(applied.database!.records).toHaveLength(2);
      expect(typeof applied.snapshotPath).toBe("string");
      expect(applied.records).toBe(2);

      const resolved = await bindings.writable.structure.resolveMigration(
        operation,
      );
      expect(resolved).toEqual(applied);
      expect(sent.map((request) => request.type)).toEqual([
        "migration:preview",
        "migration:commit",
        "migration:resolve",
      ]);
      expect(legacyCalls).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it("preserves a business-false migration preview with its issues", async () => {
    const f = propertyFixture();
    try {
      const { bindings } = structuralLane(f);
      const direct = previewLegacyMigration(f.store, f.owner.id);
      expect(direct.canApply).toBe(false);
      const preview = await bindings.writable.structure.previewMigration(
        f.owner.id,
      );
      expect(preview).toEqual(direct);
      expect(preview.canApply).toBe(false);
      expect(preview.issues.length).toBeGreaterThan(0);
      expect(typeof preview.issues[0]!.reason).toBe("string");
    } finally {
      f.dispose();
    }
  });

  it("previews, commits and resolves a property change verbatim", async () => {
    const f = propertyFixture();
    try {
      const { bindings, sent } = structuralLane(f);
      const change = {
        kind: "add" as const,
        property: { id: "added", name: "新列", type: "checkbox" as const },
      };
      const owner = f.store.get(f.owner.id);
      const preview = await bindings.writable.structure.previewProperty(
        f.owner.id,
        owner.revision,
        change,
      );
      expect(preview.ok).toBe(true);
      expect(preview.command).toBeDefined();
      expect(preview.requiresBackup).toBe(false);

      const operation = preparePropertyOperation(preview.command!);
      const applied = await bindings.writable.structure.commitProperty(
        operation,
      );
      expect(applied.status).toBe("applied");
      expect(applied.commandKind).toBe("add");
      expect(applied.database!.settings.properties.at(-1)).toEqual(
        change.property,
      );
      const resolved = await bindings.writable.structure.resolveProperty(
        operation,
      );
      expect(resolved).toEqual(applied);
      expect(sent.map((request) => request.type)).toEqual([
        "property:preview",
        "property:commit",
        "property:resolve",
      ]);
    } finally {
      f.dispose();
    }
  });

  it("preserves a business-false property preview with its issues", async () => {
    const f = propertyFixture();
    try {
      const { bindings } = structuralLane(f);
      const preview = await bindings.writable.structure.previewProperty(
        f.owner.id,
        999,
        { kind: "rename", propertyId: "subject", name: "Renamed" },
      );
      expect(preview.ok).toBe(false);
      expect(preview.command).toBeUndefined();
      expect(preview.changes).toEqual([]);
      expect(preview.issues.length).toBeGreaterThan(0);
      expect(typeof preview.issues[0]!.message).toBe("string");
      expect(preview.requiresBackup).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("keeps an unknown migration result verbatim, databasePageId included", async () => {
    const f = migrationFixture();
    try {
      const { bindings } = structuralLane(f);
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      const resolved = await bindings.writable.structure.resolveMigration(
        operation,
      );
      expect(resolved.status).toBe("unknown");
      expect(resolved.databasePageId).toBe(f.legacy.id);
      expect(resolved.page).toBeUndefined();
      expect(typeof resolved.message).toBe("string");
    } finally {
      f.dispose();
    }
  });
});

describe("StructurePort synchronous result validation", () => {
  const malformed: [string, unknown][] = [
    ["a non-object", 7],
    ["a missing receipt", { status: "applied" }],
    ["a non-hex fingerprint", { status: "applied", fingerprint: "z" }],
    ["an unknown status", { status: "done" }],
  ];
  it.each(malformed)(
    "migration:resolve fails closed to UNCLASSIFIED for %s",
    async (_label, value) => {
      const f = migrationFixture();
      try {
        const preload = createPrivateRequestPreload(async (request) =>
          privateRequestSuccessReply({ value, requestType: request.type }),
        );
        const bindings = createDesktopRootBindings({
          requestDiagnostic: preload.requestDiagnostic,
        });
        const operation = prepareLegacyMigration(
          previewLegacyMigration(f.store, f.legacy.id),
        );
        await safeE(
          bindings.writable.structure.resolveMigration(operation),
          "migration:resolve",
        );
      } finally {
        f.dispose();
      }
    },
  );

  it("rejects getter, thenable, cyclic and foreign-prototype structural results", async () => {
    const f = migrationFixture();
    try {
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      const base = {
        status: "applied",
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        seq: operation.seq,
        databasePageId: operation.databasePageId,
        fingerprint: "a".repeat(64),
      };
      const getter = {};
      Object.defineProperty(getter, "status", {
        enumerable: true,
        get: () => "applied",
      });
      const cyclic = { ...base } as Record<string, unknown>;
      cyclic.self = cyclic;
      const foreign = Object.create({ inherited: true });
      Object.assign(foreign, base);
      for (const value of [
        getter,
        cyclic,
        foreign,
        { ...base, then: () => undefined },
      ]) {
        const preload = createPrivateRequestPreload(async (request) =>
          privateRequestSuccessReply({ value, requestType: request.type }),
        );
        const bindings = createDesktopRootBindings({
          requestDiagnostic: preload.requestDiagnostic,
        });
        await safeE(
          bindings.writable.structure.resolveMigration(operation),
          "migration:resolve",
        );
      }
    } finally {
      f.dispose();
    }
  });
});

describe("StructurePort non-wire storageFailure carrier", () => {
  /** A lane whose success value is the given carrier verbatim — the same
   * envelope the real preload produces, without a store round-trip. */
  const lane = (value: unknown) => {
    const preload = createPrivateRequestPreload(async (request) =>
      privateRequestSuccessReply({ value, requestType: request.type }),
    );
    return createDesktopRootBindings({
      requestDiagnostic: preload.requestDiagnostic,
    });
  };
  const foreignDiagnostic = () => unclassifiedRequestFailure("save:commit");

  it("rejects own storageFailure carriers on migration commit/resolve as the actual tag", async () => {
    const f = migrationFixture();
    try {
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      const receipt = {
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        seq: operation.seq,
        databasePageId: operation.databasePageId,
        fingerprint: "a".repeat(64),
      };
      const carriers: unknown[] = [
        {
          status: "applied",
          ...receipt,
          storageFailure: unclassifiedRequestFailure("migration:commit"),
        },
        {
          status: "applied",
          ...receipt,
          storageFailure: unclassifiedRequestFailure("migration:resolve"),
        },
        {
          status: "rejected",
          ...receipt,
          message: "refused",
          storageFailure: foreignDiagnostic(),
        },
        {
          status: "unknown",
          ...receipt,
          message: "unconfirmed",
          storageFailure: foreignDiagnostic(),
        },
        { status: "unknown", ...receipt, storageFailure: undefined },
        { status: "unknown", ...receipt, storageFailure: "not-a-diagnostic" },
      ];
      for (const value of carriers) {
        const bindings = lane(value);
        await safeE(
          bindings.writable.structure.commitMigration(operation),
          "migration:commit",
        );
        await safeE(
          bindings.writable.structure.resolveMigration(operation),
          "migration:resolve",
        );
      }
    } finally {
      f.dispose();
    }
  });

  it("rejects own storageFailure carriers on property commit/resolve as the actual tag", async () => {
    const f = propertyFixture();
    try {
      const owner = f.store.get(f.owner.id);
      const preview = previewPropertyOperation(f.store, {
        type: "property:preview",
        databasePageId: f.owner.id,
        revision: owner.revision,
        change: { kind: "rename", propertyId: "subject", name: "Renamed" },
      });
      const operation = preparePropertyOperation(preview.command!);
      const receipt = {
        operationId: operation.operationId,
        sessionId: operation.sessionId,
        seq: operation.seq,
        fingerprint: "b".repeat(64),
        commandKind: "rename",
        databasePageId: f.owner.id,
      };
      const carriers: unknown[] = [
        {
          status: "applied",
          ...receipt,
          storageFailure: unclassifiedRequestFailure("property:commit"),
        },
        {
          status: "applied",
          ...receipt,
          storageFailure: unclassifiedRequestFailure("property:resolve"),
        },
        {
          status: "rejected",
          ...receipt,
          message: "refused",
          storageFailure: foreignDiagnostic(),
        },
        {
          status: "unknown",
          ...receipt,
          message: "unconfirmed",
          storageFailure: foreignDiagnostic(),
        },
        { status: "unknown", ...receipt, storageFailure: undefined },
        { status: "unknown", ...receipt, storageFailure: "not-a-diagnostic" },
      ];
      for (const value of carriers) {
        const bindings = lane(value);
        await safeE(
          bindings.writable.structure.commitProperty(operation),
          "property:commit",
        );
        await safeE(
          bindings.writable.structure.resolveProperty(operation),
          "property:resolve",
        );
      }
    } finally {
      f.dispose();
    }
  });

  it("never reads an own storageFailure accessor on either result decoder", async () => {
    const mf = migrationFixture();
    const pf = propertyFixture();
    try {
      const migrationOperation = prepareLegacyMigration(
        previewLegacyMigration(mf.store, mf.legacy.id),
      );
      const owner = pf.store.get(pf.owner.id);
      const preview = previewPropertyOperation(pf.store, {
        type: "property:preview",
        databasePageId: pf.owner.id,
        revision: owner.revision,
        change: { kind: "rename", propertyId: "subject", name: "Renamed" },
      });
      const propertyOperation = preparePropertyOperation(preview.command!);
      let migrationReads = 0;
      let propertyReads = 0;
      const migrationValue: Record<string, unknown> = {
        status: "applied",
        operationId: migrationOperation.operationId,
        sessionId: migrationOperation.sessionId,
        seq: migrationOperation.seq,
        databasePageId: migrationOperation.databasePageId,
        fingerprint: "a".repeat(64),
      };
      Object.defineProperty(migrationValue, "storageFailure", {
        enumerable: true,
        get: () => {
          migrationReads += 1;
          return foreignDiagnostic();
        },
      });
      const propertyValue: Record<string, unknown> = {
        status: "applied",
        operationId: propertyOperation.operationId,
        sessionId: propertyOperation.sessionId,
        seq: propertyOperation.seq,
        fingerprint: "b".repeat(64),
        commandKind: "rename",
        databasePageId: pf.owner.id,
      };
      Object.defineProperty(propertyValue, "storageFailure", {
        enumerable: true,
        get: () => {
          propertyReads += 1;
          return foreignDiagnostic();
        },
      });
      await safeE(
        lane(migrationValue).writable.structure.resolveMigration(
          migrationOperation,
        ),
        "migration:resolve",
      );
      await safeE(
        lane(propertyValue).writable.structure.resolveProperty(
          propertyOperation,
        ),
        "property:resolve",
      );
      expect(migrationReads).toBe(0);
      expect(propertyReads).toBe(0);
    } finally {
      mf.dispose();
      pf.dispose();
    }
  });

  it("closes a matching-carrier unknown to exchange UNKNOWN on all four tags", async () => {
    const mf = migrationFixture();
    const pf = propertyFixture();
    try {
      const migrationOperation = prepareLegacyMigration(
        previewLegacyMigration(mf.store, mf.legacy.id),
      );
      const owner = pf.store.get(pf.owner.id);
      const preview = previewPropertyOperation(pf.store, {
        type: "property:preview",
        databasePageId: pf.owner.id,
        revision: owner.revision,
        change: { kind: "rename", propertyId: "subject", name: "Renamed" },
      });
      const propertyOperation = preparePropertyOperation(preview.command!);
      const migrationReceipt = {
        operationId: migrationOperation.operationId,
        sessionId: migrationOperation.sessionId,
        seq: migrationOperation.seq,
        databasePageId: migrationOperation.databasePageId,
        fingerprint: "a".repeat(64),
      };
      const propertyReceipt = {
        operationId: propertyOperation.operationId,
        sessionId: propertyOperation.sessionId,
        seq: propertyOperation.seq,
        fingerprint: "b".repeat(64),
        commandKind: "rename",
        databasePageId: pf.owner.id,
      };
      for (const resolve of [false, true]) {
        const tag = resolve ? "migration:resolve" : "migration:commit";
        const value = {
          status: "unknown",
          ...migrationReceipt,
          message: "carried diagnostic",
          storageFailure: unclassifiedRequestFailure(tag),
        };
        const bindings = lane(value);
        const result = await exchangeStructural(
          { family: "migration", operation: migrationOperation },
          resolve,
          30_000,
          structuralBridge(bindings.writable.structure),
        );
        expect(result.status).toBe("unknown");
        expect(result.operationId).toBe(migrationOperation.operationId);
      }
      for (const resolve of [false, true]) {
        const tag = resolve ? "property:resolve" : "property:commit";
        const value = {
          status: "unknown",
          ...propertyReceipt,
          message: "carried diagnostic",
          storageFailure: unclassifiedRequestFailure(tag),
        };
        const bindings = lane(value);
        const result = await exchangeStructural(
          { family: "property", operation: propertyOperation },
          resolve,
          30_000,
          structuralBridge(bindings.writable.structure),
        );
        expect(result.status).toBe("unknown");
        expect(result.operationId).toBe(propertyOperation.operationId);
      }
    } finally {
      mf.dispose();
      pf.dispose();
    }
  });

  it("keeps diagnostic-free unknown/message results as the original value", async () => {
    const mf = migrationFixture();
    const pf = propertyFixture();
    try {
      const migrationOperation = prepareLegacyMigration(
        previewLegacyMigration(mf.store, mf.legacy.id),
      );
      const migrationValue = {
        status: "unknown",
        operationId: migrationOperation.operationId,
        sessionId: migrationOperation.sessionId,
        seq: migrationOperation.seq,
        databasePageId: migrationOperation.databasePageId,
        fingerprint: "a".repeat(64),
        message: "receipt not found",
      };
      expect(
        await lane(migrationValue).writable.structure.resolveMigration(
          migrationOperation,
        ),
      ).toBe(migrationValue);

      const owner = pf.store.get(pf.owner.id);
      const preview = previewPropertyOperation(pf.store, {
        type: "property:preview",
        databasePageId: pf.owner.id,
        revision: owner.revision,
        change: { kind: "rename", propertyId: "subject", name: "Renamed" },
      });
      const propertyOperation = preparePropertyOperation(preview.command!);
      const propertyValue = {
        status: "unknown",
        operationId: propertyOperation.operationId,
        sessionId: propertyOperation.sessionId,
        seq: propertyOperation.seq,
        fingerprint: "b".repeat(64),
        commandKind: "rename",
        databasePageId: pf.owner.id,
        message: "receipt not found",
      };
      expect(
        await lane(propertyValue).writable.structure.resolveProperty(
          propertyOperation,
        ),
      ).toBe(propertyValue);
    } finally {
      mf.dispose();
      pf.dispose();
    }
  });
});

describe("exchangeStructural trailing transport", () => {
  it("sends commit then resolve through the injected purpose bridge only", async () => {
    const f = migrationFixture();
    try {
      const { bindings, sent } = structuralLane(f);
      const transport = structuralBridge(bindings.writable.structure);
      const preview = await bindings.writable.structure.previewMigration(
        f.legacy.id,
      );
      const entry = {
        family: "migration" as const,
        operation: prepareLegacyMigration(preview),
      };
      const applied = await exchangeStructural(entry, false, 30_000, transport);
      expect(applied.status).toBe("applied");
      const resolved = await exchangeStructural(entry, true, 30_000, transport);
      expect(resolved.status).toBe("applied");
      expect(sent.map((request) => request.type)).toEqual([
        "migration:preview",
        "migration:commit",
        "migration:resolve",
      ]);
    } finally {
      f.dispose();
    }
  });

  it("turns a wrong-family refusal into the local unknown result without a second send", async () => {
    const f = migrationFixture();
    try {
      const { bindings, sent } = structuralLane(f);
      const transport = structuralBridge(bindings.writable.structure);
      const operation = prepareLegacyMigration(
        previewLegacyMigration(f.store, f.legacy.id),
      );
      // A save-shaped entry can never be built by prepare functions; prove the
      // transport-level refusal path returns the bounded local unknown and the
      // underlying port stays uninvoked.
      const wrong = await transport({
        type: "save:commit",
        operation: {} as never,
      }).then(
        () => ({ ok: true }),
        (reason: unknown) => ({ ok: false, reason }),
      );
      expect(wrong.ok).toBe(false);
      expect((wrong as { reason: unknown }).reason).toBeInstanceOf(
        StorageFailureError,
      );
      expect(sent).toEqual([]);
      const result = await exchangeStructural(
        { family: "migration", operation },
        true,
        30_000,
        async () => {
          throw new Error("lookup transport lost");
        },
      );
      expect(result.status).toBe("unknown");
      expect(result.operationId).toBe(operation.operationId);
    } finally {
      f.dispose();
    }
  });

  it("maps a structurally valid but identity-mismatched receipt to local unknown", async () => {
    const f = propertyFixture();
    try {
      const owner = f.store.get(f.owner.id);
      const preview = previewPropertyOperation(f.store, {
        type: "property:preview",
        databasePageId: f.owner.id,
        revision: owner.revision,
        change: { kind: "rename", propertyId: "subject", name: "Renamed" },
      });
      const operation = preparePropertyOperation(preview.command!);
      const alien = {
        status: "applied",
        operationId: "different-operation",
        sessionId: operation.sessionId,
        seq: operation.seq,
        fingerprint: "b".repeat(64),
        commandKind: "rename",
        databasePageId: f.owner.id,
      };
      const result = await exchangeStructural(
        { family: "property", operation },
        false,
        30_000,
        async () => alien,
      );
      expect(result.status).toBe("unknown");
      expect(result.operationId).toBe(operation.operationId);
      expect(result.fingerprint).not.toBe(alien.fingerprint);
    } finally {
      f.dispose();
    }
  });
});

describe("structural dialog wiring", () => {
  const dialog = read("src/renderer/StructuralDatabaseDialog.tsx");
  const structural = read("src/renderer/structural-operation.ts");

  it("requires injected workspace and structure ports with no window lane", () => {
    for (const marker of [
      "workspace: WorkspaceReadPort",
      "structure: StructurePort",
      "structure.previewMigration(owner.id)",
      "structure.previewProperty(owner.id",
      "workspace.readDatabase(owner.id)",
      "structuralBridge(structure)",
    ])
      expect(dialog).toContain(marker);
    expect(dialog).not.toContain("window.folio");
    expect(dialog).not.toContain("migration:preview");
    expect(dialog).not.toContain("property:preview");
    expect(dialog).not.toContain("database:read");
  });

  it("retains before every send, marks sent once, and keeps resolve lookup-only", () => {
    const order = [
      "if (busy.current || applied.current || (sent.current && !resolve))",
      "if (!operation.current)",
      "await retain(operation.current)",
      "setRetentionBlocked(!sent.current)",
      "const lookupOnly = sent.current",
      "sent.current = true",
      "exchangeStructural(operation.current, lookupOnly,",
    ];
    let cursor = 0;
    for (const marker of order) {
      const found = dialog.indexOf(marker, cursor);
      expect(found, marker).toBeGreaterThanOrEqual(cursor);
      cursor = found;
    }
    expect(dialog).toContain("await retain(null)");
    const applied = dialog.indexOf("await onApplied()");
    const release = dialog.indexOf("operation.current = undefined");
    expect(applied).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(applied);
  });

  it("keeps the exchange signature, guards and semantic checks unchanged", () => {
    for (const marker of [
      "export type StructuralTransport",
      "resolve = false",
      "timeoutMs = 30_000",
      "send: StructuralTransport = (request) => window.folio.request(request)",
      "fingerprint = await operationFingerprint(op)",
      "send(request)",
      "result.operationId !== op.operationId",
      "result.sessionId !== op.sessionId",
      "result.fingerprint !== fingerprint",
      "result.databasePageId !== owner",
      '"applied", "rejected", "unknown"',
    ])
      expect(structural).toContain(marker);
  });
});
