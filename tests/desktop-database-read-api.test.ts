import { describe, expect, it } from "vitest";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { StorageFailureError } from "../src/renderer/private-request";
import { validateRecordReadSnapshot } from "../src/renderer/record-save-coordinator";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { commitDatabaseOperation } from "../src/persistence/database-operations";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { saveFixture } from "./fixtures/r4-save-fixture";
import type {
  RecordReadSnapshot,
  WorkspaceReadPort,
} from "../src/shared/app-api";
import type { DatabaseReadSnapshot } from "../src/shared/database-operation";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import type {
  DatabaseProjection,
  FolioAPI,
  Request,
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
  };
  return { bridge, sent, legacyCalls: () => legacyCalls };
}

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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Fixture = ReturnType<typeof saveFixture>;

/** The exact values the disposable Store emits for the three discriminants. */
function producerReads(f: Fixture): {
  databaseRead: DatabaseReadSnapshot;
  databaseLoad: DatabaseProjection;
  recordRead: RecordReadSnapshot;
} {
  return {
    databaseRead: f.store.handle({
      type: "database:read",
      databasePageId: f.owner.id,
    }) as DatabaseReadSnapshot,
    databaseLoad: f.store.handle({
      type: "database:load",
      databasePageId: f.owner.id,
    }) as DatabaseProjection,
    recordRead: f.store.handle({
      type: "record:read",
      pageId: f.record.pageId,
    }) as RecordReadSnapshot,
  };
}

describe("workspace database/record read ports", () => {
  it("returns the disposable Store producer values unchanged through the v1 lane", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f);
      expect(produced.databaseRead.page.id).toBe(f.owner.id);
      expect(produced.databaseRead.page.kind).toBe("database");
      expect(
        produced.databaseRead.database.records.map((r) => r.pageId),
      ).toContain(f.record.pageId);
      expect(
        produced.databaseLoad.records.map((r) => r.pageId),
      ).toContain(f.record.pageId);
      expect(produced.recordRead.page.id).toBe(f.record.pageId);
      expect(produced.recordRead.page.kind).toBe("page");
      expect(produced.recordRead.record.pageId).toBe(f.record.pageId);
      expect(produced.recordRead.record.databasePageId).toBe(f.owner.id);

      const cases: {
        request: Request;
        produced: unknown;
        run: (workspace: WorkspaceReadPort) => Promise<unknown>;
      }[] = [
        {
          request: { type: "database:read", databasePageId: f.owner.id },
          produced: produced.databaseRead,
          run: (workspace) => workspace.readDatabase(f.owner.id),
        },
        {
          request: { type: "database:load", databasePageId: f.owner.id },
          produced: produced.databaseLoad,
          run: (workspace) => workspace.loadDatabase(f.owner.id),
        },
        {
          request: { type: "record:read", pageId: f.record.pageId },
          produced: produced.recordRead,
          run: (workspace) => workspace.readRecord(f.record.pageId),
        },
      ];
      for (const entry of cases) {
        const { bridge, sent, legacyCalls } = rootBridge(async (request) => {
          expect(request).toEqual(entry.request);
          return okReply({ present: true, value: roundtrip(entry.produced) });
        });
        const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
        expect(await entry.run(workspace)).toEqual(entry.produced);
        // A second call is a second single invoke — nothing is cached, merged
        // or answered from a different discriminant.
        expect(await entry.run(workspace)).toEqual(entry.produced);
        expect(sent).toEqual([entry.request, entry.request]);
        expect(legacyCalls()).toBe(0);
      }
    } finally {
      f.dispose();
    }
  });

  it("serves an operation-created database and keeps an unregistered legacy owner unreadable", async () => {
    const f = saveFixture();
    try {
      // New lane: the createDatabase operation registers its own owner.
      const created = commitDatabaseOperation(
        f.store,
        prepareDatabaseCreation("New DB"),
      );
      expect(created.status).toBe("applied");
      const newOwnerId = created.page!.id;
      for (const [run, request, produced] of [
        [
          (workspace: WorkspaceReadPort) => workspace.readDatabase(newOwnerId),
          { type: "database:read", databasePageId: newOwnerId },
          f.store.handle({
            type: "database:read",
            databasePageId: newOwnerId,
          }),
        ],
        [
          (workspace: WorkspaceReadPort) => workspace.loadDatabase(newOwnerId),
          { type: "database:load", databasePageId: newOwnerId },
          f.store.handle({
            type: "database:load",
            databasePageId: newOwnerId,
          }),
        ],
      ] as const) {
        const { bridge, sent, legacyCalls } = rootBridge(async () =>
          okReply({ present: true, value: roundtrip(produced) }),
        );
        const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
        expect(await run(workspace)).toEqual(produced);
        expect(sent).toEqual([request]);
        expect(legacyCalls()).toBe(0);
      }

      // Old lane: a database Page that never went through record registration
      // stays unreadable — the producer refuses and the port surfaces safeE.
      // create() auto-registers on this v4 fixture, so drop the registration
      // row to restore the never-registered legacy state.
      const legacy = f.store.create(null, "database", "Legacy");
      f.store.db
        .prepare("DELETE FROM record_databases WHERE database_page_id=?")
        .run(legacy.id);
      expect(() =>
        f.store.handle({ type: "database:read", databasePageId: legacy.id }),
      ).toThrow();
      expect(() =>
        f.store.handle({ type: "database:load", databasePageId: legacy.id }),
      ).toThrow();
      for (const requestType of ["database:read", "database:load"] as const) {
        const { bridge, sent, legacyCalls } = rootBridge(async () =>
          failureReply(unclassified({ requestType })),
        );
        const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
        const promise =
          requestType === "database:read"
            ? workspace.readDatabase(legacy.id)
            : workspace.loadDatabase(legacy.id);
        await expectSafeE(promise, requestType);
        expect(sent).toHaveLength(1);
        expect(legacyCalls()).toBe(0);
      }
    } finally {
      f.dispose();
    }
  });

  it("keeps a legacy single-view settings payload instead of normalizing it away", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f);
      // The pre-v2 shape the store can still emit: schemaVersion 1, one
      // view/filter/sort triple and no views collection.
      const legacySettings = {
        schemaVersion: 1,
        properties: produced.databaseLoad.settings.properties,
        view: "table",
        filter: "",
        sort: "",
      };
      const legacyLoad = {
        ...produced.databaseLoad,
        settings: legacySettings,
      };
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: roundtrip(legacyLoad) }),
      );
      const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
      expect(await workspace.loadDatabase(f.owner.id)).toEqual(legacyLoad);
      expect(sent).toEqual([
        { type: "database:load", databasePageId: f.owner.id },
      ]);
      expect(legacyCalls()).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("returns the atomic record pair and leaves owner binding to the existing validator", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f).recordRead;
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: roundtrip(produced) }),
      );
      const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
      const read = await workspace.readRecord(f.record.pageId);
      expect(read).toEqual(produced);
      expect(sent).toEqual([{ type: "record:read", pageId: f.record.pageId }]);
      expect(legacyCalls()).toBe(0);

      // The real owner-bound validator accepts the port result for the
      // caller's captured owner and rejects it for any other owner.
      const pair = validateRecordReadSnapshot(
        read,
        f.record.pageId,
        f.owner.id,
      );
      expect(pair.page.id).toBe(f.record.pageId);
      expect(pair.record.databasePageId).toBe(f.owner.id);
      expect(() =>
        validateRecordReadSnapshot(read, f.record.pageId, "other-owner"),
      ).toThrow();

      // The adapter never substitutes the payload's owner for the caller's
      // captured owner: a pair claiming another owner is still valid wire
      // data, returned verbatim, and only the caller-side check can reject it.
      const foreign = roundtrip({
        ...produced,
        record: { ...produced.record, databasePageId: "other-db" },
      });
      const foreignBridge = rootBridge(async () =>
        okReply({ present: true, value: foreign }),
      );
      const foreignRead = await createDesktopRootBindings(
        foreignBridge.bridge,
      ).readOnly.workspace.readRecord(f.record.pageId);
      expect(foreignRead).toEqual(foreign);
      expect(() =>
        validateRecordReadSnapshot(foreignRead, f.record.pageId, f.owner.id),
      ).toThrow();
      expect(
        validateRecordReadSnapshot(foreignRead, f.record.pageId, "other-db")
          .record.databasePageId,
      ).toBe("other-db");
    } finally {
      f.dispose();
    }
  });

  it("keeps delayed results fenced: a cancelled continuation never attaches", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f).recordRead;
      const gate = deferred<unknown>();
      const { bridge, sent, legacyCalls } = rootBridge(() => gate.promise);
      const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
      const sessions = new EditSessionCoordinator(async () => {
        throw new Error("no send in this test");
      });
      let cancelled = false;
      const attached: string[] = [];
      const pending = workspace.readRecord(f.record.pageId).then((read) => {
        if (cancelled) return;
        const pair = validateRecordReadSnapshot(
          read,
          f.record.pageId,
          f.owner.id,
        );
        sessions.attach(pair.page, pair.record);
        attached.push(pair.page.id);
      });
      // The component unmounted or switched owner before the reply landed.
      cancelled = true;
      gate.resolve(okReply({ present: true, value: roundtrip(produced) }));
      await pending;
      expect(attached).toHaveLength(0);
      expect(sessions.get(f.record.pageId)).toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("fails closed on malformed, smuggled and wrong-owner replies — one invoke, zero legacy", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f);
      const cases: {
        requestType: string;
        run: (workspace: WorkspaceReadPort) => Promise<unknown>;
        values: unknown[];
      }[] = [
        {
          requestType: "database:read",
          run: (workspace) => workspace.readDatabase(f.owner.id),
          values: [
            null,
            {},
            { database: produced.databaseRead.database },
            {
              ...produced.databaseRead,
              page: { ...produced.databaseRead.page, id: "other-db" },
            },
            {
              ...produced.databaseRead,
              page: { ...produced.databaseRead.page, kind: "page" },
            },
            {
              ...produced.databaseRead,
              database: {
                ...produced.databaseRead.database,
                records: "not-an-array",
              },
            },
            {
              ...produced.databaseRead,
              database: {
                ...produced.databaseRead.database,
                revision: -1,
              },
            },
            {
              ...produced.databaseRead,
              database: {
                ...produced.databaseRead.database,
                records: [
                  {
                    ...produced.databaseRead.database.records[0],
                    databasePageId: "other-db",
                  },
                ],
              },
            },
            {
              ...produced.databaseRead,
              database: {
                ...produced.databaseRead.database,
                settings: {
                  ...produced.databaseRead.database.settings,
                  rows: [],
                },
              },
            },
            {
              ...produced.databaseRead,
              database: {
                ...produced.databaseRead.database,
                settings: { bogus: true },
              },
            },
            // Required fields reachable only through an own __proto__ key can
            // never satisfy the shape — the key stays data, not a payload.
            Object.fromEntries([["__proto__", produced.databaseRead]]),
          ],
        },
        {
          requestType: "database:load",
          run: (workspace) => workspace.loadDatabase(f.owner.id),
          values: [
            null,
            {},
            { settings: produced.databaseLoad.settings },
            {
              ...produced.databaseLoad,
              revision: 1.5,
            },
            {
              ...produced.databaseLoad,
              records: [
                {
                  ...produced.databaseLoad.records[0],
                  databasePageId: "other-db",
                },
              ],
            },
            {
              ...produced.databaseLoad,
              settings: null,
            },
            Object.fromEntries([["__proto__", produced.databaseLoad]]),
          ],
        },
        {
          requestType: "record:read",
          run: (workspace) => workspace.readRecord(f.record.pageId),
          values: [
            null,
            {},
            { record: produced.recordRead.record },
            {
              ...produced.recordRead,
              page: { ...produced.recordRead.page, id: "other-page" },
            },
            {
              ...produced.recordRead,
              page: { ...produced.recordRead.page, kind: "database" },
            },
            {
              ...produced.recordRead,
              record: { ...produced.recordRead.record, pageId: "other-page" },
            },
            {
              ...produced.recordRead,
              record: {
                ...produced.recordRead.record,
                values: { note: { nested: true } },
              },
            },
            {
              ...produced.recordRead,
              record: {
                ...produced.recordRead.record,
                deletedAt: "not-a-time",
              },
            },
            Object.fromEntries([["__proto__", produced.recordRead]]),
          ],
        },
      ];
      for (const entry of cases) {
        for (const value of entry.values) {
          const { bridge, sent, legacyCalls } = rootBridge(async () =>
            okReply({ present: true, value: roundtrip(value) }),
          );
          const workspace = createDesktopRootBindings(bridge).readOnly
            .workspace;
          await expectSafeE(entry.run(workspace), entry.requestType);
          expect(sent).toHaveLength(1);
          expect(legacyCalls()).toBe(0);
        }
      }
    } finally {
      f.dispose();
    }
  });

  it("never executes accessors, thenables or proxy traps and maps every failure to the actual request type", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f);
      let getterCalls = 0;
      const getterPage: Record<string, unknown> = {
        ...produced.recordRead.page,
      };
      Object.defineProperty(getterPage, "revision", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return 1;
        },
      });
      const getterDatabase: Record<string, unknown> = {
        ...produced.databaseRead,
      };
      Object.defineProperty(getterDatabase, "database", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return produced.databaseRead.database;
        },
      });
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
      // A top-level thenable is assimilated by the promise machinery before
      // the decoder runs; a rejecting one must still surface as safeE with
      // the actual request type and no raw message. A function anywhere else
      // in the tree is not wire data and fails closed in ownPlainData.
      const rejectingThenable = (base: object) => ({
        ...base,
        then(
          _onFulfilled: (value: unknown) => void,
          onRejected?: (error: unknown) => void,
        ) {
          onRejected?.(new Error("raw thenable /Users/alice/secret"));
        },
      });
      const hostile: {
        requestType: string;
        run: (workspace: WorkspaceReadPort) => Promise<unknown>;
        values: unknown[];
      }[] = [
        {
          requestType: "database:read",
          run: (workspace) => workspace.readDatabase(f.owner.id),
          values: [
            getterDatabase,
            rejectingThenable(produced.databaseRead),
            {
              ...produced.databaseRead,
              database: {
                ...produced.databaseRead.database,
                records: [
                  {
                    ...produced.databaseRead.database.records[0],
                    values: { note() { return 1; } },
                  },
                ],
              },
            },
            proxy,
          ],
        },
        {
          requestType: "database:load",
          run: (workspace) => workspace.loadDatabase(f.owner.id),
          values: [
            rejectingThenable(produced.databaseLoad),
            {
              ...produced.databaseLoad,
              settings: {
                ...produced.databaseLoad.settings,
                nested() { return 1; },
              },
            },
            proxy,
          ],
        },
        {
          requestType: "record:read",
          run: (workspace) => workspace.readRecord(f.record.pageId),
          values: [
            { ...produced.recordRead, page: getterPage },
            rejectingThenable(produced.recordRead),
            {
              ...produced.recordRead,
              record: {
                ...produced.recordRead.record,
                values: { note() { return 1; } },
              },
            },
            proxy,
          ],
        },
      ];
      for (const entry of hostile) {
        for (const value of entry.values) {
          const { bridge, sent, legacyCalls } = rootBridge(
            async () =>
              ({
                tag: "folio-request-result",
                version: 1,
                ok: true,
                valueSlot: { present: true, value },
              }) as const,
          );
          const workspace = createDesktopRootBindings(bridge).readOnly
            .workspace;
          const error = await expectSafeE(entry.run(workspace), entry.requestType);
          expect(error.message).not.toContain("secret");
          expect(sent).toHaveLength(1);
          expect(legacyCalls()).toBe(0);
        }
      }
      expect(getterCalls).toBe(0);
    } finally {
      f.dispose();
    }
  });

  it("fails closed on transport rejection, malformed envelopes, missing and old bridges", async () => {
    const f = saveFixture();
    try {
      const lanes: {
        requestType: string;
        id: string;
        run: (workspace: WorkspaceReadPort) => Promise<unknown>;
      }[] = [
        {
          requestType: "database:read",
          id: f.owner.id,
          run: (workspace) => workspace.readDatabase(f.owner.id),
        },
        {
          requestType: "database:load",
          id: f.owner.id,
          run: (workspace) => workspace.loadDatabase(f.owner.id),
        },
        {
          requestType: "record:read",
          id: f.record.pageId,
          run: (workspace) => workspace.readRecord(f.record.pageId),
        },
      ];
      for (const lane of lanes) {
        for (const invoke of [
          async () => {
            throw new Error("raw transport /Users/alice/secret");
          },
          async () => ({ unexpected: true }),
          async () => failureReply(unclassified({ requestType: lane.requestType })),
        ] as const) {
          const { bridge, sent, legacyCalls } = rootBridge(invoke);
          const workspace = createDesktopRootBindings(bridge).readOnly
            .workspace;
          const error = await expectSafeE(lane.run(workspace), lane.requestType);
          expect(error.message).not.toContain("secret");
          expect(sent).toHaveLength(1);
          expect(legacyCalls()).toBe(0);
        }
        // Missing bridge: safeE without any invoke at all.
        await expectSafeE(
          lane.run(createDesktopRootBindings(undefined).readOnly.workspace),
          lane.requestType,
        );
        // Old preload exposing only the legacy request channel: the purpose
        // port still fails closed and the legacy channel stays untouched.
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
        await expectSafeE(lane.run(bindings.readOnly.workspace), lane.requestType);
        expect(legacyCalls).toBe(0);
      }
    } finally {
      f.dispose();
    }
  });

  it("preserves a legal own __proto__ string cell as wire data without weakening the caller validator", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f).recordRead;
      const values = Object.fromEntries([
        ["__proto__", "legacy-cell"],
        ["note", "x"],
      ]);
      const pair = {
        ...produced,
        record: { ...produced.record, values },
      };
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: roundtrip(pair) }),
      );
      const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
      const read = await workspace.readRecord(f.record.pageId);
      // The adapter returns the original value: the legal own __proto__
      // string cell is data, not a banned key.
      expect(read).toEqual(pair);
      expect(sent).toEqual([{ type: "record:read", pageId: f.record.pageId }]);
      expect(legacyCalls()).toBe(0);
      // The existing W02 owner validator still rejects the same payload
      // downstream — the port added no new ban and removed none either.
      expect(() =>
        validateRecordReadSnapshot(read, f.record.pageId, f.owner.id),
      ).toThrow();
    } finally {
      f.dispose();
    }
  });

  it("serves the real producer DAG through pass-through and structuredClone, not only JSON", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f);
      // The actual Store aliases the owner Page's database arrays into the
      // projection settings — a legal shared-reference DAG, not a cycle.
      const ownerDatabase = produced.databaseRead.page.database;
      expect(ownerDatabase).not.toBeNull();
      expect(produced.databaseRead.database.settings.properties).toBe(
        ownerDatabase!.properties,
      );
      expect(produced.databaseRead.database.settings.views).toBe(
        ownerDatabase!.views,
      );
      const rawEnvelope = (value: unknown): unknown =>
        ({
          tag: "folio-request-result",
          version: 1,
          ok: true,
          valueSlot: { present: true, value },
        }) as const;
      const carriers: {
        name: string;
        envelope: (value: unknown) => unknown;
        keepsAliases: boolean;
      }[] = [
        // The production preload is a pure pass-through: the identical
        // object graph reaches the adapter, aliases included.
        {
          name: "raw pass-through",
          envelope: rawEnvelope,
          keepsAliases: true,
        },
        {
          name: "structuredClone",
          envelope: (value) => structuredClone(rawEnvelope(value)),
          keepsAliases: true,
        },
        // JSON is the only carrier that silently splits shared references
        // into equal copies — it can no longer stand in for the wire.
        {
          name: "JSON",
          envelope: (value) => okReply({ present: true, value }),
          keepsAliases: false,
        },
      ];
      const cases: {
        requestType: string;
        produced: unknown;
        run: (workspace: WorkspaceReadPort) => Promise<unknown>;
      }[] = [
        {
          requestType: "database:read",
          produced: produced.databaseRead,
          run: (workspace) => workspace.readDatabase(f.owner.id),
        },
        {
          requestType: "database:load",
          produced: produced.databaseLoad,
          run: (workspace) => workspace.loadDatabase(f.owner.id),
        },
        {
          requestType: "record:read",
          produced: produced.recordRead,
          run: (workspace) => workspace.readRecord(f.record.pageId),
        },
      ];
      for (const carrier of carriers) {
        for (const entry of cases) {
          const { bridge, sent, legacyCalls } = rootBridge(async () =>
            carrier.envelope(entry.produced),
          );
          const workspace = createDesktopRootBindings(bridge).readOnly
            .workspace;
          const read = await entry.run(workspace);
          expect(read, carrier.name).toEqual(entry.produced);
          expect(sent, carrier.name).toHaveLength(1);
          expect(legacyCalls()).toBe(0);
          if (carrier.name === "raw pass-through")
            // Zero copies: the decoder returns the original value.
            expect(read).toBe(entry.produced);
          if (entry.requestType === "database:read") {
            const snapshot = read as DatabaseReadSnapshot;
            expect(
              snapshot.database.settings.properties ===
                snapshot.page.database!.properties,
              carrier.name,
            ).toBe(carrier.keepsAliases);
          }
        }
      }
    } finally {
      f.dispose();
    }
  });

  it("accepts a legal shared-reference DAG but still closes on a true cycle", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f).recordRead;
      const shared = { label: "shared", nested: [1, 2, 3] };
      const dag = { ...produced, aliasA: shared, aliasB: shared };
      const { bridge, sent, legacyCalls } = rootBridge(
        async () =>
          ({
            tag: "folio-request-result",
            version: 1,
            ok: true,
            valueSlot: { present: true, value: dag },
          }) as const,
      );
      const workspace = createDesktopRootBindings(bridge).readOnly.workspace;
      const read = (await workspace.readRecord(
        f.record.pageId,
      )) as Record<string, unknown>;
      // The original value comes back untouched — the shared reference stays
      // shared and nothing is cloned or normalized into a tree.
      expect(read).toBe(dag);
      expect(read.aliasA).toBe(read.aliasB);
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);

      const cyclic: Record<string, unknown> = { ...produced };
      cyclic.self = cyclic;
      const inner: Record<string, unknown> = { flag: true };
      inner.loop = inner;
      const nestedCyclic = { ...produced, extra: inner };
      for (const value of [cyclic, nestedCyclic]) {
        const hostile = rootBridge(
          async () =>
            ({
              tag: "folio-request-result",
              version: 1,
              ok: true,
              valueSlot: { present: true, value },
            }) as const,
        );
        const port = createDesktopRootBindings(hostile.bridge).readOnly
          .workspace;
        await expectSafeE(port.readRecord(f.record.pageId), "record:read");
        expect(hostile.sent).toHaveLength(1);
        expect(hostile.legacyCalls()).toBe(0);
      }
    } finally {
      f.dispose();
    }
  });

  it("decodes before the async return can assimilate a top-level then — zero getter and function calls", async () => {
    const f = saveFixture();
    try {
      const produced = producerReads(f);
      const lanes: {
        requestType: string;
        produced: object;
        run: (workspace: WorkspaceReadPort) => Promise<unknown>;
      }[] = [
        {
          requestType: "database:read",
          produced: produced.databaseRead,
          run: (workspace) => workspace.readDatabase(f.owner.id),
        },
        {
          requestType: "database:load",
          produced: produced.databaseLoad,
          run: (workspace) => workspace.loadDatabase(f.owner.id),
        },
        {
          requestType: "record:read",
          produced: produced.recordRead,
          run: (workspace) => workspace.readRecord(f.record.pageId),
        },
      ];
      for (const lane of lanes) {
        let getterCalls = 0;
        const getterValue: Record<string, unknown> = { ...lane.produced };
        Object.defineProperty(getterValue, "then", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return undefined;
          },
        });
        let thenCalls = 0;
        const neverValue = {
          ...lane.produced,
          then() {
            thenCalls += 1;
          },
        };
        for (const value of [getterValue, neverValue]) {
          const { bridge, sent, legacyCalls } = rootBridge(
            async () =>
              ({
                tag: "folio-request-result",
                version: 1,
                ok: true,
                valueSlot: { present: true, value },
              }) as const,
          );
          const workspace = createDesktopRootBindings(bridge).readOnly
            .workspace;
          // Under the post-return decoder this carrier either executed the
          // getter once or assimilated `then` and pended forever; now it is
          // a prompt bounded E with the actual request type and zero calls.
          await expectSafeE(lane.run(workspace), lane.requestType);
          expect(sent).toHaveLength(1);
          expect(legacyCalls()).toBe(0);
        }
        expect(getterCalls, lane.requestType).toBe(0);
        expect(thenCalls, lane.requestType).toBe(0);
      }
    } finally {
      f.dispose();
    }
  });
});
