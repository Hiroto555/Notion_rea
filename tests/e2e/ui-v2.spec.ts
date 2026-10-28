import { writeFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { test, expect, type Session } from "./next-round-fixture";

// UI 2.0 evidence suite. Everything here observes the display layer through
// real Electron: geometry, computed tokens, hover/focus affordances, menu
// bounds and contrast. Product behaviour (save, move, recovery) is exercised
// by the existing suites and is not re-specified here.

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
} | null;

type Reading = {
  viewport: { width: number; height: number; dpr: number };
  theme: string;
  horizontalOverflow: number;
  documentOverflow: number | null;
  boxes: Record<
    | "sidebar"
    | "topbar"
    | "topbarActions"
    | "breadcrumbs"
    | "saveState"
    | "menuButton"
    | "documentScroll"
    | "content"
    | "title"
    | "inspector"
    | "activeRow",
    Box
  >;
  styles: Record<string, string>;
  a11y: {
    activeLabelCurrent: string | null;
    sidebarPressed: string | null;
    inspectorPressed: string | null;
    toggleExpanded: string | null;
    saveStateText: string | null;
    focusableCount: number;
  };
  tree: { text: string; left: number; depth: string; active: boolean }[];
};

async function measure(s: Session): Promise<Reading> {
  return s.window.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      const round = (value: number) => Math.round(value * 10) / 10;
      return {
        x: round(r.x),
        y: round(r.y),
        width: round(r.width),
        height: round(r.height),
      };
    };
    const css = (selector: string, property: string) => {
      const element = document.querySelector(selector);
      return element
        ? getComputedStyle(element).getPropertyValue(property)
        : "";
    };
    const documentScroll = document.querySelector(
      ".document-scroll",
    ) as HTMLElement | null;
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
      documentOverflow: documentScroll
        ? documentScroll.scrollWidth - documentScroll.clientWidth
        : null,
      boxes: {
        sidebar: box(".sidebar"),
        topbar: box(".topbar"),
        topbarActions: box(".topbar-actions"),
        breadcrumbs: box(".breadcrumbs"),
        saveState: box(".save-state"),
        menuButton: box(".topbar .menu-anchor > button"),
        documentScroll: box(".document-scroll"),
        content: box(".document-content"),
        title: box(".page-title"),
        inspector: box(".inspector"),
        activeRow: box(".page-tree-row.active"),
      },
      styles: {
        bodyBackground: css(".main-pane", "background-color"),
        bodyColor: css(".main-pane", "color"),
        sidebarBackground: css(".sidebar", "background-color"),
        line: css(".topbar", "border-bottom-color"),
        titleSize: css(".page-title", "font-size"),
        titleWeight: css(".page-title", "font-weight"),
        titleColor: css(".page-title", "color"),
        subtitleColor: css(".page-subtitle", "color"),
        contentPaddingLeft: css(".document-content", "padding-left"),
        inspectorPosition: css(".inspector", "position"),
        inspectorBackground: css(".inspector", "background-color"),
        crumbSize: css(".crumb-current", "font-size"),
        treeAddOpacity: css(".page-tree-row.active .tree-add", "opacity"),
        pageToolsOpacity: css(".page-tools", "opacity"),
        focusOutline: "",
      },
      a11y: {
        activeLabelCurrent:
          document
            .querySelector(".page-tree-label[aria-current='page']")
            ?.textContent?.trim() ?? null,
        sidebarPressed:
          document
            .querySelector("[aria-label='サイドバーを切り替え']")
            ?.getAttribute("aria-pressed") ?? null,
        inspectorPressed:
          document
            .querySelector("[aria-label='ページ情報']")
            ?.getAttribute("aria-pressed") ?? null,
        toggleExpanded:
          document
            .querySelector(".tree-toggle[aria-expanded]")
            ?.getAttribute("aria-expanded") ?? null,
        saveStateText:
          document.querySelector(".save-state")?.textContent?.trim() ?? null,
        focusableCount: document.querySelectorAll(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex='0']",
        ).length,
      },
      tree: [...document.querySelectorAll(".page-tree-row")].map((row) => {
        const r = row.getBoundingClientRect();
        return {
          text:
            row.querySelector(".page-tree-label")?.textContent?.trim() ?? "",
          left: Math.round(r.left * 10) / 10,
          depth:
            (row.closest(".page-tree-node") as HTMLElement | null)?.dataset
              .depth ?? "",
          active: row.classList.contains("active"),
        };
      }),
    } satisfies Reading;
  });
}

async function focusWindow(s: Session) {
  // Real OS hover state needs an active window in this Electron build.
  await s.app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
    window.focus();
  });
  await s.window.bringToFront().catch(() => {});
}

async function hoverElement(s: Session, locator: Locator) {
  await focusWindow(s);
  const box = await locator.boundingBox();
  if (!box) throw new Error("hover target has no bounding box");
  const x = box.x + Math.min(40, box.width / 2),
    y = box.y + box.height / 2;
  // Two moves make the hover state robust on macOS when the window was just
  // activated; the assertion below still requires a real :hover match.
  await s.window.mouse.move(x - 80, y, { steps: 4 });
  await s.window.mouse.move(x, y, { steps: 4 });
  await expect
    .poll(() => locator.evaluate((el) => el.matches(":hover")))
    .toBe(true);
}

async function resize(s: Session, width: number, height: number) {
  await s.app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await expect
    .poll(async () => {
      const actual = await s.window.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      return (
        Math.abs(actual.width - width) <= 1 &&
        Math.abs(actual.height - height) <= 1
      );
    })
    .toBe(true);
}

function channels(value: string): [number, number, number] {
  const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}
function luminance([r, g, b]: [number, number, number]) {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(foreground: string, background: string) {
  const a = luminance(channels(foreground)),
    b = luminance(channels(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function record(
  info: { outputPath: (file: string) => string },
  name: string,
  value: unknown,
) {
  writeFileSync(info.outputPath(name), JSON.stringify(value, null, 2) + "\n");
  console.log("UI-EVIDENCE " + name + " " + JSON.stringify(value));
}

test("UI 2.0 light: hierarchy, hover reveal, menu bounds and contrast", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);
  await expect(w.locator(".page-title")).toBeVisible();
  await expect(w.locator("html")).toHaveAttribute("data-theme", "light");
  // Expand one nested page so indentation and guides are measurable.
  await w.getByLabel("アイデアノート を展開").click();
  await expect(w.locator(".page-tree-children .page-tree-row")).toHaveCount(1);
  const light = await measure(s);

  expect(light.viewport.width).toBeGreaterThanOrEqual(1400);
  // R4 shared shell contract: 240px at the desktop viewport.
  expect(light.boxes.sidebar!.width).toBeCloseTo(240, 0);
  expect(light.boxes.inspector!.width).toBeCloseTo(240, 0);
  expect(light.boxes.topbar!.height).toBeCloseTo(54, 0);
  expect(light.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(light.documentOverflow).toBeLessThanOrEqual(1);
  expect(light.a11y.activeLabelCurrent).toContain("ようこそ");
  expect(light.a11y.saveStateText).toBe("保存済み");
  expect(light.a11y.sidebarPressed).toBe("true");
  expect(light.a11y.inspectorPressed).toBe("true");
  expect(light.a11y.toggleExpanded).not.toBeNull();
  expect(light.tree.filter((row) => row.active)).toHaveLength(1);
  const roots = light.tree.filter((row) => row.depth === "0");
  const nested = light.tree.filter((row) => Number(row.depth) > 0);
  expect(roots.length).toBeGreaterThan(0);
  expect(nested.length).toBeGreaterThan(0);
  expect(nested[0].left).toBeGreaterThan(roots[0].left);

  // Hover reveals the per-row action and the page tools without moving layout.
  const activeRow = w.locator(".page-tree-row.active");
  const treeAdd = activeRow.locator(".tree-add");
  const opacity = (selector: string) =>
    w.locator(selector).evaluate((el) => getComputedStyle(el).opacity);
  const hoverProbe = () =>
    w.evaluate(() => {
      const row = document.querySelector(
        ".page-tree-row.active",
      ) as HTMLElement | null;
      const add = row?.querySelector(".tree-add") as HTMLElement | null;
      if (!row || !add) return null;
      const box = row.getBoundingClientRect();
      const point = document.elementFromPoint(
        box.x + 40,
        box.y + box.height / 2,
      );
      return {
        rowHover: row.matches(":hover"),
        addHover: add.matches(":hover"),
        focusWithin: row.matches(":focus-within"),
        opacity: getComputedStyle(add).opacity,
        pointTag: point?.tagName ?? null,
        pointClass: point?.getAttribute("class") ?? null,
        documentFocused: document.hasFocus(),
        activeElement: (document.activeElement as HTMLElement | null)
          ?.className,
        rowBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    });
  expect(await opacity(".page-tree-row.active .tree-add")).toBe("0");
  const hoverBefore = await hoverProbe();
  await hoverElement(s, activeRow);
  const hoverMoved = await hoverProbe();
  record(info, "ui-hover-state.json", {
    before: hoverBefore,
    moved: hoverMoved,
  });
  await expect.poll(() => opacity(".page-tree-row.active .tree-add")).toBe("1");
  const hoverAfter = await hoverProbe();
  await w.mouse.move(2, 2);
  await expect.poll(() => opacity(".page-tree-row.active .tree-add")).toBe("0");
  await hoverElement(s, w.locator(".page-decoration"));
  await expect.poll(() => opacity(".page-tools")).toBe("1");
  await treeAdd.focus();
  await expect.poll(() => opacity(".page-tree-row.active .tree-add")).toBe("1");
  const rowBox = await activeRow.boundingBox();
  expect(rowBox!.height).toBeGreaterThanOrEqual(30);

  // Body text, title and secondary metadata meet AA contrast on the page.
  const bodyContrast = contrast(
    light.styles.bodyColor,
    light.styles.bodyBackground,
  );
  const titleContrast = contrast(
    light.styles.titleColor,
    light.styles.bodyBackground,
  );
  const metaContrast = contrast(
    light.styles.subtitleColor,
    light.styles.bodyBackground,
  );
  expect(bodyContrast).toBeGreaterThanOrEqual(7);
  expect(titleContrast).toBeGreaterThanOrEqual(10);
  expect(metaContrast).toBeGreaterThanOrEqual(4.5);
  expect(parseFloat(light.styles.titleSize)).toBeGreaterThanOrEqual(30);
  expect(parseFloat(light.styles.crumbSize)).toBeGreaterThanOrEqual(11);

  // The page menu stays inside the viewport, is grouped by section labels and
  // changes background on hover.
  await w.getByLabel("ページメニュー", { exact: true }).click();
  const dropdown = w.locator(".dropdown");
  await expect(dropdown).toBeVisible();
  const dropdownBox = await dropdown.boundingBox();
  expect(dropdownBox).not.toBeNull();
  expect(dropdownBox!.x).toBeGreaterThanOrEqual(0);
  expect(dropdownBox!.y).toBeGreaterThanOrEqual(0);
  expect(dropdownBox!.x + dropdownBox!.width).toBeLessThanOrEqual(
    light.viewport.width + 1,
  );
  expect(dropdownBox!.y + dropdownBox!.height).toBeLessThanOrEqual(
    light.viewport.height + 1,
  );
  await expect(dropdown.locator(".menu-section-label").first()).toHaveText(
    "ページ",
  );
  const duplicate = dropdown.getByRole("button", {
    name: "複製",
    exact: true,
  });
  const itemBackground = () =>
    duplicate.evaluate((el) => getComputedStyle(el).backgroundColor);
  const idle = await itemBackground();
  await duplicate.hover();
  await expect.poll(itemBackground).not.toBe(idle);
  await w.keyboard.press("Escape");
  await expect(dropdown).toHaveCount(0);
  await w.getByLabel("ページメニュー", { exact: true }).click();
  await expect(dropdown).toBeVisible();
  await w.locator(".page-title").click();
  await expect(dropdown).toHaveCount(0);

  await w.screenshot({ path: info.outputPath("ui-light-1440x960.png") });
  record(info, "ui-light-metrics.json", {
    capture: "1440x960 light",
    reading: light,
    contrast: {
      body: Number(bodyContrast.toFixed(2)),
      title: Number(titleContrast.toFixed(2)),
      meta: Number(metaContrast.toFixed(2)),
    },
    menu: {
      box: dropdownBox,
      sectionLabel: "ページ",
      hoverBackgroundChanged: true,
      escapeClosed: true,
      clickOutsideClosed: true,
    },
    hover: {
      treeAddHiddenUntilHover: true,
      treeAddVisibleOnFocus: true,
      pageToolsHiddenUntilHover: true,
      before: hoverBefore,
      moved: hoverMoved,
      after: hoverAfter,
    },
  });
});

test("UI 2.0 dark: theme tokens, menu surface and contrast", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);
  await expect(w.locator("html")).toHaveAttribute("data-theme", "light");
  const before = await measure(s);
  await w.getByLabel("テーマを切り替え").click();
  await expect(w.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(w.getByLabel("テーマを切り替え")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const dark = await measure(s);

  expect(dark.styles.bodyBackground).not.toBe(before.styles.bodyBackground);
  expect(dark.styles.bodyColor).not.toBe(before.styles.bodyColor);
  expect(dark.styles.sidebarBackground).not.toBe(
    before.styles.sidebarBackground,
  );
  const bodyContrast = contrast(
    dark.styles.bodyColor,
    dark.styles.bodyBackground,
  );
  const titleContrast = contrast(
    dark.styles.titleColor,
    dark.styles.bodyBackground,
  );
  const metaContrast = contrast(
    dark.styles.subtitleColor,
    dark.styles.bodyBackground,
  );
  expect(bodyContrast).toBeGreaterThanOrEqual(7);
  expect(titleContrast).toBeGreaterThanOrEqual(10);
  expect(metaContrast).toBeGreaterThanOrEqual(4.5);
  const sidebarContrast = contrast(
    dark.styles.bodyColor,
    dark.styles.sidebarBackground,
  );
  expect(sidebarContrast).toBeGreaterThanOrEqual(7);

  // Menus use a surface token distinct from the page background, and the
  // inspector stays legible in dark mode.
  await w.getByLabel("ページメニュー", { exact: true }).click();
  const surface = await w
    .locator(".dropdown")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(w.locator(".dropdown")).toBeVisible();
  expect(channels(surface)).not.toEqual(channels(dark.styles.bodyBackground));
  await w.keyboard.press("Escape");

  await hoverElement(s, w.locator(".page-tree-row.active"));
  await expect
    .poll(() =>
      w
        .locator(".page-tree-row.active .tree-add")
        .evaluate((el) => getComputedStyle(el).opacity),
    )
    .toBe("1");

  // The chosen theme survives a renderer reload (existing setting behaviour).
  await w.reload();
  await w.waitForSelector(".page-title");
  await expect(w.locator("html")).toHaveAttribute("data-theme", "dark");
  const reopened = await measure(s);
  expect(reopened.theme).toBe("dark");
  await w.screenshot({ path: info.outputPath("ui-dark-1440x960.png") });
  record(info, "ui-dark-metrics.json", {
    capture: "1440x960 dark",
    reading: dark,
    reopenedTheme: reopened.theme,
    contrast: {
      body: Number(bodyContrast.toFixed(2)),
      title: Number(titleContrast.toFixed(2)),
      meta: Number(metaContrast.toFixed(2)),
      sidebar: Number(sidebarContrast.toFixed(2)),
    },
    menuSurface: surface,
    menuSurfaceDiffersFromPage: true,
  });
});

test("UI 2.0 responsive: 1024 and 960 keep panels usable without overflow", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);
  const readings: { size: string; reading: Reading }[] = [];
  for (const size of [
    { width: 1024, height: 720, panel: "static", sidebar: 220, title: 34, gutter: 36 },
    { width: 960, height: 700, panel: "absolute", sidebar: 208, title: 30, gutter: 28 },
  ] as const) {
    await resize(s, size.width, size.height);
    const reading = await measure(s);
    const viewport = reading.viewport;
    expect(Math.abs(viewport.width - size.width)).toBeLessThanOrEqual(1);
    expect(reading.horizontalOverflow).toBeLessThanOrEqual(0);
    expect(reading.documentOverflow).toBeLessThanOrEqual(1);
    expect(reading.styles.inspectorPosition).toBe(size.panel);
    expect(reading.boxes.inspector).not.toBeNull();
    expect(reading.boxes.sidebar!.width).toBeCloseTo(size.sidebar, 0);
    expect(
      reading.boxes.inspector!.x + reading.boxes.inspector!.width,
    ).toBeLessThanOrEqual(viewport.width + 1);
    expect(
      reading.boxes.inspector!.y + reading.boxes.inspector!.height,
    ).toBeLessThanOrEqual(viewport.height + 1);
    expect(
      reading.boxes.topbarActions!.x + reading.boxes.topbarActions!.width,
    ).toBeLessThanOrEqual(viewport.width + 1);
    expect(reading.boxes.content!.width).toBeLessThanOrEqual(
      reading.boxes.documentScroll!.width + 1,
    );
    expect(parseFloat(reading.styles.titleSize)).toBeCloseTo(size.title, 0);
    expect(
      parseFloat(reading.styles.contentPaddingLeft),
    ).toBeCloseTo(size.gutter, 0);
    if (size.panel === "static") {
      // In-flow panel: the reading column ends before the inspector starts.
      expect(
        reading.boxes.content!.x + reading.boxes.content!.width,
      ).toBeLessThanOrEqual(reading.boxes.inspector!.x + 1);
      expect(reading.boxes.inspector!.x).toBeGreaterThanOrEqual(
        reading.boxes.documentScroll!.x - 1,
      );
      await expect(w.locator(".inspector-close")).toBeHidden();
    } else {
      // Overlay panel: it stays inside the window and offers an explicit close.
      expect(reading.boxes.inspector!.x).toBeGreaterThanOrEqual(
        reading.boxes.documentScroll!.x - 1,
      );
      await expect(w.locator(".inspector-close")).toBeVisible();
    }
    await w.screenshot({
      path: info.outputPath(`ui-light-${size.width}x${size.height}.png`),
    });
    readings.push({ size: `${size.width}x${size.height}`, reading });
  }

  // The inspector and sidebar toggles keep working in the compact layout.
  await w.getByLabel("情報パネルを閉じる").click();
  await expect(w.locator(".inspector")).toHaveCount(0);
  await w.getByLabel("ページ情報", { exact: true }).click();
  await expect(w.locator(".inspector")).toBeVisible();
  await w.getByLabel("サイドバーを切り替え").click();
  await expect(w.locator(".sidebar")).toHaveCount(0);
  const clearedPadding = await w
    .locator(".topbar")
    .evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(parseFloat(clearedPadding)).toBeGreaterThanOrEqual(88);
  const collapsed = await measure(s);
  expect(collapsed.horizontalOverflow).toBeLessThanOrEqual(0);
  await w.screenshot({
    path: info.outputPath("ui-light-960x700-sidebar-hidden.png"),
  });
  await w.getByLabel("サイドバーを切り替え").click();
  await expect(w.locator(".sidebar")).toBeVisible();

  record(info, "ui-responsive-metrics.json", {
    readings,
    toggles: {
      inspectorCloseButton: true,
      inspectorReopenedFromTopbar: true,
      sidebarHidden: true,
      topbarLeftAfterSidebarHidden: clearedPadding,
      overflowWhileSidebarHidden: collapsed.horizontalOverflow,
    },
  });
});

test("UI 2.0 keyboard: focus visibility, shortcuts and menu Escape", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await focusWindow(s);
  await w.locator(".page-title").click();
  await w.keyboard.press("Tab");
  const focus = await w.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      label: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "",
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focus).not.toBeNull();
  expect(focus!.tag).toBe("BUTTON");
  expect(focus!.outlineStyle).toBe("solid");
  expect(parseFloat(focus!.outlineWidth)).toBeGreaterThanOrEqual(2);

  // Existing shortcut still opens the shared search dialog; Escape closes it.
  await w.keyboard.press("Meta+p");
  const dialog = w.getByRole("dialog", {
    name: "ワークスペース検索",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(w.getByLabel("検索キーワード")).toBeFocused();
  await w.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The page menu can be opened from the keyboard, then closed with Escape.
  const menuButton = w.getByLabel("ページメニュー", { exact: true });
  await menuButton.focus();
  await w.keyboard.press("Enter");
  await expect(w.locator(".dropdown")).toBeVisible();
  expect(
    await w.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.getAttribute(
        "aria-label",
      ),
    ),
  ).toBe("ページメニュー");
  await w.keyboard.press("Escape");
  await expect(w.locator(".dropdown")).toHaveCount(0);
  expect(
    await w.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.getAttribute(
        "aria-label",
      ),
    ),
  ).toBe("ページメニュー");

  // Arrow keys still navigate the search result list.
  await w.keyboard.press("Meta+p");
  const results = w.locator(".search-results button");
  await expect(results.first()).toBeVisible();
  const count = await results.count();
  if (count > 1) {
    await w.keyboard.press("ArrowDown");
    await expect(results.nth(1)).toHaveAttribute("aria-current", "true");
  }
  await w.keyboard.press("Escape");

  await w.screenshot({ path: info.outputPath("ui-keyboard-focus.png") });
  record(info, "ui-keyboard-metrics.json", {
    tabFocus: focus,
    searchDialogOpened: true,
    searchDialogClosed: true,
    menuOpenedFromKeyboard: true,
    menuClosedWithEscape: true,
    resultNavigation:
      count > 1 ? "ArrowDown moved aria-current" : "single result",
  });
});
