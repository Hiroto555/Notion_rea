import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  disposeR7,
  launchR7,
  openR7Database,
  r7Data,
  r7Saved,
} from "./r7-fixture";

test("board cards expose a readable excerpt and open the underlying record", async () => {
  const data = r7Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR7(data);
    app = running.app;
    const window = running.window;
    await openR7Database(window);

    const inProgress = window.getByRole("region", {
      name: "グループ 進行中",
      exact: true,
    });
    const notStarted = window.getByRole("region", {
      name: "グループ 未着手",
      exact: true,
    });
    await expect(inProgress).toBeVisible();
    await expect(notStarted).toBeVisible();
    await expect(inProgress).toContainText("Alpha task");
    await expect(inProgress).toContainText("Alpha body text");
    await expect(notStarted).toContainText("Beta task");
    await expect(notStarted).toContainText("Beta body text");

    await inProgress
      .getByRole("button", { name: "開く Alpha task", exact: true })
      .click();
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("Alpha task");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "Alpha body text",
    );
    await expect(
      window.getByRole("button", { name: "レコードを閉じる", exact: true }),
    ).toBeVisible();
    const body = window.locator(".r3-record-page .folio-editor");
    await body.fill("書き直した日本語の本文抜粋");
    await r7Saved(window);
    await window.getByRole("button", {name: "レコードを閉じる", exact: true}).click();
    await expect(inProgress).toContainText("書き直した日本語の本文抜粋");
  } finally {
    await disposeR7(data, app);
  }
});
