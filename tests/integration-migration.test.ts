import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EditorState } from "@tiptap/pm/state";
import { documentSchema } from "../src/shared/editor-schema";
import { assignBlockIds } from "../src/editor/block-identity";
import { addView } from "../src/database/model";
import { Store } from "../src/persistence/store";

it("migrates an isolated legacy database page while preserving its document and asset across ID and view edits", () => {
  const root = mkdtempSync(resolve("output/integration-legacy-"));
  const dbPath = join(root, "workspace.sqlite");
  const assetName = "12345678-1234-1234-1234-123456789abc.png";
  const assetBytes = readFileSync(resolve("tests/fixtures/image.png"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", assetName), assetBytes);
  let store: Store | undefined;
  try {
    store = new Store(dbPath);
    const page = store.create(null, "database", "移行対象");
    const legacyDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "書式付き", marks: [{ type: "bold" }] },
          ],
        },
        {
          type: "image",
          attrs: { src: `folio-asset://${assetName}`, alt: "添付画像" },
        },
      ],
    };
    const legacyDatabase = {
      properties: [
        {
          id: "status",
          name: "状態",
          type: "select",
          options: ["進行中", "完了"],
        },
      ],
      rows: [{ id: "row-a", title: "原本行", values: { status: "進行中" } }],
      view: "table",
      filter: "",
      sort: "title",
    };
    const original = { ...page, doc: legacyDoc, database: legacyDatabase };
    const originalBytes = JSON.stringify(original);
    const futureHistoryDoc = JSON.stringify({
      type: "doc",
      schemaVersion: 99,
      content: [{ type: "paragraph" }],
    });
    const futureHistoryDatabase = JSON.stringify(legacyDatabase, null, 2);
    store.db
      .prepare(
        "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
      )
      .run(page.id, 1, "未知の履歴", futureHistoryDoc, futureHistoryDatabase);
    store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(originalBytes, page.id);
    store.db.exec("PRAGMA user_version=2");
    store.close();
    store = new Store(dbPath);
    const migrated = store.get(page.id);
    const futureHistory = store.db
      .prepare("SELECT doc,database FROM versions WHERE pageId=? AND title=?")
      .get(page.id, "未知の履歴") as any;
    expect(futureHistory.doc).toBe(futureHistoryDoc);
    expect(futureHistory.database).toBe(futureHistoryDatabase);
    expect(migrated.doc).toEqual(legacyDoc);
    expect(migrated.database!.rows).toEqual(legacyDatabase.rows);
    expect(migrated.database!.properties).toEqual(legacyDatabase.properties);
    const oldSnapshot = new DatabaseSync(dbPath + ".pre-v3.sqlite", {
      readOnly: true,
    });
    try {
      expect(
        (
          oldSnapshot
            .prepare("SELECT data FROM pages WHERE id=?")
            .get(page.id) as { data: string }
        ).data,
      ).toBe(originalBytes);
      expect(
        (oldSnapshot.prepare("PRAGMA user_version").get() as any).user_version,
      ).toBe(2);
    } finally {
      oldSnapshot.close();
    }
    const state = EditorState.create({
      schema: documentSchema,
      doc: documentSchema.nodeFromJSON(migrated.doc),
    });
    const tr = state.tr;
    expect(assignBlockIds(tr)).toBe(true);
    const idDoc = tr.doc.toJSON();
    const edited = store.update(page.id, migrated.revision, { doc: idDoc });
    expect(edited.database!.rows).toEqual(legacyDatabase.rows);
    const views = addView(edited.database!, "board", { name: "進行別" });
    const editedDatabase = store.update(page.id, edited.revision, {
      database: views,
    });
    expect(editedDatabase.doc).toEqual(idDoc);
    store.close();
    store = new Store(dbPath);
    const reopened = store.get(page.id);
    expect(reopened.doc).toEqual(idDoc);
    expect(reopened.database).toEqual(views);
    expect(reopened.database!.rows).toEqual(legacyDatabase.rows);
    expect(readFileSync(join(root, "assets", assetName))).toEqual(assetBytes);
    expect((reopened.doc as any).content[0].content[0].marks).toContainEqual({
      type: "bold",
    });
    expect((reopened.doc as any).content[1].attrs.src).toBe(
      `folio-asset://${assetName}`,
    );
  } finally {
    try {
      store?.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["document", "page"])(
  "preserves unknown %s formats byte-for-byte during database migration",
  (kind) => {
    const root = mkdtempSync(resolve("output/integration-unknown-doc-"));
    let store: Store | undefined;
    try {
      const dbPath = join(root, "workspace.sqlite");
      store = new Store(dbPath);
      const page = store.create(null, "database", "未知文書");
      const source = JSON.stringify(
        {
          ...page,
          schemaVersion: kind === "page" ? 99 : 1,
          doc: {
            type: "doc",
            schemaVersion: kind === "document" ? 99 : 1,
            content: [{ type: "paragraph" }],
          },
          database: {
            properties: [],
            rows: [],
            view: "table",
            filter: "",
            sort: "",
          },
        },
        null,
        2,
      );
      const historyDoc = JSON.stringify(
        { type: "doc", schemaVersion: 99, content: [{ type: "paragraph" }] },
        null,
        2,
      );
      const historyDatabase = JSON.stringify(
        { properties: [], rows: [], view: "table", filter: "", sort: "" },
        null,
        2,
      );
      store.db
        .prepare("UPDATE pages SET data=? WHERE id=?")
        .run(source, page.id);
      store.db
        .prepare(
          "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
        )
        .run(page.id, 1, "未知の履歴", historyDoc, historyDatabase);
      const validHistoryDoc = JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph" }],
      });
      store.db
        .prepare(
          "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
        )
        .run(page.id, 2, "保護ページの履歴", validHistoryDoc, historyDatabase);
      store.db.exec("PRAGMA user_version=2");
      store.close();
      store = new Store(dbPath);
      const validHistory = store.db
        .prepare("SELECT doc,database FROM versions WHERE pageId=? AND title=?")
        .get(page.id, "保護ページの履歴") as any;
      expect(validHistory.doc).toBe(validHistoryDoc);
      expect(validHistory.database).toBe(historyDatabase);
      expect(store.get(page.id).documentError).toBeTruthy();
      expect(store.handle({ type: "pageSource", id: page.id })).toBe(source);
      const history = store.db
        .prepare("SELECT doc,database FROM versions WHERE pageId=? AND title=?")
        .get(page.id, "未知の履歴") as any;
      expect(history.doc).toBe(historyDoc);
      expect(history.database).toBe(historyDatabase);
      expect(() =>
        store!.update(page.id, page.revision, { title: "上書き" }),
      ).toThrow();
      expect(store.handle({ type: "pageSource", id: page.id })).toBe(source);
    } finally {
      try {
        store?.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  },
);
