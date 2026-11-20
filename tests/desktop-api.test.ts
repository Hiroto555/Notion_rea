import { describe, expect, it } from "vitest";
import {
  createDesktopRootBindings,
  type DesktopCompatibility,
} from "../src/renderer/desktop-api";
import type { AppApi, ReadOnlyAppApi } from "../src/shared/app-api";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { createSharedRuntimeBridge } from "../src/preload/shared-runtime-queue";
import { StorageFailureError } from "../src/renderer/private-request";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import type { SharedRuntimeRequest } from "../src/shared/shared-runtime-ipc";
import {
  blankDoc,
  emptyDatabase,
  type FolioAPI,
  type Page,
  type Request,
  type Snapshot,
} from "../src/shared/types";

const roundtrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const okReply = (
  valueSlot: { present: false } | { present: true; value: unknown },
): unknown =>
  roundtrip({ tag: "folio-request-result", version: 1, ok: true, valueSlot });
const failureReply = (failure: unknown): unknown =>
  roundtrip({ tag: "folio-request-result", version: 1, ok: false, failure });
const rejected = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("unexpected resolve");
    },
    (error: unknown) => error,
  );

function unclassified(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return {
    version: 1,
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    failureSubject: "UNIDENTIFIED",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType: "load",
    sourceOutcome: null,
    sourceCauseCodes: [],
    causeSummaryIncomplete: true,
    attemptId: null,
    precondition: null,
    operationProgress: "PARTIAL_OR_UNKNOWN",
    retryAuthority: "NONE",
    preserve: true,
    ...overrides,
  };
}

/** A real preload pair: the production v1 preload adapter in front of a fake
 * invoke, plus a legacy channel that only counts calls so any fallback would
 * be observed. */
function rootBridge(
  invoke: (request: Request) => unknown | Promise<unknown>,
  shared?: FolioAPI["shared"],
) {
  const sent: Request[] = [];
  let legacyCalls = 0;
  const preload = createPrivateRequestPreload(async (request) => {
    sent.push(request);
    return invoke(request);
  });
  const bridge: Pick<FolioAPI, "requestDiagnostic" | "shared"> & {
    request: FolioAPI["request"];
  } = {
    requestDiagnostic: preload.requestDiagnostic,
    request: async <T>(request: Request): Promise<T> => {
      legacyCalls += 1;
      return request as unknown as T;
    },
    ...(shared !== undefined ? { shared } : {}),
  };
  return { bridge, sent, legacyCalls: () => legacyCalls };
}

const healthyPage = (overrides: Partial<Page> = {}): Page => ({
  id: "page-1",
  parentId: null,
  title: "メモ",
  icon: "📄",
  cover: "",
  position: 0,
  doc: blankDoc(),
  kind: "page",
  database: null,
  favorite: false,
  createdAt: 1,
  updatedAt: 2,
  revision: 3,
  deletedAt: null,
  ...overrides,
});
const recordProjection = () => ({
  pageId: "rec-1",
  databasePageId: "db-1",
  revision: 2,
  title: "レコード",
  icon: "🗂",
  values: { status: "進行中", count: 3, done: false },
  deletedAt: null,
});
const legalSnapshot = (overrides: Partial<Snapshot> = {}): Snapshot =>
  ({
    pages: [healthyPage()],
    settings: { theme: "light", activePage: "page-1" },
    ...overrides,
  }) as Snapshot;

const expectSafeE = async (
  promise: Promise<unknown>,
  requestType: string,
): Promise<StorageFailureError> => {
  const error = await rejected(promise);
  expect(error).toBeInstanceOf(StorageFailureError);
  const failure = (error as StorageFailureError).storageFailure;
  expect(failure).toMatchObject({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType,
    retryAuthority: "NONE",
    preserve: true,
  });
  return error as StorageFailureError;
};

describe("createDesktopRootBindings factory shape", () => {
  it("never invokes the bridge and never throws synchronously, even when absent", () => {
    let invokes = 0;
    const { bridge } = rootBridge(async () => {
      invokes += 1;
      return okReply({ present: false });
    });
    const bindings = createDesktopRootBindings(bridge);
    expect(invokes).toBe(0);
    expect(() => createDesktopRootBindings(undefined)).not.toThrow();
  });

  it("exposes only the typed fields: workspace on read-only, workspace+shared on writable, compat apart", () => {
    const shared = createSharedRuntimeBridge(async (input) => input);
    const { bridge } = rootBridge(async () => okReply({ present: false }), shared);
    const bindings = createDesktopRootBindings(bridge);
    expect(Object.keys(bindings.readOnly).sort()).toEqual([
      "capabilities",
      "original",
      "recovery",
      "workspace",
    ]);
    expect(Object.keys(bindings.writable).sort()).toEqual([
      "capabilities",
      "conflict",
      "editing",
      "original",
      "recovery",
      "shared",
      "storage",
      "structure",
      "sync",
      "workspace",
    ]);
    expect(Object.keys(bindings.readOnly.workspace).sort()).toEqual([
      "load",
      "loadDatabase",
      "readDatabase",
      "readRecord",
      "startupStatus",
    ]);
    expect(Object.keys(bindings.readOnly.original).sort()).toEqual([
      "exportOriginal",
      "exportWorkspaceMarkdown",
      "readOriginal",
    ]);
    expect(Object.keys(bindings.readOnly.recovery).sort()).toEqual([
      "salvageRaw",
    ]);
    expect(Object.keys(bindings.readOnly.capabilities).sort()).toEqual([
      "read",
    ]);
    expect(Object.keys(bindings.writable.storage).sort()).toEqual([
      "readPressure",
    ]);
    expect(Object.keys(bindings.writable.conflict).sort()).toEqual([
      "decision",
      "exportCandidate",
      "inspect",
      "readCandidate",
    ]);
    expect(Object.keys(bindings.writable.conflict.decision).sort()).toEqual([
      "cancel",
      "confirm",
      "preview",
      "status",
    ]);
    expect(Object.keys(bindings.writable.editing).sort()).toEqual([
      "commitDatabase",
      "commitSave",
      "resolveDatabase",
      "resolveSave",
    ]);
    expect(Object.keys(bindings.writable.structure).sort()).toEqual([
      "commitMigration",
      "commitProperty",
      "previewMigration",
      "previewProperty",
      "resolveMigration",
      "resolveProperty",
    ]);
    expect(Object.keys(bindings.compatibility).sort()).toEqual(["request"]);
    expect(bindings.readOnly.workspace).toBe(bindings.writable.workspace);
    expect(bindings.readOnly.original).toBe(bindings.writable.original);
    expect(bindings.readOnly.recovery).toBe(bindings.writable.recovery);
    expect(bindings.readOnly.capabilities).toBe(bindings.writable.capabilities);
    expect(bindings.writable.editing).toBe(bindings.writable.editing);
    expect(bindings.writable.structure).toBe(bindings.writable.structure);
    expect(bindings.compatibility).not.toBe(bindings.readOnly);
    expect(bindings.compatibility).not.toBe(bindings.writable);
    expect(bindings.writable.shared).toBe(shared);
  });

  it("treats a missing or malformed shared bridge as unavailable without substituting a port", () => {
    const { bridge } = rootBridge(async () => okReply({ present: false }));
    expect(createDesktopRootBindings(undefined).writable.shared).toBeUndefined();
    expect(
      createDesktopRootBindings({ ...bridge, shared: undefined }).writable
        .shared,
    ).toBeUndefined();
    expect(
      createDesktopRootBindings({
        ...bridge,
        shared: {} as FolioAPI["shared"],
      }).writable.shared,
    ).toBeUndefined();
    expect(
      createDesktopRootBindings({
        ...bridge,
        shared: { request: "not-a-function" } as unknown as FolioAPI["shared"],
      }).writable.shared,
    ).toBeUndefined();
  });

  it("keeps the common API free of the compat transport at the type level", () => {
    const bindings = createDesktopRootBindings(undefined);
    const readOnlyApi: ReadOnlyAppApi = bindings.readOnly;
    const appApi: AppApi = bindings.writable;
    const compat: DesktopCompatibility = bindings.compatibility;
    // @ts-expect-error the common API exposes no generic request transport
    void readOnlyApi.request;
    // @ts-expect-error read-only bindings carry no shared runtime
    void readOnlyApi.shared;
    // @ts-expect-error the common API exposes no generic request transport
    void appApi.request;
    // @ts-expect-error read-only bindings carry no write or editing ports
    void readOnlyApi.workspace.save;
    // @ts-expect-error read-only bindings carry no write or editing ports
    void readOnlyApi.editing;
    // @ts-expect-error read-only bindings carry no write or editing ports
    void readOnlyApi.structure;
    // @ts-expect-error read-only bindings carry no write or editing ports
    void readOnlyApi.sync;
    // @ts-expect-error the writable-only storage port is absent here
    void readOnlyApi.storage;
    // @ts-expect-error the writable-only conflict port is absent here
    void readOnlyApi.conflict;
    if (false) {
      // @ts-expect-error purpose methods take no request argument
      void readOnlyApi.original.readOriginal({ type: "pageSource" });
      // @ts-expect-error purpose methods take no request argument
      void readOnlyApi.original.exportOriginal({ type: "export" });
      // @ts-expect-error purpose methods take no request argument
      void readOnlyApi.recovery.salvageRaw({ type: "storage:rawSalvage" });
      // @ts-expect-error purpose methods take no request argument
      void readOnlyApi.capabilities.read({ type: "desktop:capabilities" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.storage.readPressure({ type: "storage:pressure" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.workspace.load({ type: "load" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.workspace.startupStatus({ type: "startup:status" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.workspace.readDatabase({ type: "database:read" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.workspace.loadDatabase({ type: "database:load" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.workspace.readRecord({ type: "record:read" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.editing.commitSave({ type: "save:commit" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.editing.resolveDatabase({ type: "database:resolve" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.structure.previewMigration({ type: "migration:preview" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.structure.commitProperty({ type: "property:commit" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.conflict.inspect({ type: "sync:conflict" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.conflict.decision.status({ type: "sync:conflictDecisionStatus" });
      // @ts-expect-error purpose methods take no request argument
      void appApi.conflict.decision.confirm({ type: "sync:conflictConfirm", previewId: "p" });
    }
    void compat;
  });
});

describe("workspace.startupStatus", () => {
  it("returns a legal status payload unchanged through the real v1 adapter", async () => {
    for (const status of [
      { mode: "writable" },
      { mode: "readOnly", message: "容量が不足しています。" },
      { mode: "writable", syncMessage: "" },
      { mode: "writable", message: "", syncMessage: "同期を保留しています。" },
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: status }),
      );
      const bindings = createDesktopRootBindings(bridge);
      const value = await bindings.readOnly.workspace.startupStatus();
      expect(value).toEqual(status);
      expect(sent).toEqual([{ type: "startup:status" }]);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("rejects unknown modes, falsy values and non-string messages as a bounded E — once, no fallback", async () => {
    const invalid: unknown[] = [
      { mode: "bogus" },
      { mode: null },
      { mode: 1 },
      { mode: true },
      { mode: "writable", message: 42 },
      { mode: "readOnly", syncMessage: { text: "x" } },
      { notMode: "writable" },
      null,
      false,
      0,
      "",
      "writable",
      undefined,
    ];
    for (const status of invalid) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: status }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.readOnly.workspace.startupStatus(),
        "startup:status",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("does not let an own __proto__ key satisfy a missing required field", async () => {
    const injected = Object.fromEntries([
      ["__proto__", { mode: "writable", syncMessage: "injected" }],
    ]);
    const { bridge, sent, legacyCalls } = rootBridge(async () =>
      okReply({ present: true, value: injected }),
    );
    const bindings = createDesktopRootBindings(bridge);
    await expectSafeE(
      bindings.readOnly.workspace.startupStatus(),
      "startup:status",
    );
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  });

  it("never executes accessors and never converts an invalid status into an empty success", async () => {
    let getterCalls = 0;
    const accessorStatus: Record<string, unknown> = {};
    Object.defineProperty(accessorStatus, "mode", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "writable";
      },
    });
    const { bridge, sent, legacyCalls } = rootBridge(
      async () =>
        ({
          tag: "folio-request-result",
          version: 1,
          ok: true,
          valueSlot: { present: true, value: accessorStatus },
        }) as const,
    );
    const bindings = createDesktopRootBindings(bridge);
    await expectSafeE(
      bindings.readOnly.workspace.startupStatus(),
      "startup:status",
    );
    expect(getterCalls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  });

  it("fails closed on transport rejection and malformed envelopes with one invoke", async () => {
    for (const invoke of [
      async () => {
        throw new Error("raw transport /Users/alice/secret");
      },
      async () => ({ unexpected: true }),
      async () => failureReply({ kind: "OUTCOME_UNKNOWN" }),
    ] as const) {
      const { bridge, sent, legacyCalls } = rootBridge(invoke);
      const bindings = createDesktopRootBindings(bridge);
      const error = await expectSafeE(
        bindings.readOnly.workspace.startupStatus(),
        "startup:status",
      );
      expect(error.message).not.toContain("secret");
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });
});

describe("workspace.load", () => {
  it("returns legal snapshots unchanged: plain, records and legacy optional fields missing", async () => {
    const snapshots: Snapshot[] = [
      legalSnapshot(),
      legalSnapshot({
        records: [recordProjection()],
        recordDatabaseIds: ["db-1"],
      }),
      legalSnapshot({ pages: [] , settings: {} }),
      legalSnapshot({
        pages: [
          healthyPage({ id: "a", position: 2 }),
          healthyPage({ id: "b", position: 1, width: "wide", schemaVersion: 1 }),
        ],
      }),
    ];
    for (const snapshot of snapshots) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: snapshot }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(await bindings.writable.workspace.load()).toEqual(snapshot);
      expect(sent).toEqual([{ type: "load" }]);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("keeps own __proto__ data as data: injected fields fail, a legitimate string cell passes", async () => {
    const injectedShell = Object.fromEntries([
      ["__proto__", { pages: [], settings: {} }],
    ]);
    const injectedSettings = legalSnapshot({
      settings: Object.fromEntries([
        ["__proto__", { theme: 7 }],
        ["theme", "light"],
      ]) as unknown as Record<string, string>,
    });
    const injectedRecord = legalSnapshot({
      records: [
        {
          ...recordProjection(),
          values: Object.fromEntries([
            ["__proto__", { injected: true }],
            ["status", "x"],
          ]),
        },
      ] as unknown as Snapshot["records"],
    });
    for (const value of [injectedShell, injectedSettings, injectedRecord]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(bindings.writable.workspace.load(), "load");
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
    // Object.fromEntries is what the real settings producer emits, so an own
    // `__proto__` string cell is legitimate wire data and must be preserved.
    const legitimate = legalSnapshot({
      settings: Object.fromEntries([
        ["__proto__", "dark"],
        ["theme", "light"],
      ]),
    });
    const { bridge } = rootBridge(async () =>
      okReply({ present: true, value: legitimate }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(await bindings.writable.workspace.load()).toEqual(legitimate);
  });

  it("keeps quarantined documentError pages as a legal read shape without touching preserved content", async () => {
    const quarantined = {
      ...healthyPage({ id: "corrupt-1" }),
      documentError:
        "未対応または不正な文書です。原本を保全し、編集を停止しています。",
      doc: "not-a-document-at-all",
    } as unknown as Page;
    const { doc: _dropped, ...withoutDoc } = quarantined as Page & {
      doc: unknown;
    };
    const blocked = {
      ...healthyPage({ id: "blocked-2", kind: "database" }),
      documentError:
        "関連するレコードまたはデータベースを読めません。原本を保全し、編集を停止しています。",
      database: { anything: "preserved-for-raw-export" },
    } as unknown as Page;
    const snapshot = legalSnapshot({
      pages: [quarantined, withoutDoc as Page, blocked],
    });
    const { bridge } = rootBridge(async () =>
      okReply({ present: true, value: snapshot }),
    );
    const bindings = createDesktopRootBindings(bridge);
    const result = await bindings.writable.workspace.load();
    expect(result).toEqual(snapshot);
    expect(result.pages[0].documentError).toContain("原本を保全");
  });

  it("keeps quarantined reads legal next to a healthy page while requiring the row metadata Store guarantees", async () => {
    const quarantine = (overrides: Record<string, unknown>): Page =>
      ({
        ...healthyPage({ id: "q-1" }),
        documentError:
          "未対応または不正な文書です。原本を保全し、編集を停止しています。",
        ...overrides,
      }) as unknown as Page;
    const preservedCauses = quarantine({
      schemaVersion: 99,
      width: "huge",
      doc: { type: "unknownNode", marks: [{ weird: true }] },
    });
    const { doc: _droppedDoc, ...missingDoc } = quarantine({ id: "q-2" });
    const nullDoc = quarantine({ id: "q-3", doc: null });
    const snapshot = legalSnapshot({
      pages: [
        preservedCauses,
        missingDoc as Page,
        nullDoc,
        healthyPage({ id: "alive" }),
      ],
    });
    const { bridge } = rootBridge(async () =>
      okReply({ present: true, value: snapshot }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(await bindings.writable.workspace.load()).toEqual(snapshot);
  });

  it("rejects quarantined pages whose required row metadata is missing or malformed", async () => {
    const base = {
      ...healthyPage({ id: "q" }),
      documentError: "原本を保全しています。",
    };
    const cases: unknown[] = [
      { id: "only-id", documentError: "原本を保全しています。" },
      { ...base, title: 9 },
      { ...base, title: null },
      { ...base, icon: 4 },
      { ...base, cover: null },
      { ...base, parentId: 4 },
      { ...base, kind: "record" },
      { ...base, favorite: "yes" },
      { ...base, position: "0" },
      { ...base, revision: "3" },
      { ...base, revision: 1.5 },
      { ...base, createdAt: -1 },
      { ...base, updatedAt: "now" },
      { ...base, deletedAt: "x" },
      { ...base, deletedAt: -1 },
      { ...base, database: "corrupt" },
      { ...base, documentError: 9 },
    ];
    for (const page of cases) {
      const snapshot = legalSnapshot({
        pages: [page as Page, healthyPage({ id: "alive" })],
      });
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: snapshot }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(bindings.writable.workspace.load(), "load");
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("rejects a healthy database that is not the existing DatabaseData structure and keeps a real producer value", async () => {
    const malformed: unknown[] = [
      { ...emptyDatabase(), properties: "not-an-array" },
      { ...emptyDatabase(), rows: "not-an-array" },
      { ...emptyDatabase(), views: "not-an-array" },
      { ...emptyDatabase(), activeViewId: 7 },
      { ...emptyDatabase(), schemaVersion: 3 },
      "not-a-database",
      [],
    ];
    for (const database of malformed) {
      const snapshot = legalSnapshot({
        pages: [
          {
            ...healthyPage({ id: "db-bad", kind: "database" }),
            database,
          } as unknown as Page,
        ],
      });
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: snapshot }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(bindings.writable.workspace.load(), "load");
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
    const good = legalSnapshot({
      pages: [
        healthyPage({
          id: "db-ok",
          kind: "database",
          database: emptyDatabase(),
        }),
      ],
    });
    const { bridge } = rootBridge(async () =>
      okReply({ present: true, value: good }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(await bindings.writable.workspace.load()).toEqual(good);
  });

  it("rejects invalid snapshot shells and fields as a bounded E — no empty success, resend or legacy call", async () => {
    const invalid: unknown[] = [
      null,
      false,
      0,
      "",
      [],
      "snapshot",
      {},
      { pages: {} },
      { pages: [healthyPage()], settings: "nope" },
      { pages: [healthyPage()], settings: { theme: 7 } },
      legalSnapshot({ records: {} as unknown as Snapshot["records"] }),
      legalSnapshot({
        records: [
          { ...recordProjection(), values: { a: {} } },
        ] as unknown as Snapshot["records"],
      }),
      legalSnapshot({
        records: [
          { ...recordProjection(), deletedAt: "x" },
        ] as unknown as Snapshot["records"],
      }),
      legalSnapshot({
        recordDatabaseIds: ["db-1", 9] as unknown as string[],
      }),
      legalSnapshot({ pages: [{ ...healthyPage(), id: "" }] }),
      legalSnapshot({
        pages: [{ ...healthyPage(), parentId: 4 } as unknown as Page],
      }),
      legalSnapshot({
        pages: [{ ...healthyPage(), kind: "record" } as unknown as Page],
      }),
      legalSnapshot({ pages: [{ ...healthyPage(), revision: 1.5 }] }),
      legalSnapshot({ pages: [{ ...healthyPage(), deletedAt: -1 }] }),
      legalSnapshot({
        pages: [
          {
            ...healthyPage(),
            doc: { type: "doc", content: "x" },
          } as unknown as Page,
        ],
      }),
      legalSnapshot({
        pages: [{ ...healthyPage(), database: "corrupt" } as unknown as Page],
      }),
      legalSnapshot({
        pages: [{ ...healthyPage(), documentError: 9 } as unknown as Page],
      }),
    ];
    for (const snapshot of invalid) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: snapshot }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(bindings.writable.workspace.load(), "load");
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("fails closed on getter- and trap-bearing carriers without executing them", async () => {
    let getterCalls = 0;
    const accessorSnapshot: Record<string, unknown> = {
      pages: [],
      settings: {},
    };
    Object.defineProperty(accessorSnapshot, "records", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    const getterPage: Record<string, unknown> = { ...healthyPage() };
    Object.defineProperty(getterPage, "revision", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 3;
      },
    });
    const getterDocPage = {
      ...healthyPage({ id: "getter-doc" }),
      doc: {
        type: "doc",
        get content() {
          getterCalls += 1;
          return [];
        },
      },
    } as unknown as Page;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("proto trap /Users/alice/secret");
        },
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap /Users/alice/secret");
        },
        get() {
          throw new Error("get trap /Users/alice/secret");
        },
      },
    );
    for (const value of [
      accessorSnapshot,
      legalSnapshot({ pages: [getterPage as unknown as Page] }),
      legalSnapshot({ pages: [getterDocPage] }),
      proxy,
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(
        async () =>
          ({
            tag: "folio-request-result",
            version: 1,
            ok: true,
            valueSlot: { present: true, value },
          }) as const,
      );
      const bindings = createDesktopRootBindings(bridge);
      const error = await expectSafeE(bindings.writable.workspace.load(), "load");
      expect(error.message).not.toContain("secret");
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects transport failures once and still lets the next call succeed on its own invoke", async () => {
    let ok = false;
    const { bridge, sent, legacyCalls } = rootBridge(async () =>
      ok ? okReply({ present: true, value: legalSnapshot() }) : Promise.reject(new Error("down")),
    );
    const bindings = createDesktopRootBindings(bridge);
    await expectSafeE(bindings.writable.workspace.load(), "load");
    ok = true;
    expect(await bindings.writable.workspace.load()).toEqual(legalSnapshot());
    expect(sent).toHaveLength(2);
    expect(legacyCalls()).toBe(0);
  });
});

describe("compatibility transport", () => {
  const settingRequest: Request = {
    type: "setting",
    key: "theme",
    value: "dark",
  };

  it("keeps U5 semantics for void and falsy successes and validated typed failures", async () => {
    {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: false }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(
        await bindings.compatibility.request<unknown>(settingRequest),
      ).toBeUndefined();
      expect(sent).toEqual([settingRequest]);
      expect(legacyCalls()).toBe(0);
    }
    for (const value of [null, false, 0, ""] as const) {
      const { bridge } = rootBridge(async () =>
        okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(
        await bindings.compatibility.request<unknown>(settingRequest),
      ).toBe(value);
    }
    const dto = unclassified({ requestType: "setting" });
    const { bridge, legacyCalls } = rootBridge(async () => failureReply(dto));
    const bindings = createDesktopRootBindings(bridge);
    const error = await rejected(
      bindings.compatibility.request<unknown>(settingRequest),
    );
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toEqual(dto);
    expect(legacyCalls()).toBe(0);
  });

  it("fails closed on a missing bridge or an old preload without any legacy call", async () => {
    {
      const bindings = createDesktopRootBindings(undefined);
      const error = await expectSafeE(
        bindings.compatibility.request<unknown>(settingRequest),
        "setting",
      );
      expect(error.storageFailure.requestType).toBe("setting");
    }
    let legacyCalls = 0;
    const oldPreload = {
      request: async (request: Request): Promise<unknown> => {
        legacyCalls += 1;
        return request;
      },
    };
    const bindings = createDesktopRootBindings(
      oldPreload as unknown as Pick<FolioAPI, "requestDiagnostic" | "shared">,
    );
    await expectSafeE(
      bindings.compatibility.request<unknown>(settingRequest),
      "setting",
    );
    await expectSafeE(bindings.readOnly.workspace.startupStatus(), "startup:status");
    await expectSafeE(bindings.writable.workspace.load(), "load");
    expect(legacyCalls).toBe(0);
  });

  it("calls the injected bridge method with the bridge as receiver", async () => {
    let receiver: unknown;
    let invokes = 0;
    const bridge = {
      marker: "the-bridge",
      requestDiagnostic(
        this: { marker: string },
        _request: Request,
      ): Promise<unknown> {
        invokes += 1;
        receiver = this;
        return Promise.resolve(okReply({ present: false }));
      },
    };
    const bindings = createDesktopRootBindings(bridge);
    await bindings.compatibility.request<unknown>(settingRequest);
    expect(invokes).toBe(1);
    expect(receiver).toBe(bridge);
  });
});

describe("shared runtime reference", () => {
  const listRequest: SharedRuntimeRequest = { type: "list" };

  it("passes the same object through to writable.shared and keeps FIFO + recovery after rejection", async () => {
    const inputs: SharedRuntimeRequest[] = [];
    const resolvers: {
      input: SharedRuntimeRequest;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
    }[] = [];
    const shared = createSharedRuntimeBridge(
      (input) =>
        new Promise((resolve, reject) => {
          inputs.push(input);
          resolvers.push({ input, resolve, reject });
        }),
    );
    const { bridge, legacyCalls } = rootBridge(async () =>
      okReply({ present: false }), shared);
    const bindings = createDesktopRootBindings(bridge);
    expect(bindings.writable.shared).toBe(shared);
    const api = bindings.writable.shared!;

    const pending = Array.from({ length: 64 }, () => api.request(listRequest));
    await expect(api.request(listRequest)).rejects.toThrow("SHARED_QUEUE_FULL");

    resolvers[0].reject(new Error("first transport"));
    await expect(pending[0]).rejects.toThrow("first transport");
    for (let index = 1; index < 64; index += 1) {
      while (resolvers.length <= index)
        await new Promise((resolve) => setImmediate(resolve));
      resolvers[index].resolve({ index });
      await expect(pending[index]).resolves.toEqual({ index });
    }
    expect(legacyCalls()).toBe(0);

    const next = api.request({ type: "connections" });
    while (resolvers.length <= 64)
      await new Promise((resolve) => setImmediate(resolve));
    resolvers[64].resolve({ connections: [] });
    await expect(next).resolves.toEqual({ connections: [] });
  });

  it("sends a detached clone, not the caller's object", async () => {
    const seen: SharedRuntimeRequest[] = [];
    const shared = createSharedRuntimeBridge(async (input) => {
      seen.push(input);
      return null;
    });
    const { bridge } = rootBridge(async () => okReply({ present: false }), shared);
    const api = createDesktopRootBindings(bridge).writable.shared!;
    const request: SharedRuntimeRequest = { type: "connections" };
    await api.request(request);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(request);
    expect(seen[0]).not.toBe(request);
  });
});
