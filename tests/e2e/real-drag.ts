import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Each attempt owns its capture listeners and mouse press. The target is a real
// user-visible control; no synthetic drag/drop events are dispatched.
export async function beginRealDrag(page: Page, source: Locator) {
  const id = randomUUID();
  await source.hover();
  const rect = await source.boundingBox();
  if (!rect) throw Error("drag source not visible");
  await source.evaluate((element, attempt) => {
    const g = globalThis as any;
    g.dragAttemptCleanup?.();
    g.pointerDragStarted = false; g.pointerDragEnded = false; g.pointerDropped = false;
    const entries: any[] = [];
    g.dragAttempt = { id: attempt, entries };
    const describe = (e: Element | null) => e && ({ tag: e.tagName, className: e.getAttribute("class"), label: e.getAttribute("aria-label"), text: e.textContent?.slice(0, 100), connected: e.isConnected });
    const bounds = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    entries.push({ type: "before", source: describe(element), rect: bounds(element), hit: describe(document.elementFromPoint(bounds(element).x + bounds(element).width / 2, bounds(element).y + bounds(element).height / 2)), focused: document.hasFocus(), active: describe(document.activeElement), scroll: { x: scrollX, y: scrollY } });
    const types = ["pointerdown", "mousedown", "pointermove", "mousemove", "dragstart", "dragover", "drop", "dragend", "mouseup"];
    const listen = (event: Event) => {
      const e = event as DragEvent; const target = e.target as Element;
      const start = event.type === "dragstart" && (target === element || element.contains(target));
      if (start) g.pointerDragStarted = true;
      if (g.pointerDragStarted && event.type === "drop") g.pointerDropped = true;
      if (g.pointerDragStarted && event.type === "dragend" && (target === element || element.contains(target))) g.pointerDragEnded = true;
      entries.push({ type: event.type, time: performance.now(), target: describe(target), hit: describe(document.elementFromPoint(e.clientX, e.clientY)), x: e.clientX, y: e.clientY, sourceConnected: element.isConnected, active: describe(document.activeElement), focused: document.hasFocus(), types: [...(e.dataTransfer?.types ?? [])], pageId: event.type === "drop" ? e.dataTransfer?.getData("application/x-folio-page") : undefined });
    };
    types.forEach(type => document.addEventListener(type, listen, true));
    g.dragAttemptCleanup = () => { types.forEach(type => document.removeEventListener(type, listen, true)); delete g.dragAttemptCleanup; };
  }, id);
  const cleanup = async () => {
    await page.mouse.up().catch(() => {});
    await page.evaluate(() => (globalThis as any).dragAttemptCleanup?.()).catch(() => {});
  };
  try {
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 40, rect.y + rect.height / 2, { steps: 10 });
    await expect.poll(() => page.evaluate(() => (globalThis as any).pointerDragStarted)).toBe(true);
    return { id, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
export async function realDrag(page: Page, source: Locator, target: Locator) {
  const attempt = await beginRealDrag(page, source);
  try {
    await target.evaluate(element => { const r = element.getBoundingClientRect(); (globalThis as any).dragAttempt.target = { tag: element.tagName, className: element.getAttribute("class"), text: element.textContent?.slice(0, 100), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, connected: element.isConnected }; });
    await target.hover(); await target.hover(); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (globalThis as any).pointerDropped)).toBe(true);
  } finally { await attempt.cleanup(); }
}
