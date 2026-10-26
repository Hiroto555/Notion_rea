import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/persistence/store";
import { queryRows, monthDays } from "../src/database/model";
import { editBlocks } from "../src/editor/blocks";
import { emptyDatabase, requestSchema, type Doc } from "../src/shared/types";
const roots: string[] = [],
  stores: Store[] = [];
function make() {
  const root = mkdtempSync(join(process.cwd(), "output/test-store-"));
  roots.push(root);
  const s = new Store(join(root, "test.sqlite"));
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0))
    try {
      s.close();
    } catch {}
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe("SQLite integrity", () => {
  it("persists Japanese/English, hierarchy, preferences across reopen", () => {
    const s = make(),
      p = s.create(null, "page", "日本語 English"),
      child = s.create(p.id);
    s.update(child.id, 0, {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "長い文章 mixed 日本語 ".repeat(2000) },
            ],
          },
        ],
      },
    });
    s.handle({ type: "setting", key: "activePage", value: child.id });
    s.close();
    const reopened = new Store(s.path);
    stores.push(reopened);
    expect(reopened.load().settings.activePage).toBe(child.id);
    expect(reopened.get(child.id).parentId).toBe(p.id);
    expect(
      (reopened.handle({ type: "search", query: "mixed 日本語" }) as unknown[])
        .length,
    ).toBe(1);
    expect(
      reopened.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    ).toBe("ok");
  });
  it("handles 150 nested pages and refuses cycles without partial mutation", () => {
    const s = make();
    let parent: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) {
      const p = s.create(parent, "page", "Level " + i);
      ids.push(p.id);
      parent = p.id;
    }
    expect(s.descendants(ids[0]).size).toBe(150);
    expect(() => s.move(ids[0], ids[149], null)).toThrow(/子孫/);
    expect(s.get(ids[0]).parentId).toBe(null);
    s.move(ids[149], null, ids[0]);
    expect(s.get(ids[149]).position).toBe(0);
  });
  it("duplicates full subtrees with new IDs and preserves originals", () => {
    const s = make(),
      p = s.create(null),
      c = s.create(p.id),
      g = s.create(c.id);
    const copy = s.duplicate(p.id);
    expect(s.descendants(copy.id).size).toBe(3);
    expect(s.pages().length).toBe(6);
    expect(s.get(g.id).parentId).toBe(c.id);
  });
  it("rejects stale writes and restores version history", () => {
    const s = make(),
      p = s.create(null);
    const doc: Doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
      ],
    };
    s.update(p.id, 0, { doc });
    s.update(p.id, 1, {
      doc: {
        ...doc,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "after" }] },
        ],
      },
    });
    expect(() => s.update(p.id, 0, { title: "stale" })).toThrow(/競合/);
    const version = s
      .versions(p.id)
      .find((v) => v.doc.content?.[0].content?.[0].text === "before")!;
    s.handle({ type: "restoreVersion", id: p.id, versionId: version.id });
    expect(s.get(p.id).doc).toEqual(doc);
  });
  it("moves, trashes, and restores subtrees transactionally", () => {
    const s = make(),
      a = s.create(null),
      b = s.create(null),
      c = s.create(a.id);
    s.move(c.id, b.id, null);
    expect(s.get(c.id).parentId).toBe(b.id);
    s.trash(b.id);
    expect(s.get(c.id).deletedAt).toBeTruthy();
    s.restore(b.id);
    expect(s.get(c.id).deletedAt).toBe(null);
  });
  it("backs up a 1000 block document into a valid independent SQLite file", () => {
    const s = make(),
      p = s.create(null);
    const content = Array.from({ length: 1000 }, (_, i) => ({
      type: "paragraph",
      content: [{ type: "text", text: `Block ${i} 日本語` }],
    }));
    s.update(p.id, 0, { doc: { type: "doc", content } });
    const file = join(roots.at(-1)!, "backup.sqlite");
    s.db.prepare("VACUUM INTO ?").run(file);
    const backup = new Store(file);
    stores.push(backup);
    expect(backup.get(p.id).doc.content).toHaveLength(1000);
    expect(
      backup.db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    ).toBe("ok");
  });
});
describe("block and database operations", () => {
  const nodes = ["a", "b", "c", "d"].map((text) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  }));
  const names = (ns: Doc[]) => ns.map((n) => n.content?.[0].text).join("");
  it("moves multiple blocks without losing contents", () => {
    expect(names(editBlocks(nodes, [1, 2], "move", 0))).toBe("bcad");
    expect(names(editBlocks(nodes, [0, 1], "move", 4))).toBe("cdab");
  });
  it("duplicates and deletes selections, retaining one empty paragraph", () => {
    expect(names(editBlocks(nodes, [0, 2], "duplicate"))).toBe("aabccd");
    expect(names(editBlocks(nodes, [1, 2], "delete"))).toBe("ad");
    expect(editBlocks(nodes, [0, 1, 2, 3], "delete")).toEqual([
      { type: "paragraph" },
    ]);
  });
  it("filters across typed properties and sorts numerically", () => {
    const db = {
      ...emptyDatabase(),
      rows: [
        { id: "a", title: "日本語 10", values: { cost: 10, status: "進行中" } },
        { id: "b", title: "English 2", values: { cost: 2, status: "進行中" } },
        { id: "c", title: "Other", values: { cost: 100, status: "完了" } },
      ],
      filter: "進行中",
      sort: "cost",
    };
    expect(queryRows(db).map((r) => r.id)).toEqual(["b", "a"]);
    db.sort = "-cost";
    expect(queryRows(db).map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("generates local calendar dates including leap years", () => {
    const days = monthDays("2024-02");
    expect(days).toHaveLength(42);
    expect(days).toContain("2024-02-29");
    expect(days[0]).toBe("2024-01-28");
  });
  it("rejects unapproved IPC operations and malformed records", () => {
    expect(
      requestSchema.safeParse({ type: "shell", command: "x" }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        type: "update",
        id: "x",
        revision: 0,
        patch: { parentId: "x" },
      }).success,
    ).toBe(false);
  });
});
it("restoring an individual child of a trashed parent makes it reachable", () => {
  const s = make(),
    p = s.create(null),
    c = s.create(p.id);
  s.trash(p.id);
  s.restore(c.id);
  expect(s.get(c.id).parentId).toBe(null);
  expect(s.get(p.id).deletedAt).toBeTruthy();
});
it("rejects arbitrary document node types before storage", () => {
  expect(
    requestSchema.safeParse({
      type: "update",
      id: "x",
      revision: 0,
      patch: { doc: { type: "doc", content: [{ type: "script" }] } },
    }).success,
  ).toBe(false);
});
