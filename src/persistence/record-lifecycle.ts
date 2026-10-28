import type { Doc, Page, RecordProjection } from "../shared/types";
import type { Store } from "./store";
import { RecordRepository } from "./record-repository";

type Membership = {
  page_id: string;
  database_page_id: string;
  position: number;
  values_json: string;
};

/** Transactional lifecycle primitives. Existing trashed databases converted
 * from legacy data require
 * registerMigratedTrashInTransaction before restore can be enabled.
 * Hierarchical descendants are deliberately rejected until a complete subtree
 * implementation exists; this avoids silently omitting children. */
export class RecordLifecycle {
  private readonly records: RecordRepository;
  constructor(private readonly store: Store) {
    this.records = new RecordRepository(store);
  }

  private createSchema(): void {
    if (!this.store.db.isTransaction)
      throw new Error("Lifecycle schema requires transaction");
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS record_database_trash_batches (
        database_page_id TEXT PRIMARY KEY REFERENCES record_databases(database_page_id),
        deleted_revision INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS record_database_trash_members (
        database_page_id TEXT NOT NULL REFERENCES record_database_trash_batches(database_page_id) ON DELETE CASCADE,
        page_id TEXT NOT NULL REFERENCES pages(id),
        deleted_revision INTEGER NOT NULL,
        PRIMARY KEY(database_page_id,page_id)
      );
    `);
  }

  /** Called only inside legacy conversion, for a previously trashed legacy DB. */
  registerMigratedTrashInTransaction(databasePageId: string): void {
    this.createSchema();
    const db = this.database(databasePageId);
    if (db.deletedAt === null) throw new Error("Database is not trashed");
    const members = this.members(databasePageId);
    this.assertNoChildren([db.id, ...members.map((m) => m.page_id)]);
    this.store.db
      .prepare("INSERT INTO record_database_trash_batches VALUES(?,?,?)")
      .run(db.id, db.revision, db.deletedAt);
    for (const member of members) {
      const page = this.record(member.page_id);
      if (page.deletedAt !== db.deletedAt)
        throw new Error("Legacy trash ownership is ambiguous");
      this.store.db
        .prepare("INSERT INTO record_database_trash_members VALUES(?,?,?)")
        .run(db.id, page.id, page.revision);
    }
  }

  trashRecord(pageId: string, revision: number): void {
    this.store.transaction(() => {
      const member = this.member(pageId),
        page = this.record(pageId),
        database = this.database(member.database_page_id);
      this.requireRevision(page, revision);
      if (page.deletedAt !== null || database.deletedAt !== null)
        throw new Error("Record or database is already trashed");
      this.assertNoChildren([pageId]);
      this.store.write({
        ...page,
        deletedAt: Date.now(),
        updatedAt: Date.now(),
        revision: page.revision + 1,
      });
    });
  }

  restoreRecord(pageId: string, revision: number): RecordProjection {
    return this.store.transaction(() => {
      const member = this.member(pageId),
        page = this.record(pageId),
        database = this.database(member.database_page_id);
      this.requireRevision(page, revision);
      if (database.deletedAt !== null)
        throw new Error("Restore the owning database first");
      if (page.deletedAt === null) throw new Error("Record is not trashed");
      this.assertNoChildren([pageId]);
      this.store.write({
        ...page,
        deletedAt: null,
        updatedAt: Date.now(),
        revision: page.revision + 1,
      });
      return this.records.projection(pageId);
    });
  }

  trashDatabase(id: string, revision: number): void {
    this.store.transaction(() => {
      this.createSchema();
      const db = this.database(id),
        members = this.members(id);
      this.requireRevision(db, revision);
      if (db.deletedAt !== null) throw new Error("Database is already trashed");
      this.assertNoChildren([id, ...members.map((m) => m.page_id)]);
      const now = Date.now();
      this.store.db
        .prepare("INSERT INTO record_database_trash_batches VALUES(?,?,?)")
        .run(id, db.revision + 1, now);
      for (const member of members) {
        const page = this.record(member.page_id);
        if (page.deletedAt !== null) continue;
        this.store.db
          .prepare("INSERT INTO record_database_trash_members VALUES(?,?,?)")
          .run(id, page.id, page.revision + 1);
        this.store.write({
          ...page,
          deletedAt: now,
          updatedAt: now,
          revision: page.revision + 1,
        });
      }
      this.store.write({
        ...db,
        deletedAt: now,
        updatedAt: now,
        revision: db.revision + 1,
      });
    });
  }

  restoreDatabase(id: string, revision: number): Page {
    return this.store.transaction(() => {
      this.createSchema();
      const db = this.database(id);
      this.requireRevision(db, revision);
      if (db.deletedAt === null) throw new Error("Database is not trashed");
      const batch = this.store.db
        .prepare(
          "SELECT deleted_revision,deleted_at FROM record_database_trash_batches WHERE database_page_id=?",
        )
        .get(id) as
        { deleted_revision: number; deleted_at: number } | undefined;
      if (
        !batch ||
        batch.deleted_revision !== db.revision ||
        batch.deleted_at !== db.deletedAt
      )
        throw new Error(
          "Database trash batch unavailable or changed; original retained",
        );
      const members = this.store.db
        .prepare(
          "SELECT page_id,deleted_revision FROM record_database_trash_members WHERE database_page_id=?",
        )
        .all(id) as { page_id: string; deleted_revision: number }[];
      this.assertNoChildren([id, ...this.members(id).map((m) => m.page_id)]);
      for (const member of members) {
        const page = this.record(member.page_id),
          actual = this.member(page.id);
        if (
          actual.database_page_id !== id ||
          page.deletedAt !== batch.deleted_at ||
          page.revision !== member.deleted_revision
        )
          throw new Error("Trashed record changed; original retained");
        this.store.write({
          ...page,
          deletedAt: null,
          updatedAt: Date.now(),
          revision: page.revision + 1,
        });
      }
      const parentGone =
        db.parentId && this.store.get(db.parentId).deletedAt !== null;
      const result = this.store.write({
        ...db,
        parentId: parentGone ? null : db.parentId,
        deletedAt: null,
        updatedAt: Date.now(),
        revision: db.revision + 1,
      });
      this.store.db
        .prepare(
          "DELETE FROM record_database_trash_batches WHERE database_page_id=?",
        )
        .run(id);
      return result;
    });
  }

  duplicateRecord(id: string, revision: number): RecordProjection {
    return this.store.transaction(() => {
      const member = this.member(id),
        source = this.record(id),
        database = this.database(member.database_page_id);
      this.requireRevision(source, revision);
      if (source.deletedAt !== null || database.deletedAt !== null)
        throw new Error("Cannot duplicate a trashed record");
      this.assertNoChildren([id]);
      const title = source.title + " のコピー";
      if (title.length > 500) throw new Error("Copied title exceeds the limit");
      const copyId = this.store.allocatePageId(),
        now = Date.now(),
        values = this.records.projection(id).values;
      const position =
        this.members(database.id).reduce(
          (max, x) => Math.max(max, x.position),
          -1,
        ) + 1;
      this.store.write(
        {
          ...source,
          id: copyId,
          title,
          doc: rewriteDocument(source.doc, new Map([[id, copyId]])),
          parentId: null,
          position,
          revision: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        true,
      );
      this.records.attachForMigration(copyId, database.id, position, {
        ...values,
      });
      return this.records.projection(copyId);
    });
  }

  duplicateDatabase(id: string, revision: number): Page {
    return this.store.transaction(() => {
      const source = this.database(id),
        members = this.members(id);
      this.requireRevision(source, revision);
      if (source.deletedAt !== null)
        throw new Error("Cannot duplicate a trashed database");
      this.assertNoChildren([id, ...members.map((m) => m.page_id)]);
      if (source.database!.rows.length)
        throw new Error("Database still contains legacy rows");
      const title = source.title + " のコピー";
      if (title.length > 500) throw new Error("Copied title exceeds the limit");
      const active = members
        .map((member) => ({ member, page: this.record(member.page_id) }))
        .filter(({ page }) => page.deletedAt === null);
      const reserved = new Set<string>(),
        mapping = new Map<string, string>();
      mapping.set(id, this.store.allocatePageId(undefined, reserved));
      for (const { page } of active)
        mapping.set(page.id, this.store.allocatePageId(undefined, reserved));
      const now = Date.now(),
        copiedDatabaseId = mapping.get(id)!;
      this.store.write(
        {
          ...source,
          id: copiedDatabaseId,
          title,
          doc: rewriteDocument(source.doc, mapping),
          database: structuredClone(source.database),
          position: source.position + 0.5,
          revision: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        true,
      );
      this.records.registerDatabase(copiedDatabaseId);
      for (const { member, page } of active) {
        const pageId = mapping.get(page.id)!,
          values = this.records.projection(page.id).values;
        this.store.write(
          {
            ...page,
            id: pageId,
            doc: rewriteDocument(page.doc, mapping),
            parentId: null,
            revision: 0,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
          true,
        );
        this.records.attachForMigration(
          pageId,
          copiedDatabaseId,
          member.position,
          { ...values },
        );
      }
      return this.store.get(copiedDatabaseId);
    });
  }

  private requireRevision(page: Page, revision: number) {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision !== page.revision
    )
      throw new Error("保存の競合を検出しました。");
  }
  private record(id: string): Page {
    const page = this.store.get(id);
    if (page.kind !== "page" || page.documentError)
      throw new Error("Unsupported record; original retained");
    this.records.projection(id);
    return page;
  }
  private database(id: string): Page {
    const page = this.store.get(id);
    if (
      page.kind !== "database" ||
      !page.database ||
      page.documentError ||
      !this.store.db
        .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
        .get(id)
    )
      throw new Error("Unsupported database; original retained");
    return page;
  }
  private member(id: string): Membership {
    const value = this.store.db
      .prepare(
        "SELECT page_id,database_page_id,position,values_json FROM record_memberships WHERE page_id=?",
      )
      .get(id) as Membership | undefined;
    if (!value) throw new Error("Record membership not found");
    return value;
  }
  private members(id: string): Membership[] {
    return this.store.db
      .prepare(
        "SELECT page_id,database_page_id,position,values_json FROM record_memberships WHERE database_page_id=? ORDER BY position,page_id",
      )
      .all(id) as Membership[];
  }
  private assertNoChildren(ids: string[]): void {
    const roots = new Set(ids);
    if (
      this.store
        .pages()
        .some((p) => p.parentId !== null && roots.has(p.parentId))
    )
      throw new Error(
        "Lifecycle of pages with children is not supported; originals retained",
      );
  }
}

/** Blocks are scoped to a document. Only links targeting copied identities are
 * rewritten; links outside the copy remain unchanged. */
function rewriteDocument(doc: Doc, ids: Map<string, string>): Doc {
  const copy = structuredClone(doc),
    stack = [copy];
  while (stack.length) {
    const node = stack.pop()!;
    for (const mark of node.marks ?? []) {
      const href =
        mark.type === "link" && typeof mark.attrs?.href === "string"
          ? mark.attrs.href
          : null;
      if (!href?.startsWith("folio-page://")) continue;
      const mapped = ids.get(href.slice("folio-page://".length));
      if (mapped)
        mark.attrs = { ...mark.attrs, href: `folio-page://${mapped}` };
    }
    stack.push(...(node.content ?? []));
  }
  return copy;
}
