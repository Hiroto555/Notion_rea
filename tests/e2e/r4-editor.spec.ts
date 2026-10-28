import { test, expect, saved, type Session } from "./next-round-fixture";

async function blankPage(s: Session, title: string) {
  const id = await s.window.evaluate(async (title) => {
    const page = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title,
    });
    await window.folio.request({
      type: "setting",
      key: "activePage",
      value: page.id,
    });
    return page.id as string;
  }, title);
  await s.window.reload();
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue(title);
  await expect(s.window.locator(".folio-editor")).toBeVisible();
  return id;
}

test("R4 slash heading choice is one Undo step and survives SQLite restart", async ({
  folio: s,
}) => {
  const id = await blankPage(s, "R4 slash heading");
  const w = s.window;
  const body = w.locator(".folio-editor");
  await body.fill("/heading");
  const menu = w.getByRole("listbox", { name: "ブロックコマンド" });
  await expect(menu.getByRole("option")).toHaveCount(3);
  await w.keyboard.press("ArrowDown");
  await expect(menu.getByRole("option", { selected: true })).toContainText(
    "見出し 2",
  );
  await w.keyboard.press("ArrowUp");
  await expect(menu.getByRole("option", { selected: true })).toContainText(
    "見出し 1",
  );
  await w.keyboard.press("ArrowDown");
  await w.keyboard.press("Enter");
  await expect(body.locator("h2")).toHaveCount(1);
  await expect(menu).toHaveCount(0);
  await w.keyboard.press("Meta+z");
  await expect(body.locator("p").first()).toHaveText("/heading");
  await expect(body.locator("h2")).toHaveCount(0);
  await w.keyboard.press("Meta+Shift+z");
  await expect(body.locator("h2")).toHaveCount(1);
  await w.keyboard.insertText("Heading survives restart");
  await saved(s);
  await s.restart();
  await expect(s.window.locator(".folio-editor h2")).toHaveText(
    "Heading survives restart",
  );
  const persisted = await s.window.evaluate(
    async (id) =>
      (await window.folio.request<any>({ type: "load" })).pages.find(
        (page: any) => page.id === id,
      ),
    id,
  );
  expect(persisted.doc.content[0].type).toBe("heading");
  expect(persisted.doc.content[0].attrs.level).toBe(2);
  expect(JSON.stringify(persisted.doc)).not.toContain("/heading");
});

test("R4 Escape keeps slash text dismissed until input changes; todo conversion is undoable", async ({
  folio: s,
}) => {
  await blankPage(s, "R4 slash todo");
  const w = s.window;
  const body = w.locator(".folio-editor");
  const menu = w.getByRole("listbox", { name: "ブロックコマンド" });
  await body.fill("/todo");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await w.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(body).toHaveText("/todo");
  // A harmless Editor transaction (e.g. focus or metadata) must not undo Esc.
  await w.evaluate(() => {
    const editor = (document.querySelector(".folio-editor") as any).editor;
    editor.view.dispatch(
      editor.state.tr.setMeta("r4-escape-observation", true),
    );
  });
  await expect(menu).toHaveCount(0);
  await w.keyboard.insertText("x");
  await expect(menu).toContainText("該当するコマンドがありません");
  await w.keyboard.press("ArrowDown");
  await w.keyboard.press("Backspace");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await w.keyboard.press("Enter");
  await expect(body.locator('[data-type="taskList"]')).toHaveCount(1);
  await w.keyboard.press("Meta+z");
  await expect(body).toHaveText("/todo");
  await expect(body.locator('[data-type="taskList"]')).toHaveCount(0);
  await w.keyboard.press("Meta+Shift+z");
  await w.keyboard.insertText("Check this task");
  await body.locator('input[type="checkbox"]').check();
  await saved(s);
  await s.restart();
  await expect(
    s.window.locator('.folio-editor [data-type="taskItem"]'),
  ).toContainText("Check this task");
  await expect(
    s.window.locator('.folio-editor input[type="checkbox"]'),
  ).toBeChecked();
});

test("R4 Escape cancels block selection before parent navigation", async ({
  folio: s,
}) => {
  await blankPage(s, "R4 block selection");
  const w = s.window;
  await w.locator(".folio-editor").fill("Keep this block");
  await saved(s);
  await w.getByLabel("ブロック 1 を選択", { exact: true }).click();
  await expect(w.locator(".block-actions")).toContainText("1 ブロック");
  await w.evaluate(() => {
    (globalThis as any).r4EscapeReachedParent = false;
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.defaultPrevented)
        (globalThis as any).r4EscapeReachedParent = true;
    });
  });
  await w.keyboard.press("Escape");
  await expect(w.locator(".block-actions")).toHaveCount(0);
  expect(
    await w.evaluate(() => (globalThis as any).r4EscapeReachedParent),
  ).toBe(false);
  await expect(w.locator(".folio-editor")).toHaveText("Keep this block");
});
