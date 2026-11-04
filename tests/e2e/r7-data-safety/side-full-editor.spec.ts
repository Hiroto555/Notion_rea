import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  disposeR4,
  launchR4,
  openR4Database,
  openR4Record,
  r4Data,
  r4Saved,
} from "../r4-fixture";

test("R7 side/full keeps the same Editor instance, text selection and Undo history", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const window = running.window;
    await openR4Database(window);
    await openR4Record(window);
    const body = window.locator(".r3-record-page .folio-editor");
    await expect(body).toBeVisible();
    await body.fill("R7 サイドピークの本文");
    await r4Saved(window);
    await body.evaluate((element) => {
      (globalThis as any).r7Editor = (element as any).editor;
    });
    const selection = await body.evaluate((element) => {
      const editor = (element as any).editor;
      editor.commands.setTextSelection({ from: 1, to: 6 });
      return {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      };
    });
    expect(selection.to).toBeGreaterThan(selection.from);

    await window
      .getByRole("button", { name: "全画面で開く", exact: true })
      .click();
    await expect(window.locator(".r3-record-page")).toHaveAttribute(
      "data-record-mode",
      "full",
    );
    expect(
      await body.evaluate(
        (element) =>
          (element as any).editor === (globalThis as any).r7Editor,
      ),
    ).toBe(true);
    expect(
      await body.evaluate((element) => {
        const current = (element as any).editor.state.selection;
        return { from: current.from, to: current.to };
      }),
    ).toEqual(selection);

    await window
      .getByRole("button", { name: "サイドピークで開く", exact: true })
      .click();
    await expect(window.locator(".r3-record-page")).toHaveAttribute(
      "data-record-mode",
      "side",
    );
    expect(
      await body.evaluate(
        (element) =>
          (element as any).editor === (globalThis as any).r7Editor,
      ),
    ).toBe(true);
    expect(
      await body.evaluate((element) => {
        const current = (element as any).editor.state.selection;
        return { from: current.from, to: current.to };
      }),
    ).toEqual(selection);

    await body.focus();
    await window.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    await expect(body).toContainText("alpha original body");
    await r4Saved(window);
  } finally {
    await disposeR4(data, app);
  }
});
