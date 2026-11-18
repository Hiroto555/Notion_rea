import {sqliteOwnerRetainsPlatform} from "../src/sync/sqlite-connection-owner";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProductPrivatePlatform,
  withProductPrivateJournals,
  type ProductPrivateJournalOptions,
} from "../src/platform/product-private-journals";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { PrivateLedger } from "../src/sync/private-ledger";
import type { PrivatePlatform } from "../src/sync/private-platform";
import {
  canonicalJson,
  sha256 as sha,
  SyncError,
} from "../src/sync/protocol";
import { inspectTransferCacheCatalog } from "../src/sync/transfer-cache-catalog";
import { TransferMaintenanceService } from "../src/main/transfer-maintenance-service";
import {
  WorkspaceSyncService,
  type WorkspaceSyncTransport,
} from "../src/main/workspace-sync-service";
import { SecretRecordLedgerPersistence } from "../src/sync/secret-record-ledger";
import { SyncConnectionVault } from "../src/main/sync-connection-vault";
import { syncSecretKey } from "../src/sync/secret-store";
import {
  stageCheckpointAssets,
  uploadCheckpointAssets,
  type WorkspaceBlobClientOptions,
} from "../src/sync/workspace-blobs";
import type { BlobTransferScope } from "../src/sync/blob-transfer-types";

/**
 * Every injected port below is an untrusted contract double over disposable
 * POSIX files and reports kind "windows" so journal dispatch selects the
 * native path. Nothing here mutates process.platform or claims Windows
 * OS/filesystem acceptance.
 */
const POSIX = process.platform !== "win32";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), prefix)),
  );
  chmodSync(directory, 0o700);
  roots.push(directory);
  return directory;
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/**
 * Routing contract double with disposable SQLite/filesystem storage; no
 * identity/ACL proof. It proves only that each journal open received a fresh
 * owner on the native path, never Windows OS acceptance.
 */
function fakeWindowsPort() {
  return {
    kind: "windows" as const,
    bind: vi.fn((directory: string) => {
      privateDir(directory);
      return realpathSync(directory);
    }),
    assertRoot: vi.fn(() => undefined),
    assertFile: vi.fn((_path: string) => undefined),
    assertSidecars: vi.fn((_path: string) => undefined),
    createExclusive: vi.fn((path: string) => {
      if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    }),
    assertEmptyFile: vi.fn((path: string) => {
      if (lstatSync(path).size !== 0) throw new Error("not-empty");
    }),
    close: vi.fn(() => undefined),
  };
}

type FakePort = ReturnType<typeof fakeWindowsPort>;

function trackingFactory(): {
  factory: (directory: string, name: string) => PrivatePlatform;
  calls: { directory: string; name: string }[];
  ports: FakePort[];
  options: ProductPrivateJournalOptions;
} {
  const calls: { directory: string; name: string }[] = [];
  const ports: FakePort[] = [];
  const factory = (directory: string, name: string) => {
    calls.push({ directory, name });
    const port = fakeWindowsPort();
    ports.push(port);
    return port;
  };
  return { factory, calls, ports, options: { privatePlatformFactory: factory } };
}

function constructorAggregate(run: () => unknown): AggregateError {
  try {run();} catch (error) {expect(error).toBeInstanceOf(AggregateError); return error as AggregateError;}
  throw new Error("Expected retained constructor failure");
}

function syncError(run: () => unknown): SyncError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    return error as SyncError;
  }
  throw new Error("expected SyncError");
}

async function asyncError(run: () => Promise<unknown>): Promise<SyncError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    return error as SyncError;
  }
  throw new Error("expected SyncError");
}

describe("product-private-journals factory contract", () => {
  const directory = "/unused/journal-directory";

  it("returns undefined without a configured factory and never invents a fallback", () => {
    expect(createProductPrivatePlatform(directory, "state.sqlite")).toBeUndefined();
    expect(
      createProductPrivatePlatform(directory, "state.sqlite", {}),
    ).toBeUndefined();
    expect(
      withProductPrivateJournals(undefined, () =>
        createProductPrivatePlatform(directory, "state.sqlite"),
      ),
    ).toBeUndefined();
  });

  it("prefers explicit options over the scoped context and lets an empty object disable it", () => {
    const outer = trackingFactory();
    const inner = trackingFactory();
    withProductPrivateJournals(outer.options, () => {
      expect(
        createProductPrivatePlatform(directory, "state.sqlite", inner.options),
      ).toBeDefined();
      expect(
        createProductPrivatePlatform(directory, "state.sqlite", {}),
      ).toBeUndefined();
      expect(
        createProductPrivatePlatform(directory, "state.sqlite"),
      ).toBeDefined();
    });
    expect(inner.calls).toEqual([{ directory, name: "state.sqlite" }]);
    expect(outer.calls).toEqual([{ directory, name: "state.sqlite" }]);
  });

  it("rejects async and generator factories before invoking them", () => {
    let invoked = 0;
    const asyncFactory = async () => {
      invoked += 1;
      return fakeWindowsPort();
    };
    const generatorFactory = function* () {
      invoked += 1;
      yield fakeWindowsPort();
    };
    const asyncGeneratorFactory = async function* () {
      invoked += 1;
      yield fakeWindowsPort();
    };
    for (const factory of [
      asyncFactory,
      generatorFactory,
      asyncGeneratorFactory,
    ]) {
      const error = syncError(() =>
        createProductPrivatePlatform(directory, "state.sqlite", {
          privatePlatformFactory:
            factory as unknown as ProductPrivateJournalOptions["privatePlatformFactory"],
        }),
      );
      expect(error).toMatchObject({
        code: "product-private-platform-invalid",
        status: 503,
      });
    }
    expect(invoked).toBe(0);
  });

  it.each([
    ["undefined", () => undefined],
    ["null", () => null],
    ["a string", () => "port"],
    ["an incomplete object with safe cleanup", () => ({ close() {} })],
    ["an array", () => []],
    ["a resolved Promise", () => Promise.resolve(fakeWindowsPort())],
    ["a rejected Promise", () => Promise.reject(new Error("late factory"))],
    ["a thenable", () => ({ then() {} })],
  ])(
    "rejects %s results with no fallback to the POSIX default",
    (_label, factory) => {
      const error = syncError(() =>
        createProductPrivatePlatform(directory, "state.sqlite", {
          privatePlatformFactory:
            factory as unknown as ProductPrivateJournalOptions["privatePlatformFactory"],
        }),
      );
      expect(error).toMatchObject({
        code: "product-private-platform-invalid",
        status: 503,
      });
    },
  );

  it("preserves a synchronous factory throw with its identity", () => {
    const cause = new Error("factory exploded");
    let actual: unknown;
    try {
      createProductPrivatePlatform(directory, "state.sqlite", {
        privatePlatformFactory: () => {
          throw cause;
        },
      });
    } catch (error) {
      actual = error;
    }
    expect(actual).toBe(cause);
  });

  it("rejects reuse of the same raw port or its facade, even after close, without closing the owner", () => {
    const raw = fakeWindowsPort();
    const factory = () => raw;
    const issued = createProductPrivatePlatform(directory, "state.sqlite", {
      privatePlatformFactory: factory,
    });
    expect(issued).toBeDefined();

    let error = syncError(() =>
      createProductPrivatePlatform(directory, "state.sqlite", {
        privatePlatformFactory: factory,
      }),
    );
    expect(error.code).toBe("product-private-platform-reused");
    expect(raw.close).not.toHaveBeenCalled();

    // Re-presenting the already issued facade is the same owner.
    error = syncError(() =>
      createProductPrivatePlatform(directory, "state.sqlite", {
        privatePlatformFactory: () => issued!,
      }),
    );
    expect(error.code).toBe("product-private-platform-reused");
    expect(raw.close).not.toHaveBeenCalled();

    // Ownership outlives close: the port must never be reissued.
    issued!.close();
    expect(raw.close).toHaveBeenCalledTimes(1);
    error = syncError(() =>
      createProductPrivatePlatform(directory, "state.sqlite", {
        privatePlatformFactory: factory,
      }),
    );
    expect(error.code).toBe("product-private-platform-reused");
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed options values rather than treating them as absent", () => {
    for (const bad of [null, [], "x", 42]) {
      const options = bad as unknown as ProductPrivateJournalOptions;
      expect(
        syncError(() =>
          createProductPrivatePlatform(directory, "state.sqlite", options),
        ).code,
      ).toBe("product-private-platform-invalid");
      expect(
        syncError(() => withProductPrivateJournals(options, () => undefined))
          .code,
      ).toBe("product-private-platform-invalid");
    }
    // An explicit malformed value never inherits the ambient context.
    const ambient = trackingFactory();
    withProductPrivateJournals(ambient.options, () => {
      expect(
        syncError(() =>
          createProductPrivatePlatform(
            directory,
            "state.sqlite",
            null as unknown as ProductPrivateJournalOptions,
          ),
        ).code,
      ).toBe("product-private-platform-invalid");
    });
    expect(ambient.calls).toHaveLength(0);
  });

  it("classifies the single cleanup attempt after failed validation strictly", () => {
    const issue = (provider: unknown) =>
      createProductPrivatePlatform(directory, "state.sqlite", {
        privatePlatformFactory: () => provider as PrivatePlatform,
      });
    const aggregate = (run: () => unknown): AggregateError => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        return error as AggregateError;
      }
      throw new Error("expected AggregateError");
    };

    // A synchronous close returning undefined is the only clean cleanup.
    const clean = { kind: "windows", close: vi.fn(() => undefined) };
    expect(syncError(() => issue(clean)).code).toBe(
      "product-private-platform-invalid",
    );
    expect(clean.close).toHaveBeenCalledTimes(1);

    // A synchronous close throw keeps its identity as the cleanup cause.
    const sentinel = new Error("close exploded");
    const throwing = {
      kind: "windows",
      close: vi.fn(() => {
        throw sentinel;
      }),
    };
    let errors = aggregate(() => issue(throwing)).errors;
    expect(errors[0]).toMatchObject({ code: "product-private-platform-invalid" });
    expect(errors[1]).toBe(sentinel);
    expect(throwing.close).toHaveBeenCalledTimes(1);

    // A nonvoid result — resolved or rejected Promise, thenable, or any
    // primitive — means the cleanup outcome is UNKNOWN. Native Promises are
    // observed so no rejection surfaces unhandled.
    const nonvoid = [
      { kind: "windows", close: vi.fn(() => Promise.resolve()) },
      {
        kind: "windows",
        close: vi.fn(() => Promise.reject(new Error("late close"))),
      },
      { kind: "windows", close: vi.fn(() => ({ then() {} })) },
      { kind: "windows", close: vi.fn(() => 42) },
    ];
    for (const provider of nonvoid) {
      errors = aggregate(() => issue(provider)).errors;
      expect(errors[0]).toMatchObject({
        code: "product-private-platform-invalid",
      });
      expect(errors[1]).toMatchObject({
        code: "product-private-platform-cleanup-unknown",
        status: 503,
      });
      expect(provider.close).toHaveBeenCalledTimes(1);
    }

    // A known asynchronous or generator close — or no close at all — is never
    // invoked; the explicit unsupported cause proves cleanup did not complete.
    // Plain async/generator methods (not vi.fn wrappers) keep their native
    // function kind so the pre-invocation check actually sees them.
    let asyncCloseCalls = 0;
    let asyncGeneratorCloseCalls = 0;
    const asyncClose = {
      kind: "windows",
      async close() {
        asyncCloseCalls += 1;
      },
    };
    const generatorClose = { kind: "windows", *close() {} };
    const asyncGeneratorClose = {
      kind: "windows",
      async *close() {
        asyncGeneratorCloseCalls += 1;
      },
    };
    const missingClose = { kind: "windows" };
    for (const provider of [
      asyncClose,
      generatorClose,
      asyncGeneratorClose,
      missingClose,
    ]) {
      errors = aggregate(() => issue(provider)).errors;
      expect(errors[0]).toMatchObject({
        code: "product-private-platform-invalid",
      });
      expect(errors[1]).toMatchObject({
        code: "product-private-platform-cleanup-unsupported",
        status: 503,
      });
    }
    expect(asyncCloseCalls).toBe(0);
    expect(asyncGeneratorCloseCalls).toBe(0);

    // An unreadable close member contributes its own exception.
    const getterError = new Error("close getter exploded");
    const poisoned = {
      kind: "windows",
      get close() {
        throw getterError;
      },
    };
    errors = aggregate(() => issue(poisoned)).errors;
    expect(errors[0]).toMatchObject({ code: "product-private-platform-invalid" });
    expect(errors[1]).toBe(getterError);
  });

  it("rejects a malformed directly-supplied port before any provider close can run", () => {
    let asyncCloseCalls = 0;
    const malformed = {
      kind: "windows",
      async close() {
        asyncCloseCalls += 1;
      },
    };
    const error = constructorAggregate(
      () =>
        new BlobTransferJournal(
          "/unused/blob-journal",
          { scopeHash: sha("scope") },
          {},
          malformed as unknown as PrivatePlatform,
        ),
    );
    expect(error.errors[0]).toMatchObject({code: "private-ledger-platform-invalid"});
    expect(error.errors[1]).toBeInstanceOf(Error);
    expect(sqliteOwnerRetainsPlatform(error)).toBe(true);
    expect(asyncCloseCalls).toBe(0);
  });
});

describe.skipIf(!POSIX)("POSIX-host journal plumbing (injected contract ports only)", () => {
  function scope(): BlobTransferScope {
    return {
      baseUrlHash: sha("http://127.0.0.1:8787"),
      workspaceId: "workspace1",
      clientId: "client1",
      bindingId: "binding1",
      serverEpoch: "epoch1",
    };
  }

  function clientOptions(
    workspace: string,
    assetsDirectory: string,
    privateJournals?: ProductPrivateJournalOptions,
  ): WorkspaceBlobClientOptions {
    const transferScope = scope();
    return {
      baseUrl: "http://127.0.0.1:8787",
      workspaceId: "workspace1",
      token: "A".repeat(64),
      assetsDirectory,
      transfer: {
        scope: transferScope,
        directory: join(
          workspace,
          ".folio-sync-transfers",
          sha(canonicalJson(transferScope)),
        ),
        workspaceDirectory: workspace,
      },
      ...(privateJournals ? { privateJournals } : {}),
    };
  }

  function journalDirectory(
    options: WorkspaceBlobClientOptions,
    direction: "download" | "upload",
  ): string {
    return join(
      options.transfer!.directory,
      `${direction}-${sha(realpathSync(options.assetsDirectory))}`,
    );
  }

  function emptyJournalFixture(workspace: string) {
    const scopeHash = sha("scope:" + randomUUID());
    const journalName = "download-" + sha("assets:" + randomUUID());
    const cacheRoot = privateDir(join(workspace, ".folio-sync-transfers"));
    const scopeDir = privateDir(join(cacheRoot, scopeHash));
    const path = privateDir(join(scopeDir, journalName));
    // A real disposable empty journal; maintenance never deletes its records.
    new BlobTransferJournal(path, { scopeHash }).close();
    return { cacheRoot, scopeDir, path, scopeHash, journalName };
  }

  function safeStorage() {
    return {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from("cipher:" + value),
      decryptString: (value: Buffer) =>
        value.toString().slice("cipher:".length),
    };
  }

  it("keeps the default POSIX path for journals, transfer functions, catalog and maintenance", async () => {
    const workspace = tempDir("folio-pj-posix-ws-");
    const assets = tempDir("folio-pj-posix-assets-");
    const options = clientOptions(workspace, assets);

    await uploadCheckpointAssets(options, []);
    await stageCheckpointAssets(options, []);
    const uploadDir = journalDirectory(options, "upload");
    const downloadDir = journalDirectory(options, "download");
    expect(existsSync(join(uploadDir, "state.sqlite"))).toBe(true);
    expect(existsSync(join(downloadDir, "state.sqlite"))).toBe(true);

    // Real reopen through the public function succeeds again.
    await uploadCheckpointAssets(options, []);

    // Direct journal write/read/close/reopen on a disposable fixture.
    const scopeHash = sha(canonicalJson(scope()));
    const journal = new BlobTransferJournal(uploadDir, { scopeHash });
    const record = journal.begin({
      direction: "upload",
      assetId: "asset-posix",
      sha256: sha("asset-posix"),
      bytes: 4,
    });
    journal.close();
    const reopened = new BlobTransferJournal(uploadDir, { scopeHash });
    try {
      expect(reopened.get(record.key)).toMatchObject({
        assetId: "asset-posix",
        state: "active",
      });
    } finally {
      reopened.close();
    }

    // Catalog sees the seeded record; maintenance view/plan/resolve work on a
    // fixture empty journal without deleting real data.
    const view = inspectTransferCacheCatalog(workspace, null);
    expect(
      view.entries.some(
        (entry) => entry.scopeHash === scopeHash && entry.state === "active",
      ),
    ).toBe(true);

    const empty = emptyJournalFixture(workspace);
    const service = new TransferMaintenanceService(workspace, () => null);
    const maintenance = await service.view();
    const entryId = `${empty.scopeHash}/${empty.journalName}/!`;
    expect(
      maintenance.entries.find((entry) => entry.entryId === entryId),
    ).toMatchObject({ state: "empty-scope", canRelease: true });
    const plan = await service.plan(entryId);
    expect(plan.operationId).toMatch(/^[a-f0-9-]{36}$/);
    const resolved = await service.resolve(plan.operationId);
    expect(resolved).toMatchObject({
      outcome: "outcome-unknown",
      reason: "release-pending",
    });
    expect(existsSync(join(empty.path, "state.sqlite"))).toBe(true);
  });

  it("issues a fresh injected port per transfer journal for upload and download across the workspaceDirectory recursion", async () => {
    const workspace = tempDir("folio-pj-inject-ws-");
    const assets = tempDir("folio-pj-inject-assets-");
    const injected = trackingFactory();
    const options = clientOptions(workspace, assets, injected.options);

    await uploadCheckpointAssets(options, []);
    await stageCheckpointAssets(options, []);
    await uploadCheckpointAssets(options, []);

    expect(injected.calls.map((call) => call.name)).toEqual([
      "state.sqlite",
      "state.sqlite",
      "state.sqlite",
    ]);
    const expected = [
      journalDirectory(options, "upload"),
      journalDirectory(options, "download"),
      journalDirectory(options, "upload"),
    ];
    expect(injected.calls.map((call) => call.directory)).toEqual(expected);
    expect(new Set(injected.ports).size).toBe(3);
    for (const port of injected.ports) {
      expect(port.bind).toHaveBeenCalledTimes(1);
      expect(port.close).toHaveBeenCalledTimes(1);
    }
    expect(
      existsSync(join(journalDirectory(options, "upload"), "state.sqlite")),
    ).toBe(true);
    expect(
      existsSync(join(journalDirectory(options, "download"), "state.sqlite")),
    ).toBe(true);
  });

  it("issues fresh ports for independent catalog opens and every maintenance ledger and journal open", async () => {
    const workspace = tempDir("folio-pj-maint-ws-");
    const fixture = emptyJournalFixture(workspace);
    const injected = trackingFactory();
    const options = injected.options;

    const catalog = inspectTransferCacheCatalog(
      workspace,
      fixture.scopeHash,
      undefined,
      options,
    );
    expect(
      catalog.entries.find(
        (entry) => entry.entryId === `${fixture.scopeHash}/${fixture.journalName}/!`,
      ),
    ).toMatchObject({ state: "empty-scope" });
    const first = await serviceCalls(workspace, options, fixture);
    expect(first.plan.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.resolved).toMatchObject({ outcome: "outcome-unknown" });
    // A second pass allocates independent owners again.
    const second = await serviceCalls(workspace, options, fixture);
    expect(second.plan.operationId).not.toBe(first.plan.operationId);

    const names = injected.calls.map((call) => call.name);
    expect(names.filter((name) => name === "cache-maintenance.sqlite").length)
      .toBeGreaterThanOrEqual(6);
    expect(names.filter((name) => name === "state.sqlite").length)
      .toBeGreaterThanOrEqual(3);
    expect(new Set(injected.ports).size).toBe(injected.ports.length);
    for (const port of injected.ports) {
      expect(port.bind).toHaveBeenCalledTimes(1);
      expect(port.close).toHaveBeenCalledTimes(1);
    }
  });

  async function serviceCalls(
    workspace: string,
    options: ProductPrivateJournalOptions,
    fixture: { scopeHash: string; journalName: string },
  ) {
    const service = new TransferMaintenanceService(
      workspace,
      () => null,
      undefined,
      options,
    );
    const view = await service.view();
    const entryId = `${fixture.scopeHash}/${fixture.journalName}/!`;
    expect(
      view.entries.find((entry) => entry.entryId === entryId),
    ).toMatchObject({ state: "empty-scope" });
    const plan = await service.plan(entryId);
    const resolved = await service.resolve(plan.operationId);
    return { plan, resolved };
  }

  it("reaches the partial and empty release journal opens with fresh ports", async () => {
    const workspace = tempDir("folio-pj-release-ws-");
    const injected = trackingFactory();
    const service = new TransferMaintenanceService(
      workspace,
      () => null,
      undefined,
      injected.options,
    );

    // Partial release: a real record plus its matching .part file.
    const partial = emptyJournalFixture(workspace);
    const seeded = new BlobTransferJournal(partial.path, {
      scopeHash: partial.scopeHash,
    });
    const record = seeded.begin({
      direction: "download",
      assetId: "asset-1",
      sha256: sha("asset-1"),
      bytes: 4,
    });
    seeded.close();
    writeFileSync(join(partial.path, record.partialName), "data", {
      mode: 0o600,
    });

    const partialPlan = await service.plan(
      `${partial.scopeHash}/${partial.journalName}/${record.key}`,
    );
    const released = await service.release(partialPlan.operationId);
    expect(released).toMatchObject({ outcome: "released", releasedBytes: 4 });
    expect(
      await service.resolve(partialPlan.operationId),
    ).toMatchObject({ outcome: "released", reason: null });
    expect(
      await service.release(partialPlan.operationId),
    ).toMatchObject({ outcome: "released" });
    expect(existsSync(join(partial.path, record.partialName))).toBe(false);
    // Journal state reconciled: the released record is gone.
    const verified = new BlobTransferJournal(partial.path, {
      scopeHash: partial.scopeHash,
    });
    try {
      expect(verified.get(record.key)).toBeNull();
      expect(verified.inventory()).toHaveLength(0);
    } finally {
      verified.close();
    }

    // Empty release: only the released fixture is removed — a sibling
    // journal and the workspace root survive.
    const survivor = emptyJournalFixture(workspace);
    const empty = emptyJournalFixture(workspace);
    const emptyPlan = await service.plan(
      `${empty.scopeHash}/${empty.journalName}/!`,
    );
    const emptied = await service.release(emptyPlan.operationId);
    expect(emptied).toMatchObject({ outcome: "released" });
    expect(existsSync(empty.path)).toBe(false);
    expect(existsSync(join(survivor.path, "state.sqlite"))).toBe(true);
    expect(existsSync(partial.path)).toBe(true);

    // plan + release opens for both fixture journals each got a fresh owner.
    expect(
      injected.calls.filter((call) => call.name === "state.sqlite").length,
    ).toBeGreaterThanOrEqual(4);
    expect(new Set(injected.ports).size).toBe(injected.ports.length);
    for (const port of injected.ports) {
      expect(port.bind).toHaveBeenCalledTimes(1);
      expect(port.close).toHaveBeenCalledTimes(1);
    }
  });

  it("reaches the prune journal open when an expired planned operation is discarded", async () => {
    const workspace = tempDir("folio-pj-prune-ws-");
    const injected = trackingFactory();
    const service = new TransferMaintenanceService(
      workspace,
      () => null,
      undefined,
      injected.options,
    );
    const fixture = emptyJournalFixture(workspace);
    const entryId = `${fixture.scopeHash}/${fixture.journalName}/!`;

    const seeded = await service.plan(entryId);
    const now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now + 181_000);
    const replanned = await service.plan(entryId);
    expect(replanned.operationId).not.toBe(seeded.operationId);

    // Separate ledger read proves the expired row was discarded.
    const ledger = new PrivateLedger(
      join(workspace, ".folio-sync-transfers"),
      "cache-maintenance.sqlite",
      "cache-maintenance",
    );
    try {
      expect(ledger.read("release:" + seeded.operationId)).toBeNull();
      expect(ledger.read("release:" + replanned.operationId)).not.toBeNull();
    } finally {
      ledger.close();
    }

    // The second plan opened the fixture journal once for the prune check
    // and once for its own planning, each through a fresh owner.
    expect(
      injected.calls.filter((call) => call.name === "state.sqlite").length,
    ).toBeGreaterThanOrEqual(3);
    for (const port of injected.ports) {
      expect(port.bind).toHaveBeenCalledTimes(1);
      expect(port.close).toHaveBeenCalledTimes(1);
    }
  });

  function transportFor(
    options: WorkspaceBlobClientOptions,
  ): WorkspaceSyncTransport<null> {
    return {
      status: () => null,
      sendPending: async () => {
        await uploadCheckpointAssets(options, []);
        return null;
      },
      receiveAndStage: async () => {
        await stageCheckpointAssets(options, []);
        return null;
      },
    };
  }

  it("scopes upload and staging through the ambient context the way the parent startup wrapper does", async () => {
    const workspace = tempDir("folio-pj-scoped-ws-");
    const assets = tempDir("folio-pj-scoped-assets-");
    const injected = trackingFactory();
    // Mirrors runStartupWorkspaceSyncDetailed reaching transferOptions()
    // objects that carry no privateJournals field of their own.
    const options = clientOptions(workspace, assets);
    expect("privateJournals" in options).toBe(false);

    await withProductPrivateJournals(injected.options, async () => {
      await uploadCheckpointAssets(options, []);
      await stageCheckpointAssets(options, []);
    });
    expect(injected.calls.length).toBe(2);
    expect(new Set(injected.ports).size).toBe(2);
    for (const port of injected.ports)
      expect(port.close).toHaveBeenCalledTimes(1);
  });

  it("scopes WorkspaceSyncService send/receive and reconnect passes, and isolates two concurrent services", async () => {
    const wsA = tempDir("folio-pj-svc-a-");
    const assetsA = tempDir("folio-pj-svc-assets-a-");
    const injectedA = trackingFactory();
    const optionsA = clientOptions(wsA, assetsA);
    const serviceA = new WorkspaceSyncService<null>(
      transportFor(optionsA),
      undefined,
      undefined,
      injectedA.options,
    );

    const wsB = tempDir("folio-pj-svc-b-");
    const assetsB = tempDir("folio-pj-svc-assets-b-");
    const injectedB = trackingFactory();
    const optionsB = clientOptions(wsB, assetsB);
    const serviceB = WorkspaceSyncService.reconnect<null>(
      async () => transportFor(optionsB),
      undefined,
      injectedB.options,
    );

    // Overlapping passes prove each service's async-local scope keeps its own
    // factory while async continuations interleave.
    const [statusA, statusB] = await Promise.all([
      serviceA.sync(),
      serviceB.sync(),
    ]);
    expect(statusA.lastError).toBeNull();
    expect(statusB.lastError).toBeNull();
    expect(injectedA.calls.length).toBe(2);
    expect(
      injectedA.calls.every((call) => call.directory.startsWith(wsA)),
    ).toBe(true);
    expect(injectedB.calls.length).toBe(2);
    expect(
      injectedB.calls.every((call) => call.directory.startsWith(wsB)),
    ).toBe(true);
    expect(injectedB.ports.some((port) => injectedA.ports.includes(port))).toBe(
      false,
    );
    for (const port of [...injectedA.ports, ...injectedB.ports]) {
      expect(port.bind).toHaveBeenCalledTimes(1);
      expect(port.close).toHaveBeenCalledTimes(1);
    }
  });

  it("settles malformed scoped options as a bounded lastError and still allows another sync", async () => {
    let sends = 0;
    const service = new WorkspaceSyncService<null>(
      {
        status: () => null,
        sendPending: async () => {
          sends += 1;
          return null;
        },
        receiveAndStage: async () => null,
      },
      undefined,
      undefined,
      [] as unknown as ProductPrivateJournalOptions,
    );
    const first = await service.sync();
    expect(first.running).toBe(false);
    expect(first.lastError).toBe("local-or-network-error");
    expect(sends).toBe(0);
    // inFlight cleared: a new pass is attempted instead of re-sharing a
    // permanently rejected promise.
    const second = await service.sync();
    expect(second.running).toBe(false);
    expect(second.lastError).toBe("local-or-network-error");
  });

  it("closes the fresh owner when journal bind or proof fails and retains close evidence", () => {
    const directory = tempDir("folio-pj-fail-journal-");
    const scopeHash = sha("scope");
    const port = fakeWindowsPort();
    const primary = new Error("bind allocated then failed");
    const cleanup = new Error("native cleanup failed");
    vi.mocked(port.bind).mockImplementation(() => {
      throw primary;
    });
    vi.mocked(port.close).mockImplementation(() => {
      throw cleanup;
    });
    let actual: unknown;
    try {
      new BlobTransferJournal(
        directory,
        { scopeHash },
        {},
        createProductPrivatePlatform(directory, "state.sqlite", {
          privatePlatformFactory: () => port,
        }),
      );
    } catch (error) {
      actual = error;
    }
    expect(actual).toBeInstanceOf(AggregateError);
    expect((actual as AggregateError).errors).toEqual([primary, cleanup]);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(existsSync(join(directory, "state.sqlite"))).toBe(false);
  });

  it("surfaces a malformed port inside the transfer call without creating a POSIX fallback journal", async () => {
    const workspace = tempDir("folio-pj-malformed-ws-");
    const assets = tempDir("folio-pj-malformed-assets-");
    const options = clientOptions(workspace, assets, {
      privatePlatformFactory: () =>
        ({ close() {} }) as unknown as PrivatePlatform,
    });
    const error = await asyncError(() => uploadCheckpointAssets(options, []));
    expect(error.code).toBe("product-private-platform-invalid");
    expect(existsSync(journalDirectory(options, "upload"))).toBe(false);
  });

  it("closes a freshly allocated port when early journal validation rejects scope or limits", async () => {
    const workspace = tempDir("folio-pj-early-ws-");
    const assets = tempDir("folio-pj-early-assets-");
    const injected = trackingFactory();
    // baseUrlHash/workspaceId stay valid so the transfer layer passes scope
    // checks and the journal constructor itself rejects the missing clientId.
    const badScope = {
      baseUrlHash: sha("http://127.0.0.1:8787"),
      workspaceId: "workspace1",
      clientId: "",
      bindingId: "binding1",
      serverEpoch: "epoch1",
    } as BlobTransferScope;
    const options = clientOptions(workspace, assets, injected.options);
    options.transfer!.scope = badScope;
    options.transfer!.directory = join(
      workspace,
      ".folio-sync-transfers",
      sha(canonicalJson(badScope)),
    );

    const error = await asyncError(() => uploadCheckpointAssets(options, []));
    expect(error.code).toBe("invalid-blob-transfer-scope");
    expect(injected.calls).toHaveLength(1);
    expect(injected.ports[0].bind).not.toHaveBeenCalled();
    expect(injected.ports[0].close).toHaveBeenCalledTimes(1);
    expect(
      existsSync(
        join(options.transfer!.directory, "upload-" + sha(realpathSync(assets))),
      ),
    ).toBe(false);

    // Direct limits validation also returns the supplied port to close.
    const limitsDir = tempDir("folio-pj-early-limits-");
    const limitsPort = fakeWindowsPort();
    const limitsError = syncError(
      () =>
        new BlobTransferJournal(
          limitsDir,
          { scopeHash: sha("scope") },
          { maxEntries: 0 },
          limitsPort,
        ),
    );
    expect(limitsError.code).toBe("invalid-blob-transfer-limits");
    expect(limitsPort.bind).not.toHaveBeenCalled();
    expect(limitsPort.close).toHaveBeenCalledTimes(1);

    // A failing cleanup is retained next to the primary validation cause.
    const cleanupDir = tempDir("folio-pj-early-cleanup-");
    const cleanupPort = fakeWindowsPort();
    const cleanupFailure = new Error("early cleanup exploded");
    vi.mocked(cleanupPort.close).mockImplementation(() => {
      throw cleanupFailure;
    });
    let actual: unknown;
    try {
      new BlobTransferJournal(
        cleanupDir,
        { scopeHash: sha("scope") },
        { maxEntries: 0 },
        cleanupPort,
      );
    } catch (caught) {
      actual = caught;
    }
    expect(actual).toBeInstanceOf(AggregateError);
    const causes = (actual as AggregateError).errors;
    expect(causes[0]).toMatchObject({ code: "invalid-blob-transfer-limits" });
    expect(causes[1]).toBe(cleanupFailure);
    expect(cleanupPort.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong-bound blob scope and ledger role through preflight without changing bytes", () => {
    const blobDir = tempDir("folio-pj-scope-blob-");
    const scopeA = sha("scope-a");
    const journal = new BlobTransferJournal(blobDir, { scopeHash: scopeA });
    journal.begin({
      direction: "download",
      assetId: "asset-kept",
      sha256: sha("asset-kept"),
      bytes: 8,
    });
    journal.close();
    const database = join(blobDir, "state.sqlite");
    const before = readFileSync(database);
    const injected = trackingFactory();
    const error = syncError(
      () =>
        new BlobTransferJournal(
          blobDir,
          { scopeHash: sha("scope-b") },
          {},
          createProductPrivatePlatform(blobDir, "state.sqlite", injected.options),
        ),
    );
    expect(error.code).toBe("blob-transfer-scope-mismatch");
    expect(readFileSync(database)).toEqual(before);
    expect(injected.ports[0].close).toHaveBeenCalledTimes(1);

    const ledgerDir = tempDir("folio-pj-scope-ledger-");
    const ledger = new PrivateLedger(ledgerDir, "role.sqlite", "alpha");
    ledger.transaction(() => ledger.write("k", "v"));
    ledger.close();
    const ledgerPath = join(ledgerDir, "role.sqlite");
    const beforeLedger = readFileSync(ledgerPath);
    const injectedLedger = trackingFactory();
    const roleError = syncError(
      () =>
        new PrivateLedger(
          ledgerDir,
          "role.sqlite",
          "beta",
          [],
          createProductPrivatePlatform(
            ledgerDir,
            "role.sqlite",
            injectedLedger.options,
          ),
        ),
    );
    expect(roleError.code).toBe("private-ledger-invalid");
    expect(readFileSync(ledgerPath)).toEqual(beforeLedger);
    expect(injectedLedger.ports[0].close).toHaveBeenCalledTimes(1);
  });

  it("lets vault and secret ledgers use only their own factory, fresh per open, inside a foreign context", async () => {
    const vaultDirectory = tempDir("folio-pj-vault-store-");
    const workspace = tempDir("folio-pj-vault-ws-");
    const forbidden = tempDir("folio-pj-vault-forbidden-");
    const database = join(workspace, "workspace.sqlite");
    writeFileSync(database, "", { mode: 0o600 });
    chmodSync(database, 0o600);
    const injected = trackingFactory();
    const trap = trackingFactory();
    const vault = new SyncConnectionVault({
      directory: vaultDirectory,
      forbiddenRoots: [forbidden],
      safeStorage: safeStorage(),
      platform: "darwin",
      assertWorkspaceAllowed: () => undefined,
      workspaceIdentity: () => "identity-1",
      privatePlatformFactory: injected.factory,
    });
    const views = withProductPrivateJournals(
      { privatePlatformFactory: trap.factory },
      () => [vault.view(database), vault.view(database)],
    );
    expect(views.every((view) => view.state === "unconfigured")).toBe(true);
    expect(trap.calls).toHaveLength(0);
    expect(injected.calls).toEqual([
      { directory: vaultDirectory, name: "connections.sqlite" },
      { directory: vaultDirectory, name: "connections.sqlite" },
    ]);
    expect(new Set(injected.ports).size).toBe(2);
    for (const port of injected.ports)
      expect(port.close).toHaveBeenCalledTimes(1);

    // A POSIX secret ledger must not inherit the ambient factory either.
    const secretsDirectory = tempDir("folio-pj-secrets-");
    const persistence = new SecretRecordLedgerPersistence({
      directory: secretsDirectory,
    });
    const key = syncSecretKey({
      baseUrl: "http://127.0.0.1:8787",
      workspaceId: "workspace1",
      clientId: "client1",
      bindingId: "binding1",
      serverEpoch: "epoch1",
    });
    const ciphertext = new Uint8Array(Buffer.from("sealed-unit"));
    await withProductPrivateJournals(
      { privatePlatformFactory: trap.factory },
      async () => {
        await persistence.write(key, ciphertext);
        expect(await persistence.read(key)).toEqual(ciphertext);
      },
    );
    expect(trap.calls.length).toBe(0);
    expect(existsSync(join(secretsDirectory, "secrets.sqlite"))).toBe(true);
  });

  it("opens the secret record ledger through its own factory with a fresh port per open", async () => {
    const secretsDirectory = tempDir("folio-pj-secrets-own-");
    const injected = trackingFactory();
    const persistence = new SecretRecordLedgerPersistence({
      directory: secretsDirectory,
      privatePlatformFactory: injected.factory,
    });
    const key = syncSecretKey({
      baseUrl: "http://127.0.0.1:8787",
      workspaceId: "workspace1",
      clientId: "client1",
      bindingId: "binding1",
      serverEpoch: "epoch1",
    });
    const ciphertext = new Uint8Array(Buffer.from("sealed-unit"));
    await persistence.write(key, ciphertext);
    expect(await persistence.read(key)).toEqual(ciphertext);
    await persistence.read(key);
    expect(injected.calls).toEqual([
      { directory: secretsDirectory, name: "secrets.sqlite" },
      { directory: secretsDirectory, name: "secrets.sqlite" },
      { directory: secretsDirectory, name: "secrets.sqlite" },
    ]);
    expect(new Set(injected.ports).size).toBe(3);
    for (const port of injected.ports) {
      expect(port.bind).toHaveBeenCalledTimes(1);
      expect(port.close).toHaveBeenCalledTimes(1);
    }
    expect(existsSync(join(secretsDirectory, "secrets.sqlite"))).toBe(true);
  });
});
