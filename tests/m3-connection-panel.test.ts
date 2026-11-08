import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SyncConnectionPanel,
  canDisableConnection,
  canWriteConnection,
  connectionDisableBlockReason,
  connectionErrorMessage,
  connectionWriteBlockReason,
  disableFeedback,
  resolvedOutcomeFeedback,
  saveFeedback,
  unknownOutcomeFeedback,
} from "../src/renderer/sync/SyncConnectionPanel";
import type {
  SyncConnectionAction,
  SyncConnectionView,
} from "../src/shared/sync-management";

const requestId = "22222222-2222-4222-8222-222222222222";
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
      onResolve: async () => null,
    }),
  );
}

function buttonTag(html: string, label: string): string {
  const text = `>${label}</button>`;
  const index = html.indexOf(text);
  return html.slice(html.lastIndexOf("<button", index), index + text.length);
}

describe("SyncConnectionPanel hardening", () => {
  it("keeps typed mode values with natural Japanese purpose labels", () => {
    const html = render(configuredView);
    expect(html).toContain('value="publish"');
    expect(html).toContain('value="join"');
    expect(html).toContain('value="recover"');
    expect(html).toContain("新しく公開して同期を開始");
    expect(html).toContain("既存のワークスペースに参加");
    expect(html).toContain("以前の接続を復旧");
  });

  it("keeps the token in the password input only", () => {
    const html = render(configuredView);
    expect(html).toContain('type="password"');
    expect(html).toContain('name="token"');
    expect(html.toLowerCase()).toContain('autocomplete="off"');
    expect(html).not.toContain("secret-token-value");
    expect(html).not.toContain("localStorage");
  });

  it("never renders a caught error message, even when several secrets are present", () => {
    const failure = connectionErrorMessage(
      new Error("token=secret-a secondary=secret-b"),
      "secret-a",
    );
    expect(failure).toBe(
      "操作を完了できませんでした。状態を更新して、もう一度お試しください。",
    );
    expect(failure).not.toContain("secret-a");
    expect(failure).not.toContain("secret-b");
    expect(failure).not.toContain("token=");
    expect(connectionErrorMessage("raw string secret-c", "secret-c")).toBe(failure);
  });

  it("retains the original request id when a save response is lost", () => {
    const lost = unknownOutcomeFeedback("save", requestId);
    expect(lost.kind).toBe("outcome-unknown");
    expect(lost.requestId).toBe(requestId);
    expect(lost.message).not.toContain("保存しました");
    expect(lost.message).toContain("確認できません");

    const stillUnknown = resolvedOutcomeFeedback(action("outcome-unknown"), requestId, "save");
    expect(stillUnknown.feedback.kind).toBe("outcome-unknown");
    expect(stillUnknown.pendingRequestId).toBe(requestId);
    expect(stillUnknown.permitsRetry).toBe(false);
  });

  it("retains the original request id when a disable response is lost", () => {
    const lost = unknownOutcomeFeedback("disable", requestId);
    expect(lost.kind).toBe("outcome-unknown");
    expect(lost.requestId).toBe(requestId);
    expect(lost.message).not.toContain("無効化しました");

    const stillUnknown = resolvedOutcomeFeedback(action("outcome-unknown"), requestId, "disable");
    expect(stillUnknown.feedback.kind).toBe("outcome-unknown");
    expect(stillUnknown.pendingRequestId).toBe(requestId);
  });

  it("treats a null resolve as definitely uncommitted and permits a new retry", () => {
    const retry = resolvedOutcomeFeedback(null, requestId, "save");
    expect(retry.feedback.kind).toBe("idle");
    expect(retry.feedback.message).toContain("もう一度実行できます");
    expect(retry.feedback.requestId).toBeUndefined();
    expect(retry.pendingRequestId).toBeNull();
    expect(retry.permitsRetry).toBe(true);
  });

  it("settles a known resolve and does not retain the request id", () => {
    const saved = resolvedOutcomeFeedback(action("saved"), requestId, "save");
    expect(saved.feedback.kind).toBe("saved");
    expect(saved.pendingRequestId).toBeNull();
    expect(saved.permitsRetry).toBe(false);

    const disabled = resolvedOutcomeFeedback(action("disabled"), requestId, "disable");
    expect(disabled.feedback.kind).toBe("disabled");
    expect(disabled.pendingRequestId).toBeNull();
    expect(disabled.permitsRetry).toBe(false);
  });

  it("settles held outcomes without blocking retries on an unknown id", () => {
    const heldSave = saveFeedback(action("held"), requestId);
    expect(heldSave.kind).toBe("held");
    expect(heldSave.requestId).toBeUndefined();

    const heldDisable = disableFeedback(action("held"), requestId);
    expect(heldDisable.kind).toBe("held");
    expect(heldDisable.requestId).toBeUndefined();

    const resolved = resolvedOutcomeFeedback(action("held"), requestId, "save");
    expect(resolved.feedback.kind).toBe("held");
    expect(resolved.pendingRequestId).toBeNull();
    expect(resolved.permitsRetry).toBe(false);
  });

  it("blocks new writes while an outcome is unknown", () => {
    expect(connectionWriteBlockReason(configuredView, false, requestId)).toContain(
      "確認できません",
    );
    expect(connectionDisableBlockReason(configuredView, false, requestId)).toContain(
      "確認できません",
    );
    expect(canWriteConnection(configuredView, false, requestId)).toBe(false);
    expect(canDisableConnection(configuredView, false, requestId)).toBe(false);
  });

  it("allows disabling when held only by secure-store-unavailable", () => {
    const held = view({ state: "held", reason: "secure-store-unavailable" });
    expect(canWriteConnection(held, false)).toBe(false);
    expect(canDisableConnection(held, false)).toBe(true);

    const html = render(held);
    expect(buttonTag(html, "保存")).toContain("disabled");
    expect(buttonTag(html, "無効化")).not.toContain("disabled");
    expect(buttonTag(html, "更新")).not.toContain("disabled");
  });


  it("still holds disabling for read-only, recovery, identity, intent, and busy", () => {
    for (const reason of [
      "read-only",
      "recovery-copy-held",
      "identity-changed",
      "intent-present",
    ] as const) {
      const current = view({ reason });
      expect(connectionDisableBlockReason(current, false)).not.toBeNull();
      expect(canDisableConnection(current, false)).toBe(false);
      expect(buttonTag(render(current), "無効化")).toContain("disabled");
    }
    expect(canDisableConnection(configuredView, true)).toBe(false);
    expect(buttonTag(render(configuredView, true), "無効化")).toContain("disabled");
  });
});
