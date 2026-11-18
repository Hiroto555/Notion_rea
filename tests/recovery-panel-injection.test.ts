import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReadOnlyAppApi,
  StorageReadPort,
} from "../src/shared/app-api";
import type { StartupStatus } from "../src/shared/startup-status";
import type { Snapshot } from "../src/shared/types";
import type { Doc } from "../src/shared/types";
import { ReadOnlyWorkspace } from "../src/renderer/ReadOnlyWorkspace";
import { StoragePressurePanel } from "../src/renderer/StoragePressurePanel";
import * as ReactMock from "react";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  let index = 0;
  const slots: unknown[] = [];
  const cleanups: (() => void)[] = [];
  const slot = (init: unknown) => {
    if (!(index in slots)) slots[index] = init;
    return slots[index++];
  };
  return {
    ...actual,
    // Fresh mount: clears state slots and pending cleanups (per test).
    __resetHooks: () => {
      index = 0;
      slots.splice(0);
      cleanups.splice(0);
    },
    // Re-render: hook indices restart from 0 while state slots persist.
    __nextRender: () => {
      index = 0;
    },
    __takeCleanups: () => cleanups.splice(0),
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
    // Deps-aware: an effect whose dep list is unchanged does not re-run, and
    // a changed dep list runs the previous cleanup first — like React.
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const i = index++;
      if (!(i in slots))
        slots[i] = { deps: undefined, cleanup: undefined };
      const record = slots[i] as {
        deps: unknown[] | undefined;
        cleanup: (() => void) | undefined;
      };
      const changed =
        deps === undefined ||
        record.deps === undefined ||
        deps.length !== record.deps.length ||
        deps.some((dep, j) => !Object.is(dep, record.deps![j]));
      if (!changed) return;
      record.deps = deps?.slice();
      if (record.cleanup) record.cleanup();
      const cleanup = fn();
      if (typeof cleanup === "function") {
        record.cleanup = cleanup as () => void;
        cleanups.push(cleanup as () => void);
      }
    },
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
  };
});

const resetHooks = () =>
  (ReactMock as unknown as { __resetHooks(): void }).__resetHooks();
const nextRender = () =>
  (ReactMock as unknown as { __nextRender(): void }).__nextRender();
const takeCleanups = () =>
  (ReactMock as unknown as { __takeCleanups(): (() => void)[] }).__takeCleanups();

const renderWorkspace = (api: ReadOnlyAppApi) => {
  nextRender();
  return ReadOnlyWorkspace({ status, api }) as never;
};
const renderPanel = (storage: StorageReadPort) => {
  nextRender();
  return StoragePressurePanel({ storage }) as never;
};

const root = resolve(__dirname, "..");
const readSource = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");
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

const textTree = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textTree).join("");
  if (!node || typeof node !== "object") return "";
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return children === undefined ? "" : textTree(children);
};

const textDoc = (text: string): Doc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const snapshot: Snapshot = {
  pages: [
    {
      id: "p-1",
      parentId: null,
      title: "メモ",
      icon: "📄",
      cover: "",
      position: 0,
      doc: textDoc("本文テキスト"),
      kind: "page",
      database: null,
      favorite: false,
      createdAt: 1,
      updatedAt: 2,
      revision: 3,
      deletedAt: null,
    },
  ],
  settings: {},
};
const status: StartupStatus = { mode: "readOnly", message: "閲覧のみ" };

function makeReadOnlyApi(overrides: {
  capabilitiesRead?: () => Promise<unknown>;
} = {}) {
  const api = {
    workspace: {
      load: vi.fn(async () => snapshot),
    },
    original: {
      readOriginal: vi.fn(async (_pageId: string) => "原本JSON"),
      exportOriginal: vi.fn(async () => "/tmp/out/page.json"),
    },
    recovery: {
      salvageRaw: vi.fn(async () => ({
        directory: "/tmp/salvage",
        files: 2,
        bytes: 128,
      })),
    },
    capabilities: {
      read: vi.fn(overrides.capabilitiesRead ?? (async () => null)),
    },
  };
  return api as unknown as ReadOnlyAppApi & {
    workspace: { load: ReturnType<typeof vi.fn> };
    original: {
      readOriginal: ReturnType<typeof vi.fn>;
      exportOriginal: ReturnType<typeof vi.fn>;
    };
    recovery: { salvageRaw: ReturnType<typeof vi.fn> };
    capabilities: { read: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  resetHooks();
});

describe("ReadOnlyWorkspace port injection", () => {
  it("mounts with one load and one capability read", async () => {
    const api = makeReadOnlyApi();
    renderWorkspace(api);
    expect(api.workspace.load).toHaveBeenCalledTimes(1);
    expect(api.capabilities.read).toHaveBeenCalledTimes(1);
    await tick();
    const element = renderWorkspace(api);
    expect(textTree(element)).toContain("本文テキスト");
    expect(api.workspace.load).toHaveBeenCalledTimes(1);
    expect(api.capabilities.read).toHaveBeenCalledTimes(1);
  });

  it("runs the original read/export and the raw salvage through the injected ports", async () => {
    const api = makeReadOnlyApi();
    renderWorkspace(api);
    await tick();
    const element = renderWorkspace(api);
    const buttons = findAll(element, (node) => node.type === "button");
    const exportButton = buttons.find((node) =>
      String(node.props?.children).includes("原本JSON"),
    );
    const salvageButton = buttons.find((node) =>
      String(node.props?.children).includes("救出"),
    );
    expect(exportButton).toBeDefined();
    expect(salvageButton).toBeDefined();
    (exportButton!.props!.onClick as () => void)();
    await tick();
    expect(api.original.readOriginal).toHaveBeenCalledWith("p-1");
    expect(api.original.exportOriginal).toHaveBeenCalledWith({
      name: "メモ",
      content: "原本JSON",
    });
    let rendered = renderWorkspace(api);
    expect(textTree(rendered)).toContain("書き出し先 /tmp/out/page.json");
    (salvageButton!.props!.onClick as () => void)();
    await tick();
    expect(api.recovery.salvageRaw).toHaveBeenCalledTimes(1);
    rendered = renderWorkspace(api);
    expect(textTree(rendered)).toContain("救出先 /tmp/salvage");
    expect(textTree(rendered)).toContain(
      "救出の利用条件は操作時に確認してください。",
    );
  });

  it("never makes an action await the capability read", async () => {
    let resolveCapabilities: ((value: unknown) => void) | undefined;
    const api = makeReadOnlyApi({
      capabilitiesRead: () =>
        new Promise((resolve) => {
          resolveCapabilities = resolve;
        }),
    });
    renderWorkspace(api);
    await tick();
    const element = renderWorkspace(api);
    const exportButton = findAll(
      element,
      (node) =>
        node.type === "button" &&
        String(node.props?.children).includes("原本JSON"),
    )[0];
    (exportButton!.props!.onClick as () => void)();
    await tick();
    // The export completed end to end while the capability read is still
    // pending — the notice is display-only, never a precondition.
    expect(api.original.readOriginal).toHaveBeenCalledWith("p-1");
    expect(api.original.exportOriginal).toHaveBeenCalledTimes(1);
    resolveCapabilities!(null);
    await tick();
  });

  it("keeps the original text and error surface unchanged when capability info fails", async () => {
    const api = makeReadOnlyApi({
      capabilitiesRead: async () => {
        throw new Error("capability transport is down");
      },
    });
    renderWorkspace(api);
    await tick();
    const element = renderWorkspace(api);
    const text = textTree(element);
    expect(text).toContain("本文テキスト");
    expect(text).toContain("書き出し機能の情報を確認できません。");
    expect(text).not.toContain("capability transport is down");
  });

  it("drops a capability reply that arrives after unmount", async () => {
    let resolveCapabilities: ((value: unknown) => void) | undefined;
    const api = makeReadOnlyApi({
      capabilitiesRead: () =>
        new Promise((resolve) => {
          resolveCapabilities = resolve;
        }),
    });
    renderWorkspace(api);
    await tick();
    for (const cleanup of takeCleanups()) cleanup();
    resolveCapabilities!({
      version: 1,
      host: { kind: "desktop", platform: "darwin", mode: "read-only" },
      features: [],
    });
    await tick();
    const element = renderWorkspace(api);
    const text = textTree(element);
    expect(text).not.toContain("書き出し画面の機能が未接続");
    expect(text).not.toContain("書き出し機能の情報を確認");
    expect(text).not.toContain("書き出しの利用条件");
  });
});

describe("StoragePressurePanel storage port injection", () => {
  const base = {
    checkedAt: "2026-11-15T01:02:03.000Z",
    reserveBytes: 268_435_456,
    additionalBytes: 0,
  };

  function panelWith(snapshotValue: unknown) {
    const storage = {
      readPressure: vi.fn(async () => snapshotValue),
    };
    return storage as unknown as StorageReadPort & {
      readPressure: ReturnType<typeof vi.fn>;
    };
  }

  async function press(storage: StorageReadPort) {
    resetHooks();
    const element = renderPanel(storage);
    const button = findAll(element, (node) => node.type === "button")[0];
    (button!.props!.onClick as () => void)();
    await tick();
    return renderPanel(storage);
  }

  it("renders the ready state as produced", async () => {
    const storage = panelWith({
      ...base,
      state: "ready",
      availableBytes: 4 * 1024 ** 3,
    });
    const element = await press(storage);
    const text = textTree(element);
    expect(text).toContain("確認時点では、保存用の空き容量があります。");
    expect(text).toContain("4.0 GiB");
    expect(storage.readPressure).toHaveBeenCalledTimes(1);
  });

  it("distinguishes blocked from ready and unknown from measured space", async () => {
    const blocked = panelWith({
      ...base,
      state: "blocked",
      availableBytes: 1,
      reason: "capacity-exceeded",
    });
    const blockedText = textTree(await press(blocked));
    expect(blockedText).toContain(
      "空き容量が少ないため、新しい保存を停止しています。",
    );
    const unknown = panelWith({
      ...base,
      state: "unknown",
      availableBytes: null,
      reason: "capacity-unknown",
    });
    const unknownText = textTree(await press(unknown));
    expect(unknownText).toContain(
      "空き容量を確認できないため、新しい保存を停止しています。",
    );
    expect(unknownText).toContain("未確認");
    expect(unknownText).not.toContain("空き容量が少ないため");
  });

  it("shows the bounded failure text on a port rejection and sends once while busy", async () => {
    const storage = {
      readPressure: vi.fn(() => new Promise(() => {})),
    } as unknown as StorageReadPort & {
      readPressure: ReturnType<typeof vi.fn>;
    };
    const element = renderPanel(storage);
    const button = findAll(element, (node) => node.type === "button")[0];
    (button!.props!.onClick as () => void)();
    const whileBusy = renderPanel(storage);
    const busyButton = findAll(whileBusy, (node) => node.type === "button")[0];
    (busyButton!.props!.onClick as () => void)();
    await tick();
    expect(storage.readPressure).toHaveBeenCalledTimes(1);
    resetHooks();

    const failing = {
      readPressure: vi.fn(async () => {
        throw new Error("storage transport is down");
      }),
    } as unknown as StorageReadPort;
    const failedText = textTree(await press(failing));
    expect(failedText).toContain("空き容量を確認できませんでした");
    expect(failedText).not.toContain("transport is down");
  });
});

describe("actual App and panel wiring", () => {
  it("passes the writable storage port to the single always-mounted StoragePressurePanel", () => {
    const source = readSource("src/renderer/App.tsx");
    // The panel moved into one always-mounted WorkspaceTools disclosure; the
    // old inspector/empty-workspace duplicates are gone, the port is identical.
    expect(source.match(/<StoragePressurePanel /g)).toBeNull();
    expect(source.match(/<WorkspaceTools[\s>]/g)).toHaveLength(1);
    expect(source.match(/storage=\{appApi\.storage\}/g)).toHaveLength(1);
    const tools = readSource("src/renderer/WorkspaceTools.tsx");
    expect(tools.match(/<StoragePressurePanel /g)).toHaveLength(1);
    expect(tools).toContain("storage={storage}");
    const panel = readSource("src/renderer/StoragePressurePanel.tsx");
    expect(panel).toContain("storage: StorageReadPort");
    expect(panel).not.toContain("window.folio");
    const readOnly = readSource("src/renderer/ReadOnlyWorkspace.tsx");
    expect(readOnly).not.toContain("window.folio");
  });
});
