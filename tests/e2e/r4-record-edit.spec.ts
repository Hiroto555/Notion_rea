import { test, expect, type ElectronApplication } from "@playwright/test";
import {
  disposeR4,
  launchR4,
  openR4Database,
  openR4Record,
  r4Data,
  r4Saved,
  readR4Record,
} from "./r4-fixture";

test("record body, title and three property types persist through cells, panel and Electron restart", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR4(data);
    app = running.app;
    let window = running.window;
    await openR4Database(window);
    const row = window.locator(`tr[data-record-id="${data.first.pageId}"]`);
    await row.getByLabel("メモ R4 Alpha", { exact: true }).fill("cell note");
    await row.getByLabel("見積 R4 Alpha", { exact: true }).fill("12.5");
    await row.getByLabel("完了 R4 Alpha", { exact: true }).check();
    await r4Saved(window);
    await openR4Record(window);
    const record = window.locator(".r3-record-page");
    await expect(record.getByLabel("メモ", { exact: true })).toHaveValue(
      "cell note",
    );
    await expect(record.getByLabel("見積", { exact: true })).toHaveValue(
      "12.5",
    );
    await expect(record.getByLabel("完了", { exact: true })).toBeChecked();
    await record.getByLabel("レコードのタイトル").fill("R4 edited Alpha");
    await record
      .locator(".folio-editor")
      .fill("body saved through the real Editor");
    await record.getByLabel("メモ", { exact: true }).fill("panel note");
    await record.getByLabel("見積", { exact: true }).fill("24.75");
    await record.getByLabel("完了", { exact: true }).uncheck();
    await r4Saved(window);
    await record.getByRole("button", { name: "レコードを閉じる" }).click();
    await expect(
      row.getByLabel("名前 R4 edited Alpha", { exact: true }),
    ).toHaveValue("R4 edited Alpha");
    await expect(
      row.getByLabel("メモ R4 edited Alpha", { exact: true }),
    ).toHaveValue("panel note");
    await expect(
      row.getByLabel("見積 R4 edited Alpha", { exact: true }),
    ).toHaveValue("24.75");
    await expect(
      row.getByLabel("完了 R4 edited Alpha", { exact: true }),
    ).not.toBeChecked();
    await app.close();
    app = undefined;
    running = await launchR4(data);
    app = running.app;
    window = running.window;
    await openR4Database(window);
    await openR4Record(window, "R4 edited Alpha");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "body saved through the real Editor",
    );
    const saved = await readR4Record(window, data.first.pageId);
    expect(saved.page.title).toBe("R4 edited Alpha");
    expect(saved.record.values).toEqual({
      note: "panel note",
      estimate: 24.75,
      done: false,
    });
    expect(JSON.stringify(saved.page.doc)).toContain(
      "body saved through the real Editor",
    );
    expect(saved.page.revision).toBe(saved.record.revision);
  } finally {
    await disposeR4(data, app);
  }
});

test("side/full preserves the Editor and undo history and close restores origin focus and scroll", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    await openR4Database(window);
    const origin = window.locator(
      `[data-record-open-id="${data.tail.pageId}"]`,
    );
    await origin.scrollIntoViewIfNeeded();
    const scroll = await window
      .locator(".document-scroll")
      .evaluate((element) => element.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await origin.click();
    const body = window.locator(".r3-record-page .folio-editor");
    await expect(body).toBeVisible();
    await body.evaluate((element) => {
      (globalThis as any).r4EditorInstance = (element as any).editor;
    });
    await body.fill("same editor after switching");
    await r4Saved(window);
    await window
      .getByRole("button", { name: "全画面で開く", exact: true })
      .click();
    await expect(window.locator(".r3-record-page")).toHaveAttribute(
      "data-record-mode",
      "full",
    );
    await window
      .getByRole("button", { name: "サイドピークで開く", exact: true })
      .click();
    expect(
      await body.evaluate(
        (element) =>
          (element as any).editor === (globalThis as any).r4EditorInstance,
      ),
    ).toBe(true);
    await body.focus();
    await window.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    await expect(body).toContainText("tail original body");
    await r4Saved(window);
    await window.getByRole("button", { name: "レコードを閉じる" }).click();
    await expect(origin).toBeFocused();
    expect(
      await window
        .locator(".document-scroll")
        .evaluate((element) => element.scrollTop),
    ).toBe(scroll);
  } finally {
    await disposeR4(data, app);
  }
});

test("held record ACK retains later input across close, another record and reopen without cross-target writes", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    await openR4Database(window);
    await openR4Record(window);
    await app.evaluate(({ ipcMain }, pageId) => {
      const ipc = ipcMain as any,
        original = ipc._invokeHandlers.get("folio:request");
      const gate: any = ((globalThis as any).r4Ack = {
        requests: [],
        held: false,
      });
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await original(event, request);
        if (request.type === "save:commit") {
          gate.requests.push(request.operation);
          if (request.operation.pageId === pageId && !gate.held) {
            gate.held = true;
            await new Promise<void>((release) => {
              gate.release = release;
            });
          }
        }
        return result;
      });
    }, data.first.pageId);
    await window.getByLabel("レコードのタイトル").fill("R4 first ACK held");
    await expect
      .poll(() => app!.evaluate(() => typeof (globalThis as any).r4Ack.release))
      .toBe("function");
    await window
      .locator(".r3-record-page .folio-editor")
      .fill("later input while ACK is held");
    await window.getByRole("button", { name: "レコードを閉じる" }).click();
    await openR4Record(window, "R4 Beta");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "beta original body",
    );
    await window.getByRole("button", { name: "レコードを閉じる" }).click();
    await openR4Record(window, "R4 first ACK held");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "later input while ACK is held",
    );
    await app.evaluate(() => (globalThis as any).r4Ack.release());
    await r4Saved(window);
    const first = await readR4Record(window, data.first.pageId);
    const second = await readR4Record(window, data.second.pageId);
    expect(first.page.title).toBe("R4 first ACK held");
    expect(JSON.stringify(first.page.doc)).toContain(
      "later input while ACK is held",
    );
    expect(second.page.title).toBe("R4 Beta");
    expect(JSON.stringify(second.page.doc)).toContain("beta original body");
    const requests = await app.evaluate(
      () => (globalThis as any).r4Ack.requests,
    );
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (operation: any) => operation.pageId === data.first.pageId,
      ),
    ).toBe(true);
    expect(requests[0].sessionId).toBe(requests[1].sessionId);
    expect(requests[1].seq).toBeGreaterThan(requests[0].seq);
    expect(requests[1].revision).toBe(requests[0].revision + 1);
  } finally {
    await disposeR4(data, app);
  }
});

test("lost post-COMMIT ACK resolves from receipt without duplicate application and protects normal close and reload", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    await openR4Database(window);
    await openR4Record(window);
    await r4Saved(window);
    const original = await readR4Record(window, data.first.pageId);
    await app.evaluate(({ ipcMain }, pageId) => {
      const ipc = ipcMain as any,
        handler = ipc._invokeHandlers.get("folio:request");
      const capture: any = ((globalThis as any).r4LostAck = {
        commits: [],
        resolves: 0,
      });
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await handler(event, request);
        if (request.type === "save:resolve") capture.resolves++;
        if (
          request.type === "save:commit" &&
          request.operation.pageId === pageId
        ) {
          capture.commits.push(request.operation);
          if (capture.commits.length === 1) {
            capture.operation = request.operation;
            capture.result = result;
            throw new Error("R4 synthetic ACK lost after COMMIT");
          }
        }
        return result;
      });
    }, data.first.pageId);
    await window
      .getByLabel("レコードのタイトル")
      .fill("R4 committed without ACK");
    await expect(window.locator(".r3-record-save")).toHaveAttribute(
      "data-save-state",
      "unknown",
    );
    await expect(
      window.getByRole("button", { name: "保存を再試行" }),
    ).toHaveCount(0);
    await window.getByRole("button", { name: "レコードを閉じる" }).click();
    await openR4Record(window, "R4 committed without ACK");
    await expect(window.getByLabel("レコードのタイトル")).toHaveValue(
      "R4 committed without ACK",
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).r4PreventedUnload))
      .toBe(1);
    await expect(window.locator(".r3-record-page")).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.reload(),
    );
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).r4PreventedUnload))
      .toBe(2);
    await expect(window.getByLabel("レコードのタイトル")).toHaveValue(
      "R4 committed without ACK",
    );
    const beforeResolve = await readR4Record(window, data.first.pageId);
    expect(beforeResolve.page.revision).toBe(original.page.revision + 1);
    await window
      .locator(".r3-record-page")
      .getByRole("button", { name: "保存結果を確認", exact: true })
      .click();
    await r4Saved(window);
    const capture = await app.evaluate(() => ({
      commits: (globalThis as any).r4LostAck.commits,
      resolves: (globalThis as any).r4LostAck.resolves,
      operation: (globalThis as any).r4LostAck.operation,
    }));
    expect(capture.commits).toHaveLength(1);
    expect(capture.resolves).toBe(1);
    const duplicate = await window.evaluate(
      (operation) =>
        globalThis.window.folio.request<any>({
          type: "save:commit",
          operation,
        } as any),
      capture.operation,
    );
    expect(duplicate.status).toBe("applied");
    expect(duplicate.page.revision).toBe(beforeResolve.page.revision);
    const after = await readR4Record(window, data.first.pageId);
    expect(after.page.revision).toBe(beforeResolve.page.revision);
    expect(after.page.title).toBe("R4 committed without ACK");
  } finally {
    await disposeR4(data, app);
  }
});

test("incomplete numeric input survives close and reopen and blocks reload until completed", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    await openR4Database(window);
    await openR4Record(window);
    const numeric = window
      .locator(".r3-record-page")
      .getByLabel("見積", { exact: true });
    await numeric.fill("-");
    await window.getByRole("button", { name: "レコードを閉じる" }).click();
    await expect(
      window.getByLabel("見積 R4 Alpha", { exact: true }),
    ).toHaveValue("-");
    await openR4Record(window);
    await expect(numeric).toHaveValue("-");
    expect(
      (await readR4Record(window, data.first.pageId)).record.values.estimate,
    ).toBe(1);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.reload(),
    );
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).r4PreventedUnload))
      .toBe(1);
    await expect(numeric).toHaveValue("-");
    await numeric.fill("-4.5");
    await r4Saved(window);
    expect(
      (await readR4Record(window, data.first.pageId)).record.values.estimate,
    ).toBe(-4.5);
  } finally {
    await disposeR4(data, app);
  }
});
