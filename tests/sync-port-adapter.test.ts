import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncControlPort } from "../src/shared/app-api";
import { StorageFailureError } from "../src/renderer/private-request";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import type { FolioAPI, Request } from "../src/shared/types";

const okReply = (
  valueSlot: { present: false } | { present: true; value: unknown },
) =>
  cloneJSON({
    tag: "folio-request-result",
    version: 1,
    ok: true,
    valueSlot,
  });

const cloneJSON = <T>(value: T): T =>
  value === undefined ? value : structuredClone(value);

function rootBridge(
  impl: (input: Request) => Promise<unknown>,
): {
  bridge: Pick<FolioAPI, "requestDiagnostic" | "shared">;
  sent: Request[];
  legacyCalls: () => number;
} {
  const sent: Request[] = [];
  let legacy = 0;
  const legacyRequest = vi.fn(() => {
    legacy += 1;
    return Promise.reject(new Error("legacy transport"));
  });
  vi.stubGlobal("window", { folio: { request: legacyRequest } });
  return {
    sent,
    legacyCalls: () => legacy,
    bridge: {
      requestDiagnostic: async (input: Request) => {
        sent.push(cloneJSON(input));
        return impl(input);
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const syncStatus = {
  available: true,
  connection: "connected",
  running: false,
  lastSuccessAt: null,
  lastError: null,
  workspace: {
    receivedCursor: 1,
    appliedRevision: 1,
    generation: 1,
    cleanGeneration: 1,
    pending: false,
    conflict: false,
  },
} as const;

const syncStatusUnavailable = { available: false, reason: "not-connected" } as const;
const restartIdle = {
  available: true,
  state: "idle",
  scheduled: false,
  targetRevision: 2,
  canRequest: true,
  canCancel: false,
  reason: null,
} as const;
const restartUnavailable = { available: false, reason: "read-only" } as const;
const restartAction = {
  result: "prepared",
  view: {
    available: true,
    state: "requested",
    reservationId: "res-1",
    scheduled: false,
    targetRevision: 2,
    canRequest: false,
    canCancel: true,
    reason: null,
  },
} as const;
const connectionView = {
  state: "configured",
  revision: "rev-1",
  target: {
    baseUrl: "http://127.0.0.1:43123/",
    workspaceId: "w1",
    clientId: "c1",
    mode: "publish",
  },
  hasCredential: true,
  reason: null,
} as const;
const connectionAction = { outcome: "saved", view: connectionView } as const;
const retentionView = {
  queue: { rows: 1, bytes: 2, maxRows: 3, maxBytes: 4, held: false },
  backups: { generations: 1, bytes: 2, held: false },
  held: null,
} as const;
const transferEntry = {
  entryId: "scope/journal/key",
  scopeHash: "hash",
  assetId: null,
  bytes: 10,
  offset: 0,
  state: "active",
  currentScope: true,
  canRelease: false,
  reason: null,
} as const;
const transferView = {
  entries: [transferEntry],
  nextCursor: null,
  usedBytes: 10,
  overLimit: false,
  held: null,
} as const;
const transferPlan = { operationId: "op-1", entry: transferEntry, expiresAt: 123 } as const;
const transferResult = {
  operationId: "op-1",
  outcome: "released",
  releasedBytes: 10,
  reason: null,
} as const;
const connectionInput = {
  requestId: "11111111-1111-4111-8111-111111111111",
  expectedRevision: null,
  baseUrl: "http://127.0.0.1:43123/",
  workspaceId: "w1",
  clientId: "c1",
  mode: "publish",
  token: "abcdefghijklmnopqrstuvwxyz123456",
} as const;

const cases = [
  {
    name: "status",
    request: { type: "sync:status" },
    value: syncStatus,
    call: (sync: SyncControlPort) => sync.status(),
  },
  {
    name: "restartStatus",
    request: { type: "sync:restartStatus" },
    value: restartIdle,
    call: (sync: SyncControlPort) => sync.restartStatus(),
  },
  {
    name: "restartRequest",
    request: { type: "sync:restartRequest" },
    value: restartAction,
    call: (sync: SyncControlPort) => sync.restartRequest(),
  },
  {
    name: "restartCancel",
    request: { type: "sync:restartCancel", reservationId: "res-1" },
    value: restartAction,
    call: (sync: SyncControlPort) => sync.restartCancel("res-1"),
  },
  {
    name: "run",
    request: { type: "sync:run" },
    value: syncStatus,
    call: (sync: SyncControlPort) => sync.run(),
  },
  {
    name: "connectionStatus",
    request: { type: "sync:connectionStatus" },
    value: connectionView,
    call: (sync: SyncControlPort) => sync.connectionStatus(),
  },
  {
    name: "transferInventory",
    request: { type: "sync:transferInventory", cursor: "cursor-1" },
    value: transferView,
    call: (sync: SyncControlPort) => sync.transferInventory("cursor-1"),
  },
  {
    name: "retention",
    request: { type: "sync:retentionStatus" },
    value: retentionView,
    call: (sync: SyncControlPort) => sync.retention(),
  },
  {
    name: "connectionResolve",
    request: { type: "sync:connectionResolve", requestId: "req-1" },
    value: connectionAction,
    call: (sync: SyncControlPort) => sync.connectionResolve("req-1"),
  },
  {
    name: "connectionConfigure",
    request: { type: "sync:connectionConfigure", input: connectionInput },
    value: connectionAction,
    call: (sync: SyncControlPort) => sync.connectionConfigure(connectionInput),
  },
  {
    name: "connectionDisable",
    request: {
      type: "sync:connectionDisable",
      requestId: "req-1",
      expectedRevision: "rev-1",
    },
    value: connectionAction,
    call: (sync: SyncControlPort) =>
      sync.connectionDisable("req-1", "rev-1"),
  },
  {
    name: "transferPlan",
    request: { type: "sync:transferPlan", entryId: transferEntry.entryId },
    value: transferPlan,
    call: (sync: SyncControlPort) => sync.transferPlan(transferEntry.entryId),
  },
  {
    name: "transferRelease",
    request: { type: "sync:transferRelease", operationId: "op-1" },
    value: transferResult,
    call: (sync: SyncControlPort) => sync.transferRelease("op-1"),
  },
  {
    name: "transferResolve",
    request: { type: "sync:transferResolve", operationId: "op-1" },
    value: transferResult,
    call: (sync: SyncControlPort) => sync.transferResolve("op-1"),
  },
] as const;

const expectSafe = async (promise: Promise<unknown>, requestType: string) => {
  try {
    await promise;
    expect.unreachable("expected a safe transport failure");
  } catch (error) {
    expect(error).toBeInstanceOf(StorageFailureError);
    const failure = (error as StorageFailureError).storageFailure;
    expect(failure.kind).toBe("UNCLASSIFIED");
    expect(failure.requestType).toBe(requestType);
    expect((error as Error).message).not.toMatch(
      /raw-secret|getter|cycle|foreign|thenable/,
    );
  }
};

describe("sync purpose port adapter", () => {
  for (const entry of cases) {
    it(`${entry.name} uses one fixed v1 request and validates before async return`, async () => {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: entry.value }),
      );
      const result = await entry.call(createDesktopRootBindings(bridge).writable.sync);
      expect(result).toEqual(entry.value);
      expect(sent).toEqual([entry.request]);
      expect(legacyCalls()).toBe(0);
    });

    it(`${entry.name} maps invalid and missing responses to the actual request type`, async () => {
      for (const reply of [
        okReply({ present: true, value: {} }),
        okReply({ present: false }),
      ]) {
        const { bridge, sent, legacyCalls } = rootBridge(async () => reply);
        await expectSafe(
          entry.call(createDesktopRootBindings(bridge).writable.sync),
          entry.request.type,
        );
        expect(sent).toEqual([entry.request]);
        expect(legacyCalls()).toBe(0);
      }
    });
  }

  it("accepts cloneJSON and legal shared DAG payloads without normalization", async () => {
    const cloned = cloneJSON(syncStatus);
    const { bridge: cloneBridge, sent: cloneSent } = rootBridge(async () =>
      okReply({ present: true, value: cloned }),
    );
    await expect(
      createDesktopRootBindings(cloneBridge).writable.sync.status(),
    ).resolves.toEqual(syncStatus);
    expect(cloneSent).toEqual([{ type: "sync:status" }]);

    const shared = { ...transferView, entries: [transferEntry, transferEntry] };
    const { bridge: dagBridge } = rootBridge(async () =>
      okReply({ present: true, value: shared }),
    );
    await expect(
      createDesktopRootBindings(dagBridge).writable.sync.transferInventory(),
    ).resolves.toEqual(shared);
  });

  it("preserves available:false, null and optional slots", async () => {
    const values: [string, (sync: SyncControlPort) => Promise<unknown>, unknown][] = [
      ["sync:status", sync => sync.status(), syncStatusUnavailable],
      ["sync:restartStatus", sync => sync.restartStatus(), restartUnavailable],
      ["sync:connectionResolve", sync => sync.connectionResolve("req-1"), null],
    ];
    for (const [requestType, call, value] of values) {
      const { bridge } = rootBridge(async () => okReply({ present: true, value }));
      await expect(call(createDesktopRootBindings(bridge).writable.sync)).resolves.toEqual(value);
      void requestType;
    }
  });

  it("rejects raw transport rejection without leaking the cause", async () => {
    const { bridge } = rootBridge(async () => {
      throw new Error("raw-secret transport detail");
    });
    await expectSafe(
      createDesktopRootBindings(bridge).writable.sync.status(),
      "sync:status",
    );
  });

  it("rejects accessor, true cycle, foreign carrier and thenable success values", async () => {
    const accessor = {};
    Object.defineProperty(accessor, "available", {
      enumerable: true,
      get() {
        throw new Error("getter-secret");
      },
    });
    const cyclic: Record<string, unknown> = { available: true };
    cyclic.self = cyclic;
    const foreign = new (class Foreign {})();
    const thenable = { available: true, then() {} };
    for (const value of [accessor, cyclic, foreign, thenable]) {
      const { bridge } = rootBridge(async () => okReply({ present: true, value }));
      await expectSafe(
        createDesktopRootBindings(bridge).writable.sync.status(),
        "sync:status",
      );
    }
  });
});
