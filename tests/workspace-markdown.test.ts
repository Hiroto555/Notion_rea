import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { MarkdownManager } from "@tiptap/markdown";
import { Store } from "../src/persistence/store";
import { exportWorkspaceMarkdown } from "../src/persistence/workspace-markdown";
import { attachBuffer } from "../src/persistence/assets";
import { extensions } from "../src/shared/editor-schema";
import {
  emptyDatabase,
  isDocument,
  type Page,
  type Doc,
} from "../src/shared/types";
import { HighlightedCodeBlock } from "../src/editor/code-language";
import { RecordRepository } from "../src/persistence/record-repository";
import { prepareDatabaseCreation } from "../src/shared/database-operation";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-markdown-"));
  const workspace = join(root, "workspace"),
    assets = join(workspace, "assets"),
    output = join(root, "export");
  mkdirSync(assets, { recursive: true });
  mkdirSync(output);
  const store = new Store(join(workspace, "workspace.sqlite"));
  onTestFinished(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, assets, output, workspace };
}
it("preserves hierarchy, duplicate titles, literal URLs, nested attachment links and their exact bytes", () => {
  const { store, assets, output } = fixture();
  const file = attachBuffer(
    store.db,
    assets,
    "画像.png",
    "image/png",
    Buffer.from([1, 2, 3]),
  );
  const parent = store.create(null, "page", "作業"),
    doc: Doc = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: file.url, alt: "図" } },
        { type: "paragraph", content: [{ type: "text", text: file.url }] },
      ],
    };
  store.create(parent.id, "page", "週/報", doc);
  store.create(parent.id, "page", "週/報", doc);
  const root = exportWorkspaceMarkdown(
      store,
      assets,
      output,
      new Date(2026, 10, 20),
    ),
    read = (name: string) =>
      readFileSync(join(root, "作業", name, "index.md"), "utf8");
  expect(read("週_報")).toContain("../../assets/" + file.id + ".png");
  expect(read("週_報-2")).toContain(file.url);
  expect(readdirSync(join(root, "assets"))).toEqual([file.id + ".png"]);
  expect(readFileSync(join(root, "assets", file.id + ".png"))).toEqual(
    Buffer.from([1, 2, 3]),
  );
  expect(existsSync(join(root, "FOLIO-EXPORT-INCOMPLETE"))).toBe(false);
  expect(
    exportWorkspaceMarkdown(store, assets, output, new Date(2026, 10, 20)),
  ).toBe(root + "-2");
  expect(store.pages().find((p) => p.title === "週/報")!.doc).toMatchObject(
    doc,
  );
});

it("exports legacy and registered records as Markdown and escaped CSV, separating deleted pages", () => {
  const { store, assets, output } = fixture();
  const legacy = store.create(null, "database", "旧DB"),
    db = legacy.database!;
  store.update(legacy.id, legacy.revision, {
    database: {
      ...db,
      rows: [{ id: "legacy1", title: '引用"行', values: {} }],
    },
  });
  const { rows: _, ...settings } = emptyDatabase();
  const created = store.handle({
    type: "database:commit",
    operation: prepareDatabaseCreation("新DB", null, settings),
  }) as { page: Page };
  new RecordRepository(store).create(created.page.id, "ノート", {});
  const deleted = store.create(null, "page", "deleted");
  store.trash(deleted.id);
  const root = exportWorkspaceMarkdown(store, assets, output);
  expect(readFileSync(join(root, "旧DB", "records.csv"), "utf8")).toContain(
    '"引用""行"',
  );
  expect(existsSync(join(root, "旧DB", "引用_行", "index.md"))).toBe(true);
  expect(readFileSync(join(root, "新DB", "records.csv"), "utf8")).toContain(
    '"ノート"',
  );
  expect(existsSync(join(root, "新DB", "ノート", "index.md"))).toBe(true);
  expect(existsSync(join(root, "ゴミ箱", "deleted", "index.md"))).toBe(true);
});

it("refuses workspace and backup destinations, and marks partial output when bytes are damaged", () => {
  const { store, assets, output, workspace } = fixture();
  expect(() => exportWorkspaceMarkdown(store, assets, workspace)).toThrow(
    /ワークスペース/,
  );
  const backup = join(output, "backup");
  mkdirSync(backup);
  writeFileSync(join(backup, "workspace.sqlite"), "");
  expect(() => exportWorkspaceMarkdown(store, assets, backup)).toThrow(
    /バックアップ/,
  );
  const file = attachBuffer(
    store.db,
    assets,
    "a.png",
    "image/png",
    Buffer.from([7]),
  );
  store.create(null, "page", "p", {
    type: "doc",
    content: [{ type: "image", attrs: { src: file.url } }],
  });
  writeFileSync(join(assets, file.id), Buffer.from([8]));
  expect(() => exportWorkspaceMarkdown(store, assets, output)).toThrow(
    /未完了/,
  );
  const incomplete = readdirSync(output).find((p) =>
    p.startsWith("folio-export-"),
  )!;
  expect(existsSync(join(output, incomplete, "FOLIO-EXPORT-INCOMPLETE"))).toBe(
    true,
  );
});

it("preserves old code blocks and named language fences across the headless and highlighted schemas", () => {
  const manager = new MarkdownManager({
    extensions: extensions({ highlightedCodeBlock: HighlightedCodeBlock }),
  });
  expect(
    JSON.stringify(
      HighlightedCodeBlock.options.lowlight.highlight(
        "typescript",
        "const n = 1",
      ),
    ),
  ).toContain("hljs-keyword");
  for (const language of [null, "typescript", "unlisted"]) {
    const doc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          ...(language === null ? {} : { attrs: { language } }),
          content: [{ type: "text", text: "const n = 1" }],
        },
      ],
    };
    expect(isDocument(doc)).toBe(true);
    expect(manager.serialize(doc)).toContain(
      "```" + (language ?? "") + "\nconst n = 1",
    );
    expect(isDocument(manager.parse(manager.serialize(doc)))).toBe(true);
  }
});
