import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createMigrationSnapshot } from "../src/persistence/migration-snapshot";

function fixture() {
  const root = mkdtempSync(resolve("output/migration-snapshot-"));
  const assets = join(root, "assets"),
    dest = join(root, "snapshot");
  mkdirSync(assets);
  const db = new DatabaseSync(join(root, "workspace.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=3; CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,metadata TEXT);",
  );
  const bytes = Buffer.from("synthetic attachment bytes");
  writeFileSync(join(assets, "synthetic-id"), bytes);
  db.prepare("INSERT INTO assets VALUES(?,?)").run(
    "synthetic-id",
    JSON.stringify({
      id: "synthetic-id",
      storageName: "synthetic-id",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  return {
    root,
    assets,
    dest,
    db,
    bytes,
    dispose() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Simulate another actor adding an entry after exclusive directory creation. */
function afterSnapshot(db: DatabaseSync, callback: () => void): DatabaseSync {
  return {
    get isTransaction() { return db.isTransaction; },
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        run(path: string) {
          const result = statement.run(path);
          callback();
          return result;
        },
      };
    },
  } as unknown as DatabaseSync;
}

describe("migration snapshot", () => {
  it("captures committed WAL data and verified attachments, and never replaces an existing snapshot", () => {
    const f = fixture();
    try {
      f.db
        .prepare("INSERT INTO pages VALUES(?,?)")
        .run("wal-page", "committed WAL data");
      expect(existsSync(join(f.root, "workspace.sqlite-wal"))).toBe(true);
      createMigrationSnapshot(f.db, f.assets, f.dest);
      const copy = new DatabaseSync(join(f.dest, "workspace.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          copy.prepare("SELECT data FROM pages WHERE id='wal-page'").get()
            ?.data,
        ).toBe("committed WAL data");
        expect(copy.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
        expect(
          copy.prepare("PRAGMA integrity_check").get()?.integrity_check,
        ).toBe("ok");
      } finally {
        copy.close();
      }
      expect(readFileSync(join(f.dest, "assets", "synthetic-id"))).toEqual(
        f.bytes,
      );
      expect(readFileSync(join(f.assets, "synthetic-id"))).toEqual(f.bytes);
      const manifest = readFileSync(join(f.dest, "manifest.json"), "utf8");
      expect(JSON.parse(manifest)).toMatchObject({
        format: "folio-pre-migration-snapshot",
        consistency: "requires-exclusive-workspace",
      });
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow();
      expect(readFileSync(join(f.dest, "manifest.json"), "utf8")).toBe(
        manifest,
      );
    } finally {
      f.dispose();
    }
  });

  it("retains the incomplete destination and source bytes after an attachment is missing", () => {
    const f = fixture();
    try {
      const savedAttachment = join(f.root, "temporarily-missing-attachment");
      renameSync(join(f.assets, "synthetic-id"), savedAttachment);
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow(
        "Registered asset missing",
      );
      expect(existsSync(f.dest)).toBe(true);
      expect(existsSync(join(f.dest, "workspace.sqlite"))).toBe(true);
      expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
      expect(readFileSync(savedAttachment)).toEqual(f.bytes);
      const incompleteBytes = readFileSync(join(f.dest, "workspace.sqlite"));
      renameSync(savedAttachment, join(f.assets, "synthetic-id"));
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow();
      expect(readFileSync(join(f.dest, "workspace.sqlite"))).toEqual(incompleteBytes);
      expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
      expect(readFileSync(join(f.assets, "synthetic-id"))).toEqual(f.bytes);
      const nextDest = join(f.root, "new-attempt");
      createMigrationSnapshot(f.db, f.assets, nextDest);
      expect(readFileSync(join(nextDest, "assets", "synthetic-id"))).toEqual(f.bytes);
      expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("retains source attachment and failed copy when registered metadata does not match", () => {
    const f = fixture();
    try {
      const rawMetadata = f.db.prepare("SELECT metadata FROM assets WHERE id=?").get("synthetic-id")?.metadata as string;
      const metadata = JSON.parse(rawMetadata);
      metadata.sha256 = "0".repeat(64);
      f.db.prepare("UPDATE assets SET metadata=? WHERE id=?").run(JSON.stringify(metadata), "synthetic-id");
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow(
        "Asset verification failed",
      );
      expect(existsSync(f.dest)).toBe(true);
      expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
      expect(readFileSync(join(f.dest, "assets", "synthetic-id"))).toEqual(f.bytes);
      expect(readFileSync(join(f.assets, "synthetic-id"))).toEqual(f.bytes);
      expect(f.db.prepare("SELECT metadata FROM assets WHERE id=?").get("synthetic-id")?.metadata).toBe(JSON.stringify(metadata));
    } finally {
      f.dispose();
    }
  });

  it("refuses unsafe asset entries and an active transaction without altering the source", () => {
    const f = fixture();
    try {
      symlinkSync("/nonexistent-target", join(f.assets, "symlink"));
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow(
        "Unsupported asset entry",
      );
      expect(existsSync(f.dest)).toBe(true);
      expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
      rmSync(join(f.assets, "symlink"));
      f.db.exec("BEGIN IMMEDIATE");
      const newDest = join(f.root, "during-transaction");
      expect(() => createMigrationSnapshot(f.db, f.assets, newDest)).toThrow(
        "no active transaction",
      );
      f.db.exec("ROLLBACK");
      expect(existsSync(newDest)).toBe(false);
      expect(readFileSync(join(f.assets, "synthetic-id"))).toEqual(f.bytes);
    } finally {
      f.dispose();
    }
  });

  it("does not reuse an incomplete destination or create a snapshot under assets", () => {
    const f = fixture();
    try {
      mkdirSync(f.dest);
      writeFileSync(join(f.dest, "incomplete"), "untouched");
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow();
      expect(readFileSync(join(f.dest, "incomplete"), "utf8")).toBe(
        "untouched",
      );
      expect(() =>
        createMigrationSnapshot(f.db, f.assets, join(f.assets, "backup")),
      ).toThrow("cannot be in assets");
      expect(existsSync(join(f.assets, "backup"))).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("preserves externally inserted content if pending manifest creation fails", () => {
    const f = fixture();
    try {
      const pending = join(f.dest, ".manifest-pending.json"), external = join(f.dest, "external.txt");
      const simulated = afterSnapshot(f.db, () => {
        writeFileSync(pending, "foreign pending");
        writeFileSync(external, "foreign content");
      });
      expect(() => createMigrationSnapshot(simulated, f.assets, f.dest)).toThrow();
      expect(readFileSync(pending, "utf8")).toBe("foreign pending");
      expect(readFileSync(external, "utf8")).toBe("foreign content");
      expect(existsSync(join(f.dest, "manifest.json"))).toBe(false);
      expect(readFileSync(join(f.assets, "synthetic-id"))).toEqual(f.bytes);
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow();
      expect(readFileSync(external, "utf8")).toBe("foreign content");
    } finally { f.dispose(); }
  });

  it("does not overwrite or delete a foreign manifest created before publication", () => {
    const f = fixture();
    try {
      const manifest = join(f.dest, "manifest.json"), external = join(f.dest, "external.txt");
      const simulated = afterSnapshot(f.db, () => {
        writeFileSync(manifest, "foreign marker");
        writeFileSync(external, "foreign content");
      });
      expect(() => createMigrationSnapshot(simulated, f.assets, f.dest)).toThrow();
      // A foreign file at this name cannot be removed or represented as our
      // completion marker; the caller did not receive a successful return.
      expect(readFileSync(manifest, "utf8")).toBe("foreign marker");
      expect(readFileSync(external, "utf8")).toBe("foreign content");
      expect(readFileSync(join(f.assets, "synthetic-id"))).toEqual(f.bytes);
      expect(() => createMigrationSnapshot(f.db, f.assets, f.dest)).toThrow();
      expect(readFileSync(manifest, "utf8")).toBe("foreign marker");
    } finally { f.dispose(); }
  });
});
