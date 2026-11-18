import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as ReactMock from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveStateDetails, type SaveStateDetailRow } from "../src/renderer/SaveStateDetails";
import { WorkspaceTools } from "../src/renderer/WorkspaceTools";
import { closeDetailsOnEscape } from "../src/renderer/details-keyboard";
import { StoragePressurePanel } from "../src/renderer/StoragePressurePanel";
import { WorkspaceMaintenancePanel } from "../src/renderer/WorkspaceMaintenancePanel";
import type { StorageReadPort } from "../src/shared/app-api";

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
    // Fresh mount: hook indices and state slots restart.
    __resetHooks: () => {
      index = 0;
      slots.splice(0);
    },
    // Re-render of an already mounted tree: indices restart, state persists.
    __nextRender: () => {
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
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
  };
});

const resetHooks = () =>
  (ReactMock as unknown as { __resetHooks(): void }).__resetHooks();
const nextRender = () =>
  (ReactMock as unknown as { __nextRender(): void }).__nextRender();
const createElement = ReactMock.createElement;

const root = resolve(__dirname, "..");
const readSource = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type AnyElement = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};
const findAll = (
  node: unknown,
  pred: (element: AnyElement) => boolean,
  out: AnyElement[] = [],
): AnyElement[] => {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const element = node as AnyElement;
  if (element.props && typeof element.props === "object") {
    if (pred(element)) out.push(element);
    findAll(element.props.children, pred, out);
  }
  return out;
};
const textTree = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textTree).join("");
  const element = node as AnyElement;
  if (element.props) return textTree(element.props.children);
  return "";
};

const fakeStorage = (snapshot?: unknown) =>
  ({ readPressure: vi.fn(async () => snapshot) }) as unknown as StorageReadPort;

describe("WorkspaceTools — the always-mounted 保存と復旧 entry", () => {
  it("mounts both stateful panels unconditionally inside one native details", () => {
    resetHooks();
    const onRepairOrder = vi.fn();
    const storage = fakeStorage();
    const element = WorkspaceTools({ storage, onRepairOrder }) as AnyElement;
    expect(element.type).toBe("details");
    const body = findAll(
      element,
      (node) =>
        node.type === "div" &&
        node.props?.className === "workspace-tools-body",
    )[0];
    expect(body).toBeDefined();
    const panels = findAll(
      body!.props!.children,
      (node) =>
        node.type === StoragePressurePanel ||
        node.type === WorkspaceMaintenancePanel,
    );
    // Both panels are direct unconditional children: nothing between the
    // closed disclosure and them can unmount running state or drafts.
    expect(panels).toHaveLength(2);
    expect(panels[0].type).toBe(StoragePressurePanel);
    expect(panels[0].props!.storage).toBe(storage);
    expect(panels[1].type).toBe(WorkspaceMaintenancePanel);
    expect(panels[1].props!.onRepairOrder).toBe(onRepairOrder);
  });

  it("re-renders the same disclosure tree — children are never conditionally unmounted", () => {
    resetHooks();
    const storage = fakeStorage();
    for (const render of [nextRender(), nextRender(), nextRender()]) {
      void render;
      const tree = WorkspaceTools({ storage }) as AnyElement;
      expect(tree.type).toBe("details");
      expect(
        findAll(tree, (node) => node.type === StoragePressurePanel),
      ).toHaveLength(1);
      expect(
        findAll(tree, (node) => node.type === WorkspaceMaintenancePanel),
      ).toHaveLength(1);
    }
  });

  it("mounts the caller's conflict-recovery rescue inside the same body", () => {
    resetHooks();
    const rescue = createElement(
      "details",
      { className: "conflict-recovery-details" },
      createElement("summary", null, "保全した競合データを取り出す"),
    );
    const element = WorkspaceTools({
      storage: fakeStorage(),
      conflictRecovery: rescue,
    }) as AnyElement;
    const body = findAll(
      element,
      (node) =>
        node.type === "div" &&
        node.props?.className === "workspace-tools-body",
    )[0];
    const mounted = findAll(
      body!.props!.children,
      (node) => node === rescue,
    );
    expect(mounted).toHaveLength(1);
  });

  it("surfaces a retained blocked/unknown observation on the closed summary without a read", () => {
    resetHooks();
    const storage = fakeStorage();
    for (const [observation, label] of [
      ["blocked", "空き容量が不足"],
      ["unknown", "空き容量を確認"],
      ["error", "空き容量を確認"],
    ] as const) {
      resetHooks();
      const first = WorkspaceTools({ storage }) as AnyElement;
      const panel = findAll(
        first,
        (node) => node.type === StoragePressurePanel,
      )[0];
      // The panel mirrors its retained state out through the display-only
      // callback — the disclosure may then close while the warning stays.
      (panel!.props!.onObservation as (state: string) => void)(observation);
      nextRender();
      const closed = WorkspaceTools({ storage }) as AnyElement;
      expect(textTree(closed)).toContain(label);
      const chips = findAll(
        closed,
        (node) => node.props?.className === "workspace-tools-alert",
      );
      expect(chips).toHaveLength(1);
      expect(chips[0].props!["data-pressure"]).toBe(observation);
    }
    // Mirroring and re-showing never performed a read of its own.
    expect(storage.readPressure).not.toHaveBeenCalled();
  });

  it("shows no warning chip for a ready or unobserved state", () => {
    resetHooks();
    const tree = WorkspaceTools({ storage: fakeStorage() }) as AnyElement;
    expect(
      findAll(tree, (node) => node.props?.className === "workspace-tools-alert"),
    ).toHaveLength(0);
    const panel = findAll(tree, (node) => node.type === StoragePressurePanel)[0];
    (panel!.props!.onObservation as (state: string) => void)("ready");
    nextRender();
    const ready = WorkspaceTools({ storage: fakeStorage() }) as AnyElement;
    expect(
      findAll(ready, (node) => node.props?.className === "workspace-tools-alert"),
    ).toHaveLength(0);
  });

  it("uses the shared nested-details Escape rule on its own summary", () => {
    resetHooks();
    const tree = WorkspaceTools({ storage: fakeStorage() }) as AnyElement;
    expect(tree.props!.onKeyDown).toBe(closeDetailsOnEscape);
  });

  it("SSR markup keeps the panel sections inside the closed disclosure — hidden, not removed", () => {
    resetHooks();
    const markup = renderToStaticMarkup(
      createElement(WorkspaceTools, {
        storage: fakeStorage(),
        onRepairOrder: () => {},
      }),
    );
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("保存と復旧");
    expect(markup).toContain('aria-label="保存先の空き容量"');
    expect(markup).toContain('aria-label="ワークスペースの保守"');
    expect(markup).toContain("診断用の原本を救出");
  });

  it("keeps a mounted panel's view state across re-renders of the same tree", async () => {
    const snapshot = {
      availableBytes: 8 * 1024 ** 3,
      reserveBytes: 1024 ** 3,
      checkedAt: "2026-11-15T00:00:00.000Z",
      state: "ready",
    };
    const storage = fakeStorage(snapshot);
    resetHooks();
    let tree = StoragePressurePanel({ storage }) as never as AnyElement;
    const button = findAll(tree, (node) => node.type === "button")[0];
    (button!.props!.onClick as () => void)();
    await tick();
    nextRender();
    tree = StoragePressurePanel({ storage }) as never as AnyElement;
    expect(textTree(tree)).toContain("GiB");
    expect(storage.readPressure).toHaveBeenCalledTimes(1);
  });
});

describe("App shell wiring (AST)", () => {
  const app = () => readSource("src/renderer/App.tsx");

  it("starts with the inspector closed", () => {
    expect(app()).toContain("inspector, setInspector] = useState(false)");
  });

  it("mounts WorkspaceTools once outside the inert topbar-actions group", () => {
    const source = app();
    expect(source.match(/<WorkspaceTools[\s>]/g)).toHaveLength(1);
    const toolsIndex = source.indexOf("<WorkspaceTools");
    const inertIndex = source.indexOf('className="topbar-group topbar-actions"');
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(inertIndex).toBeGreaterThan(toolsIndex);
    // The old inspector and empty-workspace duplicate mounts are gone.
    expect(source.match(/<StoragePressurePanel /g)).toBeNull();
    expect(source.match(/<WorkspaceMaintenancePanel /g)).toBeNull();
  });

  it("moves the conflict-recovery rescue into the always-mounted tools, out of the inert group", () => {
    const source = app();
    // Exactly one mount of the existing panel and its details, unchanged.
    expect(source.match(/<WorkspaceConflictRecoveryPanel port=\{conflictRecoveryPort\} \/>/g)).toHaveLength(1);
    expect(source.match(/className="conflict-recovery-details"/g)).toHaveLength(1);
    // It lives inside the WorkspaceTools conflictRecovery slot — reachable
    // through 保存と復旧 while a record makes topbar-actions inert.
    expect(source).toContain("conflictRecovery={");
    const slotIndex = source.indexOf("conflictRecovery={");
    const detailsIndex = source.indexOf('className="conflict-recovery-details"');
    const inertIndex = source.indexOf('className="topbar-group topbar-actions"');
    expect(slotIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(slotIndex);
    expect(inertIndex).toBeGreaterThan(detailsIndex);
    // The old topbar-actions mount is gone: nothing recovery-related remains
    // after the inert group starts besides the panel itself.
    const afterInert = source.slice(inertIndex);
    expect(afterInert).not.toContain("conflict-recovery-details");
    expect(afterInert).not.toContain("WorkspaceConflictRecoveryPanel");
  });

  it("keeps the nested Escape handlers on the shared composition-aware rule", () => {
    const source = app();
    expect(source).toContain('import { closeDetailsOnEscape } from "./details-keyboard";');
    // No inline JSX handler may re-implement its own Escape-close rule.
    for (const match of source.matchAll(/onKeyDown=\{([^}]+)\}/g))
      if (/key\s*[=!]==?\s*"Escape"/.test(match[1]))
        throw new Error("inline Escape handler bypasses the shared rule");
    expect(
      readSource("src/renderer/WorkspaceTools.tsx"),
    ).toContain('import { closeDetailsOnEscape } from "./details-keyboard";');
    const keyboard = readSource("src/renderer/details-keyboard.ts");
    expect(keyboard).toContain("composing(event)");
    // React's synthetic event carries the composition flags on nativeEvent.
    expect(keyboard).toContain("event.nativeEvent");
    expect(keyboard).toContain("defaultPrevented");
  });

  it("keeps the exact upper save-state decision expression unchanged", () => {
    expect(app()).toContain(
      'data-state={error ? "error" : pending || edits.current.size || sessions.current.hasUnsaved() || hasNumberDrafts() || hasDatabasePending() || recoveryStatus?.state !== "saved" || recoveryError ? "pending" : "saved"}',
    );
  });

  it("feeds the disclosure controlled rows projected from the original state maps", () => {
    const source = app();
    expect(
      source.match(/<SaveStateDetails rows=\{saveStateRows\} \/>/g),
    ).toHaveLength(1);
    // The projection is a pure display module — App only hands it the
    // original owner state, never a derived status or a new request.
    expect(source).toContain(
      'from "./save-state-presentation";',
    );
    const start = source.indexOf("const saveStateRows");
    const end = source.indexOf("saveStateAlertChips", start);
    const block = source.slice(start, end);
    for (const marker of [
      "pageOperations.current",
      "pageStorageFailures.current",
      "edits.current.failed",
      "recordIds",
      "recordDatabaseIdsRef.current",
      'kind === "database"',
      "liveDatabaseCount",
      "sessions.current.views()",
      "databases.current.views()",
      "hasNumberDrafts()",
      "hasFilterDrafts()",
      "databaseCreation.current",
      "pageCreation.current?.entries()",
      "recoveryStatus?.state",
    ])
      expect(block).toContain(marker);
    // first* helpers would drop every retained entry after the first.
    expect(block).not.toContain("firstRejected()");
    expect(block).not.toContain("firstUnknown()");
    expect(block).not.toContain("firstUncheckpointed()");
  });

  it("keeps per-target anomaly chips visible on the closed summary", () => {
    const source = app();
    expect(source).toContain("saveStateAlerts(saveStateRows)");
    expect(source).toContain("saveStateAlertChips.map(");
    // The chips render inside the summary — outside the closed details body.
    const summary = source.slice(
      source.indexOf('<summary className="save-state-menu-summary">'),
      source.indexOf("</summary>"),
    );
    expect(summary).toContain("saveStateAlertChips.map(");
    expect(summary).toContain('className="save-state-alert"');
    // Fixed labels only — raw error text never reaches the topbar chip.
    expect(summary).not.toContain("alert.detail");
    expect(summary).not.toContain("{error}");
  });

  it("keeps the independent anomaly and rescue surfaces outside the details", () => {
    const source = app();
    for (const marker of [
      'className="error-banner"',
      'className="r6-recovery-status"',
      'className="conflict-recovery-details"',
      'className="r5-database-operation"',
      "退避JSONから復旧",
      "未保存の変更を別ファイルに記録",
      "原本JSONを保存",
      "openOrderRepair",
    ])
      expect(source).toContain(marker);
  });

  it("keeps the retry action resolve-only with the original guards", () => {
    const source = app();
    expect(source.match(/resolvePageSaves\(true\)/g)).toHaveLength(1);
    expect(source.match(/保存を再試行/g)).toHaveLength(1);
    expect(source).toContain(
      'latchedRecoveryError() ? "復旧用保存を確認してから再試行" : "保存を再試行"',
    );
  });

  it("moves kind/updatedAt from above the body into the information pane", () => {
    const source = app();
    expect(source).not.toContain("page-subtitle");
    expect(source).toContain("<dt>種類</dt>");
    expect(source).toContain("<dt>更新日</dt>");
    expect(source).toContain("page.updatedAt");
  });

  it("imports only the new chrome stylesheet for the added UI", () => {
    const source = app();
    expect(source).toContain('import "./ui-chrome.css";');
    expect(source).not.toContain("styles.css");
  });
});

describe("slots stay connected", () => {
  const app = () => readSource("src/renderer/App.tsx");

  it("passes the existing width control through the RecordPage displayOptions slot, not the body", () => {
    const source = app();
    expect(source.match(/displayOptions=/g)).toHaveLength(1);
    expect(source).toContain("displayOptions={<PageLayoutControl");
    expect(source).not.toContain("body={<><PageLayoutControl");
    // The Editor keeps its session-bound key and wiring untouched.
    expect(source).toContain("key={openedRecord.handle.sessionId}");
  });

  it("keeps exactly the menu 表示 section and the record display slot for PageLayoutControl", () => {
    const source = app();
    expect(source.match(/<PageLayoutControl /g)).toHaveLength(2);
    expect(source).toContain('menu-section-label">表示');
    expect(source).toContain("update(page.id, {width})");
    expect(source).toContain("editRecord(recordView.id, {width})");
  });

  it("connects schemaActions as プロパティを編集 while 新規行 stays in toolbarActions", () => {
    const source = readSource("src/renderer/LiveRecordDatabase.tsx");
    expect(source.match(/schemaActions=/g)).toHaveLength(1);
    expect(source.match(/toolbarActions=/g)).toHaveLength(1);
    const schema = source.slice(
      source.indexOf("schemaActions="),
      source.indexOf("toolbarActions="),
    );
    expect(schema).toContain("onOpenProperties");
    expect(schema).toContain("プロパティを編集");
    const toolbar = source.slice(source.indexOf("toolbarActions="));
    expect(toolbar).toContain("新規行");
    expect(toolbar).not.toContain("onOpenProperties");
    expect(source).not.toContain("列の設定");
  });
});

describe("SaveStateDetails — controlled display of simultaneous states", () => {
  it("renders simultaneous UNKNOWN/conflict/recovery-error rows independently", () => {
    const rows: SaveStateDetailRow[] = [
      { id: "body:op-1", target: "本文", label: "ページA", state: "unknown", detail: "結果を確認しています。" },
      { id: "record:r-1", target: "レコード", label: "レコードB", state: "unknown" },
      { id: "record:r-2", target: "レコード", label: "レコードC", state: "conflict", detail: "競合を保持" },
      { id: "recovery", target: "復旧用保存", label: "チェックポイント", state: "error", detail: "復旧記録を保存できません" },
    ];
    const markup = renderToStaticMarkup(
      createElement(SaveStateDetails, { rows }),
    );
    expect(markup.match(/<li /g)).toHaveLength(4);
    expect(markup.match(/data-state="unknown"/g)).toHaveLength(2);
    expect(markup).toContain('data-target="本文"');
    expect(markup).toContain('data-state="conflict"');
    expect(markup).toContain('data-state="error"');
    expect(markup).toContain("復旧記録を保存できません");
  });

  it("never upgrades an unknown or held row into a success claim", () => {
    const rows: SaveStateDetailRow[] = [
      { id: "a", target: "本文", label: "ページA", state: "unknown" },
      { id: "b", target: "レコード", label: "レコードB", state: "blocked" },
    ];
    const markup = renderToStaticMarkup(
      createElement(SaveStateDetails, { rows }),
    );
    expect(markup).not.toContain("保存済み");
    expect(markup).toContain("結果を確認");
    expect(markup).toContain("保存を停止");
  });

  it("renders the clean per-target confirmation concisely", () => {
    const rows: SaveStateDetailRow[] = [
      { id: "target:body", target: "本文", label: "通常ページ", state: "saved" },
      { id: "target:record", target: "レコード", label: "値と本文", state: "none", detail: "対象なし" },
      { id: "target:database", target: "データベース設定", label: "ビューと表示条件", state: "none", detail: "対象なし" },
      { id: "target:recovery", target: "復旧用保存", label: "チェックポイント", state: "saved" },
    ];
    const markup = renderToStaticMarkup(
      createElement(SaveStateDetails, { rows }),
    );
    expect(markup.match(/data-state="saved"/g)).toHaveLength(2);
    expect(markup.match(/data-state="none"/g)).toHaveLength(2);
    expect(markup).toContain("保存済み");
    expect(markup).toContain("対象なし");
  });
});

describe("ui-chrome.css drag-region and motion contract", () => {
  const css = () => readSource("src/renderer/ui-chrome.css");

  it("opts every new topbar surface out of the Electron drag region", () => {
    const source = css();
    // The enclosing group, both disclosures and both panels are covered — the
    // summaries and panels are not buttons, so drag would otherwise win.
    for (const selector of [
      ".topbar-shell-tools",
      ".save-state-menu",
      ".save-state-panel",
      ".workspace-tools",
      ".workspace-tools-body",
    ])
      expect(source).toContain(selector);
    expect(source.match(/-webkit-app-region:\s*no-drag/g)).toBeTruthy();
    // Interactive children under the group are covered explicitly too.
    expect(source).toMatch(
      /\.topbar-shell-tools\s+(details|summary|section|button|input)/,
    );
  });

  it("stops the summary arrow transition under prefers-reduced-motion", () => {
    const source = css();
    expect(source).toContain("transition: transform 120ms ease");
    const media = source.slice(
      source.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(media).toContain("summary::before");
    expect(media).toContain("transition: none");
  });
});

describe("zero unauthorized send authority", () => {
  it("the new chrome components own no transport or send", () => {
    for (const path of [
      "src/renderer/WorkspaceTools.tsx",
      "src/renderer/SaveStateDetails.tsx",
      "src/renderer/save-state-presentation.ts",
      "src/renderer/details-keyboard.ts",
    ]) {
      const source = readSource(path);
      expect(source, path).not.toContain("window");
      expect(source, path).not.toContain("folio");
      expect(source, path).not.toMatch(
        /\b(api|send|request|commit|flush|resolve|retry)\s*\(/,
      );
    }
    // SaveStateDetails stays fully controlled — no state at all. WorkspaceTools
    // may keep display-only local state for the retained observation chip, but
    // still no effects, buttons or clicks of its own.
    const details = readSource("src/renderer/SaveStateDetails.tsx");
    expect(details).not.toContain("useState");
    expect(details).not.toContain("useEffect");
    const tools = readSource("src/renderer/WorkspaceTools.tsx");
    expect(tools).not.toContain("useEffect");
    expect(tools).not.toContain("<button");
    expect(tools).not.toContain("onClick");
  });

  it("the pressure observation stays a display-only mirror — no read authority", () => {
    const panel = readSource("src/renderer/StoragePressurePanel.tsx");
    // The callback is optional (StageA/read-only callers unaffected) and the
    // only send remains the original manual readPressure on the button.
    expect(panel).toContain("onObservation?:");
    expect(panel.match(/storage\.readPressure\(\)/g)).toHaveLength(1);
    const tools = readSource("src/renderer/WorkspaceTools.tsx");
    expect(tools).toContain("onObservation={setPressure}");
    expect(tools).not.toContain("readPressure");
    // Re-showing the summary must not cause extra reads: the chip derives
    // from the retained state, not from a probe.
    const appSource = app();
    expect(appSource).not.toContain("readPressure");
  });

  it("the saveStateRows call performs no send, flush, resolve or request", () => {
    const source = app();
    const start = source.indexOf("const saveStateRows");
    const block = source.slice(
      start,
      source.indexOf("saveStateAlertChips", start),
    );
    expect(block).not.toMatch(
      /\b(api|send|request|commit|flush|resolve|retryReliableSave|sendReliableSave|resolveReliableSave|resolveDatabaseOperation|sendDatabaseOperation)\s*\(/,
    );
    expect(block).not.toContain("window");
    expect(block).not.toContain("folio");
  });
});

const app = () => readSource("src/renderer/App.tsx");
