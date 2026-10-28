import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createLegacyRecordMap,
  legacyRecordPageId,
} from "../src/persistence/legacy-record-map";

describe("legacy record identity foundation", () => {
  it("scopes repeated row IDs to the database, avoids page and mapping collisions and is stable", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT); INSERT INTO pages VALUES('existing','original'); BEGIN IMMEDIATE",
      );
      createLegacyRecordMap(db);
      const candidates = ["existing", "record-a", "record-a", "record-b"];
      const generate = () => candidates.shift()!;
      expect(legacyRecordPageId(db, "db-a", "same", generate)).toBe("record-a");
      expect(legacyRecordPageId(db, "db-b", "same", generate)).toBe("record-b");
      expect(
        legacyRecordPageId(db, "db-a", "same", () => {
          throw Error("should reuse");
        }),
      ).toBe("record-a");
      db.exec("COMMIT");
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM legacy_record_map").get()?.n,
      ).toBe(2);
      expect(
        db.prepare("SELECT data FROM pages WHERE id='existing'").get()?.data,
      ).toBe("original");
    } finally {
      db.close();
    }
  });
  it("rolls schema, mapping, page and version back together after an interrupted migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT); PRAGMA user_version=3; BEGIN IMMEDIATE",
      );
      createLegacyRecordMap(db);
      const id = legacyRecordPageId(db, "db-a", "row", () => "new-page");
      db.prepare("INSERT INTO pages VALUES(?,?)").run(id, "record");
      db.exec("PRAGMA user_version=4; ROLLBACK");
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
      expect(db.prepare("SELECT COUNT(*) AS n FROM pages").get()?.n).toBe(0);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='legacy_record_map'",
          )
          .get()?.n,
      ).toBe(0);
      db.exec("BEGIN IMMEDIATE");
      createLegacyRecordMap(db);
      expect(legacyRecordPageId(db, "db-a", "row", () => "retry-page")).toBe(
        "retry-page",
      );
      db.exec("COMMIT");
      db.exec("BEGIN IMMEDIATE");
      expect(legacyRecordPageId(db, "db-a", "row", () => "other")).toBe(
        "retry-page",
      );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  });
  it("refuses to allocate a mapping outside the migration transaction", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() => createLegacyRecordMap(db)).toThrow(
        "requires a migration transaction",
      );
    } finally {
      db.close();
    }
  });
  it("fails without a partial mapping when no collision-free id can be allocated", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT); INSERT INTO pages VALUES('taken',''); BEGIN IMMEDIATE",
      );
      createLegacyRecordMap(db);
      expect(() => legacyRecordPageId(db, "db", "row", () => "taken")).toThrow(
        "unique record page ID",
      );
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM legacy_record_map").get()?.n,
      ).toBe(0);
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  });
});

it("reuses a committed mapping after closing and reopening SQLite", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const root = mkdtempSync(resolve("output/legacy-map-reopen-"));
  const file = join(root, "fixture.sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT); BEGIN IMMEDIATE",
    );
    createLegacyRecordMap(db);
    expect(legacyRecordPageId(db, "db-a", "same", () => "saved-id")).toBe(
      "saved-id",
    );
    db.exec("COMMIT");
    db.close();
    db = new DatabaseSync(file);
    db.exec("BEGIN IMMEDIATE");
    expect(legacyRecordPageId(db, "db-a", "same", () => "new-id")).toBe(
      "saved-id",
    );
    db.exec("COMMIT");
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
