import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../src/persistence/store";
import {
  textOf,
  requestSchema,
  emptyDatabase,
  type Doc,
} from "../src/shared/types";
const roots: string[] = [],
  stores: Store[] = [];
function make() {
  const root = mkdtempSync(resolve("output/gate-a-unit-"));
  roots.push(root);
  const s = new Store(join(root, "workspace.sqlite"));
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const mixed: Doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "不" },
        { type: "text", text: "動", marks: [{ type: "bold" }] },
        { type: "text", text: "産" },
        { type: "hardBreak" },
        { type: "text", text: "soft" },
        {
          type: "text",
          text: "ware",
          marks: [{ type: "link", attrs: { href: "https://example.com" } }],
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: "next" }] },
  ],
};
describe("Gate A actual storage regressions", () => {
  it("F02 inline formatting preserves words, hardBreak and paragraph boundaries are newlines", () => {
    expect(textOf(mixed)).toBe("不動産\nsoftware\nnext");
    const s = make(),
      p = s.create(null);
    s.update(p.id, 0, { doc: mixed });
    for (const query of ["不動産", "software", "software\nnext"])
      expect(s.handle({ type: "search", query })).toHaveLength(1);
    expect(s.handle({ type: "search", query: "softwarenext" })).toHaveLength(0);
  });
  it("F04 database row deletion and property changes have durable restorable snapshots", () => {
    const s = make(),
      p = s.create(null, "database");
    const database = {
      ...emptyDatabase(),
      rows: [
        { id: "row", title: "原本", values: { status: "進行中", cost: 42 } },
      ],
    };
    s.update(p.id, 0, { database, title: "Original database", doc: mixed });
    s.update(p.id, 1, { database: { ...database, rows: [], properties: [] } });
    const versions = s.versions(p.id);
    const v = versions.find((v) => (v as any).database?.rows.length === 1);
    expect(v).toBeDefined();
    s.close();
    const reopened = new Store(s.path);
    stores.push(reopened);
    reopened.handle({ type: "restoreVersion", id: p.id, versionId: v!.id });
    expect(reopened.get(p.id).database).toEqual(database);
    expect(reopened.get(p.id).doc).toEqual(mixed);
    expect(reopened.get(p.id).title).toBe("Original database");
  });
  for (const [name, doc] of [
    ["doc text", { type: "doc", content: [{ type: "text", text: "bad" }] }],
    [
      "list paragraph",
      {
        type: "doc",
        content: [{ type: "bulletList", content: [{ type: "paragraph" }] }],
      },
    ],
    [
      "heading attribute",
      { type: "doc", content: [{ type: "heading", attrs: { level: 99 } }] },
    ],
    [
      "future schema",
      { type: "doc", schemaVersion: 999, content: [{ type: "paragraph" }] },
    ],
  ] as const)
    it("F07 rejects " + name + " before persistence", () => {
      const s = make(),
        p = s.create(null);
      expect(
        requestSchema.safeParse({
          type: "update",
          id: p.id,
          revision: 0,
          patch: { doc },
        }).success,
      ).toBe(false);
      expect(() => s.update(p.id, 0, { doc: doc as unknown as Doc })).toThrow();
      expect(s.get(p.id)).toEqual(p);
    });
});

it("F07 malformed stored JSON and future document versions stay byte-for-byte intact", () => {
  const s = make(),
    p = s.create(null);
  const future = JSON.stringify({
    ...p,
    doc: { ...p.doc, schemaVersion: 999 },
  });
  s.db.prepare("UPDATE pages SET data=? WHERE id=?").run(future, p.id);
  expect(s.load().pages[0].documentError).toBeTruthy();
  expect(() => s.update(p.id, 0, { title: "overwrite" })).toThrow();
  expect(s.handle({ type: "pageSource", id: p.id })).toBe(future);
  s.db.prepare("UPDATE pages SET data=? WHERE id=?").run("{broken", p.id);
  expect(() => s.load()).toThrow(/JSON/);
  expect(s.handle({ type: "pageSource", id: p.id })).toBe("{broken");
});
it("F04 SQL failure rolls back both history and page modification", () => {
  const s = make(),
    p = s.create(null, "database");
  s.db.exec(
    "CREATE TRIGGER fail_write BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT,'injected disk failure'); END;",
  );
  expect(() =>
    s.update(p.id, 0, {
      database: {
        ...emptyDatabase(),
        rows: [{ id: "x", title: "x", values: {} }],
      },
    }),
  ).toThrow(/injected/);
  expect(s.get(p.id)).toEqual(p);
  expect(s.versions(p.id)).toHaveLength(0);
});
it("F11 recovery copies local edits without overwriting the stored competing page", () => {
  const s = make(),
    p = s.create(null);
  s.update(p.id, 0, { title: "remote" });
  const [copy] = s.recover({
    format: "folio-recovery",
    schemaVersion: 1,
    pages: [p],
    pendingPatches: [{ id: p.id, patch: { title: "local", doc: mixed } }],
  });
  expect(copy.id).not.toBe(p.id);
  expect(copy.title).toBe("[復旧] local");
  expect(copy.doc).toEqual(mixed);
  expect(s.get(p.id).title).toBe("remote");
  expect(() =>
    s.recover({
      format: "folio-recovery",
      schemaVersion: 1,
      pages: [p],
      pendingPatches: [
        {
          id: p.id,
          patch: {
            doc: { type: "doc", content: [{ type: "text", text: "invalid" }] },
          },
        },
      ],
    }),
  ).toThrow();
  expect(s.pages()).toHaveLength(2);
});
it("F07 accepts registered nested blocks and rejects excessive depth and malformed mark attrs", () => {
  const valid: Doc = {
    type: "doc",
    schemaVersion: 1,
    content: [
      {
        type: "details",
        attrs: { open: true },
        content: [
          {
            type: "detailsSummary",
            content: [{ type: "text", text: "Summary" }],
          },
          {
            type: "detailsContent",
            content: [
              {
                type: "taskList",
                content: [
                  {
                    type: "taskItem",
                    attrs: { checked: false },
                    content: [
                      {
                        type: "paragraph",
                        content: [
                          {
                            type: "text",
                            text: "Task",
                            marks: [{ type: "italic" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "image",
        attrs: {
          src: "folio-asset://12345678-1234-1234-1234-123456789abc",
          alt: "image",
        },
      },
      {
        type: "codeBlock",
        attrs: { language: "js" },
        content: [{ type: "text", text: "1 + 2" }],
      },
      { type: "horizontalRule" },
    ],
  };
  const validRequest = (doc: Doc) =>
    requestSchema.safeParse({
      type: "update",
      id: "page",
      revision: 0,
      patch: { doc },
    }).success;
  expect(validRequest(valid)).toBe(true);
  let nested: Doc = { type: "paragraph" };
  for (let i = 0; i < 110; i++)
    nested = { type: "blockquote", content: [nested] };
  expect(validRequest({ type: "doc", content: [nested] })).toBe(false);
  expect(
    validRequest({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "bad link",
              marks: [{ type: "link", attrs: { href: 42 } }],
            },
          ],
        },
      ],
    }),
  ).toBe(false);
});
it("F07 unknown page-level schema is read-only and never rewritten", () => {
  const s = make(),
    p = s.create(null);
  const raw = JSON.stringify({ ...p, schemaVersion: 99 });
  s.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, p.id);
  expect(s.get(p.id).documentError).toBeTruthy();
  expect(() => s.update(p.id, 0, { title: "overwrite" })).toThrow();
  expect(s.handle({ type: "pageSource", id: p.id })).toBe(raw);
});
