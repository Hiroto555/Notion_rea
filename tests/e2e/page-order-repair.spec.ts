import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { test, expect, saved, type Session } from "./next-round-fixture";
import type { Page } from "../../src/shared/types";
import type { PageOrderRepairPreview } from "../../src/shared/page-order-repair";
import { verifyFullBackup } from "../../src/persistence/full-backup-verify";

function rawPages(session: Session) {
  const db = new DatabaseSync(join(session.folder, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare("SELECT id,data,body FROM pages ORDER BY id").all() as {
      id: string;
      data: string;
      body: string;
    }[];
  } finally {
    db.close();
  }
}

async function setupTie(session: Session) {
  const pages = await session.window.evaluate(async () => {
    const create = (title: string) =>
      window.folio.request<Page>({
        type: "create",
        parentId: null,
        kind: "page",
        title,
      });
    return [await create("Order first"), await create("Order second")];
  });
  // Emulate old stored data only inside the fixture-owned SQLite workspace.
  const db = new DatabaseSync(join(session.folder, "workspace.sqlite"));
  try {
    db.prepare(
      "UPDATE pages SET data=json_set(data,'$.position',?) WHERE id=?",
    ).run(pages[0].position, pages[1].id);
  } finally {
    db.close();
  }
  const preview = await session.window.evaluate(() =>
    window.folio.request<PageOrderRepairPreview>({ type: "pageOrder:preview" }),
  );
  expect(preview.canApply).toBe(true);
  const active = preview.targetIds[0];
  await session.window.evaluate(
    (id) =>
      window.folio.request({ type: "setting", key: "activePage", value: id }),
    active,
  );
  await session.window.reload();
  await session.window.waitForSelector(".page-title");
  await saved(session);
  return { active, preview };
}

async function openRepair(session: Session) {
  const panel = session.window.getByLabel("ワークスペースの保守", {
    exact: true,
  });
  await panel.locator("summary").click();
  await panel
    .getByRole("button", { name: "ページの並び順を修復", exact: true })
    .click();
  const dialog = session.window.getByRole("dialog", {
    name: "ページの並び順を修復",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "並び順を確認", exact: true })
    .click();
  await expect(dialog.getByRole("table")).toBeVisible();
  return dialog;
}

test("page order repair previews, backs up and reloads before saving the changed Page", async ({
  folio: session,
}) => {
  const { active } = await setupTie(session);
  const before = rawPages(session);
  const dialog = await openRepair(session);
  expect(rawPages(session)).toEqual(before);
  await dialog
    .getByRole("button", { name: "バックアップを作成して修復", exact: true })
    .click();
  await expect(
    dialog.getByText("1 件の並び順を修復しました。", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "閉じる", exact: true }),
  ).toBeDisabled();
  await session.window.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  const after = rawPages(session);
  for (const row of before.filter(({ id }) => id !== active))
    expect(after.find(({ id }) => id === row.id)).toEqual(row);
  const backups = readdirSync(join(session.folder, "backups")).filter((name) =>
    name.startsWith("page-order-repair-"),
  );
  expect(backups).toHaveLength(1);
  verifyFullBackup(join(session.folder, "backups", backups[0]));
  await dialog
    .getByRole("button", { name: "保存済みの状態を読み直す", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    session.window.getByLabel("ページタイトル", { exact: true }),
  ).toBeVisible();
  await session.window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Edited after order repair");
  await saved(session);
  await session.restart();
  await expect(
    session.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Edited after order repair");
});

test("page order repair rejects a stale preview and leaves the current Pages untouched", async ({
  folio: session,
}) => {
  const { active } = await setupTie(session);
  const dialog = await openRepair(session);
  await session.window.evaluate(async (id) => {
    const { pages } = await window.folio.request<{ pages: Page[] }>({
      type: "load",
    });
    const page = pages.find((page) => page.id === id)!;
    await window.folio.request({
      type: "update",
      id,
      revision: page.revision,
      patch: { title: "Changed after preview" },
    });
  }, active);
  const before = rawPages(session);
  await dialog
    .getByRole("button", { name: "バックアップを作成して修復", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "プレビュー後に原本が変わりました",
  );
  expect(rawPages(session)).toEqual(before);
  await expect(
    dialog.getByRole("button", { name: "閉じる", exact: true }),
  ).toBeEnabled();
});

test("page order repair keeps a lost reply pending until saved state is reloaded without a resend", async ({
  folio: session,
}) => {
  await setupTie(session);
  const dialog = await openRepair(session);
  await session.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any;
    const original = ipc._invokeHandlers.get("folio:request");
    (globalThis as any).orderRepairCalls = 0;
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      if (request.type === "pageOrder:apply") {
        (globalThis as any).orderRepairCalls++;
        throw new Error("synthetic lost order repair reply");
      }
      return result;
    });
  });
  await dialog
    .getByRole("button", { name: "バックアップを作成して修復", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "修復結果を確認できません",
  );
  await expect(
    dialog.getByRole("button", { name: "閉じる", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "保存済みの状態を読み直す", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    session.window.getByLabel("ページタイトル", { exact: true }),
  ).toBeVisible();
  const preview = await session.window.evaluate(() =>
    window.folio.request<PageOrderRepairPreview>({ type: "pageOrder:preview" }),
  );
  expect(preview.groups).toHaveLength(0);
  expect(
    await session.app.evaluate(() => (globalThis as any).orderRepairCalls),
  ).toBe(1);
  await session.window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Saved after uncertain repair");
  await saved(session);
});
