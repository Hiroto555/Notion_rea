import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  blankDoc,
  isDocument,
  requestSchema,
  emptyDatabase,
  textOf,
  type Page,
  type PagePatch,
  type Request,
  type Snapshot,
  type Version,
} from "../shared/types";
import { recoveryPages } from "../shared/recovery";
import { normalizeDatabaseData } from "../database/model";
const STORE_VERSION = 3;
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
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
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, data TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL); CREATE INDEX IF NOT EXISTS versions_page ON versions(pageId,createdAt); `,
      );
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
          if (!existsSync(backup))
            this.db.prepare("VACUUM INTO ?").run(backup);
        }
        this.transaction(() => {
          this.migrateStoredDatabases();
          this.db.exec(`PRAGMA user_version=${STORE_VERSION}`);
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
    const pages = this.db
      .prepare("SELECT id,data FROM pages")
      .all() as { id: string; data: string }[];
    for (const row of pages) {
      let page: any;
      try {
        page = JSON.parse(row.data);
      } catch {
        // Corrupt JSON is left byte-for-byte intact for pageSource/recovery.
        continue;
      }
      if (!page || typeof page !== "object" || page.database == null) continue;
      const database = normalizeDatabaseData(page.database);
      // Unknown database versions and malformed values also stay untouched.
      if (!database.ok || !database.migrated) continue;
      this.db
        .prepare("UPDATE pages SET data=? WHERE id=?")
        .run(JSON.stringify({ ...page, database: database.data }), row.id);
    }
    const versions = this.db
      .prepare("SELECT id,database FROM versions WHERE database IS NOT NULL")
      .all() as { id: number; database: string }[];
    for (const row of versions) {
      let value: unknown;
      try {
        value = JSON.parse(row.database);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const database = normalizeDatabaseData(value);
      if (!database.ok || !database.migrated) continue;
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
      if (normalized.ok) database = normalized.data;
      else {
        databaseError = normalized.error;
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
      this.db.exec("ROLLBACK");
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
  write(p: Page) {
    if (
      p.documentError ||
      (p.schemaVersion !== undefined && p.schemaVersion !== 1) ||
      !isDocument(p.doc)
    )
      throw new Error("不正な文書は保存できません。原本を保全しています。");
    let database = p.database === undefined ? null : p.database;
    if (database !== null) {
      const normalized = normalizeDatabaseData(database);
      if (!normalized.ok)
        throw new Error(
          normalized.error + " 不正なデータベースは保存できません。",
        );
      database = normalized.data;
    }
    const page = { ...p, database };
    this.db
      .prepare(
        "INSERT INTO pages(id,data,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,body=excluded.body",
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
    return {
      pages: this.pages(),
      settings: Object.fromEntries(
        (
          this.db.prepare("SELECT key,value FROM settings").all() as {
            key: string;
            value: string;
          }[]
        ).map((r) => [r.key, r.value]),
      ),
    };
  }
  create(
    parentId: string | null,
    kind: Page["kind"] = "page",
    title = "無題",
  ): Page {
    if (parentId && this.get(parentId).deletedAt)
      throw new Error("削除済みの親ページです");
    const now = Date.now();
    return this.write({
      id: randomUUID(),
      schemaVersion: 1,
      parentId,
      title,
      icon: kind === "database" ? "▦" : "📄",
      cover: "",
      position:
        Math.max(
          0,
          ...this.pages()
            .filter((p) => p.parentId === parentId)
            .map((p) => p.position),
        ) + 1,
      doc: blankDoc(),
      kind,
      database: kind === "database" ? emptyDatabase() : null,
      favorite: false,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      deletedAt: null,
    });
  }
  update(id: string, revision: number, patch: PagePatch): Page {
    const parsed = requestSchema.parse({ type: "update", id, revision, patch });
    if (parsed.type !== "update") throw new Error("Unsupported storage request");
    const cleanPatch: PagePatch = parsed.patch;
    return this.transaction(() => {
      const p = this.get(id);
      if (p.revision !== revision)
        throw new Error(
          "保存の競合を検出しました。再読み込みして変更を確認してください。",
        );
      if (p.documentError) throw new Error(p.documentError);
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
    });
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
  move(id: string, parentId: string | null, beforeId: string | null) {
    return this.transaction(() => {
      const p = this.get(id);
      if (parentId) {
        const parent = this.get(parentId);
        if (parent.deletedAt) throw new Error("削除済みの親ページです");
        if (this.descendants(id).has(parentId))
          throw new Error("ページを自身の子孫へ移動できません");
      }
      const siblings = this.pages().filter(
        (x) => x.parentId === parentId && x.id !== id && !x.deletedAt,
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
      const originals = this.pages(),
        ids = this.descendants(id),
        mapping = new Map([...ids].map((x) => [x, randomUUID()]));
      for (const p of originals.filter((p) => ids.has(p.id))) {
        this.write({
          ...p,
          id: mapping.get(p.id)!,
          parentId: p.id === id ? p.parentId : mapping.get(p.parentId!)!,
          title: p.id === id ? p.title + " のコピー" : p.title,
          position: p.position + 0.5,
          revision: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return this.get(mapping.get(id)!);
    });
  }
  trash(id: string) {
    this.transaction(() => {
      const ids = this.descendants(id),
        now = Date.now();
      for (const p of this.pages())
        if (ids.has(p.id) && !p.deletedAt)
          this.write({ ...p, deletedAt: now, revision: p.revision + 1 });
    });
  }
  restore(id: string) {
    this.transaction(() => {
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
            : normalized?.ok
              ? normalized.data
              : (parsed as Version["database"]),
      };
    });
  }
  handle(r: Request): unknown {
    switch (r.type) {
      case "load":
        return this.load();
      case "create":
        return this.create(r.parentId, r.kind, r.title);
      case "update":
        return this.update(r.id, r.revision, r.patch);
      case "move":
        return this.move(r.id, r.parentId, r.beforeId);
      case "duplicate":
        return this.duplicate(r.id);
      case "trash":
        return this.trash(r.id);
      case "restore":
        return this.restore(r.id);
      case "setting":
        this.db
          .prepare(
            "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(r.key, r.value);
        return true;
      case "search": {
        const term = r.query.toLocaleLowerCase();
        return this.pages().filter(
          (p) =>
            !p.deletedAt &&
            [
              p.title,
              p.documentError ? "" : textOf(p.doc),
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
        const v = this.versions(r.id).find((v) => v.id === r.versionId);
        if (!v) throw new Error("履歴がありません");
        return this.update(r.id, this.get(r.id).revision, {
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
    this.db.close();
  }
}
