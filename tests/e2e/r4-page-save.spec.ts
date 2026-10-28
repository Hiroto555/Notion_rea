import { test, expect, type ElectronApplication } from "@playwright/test";
import { disposeR4, launchR4, r4Data, r4Doc, r4Saved } from "./r4-fixture";

for (const phase of ["restore-ack", "post-restore-load"] as const) {
  test(`closing history while ${phase} is held keeps old content locked until the restored snapshot is installed`, async () => {
    const data = r4Data();
    let app: ElectronApplication | undefined;
    try {
      const running = await launchR4(data);
      app = running.app;
      const window = running.window;
      await expect(window.locator(".folio-editor")).toContainText("現在の本文");
      await r4Saved(window);
      const baseline = await window.evaluate(
        async (id) =>
          (
            await globalThis.window.folio.request<any>({ type: "load" })
          ).pages.find((page: any) => page.id === id),
        data.home.id,
      );
      await app.evaluate(({ ipcMain }, holdPhase) => {
        const ipc = ipcMain as any,
          original = ipc._invokeHandlers.get("folio:request");
        const gate: any = ((globalThis as any).r4Restore = { writes: [] });
        ipc.removeHandler("folio:request");
        ipc.handle("folio:request", async (event: any, request: any) => {
          if (request.type === "save:commit")
            gate.writes.push(request.operation);
          const result = await original(event, request);
          if (request.type === "restoreVersion") {
            gate.saved = result;
            if (holdPhase === "restore-ack")
              await new Promise<void>((release) => {
                gate.release = release;
              });
          } else if (
            request.type === "load" &&
            gate.saved &&
            !gate.loadHeld &&
            holdPhase === "post-restore-load"
          ) {
            gate.loadHeld = true;
            await new Promise<void>((release) => {
              gate.release = release;
            });
          }
          return result;
        });
      }, phase);
      await window.getByRole("button", { name: "ページメニュー" }).click();
      await window
        .getByRole("button", { name: "変更履歴", exact: true })
        .click();
      const history = window.getByRole("dialog", { name: "変更履歴" });
      await history
        .locator(".dialog-list > div")
        .filter({ hasText: "履歴の本文" })
        .getByRole("button", { name: "復元", exact: true })
        .click();
      await expect
        .poll(() =>
          app!.evaluate(() => typeof (globalThis as any).r4Restore.release),
        )
        .toBe("function");
      await history
        .getByRole("button", { name: "閉じる", exact: true })
        .click();
      await expect(history).toHaveCount(0);
      const body = window.locator(".folio-editor");
      await expect(body).toHaveAttribute("contenteditable", "false");
      await expect(
        window.getByLabel("ページタイトル", { exact: true }),
      ).toBeDisabled();
      await body.evaluate((element) => (element as HTMLElement).focus());
      await window.keyboard.type("must not overwrite restored content");
      expect(
        await app.evaluate(() => (globalThis as any).r4Restore.writes),
      ).toEqual([]);
      const committed = await app.evaluate(
        () => (globalThis as any).r4Restore.saved,
      );
      expect(JSON.stringify(committed.doc)).toContain("履歴の本文");
      expect(committed.revision).toBe(baseline.revision + 1);
      await app.evaluate(() => (globalThis as any).r4Restore.release());
      await expect(body).toHaveAttribute("contenteditable", "true");
      await expect(body).toContainText("履歴の本文");
      await expect(body).not.toContainText("現在の本文");
      await body.click();
      await window.keyboard.press("End");
      await window.keyboard.type(" after restore");
      await r4Saved(window);
      const stored = await window.evaluate(async (id) => {
        const state = await globalThis.window.folio.request<any>({
          type: "load",
        });
        return state.pages.find((page: any) => page.id === id);
      }, data.home.id);
      expect(JSON.stringify(stored.doc)).toContain("履歴の本文");
      expect(JSON.stringify(stored.doc)).toContain("after restore");
      expect(JSON.stringify(stored.doc)).not.toContain("現在の本文");
      expect(JSON.stringify(stored.doc)).not.toContain("must not overwrite");
    } finally {
      await disposeR4(data, app);
    }
  });
}

test("ordinary Page refresh cannot pair an old Editor document with an external revision", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    const baseline = await window.evaluate(
      async (id) =>
        (
          await globalThis.window.folio.request<any>({ type: "load" })
        ).pages.find((page: any) => page.id === id),
      data.home.id,
    );
    const external = await window.evaluate(
      ({ id, revision, doc }) =>
        globalThis.window.folio.request<any>({
          type: "update",
          id,
          revision,
          patch: { doc },
        }),
      {
        id: data.home.id,
        revision: baseline.revision,
        doc: r4Doc("external ordinary Page body"),
      },
    );
    await window.getByRole("button", { name: /^ゴミ箱 / }).click();
    const trash = window.getByRole("dialog", { name: "ゴミ箱" });
    await trash
      .locator(".dialog-list > div")
      .filter({ hasText: "R4 Refresh Trigger" })
      .getByRole("button", { name: "復元", exact: true })
      .click();
    await expect(
      window.getByRole("status").filter({ hasText: "ページを復元しました" }),
    ).toBeVisible();
    await trash.getByRole("button", { name: "閉じる", exact: true }).click();
    await expect(window.locator(".folio-editor")).toContainText("現在の本文");
    await window
      .locator(".folio-editor")
      .fill("local input from old installed content");
    await expect(window.getByRole("alert")).toContainText("競合");
    const saved = await window.evaluate(
      async (id) =>
        (
          await globalThis.window.folio.request<any>({ type: "load" })
        ).pages.find((page: any) => page.id === id),
      data.home.id,
    );
    expect(saved.revision).toBe(external.revision);
    expect(saved.doc).toEqual(external.doc);
    await expect(window.locator(".folio-editor")).toContainText(
      "local input from old installed content",
    );
  } finally {
    await disposeR4(data, app);
  }
});

test("ordinary Page delayed ACK keeps later input and does not replace another selected Page", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    await app.evaluate(({ ipcMain }, pageId) => {
      const ipc = ipcMain as any,
        original = ipc._invokeHandlers.get("folio:request");
      const gate: any = ((globalThis as any).r4PageAck = {
        operations: [],
        held: false,
      });
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await original(event, request);
        if (
          request.type === "save:commit" &&
          request.operation.pageId === pageId
        ) {
          gate.operations.push(request.operation);
          if (!gate.held) {
            gate.held = true;
            await new Promise<void>((release) => {
              gate.release = release;
            });
          }
        }
        return result;
      });
    }, data.home.id);
    await window
      .getByLabel("ページタイトル", { exact: true })
      .fill("R4 Page ACK held");
    await expect
      .poll(() =>
        app!.evaluate(() => typeof (globalThis as any).r4PageAck.release),
      )
      .toBe("function");
    await window.locator(".folio-editor").fill("later ordinary Page body");
    await window.getByTitle("R4 Tasks", { exact: true }).click();
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("R4 Tasks");
    await app.evaluate(() => (globalThis as any).r4PageAck.release());
    await r4Saved(window);
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("R4 Tasks");
    await window.getByTitle("R4 Page ACK held", { exact: true }).click();
    await expect(window.locator(".folio-editor")).toContainText(
      "later ordinary Page body",
    );
    const saved = await window.evaluate(
      async (id) =>
        (
          await globalThis.window.folio.request<any>({ type: "load" })
        ).pages.find((page: any) => page.id === id),
      data.home.id,
    );
    expect(saved.title).toBe("R4 Page ACK held");
    expect(JSON.stringify(saved.doc)).toContain("later ordinary Page body");
    const operations = await app.evaluate(
      () => (globalThis as any).r4PageAck.operations,
    );
    expect(operations.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set(operations.map((operation: any) => operation.sessionId)).size,
    ).toBe(1);
    for (let i = 1; i < operations.length; i++) {
      expect(operations[i].revision).toBe(operations[i - 1].revision + 1);
      expect(operations[i].seq).toBeGreaterThan(operations[i - 1].seq);
    }
  } finally {
    await disposeR4(data, app);
  }
});
