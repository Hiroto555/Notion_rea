import { fileFits } from "../shared/limits";
import {
  requestSchema,
  blankDoc,
  type FilterValue,
  type RecordPatch,
  type RecordProjection,
  type Page,
  type DatabaseSettings,
  type DatabaseProjection,
} from "../shared/types";
import type { Store } from "./store";

/** Record commands are available through IPC, but the experimental schema is
 * not enabled by startup. Migration/versioning, recovery and UI integration
 * must be completed before enabling the schema for an actual workspace. */
export class RecordRepository {
  constructor(private readonly store: Store) {}

  createSchema(): void {
    this.requireTransaction();
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS record_databases (
        database_page_id TEXT PRIMARY KEY REFERENCES pages(id)
      );
      CREATE TABLE IF NOT EXISTS record_memberships (
        page_id TEXT PRIMARY KEY REFERENCES pages(id),
        database_page_id TEXT NOT NULL REFERENCES pages(id),
        position INTEGER NOT NULL,
        values_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS record_memberships_database ON record_memberships(database_page_id, position);
      CREATE TABLE IF NOT EXISTS record_value_versions (
        version_id INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
        values_json TEXT NOT NULL
      );
    `);
  }

  /** Mark even an empty migrated database so legacy whole-row writes fail. */
  registerDatabase(databasePageId: string): void {
    this.requireTransaction();
    const database = this.store.get(databasePageId);
    if (
      database.kind !== "database" ||
      database.documentError ||
      !database.database
    )
      throw new Error("Invalid database");
    this.store.db
      .prepare(
        "INSERT INTO record_databases(database_page_id) VALUES(?) ON CONFLICT DO NOTHING",
      )
      .run(databasePageId);
  }

  attachForMigration(
    pageId: string,
    databasePageId: string,
    position: number,
    values: Record<string, FilterValue>,
  ): void {
    this.requireTransaction();
    const page = this.store.get(pageId),
      database = this.store.get(databasePageId);
    if (
      page.kind !== "page" ||
      page.documentError ||
      database.kind !== "database" ||
      database.documentError ||
      !database.database ||
      !Number.isSafeInteger(position)
    )
      throw new Error("Invalid record membership");
    this.registerDatabase(databasePageId);
    const clean = this.validateValues(values, false);
    this.store.db
      .prepare(
        "INSERT INTO record_memberships(page_id,database_page_id,position,values_json) VALUES(?,?,?,?)",
      )
      .run(pageId, databasePageId, position, JSON.stringify(clean));
  }

  projection(pageId: string): RecordProjection {
    const member = this.member(pageId),
      page = this.store.get(pageId);
    return {
      pageId,
      databasePageId: member.database_page_id,
      revision: page.revision,
      title: page.title,
      icon: page.icon,
      values: this.parseValues(member.values_json),
      deletedAt: page.deletedAt,
    };
  }

  /** Read a live record, its document, membership and owner from one SQLite
   * snapshot. This does not install the document into an Editor. */
  readSnapshot(pageId: string): { page: Page; record: RecordProjection } {
    const read = () => {
      const member = this.member(pageId);
      const page = this.store.get(pageId);
      const owner = this.store.get(member.database_page_id);
      if (
        page.kind !== "page" ||
        page.database !== null ||
        page.deletedAt !== null ||
        page.documentError ||
        owner.kind !== "database" ||
        !owner.database ||
        owner.deletedAt !== null ||
        owner.documentError ||
        !this.store.db
          .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
          .get(owner.id)
      )
        throw new Error(
          "レコードまたは所有データベースを安全に読み込めません。",
        );
      const record = this.projection(pageId);
      if (
        record.revision !== page.revision ||
        record.databasePageId !== owner.id
      )
        throw new Error("レコードの読み取りが一致しません。");
      return { page, record };
    };
    if (this.store.db.isTransaction) return read();
    this.store.db.exec("BEGIN");
    try {
      const result = read();
      this.store.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  create(
    databasePageId: string,
    title: string,
    values: Record<string, FilterValue>,
  ): RecordProjection {
    return this.store.transaction(() => this.createInTransaction(databasePageId, title, values));
  }

  createInTransaction(
    databasePageId: string,
    title: string,
    values: Record<string, FilterValue>,
  ): RecordProjection {
    this.requireTransaction();
    requestSchema.parse({
      type: "update",
      id: databasePageId,
      revision: 0,
      patch: { title },
    });
    const clean = this.validateValues(values, false) as Record<
      string,
      FilterValue
    >;

      const database = this.store.get(databasePageId);
      if (
        database.kind !== "database" ||
        !database.database ||
        database.deletedAt !== null ||
        database.documentError ||
        !this.store.db
          .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
          .get(databasePageId)
      )
        throw new Error("レコードの作成先を開けません。");
      const id = this.store.allocatePageId(),
        now = Date.now();
      const row = this.store.db
        .prepare(
          "SELECT MAX(position) AS position FROM record_memberships WHERE database_page_id=?",
        )
        .get(databasePageId) as { position: number | null };
      const position = (row.position ?? -1) + 1;
      this.store.write(
        {
          id,
          schemaVersion: 1,
          parentId: null,
          title,
          icon: "📄",
          cover: "",
          position,
          doc: blankDoc(),
          kind: "page",
          database: null,
          favorite: false,
          createdAt: now,
          updatedAt: now,
          revision: 0,
          deletedAt: null,
        },
        true,
      );
      this.attachForMigration(id, databasePageId, position, clean);
      return this.projection(id);
  }

  databaseProjection(databasePageId: string): DatabaseProjection {
    const database = this.store.get(databasePageId);
    if (
      !database.database ||
      database.kind !== "database" ||
      database.deletedAt !== null ||
      database.documentError ||
      !this.store.db
        .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
        .get(databasePageId)
    )
      throw new Error("データベースを開けません。");
    const { rows: _rows, ...settings } = database.database;
    const members = this.store.db
      .prepare(
        "SELECT page_id FROM record_memberships WHERE database_page_id=? ORDER BY position,page_id",
      )
      .all(databasePageId) as { page_id: string }[];
    return {
      settings,
      revision: database.revision,
      // Include independently trashed records so the UI can offer restore;
      // normal table/board/calendar/gallery views filter by deletedAt.
      records: members.map((member) => this.projection(member.page_id)),
    };
  }

  updateSettings(
    databasePageId: string,
    revision: number,
    settings: DatabaseSettings,
  ): DatabaseProjection {
    const request = requestSchema.parse({
      type: "database:settings",
      databasePageId,
      revision,
      settings,
    });
    if (request.type !== "database:settings")
      throw new Error("Invalid settings request");
    return this.store.transaction(() => {
      const database = this.store.get(databasePageId);
      if (database.revision !== revision)
        throw new Error("保存の競合を検出しました。");
      if (
        database.kind !== "database" ||
        !database.database ||
        database.deletedAt !== null ||
        database.documentError ||
        !this.store.db
          .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
          .get(databasePageId)
      )
        throw new Error("データベースを保存できません。");
      this.store.recordVersion(database);
      this.store.write({
        ...database,
        database: { ...settings, rows: [] },
        revision: database.revision + 1,
        updatedAt: Date.now(),
      });
      return this.databaseProjection(databasePageId);
    });
  }

  /** Atomic title/value patch and history. Never returns a document snapshot. */
  patch(
    pageId: string,
    databasePageId: string,
    revision: number,
    patch: RecordPatch,
  ): RecordProjection {
    requestSchema.parse({ type: "record:patch", pageId, databasePageId, revision, patch });
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((k) => k !== "title" && k !== "values")
    )
      throw new Error("Invalid record patch");
    const titlePatch = patch.title === undefined ? {} : { title: patch.title };
    requestSchema.parse({
      type: "update",
      id: pageId,
      revision,
      patch: titlePatch,
    });
    const changes =
      patch.values === undefined ? {} : this.validateValues(patch.values, true);
    return this.store.transaction(() => {
      this.store.assertRecordWriteSchema();
      const member = this.member(pageId),
        page = this.store.get(pageId),
        database = this.store.get(databasePageId);
      if (member.database_page_id !== databasePageId)
        throw new Error("Record owner mismatch; original retained");
      if (page.revision !== revision)
        throw new Error(
          "保存の競合を検出しました。再読み込みして変更を確認してください。",
        );
      if (!Number.isSafeInteger(page.revision + 1))
        throw new Error("Record revision limit reached; original retained");
      if (
        page.id !== pageId ||
        page.kind !== "page" ||
        page.database !== null ||
        page.deletedAt !== null ||
        database.id !== databasePageId ||
        database.kind !== "database" ||
        !database.database ||
        database.database.rows.length !== 0 ||
        database.deletedAt !== null ||
        page.documentError ||
        database.documentError ||
        !this.store.db.prepare("SELECT 1 FROM record_databases WHERE database_page_id=?").get(databasePageId)
      )
        throw new Error("削除済みまたは未対応のレコードです。");
      const values = new Map(
        Object.entries(this.parseValues(member.values_json)),
      );
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) values.delete(key);
        else values.set(key, value);
      }
      const nextValues = Object.fromEntries(values);
      if (!fileFits(JSON.stringify(nextValues)))
        throw new Error("Record values exceed the file limit");
      this.store.recordVersion(page);
      this.store.db
        .prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?")
        .run(JSON.stringify(nextValues), pageId);
      this.store.write({
        ...page,
        ...titlePatch,
        updatedAt: Date.now(),
        revision: page.revision + 1,
      });
      return this.projection(pageId);
    });
  }

  /** Restore an understood record version together with its value snapshot. */
  restoreVersion(
    pageId: string,
    versionId: number,
    expectedRevision: number | undefined,
  ): Page {
    return this.store.transaction(() => {
      const member = this.member(pageId);
      const page = this.store.get(pageId);
      const database = this.store.get(member.database_page_id);
      if (expectedRevision === undefined || page.revision !== expectedRevision)
        throw new Error("保存の競合を検出しました。");
      if (
        page.deletedAt ||
        database.deletedAt ||
        page.documentError ||
        database.documentError
      )
        throw new Error("削除済みまたは未対応のレコードです。");
      const row = this.store.db
        .prepare(
          "SELECT v.title,v.doc,r.values_json FROM versions v JOIN record_value_versions r ON r.version_id=v.id WHERE v.pageId=? AND v.id=?",
        )
        .get(pageId, versionId) as
        { title: string; doc: string; values_json: string } | undefined;
      if (!row)
        throw new Error(
          "レコードの完全な履歴がありません。原本を保持しています。",
        );
      let doc: unknown;
      try {
        doc = JSON.parse(row.doc);
      } catch {
        throw new Error("履歴の文書を読めません。原本を保持しています。");
      }
      const values = this.parseValues(row.values_json);
      const request = requestSchema.parse({
        type: "update",
        id: pageId,
        revision: page.revision,
        patch: { title: row.title, doc },
      });
      if (request.type !== "update") throw new Error("Invalid history request");
      this.store.recordVersion(page);
      this.store.db
        .prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?")
        .run(JSON.stringify(values), pageId);
      this.store.write({
        ...page,
        ...request.patch,
        revision: page.revision + 1,
        updatedAt: Date.now(),
      });
      return this.store.get(pageId);
    });
  }

  private member(pageId: string) {
    const row = this.store.db
      .prepare(
        "SELECT database_page_id,values_json FROM record_memberships WHERE page_id=?",
      )
      .get(pageId) as
      { database_page_id: string; values_json: string } | undefined;
    if (!row) throw new Error("Record membership not found");
    return row;
  }

  private parseValues(raw: string): Record<string, FilterValue> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid record values; original retained");
    }
    return this.validateValues(parsed, false) as Record<string, FilterValue>;
  }

  private validateValues(
    input: unknown,
    allowNull: boolean,
  ): Record<string, FilterValue | null> {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      throw new Error("Invalid record values");
    const entries = Object.entries(input);
    if (
      entries.length > 1000 ||
      entries.some(
        ([key, value]) =>
          !key ||
          key.length > 500 ||
          !(
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            (allowNull && value === null)
          ),
      ) ||
      !fileFits(JSON.stringify(input))
    )
      throw new Error("Invalid record values");
    return Object.fromEntries(entries) as Record<string, FilterValue | null>;
  }

  private requireTransaction(): void {
    if (!this.store.db.isTransaction)
      throw new Error("Record schema and migration require a transaction");
  }
}
