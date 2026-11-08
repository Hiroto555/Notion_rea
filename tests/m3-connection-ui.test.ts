import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SyncConnectionPanel,
  canWriteConnection,
  connectionErrorMessage,
  connectionStateNotice,
  disableFeedback,
  saveFeedback,
} from "../src/renderer/sync/SyncConnectionPanel";
import type {
  SyncConnectionAction,
  SyncConnectionView,
} from "../src/shared/sync-management";

const configuredView: SyncConnectionView = {
  state: "configured",
  revision: "11111111-1111-4111-8111-111111111111",
  target: {
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace-1",
    clientId: "client-1",
    mode: "publish",
  },
  hasCredential: true,
  reason: null,
};

function view(patch: Partial<SyncConnectionView> = {}): SyncConnectionView {
  return { ...configuredView, ...patch };
}

function action(outcome: SyncConnectionAction["outcome"]): SyncConnectionAction {
  return { outcome, view: configuredView };
}

function render(current: SyncConnectionView, busy = false): string {
  return renderToStaticMarkup(
    createElement(SyncConnectionPanel, {
      view: current,
      busy,
      onSave: async () => action("saved"),
      onDisable: async () => action("disabled"),
      onRefresh: async () => {},
    }),
  );
}

function buttonTag(html: string, label: string): string {
  const text = `>${label}</button>`;
  const index = html.indexOf(text);
  return html.slice(html.lastIndexOf("<button", index), index + text.length);
}

describe("SyncConnectionPanel", () => {
  it("renders a password token input and never puts a secret in status text", () => {
    const html = render(configuredView);
    expect(html).toMatch(/type="password"/);
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toContain('name="token"');
    expect(html).not.toContain("secret-token-value");
    expect(connectionErrorMessage(new Error("token=secret-token-value"), "secret-token-value"))
      .not.toContain("secret-token-value");
  });

  it("renders Japanese URL, workspace, client id, token, and explicit mode labels", () => {
    const html = render(configuredView);
    expect(html).toContain("URL");
    expect(html).toContain("ワークスペース ID");
    expect(html).toContain("クライアント ID");
    expect(html).toContain("サーバー発行トークン");
    expect(html).toContain('value="publish"');
    expect(html).toContain('value="join"');
    expect(html).toContain('value="recover"');
  });

  it("explains next-restart activation and has no apply or re-register button", () => {
    const html = render(view({ state: "pending-restart" }));
    expect(html).toContain("次回の再起動時に有効になります");
    expect(html).toContain(">保存</button>");
    expect(html).toContain(">無効化</button>");
    expect(html).toContain(">更新</button>");
    expect(html).not.toContain("適用");
    expect(html).not.toContain("再登録");
  });

  it("disables writes while held but keeps refresh available", () => {
    const held = view({ state: "held", reason: "recovery-copy-held" });
    const html = render(held);
    expect(canWriteConnection(held, false)).toBe(false);
    expect(buttonTag(html, "保存")).toContain("disabled");
    expect(buttonTag(html, "無効化")).toContain("disabled");
    expect(buttonTag(html, "更新")).not.toContain("disabled");
    expect(html).toContain("保留");
  });

  it("disables writes for read-only and secure-store-unavailable states", () => {
    for (const reason of ["read-only", "secure-store-unavailable"] as const) {
      const current = view({ reason });
      expect(canWriteConnection(current, false)).toBe(false);
      const html = render(current);
      expect(buttonTag(html, "保存")).toContain("disabled");
      expect(buttonTag(html, "更新")).not.toContain("disabled");
    }
    expect(connectionStateNotice(view({ reason: "read-only" }))).toContain(
      "読み取り専用",
    );
    expect(
      connectionStateNotice(view({ reason: "secure-store-unavailable" })),
    ).toContain("資格情報ストア");
  });

  it("does not report false success for held or unknown outcomes", () => {
    const saved = saveFeedback(action("saved"), "request-1");
    expect(saved.kind).toBe("saved");
    expect(saved.message).toContain("次回の再起動");

    const held = saveFeedback(action("held"), "request-1");
    expect(held.kind).toBe("held");
    expect(held.message).not.toContain("保存しました");
    expect(held.requestId).toBeUndefined();

    const unknown = saveFeedback(action("outcome-unknown"), "request-1");
    expect(unknown.kind).toBe("outcome-unknown");
    expect(unknown.message).not.toContain("保存しました");
    expect(unknown.message).toContain("確認できません");
    expect(unknown.requestId).toBe("request-1");
  });

  it("keeps the request id for an unknown disable outcome", () => {
    const unknown = disableFeedback(action("outcome-unknown"), "request-2");
    expect(unknown.kind).toBe("outcome-unknown");
    expect(unknown.requestId).toBe("request-2");
    expect(unknown.message).not.toContain("無効化しました");
  });

  it("separates local credential deletion from server revocation", () => {
    const html = render(configuredView);
    expect(html).toContain("ローカル資格情報");
    expect(html).toContain("管理者");
    expect(html).toContain("CLI");
  });
});
