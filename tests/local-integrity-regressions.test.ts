import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { prepareDatabaseCreation, type DatabaseOperationResult } from "../src/shared/database-operation";
import { type Page } from "../src/shared/types";

function fixture(registered = true) {
  const directory = mkdtempSync(join(tmpdir(), "folio-local-integrity-"));
  const path = join(directory, "workspace.sqlite");
  let current = new Store(path);
  let ownerId: string | undefined;
  let recordId: string | undefined;
  if (registered) {
    const result = current.handle({
      type: "database:commit",
      operation: prepareDatabaseCreation("Registered owner"),
    }) as DatabaseOperationResult;
    if (result.status !== "applied" || !result.page) throw new Error("Fixture database creation failed");
    ownerId = result.page.id;
    recordId = new RecordRepository(current).create(ownerId, "Retained record", { status: "未着手" }).pageId;
  }
  return {
    get store() { return current; }, ownerId, recordId,
    reopen() { current.close(); current = new Store(path); },
    dispose() { current.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function raw(store: Store, id: string) {
  return store.db.prepare("SELECT id,data,body FROM pages WHERE id=?").get(id);
}

function ownerAndRecord(f: ReturnType<typeof fixture>) {
  if (!f.ownerId || !f.recordId) return undefined;
  return {
    owner: raw(f.store, f.ownerId), record: raw(f.store, f.recordId),
    memberships: f.store.db.prepare("SELECT * FROM record_memberships ORDER BY page_id").all(),
    history: f.store.db.prepare("SELECT * FROM versions WHERE pageId IN (?,?) ORDER BY id").all(f.ownerId, f.recordId),
  };
}

function ordinarySiblings(f: ReturnType<typeof fixture>, parentId: string | null = null) {
  return f.store.pages().filter(page => page.parentId === parentId && page.id !== f.recordId);
}

function expectUniqueOrder(pages: Page[]) {
  const positions = pages.map(page => page.position);
  expect(positions.every(Number.isFinite)).toBe(true);
  expect(new Set(positions).size).toBe(positions.length);
}

function duplicate(store: Store, id: string) {
  return store.handle({ type: "duplicate", id }) as Page;
}

describe("local page integrity regressions", () => {
  it.each([false, true])("repeated duplication leaves create/move usable and survives reopen (registered=%s)", registered => {
    const f = fixture(registered);
    try {
      const original = f.store.create(null, "page", "Original");
      const next = f.store.create(null, "page", "Next sibling");
      const originalBytes = raw(f.store, original.id);
      const protectedBefore = ownerAndRecord(f);
      const copies = Array.from({ length: 12 }, () => duplicate(f.store, original.id));
      expect(new Set(copies.map(page => page.id)).size).toBe(12);
      for (const copy of copies) {
        expect(copy.position).toBeGreaterThan(original.position);
        expect(copy.position).toBeLessThan(next.position);
      }
      expectUniqueOrder(ordinarySiblings(f));
      const added = f.store.create(null, "page", "Created after copies");
      f.store.move(added.id, null, original.id);
      expect(f.store.get(added.id).position).toBeLessThan(f.store.get(original.id).position);
      expectUniqueOrder(ordinarySiblings(f));
      // Mixed record workspaces must not rewrite an unrelated owner or record.
      if (registered) {
        expect(raw(f.store, original.id)).toEqual(originalBytes);
        expect(ownerAndRecord(f)).toEqual(protectedBefore);
      }
      const beforeReopen = f.store.load();
      f.reopen();
      expect(f.store.load()).toEqual(beforeReopen);
      expectUniqueOrder(ordinarySiblings(f));
    } finally { f.dispose(); }
  });

  it("retains the fail-closed create guard for historical equal positions without rewriting them", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      const next = f.store.create(null, "page", "Next sibling");
      const first = duplicate(f.store, original.id);
      const second = duplicate(f.store, original.id);
      // Reproduce bytes written by the old duplicate implementation, not a new supported edit.
      f.store.write({ ...second, position: first.position });
      const preservedIds = [original.id, next.id, first.id, second.id];
      const preserved = preservedIds.map(id => raw(f.store, id));
      const protectedBefore = ownerAndRecord(f);
      const before = f.store.load();
      expect(() => f.store.create(null, "page", "Blocked by historical tie")).toThrow(/並び順/);
      expect(f.store.load()).toEqual(before);
      expect(preservedIds.map(id => raw(f.store, id))).toEqual(preserved);
      expect(ownerAndRecord(f)).toEqual(protectedBefore);
      f.reopen();
      expect(f.store.load()).toEqual(before);
      expect(preservedIds.map(id => raw(f.store, id))).toEqual(preserved);
      expect(ownerAndRecord(f)).toEqual(protectedBefore);
    } finally { f.dispose(); }
  });

  it("refuses to move an unrelated page when the destination siblings contain a historical tie", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      const moving = f.store.create(null, "page", "Moving page");
      const first = duplicate(f.store, original.id);
      const second = duplicate(f.store, original.id);
      f.store.write({ ...second, position: first.position });
      const retained = [first.id, second.id].map(id => raw(f.store, id));
      const protectedBefore = ownerAndRecord(f);
      const before = f.store.load();
      expect(() => f.store.move(moving.id, null, original.id)).toThrow(/並び順/);
      expect(f.store.load()).toEqual(before);
      expect([first.id, second.id].map(id => raw(f.store, id))).toEqual(retained);
      expect(ownerAndRecord(f)).toEqual(protectedBefore);
    } finally { f.dispose(); }
  });

  it("duplicates a subtree with fresh page IDs, retained content and independent child ordering", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Subtree");
      const child = f.store.create(original.id, "page", "Child");
      const grandchild = f.store.create(child.id, "page", "Grandchild");
      const savedChild = f.store.update(child.id, child.revision, {
        width: "wide",
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this body" }] }] },
      });
      const sourceIds = [original.id, child.id, grandchild.id];
      const originalBytes = sourceIds.map(id => raw(f.store, id));
      const copies = [duplicate(f.store, original.id), duplicate(f.store, original.id)];
      for (const copy of copies) {
        const descendants = [...f.store.descendants(copy.id)];
        expect(descendants).toHaveLength(3);
        expect(descendants.every(id => !sourceIds.includes(id))).toBe(true);
        const copiedChild = f.store.pages().find(page => page.parentId === copy.id)!;
        expect(copiedChild.position).toBe(savedChild.position);
        expect(copiedChild.doc).toEqual(savedChild.doc);
        expect(copiedChild.width).toBe("wide");
        const copiedGrandchild = f.store.pages().find(page => page.parentId === copiedChild.id)!;
        expect(copiedGrandchild.title).toBe("Grandchild");
        expect(copiedGrandchild.position).toBe(grandchild.position);
        f.store.create(copy.id, "page", "New child");
        expectUniqueOrder(ordinarySiblings(f, copy.id));
      }
      expect(sourceIds.map(id => raw(f.store, id))).toEqual(originalBytes);
      expectUniqueOrder(ordinarySiblings(f));
    } finally { f.dispose(); }
  });

  it.each(["adjacent", "maximum"])("refuses duplicate ordering with no finite representable gap (%s)", variant => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      if (variant === "adjacent") {
        const next = f.store.create(null, "page", "Next sibling");
        f.store.write({ ...original, position: 1 });
        f.store.write({ ...next, position: 1 + Number.EPSILON });
      } else {
        f.store.write({ ...original, position: Number.MAX_VALUE });
      }
      const before = f.store.load();
      const rawBefore = f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all();
      const protectedBefore = ownerAndRecord(f);
      expect(() => duplicate(f.store, original.id)).toThrow(/並び順/);
      expect(f.store.load()).toEqual(before);
      expect(f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all()).toEqual(rawBefore);
      expect(ownerAndRecord(f)).toEqual(protectedBefore);
      f.reopen();
      expect(f.store.load()).toEqual(before);
    } finally { f.dispose(); }
  });

  it.each(["x".repeat(500), "😀".repeat(250)])("preserves the duplicate suffix within the title limit without splitting Unicode", title => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", title);
      const originalBytes = raw(f.store, original.id);
      const copy = duplicate(f.store, original.id);
      expect(copy.title.length).toBeLessThanOrEqual(500);
      expect(copy.title.endsWith(" のコピー")).toBe(true);
      expect(copy.title).not.toMatch(/[\uD800-\uDFFF]/u);
      const prefix = copy.title.slice(0, -" のコピー".length);
      expect(prefix.length).toBeGreaterThan(0);
      expect(title.startsWith(prefix)).toBe(true);
      f.store.move(copy.id, null, original.id);
      expect(f.store.get(copy.id).position).toBeLessThan(original.position);
      expect(raw(f.store, original.id)).toEqual(originalBytes);
      f.reopen();
      expect(f.store.get(copy.id).title).toBe(copy.title);
    } finally { f.dispose(); }
  });

  it("reserves trash positions so duplication does not create collisions on restore", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      const trashed = f.store.create(null, "page", "Will restore");
      f.store.trash(trashed.id);
      const protectedBefore = ownerAndRecord(f);
      for (let n = 0; n < 4; n++) duplicate(f.store, original.id);
      expectUniqueOrder(ordinarySiblings(f));
      f.store.restore(trashed.id);
      expect(f.store.get(trashed.id).deletedAt).toBeNull();
      expectUniqueOrder(ordinarySiblings(f));
      expect(ownerAndRecord(f)).toEqual(protectedBefore);
    } finally { f.dispose(); }
  });

  it("rolls back a partially copied subtree when a later page insertion fails", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Subtree");
      f.store.create(original.id, "page", "Fault child");
      const before = f.store.load();
      const rawBefore = f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all();
      f.store.db.exec(`CREATE TRIGGER audit_reject_copy BEFORE INSERT ON pages
        WHEN json_extract(NEW.data,'$.title')='Fault child'
        BEGIN SELECT RAISE(ABORT,'injected child copy failure'); END;`);
      expect(() => duplicate(f.store, original.id)).toThrow(/injected child copy failure/);
      expect(f.store.load()).toEqual(before);
      expect(f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all()).toEqual(rawBefore);
    } finally { f.dispose(); }
  });

  it("still refuses record/registered-owner hierarchy moves without changing either", () => {
    const f = fixture();
    try {
      const normal = f.store.create(null, "page", "Normal page");
      const before = f.store.load();
      const protectedBefore = ownerAndRecord(f);
      expect(() => f.store.move(f.recordId!, null, normal.id)).toThrow(/レコード/);
      expect(() => f.store.move(f.ownerId!, null, normal.id)).toThrow(/データベース/);
      expect(() => f.store.move(normal.id, f.ownerId!, null)).toThrow(/データベース/);
      expect(() => f.store.move(normal.id, f.recordId!, null)).toThrow(/レコード/);
      expect(f.store.load()).toEqual(before);
      expect(ownerAndRecord(f)).toEqual(protectedBefore);
    } finally { f.dispose(); }
  });
});
