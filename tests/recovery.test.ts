import { it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../src/persistence/store";
import { requestSchema } from "../src/shared/types";
import { recoveryContent, parseRecovery } from "../src/shared/recovery";
import { FILE_MAX_BYTES } from "../src/shared/limits";
import { writeRecoveryFile } from "../src/persistence/recovery-file";
import { sizedRecovery } from "./recovery-fixture";
const stores: Store[] = [];
const make = () => {
  const s = new Store(
    join(mkdtempSync(resolve("output/next-round-unit-")), "workspace.sqlite"),
  );
  stores.push(s);
  return s;
};
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
for (const length of [490, 491, 500, 501])
  it(`R1 title ${length} uses the normal input contract and preserves original`, () => {
    const s = make(),
      p = s.create(null),
      title = "題".repeat(length);
    const req = { type: "update", id: p.id, revision: 0, patch: { title } };
    expect(requestSchema.safeParse(req).success).toBe(length <= 500);
    const value = {
      format: "folio-recovery",
      schemaVersion: 1,
      pages: [p],
      pendingPatches: [{ id: p.id, patch: { title } }],
    };
    if (length > 500) expect(() => s.recover(value)).toThrow();
    else {
      const [copy] = s.recover(value);
      expect(copy.title).toBe(title);
      expect(s.get(p.id)).toEqual(p);
    }
  });
it("R1 actual export schema rejects UTF-8 bytes above the recover file limit", () => {
  const content = JSON.stringify({
    format: "folio-recovery",
    schemaVersion: 1,
    pages: [],
    pendingPatches: [],
    padding: "あ".repeat(10_100_000),
  });
  expect(content.length).toBeLessThan(30_000_000);
  expect(Buffer.byteLength(content)).toBeGreaterThan(30_000_000);
  expect(
    requestSchema.safeParse({
      type: "export",
      name: "recovery",
      format: "json",
      content,
    }).success,
  ).toBe(false);
});
for (const alphabet of ["x", "あ", "😀"])
  for (const delta of [-1, 0, 1])
    it(`R1 ${alphabet} UTF-8 boundary ${delta}: schema/file/store/reopen`, () => {
      const s = make(),
        p = s.create(null),
        content = sizedRecovery(p, FILE_MAX_BYTES + delta, alphabet);
      expect(Buffer.byteLength(content)).toBe(FILE_MAX_BYTES + delta);
      expect(
        requestSchema.safeParse({ type: "exportRecovery", content }).success,
      ).toBe(delta <= 0);
      const file = join(s.path, "..", "recovery.json");
      if (delta > 0) {
        expect(() => writeRecoveryFile(file, content)).toThrow();
        return;
      }
      writeRecoveryFile(file, content);
      const [copy] = s.recover(JSON.parse(readFileSync(file, "utf8")));
      expect(copy.doc).toEqual(parseRecovery(content)[0].doc);
      expect(s.get(p.id)).toEqual(p);
      s.close();
      stores.splice(stores.indexOf(s), 1);
      const reopened = new Store(s.path);
      stores.push(reopened);
      expect(reopened.get(copy.id).doc).toEqual(copy.doc);
      expect(reopened.get(p.id)).toEqual(p);
    });
it("R1 v2 includes only changed pages once, preserves mixed title/marks/rows/refs and rolls back all copies", () => {
  const s = make(),
    a = s.create(null),
    b = s.create(null, "database"),
    unused = s.create(null);
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "不動産 A😀",
            marks: [
              { type: "bold" },
              {
                type: "link",
                attrs: { href: "folio-asset://file/legacy.txt" },
              },
            ],
          },
        ],
      },
    ],
  };
  const database = {
    ...b.database!,
    rows: [
      {
        id: "original-row-id",
        title: "Record A",
        values: { status: "未着手", cost: 123 },
      },
    ],
  };
  const content = recoveryContent(
    [a, b, unused],
    [
      { id: a.id, patch: { title: "Aあ😀".repeat(125) } },
      { id: a.id, patch: { doc } },
      { id: b.id, patch: { title: "second", database } },
    ],
  );
  const value = JSON.parse(content);
  expect(value.pages).toHaveLength(2);
  expect(value.persistedPages).toBeUndefined();
  expect(value.pendingPatches).toBeUndefined();
  s.db.exec(
    "CREATE TRIGGER fail_second BEFORE INSERT ON pages WHEN json_extract(NEW.data,'$.title')='second' BEGIN SELECT RAISE(ABORT,'injected recovery failure'); END;",
  );
  expect(() => s.recover(value)).toThrow(/injected/);
  expect(s.pages()).toEqual([a, b, unused]);
  s.db.exec("DROP TRIGGER fail_second");
  const copies = s.recover(value);
  expect(copies[0].title).toBe("Aあ😀".repeat(125));
  expect(copies[0].doc).toEqual(doc);
  expect(copies[1].database).toEqual(database);
  expect(s.get(a.id)).toEqual(a);
  expect(s.get(b.id)).toEqual(b);
});
it("R1 invalid/unknown formats and write errors preserve existing files and source pages", () => {
  const s = make(),
    p = s.create(null),
    content = recoveryContent([p], [{ id: p.id, patch: { title: "pending" } }]);
  const path = join(s.path, "..", "recovery.json");
  writeFileSync(path, "keep");
  for (const value of [
    { ...JSON.parse(content), schemaVersion: 99 },
    { ...JSON.parse(content), pages: [{ ...p, doc: { type: "bad" } }] },
  ])
    expect(() => writeRecoveryFile(path, JSON.stringify(value))).toThrow();
  expect(readFileSync(path, "utf8")).toBe("keep");
  const directory = join(s.path, "..", "directory");
  mkdirSync(directory);
  expect(() => writeRecoveryFile(directory, content)).toThrow();
  expect(s.get(p.id)).toEqual(p);
});
