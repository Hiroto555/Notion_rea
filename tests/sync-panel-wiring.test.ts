import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilitiesReadPort,
  SyncControlPort,
  WorkspaceConflictPort,
} from "../src/shared/app-api";
import type { TransferReleaseResult } from "../src/shared/sync-management";
import { SyncConnectionPanel } from "../src/renderer/sync/SyncConnectionPanel";
import { TransferMaintenancePanel } from "../src/renderer/sync/TransferMaintenancePanel";
import { SyncManagementDialog } from "../src/renderer/sync/SyncManagementDialog";
import { WorkspaceSyncIndicator } from "../src/renderer/WorkspaceSyncIndicator";
import * as ReactMock from "react";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  let index = 0;
  const slots: unknown[] = [];
  const slot = (init: unknown) => {
    if (!(index in slots)) slots[index] = init;
    return slots[index++];
  };
  return {
    ...actual,
    __resetHooks: () => {
      index = 0;
    },
    useState: (init: unknown) => {
      const current = slot({ value: typeof init === "function" ? (init as () => unknown)() : init }) as { value: unknown };
      return [
        current.value,
        (next: unknown) => {
          current.value = typeof next === "function" ? (next as (value: unknown) => unknown)(current.value) : next;
        },
      ];
    },
    useRef: (init: unknown) => slot({ current: init }),
    useEffect: (fn: () => unknown) => {
      fn();
    },
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
  };
});

const resetHooks = () =>
  (ReactMock as unknown as { __resetHooks(): void }).__resetHooks();

const read = (path: string) => readFileSync(path, "utf8");

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
const restartIdle = {
  available: true,
  state: "idle",
  scheduled: false,
  targetRevision: 2,
  canRequest: true,
  canCancel: false,
  reason: null,
} as const;
const restartAction = { result: "prepared", view: restartIdle } as const;
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
  queue: { rows: 3, bytes: 2048, maxRows: 10, maxBytes: 4096, held: false },
  backups: null,
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
const transferResult: TransferReleaseResult = {
  operationId: "op-1",
  outcome: "released",
  releasedBytes: 10,
  reason: null,
};

const makeSync = () => {
  const mocks = {
    status: vi.fn(async () => syncStatus),
    restartStatus: vi.fn(async () => restartIdle),
    restartRequest: vi.fn(async () => restartAction),
    restartCancel: vi.fn(async () => restartAction),
    run: vi.fn(async () => syncStatus),
    connectionStatus: vi.fn(async () => connectionView),
    transferInventory: vi.fn(async (_cursor?: string) => transferView),
    retention: vi.fn(async () => retentionView),
    connectionResolve: vi.fn(async () => connectionAction),
    connectionConfigure: vi.fn(async () => connectionAction),
    connectionDisable: vi.fn(async () => connectionAction),
    transferPlan: vi.fn(async () => transferPlan),
    transferRelease: vi.fn(async () => transferResult),
    transferResolve: vi.fn(async () => transferResult),
  };
  return { mocks, sync: mocks as unknown as SyncControlPort };
};

/** Required Indicator fixtures for the conflict/capability ports the panel
 * now receives. The mock-hook render only builds Panel elements, so these
 * stubs are never invoked here; dedicated conflict-port tests exercise them. */
const conflictPort = {
  inspect: vi.fn(),
  readCandidate: vi.fn(),
  exportCandidate: vi.fn(),
  decision: {
    status: vi.fn(),
    preview: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
  },
} as unknown as WorkspaceConflictPort;
const capabilitiesPort = {
  read: vi.fn(async () => null),
} as CapabilitiesReadPort;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const findAll = (
  node: unknown,
  pred: (element: { type?: unknown; props?: Record<string, unknown> }) => boolean,
  out: { type?: unknown; props?: Record<string, unknown> }[] = [],
) => {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (element.props && typeof element.props === "object") {
    if (pred(element as { type?: unknown; props?: Record<string, unknown> }))
      out.push(element as { type?: unknown; props?: Record<string, unknown> });
    findAll(element.props.children, pred, out);
  }
  return out;
};

const textOf = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props) return textOf(props.children);
  }
  return "";
};

let legacyRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  legacyRequest = vi.fn(async (input: { type?: string }) =>
    input.type === "sync:retentionStatus"
      ? retentionView
      : input.type === "sync:transferPlan"
        ? transferPlan
        : input.type === "sync:transferRelease" || input.type === "sync:transferResolve"
          ? transferResult
          : transferView,
  );
  vi.stubGlobal("window", {
    folio: { request: legacyRequest },
    setInterval: () => 1,
    clearInterval: () => {},
  });
});

describe("sync panel wiring", () => {
  it("injects the same appApi.sync object through App, Indicator and Button/Dialog", () => {
    const app = read("src/renderer/App.tsx");
    expect(app.match(/sync=\{appApi\.sync\}/g)).toHaveLength(2);
    expect(app).toContain("<WorkspaceSyncIndicator");
    expect(app).toContain("<SyncManagementButton");

    const indicator = read("src/renderer/WorkspaceSyncIndicator.tsx");
    for (const marker of [
      "sync.status()",
      "sync.restartStatus()",
      "sync.restartRequest()",
      "sync.restartCancel(",
      "sync.run()",
    ])
      expect(indicator).toContain(marker);
    expect(indicator).not.toContain("window.folio.request");
    expect(indicator).not.toContain("folio.request");

    const dialog = read("src/renderer/sync/SyncManagementDialog.tsx");
    for (const marker of [
      "sync={sync}",
      "sync.connectionStatus()",
      "sync.connectionResolve(",
      "sync.connectionConfigure(",
      "sync.connectionDisable(",
    ])
      expect(dialog).toContain(marker);
    // M1 pin: the five former generic transfer/retention call sites are now
    // the purpose port methods (generic fallback 0), while the S1 nine
    // connection/status call sites above stay unchanged.
    for (const legacy of [
      'type: "sync:transferInventory"',
      'type: "sync:retentionStatus"',
      'type: "sync:transferPlan"',
      'type: "sync:transferRelease"',
      'type: "sync:transferResolve"',
    ])
      expect(dialog).not.toContain(legacy);
    for (const migrated of [
      "sync.transferInventory(",
      "sync.retention(",
      "sync.transferPlan(",
      "sync.transferRelease(",
      "sync.transferResolve(",
    ])
      expect(dialog).toContain(migrated);
    expect(dialog).not.toContain("window.folio");
    expect(dialog).not.toContain("folio.request");
    expect(dialog).not.toContain("setTimeout");
  });

  it("keeps read-only bindings free of the sync write port", () => {
    const source = read("src/shared/app-api.ts");
    const readOnly = source.slice(
      source.indexOf("export interface ReadOnlyAppApi"),
      source.indexOf("export interface AppApi"),
    );
    expect(readOnly).not.toContain("SyncControlPort");
    expect(readOnly).not.toContain("sync:");
  });

  it("runs Indicator through the injected sync port without legacy fallback", async () => {
    const { mocks, sync } = makeSync();
    resetHooks();
    WorkspaceSyncIndicator({
      startupMessage: undefined,
      inputReady: () => true,
      sync,
      conflict: conflictPort,
      capabilities: capabilitiesPort,
    });
    await tick();
    expect(mocks.status).toHaveBeenCalled();
    expect(mocks.restartStatus).toHaveBeenCalled();
    expect(legacyRequest).not.toHaveBeenCalled();

    resetHooks();
    const element = WorkspaceSyncIndicator({
      startupMessage: undefined,
      inputReady: () => true,
      sync,
      conflict: conflictPort,
      capabilities: capabilitiesPort,
    }) as { props?: { children?: unknown } };
    const buttons = findAll(element, (node) => node.type === "button");
    const run = buttons.find((node) =>
      String(node.props?.children).includes("同期"),
    );
    expect(run).toBeDefined();
    (run!.props!.onClick as () => void)();
    await tick();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it("runs Dialog transfer and retention callbacks through the purpose port with original arguments, results, refresh and the same UNKNOWN operation id", async () => {
    const { mocks, sync } = makeSync();
    resetHooks();
    SyncManagementDialog({ onClose: () => {}, sync });
    await tick();
    expect(mocks.connectionStatus).toHaveBeenCalled();
    expect(mocks.transferInventory).toHaveBeenCalled();
    expect(mocks.retention).toHaveBeenCalledTimes(1);
    expect(mocks.retention).toHaveBeenCalledWith();
    expect(legacyRequest).not.toHaveBeenCalled();

    resetHooks();
    const dialog = SyncManagementDialog({ onClose: () => {}, sync }) as {
      props?: { children?: unknown };
    };
    await tick();

    const retentionSection = findAll(
      dialog,
      (node) =>
        node.type === "section" && node.props?.["aria-label"] === "同期の保持上限",
    )[0];
    expect(retentionSection).toBeDefined();
    const retentionText = textOf(retentionSection);
    expect(retentionText).toContain("3 / 10 件");
    expect(retentionText).toContain("2.0 KiB");

    const connectionPanel = findAll(
      dialog,
      (node) => node.type === SyncConnectionPanel,
    )[0];
    expect(connectionPanel).toBeDefined();
    const props = connectionPanel!.props!;
    await (props.onResolve as (id: string) => Promise<unknown>)("req-1");
    await (props.onSave as (input: unknown) => Promise<unknown>)({
      requestId: "11111111-1111-4111-8111-111111111111",
      expectedRevision: null,
      baseUrl: "http://127.0.0.1:43123/",
      workspaceId: "w1",
      clientId: "c1",
      mode: "publish",
      token: "abcdefghijklmnopqrstuvwxyz123456",
    });
    await (props.onDisable as (id: string, rev: string | null) => Promise<unknown>)(
      "req-1",
      "rev-1",
    );
    expect(mocks.connectionResolve).toHaveBeenCalledWith("req-1");
    expect(mocks.connectionConfigure).toHaveBeenCalled();
    expect(mocks.connectionDisable).toHaveBeenCalledWith("req-1", "rev-1");

    const transferPanel = findAll(
      dialog,
      (node) => node.type === TransferMaintenancePanel,
    )[0];
    expect(transferPanel).toBeDefined();
    const transferProps = transferPanel!.props!;
    expect(transferProps.view).toBe(transferView);

    const inventoryBeforeRelease = mocks.transferInventory.mock.calls.length;
    const planResult = await (transferProps.onPlan as (id: string) => Promise<unknown>)(
      transferEntry.entryId,
    );
    expect(planResult).toBe(transferPlan);
    expect(mocks.transferPlan).toHaveBeenCalledTimes(1);
    expect(mocks.transferPlan).toHaveBeenCalledWith(transferEntry.entryId);

    const releaseResult = await (transferProps.onRelease as (id: string) => Promise<unknown>)(
      "op-1",
    );
    expect(releaseResult).toBe(transferResult);
    expect(mocks.transferRelease).toHaveBeenCalledTimes(1);
    expect(mocks.transferRelease).toHaveBeenCalledWith("op-1");
    // The released outcome still refreshes the inventory through the same
    // purpose method with no cursor, as the legacy after-release refresh did.
    expect(mocks.transferInventory.mock.calls.length).toBe(inventoryBeforeRelease + 1);
    expect(mocks.transferInventory.mock.calls.at(-1)?.[0]).toBeUndefined();

    const resolveResult = await (transferProps.onResolve as (id: string) => Promise<unknown>)(
      "op-1",
    );
    expect(resolveResult).toBe(transferResult);
    expect(mocks.transferResolve).toHaveBeenCalledTimes(1);
    expect(mocks.transferResolve).toHaveBeenLastCalledWith("op-1");

    const unknownResult: TransferReleaseResult = {
      operationId: "op-unknown",
      outcome: "outcome-unknown",
      releasedBytes: 0,
      reason: null,
    };
    mocks.transferResolve.mockResolvedValueOnce(unknownResult);
    const unknownResolve = await (
      transferProps.onResolve as (id: string) => Promise<unknown>
    )("op-unknown");
    expect(unknownResolve).toBe(unknownResult);
    expect(mocks.transferResolve).toHaveBeenLastCalledWith("op-unknown");
    // UNKNOWN keeps the same operation id: no new plan/ticket and no resend of
    // a different id, while the original resolve result passes through.
    expect(mocks.transferPlan).toHaveBeenCalledTimes(1);
    expect(mocks.transferRelease).toHaveBeenCalledTimes(1);
    expect(mocks.transferResolve).toHaveBeenCalledTimes(2);

    const legacyTypes = legacyRequest.mock.calls.map(
      (call) => (call[0] as { type?: string }).type,
    );
    expect(legacyTypes).toEqual([]);
    expect(mocks.transferInventory).toHaveBeenCalled();
    expect(mocks.retention).toHaveBeenCalled();
  });
});
