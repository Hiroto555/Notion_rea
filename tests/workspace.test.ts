import { it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/persistence/store";
import { workspacePath, migrateWorkspace, backupWorkspace } from "../src/persistence/workspace";
import { attachFile, resolveAsset } from "../src/persistence/assets";
import { parseAssetURL } from "../src/shared/assets";
const roots: string[] = [];
const stores: Store[] = [];
function root() {
  const r = mkdtempSync(resolve("output/gate-a-workspace-"));
  roots.push(r);
  return r;
}
function store(dir: string) {
  const s = new Store(join(dir, "workspace.sqlite"));
  stores.push(s);
  mkdirSync(join(dir, "assets"), { recursive: true });
  return s;
}
const hash = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("F03 default workspace is inside userData; explicit override wins", () => {
  const userData = "/profiles/example/Library/Application Support/Folio";
  expect(workspacePath(userData)).toBe(userData + "/workspace");
  expect(workspacePath(userData, "/test/isolated")).toBe("/test/isolated");
});
it("refuses to copy an incomplete recovery without creating either destination", () => {
  const r = root(), source = join(r, "incomplete"), s = store(source);
  s.create(null);
  s.close();
  const marker = join(source, "FOLIO-RECOVERY-INCOMPLETE");
  writeFileSync(marker, "do not open");
  const backup = join(r, "backup"), destination = join(r, "destination");
  expect(() => backupWorkspace(source, backup)).toThrow(/未完了/);
  expect(() => migrateWorkspace(source, destination)).toThrow(/未完了/);
  expect(existsSync(backup)).toBe(false);
  expect(existsSync(destination)).toBe(false);
  expect(readFileSync(marker, "utf8")).toBe("do not open");
});
it("F03 migration and backup restoration preserve pages, DB rows and attachment bytes, retaining original", () => {
  const r = root(),
    source = join(r, "old-release"),
    s = store(source);
  const p = s.create(null, "database", "Migration");
  const db = {
    ...p.database!,
    rows: [{ id: "original-row", title: "原本", values: { cost: 19 } }],
  };
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "移行する本文", marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
  s.update(p.id, 0, { database: db, doc });
  const file = join(r, "資料.長い拡張子");
  writeFileSync(file, Buffer.from([0, 255, 13, 10]));
  const attachment = attachFile(s.db, join(source, "assets"), file);
  expect(attachment.sha256).toBe(
    hash(join(source, "assets", attachment.storageName)),
  );
  s.close();
  const before = hash(join(source, "workspace.sqlite"));
  const result = migrateWorkspace(source, join(r, "new-workspace"));
  expect(hash(join(source, "workspace.sqlite"))).toBe(before);
  rmSync(source, { recursive: true });
  for (const directory of [
    result.destination,
    result.backup,
    migrateWorkspace(result.backup, join(r, "restored")).destination,
  ]) {
    const copy = store(directory);
    expect(copy.get(p.id).database).toEqual(db);
    expect(copy.get(p.id).doc).toEqual(doc);
    expect(copy.get(p.id).revision).toBe(1);
    expect(
      readFileSync(
        resolveAsset(copy.db, join(directory, "assets"), attachment.url).path,
      ),
    ).toEqual(readFileSync(file));
  }
});
it("F03 migration refuses existing targets, corrupt SQLite and symlinks without replacing source", () => {
  const r = root(),
    source = join(r, "old"),
    s = store(source);
  s.create(null);
  s.close();
  const existing = join(r, "existing");
  mkdirSync(existing);
  writeFileSync(join(existing, "sentinel"), "keep");
  expect(() => migrateWorkspace(source, existing)).toThrow(/移行先/);
  expect(readFileSync(join(existing, "sentinel"), "utf8")).toBe("keep");
  symlinkSync(join(existing, "sentinel"), join(source, "assets", "link"));
  expect(() => migrateWorkspace(source, join(r, "rejected"))).toThrow(
    /シンボリック/,
  );
  expect(existsSync(join(r, "rejected"))).toBe(false);
  const corrupt = join(r, "corrupt");
  mkdirSync(join(corrupt, "assets"), { recursive: true });
  writeFileSync(join(corrupt, "workspace.sqlite"), "not sqlite");
  expect(() => migrateWorkspace(corrupt, join(r, "bad"))).toThrow();
  expect(existsSync(join(r, "bad"))).toBe(false);
  expect(readFileSync(join(corrupt, "workspace.sqlite"), "utf8")).toBe(
    "not sqlite",
  );
});
it("F04 v1 migration keeps legacy document history and takes a rollback snapshot", () => {
  const r = root(),
    file = join(r, "workspace.sqlite"),
    legacy = new DatabaseSync(file);
  legacy.exec(
    "CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL); PRAGMA user_version=1;",
  );
  legacy
    .prepare("INSERT INTO versions(pageId,createdAt,title,doc) VALUES(?,?,?,?)")
    .run("old", 1, "旧履歴", '{"type":"doc","content":[{"type":"paragraph"}]}');
  legacy.close();
  const s = store(r);
  expect(s.versions("old")[0].database).toBeUndefined();
  expect(s.versions("old")[0].title).toBe("旧履歴");
  const backup = new DatabaseSync(file + ".pre-v2.sqlite", { readOnly: true });
  expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(backup.prepare("SELECT count(*) AS n FROM versions").get()?.n).toBe(1);
  backup.close();
});
it("F05 safe legacy URLs still resolve Unicode and extensionless files; traversal and symlinks fail", () => {
  const r = root(),
    s = store(r),
    id = "12345678-1234-1234-1234-123456789abc";
  for (const suffix of ["", ".txt", ".日本語", ".abcdefghijklmnop"]) {
    const name = id + suffix;
    writeFileSync(join(r, "assets", name), "legacy");
    const url = "folio-asset://" + name;
    expect(
      readFileSync(resolveAsset(s.db, join(r, "assets"), url).path, "utf8"),
    ).toBe("legacy");
  }
  for (const url of [
    "file:///etc/passwd",
    "folio-asset://" + id + "/../secret",
    "folio-asset://" + id + "%2f..%2fsecret",
    "folio-asset://" + id + "?path=x",
    "folio-asset://user@" + id,
  ])
    expect(parseAssetURL(url)).toBe(null);
  const other = "abcdefab-1234-1234-1234-123456789abc";
  symlinkSync(join(r, "workspace.sqlite"), join(r, "assets", other));
  expect(() =>
    resolveAsset(s.db, join(r, "assets"), "folio-asset://" + other),
  ).toThrow();
});
it("rejects symlinked migration roots, DB and assets without modifying source", () => {
  const r = root(), source = join(r, "source"), s = store(source);
  s.create(null); s.close();
  const before = hash(join(source, "workspace.sqlite"));
  symlinkSync(source, join(r, "source-link"));
  expect(() => migrateWorkspace(join(r, "source-link"), join(r, "dest1"))).toThrow(/シンボリック/);
  const realAssets = join(r, "real-assets");
  rmSync(join(source, "assets"), { recursive: true }); mkdirSync(realAssets);
  writeFileSync(join(realAssets, "file"), "attachment");
  symlinkSync(realAssets, join(source, "assets"));
  expect(() => migrateWorkspace(source, join(r, "dest2"))).toThrow(/シンボリック/);
  expect(hash(join(source, "workspace.sqlite"))).toBe(before);
  expect(readFileSync(join(realAssets, "file"), "utf8")).toBe("attachment");
  expect(existsSync(join(r, "dest2"))).toBe(false);
  rmSync(join(source, "assets")); mkdirSync(join(source, "assets"));
  const actualDb = join(r, "actual.sqlite");
  renameSync(join(source, "workspace.sqlite"), actualDb);
  symlinkSync(actualDb, join(source, "workspace.sqlite"));
  expect(() => migrateWorkspace(source, join(r, "dest3"))).toThrow(/シンボリック/);
  expect(hash(actualDb)).toBe(before);
  expect(existsSync(join(r, "dest3"))).toBe(false);
});
