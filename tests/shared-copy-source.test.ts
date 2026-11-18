import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { readPrivateCopySources } from "../src/main/shared-copy-source";
import { Store } from "../src/persistence/store";

const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ASSET_ID = "22222222-2222-4222-8222-222222222222";

let directory: string;
let assetsDirectory: string;
let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "folio-copy-source-"));
  assetsDirectory = join(directory, "assets");
  mkdirSync(assetsDirectory, { recursive: true, mode: 0o700 });
  store = new Store(join(directory, "folio.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function paragraph(id: string, text: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    content: [{ type: "text", text }],
  };
}

function image(src: string): Doc {
  return { type: "image", attrs: { src } };
}

function document(...content: Doc[]): Doc {
  return { type: "doc", content };
}

function pageData(
  id: string,
  doc: Doc,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    schemaVersion: 1,
    parentId: null,
    title: `Page ${id}`,
    icon: "",
    cover: "",
    position: 0,
    doc,
    kind: "page",
    database: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    revision: 0,
    deletedAt: null,
    ...overrides,
  };
}

function insertPage(data: Record<string, unknown>): string {
  const id = String(data.id);
  store.db
    .prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)")
    .run(id, JSON.stringify(data), "");
  return id;
}

function insertAsset(
  id: string,
  bytes: Uint8Array,
  metadata: Record<string, unknown> = {},
): string {
  writeFileSync(join(assetsDirectory, id), bytes, { mode: 0o600 });
  chmodSync(join(assetsDirectory, id), 0o600);
  store.db.prepare("INSERT INTO assets(id,metadata) VALUES(?,?)").run(
    id,
    JSON.stringify({
      id,
      name: `${id}.png`,
      extension: ".png",
      mime: "image/png",
      storageName: id,
      size: bytes.byteLength,
      sha256: sha(bytes),
      ...metadata,
    }),
  );
  return id;
}

function pageRow(id: string): string {
  const row = store.db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
    { data: string } | undefined;
  return row!.data;
}

describe("readPrivateCopySources", () => {
  it("reads only selected Pages and rewrites asset URLs to verified hashes", () => {
    const bytes = new TextEncoder().encode("private-asset-bytes");
    const hash = sha(bytes);
    insertAsset(ASSET_ID, bytes);
    insertAsset(OTHER_ASSET_ID, new TextEncoder().encode("unused-asset"));
    const selectedId = insertPage(
      pageData(
        "page_a",
        document(paragraph("a1", "hello"), image(`folio-asset://${ASSET_ID}`)),
        { parentId: "page_parent" },
      ),
    );
    insertPage(
      pageData(
        "page_b",
        document(
          paragraph("b1", "unselected-secret"),
          image(`folio-asset://${OTHER_ASSET_ID}`),
        ),
      ),
    );
    const before = pageRow(selectedId);

    const sources = readPrivateCopySources(store, assetsDirectory, [
      selectedId,
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: selectedId,
      parentId: "page_parent",
      title: `Page ${selectedId}`,
    });
    expect(sources[0].raw).toContain(`folio-asset://${hash}`);
    expect(sources[0].raw).not.toContain(ASSET_ID);
    expect(sources[0].raw).not.toContain("unselected-secret");
    expect(sources[0].assets).toEqual([{ hash, bytes }]);
    expect(readFileSync(join(assetsDirectory, ASSET_ID))).toEqual(
      Buffer.from(bytes),
    );
    expect(pageRow(selectedId)).toBe(before);
  });

  it("rejects deleted, damaged, database and record Pages without writing", () => {
    const doc = document(paragraph("p1", "body"));
    const deleted = insertPage(pageData("deleted", doc, { deletedAt: 1 }));
    const damaged = insertPage(
      pageData("damaged", doc, { documentError: "unreadable" }),
    );
    const database = insertPage(
      pageData("database", doc, { kind: "database", database: {} }),
    );
    const owner = insertPage(pageData("owner", doc, { database: {} }));
    const record = insertPage(pageData("record", doc));
    store.db.exec(
      "CREATE TABLE record_memberships(page_id TEXT PRIMARY KEY,database_page_id TEXT NOT NULL)",
    );
    store.db
      .prepare(
        "INSERT INTO record_memberships(page_id,database_page_id) VALUES(?,?)",
      )
      .run(record, "owner");
    const before = pageRow(record);

    for (const [id, code] of [
      [deleted, "COPY_SOURCE_DELETED"],
      [damaged, "COPY_SOURCE_DOCUMENT_ERROR"],
      [database, "COPY_SOURCE_RECORD"],
      [owner, "COPY_SOURCE_RECORD"],
      [record, "COPY_SOURCE_RECORD"],
      ["missing", "COPY_SOURCE_MISSING"],
    ] as const) {
      expect(() =>
        readPrivateCopySources(store, assetsDirectory, [id]),
      ).toThrow(code);
    }
    expect(pageRow(record)).toBe(before);
  });

  it("rejects unsafe, missing and tampered asset files", () => {
    const bytes = new TextEncoder().encode("asset");
    const doc = document(image(`folio-asset://${ASSET_ID}`));

    insertAsset(ASSET_ID, bytes);
    const page = insertPage(pageData("page", doc));

    const outside = join(directory, "outside");
    writeFileSync(outside, bytes, { mode: 0o600 });

    rmSync(join(assetsDirectory, ASSET_ID));
    symlinkSync(outside, join(assetsDirectory, ASSET_ID));
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [page]),
    ).toThrow("UNSAFE_ASSET_FILE");

    rmSync(join(assetsDirectory, ASSET_ID));
    linkSync(outside, join(assetsDirectory, ASSET_ID));
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [page]),
    ).toThrow("UNSAFE_ASSET_FILE");

    rmSync(join(assetsDirectory, ASSET_ID));
    writeFileSync(join(assetsDirectory, ASSET_ID), bytes, { mode: 0o644 });
    chmodSync(join(assetsDirectory, ASSET_ID), 0o644);
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [page]),
    ).toThrow("UNSAFE_ASSET_FILE");

    chmodSync(join(assetsDirectory, ASSET_ID), 0o600);
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [page]),
    ).not.toThrow();

    writeFileSync(
      join(assetsDirectory, ASSET_ID),
      new TextEncoder().encode("tampered"),
      { mode: 0o600 },
    );
    chmodSync(join(assetsDirectory, ASSET_ID), 0o600);
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [page]),
    ).toThrow("ASSET_SIZE_MISMATCH");

    rmSync(join(assetsDirectory, ASSET_ID));
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [page]),
    ).toThrow("ASSET_FILE_MISSING");
  });

  it("rejects registry aliases and malformed asset URLs", () => {
    const bytes = new TextEncoder().encode("asset");
    insertAsset(ASSET_ID, bytes, { storageName: OTHER_ASSET_ID });
    const page = insertPage(
      pageData("page", document(image(`folio-asset://${ASSET_ID}`))),
    );
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [page]),
    ).toThrow("CORRUPT_ASSET_META");

    insertPage(
      pageData("bad_url", document(image("folio-asset://not-a-uuid"))),
    );
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, ["bad_url"]),
    ).toThrow("INVALID_ASSET_URL");
  });

  it("rejects duplicate selection and does not read an unselected missing asset", () => {
    insertAsset(ASSET_ID, new TextEncoder().encode("asset"));
    const selected = insertPage(
      pageData("selected", document(image(`folio-asset://${ASSET_ID}`))),
    );
    insertPage(
      pageData(
        "unselected",
        document(image("folio-asset://33333333-3333-4333-8333-333333333333")),
      ),
    );

    const sources = readPrivateCopySources(store, assetsDirectory, [selected]);
    expect(sources).toHaveLength(1);
    expect(() =>
      readPrivateCopySources(store, assetsDirectory, [selected, selected]),
    ).toThrow("DUPLICATE_SELECTED_ID");
  });
});
