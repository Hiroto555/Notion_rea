import { writeFileSync } from "node:fs";
import { test, expect, saved, type Session } from "./next-round-fixture";

// Round 3 Fidelity lane acceptance. These tests observe the display layer in
// a real Electron window: responsive geometry, popover bounds, keyboard and
// focus behaviour, and the display side of the DB record scenario. Product
// writes are exercised only through the existing UI handlers; the new
// RecordRequest IPC is not implemented in this branch and is not asserted.

type Box = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number; panel: "static" | "absolute" };

async function resize(s: Session, size: Size) {
  await s.app.evaluate(
    ({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0].setContentSize(
        value.width,
        value.height,
      );
    },
    { width: size.width, height: size.height },
  );
  await expect
    .poll(async () => {
      const actual = await s.window.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      return (
        Math.abs(actual.width - size.width) <= 1 &&
        Math.abs(actual.height - size.height) <= 1
      );
    })
    .toBe(true);
}
async function focusWindow(s: Session) {
  await s.app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
    window.focus();
  });
  await s.window.bringToFront().catch(() => {});
}
async function box(s: Session, selector: string): Promise<Box> {
  const value = await s.window.locator(selector).first().boundingBox();
  if (!value) throw new Error("no bounding box for " + selector);
  return value;
}
function inside(
  value: Box | null,
  viewport: { width: number; height: number },
) {
  return (
    !!value &&
    value.x >= -0.5 &&
    value.y >= -0.5 &&
    value.x + value.width <= viewport.width + 0.5 &&
    value.y + value.height <= viewport.height + 0.5
  );
}
function record(
  info: { outputPath: (file: string) => string },
  name: string,
  value: unknown,
) {
  writeFileSync(info.outputPath(name), JSON.stringify(value, null, 2) + "\n");
  console.log("R3-FIDELITY " + name + " " + JSON.stringify(value));
}
async function currentFocus(s: Session) {
  return s.window.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return null;
    return {
      tag: element.tagName,
      label:
        element.getAttribute("aria-label") ??
        element.textContent?.trim().slice(0, 80) ??
        "",
      dialog: !!element.closest("dialog"),
      focusVisible: element.matches(":focus-visible"),
    };
  });
}

const sizes: Size[] = [
  { width: 1440, height: 907, panel: "static" },
  { width: 1024, height: 720, panel: "static" },
  { width: 960, height: 700, panel: "absolute" },
];

test("R3 fidelity responsive: 1440/1024/960, inspector footprint, popovers and theme", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);
  await expect(w.locator(".page-title")).toBeVisible();
  await w.getByLabel("アイデアノート を展開").click();
  await expect(w.locator(".page-tree-children .page-tree-row")).toHaveCount(1);
  const readings: unknown[] = [];

  for (const size of sizes) {
    await resize(s, size);
    const reading = await w.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const r = element.getBoundingClientRect();
        const n = (value: number) => Math.round(value * 10) / 10;
        return { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
      };
      const css = (selector: string, property: string) => {
        const element = document.querySelector(selector);
        return element
          ? getComputedStyle(element).getPropertyValue(property)
          : "";
      };
      const scroll = document.querySelector(".document-scroll") as HTMLElement;
      return {
        viewport: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        },
        theme: document.documentElement.dataset.theme ?? "",
        horizontalOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        documentOverflow: scroll.scrollWidth - scroll.clientWidth,
        scroll: {
          clientHeight: scroll.clientHeight,
          scrollHeight: scroll.scrollHeight,
          scrollTop: scroll.scrollTop,
        },
        boxes: {
          sidebar: rect(".sidebar"),
          topbar: rect(".topbar"),
          topbarActions: rect(".topbar-actions"),
          documentScroll: rect(".document-scroll"),
          content: rect(".document-content"),
          title: rect(".page-title"),
          inspector: rect(".inspector"),
          inspectorPage: rect(".inspector-page"),
          saveState: rect(".save-state"),
        },
        styles: {
          inspectorPosition: css(".inspector", "position"),
          documentScrollPaddingRight: css(".document-scroll", "padding-right"),
          titleSize: css(".page-title", "font-size"),
          editorWidth: css(".folio-editor", "width"),
        },
      };
    });
    expect(reading.viewport.width).toBeCloseTo(size.width, 0);
    expect(reading.horizontalOverflow).toBeLessThanOrEqual(0);
    expect(reading.documentOverflow).toBeLessThanOrEqual(1);
    expect(reading.styles.inspectorPosition).toBe(size.panel);
    expect(reading.boxes.inspector).not.toBeNull();
    expect(inside(reading.boxes.inspector, reading.viewport)).toBe(true);
    // New Round 3 rule: the reading/editing column never runs under the
    // inspector, including the floating layout at 960.
    expect(
      reading.boxes.content!.x + reading.boxes.content!.width,
    ).toBeLessThanOrEqual(reading.boxes.inspector!.x + 1);
    expect(
      reading.boxes.title!.x + reading.boxes.title!.width,
    ).toBeLessThanOrEqual(reading.boxes.inspector!.x + 1);
    if (size.panel === "absolute") {
      expect(
        parseFloat(reading.styles.documentScrollPaddingRight),
      ).toBeGreaterThanOrEqual(280);
      await expect(w.locator(".inspector-close")).toBeVisible();
    } else {
      expect(parseFloat(reading.styles.documentScrollPaddingRight)).toBe(0);
      await expect(w.locator(".inspector-close")).toBeHidden();
    }
    // The whole document stays reachable by scrolling in the reduced column.
    await w.locator(".document-end").scrollIntoViewIfNeeded();
    const end = await w.locator(".document-end").boundingBox();
    const scrollBox = await w.locator(".document-scroll").boundingBox();
    expect(inside(end, reading.viewport)).toBe(true);
    expect(end!.y).toBeGreaterThanOrEqual(scrollBox!.y - 1);
    expect(end!.y + end!.height).toBeLessThanOrEqual(
      scrollBox!.y + scrollBox!.height + 1,
    );
    // Page menu and icon picker stay inside the viewport at every width.
    await w.getByLabel("ページメニュー", { exact: true }).click();
    await expect(w.locator(".dropdown")).toBeVisible();
    expect(inside(await box(s, ".dropdown"), reading.viewport)).toBe(true);
    await w.keyboard.press("Escape");
    await expect(w.locator(".dropdown")).toHaveCount(0);
    await expect(w.getByLabel("ページメニュー", { exact: true })).toBeFocused();
    await w.getByLabel("ページアイコン", { exact: true }).click();
    await expect(w.locator(".icon-picker")).toBeVisible();
    expect(inside(await box(s, ".icon-picker"), reading.viewport)).toBe(true);
    await w.getByLabel("ページアイコン", { exact: true }).click();
    await expect(w.locator(".icon-picker")).toHaveCount(0);

    await w.screenshot({
      path: info.outputPath(
        `r3-fidelity-${size.width}x${size.height}-light.png`,
      ),
    });
    readings.push({ size: `${size.width}x${size.height}`, reading });
  }

  // Slash menu at 960: it opens at the paragraph start, inside the reduced
  // editing column, and adds no horizontal overflow to the scroll container.
  await resize(s, sizes[2]);
  await w.keyboard.press("Meta+n");
  await expect(w.locator(".page-title")).toHaveValue("無題");
  await w.locator(".folio-editor").click();
  await w.keyboard.type("/heading");
  await expect(w.getByRole("listbox")).toBeVisible();
  const slashViewport = await w.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  const slash = await box(s, ".slash-menu");
  expect(inside(slash, slashViewport)).toBe(true);
  expect(
    await w.evaluate(
      () =>
        (document.querySelector(".document-scroll") as HTMLElement)
          .scrollWidth -
        (document.querySelector(".document-scroll") as HTMLElement).clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await w.screenshot({
    path: info.outputPath("r3-fidelity-960-slash-menu.png"),
  });
  await w.keyboard.press("Escape");
  await expect(w.getByRole("listbox")).toHaveCount(0);

  // Light/dark token check with measured contrast at 1440.
  await resize(s, sizes[0]);
  const contrast = () =>
    w.evaluate(() => {
      const parse = (value: string) =>
        (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (color: number[]) => {
        const channel = (value: number) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return (
          0.2126 * channel(color[0]) +
          0.7152 * channel(color[1]) +
          0.0722 * channel(color[2])
        );
      };
      const ratio = (foreground: string, background: string) => {
        const a = lum(parse(foreground)),
          b = lum(parse(background));
        return (
          Math.round(
            ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100,
          ) / 100
        );
      };
      const color = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!).color;
      const background = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!).backgroundColor;
      return {
        theme: document.documentElement.dataset.theme,
        title: ratio(color(".page-title"), background(".main-pane")),
        editor: ratio(color(".folio-editor"), background(".main-pane")),
        muted: ratio(color(".page-subtitle"), background(".main-pane")),
        inspector: ratio(color(".inspector dd"), background(".inspector")),
        sidebar: ratio(color(".page-tree-title"), background(".sidebar")),
      };
    });
  await expect(w.locator("html")).toHaveAttribute("data-theme", "light");
  const light = await contrast();
  expect(light.title).toBeGreaterThanOrEqual(4.5);
  expect(light.editor).toBeGreaterThanOrEqual(4.5);
  expect(light.muted).toBeGreaterThanOrEqual(4.5);
  expect(light.inspector).toBeGreaterThanOrEqual(4.5);
  await w.getByLabel("テーマを切り替え").click();
  await expect(w.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await contrast();
  expect(dark.title).toBeGreaterThanOrEqual(4.5);
  expect(dark.editor).toBeGreaterThanOrEqual(4.5);
  expect(dark.muted).toBeGreaterThanOrEqual(4.5);
  expect(dark.inspector).toBeGreaterThanOrEqual(4.5);
  expect(dark.title).not.toBe(light.title);
  await w.screenshot({
    path: info.outputPath("r3-fidelity-1440x907-dark.png"),
  });
  await w.getByLabel("テーマを切り替え").click();
  await expect(w.locator("html")).toHaveAttribute("data-theme", "light");

  record(info, "r3-responsive.json", {
    captures: "1440x907, 1024x720, 960x700; light and dark",
    input:
      "Playwright pointer/keyboard; synthetic composition elsewhere; physical IME NOT_RUN",
    readings,
    slashMenu: { insideViewport: true, viewport: slashViewport, box: slash },
    contrast: { light, dark },
  });
});

test("R3 fidelity DB display: board/calendar/gallery record dialog is modal, bounded and focus-returning", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);
  await w
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await expect(w.locator(".database")).toBeVisible();
  const readings: unknown[] = [];

  for (const size of sizes) {
    await resize(s, size);
    const viewport = await w.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    for (const view of ["ギャラリー", "ボード", "カレンダー"]) {
      await w.getByRole("button", { name: view, exact: true }).click();
      const card = w.locator(".db-card").first();
      await expect(card).toBeVisible();
      await card.click();
      const dialog = w.getByRole("dialog", {
        name: "アイテムを編集",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      const title = w.getByLabel("アイテムのタイトル", { exact: true });
      await expect(title).toBeFocused();
      const panel = await box(s, ".common-dialog.record-modal");
      expect(inside(panel, viewport)).toBe(true);
      expect(panel.width).toBeLessThanOrEqual(viewport.width);
      const fieldCount = await dialog.locator(".record-field").count();
      expect(fieldCount).toBeGreaterThan(0);
      // Tab and Shift+Tab both stay inside the modal for a full cycle.
      const tabbable = await dialog.locator("button,input,select").count();
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 0; i < tabbable + 2; i++) {
          await w.keyboard.press(key);
          expect(
            await dialog.evaluate((el) => el.contains(document.activeElement)),
          ).toBe(true);
        }
      }
      // A background click is backdrop dismissal, not a page operation.
      const pageTitle = w.getByLabel("ページタイトル", { exact: true });
      const before = await pageTitle.inputValue();
      const background = w.locator(".page-tree-label").first();
      const backgroundBox = (await background.boundingBox())!;
      await w.mouse.click(
        backgroundBox.x + backgroundBox.width / 2,
        backgroundBox.y + backgroundBox.height / 2,
      );
      await expect(dialog).toHaveCount(0);
      await expect(pageTitle).toHaveValue(before);
      // Reopen with the keyboard: Escape returns focus to the card.
      await card.focus();
      await w.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await expect(title).toBeFocused();
      await w.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(card).toBeFocused();
      readings.push({
        size: `${size.width}x${size.height}`,
        view,
        panel,
        fieldCount,
        tabbable,
        insideViewport: true,
        escapeRestoredCardFocus: true,
      });
    }
    await w.screenshot({
      path: info.outputPath(`r3-fidelity-db-${size.width}x${size.height}.png`),
    });
  }

  // Table view in this branch still edits rows inline. The contract's full-page
  // record from every view is Core/DB UI work and remains NOT_IMPLEMENTED here.
  await resize(s, sizes[2]);
  await w.getByRole("button", { name: "テーブル", exact: true }).click();
  await expect(w.locator("tbody tr")).toHaveCount(3);
  const tableObserved = await w.evaluate(() => ({
    inlineTitleInputs: document.querySelectorAll(
      'tbody input[aria-label="アイテム名"]',
    ).length,
    recordDialog: !!document.querySelector("dialog.record-modal"),
  }));
  expect(tableObserved.inlineTitleInputs).toBe(3);
  const inline = w.locator('tbody input[aria-label="アイテム名"]').first();
  await inline.fill("テーブルで編集");
  await saved(s);

  // Fixture write path: edit a record title, close, restart, reopen the record.
  await w.getByRole("button", { name: "ギャラリー", exact: true }).click();
  const longTitle =
    "日本語の長いレコード名" +
    "を同じ画面で確認するための文章".repeat(4) +
    " UNBROKEN-0123456789";
  await w.locator(".db-card").first().click();
  await w.getByLabel("アイテムのタイトル", { exact: true }).fill(longTitle);
  await w.keyboard.press("Escape");
  await expect(w.getByRole("dialog")).toHaveCount(0);
  await saved(s);
  await s.restart();
  const reopened = s.window;
  await reopened
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await reopened
    .getByRole("button", { name: "ギャラリー", exact: true })
    .click();
  await reopened.locator(".db-card").first().click();
  await expect(
    reopened.getByLabel("アイテムのタイトル", { exact: true }),
  ).toHaveValue(longTitle);
  await reopened.keyboard.press("Escape");
  await expect(reopened.getByRole("dialog")).toHaveCount(0);

  record(info, "r3-db-record-display.json", {
    storage:
      "legacy DatabaseData v2 fixture through the existing onChange handler; DatabaseProjection/RecordRequest are not implemented and live record persistence is NOT_RUN",
    readings,
    tableViewObservation: {
      ...tableObserved,
      fullPageRecordFromTable: "NOT_IMPLEMENTED_OBSERVED",
      inlineTitleSave: "PASS (legacy fixture path)",
    },
    restart: { longJapaneseTitlePreserved: true },
  });
});

test("R3 fidelity keyboard contract: search/link/record and older dialogs share focus entry, loop, Escape and return", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);

  // Search: initial focus, arrow selection, Escape, documented focus return.
  await w.keyboard.press("Meta+p");
  const search = w.getByRole("dialog", {
    name: "ワークスペース検索",
    exact: true,
  });
  await expect(search).toBeVisible();
  await expect(w.getByLabel("検索キーワード")).toBeFocused();
  const results = w.locator(".search-results button");
  await expect(results.first()).toBeVisible();
  const resultCount = await results.count();
  if (resultCount > 1) {
    await w.keyboard.press("ArrowDown");
    await expect(results.nth(1)).toHaveAttribute("aria-current", "true");
  }
  await w.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(w.getByLabel("ページタイトル", { exact: true })).toBeFocused();

  // Link: Escape restores the exact editor selection and focus.
  await w.keyboard.press("Meta+n");
  await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
    "無題",
  );
  await w.locator(".folio-editor").click();
  await w.keyboard.type("リンク対象");
  await w.keyboard.press("Meta+ArrowLeft");
  for (let i = 0; i < 5; i++) await w.keyboard.press("Shift+ArrowRight");
  expect(await w.evaluate(() => getSelection()?.toString())).toBe("リンク対象");
  await w.keyboard.press("Meta+k");
  const link = w.getByRole("dialog", { name: "ページリンク", exact: true });
  await expect(link).toBeVisible();
  await expect(w.getByLabel("検索キーワード")).toBeFocused();
  await w.keyboard.press("Escape");
  await expect(link).toHaveCount(0);
  await expect(w.locator(".folio-editor")).toBeFocused();
  const selectionAfterCancel = await w.evaluate(() =>
    getSelection()?.toString(),
  );
  expect(selectionAfterCancel).toBe("リンク対象");

  // Synthetic composition only: Escape is ignored during composition.
  await w.keyboard.press("Meta+p");
  const compositionInput = w.getByLabel("検索キーワード");
  await compositionInput.focus();
  await compositionInput.evaluate((el) =>
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  await w.keyboard.press("Escape");
  await expect(search).toBeVisible();
  await compositionInput.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await w.keyboard.press("Escape");
  await expect(search).toHaveCount(0);

  // Older DialogFrame: templates. Initial focus is on the first content action,
  // Tab stays inside, arrows move between cards and Enter activates.
  const templatesButton = w.getByRole("button", {
    name: "テンプレート",
    exact: true,
  });
  await templatesButton.click();
  const templates = w.getByRole("dialog", {
    name: "テンプレート",
    exact: true,
  });
  await expect(templates).toBeVisible();
  const templateFocus = await w.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    return {
      tag: element.tagName,
      firstCard: element === document.querySelector(".templates button"),
      text: element.textContent?.trim(),
    };
  });
  expect(templateFocus.tag).toBe("BUTTON");
  expect(templateFocus.firstCard).toBe(true);
  const templateTabbable = await templates.locator("button").count();
  for (const key of ["Tab", "Shift+Tab"])
    for (let i = 0; i < templateTabbable + 1; i++) {
      await w.keyboard.press(key);
      expect(
        await templates.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
    }
  // Re-enter the list and follow the arrow-key order.
  await templates.locator(".templates button").first().focus();
  await w.keyboard.press("ArrowDown");
  expect(await w.evaluate(() => document.activeElement?.textContent)).toContain(
    "ミーティングノート",
  );
  await w.keyboard.press("ArrowUp");
  expect(await w.evaluate(() => document.activeElement?.textContent)).toContain(
    "空のページ",
  );
  await w.keyboard.press("Enter");
  await expect(templates).toHaveCount(0);
  await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
    "無題",
  );
  await expect(templatesButton).toBeFocused();

  // Older DialogFrame: move. The trigger is an unmounted dropdown item, so the
  // captured menu-anchor button is the focus return target.
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await w.getByRole("button", { name: "移動する", exact: true }).click();
  const move = w.getByRole("dialog", { name: "ページを移動", exact: true });
  await expect(move).toBeVisible();
  const moveFocus = await w.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    return {
      tag: element.tagName,
      firstRow: element === document.querySelector(".dialog-list button"),
    };
  });
  expect(moveFocus.tag).toBe("BUTTON");
  expect(moveFocus.firstRow).toBe(true);
  await w.keyboard.press("ArrowDown");
  expect(await w.evaluate(() => document.activeElement?.tagName)).toBe(
    "BUTTON",
  );
  await w.keyboard.press("Escape");
  await expect(move).toHaveCount(0);
  await expect(w.getByLabel("ページメニュー", { exact: true })).toBeFocused();

  // Older DialogFrame: history, opened from the inspector's visible button.
  // The welcome page has seeded revisions, so the list has a restore action.
  await w
    .locator(".page-tree-label")
    .filter({ hasText: "ようこそ、Folioへ" })
    .click();
  const historyLink = w.getByRole("button", {
    name: "変更履歴を見る",
    exact: true,
  });
  await historyLink.click();
  const history = w.getByRole("dialog", { name: "変更履歴", exact: true });
  await expect(history).toBeVisible();
  await expect(history.locator(".dialog-list button").first()).toBeVisible();
  const beforeHistoryDismiss = await w.evaluate(async () =>
    window.folio.request<any>({ type: "load" }),
  );
  // Opening history and pressing Enter again must not restore a version.
  await expect(history.getByRole("button", { name: "閉じる" })).toBeFocused();
  await w.keyboard.press("Enter");
  await expect(history).toHaveCount(0);
  await expect(historyLink).toBeFocused();
  const afterHistoryDismiss = await w.evaluate(async () =>
    window.folio.request<any>({ type: "load" }),
  );
  expect(afterHistoryDismiss.pages).toEqual(beforeHistoryDismiss.pages);

  // Older DialogFrame: trash. Trash the current page, then open the list.
  await w.keyboard.press("Meta+n");
  await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
    "無題",
  );
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await w.getByRole("button", { name: "ゴミ箱に移動", exact: true }).click();
  await expect(w.getByLabel("ページタイトル", { exact: true })).not.toHaveValue(
    "無題",
  );
  const trashButton = w
    .locator(".sidebar-footer-actions button")
    .filter({ hasText: "ゴミ箱" });
  await trashButton.click();
  const trash = w.getByRole("dialog", { name: "ゴミ箱", exact: true });
  await expect(trash).toBeVisible();
  await expect(trash.locator(".dialog-list button").first()).toBeFocused();
  await w.keyboard.press("Escape");
  await expect(trash).toHaveCount(0);
  await expect(trashButton).toBeFocused();

  // Background click while an older dialog is open dismisses it without acting.
  await templatesButton.click();
  await expect(templates).toBeVisible();
  const pageBefore = await w
    .getByLabel("ページタイトル", { exact: true })
    .inputValue();
  const background = w.locator(".page-tree-label").first();
  const backgroundBox = (await background.boundingBox())!;
  await w.mouse.click(
    backgroundBox.x + backgroundBox.width / 2,
    backgroundBox.y + backgroundBox.height / 2,
  );
  await expect(templates).toHaveCount(0);
  await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
    pageBefore,
  );

  const focusReporting = await currentFocus(s);
  record(info, "r3-focus-contract.json", {
    input:
      "Playwright pointer/keyboard; synthetic composition only; physical Japanese IME NOT_RUN",
    search: { resultCount, focusReturn: "page-title" },
    link: { selectionAfterCancel, focusReturn: "editor" },
    templates: {
      initialFocus: templateFocus,
      arrowOrder: "空のページ -> ミーティングノート -> 空のページ",
      enterActivation: "created 無題 page, focus returned to sidebar button",
    },
    move: {
      initialFocus: moveFocus,
      focusReturnAfterEscape: "ページメニュー button",
    },
    history: { focusReturnAfterEscape: "変更履歴を見る button" },
    trash: { focusReturnAfterEscape: "sidebar ゴミ箱 button" },
    background: "backdrop click dismissed without page operation",
    lastFocus: focusReporting,
  });
});

test("R3 fidelity long title, visible focus, sidebar width and reduced motion at 960", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);
  await resize(s, sizes[2]);
  const longTitle =
    "とても長い日本語のページタイトルを狭い画面で確認する" +
    "ための文章をここに置きます".repeat(5) +
    " UNBROKEN-SEGMENT-0123456789";
  await w.getByLabel("ページタイトル", { exact: true }).fill(longTitle);
  await saved(s);

  const long = await w.evaluate(() => {
    const measure = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement;
      const style = getComputedStyle(element);
      return {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        offsetWidth: element.offsetWidth,
        textOverflow: style.textOverflow,
        overflowWrap: style.overflowWrap,
        whiteSpace: style.whiteSpace,
      };
    };
    const content = document.querySelector(".document-content")!;
    const inspector = document.querySelector(".inspector")!;
    const contentRect = content.getBoundingClientRect();
    const inspectorRect = inspector.getBoundingClientRect();
    const title = document.querySelector(".page-title") as HTMLInputElement;
    const scroll = document.querySelector(".document-scroll") as HTMLElement;
    return {
      valueLength: title.value.length,
      valuePreserved: title.value.endsWith("UNBROKEN-SEGMENT-0123456789"),
      titleInput: {
        scrollWidth: title.scrollWidth,
        clientWidth: title.clientWidth,
      },
      sidebar: measure(".page-tree-row.active .page-tree-title"),
      crumb: measure(".crumb-current"),
      inspectorPage: measure(".inspector-page"),
      horizontalOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      documentOverflow: scroll.scrollWidth - scroll.clientWidth,
      contentRight: contentRect.x + contentRect.width,
      inspectorLeft: inspectorRect.x,
      titleRight:
        title.getBoundingClientRect().x + title.getBoundingClientRect().width,
    };
  });
  expect(long.valueLength).toBe(longTitle.length);
  expect(long.valuePreserved).toBe(true);
  expect(long.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(long.documentOverflow).toBeLessThanOrEqual(1);
  // The editor and the long title end before the floating inspector starts.
  expect(long.titleRight).toBeLessThanOrEqual(long.inspectorLeft + 1);
  expect(long.contentRight).toBeLessThanOrEqual(long.inspectorLeft + 1);
  expect(long.sidebar.textOverflow).toBe("ellipsis");
  expect(long.sidebar.scrollWidth).toBeGreaterThan(long.sidebar.clientWidth);
  expect(long.crumb.textOverflow).toBe("ellipsis");
  expect(long.crumb.scrollWidth).toBeGreaterThan(long.crumb.clientWidth);
  expect(long.inspectorPage.overflowWrap).toBe("anywhere");
  expect(long.inspectorPage.scrollWidth).toBeLessThanOrEqual(
    long.inspectorPage.clientWidth + 1,
  );
  // Single-line input: the value is intact and scrolls inside the field.
  expect(long.titleInput.scrollWidth).toBeGreaterThan(
    long.titleInput.clientWidth,
  );
  await w.screenshot({
    path: info.outputPath("r3-fidelity-960-long-title.png"),
  });

  // Keyboard focus gets a visible ring on the title. Text inputs match
  // :focus-visible by definition, so the ring is present after mouse focus too;
  // that is recorded rather than asserted away.
  await w.getByLabel("ページタイトル", { exact: true }).click();
  const mouseFocus = await currentFocus(s);
  await w.keyboard.press("Shift+Tab");
  await w.keyboard.press("Tab");
  const focus = await w.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const style = getComputedStyle(element);
    return {
      label: element.getAttribute("aria-label"),
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
    };
  });
  expect(focus.label).toBe("ページタイトル");
  expect(focus.focusVisible).toBe(true);
  expect(focus.outlineStyle).toBe("solid");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);

  // Sidebar toggle at 960 keeps the reduced editor column clear of the panel.
  await w.getByLabel("サイドバーを切り替え").click();
  await expect(w.locator(".sidebar")).toHaveCount(0);
  const collapsed = await w.evaluate(() => {
    const scroll = document.querySelector(".document-scroll") as HTMLElement;
    const content = document
      .querySelector(".document-content")!
      .getBoundingClientRect();
    const inspector = document
      .querySelector(".inspector")!
      .getBoundingClientRect();
    return {
      horizontalOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      documentOverflow: scroll.scrollWidth - scroll.clientWidth,
      contentRight: content.x + content.width,
      inspectorLeft: inspector.x,
      paddingRight: getComputedStyle(scroll).paddingRight,
    };
  });
  expect(collapsed.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(collapsed.documentOverflow).toBeLessThanOrEqual(1);
  expect(collapsed.contentRight).toBeLessThanOrEqual(
    collapsed.inspectorLeft + 1,
  );
  expect(parseFloat(collapsed.paddingRight)).toBeGreaterThanOrEqual(280);
  await w.getByLabel("サイドバーを切り替え").click();
  await expect(w.locator(".sidebar")).toBeVisible();

  // Reduced motion: transitions, animations and smooth scrolling are off.
  await w.emulateMedia({ reducedMotion: "reduce" });
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await expect(w.locator(".dropdown")).toBeVisible();
  const motion = await w.evaluate(() => {
    const durations = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!)
        .transitionDuration.split(",")
        .map((value) => parseFloat(value));
    return {
      scrollBehavior: getComputedStyle(
        document.querySelector(".document-scroll")!,
      ).scrollBehavior,
      dropdownAnimation: getComputedStyle(document.querySelector(".dropdown")!)
        .animationName,
      pageToolsTransitions: durations(".page-tools"),
    };
  });
  expect(motion.scrollBehavior).toBe("auto");
  expect(motion.dropdownAnimation).toBe("none");
  expect(motion.pageToolsTransitions.every((value) => value === 0)).toBe(true);
  await w.screenshot({
    path: info.outputPath("r3-fidelity-960-reduced-motion.png"),
  });
  await w.keyboard.press("Escape");
  await w.emulateMedia({ reducedMotion: null });

  record(info, "r3-long-title-keyboard-motion.json", {
    title: {
      length: longTitle.length,
      valuePreserved: true,
      inputScrolls: true,
    },
    truncation: {
      sidebar: "ellipsis (scrollWidth > clientWidth)",
      breadcrumb: "ellipsis (scrollWidth > clientWidth)",
      inspectorPage: "wraps (overflow-wrap: anywhere)",
      pageTitle:
        "single-line input scrolls internally; wrapping remains App-owned NOT_RUN",
    },
    focusRing: focus,
    mouseFocus,
    sidebarCollapsed: collapsed,
    reducedMotion: motion,
    input: "Playwright keyboard/pointer; no physical IME",
  });
});
