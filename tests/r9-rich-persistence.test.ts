import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { Store } from "../src/persistence/store";
import type { SaveOperation, SaveResult } from "../src/shared/save-contract";
import type { Doc } from "../src/shared/types";
import { validDocument } from "../src/shared/validation";

const roots: string[] = [];
const stores: Store[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function closeStore(store: Store): void {
  try {
    store.close();
  } catch {}
}

function openWorkspace(prefix: string) {
  const root = tempRoot(prefix);
  const source = join(root, "source");
  mkdirSync(join(source, "assets"), { recursive: true });
  const store = new Store(join(source, "workspace.sqlite"));
  stores.push(store);
  return { root, source, store };
}

function rawPage(store: Store, pageId: string): { data: string; body: string } {
  return store.db
    .prepare("SELECT data,body FROM pages WHERE id=?")
    .get(pageId) as { data: string; body: string };
}

function receiptRows(store: Store) {
  return store.db
    .prepare(
      "SELECT operation_id,fingerprint,result_json FROM save_receipts ORDER BY operation_id",
    )
    .all();
}

afterEach(() => {
  for (const store of stores.splice(0)) closeStore(store);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const text = (value: string, marks?: Doc["marks"]): Doc => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});

const paragraph = (id: string, content?: Doc[]): Doc => ({
  type: "paragraph",
  attrs: { id },
  ...(content ? { content } : {}),
});

const linkMark = (pageId: string) => ({
  type: "link",
  attrs: {
    href: `folio-page://${pageId}`,
    target: "_blank",
    rel: "noopener noreferrer nofollow",
    class: null,
  },
});

function cellText(
  id: string,
  type: "tableCell" | "tableHeader",
  value: string,
  marks?: Doc["marks"],
): Doc {
  return {
    type,
    attrs: { id, colspan: 1, rowspan: 1, colwidth: null },
    content: [paragraph(`${id}-p`, [text(value, marks)])],
  };
}

const tableRow = (id: string, cells: Doc[]): Doc => ({
  type: "tableRow",
  attrs: { id },
  content: cells,
});

const table = (id: string, rows: Doc[]): Doc => ({
  type: "table",
  attrs: { id },
  content: rows,
});

function simpleTable(id: string, rows: number, columns: number): Doc {
  return table(
    id,
    Array.from({ length: rows }, (_, row) =>
      tableRow(
        `${id}-r${row}`,
        Array.from({ length: columns }, (_, column) =>
          cellText(
            `${id}-r${row}-c${column}`,
            "tableCell",
            `R${row}C${column}`,
          ),
        ),
      ),
    ),
  );
}

/** A v2 rich document covering callout tone/ID, table cells with ProseMirror
 * cell attributes, global block IDs, inline marks and a folio-page link. */
function richDoc(targetPageId: string): Doc {
  return {
    type: "doc",
    schemaVersion: 2,
    content: [
      {
        type: "callout",
        attrs: { id: "callout-1", tone: "warning" },
        content: [
          paragraph("callout-p-1", [
            text("Callout body with "),
            text("bold text", [{ type: "bold" }]),
            text(" and "),
            text("linked page", [{ type: "italic" }, linkMark(targetPageId)]),
          ]),
        ],
      },
      table("table-1", [
        tableRow("table-row-1", [
          cellText("table-h-1", "tableHeader", "Header A", [{ type: "bold" }]),
          cellText("table-h-2", "tableHeader", "Header B"),
        ]),
        tableRow("table-row-2", [
          cellText("table-c-1", "tableCell", "Cell A", [{ type: "italic" }]),
          cellText("table-c-2", "tableCell", "Cell B"),
        ]),
      ]),
      paragraph("closing-p-1", [text("After the table")]),
    ],
  };
}

function collectIds(node: Doc, ids: string[] = []): string[] {
  const id = node.attrs?.id;
  if (typeof id === "string") ids.push(id);
  for (const child of node.content ?? []) collectIds(child, ids);
  return ids;
}

function findNode(node: Doc, type: string): Doc | undefined {
  if (node.type === type) return node;
  for (const child of node.content ?? []) {
    const found = findNode(child, type);
    if (found) return found;
  }
  return undefined;
}

function richTable(doc: Doc): Doc {
  const value = findNode(doc, "table");
  if (!value) throw new Error("fixture table missing");
  return value;
}

function richCallout(doc: Doc): Doc {
  const value = findNode(doc, "callout");
  if (!value) throw new Error("fixture callout missing");
  return value;
}

function saveOperation(
  pageId: string,
  revision: number,
  patch: SaveOperation["patch"],
  seq = 1,
): SaveOperation {
  return {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    seq,
    pageId,
    databasePageId: null,
    revision,
    patch,
  };
}

function expectApplied(
  result: SaveResult,
): SaveResult & { page: NonNullable<SaveResult["page"]> } {
  expect(result.status).toBe("applied");
  if (result.status !== "applied" || !result.page)
    throw new Error(
      `save was not applied: ${result.status} ${result.message ?? ""}`,
    );
  return result as SaveResult & { page: NonNullable<SaveResult["page"]> };
}

/** Accept either schema rejection or a terminal receipt rejection, but never
 * accept an applied write. */
function rejectedWithoutApplication(
  store: Store,
  operation: SaveOperation,
): void {
  let result: SaveResult | undefined;
  try {
    result = store.commitSave(operation);
  } catch {
    return;
  }
  expect(result.status).toBe("rejected");
}

function expectPageAndHistoryUnchanged(
  store: Store,
  pageId: string,
  page: ReturnType<Store["get"]>,
  versions: ReturnType<Store["versions"]>,
  raw: { data: string; body: string },
): void {
  expect(store.get(pageId)).toEqual(page);
  expect(store.versions(pageId)).toEqual(versions);
  expect(rawPage(store, pageId)).toEqual(raw);
}

it("keeps explicit v1 simple docs and implicit roots valid while accepting v2 callouts and tables", () => {
  expect(
    validDocument({
      type: "doc",
      schemaVersion: 1,
      content: [paragraph("legacy-p-1", [text("legacy body")])],
    }),
  ).toBe(true);
  expect(
    validDocument({
      type: "doc",
      content: [paragraph("implicit-p-1", [text("implicit legacy body")])],
    }),
  ).toBe(true);

  const rich = richDoc("target-page");
  expect(validDocument(rich)).toBe(true);

  for (const tone of ["note", "tip", "warning"] as const) {
    const variant = structuredClone(rich);
    richCallout(variant).attrs = { id: "callout-1", tone };
    expect(validDocument(variant), `tone ${tone}`).toBe(true);
  }

  const defaultTone = structuredClone(rich);
  richCallout(defaultTone).attrs = { id: "callout-1" };
  expect(validDocument(defaultTone), "callout default tone").toBe(true);

  const implicitRich = structuredClone(rich);
  delete implicitRich.schemaVersion;
  expect(validDocument(implicitRich), "implicit rich root").toBe(true);

  expect(
    validDocument({
      type: "doc",
      schemaVersion: 2,
      content: [simpleTable("minimum-table", 1, 1)],
    }),
    "1x1 table",
  ).toBe(true);
  expect(
    validDocument({
      type: "doc",
      schemaVersion: 2,
      content: [simpleTable("maximum-table", 100, 20)],
    }),
    "100x20 table",
  ).toBe(true);
});

it("round-trips a v2 rich doc through save, restart and history with IDs, marks, links, revisions and receipts intact", () => {
  const { source, store } = openWorkspace("folio-r9-rich-restart-");
  const target = store.create(null, "page", "Link target");
  const page = store.create(null, "page", "Rich source");
  const doc = richDoc(target.id);

  expect(validDocument(doc)).toBe(true);
  const ids = collectIds(doc);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(
    expect.arrayContaining([
      "callout-1",
      "callout-p-1",
      "table-1",
      "table-row-1",
      "table-h-1",
      "table-h-2",
      "table-row-2",
      "table-c-1",
      "table-c-2",
    ]),
  );

  const firstOperation = saveOperation(page.id, page.revision, {
    title: "Rich v2 saved",
    doc,
  });
  const first = expectApplied(store.commitSave(firstOperation));
  expect(first.page.revision).toBe(1);
  expect(first.page.doc).toEqual(doc);
  expect(first.page.doc.schemaVersion).toBe(2);

  const secondOperation = saveOperation(
    page.id,
    first.page.revision,
    { title: "Rich v2 saved and edited" },
    2,
  );
  const second = expectApplied(store.commitSave(secondOperation));
  expect(second.page.revision).toBe(2);
  expect(second.page.doc).toEqual(doc);

  const current = store.get(page.id);
  const versions = store.versions(page.id);
  const body = rawPage(store, page.id).body;
  expect(versions).toHaveLength(2);
  expect(
    versions.some(
      (version) => JSON.stringify(version.doc) === JSON.stringify(doc),
    ),
  ).toBe(true);
  for (const fragment of [
    "Callout body with bold text and linked page",
    "Header A",
    "Header B",
    "Cell A",
    "Cell B",
    "After the table",
  ])
    expect(body).toContain(fragment);

  store.close();

  const reopened = new Store(join(source, "workspace.sqlite"));
  stores.push(reopened);
  expect(reopened.get(page.id)).toEqual(current);
  expect(reopened.versions(page.id)).toEqual(versions);
  expect(rawPage(reopened, page.id).body).toBe(body);
  expect(reopened.resolveSave(firstOperation)).toEqual(first);
  expect(reopened.resolveSave(secondOperation)).toEqual(second);
  expect(reopened.commitSave(firstOperation)).toEqual(first);

  const restoredDoc = reopened.get(page.id).doc;
  expect(restoredDoc.schemaVersion).toBe(2);
  expect(richCallout(restoredDoc).attrs).toMatchObject({
    id: "callout-1",
    tone: "warning",
  });
  expect(richTable(restoredDoc).attrs).toMatchObject({ id: "table-1" });
  const header = richTable(restoredDoc).content?.[0].content?.[0];
  expect(header?.attrs).toMatchObject({
    id: "table-h-1",
    colspan: 1,
    rowspan: 1,
    colwidth: null,
  });
  const linked = richCallout(restoredDoc).content?.[0].content?.find((node) =>
    node.marks?.some((mark) => mark.type === "link"),
  );
  expect(linked?.text).toBe("linked page");
  expect(linked?.marks).toContainEqual(linkMark(target.id));
  expect(linked?.marks).toContainEqual({ type: "italic" });
});

it("preserves rich docs, history, revisions, bodies and receipts across backup and restore", () => {
  const { root, source, store } = openWorkspace("folio-r9-rich-backup-");
  const target = store.create(null, "page", "Backup link target");
  const page = store.create(null, "page", "Backup rich source");
  const doc = richDoc(target.id);

  const firstOperation = saveOperation(page.id, page.revision, {
    title: "Backup rich v2",
    doc,
  });
  const first = expectApplied(store.commitSave(firstOperation));
  const secondOperation = saveOperation(
    page.id,
    first.page.revision,
    { title: "Backup rich v2 edited" },
    2,
  );
  const second = expectApplied(store.commitSave(secondOperation));

  const expectedPage = store.get(page.id);
  const expectedVersions = store.versions(page.id);
  const expectedBody = rawPage(store, page.id).body;
  const expectedReceipts = receiptRows(store);
  expect(expectedPage.revision).toBe(2);
  expect(expectedPage.doc).toEqual(doc);
  expect(expectedVersions).toHaveLength(2);
  expect(expectedReceipts).toHaveLength(2);

  const backup = createFullBackup(store.db, source, join(root, "backup"));
  const verified = verifyFullBackup(backup.directory);
  expect(verified.fingerprint).toBe(backup.fingerprint);
  expect(verified.manifest.inventory).toMatchObject({
    pages: 2,
    versions: 2,
    saveReceipts: 2,
  });

  store.close();
  const restored = restoreFullBackup(
    backup.directory,
    join(root, "restored"),
    verified.fingerprint,
  );
  expect(restored.sourceFingerprint).toBe(verified.fingerprint);

  const reopened = new Store(join(restored.directory, "workspace.sqlite"));
  stores.push(reopened);
  expect(reopened.get(page.id)).toEqual(expectedPage);
  expect(reopened.get(page.id).doc).toEqual(doc);
  expect(reopened.versions(page.id)).toEqual(expectedVersions);
  expect(rawPage(reopened, page.id).body).toBe(expectedBody);
  expect(receiptRows(reopened)).toEqual(expectedReceipts);
  expect(reopened.resolveSave(firstOperation)).toEqual(first);
  expect(reopened.resolveSave(secondOperation)).toEqual(second);
  expect(collectIds(reopened.get(page.id).doc)).toEqual(collectIds(doc));
  expect(richCallout(reopened.get(page.id).doc).attrs).toMatchObject({
    id: "callout-1",
    tone: "warning",
  });
  const restoredLink = richCallout(
    reopened.get(page.id).doc,
  ).content?.[0].content?.find((node) =>
    node.marks?.some((mark) => mark.type === "link"),
  );
  expect(restoredLink?.marks).toContainEqual(linkMark(target.id));
});

const malformedCases: [string, () => unknown][] = [
  [
    "a non-rectangular table",
    () => {
      const doc = richDoc("target-page");
      const rows = richTable(doc).content!;
      rows[1].content = [rows[1].content![0]];
      return doc;
    },
  ],
  [
    "a merged cell with colspan other than 1",
    () => {
      // Both rows still occupy two columns; only the cell merge is invalid.
      const doc: Doc = {
        type: "doc",
        schemaVersion: 2,
        content: [simpleTable("merged-colspan", 2, 2)],
      };
      richTable(doc).content![0].content = [
        {
          type: "tableCell",
          attrs: {
            id: "merged-colspan-cell",
            colspan: 2,
            rowspan: 1,
            colwidth: null,
          },
          content: [paragraph("merged-colspan-cell-p", [text("merged")])],
        },
      ];
      return doc;
    },
  ],
  [
    "a merged cell with rowspan other than 1",
    () => {
      const doc: Doc = {
        type: "doc",
        schemaVersion: 2,
        content: [simpleTable("merged-rowspan", 1, 1)],
      };
      const cell = richTable(doc).content![0].content![0];
      cell.attrs = { ...cell.attrs, rowspan: 2 };
      return doc;
    },
  ],
  [
    "a table with more than 100 rows",
    () => ({
      type: "doc",
      schemaVersion: 2,
      content: [simpleTable("too-many-rows", 101, 1)],
    }),
  ],
  [
    "a table with more than 20 columns",
    () => ({
      type: "doc",
      schemaVersion: 2,
      content: [simpleTable("too-many-columns", 1, 21)],
    }),
  ],
  [
    "a table with no rows",
    () => ({
      type: "doc",
      schemaVersion: 2,
      content: [table("no-rows", [])],
    }),
  ],
  [
    "an invalid callout tone",
    () => {
      const doc = richDoc("target-page");
      richCallout(doc).attrs = { id: "callout-1", tone: "danger" };
      return doc;
    },
  ],
  [
    "a rich node under an explicit schemaVersion 1 root",
    () => {
      const doc = richDoc("target-page");
      doc.schemaVersion = 1;
      return doc;
    },
  ],
  [
    "a future schemaVersion 3 root",
    () => {
      const doc = richDoc("target-page");
      doc.schemaVersion = 3;
      return doc;
    },
  ],
  [
    "a nested table inside a cell",
    () => {
      const doc = richDoc("target-page");
      const cell = richTable(doc).content![1].content![0];
      cell.content!.push(simpleTable("nested-table", 1, 1));
      return doc;
    },
  ],
];

it.each(malformedCases)(
  "rejects %s without changing the stored page, history or body",
  (_name, build) => {
    const { store } = openWorkspace("folio-r9-rich-invalid-");
    const page = store.create(null, "page", "Valid rich source");
    const doc = richDoc("target-page");
    const saved = expectApplied(
      store.commitSave(
        saveOperation(page.id, page.revision, {
          title: "Valid rich v2",
          doc,
        }),
      ),
    );
    const originalPage = store.get(page.id);
    const originalVersions = store.versions(page.id);
    const originalRaw = rawPage(store, page.id);
    expect(saved.page.revision).toBe(1);

    const malformed = build();
    expect(validDocument(malformed)).toBe(false);

    rejectedWithoutApplication(
      store,
      saveOperation(page.id, originalPage.revision, {
        doc: malformed as Doc,
      }),
    );
    expectPageAndHistoryUnchanged(
      store,
      page.id,
      originalPage,
      originalVersions,
      originalRaw,
    );
  },
);
