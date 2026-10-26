import { expect, type Locator, type Page } from "@playwright/test";
// Begin native dragging while still over the source before target auto-scroll.
// Two destination moves give Chromium an actual dragover before mouse release.
export async function realDrag(page: Page, source: Locator, target: Locator) {
  await page.evaluate(() => {
    (globalThis as any).pointerDragStarted = false;
    (globalThis as any).pointerDropped = false;
    document.addEventListener(
      "drop",
      () => {
        (globalThis as any).pointerDropped = true;
      },
      { once: true },
    );
    document.addEventListener(
      "dragstart",
      () => {
        (globalThis as any).pointerDragStarted = true;
      },
      { once: true },
    );
  });
  await source.hover();
  const rect = await source.boundingBox();
  if (!rect) throw Error("drag source not visible");
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width / 2 + 40,
    rect.y + rect.height / 2,
    { steps: 10 },
  );
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).pointerDragStarted))
    .toBe(true);
  await target.hover();
  await target.hover();
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).pointerDropped))
    .toBe(true);
}
