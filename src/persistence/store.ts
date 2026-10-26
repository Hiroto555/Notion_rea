import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  blankDoc,
  emptyDatabase,
  textOf,
  type Page,
  type PagePatch,
  type Request,
  type Snapshot,
  type Version,
} from "../shared/types";
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
    if (v.user_version > 1)
      throw new Error("This workspace requires a newer Folio version.");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY, data TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL); CREATE INDEX IF NOT EXISTS versions_page ON versions(pageId,createdAt); PRAGMA user_version=1;`,
    );
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
      .map((r) => JSON.parse(r.data) as Page)
      .sort((a, b) => a.position - b.position);
  }
  get(id: string): Page {
    const r = this.db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
      { data: string } | undefined;
    if (!r) throw new Error("ページが見つかりません");
    return JSON.parse(r.data) as Page;
  }
  write(p: Page) {
    this.db
      .prepare(
        "INSERT INTO pages(id,data,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,body=excluded.body",
      )
      .run(
        p.id,
        JSON.stringify(p),
        [
          p.title,
          textOf(p.doc),
          ...(p.database?.rows.map(
            (r) => r.title + " " + Object.values(r.values).join(" "),
          ) ?? []),
        ].join("\n"),
      );
    return p;
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
    return this.transaction(() => {
      const p = this.get(id);
      if (p.revision !== revision)
        throw new Error(
          "保存の競合を検出しました。再読み込みして変更を確認してください。",
        );
      if (patch.doc) this.recordVersion(p);
      return this.write({
        ...p,
        ...patch,
        updatedAt: Date.now(),
        revision: p.revision + 1,
      });
    });
  }
  recordVersion(p: Page) {
    this.db
      .prepare(
        "INSERT INTO versions(pageId,createdAt,title,doc) VALUES(?,?,?,?)",
      )
      .run(p.id, Date.now(), p.title, JSON.stringify(p.doc));
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
        .all(id) as unknown as (Omit<Version, "doc"> & { doc: string })[]
    ).map((v) => ({ ...v, doc: JSON.parse(v.doc) }));
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
              textOf(p.doc),
              ...(p.database?.rows.map(
                (x) => x.title + " " + Object.values(x.values).join(" "),
              ) ?? []),
            ]
              .join("\n")
              .toLocaleLowerCase()
              .includes(term),
        );
      }
      case "versions":
        return this.versions(r.id);
      case "restoreVersion": {
        const v = this.versions(r.id).find((v) => v.id === r.versionId);
        if (!v) throw new Error("履歴がありません");
        return this.update(r.id, this.get(r.id).revision, {
          doc: v.doc,
          title: v.title,
        });
      }
      default:
        throw new Error("Unsupported storage request");
    }
  }
  close() {
    this.db.close();
  }
}
