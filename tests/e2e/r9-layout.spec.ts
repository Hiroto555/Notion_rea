import { expect, test, type ElectronApplication } from "@playwright/test";
import { r4Data, launchR4, disposeR4, r4Saved } from "./r4-fixture";
test("W3 a 20-column table scrolls inside its own frame at narrow width and keeps adjacent text visible", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const w = running.window;
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(960, 900),
    );
    await w.locator(".folio-editor").evaluate((el) => {
      const e = (el as any).editor;
      e.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "隣の文章は横に動かない" }],
          },
          { type: "paragraph" },
        ],
      });
      e.commands.focus("end");
      e.commands.insertSimpleTable(3, 20);
    });
    await r4Saved(w);
    await expect(w.locator(".folio-editor th")).toHaveCount(20);
    const wrapper = w.locator(".folio-editor .tableWrapper");
    expect(
      await wrapper.evaluate((el) => el.scrollWidth > el.clientWidth + 100),
    ).toBe(true);
    const before = await w.locator(".folio-editor > p").first().boundingBox();
    await wrapper.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    expect(await wrapper.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    const after = await w.locator(".folio-editor > p").first().boundingBox();
    expect(after?.x).toBe(before?.x);
    expect(
      await w
        .locator(".document-scroll")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(2);
  } finally {
    await disposeR4(data, app);
  }
});
