import { test, expect, saved } from "./next-round-fixture";
import { realDrag, beginRealDrag } from "./real-drag";
import { writeFileSync } from "node:fs";
import { observeDrag, dragEvidence } from "./drag-observer";

async function setup(s: any) {
  const ids = await s.window.evaluate(async () => {
    const create = (title: string, parentId: string | null = null) => window.folio.request<any>({ type: "create", parentId, kind: "page", title });
    const target = await create("Move Target"), source = await create("Move Source"), child = await create("Move Child", source.id);
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "移動前本文", marks: [{ type: "bold" }] }] }] };
    await window.folio.request({ type: "update", id: source.id, revision: 0, patch: { doc } });
    await window.folio.request({ type: "setting", key: "activePage", value: source.id });
    return { target: target.id, source: source.id, child: child.id, doc };
  });
  await s.window.reload(); await s.window.waitForSelector(".page-title");
  return ids;
}
async function load(s: any, ids: any) {
  return s.window.evaluate(async (ids: any) => {
    const pages = (await window.folio.request<any>({ type: "load" })).pages;
    return { source: pages.find((p: any) => p.id === ids.source), target: pages.find((p: any) => p.id === ids.target), child: pages.find((p: any) => p.id === ids.child), siblings: pages.filter((p: any) => p.parentId === ids.target).sort((a: any,b: any) => a.position-b.position).map((p: any)=>p.id) };
  }, ids);
}

test("S2 tree input: edited source becomes target child with stable identity", async ({ folio: s }, info) => {
  const ids = await setup(s), w = s.window;
  await w.locator(".folio-editor").click(); await w.keyboard.press("End"); await w.keyboard.insertText(" 保存"); await saved(s);
  const before = await load(s, ids);
  await observeDrag(s);
  try {
    const row = (label: string) => w.locator(".page-tree-row").filter({ has: w.locator(".page-tree-label", { hasText: label }) });
    await realDrag(w, row("Move Source"), row("Move Target"));
    await expect.poll(async () => (await load(s, ids)).source.parentId).toBe(ids.target);
    const after = await load(s, ids);
    expect(after.source.doc).toEqual(before.source.doc); expect(after.child.parentId).toBe(ids.source);
    expect(after.siblings).toContain(ids.source);
    await dragEvidence(s, info);
    await s.restart();
    const reopened = await load(s, ids); expect(reopened.source.parentId).toBe(ids.target);
    expect(reopened.source.doc).toEqual(before.source.doc); expect(reopened.child.parentId).toBe(ids.source); expect(reopened.siblings).toEqual(after.siblings);
  } finally { if (s.window === w) await dragEvidence(s, info); }
});

test("S2 menu F11: delayed load preserves local edit and page hierarchy through restart", async ({ folio: s }, info) => {
  let originalApp: typeof s.app | undefined, originalWindow: typeof s.window | undefined;
  let beforeRestart: unknown;
  const checkpoints: { time: number; stage: string }[] = [];
  const mark = (stage: string) => checkpoints.push({ time: Date.now(), stage });
  try {
    const ids = await setup(s), w = s.window;
    originalWindow = w;
    originalApp = s.app;
    await w.evaluate(() => {
      const journal: unknown[] = [];
      (globalThis as any).f11RendererJournal = journal;
      const clock = () => ({ time: Date.now(), monotonicMs: performance.now() });
      const recordState = () => {
        const state = document.querySelector(".save-state"), title = document.querySelector<HTMLInputElement>(".page-title");
        return { state: state?.getAttribute("data-state"), text: state?.textContent?.trim(), title: title?.value };
      };
      let lastState = "";
      const captureState = () => {
        const state = recordState(), serialized = JSON.stringify(state);
        if (serialized !== lastState) { lastState = serialized; journal.push({ ...clock(), kind: "save-state", ...state }); }
      };
      for (const type of ["beforeinput", "input", "change", "compositionstart", "compositionend"]) {
        document.addEventListener(type, (event) => {
          const target = event.target as HTMLElement | null;
          if (!target?.closest(".page-title, .folio-editor")) return;
          const input = event as InputEvent;
          journal.push({ ...clock(), kind: "input-event", type, target: target.matches(".page-title") ? "title" : "editor",
            value: target instanceof HTMLInputElement ? target.value : undefined,
            inputType: input.inputType, data: input.data, isComposing: input.isComposing, ...recordState() });
        }, true);
      }
      new MutationObserver(captureState).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-state"] });
      captureState();
    });
    await s.app.evaluate(({ ipcMain }, ids) => {
      const ipc = ipcMain as any, original = ipc._invokeHandlers.get("folio:request"); let armed = false, serial = 0;
      const journal: unknown[] = [];
      (globalThis as any).moveJournal = journal;
      const clock = () => ({ time: Date.now(), monotonicMs: performance.now() });
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, req: any) => {
        if (!["move", "load", "update", "save:commit"].includes(req.type)) return original(event, req);
        const call = ++serial;
        const operation = req.operation ?? req;
        journal.push({ ...clock(), call, type: req.type, stage: "request", id: req.id ?? operation.pageId, parentId: req.parentId,
          beforeId: req.beforeId, revision: operation.revision, patch: operation.patch });
        try {
          const result = await original(event, req);
          const pages = req.type === "load" ? result?.pages?.filter((p: any) => [ids.source, ids.target, ids.child].includes(p.id)).map((p: any) => ({ id: p.id, parentId: p.parentId, title: p.title, revision: p.revision })) : undefined;
          const saved = result?.page ?? result;
          journal.push({ ...clock(), call, type: req.type, stage: "store-result", id: saved?.id, revision: saved?.revision, title: saved?.title, pages });
          if (req.type === "move") armed = true;
          else if (req.type === "load" && armed) {
            armed = false;
            (globalThis as any).heldLoad = true;
            journal.push({ ...clock(), call, type: req.type, stage: "held" });
            await new Promise<void>(r => (globalThis as any).releaseLoad = r);
            journal.push({ ...clock(), call, type: req.type, stage: "released" });
          }
          journal.push({ ...clock(), call, type: req.type, stage: "ack" });
          return result;
        } catch (error) {
          journal.push({ ...clock(), call, type: req.type, stage: "error", message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
    }, ids);
    mark("instrumented");
    await w.getByLabel("ページメニュー", { exact: true }).click();
    await w.getByRole("button", { name: "移動する", exact: true }).click();
    await w.locator(".dialog-list").getByRole("button", { name: /Move Target/ }).click();
    await expect.poll(() => s.app.evaluate(() => (globalThis as any).heldLoad)).toBe(true);
    mark("load held");
    await w.getByLabel("ページタイトル", { exact: true }).fill("Move Source edited");
    mark("title filled");
    await s.app.evaluate(() => (globalThis as any).releaseLoad());
    mark("load release requested");
    await saved(s);
    mark("saved observed");
    const after = await load(s, ids);
    expect(after.source.id).toBe(ids.source); expect(after.source.title).toBe("Move Source edited");
    expect(after.source.parentId).toBe(ids.target); expect(after.source.doc).toEqual(ids.doc);
    expect(after.child.parentId).toBe(ids.source); expect(after.siblings).toContain(ids.source);
    beforeRestart = {
      ipc: await s.app.evaluate(() => (globalThis as any).moveJournal),
      renderer: await w.evaluate(() => (globalThis as any).f11RendererJournal),
    };
    mark("before restart");
    await s.restart();
    const reopened = await load(s, ids);
    expect(reopened.source.title).toBe(after.source.title); expect(reopened.source.parentId).toBe(ids.target);
    expect(reopened.source.doc).toEqual(ids.doc); expect(reopened.child.parentId).toBe(ids.source); expect(reopened.siblings).toEqual(after.siblings);
  } finally {
    await originalApp?.evaluate(() => (globalThis as any).releaseLoad?.()).catch(() => {});
    const ipc = await originalApp?.evaluate(() => (globalThis as any).moveJournal).catch((error: unknown) => ({ unavailable: String(error) }));
    const renderer = await originalWindow?.evaluate(() => (globalThis as any).f11RendererJournal).catch((error: unknown) => ({ unavailable: String(error) }));
    writeFileSync(info.outputPath("f11-journal.json"), JSON.stringify({ checkpoints, beforeRestart, final: { ipc, renderer } }, null, 2));
  }
});

test("S2 tree order, root, cancellation and cycle rejection", async ({ folio: s }, info) => {
  const ids = await setup(s), w = s.window;
  const sibling = await w.evaluate(async id => (await window.folio.request<any>({ type: "create", parentId: id, kind: "page", title: "Move Sibling" })).id, ids.target);
  await w.reload(); await w.waitForSelector(".page-title"); await observeDrag(s);
  const row = (label: string) => w.locator(".page-tree-row").filter({ has: w.locator(".page-tree-label", { hasText: label }) });
  try {
    await realDrag(w, row("Move Source"), row("Move Target"));
    await expect.poll(async () => (await load(s, ids)).source.parentId).toBe(ids.target);
    await expect(row("Move Sibling")).toBeVisible();
    const attempt = await beginRealDrag(w, row("Move Source"));
    try {
      await row("Move Sibling").hover({ position: { x: 10, y: 2 } });
      await row("Move Sibling").hover({ position: { x: 10, y: 2 } });
      await w.mouse.up();
    } finally { await attempt.cleanup(); }
    await expect.poll(async () => (await load(s, ids)).siblings).toEqual([ids.source, sibling]);
    const cancelled = await beginRealDrag(w, row("Move Source"));
    try { await w.locator(".new-root").hover(); await w.keyboard.press("Escape"); await w.mouse.up(); }
    finally { await cancelled.cleanup(); }
    expect((await load(s, ids)).source.parentId).toBe(ids.target);
    await realDrag(w, row("Move Source"), w.locator(".new-root"));
    await expect.poll(async () => (await load(s, ids)).source.parentId).toBeNull();
    // Cycles are rejected by the same move IPC used by both UI entry points.
    for (const parentId of [ids.source, ids.child]) {
      expect(await w.evaluate(async ({ id, parentId }) => {
        try { await window.folio.request({ type: "move", id, parentId, beforeId: null }); return false; } catch { return true; }
      }, { id: ids.source, parentId })).toBe(true);
    }
    const final = await load(s, ids); expect(final.source.parentId).toBeNull(); expect(final.child.parentId).toBe(ids.source);
    await dragEvidence(s, info);
    await s.restart(); const reopened = await load(s, ids); expect(reopened.source.parentId).toBeNull(); expect(reopened.child.parentId).toBe(ids.source);
  } finally { if (s.window === w) await dragEvidence(s, info); }
});
