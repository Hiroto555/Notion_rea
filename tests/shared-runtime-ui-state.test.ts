import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SharedWorkspacePanel,
  sharedRoleLabel,
  type SharedPanelPort,
} from "../src/renderer/shared/SharedWorkspacePanel";
import {
  allowsRecovery,
  projectRuntimeView,
  requiresReceiptRetry,
  sharedRuntimeStateLabel,
  type RuntimeProjectionInput,
  type SharedRuntimeStage,
  type SharedRuntimeView,
} from "../src/renderer/shared/runtime-state";

const base: RuntimeProjectionInput = {
  stage: "SERVER_ACCEPTED",
  readonly: false,
  online: true,
  pending: 0,
  rejection: null,
  scopeLabel: "組織A / 作品 / 第一章",
};

const allStages: readonly SharedRuntimeStage[] = [
  "UNSAVED",
  "LOCAL_DURABLE",
  "SERVER_ACCEPTED",
  "CLIENT_RECEIPT_DURABLE",
  "PEER_APPLIED",
  "UNKNOWN",
  "REJECTED",
  "OFFLINE",
  "READ_ONLY",
];

const editableStages: readonly SharedRuntimeStage[] = [
  "UNSAVED",
  "LOCAL_DURABLE",
  "SERVER_ACCEPTED",
  "CLIENT_RECEIPT_DURABLE",
  "PEER_APPLIED",
];

function project(
  overrides: Partial<RuntimeProjectionInput>,
): SharedRuntimeView {
  return projectRuntimeView({ ...base, ...overrides });
}

describe("projectRuntimeView", () => {
  it("projects every legal stage without inventing an acknowledgement", () => {
    for (const stage of allStages) {
      const view = project({ stage });
      expect(view.state).toBe(stage);
      expect(view.scopeLabel).toBe(base.scopeLabel);
      expect(view.pending).toBe(0);
      expect(view.canEdit).toBe(editableStages.includes(stage));
      expect(view.message.length).toBeGreaterThan(0);
    }
  });

  it("keeps UNKNOWN non-editable and limited to receipt retry", () => {
    const view = project({ stage: "UNKNOWN" });
    expect(view.state).toBe("UNKNOWN");
    expect(view.canEdit).toBe(false);
    expect(view.message).toContain("再試行");
    expect(view.message).toContain("受付状態");
    expect(requiresReceiptRetry(view)).toBe(true);
    expect(allowsRecovery(view)).toBe(false);
  });

  it("keeps UNKNOWN when the connection is also offline", () => {
    const view = project({ stage: "UNKNOWN", online: false });
    expect(view.state).toBe("UNKNOWN");
    expect(view.canEdit).toBe(false);
    expect(view.message).toContain("再試行");
  });

  it("never claims server acceptance for unacknowledged states", () => {
    for (const stage of [
      "UNSAVED",
      "LOCAL_DURABLE",
      "UNKNOWN",
      "OFFLINE",
      "REJECTED",
      "READ_ONLY",
    ] as const) {
      expect(project({ stage }).message).not.toContain("変更を受け付けました");
    }
  });

  it("distinguishes durable local changes from unsaved changes while offline", () => {
    const durable = project({ stage: "LOCAL_DURABLE", online: false });
    expect(durable.state).toBe("OFFLINE");
    expect(durable.canEdit).toBe(false);
    expect(durable.message).toContain("端末に保存済み");
    expect(durable.message).toContain("未送信");

    const unsaved = project({ stage: "UNSAVED", online: false });
    expect(unsaved.state).toBe("OFFLINE");
    expect(unsaved.message).toContain("まだ保存されていません");
    expect(unsaved.message).not.toContain("端末に保存済み");
    expect(unsaved.message).not.toBe(durable.message);
  });

  it("does not call an accepted change unsent when offline", () => {
    const view = project({ stage: "SERVER_ACCEPTED", online: false });
    expect(view.state).toBe("OFFLINE");
    expect(view.message).toContain("サーバー受付済み");
    expect(view.message).toContain("再確認");
  });

  it("projects a rejection over a durable stage and preserves the reason", () => {
    const view = project({
      stage: "LOCAL_DURABLE",
      rejection: "基準版が古いため拒否",
    });
    expect(view.state).toBe("REJECTED");
    expect(view.canEdit).toBe(false);
    expect(view.message).toContain("拒否");
    expect(view.message).toContain("基準版が古いため拒否");
    expect(view.message).not.toContain("変更を受け付けました");
  });

  it("makes read-only dominate online editing and acceptance", () => {
    const view = project({ stage: "SERVER_ACCEPTED", readonly: true });
    expect(view.state).toBe("READ_ONLY");
    expect(view.canEdit).toBe(false);
    expect(view.message).toContain("閲覧のみ");
  });

  it("preserves and reports pending changes without changing the stage", () => {
    const view = project({ stage: "LOCAL_DURABLE", pending: 3 });
    expect(view.state).toBe("LOCAL_DURABLE");
    expect(view.pending).toBe(3);
    expect(view.message).toContain("3件");
  });

  it("does not mutate frozen caller input", () => {
    const input: RuntimeProjectionInput = Object.freeze({
      ...base,
      stage: "LOCAL_DURABLE",
    });
    const before = JSON.stringify(input);
    const view = projectRuntimeView(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(view).not.toBe(input);
  });

  it("refuses adversarial and malformed inputs", () => {
    const invalid: unknown[] = [
      null,
      { ...base, stage: "SYNCED" },
      { ...base, pending: -1 },
      { ...base, pending: 1.5 },
      { ...base, pending: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, pending: Number.NaN },
      { ...base, scopeLabel: "" },
      { ...base, scopeLabel: "\uD800" },
      { ...base, rejection: "" },
      { ...base, rejection: "\uDC00" },
      { ...base, readonly: "no" },
      { ...base, online: 1 },
    ];
    for (const value of invalid) {
      expect(() => projectRuntimeView(value as never)).toThrow();
    }
  });
});

describe("operational labels and actions", () => {
  it("labels every stage in Japanese with distinct text", () => {
    const labels = allStages.map(sharedRuntimeStateLabel);
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(allStages.length);
  });

  it("offers retry only for receipt-unknown and recovery only for local uncertainty", () => {
    for (const stage of allStages) {
      const view = project({ stage });
      expect(requiresReceiptRetry(view)).toBe(stage === "UNKNOWN");
      expect(allowsRecovery(view)).toBe(
        stage === "UNSAVED" ||
          stage === "LOCAL_DURABLE" ||
          stage === "REJECTED" ||
          stage === "OFFLINE",
      );
    }
  });

  it("maps roles to Japanese without overstating access", () => {
    expect(sharedRoleLabel("owner")).toBe("所有者");
    expect(sharedRoleLabel("editor")).toBe("編集者");
    expect(sharedRoleLabel("viewer")).toBe("閲覧者");
  });
});

describe("SharedWorkspacePanel static output", () => {
  const port: SharedPanelPort = {
    list: async () => [],
    open: async () => {},
    retry: async () => {},
    recover: async () => "",
    status: async () => project({ stage: "UNSAVED" }),
  };

  it("renders controls without a false saved or synced claim", () => {
    const html = renderToStaticMarkup(
      createElement(SharedWorkspacePanel, { port, onClose: () => {} }),
    );
    expect(html).toContain("共有ワークスペース");
    expect(html).toContain("閉じる");
    expect(html).not.toContain("サーバー保存済み");
    expect(html).not.toContain("同期済み");
    expect(html).not.toContain("clipboard");
  });
});
