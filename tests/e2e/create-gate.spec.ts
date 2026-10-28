import { test, expect, saved } from "./next-round-fixture";

test("delayed page creation cannot redirect immediate input into the previous page", async ({
  folio: s,
}) => {
  const w = s.window;
  const initial = await w.evaluate(async () => {
    const state = await globalThis.window.folio.request<any>({ type: "load" });
    return (
      state.pages.find((page: any) => page.id === state.settings.activePage) ??
      state.pages[0]
    );
  });
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      if (request.type === "create") {
        (globalThis as any).heldCreate = true;
        await new Promise<void>((resolve) => {
          (globalThis as any).releaseCreate = resolve;
        });
      }
      return result;
    });
  });
  try {
    await w.keyboard.press("Meta+n");
    await expect
      .poll(() => s.app.evaluate(() => (globalThis as any).heldCreate))
      .toBe(true);
    await expect(
      w.getByRole("status").filter({ hasText: "ページを作成中" }),
    ).toBeVisible();
    await expect(w.getByLabel("ページタイトル", { exact: true })).toBeHidden();
    const pendingTitle = w
      .getByLabel("ページタイトル", { exact: true })
      .fill("New synthetic page");
    await s.app.evaluate(() => (globalThis as any).releaseCreate());
    await pendingTitle;
    await w.locator(".folio-editor").fill("new page body");
    await saved(s);
    const pages = await w.evaluate(
      async () =>
        (await globalThis.window.folio.request<any>({ type: "load" })).pages,
    );
    const oldPage = pages.find((page: any) => page.id === initial.id);
    const newPage = pages.find(
      (page: any) => page.title === "New synthetic page",
    );
    expect(oldPage.title).toBe(initial.title);
    expect(oldPage.doc).toEqual(initial.doc);
    expect(JSON.stringify(newPage.doc)).toContain("new page body");
  } finally {
    await s.app
      .evaluate(() => (globalThis as any).releaseCreate?.())
      .catch(() => {});
  }
});

test("a delayed create does not override a later explicit navigation", async ({
  folio: s,
}) => {
  const w = s.window;
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      if (request.type === "create") {
        (globalThis as any).heldCreate = true;
        await new Promise<void>((resolve) => {
          (globalThis as any).releaseCreate = resolve;
        });
      }
      return result;
    });
  });
  try {
    await w.keyboard.press("Meta+n");
    await expect
      .poll(() => s.app.evaluate(() => (globalThis as any).heldCreate))
      .toBe(true);
    await w
      .locator(".page-tree-label")
      .filter({ hasText: "アイデアノート" })
      .click();
    await s.app.evaluate(() => (globalThis as any).releaseCreate());
    await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
      "アイデアノート",
    );
  } finally {
    await s.app
      .evaluate(() => (globalThis as any).releaseCreate?.())
      .catch(() => {});
  }
});

test("a failed create restores the same Editor and its saved content", async ({
  folio: s,
}) => {
  const w = s.window;
  await w.locator(".folio-editor").fill("existing content before failure");
  await saved(s);
  await w.locator(".folio-editor").evaluate((node) => {
    (globalThis as any).beforeCreateEditor = node;
  });
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      if (request.type === "create") {
        (globalThis as any).heldCreate = true;
        await new Promise<void>((resolve) => {
          (globalThis as any).releaseCreate = resolve;
        });
        throw new Error("synthetic create failure");
      }
      return original(event, request);
    });
  });
  try {
    await w.keyboard.press("Meta+n");
    await expect
      .poll(() => s.app.evaluate(() => (globalThis as any).heldCreate))
      .toBe(true);
    await expect(w.locator(".folio-editor")).toBeHidden();
    await s.app.evaluate(() => (globalThis as any).releaseCreate());
    await expect(w.getByRole("alert")).toContainText(
      "synthetic create failure",
    );
    await expect(w.locator(".folio-editor")).toContainText(
      "existing content before failure",
    );
    expect(
      await w
        .locator(".folio-editor")
        .evaluate((node) => node === (globalThis as any).beforeCreateEditor),
    ).toBe(true);
  } finally {
    await s.app
      .evaluate(() => (globalThis as any).releaseCreate?.())
      .catch(() => {});
  }
});

test("a second create is refused while the first is pending", async ({
  folio: s,
}) => {
  const w = s.window;
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    (globalThis as any).createCount = 0;
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      if (request.type === "create") {
        (globalThis as any).createCount++;
        const result = await original(event, request);
        (globalThis as any).heldCreate = true;
        await new Promise<void>((resolve) => {
          (globalThis as any).releaseCreate = resolve;
        });
        return result;
      }
      return original(event, request);
    });
  });
  try {
    await w.keyboard.press("Meta+n");
    await expect
      .poll(() => s.app.evaluate(() => (globalThis as any).heldCreate))
      .toBe(true);
    await w.keyboard.press("Meta+n");
    await expect(w.getByRole("alert")).toContainText("ページを作成中");
    expect(await s.app.evaluate(() => (globalThis as any).createCount)).toBe(1);
    await s.app.evaluate(() => (globalThis as any).releaseCreate());
    await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
      "無題",
    );
  } finally {
    await s.app
      .evaluate(() => (globalThis as any).releaseCreate?.())
      .catch(() => {});
  }
});

test("page creation from the sidebar is refused during synthetic composition", async ({
  folio: s,
}) => {
  const w = s.window;
  const title = await w
    .getByLabel("ページタイトル", { exact: true })
    .inputValue();
  await w
    .locator(".folio-editor")
    .dispatchEvent("compositionstart", { data: "あ" });
  try {
    await w.getByRole("button", { name: "新しいページ" }).click();
    await expect(w.getByRole("alert")).toContainText("変換を確定");
    await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
      title,
    );
  } finally {
    await w
      .locator(".folio-editor")
      .dispatchEvent("compositionend", { data: "あ" });
  }
});
