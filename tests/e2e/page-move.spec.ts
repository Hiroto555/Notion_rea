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
  const ids = await setup(s), w = s.window;
  await s.app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any, original = ipc._invokeHandlers.get("folio:request"); let armed = false;
    (globalThis as any).moveJournal = [];
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, req: any) => {
      (globalThis as any).moveJournal.push({ type: req.type, id: req.id, parentId: req.parentId, stage: "start" });
      const result = await original(event, req);
      (globalThis as any).moveJournal.push({ type: req.type, stage: "ack" });
      if (req.type === "move") armed = true;
      else if (req.type === "load" && armed) { armed = false; (globalThis as any).heldLoad = true; await new Promise<void>(r => (globalThis as any).releaseLoad = r); }
      return result;
    });
  });
  try {
    await w.getByLabel("ページメニュー", { exact: true }).click();
    await w.getByRole("button", { name: "移動する", exact: true }).click();
    await w.locator(".dialog-list").getByRole("button", { name: /Move Target/ }).click();
    await expect.poll(() => s.app.evaluate(() => (globalThis as any).heldLoad)).toBe(true);
    await w.getByLabel("ページタイトル", { exact: true }).fill("Move Source edited");
    await s.app.evaluate(() => (globalThis as any).releaseLoad());
    await saved(s);
    const after = await load(s, ids);
    expect(after.source.id).toBe(ids.source); expect(after.source.title).toBe("Move Source edited");
    expect(after.source.parentId).toBe(ids.target); expect(after.source.doc).toEqual(ids.doc);
    expect(after.child.parentId).toBe(ids.source); expect(after.siblings).toContain(ids.source);
    writeFileSync(info.outputPath("move-journal.json"), JSON.stringify(await s.app.evaluate(() => (globalThis as any).moveJournal), null, 2));
    await s.restart();
    const reopened = await load(s, ids);
    expect(reopened.source.title).toBe(after.source.title); expect(reopened.source.parentId).toBe(ids.target);
    expect(reopened.source.doc).toEqual(ids.doc); expect(reopened.child.parentId).toBe(ids.source); expect(reopened.siblings).toEqual(after.siblings);
  } finally { await s.app.evaluate(() => (globalThis as any).releaseLoad?.()).catch(() => {}); }
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
