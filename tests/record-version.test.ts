import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { convertLegacyRecordsInTransaction } from "../src/persistence/record-migration";

it("keeps v3 readable, rejects an incomplete v4, and rolls back an unknown record marker", () => {
  const root = mkdtempSync(resolve("output/record-version-"));
  const path = join(root, "workspace.sqlite");
  let store: Store | undefined;
  try {
    store = new Store(path);
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    const db = store.create(null, "database", "fixture");
    store.db.exec(
      "CREATE TABLE folio_record_schema(version INTEGER NOT NULL); INSERT INTO folio_record_schema VALUES(99)",
    );
    const before = store.db
      .prepare("SELECT data FROM pages WHERE id=?")
      .get(db.id)?.data;
    expect(() =>
      store!.transaction(() => convertLegacyRecordsInTransaction(store!)),
    ).toThrow("unsupported record store");
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(
      store.db.prepare("SELECT data FROM pages WHERE id=?").get(db.id)?.data,
    ).toBe(before);
    store.db.exec("PRAGMA user_version=4");
    store.close();
    store = undefined;
    expect(() => new Store(path)).toThrow("unsupported record store");
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    } finally {
      raw.close();
    }
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("the fetched old Store rejects a synthetic v4 sentinel and can open the pre-conversion snapshot", () => {
  const root = mkdtempSync(resolve("output/old-store-boundary-"));
  const source = join(root, "source"),
    oldBundle = join(root, "old-store.cjs"),
    path = join(root, "workspace.sqlite"),
    snapshot = join(root, "snapshot.sqlite"),
    sentinel = join(root, "sentinel.sqlite");
  let store: Store | undefined;
  try {
    execFileSync("mkdir", [source]);
    const archive = execFileSync(
      "git",
      ["archive", "bd0f1e753258b8f29c3a436753f3bad9a1f84b16", "src"],
      { maxBuffer: 20_000_000 },
    );
    execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
    buildSync({
      entryPoints: [join(source, "src/persistence/store.ts")],
      outfile: oldBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      logLevel: "silent",
    });
    store = new Store(path);
    const db = store.create(null, "database", "legacy");
    store.update(db.id, 0, {
      database: {
        ...db.database!,
        rows: [{ id: "legacy-row", title: "safe", values: {} }],
      },
    });
    store.db.prepare("VACUUM INTO ?").run(snapshot);
    store.transaction(() => convertLegacyRecordsInTransaction(store!));
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
    store.close();
    store = undefined;
    const s = new DatabaseSync(sentinel);
    s.exec("PRAGMA user_version=4");
    s.close();
    const script = `const {Store}=require(process.argv[1]); try { const s=new Store(process.argv[2]); console.log(s.get(process.argv[3]).database.rows[0].title); s.close(); } catch(e) { console.error(e.message); process.exit(3); }`;
    const oldResult = execFileSync(
      process.execPath,
      ["-e", script, oldBundle, snapshot, db.id],
      { encoding: "utf8" },
    );
    expect(oldResult.trim()).toBe("safe");
    try {
      execFileSync(
        process.execPath,
        ["-e", script, oldBundle, sentinel, "unused"],
        { encoding: "utf8", stdio: "pipe" },
      );
      throw new Error("old Store unexpectedly opened v4");
    } catch (error: any) {
      expect(error.status).toBe(3);
      expect(String(error.stderr)).toContain("requires a newer Folio version");
    }
    expect(readFileSync(snapshot).length).toBeGreaterThan(0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
