import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blankDoc,
  isDocument,
  requestSchema,
  saveOperationSchema,
  emptyDatabase,
  textOf,
  type Page,
  type PagePatch,
  type RecordPagePatch,
  type Request,
  type Snapshot,
  type Version,
} from "../shared/types";
import { canonicalOperation, type SaveOperation, type SaveResult } from "../shared/save-contract";
import { fileFits } from "../shared/limits";
import { recoveryPages } from "../shared/recovery";
import { normalizeDatabaseData } from "../database/model";
import { isLosslessDatabaseData } from "../database/strict-database";
import { RecordRepository } from "./record-repository";
import { commitDatabaseOperation, resolveDatabaseOperation, readDatabaseSnapshot } from "./database-operations";
import { RecordLifecycle } from "./record-lifecycle";
import { restoreDatabaseVersion } from "./legacy-database-restore";
import { validateRecordStoreVersion } from "./record-version";
const STORE_VERSION = 4;
export class Store {
  private readonly connection: DatabaseSync;
  private unusable = false;
  private connectionClosed = false;
  get db(): DatabaseSync {
    if (this.unusable)
      throw new Error(
        "SQLite connection is unusable after snapshot transaction failure; reopen the workspace.",
      );
    return this.connection;
  }
  constructor(
    readonly path: string,
    options: { allowIncompleteRecovery?: boolean } = {},
  ) {
    if (
      !options.allowIncompleteRecovery &&
      existsSync(join(dirname(path), "FOLIO-RECOVERY-INCOMPLETE"))
    )
      throw new Error(
        "復旧が完了していないワークスペースです。原本を保護するため起動を停止しました。",
      );
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    try {
      if (
        typeof this.connection.isOpen !== "boolean" ||
        typeof this.connection.isTransaction !== "boolean"
      )
        throw new Error(
          "SQLite connection and transaction state APIs are required",
        );
    } catch (error) {
      try {
        this.connection.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "SQLite state check and close failed",
        );
      }
      throw error;
    }
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const v = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const originalVersion = v.user_version;
    if (originalVersion > STORE_VERSION) {
      this.db.close();
      throw new Error("This workspace requires a newer Folio version.");
    }
    try {
      if (originalVersion === 4) validateRecordStoreVersion(this.db);
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, data TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL); CREATE INDEX IF NOT EXISTS versions_page ON versions(pageId,createdAt); `,
      );
      this.db.exec(`CREATE TABLE IF NOT EXISTS save_receipts (
        operation_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL
      )`);
      if (originalVersion < 2) {
        // A standalone SQLite snapshot makes schema rollback possible. Assets stay
        // beside the original database and are never moved by this migration.
        const backup = path + ".pre-v2.sqlite";
        if (originalVersion === 1 && !existsSync(backup))
          this.db.prepare("VACUUM INTO ?").run(backup);
        this.transaction(() => {
          this.db.exec(
            "ALTER TABLE versions ADD COLUMN database TEXT; PRAGMA user_version=2;",
          );
        });
      }
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, metadata TEXT NOT NULL)",
      );
      if (originalVersion < 3) {
        // v3 changes the shape of page.database only. A VACUUM snapshot of a
        // real v2 workspace is kept before the page/version JSON is rewritten;
        // the rewrite itself and the version bump commit atomically.
        if (originalVersion === 2) {
          const backup = path + ".pre-v3.sqlite";
          if (!existsSync(backup)) this.db.prepare("VACUUM INTO ?").run(backup);
        }
        this.transaction(() => {
          this.migrateStoredDatabases();
          this.db.exec("PRAGMA user_version=3");
        });
      }
    } catch (error) {
      try {
        this.db.close();
      } catch {}
      throw error;
    }
  }
  private migrateStoredDatabases() {
    const protectedPages = new Set<string>();
    const pages = this.db.prepare("SELECT id,data FROM pages").all() as {
      id: string;
      data: string;
    }[];
    for (const row of pages) {
      let page: any;
      try {
        page = JSON.parse(row.data);
      } catch {
        // Corrupt JSON is left byte-for-byte intact for pageSource/recovery.
        protectedPages.add(row.id);
        continue;
      }
      if (!page || typeof page !== "object") {
        protectedPages.add(row.id);
        continue;
      }
      // Keep the whole source unchanged when the page or its document is not
      // understood, matching decode()'s read-only original-preservation rule.
      if (
        (page.schemaVersion !== undefined && page.schemaVersion !== 1) ||
        !isDocument(page.doc)
      ) {
        protectedPages.add(row.id);
        continue;
      }
      if (page.database == null) continue;
      const database = normalizeDatabaseData(page.database);
      // Unknown database versions and malformed values also stay untouched.
      if (!database.ok || !isLosslessDatabaseData(page.database)) {
        protectedPages.add(row.id);
        continue;
      }
      if (!database.migrated) continue;
      this.db
        .prepare("UPDATE pages SET data=? WHERE id=?")
        .run(JSON.stringify({ ...page, database: database.data }), row.id);
    }
    const versions = this.db
      .prepare(
        "SELECT id,pageId,doc,database FROM versions WHERE database IS NOT NULL",
      )
      .all() as { id: number; pageId: string; doc: string; database: string }[];
    for (const row of versions) {
      if (protectedPages.has(row.pageId)) continue;
      let value: unknown;
      try {
        // A history entry with an unknown document must also stay intact.
        if (!isDocument(JSON.parse(row.doc))) continue;
        value = JSON.parse(row.database);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const database = normalizeDatabaseData(value);
      if (!database.ok || !isLosslessDatabaseData(value) || !database.migrated)
        continue;
      this.db
        .prepare("UPDATE versions SET database=? WHERE id=?")
        .run(JSON.stringify(database.data), row.id);
    }
  }
  decode(data: string): Page {
    let p: Page;
    try {
      p = JSON.parse(data);
    } catch {
      throw new Error(
        "ワークスペースに壊れたJSONがあります。原本は変更していません。バックアップを保存してください。",
      );
    }
    if (!p || typeof p !== "object" || !p.id)
      throw new Error("ページを読めません。原本は変更していません。");
    const documentValid =
      (p.schemaVersion === undefined || p.schemaVersion === 1) &&
      isDocument(p.doc);
    let database = p.database === undefined ? null : p.database;
    let databaseError = "";
    if (database !== null) {
      const normalized = normalizeDatabaseData(database);
      if (normalized.ok && isLosslessDatabaseData(database))
        database = normalized.data;
      else {
        databaseError = normalized.ok
          ? "未対応または損失のあるデータベースです。原本を保全し、編集を停止しています。"
          : normalized.error;
        database = null;
      }
    }
    if (documentValid && !databaseError) return { ...p, database };
    return {
      ...p,
      database,
      documentError: documentValid
        ? databaseError
        : "未対応または不正な文書です。原本を保全し、編集を停止しています。",
    };
  }
  transaction<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = f();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      // A COMMIT may have completed before its caller saw an exception. Never
      // overwrite that outcome with a false rollback success. The receipt query
      // remains authoritative; a failed cleanup poisons this connection.
      if (this.connection.isTransaction) {
        try { this.connection.exec("ROLLBACK"); }
        catch (rollbackError) {
          this.unusable = true;
          throw new AggregateError([e, rollbackError], "Write outcome unknown; reopen workspace");
        }
      }
      throw e;
    }
  }
  pages(): Page[] {
    return (
      this.db.prepare("SELECT data FROM pages").all() as { data: string }[]
    )
      .map((r) => this.decode(r.data))
      .sort((a, b) => a.position - b.position);
  }
  get(id: string): Page {
    const r = this.db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!r) throw new Error("ページが見つかりません");
    return this.decode(r.data);
  }
  write(p: Page, createOnly = false) {
    // Do not permit callers holding a normalized or forged Page to overwrite
    // source bytes that decode marks read-only, even for unrelated fields.
    if (!createOnly) {
      const original = this.db
        .prepare("SELECT data FROM pages WHERE id=?")
        .get(p.id) as { data: string } | undefined;
      if (original && this.decode(original.data).documentError)
        throw new Error(
          "未対応または不正な原本は保存できません。原本を保全しています。",
        );
    }
    if (
      p.documentError ||
      (p.schemaVersion !== undefined && p.schemaVersion !== 1) ||
      !isDocument(p.doc)
    )
      throw new Error("不正な文書は保存できません。原本を保全しています。");
    let database = p.database === undefined ? null : p.database;
    if (database !== null) {
      const normalized = normalizeDatabaseData(database);
      if (!normalized.ok || !isLosslessDatabaseData(database))
        throw new Error(
          (normalized.ok
            ? "未対応または損失のあるデータベースです。"
            : normalized.error) + " 不正なデータベースは保存できません。",
        );
      database = normalized.data;
    }
    // Migrated databases have one record store. No generic writer (including
    // legacy recovery) may reintroduce a competing rows array.
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'",
        )
        .get() &&
      this.db
        .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
        .get(p.id) &&
      (p.kind !== "database" || database === null || database.rows.length > 0)
    )
      throw new Error(
        "レコード化済みデータベースには旧形式の行や不正な構造を保存できません。入力は保持されています。",
      );
    const page = { ...p, database };
    this.db
      .prepare(
        createOnly
          ? "INSERT INTO pages(id,data,body) VALUES(?,?,?)"
          : "INSERT INTO pages(id,data,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,body=excluded.body",
      )
      .run(
        page.id,
        JSON.stringify(page),
        [
          page.title,
          textOf(page.doc),
          ...(page.database?.rows.map(
            (r) => r.title + " " + Object.values(r.values).join(" "),
          ) ?? []),
        ].join("\n"),
      );
    return page;
  }
  load(): Snapshot {
    const read = (): Snapshot => {
      const hasRecords = !!this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
        )
        .get();
      const records = hasRecords
        ? (
            this.db
              .prepare(
                "SELECT page_id FROM record_memberships ORDER BY database_page_id,position,page_id",
              )
              .all() as { page_id: string }[]
          ).map((row) => new RecordRepository(this).projection(row.page_id))
        : undefined;
      const recordDatabaseIds = hasRecords
        ? (
            this.db
              .prepare(
                "SELECT database_page_id FROM record_databases ORDER BY database_page_id",
              )
              .all() as { database_page_id: string }[]
          ).map((row) => row.database_page_id)
        : undefined;
      return {
        pages: this.pages(),
        ...(records ? { records, recordDatabaseIds } : {}),
        settings: Object.fromEntries(
          (
            this.db.prepare("SELECT key,value FROM settings").all() as {
              key: string;
              value: string;
            }[]
          ).map((r) => [r.key, r.value]),
        ),
      };
    };
    // Reuse a caller-owned transaction without committing or rolling it back.
    // Otherwise keep all membership, Page and settings reads on one SQLite
    // snapshot; a later caller action still needs its own concurrency checks.
    const activeTransaction = this.readTransactionFlag();
    if (typeof activeTransaction !== "boolean")
      throw new Error(
        "SQLite transaction state is unavailable; snapshot refused",
      );
    if (activeTransaction) return read();
    try {
      this.db.exec("BEGIN");
    } catch (error) {
      this.poisonSnapshotConnection([error], "Snapshot BEGIN failed");
    }
    let snapshot: Snapshot;
    try {
      snapshot = read();
    } catch (error) {
      try {
        const active = this.readTransactionFlag();
        if (typeof active !== "boolean")
          throw new Error(
            "SQLite transaction state is unavailable during rollback",
          );
        if (active) this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        this.poisonSnapshotConnection(
          [error, rollbackError],
          "Snapshot read failed and ROLLBACK failed",
        );
      }
      throw error;
    }
    try {
      this.db.exec("COMMIT");
    } catch (error) {
      this.poisonSnapshotConnection([error], "Snapshot COMMIT failed");
    }
    return snapshot;
  }
  /** A failed transaction-control operation has an uncertain outcome. Never
   * expose this Store connection again, even when closing it also fails. */
  private poisonSnapshotConnection(errors: unknown[], message: string): never {
    this.unusable = true;
    try {
      this.closeConnection();
    } catch (closeError) {
      errors.push(closeError);
    }
    throw new AggregateError(errors, message + "; connection disabled");
  }
  private readTransactionFlag(): unknown {
    return this.db.isTransaction;
  }
  private readConnectionFlag(): unknown {
    return this.connection.isOpen;
  }
  /** A close can succeed and still report an error. Keep the error for the
   * caller, but use SQLite's open-state signal to avoid closing twice. */
  private closeConnection(): void {
    if (this.connectionClosed) return;
    const open = this.readConnectionFlag();
    if (typeof open !== "boolean")
      throw new Error(
        "SQLite connection state is unavailable; close outcome unknown",
      );
    if (!open) {
      this.connectionClosed = true;
      return;
    }
    try {
      this.connection.close();
      this.connectionClosed = true;
    } catch (closeError) {
      try {
        const stillOpen = this.readConnectionFlag();
        if (typeof stillOpen !== "boolean")
          throw new Error("SQLite connection state is unavailable after close");
        if (!stillOpen) this.connectionClosed = true;
      } catch (probeError) {
        throw new AggregateError(
          [closeError, probeError],
          "SQLite close outcome unknown",
        );
      }
      throw closeError;
    }
  }
  /** Allocate away from existing pages and reserved historical row IDs. */
  allocatePageId(
    generate: () => string = randomUUID,
    reserved = new Set<string>(),
  ): string {
    const mapped = !!this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_record_map'",
      )
      .get();
    for (let attempt = 0; attempt < 128; attempt++) {
      const id = generate();
      if (
        !id ||
        reserved.has(id) ||
        this.db.prepare("SELECT 1 FROM pages WHERE id=?").get(id) ||
        (mapped &&
          this.db
            .prepare("SELECT 1 FROM legacy_record_map WHERE page_id=?")
            .get(id))
      )
        continue;
      reserved.add(id);
      return id;
    }
    throw new Error("Unable to allocate a unique page ID");
  }
  create(
    parentId: string | null,
    kind: Page["kind"] = "page",
    title = "無題",
  ): Page {
    const createPage = () => {
      this.assertRecordWriteSchema();
      if (parentId) {
        const parent = this.get(parentId);
        if (parent.deletedAt) throw new Error("削除済みの親ページです");
        if (parent.documentError) throw new Error("未対応の親ページには追加できません。原本を保持しています。");
      }
      if (parentId && this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
      ).get() && (
        this.db.prepare("SELECT 1 FROM record_memberships WHERE page_id=?").get(parentId) ||
        this.db.prepare("SELECT 1 FROM record_databases WHERE database_page_id=?").get(parentId)
      ))
        throw new Error("レコードまたは登録済みデータベースに子ページを追加できません。");
      const siblings = this.pages().filter((page) => page.parentId === parentId);
      const hasRecordSchema = !!this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
      ).get();
      let position: number;
      if (hasRecordSchema) {
        const recordIds = new Set((this.db.prepare("SELECT page_id FROM record_memberships").all() as { page_id: string }[]).map((entry) => entry.page_id));
        // Reserve every non-record sibling's position, including trash, so
        // later restoration cannot collide with a newly created Page.
        const anchors = siblings.filter((page) => !recordIds.has(page.id));
        if (anchors.some((page) => !Number.isFinite(page.position) || page.documentError))
          throw new Error("ページの安全な並び順を確認できません。原本を保持しています。");
        const positions = anchors.map((page) => page.position).sort((a, b) => a - b);
        for (let i = 1; i < positions.length; i++)
          if (positions[i - 1] >= positions[i])
            throw new Error("ページの並び順が重複しています。原本を保持しています。");
        const maximum = positions.reduce((max, value) => Math.max(max, value), 0);
        position = maximum + 1;
        if (!Number.isFinite(position) || position <= maximum || !Object.is(JSON.parse(JSON.stringify(position)), position))
          throw new Error("ページの並び順に空きがありません。原本を保持しています。");
      } else {
        position = Math.max(0, ...siblings.map((page) => page.position)) + 1;
      }
      const now = Date.now();
      return this.write(
        {
          id: this.allocatePageId(),
          schemaVersion: 1,
          parentId,
          title,
          icon: kind === "database" ? "▦" : "📄",
          cover: "",
          position,
          doc: blankDoc(),
          kind,
          database: kind === "database" ? emptyDatabase() : null,
          favorite: false,
          createdAt: now,
          updatedAt: now,
          revision: 0,
          deletedAt: null,
        },
        true,
      );
    };
    // Parent classification and the insert must share a write transaction.
    if (kind !== "database")
      return this.db.isTransaction ? createPage() : this.transaction(createPage);
    const createDatabase = () => {
      // Read the schema version while the write transaction is held, so a
      // concurrent migration cannot switch v3 to v4 between check and insert.
      const version = (
        this.db.prepare("PRAGMA user_version").get() as { user_version: number }
      ).user_version;
      const page = createPage();
      if (version === 4) new RecordRepository(this).registerDatabase(page.id);
      return page;
    };
    if (!this.db.isTransaction) return this.transaction(createDatabase);
    // Savepoints make the Page and its registration atomic even when the
    // outer caller catches an error and continues its own transaction.
    this.db.exec("SAVEPOINT folio_create_record_database");
    try {
      const page = createDatabase();
      this.db.exec("RELEASE SAVEPOINT folio_create_record_database");
      return page;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT folio_create_record_database");
      this.db.exec("RELEASE SAVEPOINT folio_create_record_database");
      throw error;
    }
  }
  update(id: string, revision: number, patch: PagePatch): Page {
    // Validate the untransformed input before requestSchema normalizes it.
    if (patch?.database != null && !isLosslessDatabaseData(patch.database))
      throw new Error(
        "未対応または損失のあるデータベースです。原本を保全しています。",
      );
    const parsed = requestSchema.parse({ type: "update", id, revision, patch });
    if (parsed.type !== "update")
      throw new Error("Unsupported storage request");
    const cleanPatch: PagePatch = parsed.patch;
    return this.transaction(() => this.updatePageInTransaction(id, revision, cleanPatch));
  }
  private updatePageInTransaction(id: string, revision: number, cleanPatch: PagePatch): Page {
      this.assertRecordWriteSchema();
      const p = this.get(id);
      if (p.revision !== revision)
        throw new Error(
          "保存の競合を検出しました。再読み込みして変更を確認してください。",
        );
      if (p.documentError) throw new Error(p.documentError);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
          )
          .get()
      ) {
        const member = this.db
          .prepare(
            "SELECT database_page_id FROM record_memberships WHERE page_id=?",
          )
          .get(id) as { database_page_id: string } | undefined;
        if (member) {
          // Membership is checked under this write transaction, not against
          // a renderer snapshot. Even a Page that became a record after the
          // caller's read must use an owner-bound command.
          throw new Error(
            "レコードの保存には所有データベースの確認が必要です。未保存変更を保持してください。",
          );
        }
      }
      if (
        cleanPatch.database !== undefined &&
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'",
          )
          .get() &&
        this.db
          .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
          .get(id)
      )
        throw new Error(
          "旧形式の行全体の保存はできません。レコード用コマンドを使用してください。",
        );
      if (
        cleanPatch.doc !== undefined ||
        cleanPatch.database !== undefined ||
        cleanPatch.title !== undefined
      )
        this.recordVersion(p);
      return this.write({
        ...p,
        ...cleanPatch,
        updatedAt: Date.now(),
        revision: p.revision + 1,
      });
  }
  /** The Page, record membership and registered live owner are checked under
   * the same write transaction as the revision, history and Page write. */
  updateRecordPage(
    pageId: string,
    databasePageId: string,
    revision: number,
    patch: RecordPagePatch,
  ): Page {
    const parsed = requestSchema.parse({
      type: "record:pageUpdate",
      pageId,
      databasePageId,
      revision,
      patch,
    });
    if (parsed.type !== "record:pageUpdate")
      throw new Error("Invalid record Page update");
    return this.transaction(() => this.updateRecordInTransaction(parsed));
  }
  private updateRecordInTransaction(parsed: {pageId: string; databasePageId: string; revision: number; patch: RecordPagePatch}): Page {
      this.assertRecordWriteSchema();
      if (
        !this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'")
          .get() ||
        !this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'")
          .get()
      )
        throw new Error(
          "レコードの所属を確認できません。未保存変更を保持してください。",
        );
      const member = this.db
        .prepare("SELECT database_page_id FROM record_memberships WHERE page_id=?")
        .get(parsed.pageId) as { database_page_id: string } | undefined;
      if (!member || member.database_page_id !== parsed.databasePageId)
        throw new Error(
          "レコードの所有データベースが変わりました。未保存変更を保持してください。",
        );
      const page = this.get(parsed.pageId);
      const owner = this.get(parsed.databasePageId);
      if (
        page.id !== parsed.pageId ||
        page.kind !== "page" ||
        page.database !== null ||
        page.deletedAt !== null ||
        page.documentError ||
        owner.id !== parsed.databasePageId ||
        owner.kind !== "database" ||
        owner.database === null ||
        owner.database.rows.length !== 0 ||
        owner.deletedAt !== null ||
        owner.documentError ||
        !this.db
          .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
          .get(parsed.databasePageId)
      )
        throw new Error(
          "レコードまたは所有データベースを安全に保存できません。未保存変更を保持してください。",
        );
      if (page.revision !== parsed.revision)
        throw new Error(
          "保存の競合を検出しました。未保存変更を保持してください。",
        );
      // Also validate the original values for metadata-only Page updates; an
      // unknown/malformed record must not be silently treated as understood.
      new RecordRepository(this).projection(page.id);
      if (parsed.patch.doc !== undefined || parsed.patch.title !== undefined)
        this.recordVersion(page);
      return this.write({
        ...page,
        ...parsed.patch,
        updatedAt: Date.now(),
        revision: page.revision + 1,
      });
  }
  /** The synchronous Store is the single IPC execution owner. Resolution is
   * sequenced on that same event loop; an absent receipt still remains unknown
   * (the commit request may not have reached this owner yet). */
  resolveSave(input: SaveOperation): SaveResult {
    const operation = saveOperationSchema.parse(input);
    const fingerprint = createHash("sha256").update(canonicalOperation(operation)).digest("hex");
    return this.readReceipt(operation, fingerprint) ?? this.saveResult(operation, fingerprint, "unknown", "保存結果を確認できません。入力を保持しています。");
  }
  commitSave(input: SaveOperation): SaveResult {
    const operation = saveOperationSchema.parse(input);
    const fingerprint = createHash("sha256").update(canonicalOperation(operation)).digest("hex");
    return this.transaction(() => {
      const receipt = this.readReceipt(operation, fingerprint);
      if (receipt) return receipt;
      let result: SaveResult;
      this.db.exec("SAVEPOINT save_operation");
      try {
        let page: Page;
        if (operation.databasePageId === null) {
          page = this.updatePageInTransaction(operation.pageId, operation.revision, operation.patch);
          result = { ...this.saveResult(operation, fingerprint, "applied"), page };
        } else {
          const repo = new RecordRepository(this);
          // Read under BEGIN IMMEDIATE. Both owner/schema and record revision
          // are rechecked by updateRecordInTransaction before any mutation.
          const before = repo.readSnapshot(operation.pageId);
          if (before.record.databasePageId !== operation.databasePageId)
            throw new Error("レコードの所有データベースが変わりました。未保存変更を保持してください。");
          const values = { ...before.record.values };
          const owner = this.get(operation.databasePageId);
          for (const [key, value] of Object.entries(operation.values ?? {})) {
            const property = owner.database?.properties.find((item) => item.id === key);
            if (!property) throw new Error("プロパティの構成が変わりました。入力を保持しています。");
            if (value !== null && (
              (property.type === "number" && typeof value !== "number") ||
              (property.type === "checkbox" && typeof value !== "boolean") ||
              (["text", "select", "date"].includes(property.type) && typeof value !== "string") ||
              (property.type === "select" && value !== "" && !property.options?.includes(String(value)))
            )) throw new Error("プロパティの種類または選択肢が変わりました。入力を保持しています。");
            if (value === null) delete values[key];
            else values[key] = value;
          }
          if (!fileFits(JSON.stringify(values))) throw new Error("Record values exceed the file limit");
          page = this.updateRecordInTransaction({
            pageId: operation.pageId,
            databasePageId: operation.databasePageId,
            revision: operation.revision,
            patch: operation.patch,
          });
          // Values-only edits also need the pre-edit version. The shared Page
          // method snapshots title/doc changes; other metadata remains intact.
          if (operation.values && operation.patch.doc === undefined && operation.patch.title === undefined)
            this.recordVersion(before.page);
          this.db.prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?")
            .run(JSON.stringify(values), operation.pageId);
          result = { ...this.saveResult(operation, fingerprint, "applied"), page, record: repo.projection(operation.pageId) };
        }
        this.db.exec("RELEASE SAVEPOINT save_operation");
      } catch (error) {
        // A rejection is terminal only after every partial mutation rolled back.
        // Cleanup failures escape and are represented as unknown by the renderer.
        this.db.exec("ROLLBACK TO SAVEPOINT save_operation");
        this.db.exec("RELEASE SAVEPOINT save_operation");
        result = this.saveResult(operation, fingerprint, "rejected", error instanceof Error ? error.message : String(error));
      }
      this.db.prepare("INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)")
        .run(operation.operationId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  private saveResult(operation: SaveOperation, fingerprint: string, status: SaveResult["status"], message?: string): SaveResult {
    return { status, operationId: operation.operationId, sessionId: operation.sessionId, seq: operation.seq, pageId: operation.pageId, fingerprint, ...(message ? {message} : {}) };
  }
  private readReceipt(operation: SaveOperation, fingerprint: string): SaveResult | undefined {
    const receipt = this.db.prepare("SELECT fingerprint,result_json FROM save_receipts WHERE operation_id=?")
      .get(operation.operationId) as {fingerprint: string; result_json: string} | undefined;
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint)
      return this.saveResult(operation, fingerprint, "rejected", "同じ操作IDに異なる要求があります。入力を保持しています。");
    return JSON.parse(receipt.result_json) as SaveResult;
  }
  assertRecordWriteSchema(): void {
    const { user_version: version } = this.db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    if (version !== 3 && version !== 4)
      throw new Error("Incomplete or unsupported record store version");
    if (version === 4) validateRecordStoreVersion(this.db);
    // Experimental record stores can exist under v3. A partial schema must
    // never make a former record look like an ordinary Page to generic update.
    const names = new Set(
      (this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('record_databases','record_memberships','record_value_versions','folio_record_schema')",
        )
        .all() as { name: string }[]).map((row) => row.name),
    );
    if (
      names.size > 0 &&
      ["record_databases", "record_memberships", "record_value_versions"].some(
        (name) => !names.has(name),
      )
    )
      throw new Error("Incomplete or unsupported record store");
    if (names.has("record_memberships")) {
      const expected: Record<string, [string, string, number, number][]> = {
        record_databases: [["database_page_id", "TEXT", 0, 1]],
        record_memberships: [["page_id", "TEXT", 0, 1], ["database_page_id", "TEXT", 1, 0], ["position", "INTEGER", 1, 0], ["values_json", "TEXT", 1, 0]],
        record_value_versions: [["version_id", "INTEGER", 0, 1], ["values_json", "TEXT", 1, 0]],
      };
      for (const [table, columns] of Object.entries(expected)) {
        const actual = this.db.prepare(`PRAGMA table_xinfo(${table})`).all() as {
          name: string; type: string; notnull: number; pk: number; hidden: number; dflt_value: unknown;
        }[];
        if (actual.length !== columns.length || actual.some((column, index) =>
          column.name !== columns[index][0] || column.type.toUpperCase() !== columns[index][1] ||
          column.notnull !== columns[index][2] || column.pk !== columns[index][3] ||
          column.hidden !== 0 || column.dflt_value !== null))
          throw new Error("Incomplete or unsupported record store");
      }
    }
    // A marker is an explicit schema claim even on experimental v3 stores.
    // Never interpret an unknown or ambiguous marker as the known schema.
    // Marker-free v3 stores remain supported for legacy compatibility.
    if (names.has("folio_record_schema"))
      validateRecordStoreVersion(this.db);
  }
  recordVersion(p: Page) {
    this.db
      .prepare(
        "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
      )
      .run(
        p.id,
        Date.now(),
        p.title,
        JSON.stringify(p.doc),
        JSON.stringify(p.database),
      );
    // Only the experimental migration creates these tables. A body/title
    // snapshot of a record must capture its values in the same transaction.
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
        )
        .get()
    ) {
      const member = this.db
        .prepare("SELECT values_json FROM record_memberships WHERE page_id=?")
        .get(p.id) as { values_json: string } | undefined;
      if (member) {
        // Refuse a body/title save when its value source is malformed. The
        // caller's transaction rolls back the preceding version insertion.
        new RecordRepository(this).projection(p.id);
        const version = this.db
          .prepare("SELECT last_insert_rowid() AS id")
          .get() as { id: number };
        this.db
          .prepare(
            "INSERT INTO record_value_versions(version_id,values_json) VALUES(?,?)",
          )
          .run(version.id, member.values_json);
      }
    }
    this.db
      .prepare(
        "DELETE FROM versions WHERE pageId=? AND id NOT IN(SELECT id FROM versions WHERE pageId=? ORDER BY id DESC LIMIT 100)",
      )
      .run(p.id, p.id);
  }
  descendants(id: string): Set<string> {
    const ids = new Set([id]),
      pages = this.pages();
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of pages)
        if (p.parentId && ids.has(p.parentId) && !ids.has(p.id)) {
          ids.add(p.id);
          changed = true;
        }
    }
    return ids;
  }
  /** Existing hierarchy-only operations cannot safely mutate record ownership. */
  private assertLegacyLifecycleSafe(ids: Set<string>): void {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'",
        )
        .get()
    )
      return;
    for (const id of ids) {
      if (
        this.db
          .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
          .get(id) ||
        this.db
          .prepare("SELECT 1 FROM record_memberships WHERE page_id=?")
          .get(id)
      )
        throw new Error(
          "レコード対応の操作が未実装のため、変更せず停止しました。",
        );
    }
  }
  /** A mixed record-store move rewrites a Page. Reject unknown or lossy raw
   * JSON rather than changing future fields or rounded numbers. This is
   * deliberately conservative and may refuse noncanonical legacy JSON. */
  private assertLosslessMovePage(id: string): void {
    const row = this.db.prepare("SELECT data FROM pages WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new Error("ページが見つかりません");
    let source: unknown;
    try { source = JSON.parse(row.data); } catch { throw new Error("未対応のページ原本は移動できません。"); }
    const allowed = new Set(["id", "schemaVersion", "parentId", "title", "icon", "cover", "position", "doc", "kind", "database", "favorite", "createdAt", "updatedAt", "revision", "deletedAt", "recoveredFrom"]);
    if (!source || typeof source !== "object" || Array.isArray(source) ||
        Object.keys(source).some((key) => !allowed.has(key)) || JSON.stringify(source) !== row.data ||
        JSON.stringify(this.decode(row.data)) !== row.data)
      throw new Error("未対応のページ原本は移動できません。");
    const value = source as Record<string, unknown>;
    const validTime = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0;
    const validId = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 500;
    if (value.id !== id || !validId(value.id) ||
        (value.schemaVersion !== undefined && value.schemaVersion !== 1) ||
        !(value.parentId === null || validId(value.parentId)) ||
        typeof value.title !== "string" || value.title.length > 500 ||
        typeof value.icon !== "string" || value.icon.length > 16 ||
        typeof value.cover !== "string" || value.cover.length > 500 ||
        typeof value.position !== "number" || !Number.isFinite(value.position) ||
        !isDocument(value.doc) || !(value.kind === "page" || value.kind === "database") ||
        (value.kind === "page" && value.database != null) ||
        (value.kind === "database" && (value.database == null || !isLosslessDatabaseData(value.database))) ||
        typeof value.favorite !== "boolean" || !validTime(value.createdAt) || !validTime(value.updatedAt) ||
        !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
        !(value.deletedAt === null || validTime(value.deletedAt)))
      throw new Error("未対応のページ原本は移動できません。");
    const stack: unknown[] = [source];
    while (stack.length) {
      const value = stack.pop();
      if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
        throw new Error("未対応のページ原本は移動できません。");
      if (value && typeof value === "object") stack.push(...Object.values(value));
    }
    const recovered = (source as { recoveredFrom?: unknown }).recoveredFrom;
    if (recovered !== undefined && (!recovered || typeof recovered !== "object" || Array.isArray(recovered) ||
        !validId((recovered as Record<string, unknown>).pageId) ||
        !validTime((recovered as Record<string, unknown>).recoveredAt) ||
        Object.keys(recovered).some((key) => key !== "pageId" && key !== "recoveredAt")))
      throw new Error("未対応のページ原本は移動できません。");
  }
  move(id: string, parentId: string | null, beforeId: string | null) {
    return this.transaction(() => {
      this.assertRecordWriteSchema();
      const hasMemberships = !!this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
        )
        .get();
      const recordIds = new Set(
        hasMemberships
          ? (this.db.prepare("SELECT page_id FROM record_memberships").all() as {
              page_id: string;
            }[]).map((member) => member.page_id)
          : [],
      );
      const registeredDatabases = new Set(
        hasMemberships
          ? (this.db.prepare("SELECT database_page_id FROM record_databases").all() as {
              database_page_id: string;
            }[]).map((owner) => owner.database_page_id)
          : [],
      );
      const protectedIds = new Set([...recordIds, ...registeredDatabases]);
      if (protectedIds.has(id))
        throw new Error("レコードまたは登録済みデータベースの移動は未対応です。");
      if ((parentId && protectedIds.has(parentId)) || (beforeId && recordIds.has(beforeId)))
        throw new Error("レコードまたは登録済みデータベースを移動先には指定できません。");
      if ([...this.descendants(id)].some((childId) => protectedIds.has(childId)))
        throw new Error("レコードまたは登録済みデータベースを含むページの移動は未対応です。");
      const p = this.get(id);
      if (hasMemberships) this.assertLosslessMovePage(id);
      if (parentId) {
        const parent = this.get(parentId);
        if (parent.deletedAt) throw new Error("削除済みの親ページです");
        if (this.descendants(id).has(parentId))
          throw new Error("ページを自身の子孫へ移動できません");
      }
      if (hasMemberships) {
        // Record Pages are hidden from the tree. Registered DBs are fixed
        // anchors: moving an ordinary Page must not rewrite their revision or
        // create an equal-position tie that can reorder the visible tree.
        // Reserve all trashed Page positions too, so restore cannot introduce a tie.
        const siblings = this.pages().filter((x) =>
          x.parentId === parentId && x.id !== id && !recordIds.has(x.id),
        );
        if (p.deletedAt !== null || !Number.isSafeInteger(p.revision) ||
            p.revision < 0 || p.revision >= Number.MAX_SAFE_INTEGER ||
            siblings.some((x) => !Number.isFinite(x.position) || x.documentError))
          throw new Error("ページの安全な並び順を確認できません。原本を保持しています。");
        for (let i = 1; i < siblings.length; i++)
          if (siblings[i - 1].position >= siblings[i].position)
            throw new Error("ページの並び順が重複しています。原本を保持しています。");
        const index = beforeId ? siblings.findIndex((x) => x.id === beforeId && !x.deletedAt) : siblings.length;
        if (index < 0) throw new Error("移動先が見つかりません");
        const lower = index > 0 ? siblings[index - 1].position : undefined;
        const upper = index < siblings.length ? siblings[index].position : undefined;
        const position = lower === undefined && upper === undefined ? 0 :
          lower === undefined ? upper! - 1 : upper === undefined ? lower + 1 : lower / 2 + upper / 2;
        if (!Number.isFinite(position) || !Object.is(JSON.parse(JSON.stringify(position)), position) ||
            (lower !== undefined && position <= lower) ||
            (upper !== undefined && position >= upper))
          throw new Error("ページの並び順に空きがありません。原本を保持しています。");
        return this.write({ ...p, parentId, position, revision: p.revision + 1, updatedAt: Date.now() });
      }
      const siblings = this.pages().filter(
        (x) => x.parentId === parentId && x.id !== id && !x.deletedAt && !recordIds.has(x.id),
      );
      let index = beforeId
        ? siblings.findIndex((x) => x.id === beforeId)
        : siblings.length;
      if (index < 0) throw new Error("移動先が見つかりません");
      siblings.splice(index, 0, { ...p, parentId });
      siblings.forEach((x, i) =>
        this.write({
          ...x,
          position: i,
          revision: x.revision + 1,
          updatedAt: Date.now(),
        }),
      );
      return this.get(id);
    });
  }
  duplicate(id: string) {
    return this.transaction(() => {
      this.assertLegacyLifecycleSafe(this.descendants(id));
      const originals = this.pages(),
        ids = this.descendants(id),
        reserved = new Set<string>(),
        mapping = new Map(
          [...ids].map((x) => [x, this.allocatePageId(randomUUID, reserved)]),
        );
      for (const p of originals.filter((p) => ids.has(p.id))) {
        this.write(
          {
            ...p,
            id: mapping.get(p.id)!,
            parentId: p.id === id ? p.parentId : mapping.get(p.parentId!)!,
            title: p.id === id ? p.title + " のコピー" : p.title,
            position: p.position + 0.5,
            revision: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          true,
        );
      }
      return this.get(mapping.get(id)!);
    });
  }
  trash(id: string) {
    this.transaction(() => {
      this.assertLegacyLifecycleSafe(this.descendants(id));
      const ids = this.descendants(id),
        now = Date.now();
      for (const p of this.pages())
        if (ids.has(p.id) && !p.deletedAt)
          this.write({ ...p, deletedAt: now, revision: p.revision + 1 });
    });
  }
  restore(id: string) {
    this.transaction(() => {
      this.assertLegacyLifecycleSafe(this.descendants(id));
      const root = this.get(id),
        stamp = root.deletedAt;
      for (const p of this.pages())
        if (this.descendants(id).has(p.id) && p.deletedAt === stamp) {
          const parentGone =
            p.parentId &&
            this.get(p.parentId).deletedAt &&
            (p.id === id || this.get(p.parentId).deletedAt !== stamp);
          this.write({
            ...p,
            parentId: parentGone ? null : p.parentId,
            deletedAt: null,
            revision: p.revision + 1,
          });
        }
    });
  }
  versions(id: string): Version[] {
    return (
      this.db
        .prepare("SELECT * FROM versions WHERE pageId=? ORDER BY id DESC")
        .all(id) as unknown as (Omit<Version, "doc" | "database"> & {
        doc: string;
        database: string | null;
      })[]
    ).map((v) => {
      const parsed = v.database === null ? undefined : JSON.parse(v.database);
      const normalized =
        parsed === undefined ? undefined : normalizeDatabaseData(parsed);
      return {
        ...v,
        doc: JSON.parse(v.doc),
        database:
          parsed === undefined
            ? undefined
            : normalized?.ok && isLosslessDatabaseData(parsed)
              ? normalized.data
              : (parsed as Version["database"]),
      };
    });
  }
  handle(r: Request): unknown {
    switch (r.type) {
      case "database:commit":
        return commitDatabaseOperation(this, r.operation);
      case "database:resolve":
        return resolveDatabaseOperation(this, r.operation);
      case "database:read":
        return readDatabaseSnapshot(this, r.databasePageId);
      case "save:commit":
        return this.commitSave(r.operation);
      case "save:resolve":
        return this.resolveSave(r.operation);
      case "load":
        return this.load();
      case "record:get":
        return new RecordRepository(this).projection(r.pageId);
      case "record:read":
        return new RecordRepository(this).readSnapshot(r.pageId);
      case "record:pageUpdate":
        return this.updateRecordPage(
          r.pageId,
          r.databasePageId,
          r.revision,
          r.patch,
        );
      case "database:load":
        return new RecordRepository(this).databaseProjection(r.databasePageId);
      case "database:settings":
        return new RecordRepository(this).updateSettings(
          r.databasePageId,
          r.revision,
          r.settings,
        );
      case "record:create":
        return new RecordRepository(this).create(
          r.databasePageId,
          r.title,
          r.values as Record<string, string | number | boolean>,
        );
      case "record:patch":
        return new RecordRepository(this).patch(r.pageId, r.databasePageId, r.revision, r.patch);
      case "record:trash":
        return new RecordLifecycle(this).trashRecord(r.pageId, r.revision);
      case "record:restore":
        return new RecordLifecycle(this).restoreRecord(r.pageId, r.revision);
      case "record:duplicate":
        return new RecordLifecycle(this).duplicateRecord(r.pageId, r.revision);
      case "create":
        return this.create(r.parentId, r.kind, r.title);
      case "update":
        return this.update(r.id, r.revision, r.patch);
      case "move":
        return this.move(r.id, r.parentId, r.beforeId);
      case "duplicate":
      case "trash":
      case "restore": {
        const registered = !!this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'",
          )
          .get();
        const database =
          registered &&
          !!this.db
            .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
            .get(r.id);
        const record =
          registered &&
          !!this.db
            .prepare("SELECT 1 FROM record_memberships WHERE page_id=?")
            .get(r.id);
        if (database || record) {
          const lifecycle = new RecordLifecycle(this),
            revision = this.get(r.id).revision;
          if (r.type === "trash")
            return database
              ? lifecycle.trashDatabase(r.id, revision)
              : lifecycle.trashRecord(r.id, revision);
          if (r.type === "restore")
            return database
              ? lifecycle.restoreDatabase(r.id, revision)
              : lifecycle.restoreRecord(r.id, revision);
          if (database) return lifecycle.duplicateDatabase(r.id, revision);
          const copy = lifecycle.duplicateRecord(r.id, revision);
          return this.get(copy.pageId);
        }
        if (r.type === "duplicate") return this.duplicate(r.id);
        if (r.type === "trash") return this.trash(r.id);
        return this.restore(r.id);
      }
      case "setting":
        this.db
          .prepare(
            "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(r.key, r.value);
        return true;
      case "search": {
        const term = r.query.toLocaleLowerCase();
        const hasRecords = !!this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
          )
          .get();
        const values = new Map<string, string>();
        if (hasRecords) {
          const repo = new RecordRepository(this);
          for (const row of this.db
            .prepare("SELECT page_id FROM record_memberships")
            .all() as { page_id: string }[]) {
            const record = repo.projection(row.page_id);
            values.set(row.page_id, Object.values(record.values).join(" "));
          }
        }
        return this.pages().filter(
          (p) =>
            !p.deletedAt &&
            [
              p.title,
              p.documentError ? "" : textOf(p.doc),
              values.get(p.id) ?? "",
              ...(p.database?.rows.map(
                (x) => x.title + " " + Object.values(x.values).join(" "),
              ) ?? []),
            ]
              .join("\n")
              .toLocaleLowerCase()
              .includes(term),
        );
      }
      case "pageSource":
        return (
          this.db.prepare("SELECT data FROM pages WHERE id=?").get(r.id) as
            { data: string } | undefined
        )?.data;
      case "versions":
        return this.versions(r.id);
      case "restoreVersion": {
        if (
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'",
            )
            .get() &&
          this.db
            .prepare("SELECT 1 FROM record_memberships WHERE page_id=?")
            .get(r.id)
        )
          return new RecordRepository(this).restoreVersion(
            r.id,
            r.versionId,
            r.revision,
          );
        if (
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'",
            )
            .get() &&
          this.db
            .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
            .get(r.id)
        )
          return restoreDatabaseVersion(this, r.id, r.versionId, r.revision);
        const v = this.versions(r.id).find((v) => v.id === r.versionId);
        if (!v) throw new Error("履歴がありません");
        return this.update(r.id, r.revision ?? this.get(r.id).revision, {
          doc: v.doc,
          title: v.title,
          ...(v.database === undefined ? {} : { database: v.database }),
        });
      }
      default:
        throw new Error("Unsupported storage request");
    }
  }
  recover(input: unknown): Page[] {
    const pages = recoveryPages(input);
    return this.transaction(() =>
      pages.map((local) => {
        const copy = this.create(null, local.kind, local.title);
        return this.write({
          ...copy,
          title: local.title,
          doc: local.doc,
          database: local.database,
          icon: local.icon,
          cover: local.cover,
          favorite: local.favorite,
          recoveredFrom: { pageId: local.id, recoveredAt: Date.now() },
        });
      }),
    );
  }
  close() {
    this.closeConnection();
  }
}
