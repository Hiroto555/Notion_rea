import type { Session } from "./next-round-fixture";
import type { TestInfo } from "@playwright/test";
import { writeFileSync } from "node:fs";
// Only called in synthetic, dedicated test workspaces. No product telemetry.
export async function observeDrag(s: Pick<Session, "app" | "window">) {
  await s.app.evaluate(({ ipcMain }) => {
    const m = ipcMain as any,
      handler = m._invokeHandlers.get("folio:request");
    (globalThis as any).dragACK = [];
    m.removeHandler("folio:request");
    m.handle("folio:request", async (e: any, r: any) => {
      if (["move", "load", "update", "save:commit"].includes(r.type))
        (globalThis as any).dragACK.push({
          type: r.type,
          id: r.id ?? r.operation?.pageId,
          parentId: r.parentId,
          stage: "start",
          time: Date.now(),
        });
      const result = await handler(e, r);
      if (["move", "load", "update", "save:commit"].includes(r.type))
        (globalThis as any).dragACK.push({
          type: r.type,
          id: r.id ?? r.operation?.pageId,
          parentId: r.parentId,
          stage: "ack",
          time: Date.now(),
        });
      if (
        r.type === "update" ||
        (r.type === "save:commit" && result.status === "applied")
      )
        (globalThis as any).dragACK.push({
          id: r.id ?? r.operation?.pageId,
          revision: (result.page ?? result).revision,
          doc: (result.page ?? result).doc,
          database: (result.page ?? result).database,
          time: Date.now(),
        });
      return result;
    });
  });
  await s.window.evaluate(() => {
    const g = globalThis as any;
    g.dragJournal = [];
    const editor = (document.querySelector(".folio-editor") as any)?.editor;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const state = () => ({
      doc: editor?.getJSON(),
      selection: editor?.state.selection.toJSON(),
      selected: [...document.querySelectorAll(".block-handle.selected")].map(
        (el) => el.getAttribute("aria-label"),
      ),
      scroll: document.querySelector(".document-scroll")?.scrollTop,
      handles: [...document.querySelectorAll(".block-handle")].map((el) => ({
        name: el.getAttribute("aria-label"),
        ...rect(el),
      })),
    });
    g.dragJournal.push({ type: "before", ...state() });
    for (const type of [
      "mousedown",
      "mouseup",
      "dragstart",
      "dragover",
      "drop",
      "dragend",
      "keydown",
    ])
      document.addEventListener(
        type,
        (e: Event) => {
          if (type === "keydown" && (e as KeyboardEvent).key !== "Escape")
            return;
          const m = e as MouseEvent,
            t = e.target as Element;
          const entry = {
            type,
            time: performance.now(),
            x: m.clientX,
            y: m.clientY,
            target:
              t?.closest("button")?.getAttribute("aria-label") || t?.tagName,
            defaultPrevented: e.defaultPrevented,
            types: [...((e as DragEvent).dataTransfer?.types ?? [])],
            ...state(),
          };
          g.dragJournal.push(entry);
          queueMicrotask(() => (entry.defaultPrevented = e.defaultPrevented));
        },
        true,
      );
    for (const type of ["dragstart", "dragover", "drop", "dragend"])
      document.addEventListener(
        type,
        (e) =>
          g.dragJournal.push({
            type: type + "-bubble",
            defaultPrevented: e.defaultPrevented,
          }),
        false,
      );
    editor?.on("transaction", ({ transaction }: any) => {
      g.dragJournal.push({
        type: "transaction",
        docChanged: transaction.docChanged,
        ...state(),
      });
    });
  });
}
export async function dragEvidence(
  s: Pick<Session, "app" | "window">,
  info: TestInfo,
) {
  const events = await s.window.evaluate(() => ({
    events: (globalThis as any).dragJournal,
    attempt: (globalThis as any).dragAttempt,
    after: (document.querySelector(".folio-editor") as any)?.editor.getJSON(),
  }));
  const ack = await s.app.evaluate(() => (globalThis as any).dragACK);
  writeFileSync(
    info.outputPath("drag-events.json"),
    JSON.stringify({ ...events, ack }, null, 2),
  );
}
export async function editorDoc(s: Pick<Session, "app" | "window">) {
  return s.window
    .locator(".folio-editor")
    .evaluate((el) => (el as any).editor.getJSON());
}
