import { expect, it } from "vitest";
import { restartApplyText, syncStatusText } from "../src/renderer/WorkspaceSyncIndicator";
const view = {available: true as const, connection: "connected" as const, running: false, lastSuccessAt: null, lastError: null,
  workspace: {receivedCursor: 4, appliedRevision: 3, generation: 1, cleanGeneration: 0, pending: true, conflict: false}};
it("distinguishes local pending, staged remote, errors and conflicts", () => {
  expect(syncStatusText(view)).toBe("送信待ち · 受信 4 · 適用済み 3");
  expect(syncStatusText({...view, workspace: {...view.workspace, pending: false, appliedRevision: 4}})).toBe("送信済み · 適用済み 4");
  expect(syncStatusText({...view, lastError: "local-or-network-error"})).toBe("同期を保留");
  expect(syncStatusText({...view, lastError: "capacity-exceeded"})).toBe("容量不足で同期を保留");
  expect(syncStatusText({...view, workspace: {...view.workspace, conflict: true}})).toBe("同期競合・両側を保持");
  expect(syncStatusText({...view, connection: "disconnected", workspace: null})).toBe("未接続");
  expect(syncStatusText({...view, connection: "connecting", running: true, workspace: null})).toBe("接続中…");
});
it("distinguishes an in-memory request from a durable reservation and a held exit", () => {
  const request = {available: true as const, state: "requested" as const, scheduled: false,
    targetRevision: 4, canRequest: false, canCancel: true, reason: null};
  expect(restartApplyText(request)).toContain("終了時に確定");
  expect(restartApplyText({...request, reason: "sync-active"})).toContain("保留");
  expect(restartApplyText({...request, state: "committed", scheduled: true})).toContain("適用予定");
});
