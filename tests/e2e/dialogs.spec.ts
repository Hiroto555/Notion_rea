import { writeFileSync } from "node:fs";
import { test, expect, saved, type Session } from "./next-round-fixture";
import { editorDoc } from "./drag-observer";
async function openRecord(s: Session) {
  await s.window
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await s.window
    .getByRole("button", { name: "ギャラリー", exact: true })
    .click();
  const card = s.window.locator(".db-card").first();
  await card.click();
  return card;
}
test("R3 DB Escape closes the record and saves the latest input through restart", async ({
  folio: s,
}) => {
  await openRecord(s);
  await s.window.getByLabel("アイテムのタイトル").fill("Record updated Aあ😀");
  await s.window.keyboard.press("Escape");
  await expect(s.window.getByRole("dialog")).toHaveCount(0);
  await saved(s);
  await expect(s.window.locator(".db-card").first()).toBeFocused();
  await s.restart();
  await s.window.locator(".db-card").first().click();
  await expect(s.window.getByLabel("アイテムのタイトル")).toHaveValue(
    "Record updated Aあ😀",
  );
});
test("R3 search/link/record share initial focus, modal tab cycle, close button and background isolation", async ({
  folio: s,
}) => {
  const w = s.window;
  for (const mode of ["search", "link", "record"]) {
    if (mode === "record") await openRecord(s);
    else if (mode === "search") await w.keyboard.press("Meta+p");
    else await w.getByTitle("ページへのリンク", { exact: true }).click();
    const dialog = w.getByRole("dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(
      w.getByLabel(mode === "record" ? "アイテムのタイトル" : "検索キーワード"),
    ).toBeFocused();
    const count = await dialog.locator("button,input,select").count();
    for (const key of ["Tab", "Shift+Tab"])
      for (let i = 0; i < count + 2; i++) {
        await w.keyboard.press(key);
        expect(
          await dialog.evaluate((el) => el.contains(document.activeElement)),
        ).toBe(true);
      }
    const title = await w
      .getByLabel("ページタイトル", { exact: true })
      .inputValue();
    const bg = w.locator(".page-tree-label").first();
    const box = await bg.boundingBox();
    await w.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
      title,
    );
    if (await dialog.count())
      await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});
async function linkDocument(s: Session) {
  const id = await s.window.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Link origin",
    });
    await window.folio.request({
      type: "update",
      id: p.id,
      revision: 0,
      patch: {
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "不" },
                { type: "text", text: "動", marks: [{ type: "bold" }] },
                { type: "text", text: "産 software" },
              ],
            },
          ],
        },
      },
    });
    await window.folio.request({
      type: "setting",
      key: "activePage",
      value: p.id,
    });
    return p.id;
  });
  await s.window.reload();
  await s.window.waitForSelector(".folio-editor");
  return id;
}
async function selectWord(s: Session) {
  await s.window.locator(".folio-editor").click();
  await s.window.keyboard.press("Meta+ArrowLeft");
  for (let i = 0; i < 3; i++) await s.window.keyboard.press("Shift+ArrowRight");
  expect(await s.window.evaluate(() => getSelection()?.toString())).toBe(
    "不動産",
  );
}
test("R3 selected text link cancel/confirm restores exact range, wording and marks", async ({
  folio: s,
}) => {
  await linkDocument(s);
  await selectWord(s);
  const before = await editorDoc(s);
  await s.window.keyboard.press("Meta+k");
  await s.window.keyboard.press("Escape");
  expect(await editorDoc(s)).toEqual(before);
  await expect(s.window.locator(".folio-editor")).toBeFocused();
  expect(await s.window.evaluate(() => getSelection()?.toString())).toBe(
    "不動産",
  );
  await s.window.getByTitle("ページへのリンク", { exact: true }).click();
  await s.window.getByLabel("検索キーワード").fill("アイデアノート");
  await expect(s.window.locator(".search-results button")).toHaveCount(1);
  // Guard against selection drift while the modal is open; use the captured range.
  await s.window
    .locator(".folio-editor")
    .evaluate((el) => (el as any).editor.commands.setTextSelection(5));
  await s.window.locator(".search-results button").click();
  await expect(s.window.locator(".folio-editor a")).toHaveText("不動産");
  await expect(s.window.locator(".folio-editor strong")).toHaveText("動");
  await expect(s.window.locator(".folio-editor")).toHaveText("不動産 software");
  await saved(s);
  await expect(s.window.locator(".folio-editor")).toBeFocused();
});
test("R3 synthetic composition, prevented Escape and inner menus take priority (not physical IME)", async ({
  folio: s,
}) => {
  for (const mode of ["search", "link", "record"]) {
    if (mode === "record") await openRecord(s);
    else if (mode === "search") await s.window.keyboard.press("Meta+p");
    else await s.window.getByTitle("ページへのリンク", { exact: true }).click();
    const input = s.window.getByLabel(
      mode === "record" ? "アイテムのタイトル" : "検索キーワード",
    );
    await input.focus();
    await input.evaluate((el) =>
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      ),
    );
    await s.window.keyboard.press("Escape");
    await expect(s.window.getByRole("dialog")).toBeVisible();
    await input.evaluate((el) =>
      el.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await input.evaluate((el) =>
      el.addEventListener(
        "keydown",
        (e) => {
          if ((e as KeyboardEvent).key === "Escape") e.preventDefault();
        },
        { once: true },
      ),
    );
    await s.window.keyboard.press("Escape");
    await expect(s.window.getByRole("dialog")).toBeVisible();
    await s.window.keyboard.press("Escape");
    await expect(s.window.getByRole("dialog")).toHaveCount(0);
  }
});
test("R3 nested native UI consumes one Escape; search navigation focuses destination", async ({
  folio: s,
}, info) => {
  await s.window.keyboard.press("Meta+p");
  await s.window.evaluate(() => {
    const inner = document.createElement("dialog");
    inner.setAttribute("aria-label", "Inner test menu");
    inner.innerHTML = "<button>Inner test action</button>";
    document.querySelector("dialog[open]")!.append(inner);
    inner.showModal();
  });
  await s.window.keyboard.press("Escape");
  await expect(
    s.window.getByRole("dialog", { name: "ワークスペース検索", exact: true }),
  ).toBeVisible();
  await expect(
    s.window.getByRole("dialog", { name: "Inner test menu" }),
  ).not.toBeVisible();
  await s.window.getByLabel("検索キーワード").fill("アイデアノート");
  await s.window.locator(".search-results button").click();
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("アイデアノート");
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toBeFocused();
  await openRecord(s);
  const select = s.window.getByRole("dialog").getByRole("combobox");
  await s.window.evaluate(() => {
    (globalThis as any).dialogKeys = [];
    for (const type of ["keydown", "keyup", "cancel"])
      document.addEventListener(
        type,
        (e) =>
          (globalThis as any).dialogKeys.push({
            type,
            key: (e as KeyboardEvent).key,
            target: (e.target as Element)?.tagName,
            open:
              e.target instanceof HTMLSelectElement
                ? e.target.matches(":open")
                : !!document.querySelector("dialog[open] select:open"),
            prevented: e.defaultPrevented,
          }),
        true,
      );
  });
  await select.focus();
  await s.window.keyboard.press("Space");
  await expect
    .poll(() => select.evaluate((el) => el.matches(":open")))
    .toBe(true);
  await s.window.keyboard.press("Escape");
  writeFileSync(
    info.outputPath("native-select-events.json"),
    JSON.stringify(
      await s.window.evaluate(() => (globalThis as any).dialogKeys),
      null,
      2,
    ),
  );
  await expect(s.window.getByRole("dialog")).toBeVisible();
  await s.window.keyboard.press("Escape");
  await expect(s.window.getByRole("dialog")).toHaveCount(0);
});
test("R3 stale link document is rejected and switching page leaves both pages unchanged", async ({
  folio: s,
}) => {
  const id = await linkDocument(s);
  await selectWord(s);
  await s.window.keyboard.press("Meta+k");
  await s.window.getByLabel("検索キーワード").fill("アイデアノート");
  await expect(s.window.locator(".search-results button")).toHaveCount(1);
  await s.window
    .locator(".folio-editor")
    .evaluate((el) => (el as any).editor.commands.insertContent("Changed"));
  const changed = await editorDoc(s);
  await s.window.locator(".search-results button").click();
  await expect(s.window.getByRole("alert")).toContainText("本文が変わりました");
  expect(await editorDoc(s)).toEqual(changed);
  await expect(s.window.getByRole("dialog")).toHaveCount(0);
  await s.window.getByRole("button", { name: "閉じる", exact: true }).click();
  await saved(s);
  await s.window.getByTitle("ページへのリンク", { exact: true }).click();
  const state = await s.window.evaluate(() =>
    window.folio.request<any>({ type: "load" }),
  );
  const target = state.pages.find((p: any) => p.title === "アイデアノート");
  // Programmatic route change simulates navigation outside the modal; ordinary
  // background clicks are separately verified as inert.
  await s.window
    .locator(".page-tree-label")
    .filter({ hasText: "アイデアノート" })
    .evaluate((el) => (el as HTMLElement).click());
  await expect(s.window.getByRole("dialog")).toHaveCount(0);
  await expect(
    s.window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("アイデアノート");
  const after = await s.window.evaluate(() =>
    window.folio.request<any>({ type: "load" }),
  );
  expect(after.pages.find((p: any) => p.id === target.id)).toEqual(target);
  expect(after.pages.find((p: any) => p.id === id).doc.content).toEqual(
    changed.content,
  );
});
test("N04 slash arrow/confirm/cancel retains text and cursor (Folio only)", async ({
  folio: s,
}) => {
  const w = s.window;
  await w.keyboard.press("Meta+n");
  await w.locator(".folio-editor").click();
  await w.keyboard.type("/heading");
  await expect(w.getByRole("listbox")).toBeVisible();
  await w.keyboard.press("ArrowDown");
  await w.keyboard.press("Enter");
  await w.keyboard.type("Cursor");
  await expect(w.locator(".folio-editor h2")).toHaveText("Cursor");
  await w.keyboard.press("Enter");
  await w.keyboard.type("/todo");
  const before = await editorDoc(s),
    selection = await w
      .locator(".folio-editor")
      .evaluate((el) => (el as any).editor.state.selection.toJSON());
  await w.keyboard.press("Escape");
  await expect(w.getByRole("listbox")).toHaveCount(0);
  expect(await editorDoc(s)).toEqual(before);
  expect(
    await w
      .locator(".folio-editor")
      .evaluate((el) => (el as any).editor.state.selection.toJSON()),
  ).toEqual(selection);
  await saved(s);
});
