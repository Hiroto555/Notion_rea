import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyPageOrderRepair, previewPageOrderRepair } from "../src/persistence/page-order-repair";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { RecordRepository } from "../src/persistence/record-repository";
import { Store } from "../src/persistence/store";
import { prepareDatabaseCreation, type DatabaseOperationResult } from "../src/shared/database-operation";
import type { Page } from "../src/shared/types";

type Fixture = {
  directory: string;
  path: string;
  readonly store: Store;
  reopen(): void;
  dispose(): void;
};

function fixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "folio-page-order-repair-"));
  const path = join(directory, "workspace.sqlite");
  let current = new Store(path);
  return {
    directory,
    path,
    get store() {
      return current;
    },
    reopen() {
      current.close();
      current = new Store(path);
    },
    dispose() {
      current.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function registeredFixture() {
  const base = fixture();
  const result = base.store.handle({
    type: "database:commit",
    operation: prepareDatabaseCreation("Registered owner"),
  }) as DatabaseOperationResult;
  if (result.status !== "applied" || !result.page)
    throw new Error("Fixture database creation failed");
  const ownerId = result.page.id;
  const recordId = new RecordRepository(base.store).create(ownerId, "Retained record", {
    status: "未着手",
  }).pageId;
  return {
    directory: base.directory,
    path: base.path,
    get store() {
      return base.store;
    },
    reopen: () => base.reopen(),
    dispose: () => base.dispose(),
    ownerId,
    recordId,
  };
}

function rawRows(store: Store): { id: string; data: string; body: string }[] {
  return store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all() as {
    id: string;
    data: string;
    body: string;
  }[];
}

function rawRow(store: Store, id: string) {
  return store.db.prepare("SELECT id,data,body FROM pages WHERE id=?").get(id) as
    | { id: string; data: string; body: string }
    | undefined;
}

function protectedRows(store: Store) {
  const read = (table: string, order: string) =>
    store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)
      ? store.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()
      : [];
  return {
    recordDatabases: read("record_databases", "database_page_id"),
    recordMemberships: read("record_memberships", "page_id"),
    versions: read("versions", "id"),
    receipts: read("save_receipts", "operation_id"),
    settings: read("settings", "key"),
    assets: read("assets", "id"),
  };
}

function pageData(store: Store, id: string) {
  const row = rawRow(store, id);
  if (!row) throw new Error(`Missing page ${id}`);
  return JSON.parse(row.data) as Page;
}

/** Recreate the equal positions written by the previous duplicate version. */
function tie(store: Store, originalId: string) {
  const first = store.handle({ type: "duplicate", id: originalId }) as Page;
  const second = store.handle({ type: "duplicate", id: originalId }) as Page;
  store.write({ ...second, position: first.position });
  return [store.get(first.id), store.get(second.id)] as const;
}

function uniquePositions(store: Store, parentId: string | null = null) {
  const hasMemberships = !!store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'")
    .get();
  const recordIds = new Set(
    (hasMemberships
      ? (store.db.prepare("SELECT page_id FROM record_memberships").all() as {
          page_id: string;
        }[])
      : []
    ).map((row) => row.page_id),
  );
  return store
    .pages()
    .filter((page) => page.parentId === parentId && !recordIds.has(page.id))
    .map((page) => page.position);
}

function expectUniquePositions(store: Store, parentId: string | null = null) {
  const positions = uniquePositions(store, parentId);
  expect(positions.every(Number.isFinite)).toBe(true);
  expect(new Set(positions).size).toBe(positions.length);
}

function backupPage(directory: string, id: string) {
  const db = new DatabaseSync(join(directory, "workspace.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Page) : undefined;
  } finally {
    db.close();
  }
}

describe("page order repair", () => {
  it("preview is read-only, deterministic and orders equal positions by createdAt then id", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      const next = f.store.create(null, "page", "Next sibling");
      const [first, second] = tie(f.store, original.id);
      const before = rawRows(f.store);
      const protectedBefore = protectedRows(f.store);

      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(true);
      expect(preview.issues).toEqual([]);
      expect(preview.rejections).toEqual([]);
      expect(preview.groups).toHaveLength(1);
      const group = preview.groups[0];
      expect(group.parentId).toBeNull();
      expect(group.position).toBe(first.position);
      expect(group.targets).toHaveLength(2);
      expect(preview.targetIds).toEqual(
        group.targets.filter((target) => target.changed).map((target) => target.pageId),
      );

      const members = [first.id, second.id]
        .map((id) => pageData(f.store, id))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      expect(group.targets.map((target) => target.pageId)).toEqual(
        members.map((page) => page.id),
      );
      expect(group.targets[0].changed).toBe(false);
      expect(group.targets[0].toPosition).toBe(group.position);
      expect(group.targets[0].fromRevision).toBe(group.targets[0].toRevision);
      expect(group.targets[1].changed).toBe(true);
      expect(group.targets[1].toPosition).toBeGreaterThan(group.position);
      expect(group.targets[1].toPosition).toBeLessThan(next.position);
      expect(group.targets[1].toRevision).toBe(group.targets[1].fromRevision + 1);

      // Two previews over the same bytes are identical.
      expect(previewPageOrderRepair(f.store)).toEqual(preview);
      expect(rawRows(f.store)).toEqual(before);
      expect(protectedRows(f.store)).toEqual(protectedBefore);
    } finally {
      f.dispose();
    }
  });

  it("apply rewrites only tied pages and keeps a verified pre-change full backup", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      const next = f.store.create(null, "page", "Next sibling");
      const [first, second] = tie(f.store, original.id);
      const history = f.store.update(next.id, next.revision, { title: "Next renamed" });
      const before = rawRows(f.store);
      const protectedBefore = protectedRows(f.store);
      const preview = previewPageOrderRepair(f.store);
      const changedPreview = preview.groups[0].targets.filter((target) => target.changed);

      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("applied");
      expect(result.appliedGroups).toBe(1);
      expect(result.appliedPages).toBe(changedPreview.length);
      expect(result.issues).toEqual([]);
      expect(result.targets.map((target) => target.pageId)).toEqual(
        changedPreview.map((target) => target.pageId),
      );
      expect(result.backup).toBeDefined();
      const verified = verifyFullBackup(result.backup!.directory);
      expect(verified.fingerprint).toBe(result.backup!.fingerprint);
      expect(verified.manifest.inventory.pages).toBe(before.length);

      // The backup is the state before the repair: the tie is still there.
      expect(backupPage(result.backup!.directory, first.id)!.position).toBe(first.position);
      expect(backupPage(result.backup!.directory, second.id)!.position).toBe(first.position);

      // Only the changed page differs, and only position/revision/updatedAt move.
      const changedIds = new Set(result.targets.map((target) => target.pageId));
      const after = rawRows(f.store);
      expect(after.length).toBe(before.length);
      for (const row of before) {
        const nextRow = after.find((candidate) => candidate.id === row.id)!;
        if (!changedIds.has(row.id)) {
          expect(nextRow).toEqual(row);
          continue;
        }
        const target = result.targets.find((candidate) => candidate.pageId === row.id)!;
        const beforeValue = JSON.parse(row.data) as Record<string, any>;
        const afterValue = JSON.parse(nextRow.data) as Record<string, any>;
        expect(afterValue.position).toBe(target.toPosition);
        expect(afterValue.revision).toBe(target.fromRevision + 1);
        expect(typeof afterValue.updatedAt).toBe("number");
        const strip = (value: Record<string, any>) => {
          const { position, revision, updatedAt, ...rest } = value;
          return rest;
        };
        expect(strip(afterValue)).toEqual(strip(beforeValue));
        expect(nextRow.body).toBe(row.body);
      }
      expect(f.store.get(next.id).title).toBe(history.title);
      expect(protectedRows(f.store)).toEqual(protectedBefore);
      expect(uniquePositions(f.store)).toHaveLength(before.length);
      expectUniquePositions(f.store);

      f.reopen();
      expect(previewPageOrderRepair(f.store)).toMatchObject({
        groups: [],
        rejections: [],
        issues: [],
        canApply: false,
      });
      expectUniquePositions(f.store);
    } finally {
      f.dispose();
    }
  });

  it("makes create, move and restore usable again and survives reopen", () => {
    const f = registeredFixture();
    try {
      const original = f.store.create(null, "page", "Original");
      const next = f.store.create(null, "page", "Next sibling");
      tie(f.store, original.id);
      // The fail-closed duplicate position guard is active in a record store.
      expect(() => f.store.create(null, "page", "Blocked")).toThrow(/並び順/);
      applyPageOrderRepair(f.store, previewPageOrderRepair(f.store));
      expectUniquePositions(f.store);

      const created = f.store.create(null, "page", "Created after repair");
      expect(created.position).toBeGreaterThan(f.store.get(next.id).position);
      f.store.move(created.id, null, original.id);
      expect(f.store.get(created.id).position).toBeLessThan(
        f.store.get(original.id).position,
      );
      expectUniquePositions(f.store);
      f.store.trash(next.id);
      f.store.restore(next.id);
      expectUniquePositions(f.store);

      f.reopen();
      expectUniquePositions(f.store);
      f.store.create(null, "page", "Created after reopen");
      expectUniquePositions(f.store);
    } finally {
      f.dispose();
    }
  });

  it("reserves trashed positions and repairs a tie that includes a trashed page", () => {
    const f = fixture();
    try {
      const active = f.store.create(null, "page", "Active");
      const trashed = f.store.create(null, "page", "Trashed");
      const tail = f.store.create(null, "page", "Tail");
      f.store.trash(trashed.id);
      f.store.write({ ...f.store.get(active.id), position: 1 });
      f.store.write({ ...f.store.get(trashed.id), position: 1 });
      f.store.write({ ...f.store.get(tail.id), position: 3 });
      const tailBefore = rawRow(f.store, tail.id);
      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(true);
      const group = preview.groups.find((candidate) => candidate.position === 1)!;
      expect(group.targets).toHaveLength(2);
      expect(group.targets.find((target) => target.pageId === trashed.id)!.deleted).toBe(true);
      // The next free slot is bounded by the trailing Page at 3, so the moved
      // member lands exactly on the midpoint 2 no matter which id sorts first.
      const changed = group.targets.filter((target) => target.changed);
      expect(changed).toHaveLength(1);
      expect(changed[0].toPosition).toBe(2);

      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("applied");
      expect(result.appliedPages).toBe(1);
      expect(rawRow(f.store, tail.id)).toEqual(tailBefore);
      expect(f.store.get(trashed.id).deletedAt).not.toBeNull();
      expectUniquePositions(f.store);

      f.store.restore(trashed.id);
      expect(f.store.get(trashed.id).deletedAt).toBeNull();
      expectUniquePositions(f.store);
      f.store.create(null, "page", "After restore");
      expectUniquePositions(f.store);
    } finally {
      f.dispose();
    }
  });

  it("repairs multiple ties without renumbering unrelated pages", () => {
    const f = fixture();
    try {
      const pages = ["A", "B", "C", "D", "E"].map((title) =>
        f.store.create(null, "page", title),
      );
      f.store.write({ ...f.store.get(pages[1].id), position: pages[0].position });
      f.store.write({ ...f.store.get(pages[3].id), position: pages[2].position });
      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(true);
      expect(preview.groups.map((group) => group.position).sort((a, b) => a - b)).toEqual([
        pages[0].position,
        pages[2].position,
      ]);
      // Only the deterministic keeper of each tie and the untouched last page
      // keep their exact bytes; the other member of each pair moves.
      const keepers = preview.groups.map((group) => group.targets[0].pageId);
      const untouchedIds = [...keepers, pages[4].id];
      const untouched = untouchedIds.map((id) => rawRow(f.store, id));
      expect(preview.targetIds.some((id) => untouchedIds.includes(id))).toBe(false);

      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("applied");
      expect(result.appliedGroups).toBe(2);
      expect(result.appliedPages).toBe(2);
      expect(uniquePositions(f.store).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      expect(untouchedIds.map((id) => rawRow(f.store, id))).toEqual(untouched);
    } finally {
      f.dispose();
    }
  });

  it("repairs a tie inside a subtree without touching its parent or root siblings", () => {
    const f = fixture();
    try {
      const parent = f.store.create(null, "page", "Parent");
      const firstChild = f.store.create(parent.id, "page", "Child A");
      const secondChild = f.store.create(parent.id, "page", "Child B");
      const rootNext = f.store.create(null, "page", "Root next");
      f.store.write({ ...f.store.get(secondChild.id), position: firstChild.position });
      const parentBefore = rawRow(f.store, parent.id);
      const rootBefore = rawRow(f.store, rootNext.id);

      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(true);
      expect(preview.groups).toHaveLength(1);
      expect(preview.groups[0].parentId).toBe(parent.id);
      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("applied");
      expect(rawRow(f.store, parent.id)).toEqual(parentBefore);
      expect(rawRow(f.store, rootNext.id)).toEqual(rootBefore);
      expectUniquePositions(f.store, parent.id);
      f.store.create(parent.id, "page", "Child C");
      expectUniquePositions(f.store, parent.id);
    } finally {
      f.dispose();
    }
  });

  it("refuses a tie with a registered database and changes nothing", () => {
    const f = registeredFixture();
    try {
      const database = f.store.get(f.ownerId);
      const ordinary = f.store.create(null, "page", "Ordinary");
      f.store.write({ ...ordinary, position: database.position });
      const before = rawRows(f.store);
      const protectedBefore = protectedRows(f.store);

      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(false);
      expect(preview.groups).toEqual([]);
      expect(preview.rejections.length).toBeGreaterThan(0);
      expect(preview.rejections[0].pageIds).toContain(f.ownerId);
      expect(preview.rejections[0].reasons.join("\n")).toMatch(/データベース/);

      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("rejected");
      expect(result.backup).toBeUndefined();
      expect(result.issues.join("\n")).toMatch(/データベース/);
      expect(rawRows(f.store)).toEqual(before);
      expect(protectedRows(f.store)).toEqual(protectedBefore);
      expect(existsSync(join(f.directory, "backups"))).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("repairs ordinary ties in a record workspace without touching records", () => {
    const f = registeredFixture();
    try {
      const ordinary = f.store.create(null, "page", "Ordinary");
      const tied = f.store.create(null, "page", "Tied");
      const next = f.store.create(null, "page", "Next");
      f.store.write({ ...tied, position: ordinary.position });
      const ownerBefore = rawRow(f.store, f.ownerId);
      const recordBefore = rawRow(f.store, f.recordId);
      const protectedBefore = protectedRows(f.store);

      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(true);
      expect(preview.targetIds).not.toContain(f.recordId);
      expect(preview.targetIds).not.toContain(f.ownerId);
      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("applied");
      expect(rawRow(f.store, f.ownerId)).toEqual(ownerBefore);
      expect(rawRow(f.store, f.recordId)).toEqual(recordBefore);
      expect(protectedRows(f.store)).toEqual(protectedBefore);
      expect(f.store.get(f.ownerId).position).toBe(ownerBefore ? JSON.parse(ownerBefore.data).position : 0);
      expect(f.store.get(f.recordId).position).toBe(JSON.parse(recordBefore!.data).position);
      expectUniquePositions(f.store);
      f.store.create(null, "page", "After repair");
      expectUniquePositions(f.store);
      expect(result.appliedPages).toBe(1);
      expect(f.store.get(next.id).position).toBeGreaterThan(preview.groups[0].position);
    } finally {
      f.dispose();
    }
  });

  it("refuses a stale preview before writing pages or creating a backup", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      const next = f.store.create(null, "page", "Next sibling");
      tie(f.store, original.id);
      const preview = previewPageOrderRepair(f.store);
      f.store.update(next.id, next.revision, { title: "Changed after the preview" });
      const afterChange = rawRows(f.store);

      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("rejected");
      expect(result.issues.join("\n")).toMatch(/プレビュー後に原本が変わりました/);
      expect(result.backup).toBeUndefined();
      expect(result.currentFingerprint).not.toBe(preview.sourceFingerprint);
      expect(rawRows(f.store)).toEqual(afterChange);
      expect(existsSync(join(f.directory, "backups"))).toBe(false);

      const renewed = previewPageOrderRepair(f.store);
      expect(applyPageOrderRepair(f.store, renewed).status).toBe("applied");
    } finally {
      f.dispose();
    }
  });

  it("refuses to change pages when the full backup cannot be created", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      f.store.create(null, "page", "Next sibling");
      tie(f.store, original.id);
      mkdirSync(join(f.directory, "assets"));
      symlinkSync(
        join(f.directory, "outside"),
        join(f.directory, "assets", "linked-asset"),
      );
      const before = rawRows(f.store);
      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(true);

      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("rejected");
      expect(result.issues.join("\n")).toMatch(/完全バックアップ/);
      expect(result.backup).toBeUndefined();
      expect(rawRows(f.store)).toEqual(before);

      const backups = join(f.directory, "backups");
      expect(existsSync(backups)).toBe(true);
      const attempts = readdirSync(backups);
      expect(attempts).toHaveLength(1);
      expect(
        existsSync(join(backups, attempts[0], "FOLIO-RECOVERY-INCOMPLETE")),
      ).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it("rolls back every page when a later SQL write fails", () => {
    const f = fixture();
    try {
      const pages = ["A", "B", "C", "D"].map((title) =>
        f.store.create(null, "page", title),
      );
      f.store.write({ ...f.store.get(pages[1].id), position: pages[0].position });
      f.store.write({ ...f.store.get(pages[2].id), position: pages[0].position });
      f.store.write({ ...f.store.get(pages[3].id), position: 4 });
      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(true);
      expect(preview.targetIds).toHaveLength(2);
      const failingId = preview.targetIds[1];
      const before = rawRows(f.store);
      f.store.db.exec(
        `CREATE TRIGGER injected_page_order_failure BEFORE UPDATE ON pages
         WHEN NEW.id = '${failingId}'
         BEGIN SELECT RAISE(ABORT, 'injected page order failure'); END;`,
      );

      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("rejected");
      expect(result.issues.join("\n")).toMatch(/injected page order failure/);
      expect(result.backup).toBeDefined();
      expect(verifyFullBackup(result.backup!.directory).fingerprint).toBe(
        result.backup!.fingerprint,
      );
      expect(rawRows(f.store)).toEqual(before);
      expect(previewPageOrderRepair(f.store).canApply).toBe(true);
    } finally {
      f.dispose();
    }
  });

  it("refuses unknown page schema, malformed JSON and non-finite positions", () => {
    const variants = [
      {
        label: "unknown schema",
        mutate: (store: Store, id: string) => {
          const value = pageData(store, id);
          store.db
            .prepare("UPDATE pages SET data=? WHERE id=?")
            .run(JSON.stringify({ ...value, schemaVersion: 2 }), id);
        },
      },
      {
        label: "malformed JSON",
        mutate: (store: Store, id: string) => {
          store.db.prepare("UPDATE pages SET data=? WHERE id=?").run("{", id);
        },
      },
      {
        label: "non-finite position",
        mutate: (store: Store, id: string) => {
          const value = pageData(store, id);
          const raw = JSON.stringify({ ...value }).replace(
            `"position":${JSON.stringify(value.position)}`,
            '"position":1e999',
          );
          store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, id);
        },
      },
    ];
    for (const variant of variants) {
      const f = fixture();
      try {
        const original = f.store.create(null, "page", "Original");
        const next = f.store.create(null, "page", "Next sibling");
        tie(f.store, original.id);
        variant.mutate(f.store, next.id);
        const before = rawRows(f.store);
        const preview = previewPageOrderRepair(f.store);
        expect(preview.canApply, variant.label).toBe(false);
        expect(preview.groups, variant.label).toEqual([]);
        expect(preview.issues.join("\n"), variant.label).toMatch(
          variant.label === "unknown schema"
            ? /schemaVersion/
            : variant.label === "malformed JSON"
              ? /JSON/
              : /有限/,
        );
        const result = applyPageOrderRepair(f.store, preview);
        expect(result.status, variant.label).toBe("rejected");
        expect(rawRows(f.store), variant.label).toEqual(before);
      } finally {
        f.dispose();
      }
    }
  });

  it("refuses unsupported page bytes in a tied group with a reason", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      f.store.create(null, "page", "Next sibling");
      const [, second] = tie(f.store, original.id);
      const value = pageData(f.store, second.id);
      const raw = JSON.stringify({ ...value, futureField: true });
      f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, second.id);
      const before = rawRows(f.store);

      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(false);
      expect(preview.issues).toEqual([]);
      expect(preview.rejections).toHaveLength(1);
      expect(preview.rejections[0].reasons.join("\n")).toMatch(/未対応の項目/);
      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("rejected");
      expect(rawRows(f.store)).toEqual(before);
    } finally {
      f.dispose();
    }
  });

  it("refuses adjacent representable positions and the maximum boundary", () => {
    const f = fixture();
    try {
      const first = f.store.create(null, "page", "First");
      const second = f.store.create(null, "page", "Second");
      const third = f.store.create(null, "page", "Third");
      f.store.write({ ...f.store.get(second.id), position: first.position });
      f.store.write({ ...f.store.get(third.id), position: 1 + Number.EPSILON });
      const before = rawRows(f.store);
      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(false);
      expect(preview.rejections).toHaveLength(1);
      expect(preview.rejections[0].reasons.join("\n")).toMatch(/空き/);
      expect(applyPageOrderRepair(f.store, preview).status).toBe("rejected");
      expect(rawRows(f.store)).toEqual(before);
    } finally {
      f.dispose();
    }
  });

  it("refuses a tie at Number.MAX_VALUE without writing", () => {
    const f = fixture();
    try {
      const first = f.store.create(null, "page", "First");
      const second = f.store.create(null, "page", "Second");
      f.store.write({ ...f.store.get(first.id), position: Number.MAX_VALUE });
      f.store.write({ ...f.store.get(second.id), position: Number.MAX_VALUE });
      const before = rawRows(f.store);
      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(false);
      expect(preview.rejections[0].reasons.join("\n")).toMatch(/空き|安全でない整数/);
      expect(applyPageOrderRepair(f.store, preview).status).toBe("rejected");
      expect(rawRows(f.store)).toEqual(before);
    } finally {
      f.dispose();
    }
  });

  it("refuses a missing parent or a hierarchy cycle", () => {
    const cases = [
      {
        label: "missing parent",
        mutate: (store: Store, page: Page) => {
          store.db
            .prepare("UPDATE pages SET data=? WHERE id=?")
            .run(JSON.stringify({ ...page, parentId: "missing-parent" }), page.id);
        },
        pattern: /親ページ/,
      },
      {
        label: "cycle",
        mutate: (store: Store, page: Page, other: Page) => {
          store.db
            .prepare("UPDATE pages SET data=? WHERE id=?")
            .run(JSON.stringify({ ...page, parentId: other.id }), page.id);
          store.db
            .prepare("UPDATE pages SET data=? WHERE id=?")
            .run(JSON.stringify({ ...other, parentId: page.id }), other.id);
        },
        pattern: /循環/,
      },
    ];
    for (const entry of cases) {
      const f = fixture();
      try {
        const first = f.store.create(null, "page", "First");
        const second = f.store.create(null, "page", "Second");
        tie(f.store, first.id);
        entry.mutate(f.store, pageData(f.store, first.id), pageData(f.store, second.id));
        const before = rawRows(f.store);
        const preview = previewPageOrderRepair(f.store);
        expect(preview.canApply, entry.label).toBe(false);
        expect(preview.issues.join("\n"), entry.label).toMatch(entry.pattern);
        expect(applyPageOrderRepair(f.store, preview).status, entry.label).toBe("rejected");
        expect(rawRows(f.store), entry.label).toEqual(before);
      } finally {
        f.dispose();
      }
    }
  });

  it("refuses an incomplete record schema", () => {
    const f = registeredFixture();
    try {
      f.store.db.exec("DROP TABLE record_value_versions");
      const before = rawRows(f.store);
      const preview = previewPageOrderRepair(f.store);
      expect(preview.canApply).toBe(false);
      expect(preview.issues.join("\n")).toMatch(/record|schema|Incomplete/i);
      expect(applyPageOrderRepair(f.store, preview).status).toBe("rejected");
      expect(rawRows(f.store)).toEqual(before);
    } finally {
      f.dispose();
    }
  });

  it("reports no repairable ties and refuses to write", () => {
    const f = fixture();
    try {
      f.store.create(null, "page", "One");
      f.store.create(null, "page", "Two");
      const before = rawRows(f.store);
      const preview = previewPageOrderRepair(f.store);
      expect(preview).toMatchObject({
        groups: [],
        rejections: [],
        issues: [],
        targetIds: [],
        canApply: false,
      });
      const result = applyPageOrderRepair(f.store, preview);
      expect(result.status).toBe("rejected");
      expect(result.issues.join("\n")).toMatch(/修復できる同順位/);
      expect(result.backup).toBeUndefined();
      expect(rawRows(f.store)).toEqual(before);
    } finally {
      f.dispose();
    }
  });

  it("cannot be replayed once applied", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      f.store.create(null, "page", "Next sibling");
      tie(f.store, original.id);
      const preview = previewPageOrderRepair(f.store);
      expect(applyPageOrderRepair(f.store, preview).status).toBe("applied");
      const afterFirst = rawRows(f.store);
      const replay = applyPageOrderRepair(f.store, preview);
      expect(replay.status).toBe("rejected");
      expect(replay.issues.join("\n")).toMatch(/プレビュー後に原本が変わりました/);
      expect(rawRows(f.store)).toEqual(afterFirst);
    } finally {
      f.dispose();
    }
  });

  it("rejects an invalid plan fingerprint before touching the workspace", () => {
    const f = fixture();
    try {
      const original = f.store.create(null, "page", "Original");
      f.store.create(null, "page", "Next sibling");
      tie(f.store, original.id);
      const before = rawRows(f.store);
      expect(() =>
        applyPageOrderRepair(f.store, { sourceFingerprint: "not-a-fingerprint" }),
      ).toThrow(/fingerprint/);
      const wrong = applyPageOrderRepair(f.store, {
        sourceFingerprint: "0".repeat(64),
      });
      expect(wrong.status).toBe("rejected");
      expect(wrong.issues.join("\n")).toMatch(/プレビュー後に原本が変わりました/);
      expect(rawRows(f.store)).toEqual(before);
      expect(existsSync(join(f.directory, "backups"))).toBe(false);
    } finally {
      f.dispose();
    }
  });
});
