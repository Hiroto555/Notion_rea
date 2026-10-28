import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { inspectLegacyRecords } from "../src/persistence/legacy-record-plan";
import { blankDoc, emptyDatabase } from "../src/shared/types";

describe("legacy record migration preflight", () => {
  it("finds current and history-only rows in each database without rewriting any bytes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE versions(id INTEGER PRIMARY KEY,pageId TEXT,doc TEXT,database TEXT)",
      );
      const page = (id: string, title: string) =>
        JSON.stringify(
          {
            id,
            schemaVersion: 1,
            kind: "database",
            doc: blankDoc(),
            database: {
              ...emptyDatabase(),
              rows: [{ id: "same", title, values: {} }],
            },
          },
          null,
          2,
        );
      const a = page("db-a", "A"),
        b = page("db-b", "B");
      db.prepare("INSERT INTO pages VALUES(?,?)").run("db-a", a);
      db.prepare("INSERT INTO pages VALUES(?,?)").run("db-b", b);
      const old = JSON.stringify(
        {
          ...emptyDatabase(),
          rows: [
            { id: "same", title: "old", values: {} },
            { id: "history-only", title: "deleted", values: {} },
          ],
        },
        null,
        2,
      );
      const doc = JSON.stringify(blankDoc(), null, 2);
      db.prepare("INSERT INTO versions VALUES(1,?,?,?)").run("db-a", doc, old);
      expect(inspectLegacyRecords(db)).toEqual({
        issues: [],
        records: [
          {
            databasePageId: "db-a",
            legacyRowId: "same",
            inCurrent: true,
            inHistory: true,
          },
          {
            databasePageId: "db-b",
            legacyRowId: "same",
            inCurrent: true,
            inHistory: false,
          },
          {
            databasePageId: "db-a",
            legacyRowId: "history-only",
            inCurrent: false,
            inHistory: true,
          },
        ],
      });
      expect(
        db.prepare("SELECT data FROM pages WHERE id='db-a'").get()?.data,
      ).toBe(a);
      expect(
        db.prepare("SELECT data FROM pages WHERE id='db-b'").get()?.data,
      ).toBe(b);
      expect(
        db.prepare("SELECT database FROM versions WHERE id=1").get()?.database,
      ).toBe(old);
      expect(db.prepare("SELECT doc FROM versions WHERE id=1").get()?.doc).toBe(
        doc,
      );
    } finally {
      db.close();
    }
  });
  it("reports unknown and malformed page or history while preserving raw bytes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE versions(id INTEGER PRIMARY KEY,pageId TEXT,doc TEXT,database TEXT)",
      );
      const unknown = JSON.stringify(
        {
          id: "future",
          schemaVersion: 99,
          kind: "page",
          doc: blankDoc(),
          database: null,
        },
        null,
        2,
      );
      const malformed = '{ "id":';
      const history = JSON.stringify(
        { ...emptyDatabase(), schemaVersion: 99 },
        null,
        2,
      );
      db.prepare("INSERT INTO pages VALUES(?,?)").run("future", unknown);
      db.prepare("INSERT INTO pages VALUES(?,?)").run("broken", malformed);
      db.prepare("INSERT INTO versions VALUES(1,?,?,?)").run(
        "future",
        JSON.stringify(blankDoc()),
        history,
      );
      const plan = inspectLegacyRecords(db);
      expect(plan.issues.map((i) => i.reason)).toEqual(
        expect.arrayContaining([
          "malformed page JSON",
          "unsupported or malformed page/document",
          "unsupported or malformed database",
        ]),
      );
      expect(
        db.prepare("SELECT data FROM pages WHERE id='future'").get()?.data,
      ).toBe(unknown);
      expect(
        db.prepare("SELECT data FROM pages WHERE id='broken'").get()?.data,
      ).toBe(malformed);
      expect(
        db.prepare("SELECT database FROM versions WHERE id=1").get()?.database,
      ).toBe(history);
    } finally {
      db.close();
    }
  });
});

it("rejects lossy normalization, unsafe keys and values beyond record limits without changing originals", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE versions(id INTEGER PRIMARY KEY,pageId TEXT,doc TEXT,database TEXT)",
    );
    const base = emptyDatabase();
    const cases: [string, unknown][] = [
      [
        "unknown-row-field",
        { ...base, rows: [{ id: "r", title: "t", values: {}, future: 1 }] },
      ],
      [
        "unknown-filter-field",
        {
          ...base,
          views: [
            {
              ...base.views[0],
              filter: { ...base.views[0].filter, future: 1 },
            },
          ],
        },
      ],
      ["invalid-active-view", { ...base, activeViewId: "missing" }],
      [
        "long-title",
        { ...base, rows: [{ id: "r", title: "x".repeat(501), values: {} }] },
      ],
      [
        "too-many-values",
        {
          ...base,
          rows: [
            {
              id: "r",
              title: "t",
              values: Object.fromEntries(
                Array.from({ length: 1001 }, (_, i) => [String(i), i]),
              ),
            },
          ],
        },
      ],
      [
        "prototype-key",
        {
          ...base,
          rows: [
            { id: "r", title: "t", values: JSON.parse('{"__proto__":"keep"}') },
          ],
        },
      ],
    ];
    for (const [id, database] of cases) {
      const raw = JSON.stringify(
        { id, kind: "database", doc: blankDoc(), database },
        null,
        2,
      );
      db.prepare("INSERT INTO pages VALUES(?,?)").run(id, raw);
    }
    const before = db.prepare("SELECT id,data FROM pages ORDER BY id").all();
    const plan = inspectLegacyRecords(db);
    expect(plan.issues).toHaveLength(cases.length);
    expect(plan.records).toHaveLength(0);
    expect(db.prepare("SELECT id,data FROM pages ORDER BY id").all()).toEqual(
      before,
    );
  } finally {
    db.close();
  }
});
