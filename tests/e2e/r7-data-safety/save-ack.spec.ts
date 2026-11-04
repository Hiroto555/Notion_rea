import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  disposeR4,
  launchR4,
  openR4Database,
  openR4Record,
  r4Data,
  r4Saved,
  readR4Record,
} from "../r4-fixture";
import {
  gateR7Save,
  r7WaitForHeldSave,
  readR7SaveGate,
} from "./r7-fixture";

test("R7 delayed save ACK retains later input and never resends the held operation", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    await openR4Database(window);
    await openR4Record(window);
    await r4Saved(window);
    await gateR7Save(app, data.first.pageId, "held");
    await window
      .getByLabel("レコードのタイトル", { exact: true })
      .fill("R7 保留タイトル");
    await r7WaitForHeldSave(app);
    await window
      .locator(".r3-record-page .folio-editor")
      .fill("R7 保留中に入力した本文");
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await openR4Record(window, "R4 Beta");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "beta original body",
    );
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await openR4Record(window, "R7 保留タイトル");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "R7 保留中に入力した本文",
    );
    await app.evaluate(() => (globalThis as any).r7SaveGate.release());
    await r4Saved(window);

    const gate = await readR7SaveGate(app);
    expect(gate.commits).toHaveLength(2);
    expect(
      new Set(gate.commits.map((operation: any) => operation.operationId)).size,
    ).toBe(2);
    expect(
      gate.commits.filter(
        (operation: any) =>
          operation.operationId === gate.operation.operationId,
      ),
    ).toHaveLength(1);
    expect(
      new Set(gate.commits.map((operation: any) => operation.sessionId)).size,
    ).toBe(1);
    expect(gate.commits[1].seq).toBeGreaterThan(gate.commits[0].seq);
    expect(gate.commits[1].revision).toBe(gate.commits[0].revision + 1);

    const first = await readR4Record(window, data.first.pageId);
    expect(first.page.title).toBe("R7 保留タイトル");
    expect(JSON.stringify(first.page.doc)).toContain(
      "R7 保留中に入力した本文",
    );
    const second = await readR4Record(window, data.second.pageId);
    expect(second.page.title).toBe("R4 Beta");
    expect(JSON.stringify(second.page.doc)).toContain("beta original body");
  } finally {
    await disposeR4(data, app);
  }
});

test("R7 unknown save ACK resolves from the receipt once without resending or duplicating the commit", async () => {
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
    await gateR7Save(app, data.first.pageId, "lost");
    await window
      .getByLabel("レコードのタイトル", { exact: true })
      .fill("R7 不明な保存");
    await expect(window.locator(".r3-record-save")).toHaveAttribute(
      "data-save-state",
      "unknown",
    );
    await expect(
      window.getByRole("button", { name: "保存を再試行", exact: true }),
    ).toHaveCount(0);

    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await openR4Record(window, "R7 不明な保存");
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("R7 不明な保存");

    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).r4PreventedUnload))
      .toBe(1);
    await expect(window.locator(".r3-record-page")).toBeVisible();

    const beforeResolve = await readR4Record(window, data.first.pageId);
    expect(beforeResolve.page.revision).toBe(original.page.revision + 1);
    expect(beforeResolve.page.title).toBe("R7 不明な保存");
    await window
      .locator(".r3-record-page")
      .getByRole("button", { name: "保存結果を確認", exact: true })
      .click();
    await r4Saved(window);

    const gate = await readR7SaveGate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.resolves).toEqual([gate.operation]);
    expect(gate.results[0].status).toBe("applied");
    const after = await readR4Record(window, data.first.pageId);
    expect(after.page.revision).toBe(beforeResolve.page.revision);
    expect(after.page.title).toBe("R7 不明な保存");

    const duplicate = await window.evaluate(
      (operation) =>
        globalThis.window.folio.request<any>({
          type: "save:commit",
          operation,
        }),
      gate.operation,
    );
    expect(duplicate.status).toBe("applied");
    expect(duplicate.page.revision).toBe(beforeResolve.page.revision);
    const unchanged = await readR4Record(window, data.first.pageId);
    expect(unchanged.page.revision).toBe(beforeResolve.page.revision);
    expect(unchanged.page.title).toBe("R7 不明な保存");
  } finally {
    await disposeR4(data, app);
  }
});
