import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilitiesReadPort,
  ConflictDecisionPort,
  WorkspaceConflictPort,
} from "../src/shared/app-api";
import type {
  ConflictDecisionAction,
  ConflictDecisionPreview,
  ConflictDecisionView,
  ConflictPreviewRequest,
  WorkspaceConflictResolutionTarget,
} from "../src/shared/workspace-conflict-resolution";
import type { WorkspaceConflictCandidateTarget } from "../src/shared/workspace-conflict-view";
import type { FolioAPI, Request } from "../src/shared/types";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { StorageFailureError } from "../src/renderer/private-request";
import { conflictDecisionBridge } from "../src/renderer/conflict-decision-port";
import { ConflictDecisionModel } from "../src/renderer/conflict-decision-model";
import { WorkspaceConflictPanel } from "../src/renderer/WorkspaceConflictPanel";
import { WorkspaceConflictDecisionControls } from "../src/renderer/WorkspaceConflictDecisionControls";
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
      slots.length = 0;
    },
    __rerender: () => {
      index = 0;
    },
    useState: (init: unknown) => {
      const current = slot({
        value: typeof init === "function" ? (init as () => unknown)() : init,
      }) as { value: unknown };
      return [
        current.value,
        (next: unknown) => {
          current.value =
            typeof next === "function"
              ? (next as (value: unknown) => unknown)(current.value)
              : next;
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
const rerender = () =>
  (ReactMock as unknown as { __rerender(): void }).__rerender();

const read = (path: string) => readFileSync(path, "utf8");

const roundtrip = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value));
const okReply = (
  valueSlot: { present: false } | { present: true; value: unknown },
): unknown =>
  roundtrip({ tag: "folio-request-result", version: 1, ok: true, valueSlot });
const rejected = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("unexpected resolve");
    },
    (error: unknown) => error,
  );

/** The real preload pair: the production v1 adapter over a fake invoke, plus
 * a legacy channel that only counts calls so any fallback would be seen. */
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
): Promise<void> => {
  const error = await rejected(promise);
  expect(error).toBeInstanceOf(StorageFailureError);
  expect((error as StorageFailureError).storageFailure).toMatchObject({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType,
    retryAuthority: "NONE",
    preserve: true,
  });
};

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const inspection = () => ({
  operationId: "op-conflict-1",
  localGeneration: 7,
  status: {
    receivedCursor: 9,
    appliedRevision: 8,
    generation: 7,
    cleanGeneration: 6,
    pending: true,
  },
  local: {
    side: "local",
    revision: 5,
    checkpointHash: HASH_A,
    pages: 3,
    assets: 2,
    bytes: 512,
  },
  remote: {
    side: "remote",
    revision: 4,
    checkpointHash: HASH_B,
    pages: 2,
    assets: 1,
    bytes: 256,
  },
});

const validArchive = () => ({
  id: 3,
  operationId: "op-conflict-1",
  kind: "conflict-local",
  createdAt: 1_700_000_000_000,
  checkpointHash: HASH_C,
  pages: 3,
  assets: 2,
  bytes: 512,
  valid: true,
});
const invalidArchive = () => ({
  id: 4,
  operationId: "op-conflict-1",
  kind: "conflict-remote",
  createdAt: 1_700_000_001_000,
  checkpointHash: null,
  pages: null,
  assets: null,
  bytes: 999,
  valid: false,
});

const fullView = () => ({
  available: true,
  conflict: inspection(),
  archives: [validArchive(), invalidArchive()],
  archiveCount: 2,
});
const emptyView = () => ({
  available: true,
  conflict: null,
  archives: [],
  archiveCount: 0,
});

const snapshot = () => ({
  operationId: "op-conflict-1",
  side: "local",
  revision: 5,
  checkpointHash: HASH_A,
  checkpointJson: "{\"pages\":[]}",
  bytes: 512,
});
const emptyCheckpointSnapshot = () => ({
  operationId: "op-conflict-1",
  side: "remote",
  revision: 0,
  checkpointHash: null,
  checkpointJson: null,
  bytes: 0,
});

const idleDecisionView = (): ConflictDecisionView => ({
  state: "idle",
  decisionId: null,
  choice: null,
  canPreview: true,
  canCancel: false,
  reason: null,
});
const requestedDecisionView = (): ConflictDecisionView => ({
  state: "requested",
  decisionId: "dec-1",
  choice: "local",
  canPreview: false,
  canCancel: true,
  reason: null,
});
const blockedDecisionView = (): ConflictDecisionView => ({
  state: "blocked",
  decisionId: null,
  choice: null,
  canPreview: false,
  canCancel: false,
  reason: "unsaved-input",
});

const resolutionTarget = (): WorkspaceConflictResolutionTarget => ({
  version: 1,
  choice: "local",
  workspaceId: "w-1",
  clientId: "c-1",
  bindingId: "b-1",
  serverEpoch: "e-1",
  operationId: "op-conflict-1",
  localRevision: 5,
  localCheckpointHash: HASH_A,
  remoteRevision: 4,
  remoteCheckpointHash: HASH_B,
  conflictGeneration: 7,
  generation: 7,
  cleanGeneration: 6,
  appliedRevision: 8,
  receivedCursor: 9,
  latestCheckpointHash: HASH_D,
});
const preview = (): ConflictDecisionPreview => ({
  id: "pv-1",
  target: resolutionTarget(),
  latestCheckpointJson: "{\"pages\":[]}",
  remoteCheckpointJson: "{\"pages\":[]}",
  latestPages: 3,
  latestAssets: 2,
});

const candidateTarget = {
  operationId: "op-conflict-1",
  side: "remote",
  expectedRevision: 4,
  expectedCheckpointHash: HASH_B,
} as const;

let legacyRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  legacyRequest = vi.fn(async () => undefined);
  vi.stubGlobal("window", {
    folio: { request: legacyRequest },
    setInterval: () => 1,
    clearInterval: () => {},
  });
});

describe("conflict.inspect adapter through the real v1 preload", () => {
  it("returns every legal view shape unchanged — one invoke, zero legacy", async () => {
    for (const view of [
      { available: false, reason: "not-connected" },
      { available: false, reason: "read-only" },
      emptyView(),
      fullView(),
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: view }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(await bindings.writable.conflict.inspect()).toEqual(view);
      expect(sent).toEqual([{ type: "sync:conflict" }]);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("rejects malformed, extra-key, cyclic and thenable views as a bounded E on the actual tag", async () => {
    const cyclic = fullView() as Record<string, unknown>;
    cyclic.self = cyclic;
    const thenable = { ...emptyView(), then: () => null };
    for (const view of [
      { available: "yes" },
      { available: false, reason: "conflict" },
      { available: false, reason: "read-only", extra: 1 },
      { available: true, conflict: null, archives: null, archiveCount: 0 },
      { available: true, conflict: null, archives: [], archiveCount: "0" },
      { ...fullView(), extra: 1 },
      { ...fullView(), conflict: { ...inspection(), extra: 1 } },
      {
        ...fullView(),
        conflict: { ...inspection(), status: { pending: true } },
      },
      {
        ...fullView(),
        conflict: {
          ...inspection(),
          remote: { ...inspection().remote, checkpointHash: "nope" },
        },
      },
      {
        ...fullView(),
        conflict: {
          ...inspection(),
          local: { ...inspection().local, checkpointHash: null },
        },
      },
      { ...fullView(), archives: [{ ...validArchive(), valid: "yes" }] },
      cyclic,
      thenable,
      42,
      "conflict",
      undefined,
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        view === undefined
          ? okReply({ present: false })
          : ({
              tag: "folio-request-result",
              version: 1,
              ok: true,
              valueSlot: { present: true, value: view },
            }) as const,
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.writable.conflict.inspect(),
        "sync:conflict",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("closes a getter-bearing view to the bounded E without executing it", async () => {
    let getterCalls = 0;
    const view = fullView() as Record<string, unknown>;
    Object.defineProperty(view.conflict as object, "localGeneration", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 7;
      },
    });
    const { bridge, sent, legacyCalls } = rootBridge(
      async () =>
        ({
          tag: "folio-request-result",
          version: 1,
          ok: true,
          valueSlot: { present: true, value: view },
        }) as const,
    );
    const bindings = createDesktopRootBindings(bridge);
    await expectSafeE(bindings.writable.conflict.inspect(), "sync:conflict");
    expect(getterCalls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  });
});

describe("conflict.readCandidate adapter", () => {
  it("sends the exact target fields and returns a legal snapshot — including the legal null checkpoint", async () => {
    for (const value of [snapshot(), emptyCheckpointSnapshot()]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(
        await bindings.writable.conflict.readCandidate(candidateTarget),
      ).toEqual(value);
      expect(sent).toEqual([
        { type: "sync:conflictCandidate", ...candidateTarget },
      ]);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("pins the candidate purpose and never reads extra own type/channel/getter fields", async () => {
    let getterCalls = 0;
    const injected = {
      type: "sync:run",
      channel: "legacy",
      operationId: "op-injected",
      side: "remote",
      expectedRevision: 0,
      expectedCheckpointHash: null,
    } as Record<string, unknown>;
    Object.defineProperty(injected, "unused", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-cross";
      },
    });
    const { bridge, sent, legacyCalls } = rootBridge(async () =>
      okReply({ present: true, value: emptyCheckpointSnapshot() }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(
      await bindings.writable.conflict.readCandidate(
        injected as unknown as WorkspaceConflictCandidateTarget,
      ),
    ).toEqual(emptyCheckpointSnapshot());
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(Object.keys(request).sort()).toEqual(
      [
        "type",
        "operationId",
        "side",
        "expectedRevision",
        "expectedCheckpointHash",
      ].sort(),
    );
    expect(request).toEqual({
      type: "sync:conflictCandidate",
      operationId: "op-injected",
      side: "remote",
      expectedRevision: 0,
      expectedCheckpointHash: null,
    });
    expect("channel" in request).toBe(false);
    expect("unused" in request).toBe(false);
    expect(getterCalls).toBe(0);
    expect(legacyCalls()).toBe(0);
  });

  it("rejects malformed snapshots as a bounded E on the candidate tag", async () => {
    for (const value of [
      { ...snapshot(), extra: 1 },
      { ...snapshot(), side: "middle" },
      { ...snapshot(), bytes: "512" },
      { ...snapshot(), checkpointHash: "not-hex" },
      { ...snapshot(), checkpointJson: 42 },
      { operationId: "op-conflict-1", side: "local" },
      7,
      undefined,
    ]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        value === undefined
          ? okReply({ present: false })
          : ({
              tag: "folio-request-result",
              version: 1,
              ok: true,
              valueSlot: { present: true, value },
            }) as const,
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.writable.conflict.readCandidate(candidateTarget),
        "sync:conflictCandidate",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });
});

describe("conflict.exportCandidate adapter", () => {
  it("returns the display path and the picker null through the exact export tag", async () => {
    {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: "/tmp/out/conflict.json" }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(
        await bindings.writable.conflict.exportCandidate(candidateTarget),
      ).toBe("/tmp/out/conflict.json");
      expect(sent).toEqual([
        { type: "sync:conflictExport", ...candidateTarget },
      ]);
      expect(legacyCalls()).toBe(0);
    }
    const { bridge, sent } = rootBridge(async () =>
      okReply({ present: true, value: null }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(
      await bindings.writable.conflict.exportCandidate(candidateTarget),
    ).toBeNull();
    expect(sent).toEqual([{ type: "sync:conflictExport", ...candidateTarget }]);
  });

  it("pins the export purpose and never reads extra own type/channel/getter fields", async () => {
    let getterCalls = 0;
    const injected = {
      type: "sync:run",
      channel: "legacy",
      operationId: "op-injected",
      side: "remote",
      expectedRevision: 0,
      expectedCheckpointHash: null,
    } as Record<string, unknown>;
    Object.defineProperty(injected, "unused", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-cross";
      },
    });
    const { bridge, sent, legacyCalls } = rootBridge(async () =>
      okReply({ present: true, value: "/tmp/out/conflict.json" }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(
      await bindings.writable.conflict.exportCandidate(
        injected as unknown as WorkspaceConflictCandidateTarget,
      ),
    ).toBe("/tmp/out/conflict.json");
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(Object.keys(request).sort()).toEqual(
      [
        "type",
        "operationId",
        "side",
        "expectedRevision",
        "expectedCheckpointHash",
      ].sort(),
    );
    expect(request).toEqual({
      type: "sync:conflictExport",
      operationId: "op-injected",
      side: "remote",
      expectedRevision: 0,
      expectedCheckpointHash: null,
    });
    expect("channel" in request).toBe(false);
    expect("unused" in request).toBe(false);
    expect(getterCalls).toBe(0);
    expect(legacyCalls()).toBe(0);
  });

  it("rejects non-string export results as a bounded E and never resends", async () => {
    for (const value of [42, true, {}, ["x"], undefined]) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        value === undefined
          ? okReply({ present: false })
          : okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      await expectSafeE(
        bindings.writable.conflict.exportCandidate(candidateTarget),
        "sync:conflictExport",
      );
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
    // A transport failure is one bounded E on the actual tag — the promise
    // rejects once and no retry or resend is issued afterwards.
    const { bridge, sent, legacyCalls } = rootBridge(async () => {
      throw new Error("transport-down");
    });
    const bindings = createDesktopRootBindings(bridge);
    await expectSafeE(
      bindings.writable.conflict.exportCandidate(candidateTarget),
      "sync:conflictExport",
    );
    await tick();
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  });
});

describe("conflict.decision adapter", () => {
  it("returns every legal decision shape through one fixed tag each", async () => {
    {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: idleDecisionView() }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(await bindings.writable.conflict.decision.status()).toEqual(
        idleDecisionView(),
      );
      expect(sent).toEqual([{ type: "sync:conflictDecisionStatus" }]);
      expect(legacyCalls()).toBe(0);
    }
    {
      const previewInput = {
        choice: "local",
        operationId: "op-conflict-1",
        expectedLocalHash: HASH_A,
        expectedRemoteRevision: 4,
        expectedRemoteHash: HASH_B,
      } as const;
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: preview() }),
      );
      const bindings = createDesktopRootBindings(bridge);
      expect(
        await bindings.writable.conflict.decision.preview(previewInput),
      ).toEqual(preview());
      expect(sent).toEqual([
        { type: "sync:conflictPreview", ...previewInput },
      ]);
      expect(legacyCalls()).toBe(0);
    }
    for (const [method, arg, type, action] of [
      ["confirm", "pv-1", "sync:conflictConfirm", { result: "requested", view: requestedDecisionView() }],
      ["cancel", "dec-1", "sync:conflictCancel", { result: "cancelled", view: idleDecisionView() }],
    ] as const) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value: action }),
      );
      const bindings = createDesktopRootBindings(bridge);
      const port = bindings.writable.conflict.decision;
      const value =
        method === "confirm"
          ? await port.confirm(arg)
          : await port.cancel(arg);
      expect(value).toEqual(action);
      const key = method === "confirm" ? "previewId" : "decisionId";
      expect(sent).toEqual([{ type, [key]: arg }]);
      expect(legacyCalls()).toBe(0);
    }
  });

  it("pins the preview purpose and never reads extra own type/channel/getter fields", async () => {
    let getterCalls = 0;
    const injected = {
      type: "sync:run",
      channel: "legacy",
      choice: "remote",
      operationId: "op-injected",
      expectedLocalHash: HASH_A,
      expectedRemoteRevision: 4,
      expectedRemoteHash: null,
    } as Record<string, unknown>;
    Object.defineProperty(injected, "unused", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-cross";
      },
    });
    const { bridge, sent, legacyCalls } = rootBridge(async () =>
      okReply({ present: true, value: preview() }),
    );
    const bindings = createDesktopRootBindings(bridge);
    expect(
      await bindings.writable.conflict.decision.preview(
        injected as unknown as ConflictPreviewRequest,
      ),
    ).toEqual(preview());
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(Object.keys(request).sort()).toEqual(
      [
        "type",
        "choice",
        "operationId",
        "expectedLocalHash",
        "expectedRemoteRevision",
        "expectedRemoteHash",
      ].sort(),
    );
    expect(request).toEqual({
      type: "sync:conflictPreview",
      choice: "remote",
      operationId: "op-injected",
      expectedLocalHash: HASH_A,
      expectedRemoteRevision: 4,
      expectedRemoteHash: null,
    });
    expect("channel" in request).toBe(false);
    expect("unused" in request).toBe(false);
    expect(getterCalls).toBe(0);
    expect(legacyCalls()).toBe(0);
  });

  it("rejects malformed views, previews and actions as a bounded E on the actual tag", async () => {
    for (const [value, tag] of [
      [{ ...idleDecisionView(), state: "half" }, "sync:conflictDecisionStatus"],
      [{ ...idleDecisionView(), extra: 1 }, "sync:conflictDecisionStatus"],
      [{ ...idleDecisionView(), decisionId: 7 }, "sync:conflictDecisionStatus"],
      [{ ...idleDecisionView(), reason: "quota" }, "sync:conflictDecisionStatus"],
      [{ ...preview(), target: { ...resolutionTarget(), version: 2 } }, "sync:conflictPreview"],
      [{ ...preview(), latestPages: "3" }, "sync:conflictPreview"],
      [{ ...preview(), extra: 1 }, "sync:conflictPreview"],
      [{ result: "maybe", view: idleDecisionView() }, "sync:conflictConfirm"],
      [{ result: "requested" }, "sync:conflictConfirm"],
      [{ result: "cancelled", view: { ...idleDecisionView(), choice: "both" } }, "sync:conflictCancel"],
    ] as const) {
      const { bridge, sent, legacyCalls } = rootBridge(async () =>
        okReply({ present: true, value }),
      );
      const bindings = createDesktopRootBindings(bridge);
      const port = bindings.writable.conflict.decision;
      const promise =
        tag === "sync:conflictDecisionStatus"
          ? port.status()
          : tag === "sync:conflictPreview"
            ? port.preview({
                choice: "local",
                operationId: "op-conflict-1",
                expectedLocalHash: HASH_A,
                expectedRemoteRevision: 4,
                expectedRemoteHash: HASH_B,
              })
            : tag === "sync:conflictConfirm"
              ? port.confirm("pv-1")
              : port.cancel("dec-1");
      await expectSafeE(promise, tag);
      expect(sent).toHaveLength(1);
      expect(legacyCalls()).toBe(0);
    }
  });
});

describe("conflictDecisionBridge — internal four-tag dispatch", () => {
  const makePort = () => {
    const calls: string[] = [];
    const port: ConflictDecisionPort = {
      status: vi.fn(async () => {
        calls.push("status");
        return idleDecisionView();
      }),
      preview: vi.fn(async (): Promise<ConflictDecisionPreview> => {
        calls.push("preview");
        return preview();
      }),
      confirm: vi.fn(async (): Promise<ConflictDecisionAction> => {
        calls.push("confirm");
        return { result: "requested", view: requestedDecisionView() };
      }),
      cancel: vi.fn(async (): Promise<ConflictDecisionAction> => {
        calls.push("cancel");
        return { result: "cancelled", view: idleDecisionView() };
      }),
    };
    return { calls, port };
  };

  it("invokes exactly one matching port method per valid tag — synchronously, with the request's own fields", async () => {
    const { calls, port } = makePort();
    const transport = conflictDecisionBridge(port);

    const statusPromise = transport({ type: "sync:conflictDecisionStatus" });
    expect(port.status).toHaveBeenCalledTimes(1);
    // The transport returns the port call's own promise — nothing is wrapped
    // or awaited inside the bridge.
    expect(statusPromise).toBe(
      vi.mocked(port.status).mock.results[0].value,
    );
    expect(await statusPromise).toEqual(idleDecisionView());

    const previewInput = {
      choice: "remote" as const,
      operationId: "op-conflict-1",
      expectedLocalHash: HASH_A,
      expectedRemoteRevision: 4,
      expectedRemoteHash: HASH_B,
    };
    const previewPromise = transport({
      type: "sync:conflictPreview",
      ...previewInput,
    });
    expect(port.preview).toHaveBeenCalledTimes(1);
    expect(port.preview).toHaveBeenCalledWith(previewInput);
    expect(await previewPromise).toEqual(preview());

    const confirmPromise = transport({
      type: "sync:conflictConfirm",
      previewId: "pv-1",
    });
    // The port call is the returned promise itself: inputReady → actual
    // invoke carries no inserted await or probe inside the bridge.
    expect(port.confirm).toHaveBeenCalledTimes(1);
    expect(port.confirm).toHaveBeenCalledWith("pv-1");
    await confirmPromise;

    const cancelPromise = transport({
      type: "sync:conflictCancel",
      decisionId: "dec-1",
    });
    expect(port.cancel).toHaveBeenCalledTimes(1);
    expect(port.cancel).toHaveBeenCalledWith("dec-1");
    await cancelPromise;

    expect(calls).toEqual(["status", "preview", "confirm", "cancel"]);
  });

  it("invokes zero port methods and falls back to nothing for any other family", async () => {
    const { port } = makePort();
    const transport = conflictDecisionBridge(port);
    for (const request of [
      { type: "sync:conflict" },
      { type: "sync:status" },
      { type: "sync:conflictCandidate", operationId: "op-1", side: "local", expectedRevision: 0, expectedCheckpointHash: null },
      { type: "sync:conflictExport", operationId: "op-1", side: "local", expectedRevision: 0, expectedCheckpointHash: null },
      { type: "load" },
      { type: "sync:run" },
    ] as const) {
      const error = await rejected(transport(request as Request));
      expect(error).toBeInstanceOf(StorageFailureError);
      expect((error as StorageFailureError).storageFailure).toMatchObject({
        kind: "UNCLASSIFIED",
        family: "REQUEST",
        stage: "REQUEST",
        requestType: request.type,
        retryAuthority: "NONE",
        preserve: true,
      });
    }
    expect(port.status).not.toHaveBeenCalled();
    expect(port.preview).not.toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
    expect(port.cancel).not.toHaveBeenCalled();
  });

  it("keeps an UNKNOWN confirmation outcome unrepeated and reconciled by status", async () => {
    const { port } = makePort();
    vi.mocked(port.confirm).mockRejectedValueOnce(
      new Error("transport-down"),
    );
    const model = new ConflictDecisionModel(
      conflictDecisionBridge(port),
      () => true,
      () => {},
    );

    await model.refresh();
    expect(port.status).toHaveBeenCalledTimes(1);
    expect(model.snapshot().view).toEqual(idleDecisionView());

    await model.review({
      choice: "local",
      operationId: "op-conflict-1",
      expectedLocalHash: HASH_A,
      expectedRemoteRevision: 4,
      expectedRemoteHash: HASH_B,
    });
    expect(port.preview).toHaveBeenCalledTimes(1);
    expect(model.snapshot().preview?.id).toBe("pv-1");

    model.acknowledge(true);
    await model.confirm();
    expect(port.confirm).toHaveBeenCalledTimes(1);
    expect(port.confirm).toHaveBeenCalledWith("pv-1");
    expect(model.snapshot().unknown).toBe(true);

    // The model re-reads status — the failed confirm is never resent.
    await model.refresh();
    expect(port.confirm).toHaveBeenCalledTimes(1);
    expect(port.status).toHaveBeenCalledTimes(2);
    expect(model.snapshot().unknown).toBe(false);
  });

  it("routes a cancel through the same preview-independent decision lane", async () => {
    const { port } = makePort();
    vi.mocked(port.status).mockResolvedValue(requestedDecisionView());
    const model = new ConflictDecisionModel(
      conflictDecisionBridge(port),
      () => true,
      () => {},
    );
    await model.refresh();
    await model.cancel();
    expect(port.cancel).toHaveBeenCalledTimes(1);
    expect(port.cancel).toHaveBeenCalledWith("dec-1");
    expect(model.snapshot().view?.state).toBe("idle");
    expect(port.preview).not.toHaveBeenCalled();
    expect(port.confirm).not.toHaveBeenCalled();
  });
});

describe("conflict port injection — DI reaches actual root, panel and controls", () => {
  it("pins the wiring statically: App → Indicator → Panel → Controls → bridge", () => {
    const app = read("src/renderer/App.tsx");
    expect(app).toContain("conflict={appApi.conflict}");
    expect(app).toContain("capabilities={appApi.capabilities}");
    expect(app).toContain("sync={appApi.sync}");

    const indicator = read("src/renderer/WorkspaceSyncIndicator.tsx");
    expect(indicator.match(/conflict=\{conflict\}/g)).toHaveLength(2);
    expect(indicator.match(/capabilities=\{capabilities\}/g)).toHaveLength(2);
    expect(indicator).not.toContain("window.folio");
    expect(indicator).not.toContain("folio.request");

    const panel = read("src/renderer/WorkspaceConflictPanel.tsx");
    expect(panel).toContain("conflict.inspect()");
    expect(panel).toContain("conflict.readCandidate(");
    expect(panel).toContain("conflict.exportCandidate(");
    expect(panel).toContain("capabilities.read()");
    expect(panel).toContain("decision={conflict.decision}");
    expect(panel).toContain("fileExportNotice(");
    // The mount-only read is fenced by an active flag in its own effect —
    // separate from the action busy/message state.
    expect(panel).toContain("[capabilities]");
    expect(panel).not.toContain("window.folio");
    expect(panel).not.toContain("folio.request");

    const controls = read(
      "src/renderer/WorkspaceConflictDecisionControls.tsx",
    );
    expect(controls).toContain("conflictDecisionBridge(decision)");
    expect(controls).not.toContain("window.folio");
    expect(controls).not.toContain("folio.request");

    const bridge = read("src/renderer/conflict-decision-port.ts");
    for (const tag of [
      '"sync:conflictDecisionStatus"',
      '"sync:conflictPreview"',
      '"sync:conflictConfirm"',
      '"sync:conflictCancel"',
    ])
      expect(bridge).toContain(tag);
    expect(bridge).not.toContain("window.folio");
    expect(bridge).not.toContain("folio.request");
    expect(bridge).not.toContain("setTimeout");
    expect(bridge).not.toContain("setInterval");

    const api = read("src/shared/app-api.ts");
    expect(api).toContain("interface ConflictDecisionPort");
    expect(api).toContain("interface WorkspaceConflictPort");
    expect(api).toContain("readonly conflict: WorkspaceConflictPort");
    const readOnly = api.slice(
      api.indexOf("export interface ReadOnlyAppApi"),
      api.indexOf("export interface AppApi"),
    );
    expect(readOnly).not.toContain("conflict");
    expect(readOnly).not.toContain("ConflictDecisionPort");

    // The model still receives a generic transport — no public generic
    // request surface appears on the shared API.
    const model = read("src/renderer/conflict-decision-model.ts");
    expect(model).toContain("<T>(request: Request) => Promise<T>");
    expect(model).toContain('"sync:conflictDecisionStatus"');
    expect(model).toContain('"sync:conflictConfirm"');
  });

  it("exposes conflict only on the writable root — the same decision object the panel forwards", () => {
    const { bridge } = rootBridge(async () => okReply({ present: false }));
    const bindings = createDesktopRootBindings(bridge);
    expect("conflict" in bindings.readOnly).toBe(false);
    expect(typeof bindings.writable.conflict.inspect).toBe("function");
    expect(typeof bindings.writable.conflict.readCandidate).toBe("function");
    expect(typeof bindings.writable.conflict.exportCandidate).toBe("function");
    expect(typeof bindings.writable.conflict.decision.status).toBe("function");
    expect(typeof bindings.writable.conflict.decision.preview).toBe("function");
    expect(typeof bindings.writable.conflict.decision.confirm).toBe("function");
    expect(typeof bindings.writable.conflict.decision.cancel).toBe("function");
  });

  it("mounts the capability read once and never before an action — the injected port drives inspect/export", async () => {
    const conflict = {
      inspect: vi.fn(async () => fullView()),
      readCandidate: vi.fn(async () => snapshot()),
      exportCandidate: vi.fn(async () => "/tmp/out/conflict.json"),
      decision: {
        status: vi.fn(async () => idleDecisionView()),
        preview: vi.fn(),
        confirm: vi.fn(),
        cancel: vi.fn(),
      },
    } as unknown as WorkspaceConflictPort;
    const capabilities = {
      read: vi.fn(async () => ({
        version: 1,
        host: { kind: "desktop", platform: "darwin", mode: "writable" },
        features: [
          {
            id: "fileExport",
            binding: "PROVIDED",
            operation: "PROVIDED",
            readiness: "UNPROBED",
            osVerification: "NOT_RUN",
            verified: false,
            result: "DISPLAY_PATH_OR_NULL",
          },
        ],
      })),
    } as unknown as CapabilitiesReadPort;

    resetHooks();
    const props = {
      showCandidates: true,
      inputReady: () => true,
      conflict,
      capabilities,
    };
    WorkspaceConflictPanel(props);
    await tick();
    expect(capabilities.read).toHaveBeenCalledTimes(1);
    expect(conflict.inspect).not.toHaveBeenCalled();
    expect(legacyRequest).not.toHaveBeenCalled();

    rerender();
    const reopened = WorkspaceConflictPanel(props) as {
      props?: { children?: unknown };
    };
    const inspectButton = findAll(
      reopened,
      (node) =>
        node.type === "button" &&
        String(node.props?.children).includes("競合候補"),
    )[0];
    expect(inspectButton).toBeDefined();
    (inspectButton.props!.onClick as () => void)();
    await tick();
    expect(conflict.inspect).toHaveBeenCalledTimes(1);
    expect(legacyRequest).not.toHaveBeenCalled();

    rerender();
    const rendered = WorkspaceConflictPanel(props) as {
      props?: { children?: unknown };
    };
    // The capability notice is display-only connection information.
    const notices = findAll(
      rendered,
      (node) => node.props?.className === "conflict-capability-notice",
    );
    expect(notices).toHaveLength(1);
    expect(textOf(notices[0])).toContain("書き出しの利用条件");
    expect(textOf(rendered)).not.toContain("rawSalvage");

    const exportButton = findAll(
      rendered,
      (node) =>
        node.type === "button" &&
        String(node.props?.children).includes("JSONを書き出す"),
    )[0];
    expect(exportButton).toBeDefined();
    (exportButton.props!.onClick as () => void)();
    await tick();
    expect(conflict.exportCandidate).toHaveBeenCalledTimes(1);
    expect(conflict.exportCandidate).toHaveBeenCalledWith({
      operationId: "op-conflict-1",
      side: "local",
      expectedRevision: 5,
      expectedCheckpointHash: HASH_A,
    });
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it("reaches the existing model through the bridge — decision.status is invoked by mount refresh", async () => {
    const decision = {
      status: vi.fn(async () => idleDecisionView()),
      preview: vi.fn(async () => preview()),
      confirm: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ConflictDecisionPort;
    resetHooks();
    WorkspaceConflictDecisionControls({
      conflict: null,
      inputReady: () => true,
      onReview: () => {},
      decision,
    });
    await tick();
    expect(decision.status).toHaveBeenCalledTimes(1);
    expect(decision.preview).not.toHaveBeenCalled();
    expect(decision.confirm).not.toHaveBeenCalled();
    expect(decision.cancel).not.toHaveBeenCalled();
    expect(legacyRequest).not.toHaveBeenCalled();
  });
});
