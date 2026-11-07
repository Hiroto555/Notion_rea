import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { test, expect, lastResult, readArchives } from "./recovery-fixture";
import { verifyRecoveryBundle } from "../../../src/persistence/conflict-recovery-verify";
import { inspectRecoveredContent } from "../../../src/persistence/recovered-content";
import { Store } from "../../../src/persistence/store";
import { buildWorkspaceCheckpoint } from "../../../src/sync/workspace-checkpoint";
import { hashCheckpoint } from "../../../src/sync/protocol";
import {
  RECOVERY_INCOMPLETE,
  RECOVERY_ORIGIN_KEY,
} from "../../../src/shared/conflict-recovery";

test("real IPC lists offline archives, isolates corruption, paginates and handles Escape", async ({
  recovery: s,
}) => {
  await s.openPanel();
  const panel = s.window.locator(".conflict-recovery-details");
  await expect(panel).toContainText("破損のため復元対象外");
  await expect(
    panel.getByRole("button", { name: "この対象を選択" }),
  ).toHaveCount(50);
  await expect(
    panel.getByRole("button", { name: "この対象を選択" }).first(),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "次のページを読み込む" }).click();
  await expect(
    panel.getByRole("button", { name: "この対象を選択" }),
  ).toHaveCount(55);
  await expect(panel).toContainText("同期しません");
  await panel.getByRole("button", { name: "最新を読み込む" }).focus();
  await s.window.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("open", "");
  await expect(panel.locator("summary")).toBeFocused();
  expect(readArchives(s.source)).toBe(s.archives);
});

test("real IPC writes JSON-only without a manifest or attachments", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(s.external);
  await s.window
    .getByRole("button", { name: "JSONのみ保存（metadata-only）", exact: true })
    .click();
  await expect(
    s.window.getByText("結果（成功）: JSONのみ（metadata-only）", {
      exact: true,
    }),
  ).toBeVisible();
  const result = await lastResult(s);
  if (result.kind !== "metadata-only") throw new Error(JSON.stringify(result));
  expect(existsSync(join(result.directory, "manifest.json"))).toBe(false);
  expect(existsSync(join(result.directory, "assets"))).toBe(false);
  expect(existsSync(join(result.directory, RECOVERY_INCOMPLETE))).toBe(false);
  expect(readFileSync(join(result.directory, "README.txt"), "utf8")).toContain(
    "not a restorable bundle",
  );
  expect(readArchives(s.source)).toBe(s.archives);
});

test("real IPC exports and independently verifies every bundled attachment", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(s.external);
  await s.window
    .getByRole("button", { name: "添付付き回収データ保存", exact: true })
    .click();
  await expect(
    s.window.getByText("結果（成功）: 添付付き回収データ", { exact: true }),
  ).toBeVisible();
  const result = await lastResult(s);
  if (result.kind !== "complete-bundle")
    throw new Error(JSON.stringify(result));
  expect(
    verifyRecoveryBundle(result.directory).manifest.checkpoint.sha256,
  ).toBe(s.checkpointHash);
  expect(readFileSync(join(result.directory, "assets", s.assetId))).toEqual(
    s.assetBytes,
  );
  expect(readArchives(s.source)).toBe(s.archives);
  expect(readFileSync(join(s.source, "assets", s.assetId))).toEqual(
    s.assetBytes,
  );
});

test("real IPC restores a new v4 copy, then reopening it holds ambient sync", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(s.external);
  await s.window
    .getByRole("button", { name: "新規コピーとして復元", exact: true })
    .click();
  await expect(
    s.window.getByText("結果（成功）: 新規コピーとして復元", { exact: true }),
  ).toBeVisible();
  const result = await lastResult(s);
  if (result.kind !== "restored") throw new Error(JSON.stringify(result));
  inspectRecoveredContent(result.directory, s.checkpointHash);
  expect(readdirSync(s.external)).toHaveLength(2); // Retained bundle + new workspace.
  expect(readArchives(s.source)).toBe(s.archives);
  await s.restart(result.directory, {
    FOLIO_SYNC_ENABLED: "1",
    FOLIO_SYNC_MODE: "publish",
    FOLIO_SYNC_URL: "http://127.0.0.1:1",
    FOLIO_SYNC_WORKSPACE: "fixture",
    FOLIO_SYNC_CLIENT: "fixture",
    FOLIO_SYNC_BINDING: "fixture",
    FOLIO_SYNC_TOKEN: "synthetic",
  });
  await expect(
    s.window.getByText(/recovered-workspace-sync-held/),
  ).toBeVisible();
  expect(
    await s.window.getByLabel("ページタイトル", { exact: true }).inputValue(),
  ).toBe("GUI 回収元");
  const copy = new Store(join(result.directory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    expect(copy.db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    expect(
      copy.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'workspace_sync_%'",
        )
        .get()?.n,
    ).toBe(0);
    expect(
      copy.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(RECOVERY_ORIGIN_KEY),
    ).toBeDefined();
  } finally {
    copy.close();
  }
});

test("cancelled picker creates no output and allows a later request", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(null);
  await s.window
    .getByRole("button", { name: "添付付き回収データ保存", exact: true })
    .click();
  await expect(
    s.window.getByText("操作はキャンセルされました。", { exact: true }),
  ).toBeVisible();
  expect(readdirSync(s.external)).toHaveLength(0);
  await expect(
    s.window.getByRole("button", {
      name: "添付付き回収データ保存",
      exact: true,
    }),
  ).toBeEnabled();
});

test("missing attachment preserves an incomplete output and never reports success", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(s.external);
  unlinkSync(join(s.source, "assets", s.assetId));
  await s.window
    .getByRole("button", { name: "添付付き回収データ保存", exact: true })
    .click();
  await expect(
    s.window.getByText("recovery-incomplete-preserved", { exact: true }),
  ).toBeVisible();
  await expect(s.window.getByText(/結果（成功）:/)).toHaveCount(0);
  const result = await lastResult(s);
  if (result.kind !== "blocked" || !result.directory)
    throw new Error(JSON.stringify(result));
  expect(existsSync(join(result.directory, RECOVERY_INCOMPLETE))).toBe(true);
  expect(readArchives(s.source)).toBe(s.archives);
});

test("source destination is refused without overwriting source", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(s.source);
  await s.window
    .getByRole("button", { name: "JSONのみ保存（metadata-only）", exact: true })
    .click();
  await expect(
    s.window.getByText("recovery-refused", { exact: true }),
  ).toBeVisible();
  expect(readdirSync(s.external)).toHaveLength(0);
  expect(
    readdirSync(s.source).some((name) => name.startsWith("Folio-recovery-")),
  ).toBe(false);
  expect(readArchives(s.source)).toBe(s.archives);
});

test("target changed while picker waits is refused before creating output", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(s.external, true);
  const response = s.window
    .getByRole("button", { name: "添付付き回収データ保存", exact: true })
    .click();
  await expect
    .poll(() => s.app.evaluate(() => (globalThis as any).guiCiPickerCount))
    .toBe(1);
  const db = new Store(join(s.source, "workspace.sqlite"));
  try {
    db.db.prepare("DELETE FROM workspace_sync_archives WHERE id=54").run();
  } finally {
    db.close();
  }
  await s.releasePicker();
  await response;
  await expect(
    s.window.getByText("recovery-refused", { exact: true }),
  ).toBeVisible();
  expect(readdirSync(s.external)).toHaveLength(0);
});

test("lost host success reply is reconciled by the same operation ID without a second effect", async ({
  recovery: s,
}) => {
  await s.openPanel();
  await s.choose();
  await s.picker(s.external);
  await s.app.evaluate(() => {
    (globalThis as any).guiCiDropReply = true;
  });
  const action = s.window.getByRole("button", {
    name: "添付付き回収データ保存",
    exact: true,
  });
  await action.click();
  await expect(
    s.window.getByText("結果不明（成功ではありません）", { exact: true }),
  ).toBeVisible();
  await expect(action).toBeDisabled();
  expect(readdirSync(s.external)).toHaveLength(1);
  const effect = (await s.calls()).find((x) => x.type === "recovery:export")!;
  await s.window
    .getByRole("button", { name: "直近の結果を再照会", exact: true })
    .click();
  await expect(
    s.window.getByText("結果（成功）: 添付付き回収データ", { exact: true }),
  ).toBeVisible();
  const calls = await s.calls();
  expect(calls.filter((x) => x.type === "recovery:export")).toHaveLength(1);
  expect(
    calls.filter((x) => x.type === "recovery:status").at(-1)?.operationId,
  ).toBe(effect.operationId);
  expect(readdirSync(s.external)).toHaveLength(1);
  expect(readArchives(s.source)).toBe(s.archives);
});

test("ordinary edits survive Electron close and restart through the real save IPC", async ({
  recovery: s,
}) => {
  await s.window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Linux GUIで保存した題名");
  await expect(s.window.locator(".save-state")).toHaveText("保存済み");
  await s.restart();
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Linux GUIで保存した題名");
  expect(readArchives(s.source)).toBe(s.archives);
});
