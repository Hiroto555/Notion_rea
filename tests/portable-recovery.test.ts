import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import {
  exportPortableRecordRecovery,
  parsePortableRecordRecovery,
  restorePortableRecordRecoveryToNewWorkspace,
} from "../src/persistence/portable-recovery";

function fixture() {
  const root = mkdtempSync(resolve("output/portable-recovery-"));
  const assets = join(root, "assets");
  mkdirSync(assets);
  const store = new Store(join(root, "source.sqlite"));
  const db = store.create(null, "database", "DB");
  const page = store.create(null, "page", "saved title");
  const linked = store.create(null, "page", "linked");
  const records = new RecordRepository(store);
  store.transaction(() => {
    records.createSchema();
    records.attachForMigration(page.id, db.id, 4, {
      status: "saved",
      removed: "old",
    });
  });
  const file = join(root, "synthetic.png");
  writeFileSync(file, Buffer.from("synthetic-image-bytes"));
  const asset = attachFile(store.db, assets, file);
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "pending body",
            marks: [
              { type: "link", attrs: { href: `folio-page://${linked.id}` } },
            ],
          },
          {
            type: "text",
            text: "attachment",
            marks: [{ type: "link", attrs: { href: asset.url } }],
          },
        ],
      },
      { type: "image", attrs: { src: asset.url } },
    ],
  };
  const draft = {
    page: { ...page, title: "pending title", doc, cover: asset.url },
    baseValues: { status: "local base", removed: "old" },
    valuesPatch: { status: "pending", removed: null, extra: true },
  };
  const content = () =>
    exportPortableRecordRecovery(store, assets, [draft], {
      [db.id]: { title: "pending DB" },
    });
  return {
    root,
    assets,
    store,
    db,
    page,
    linked,
    records,
    asset,
    draft,
    content,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("refuses unknown raw DB fields before normalization without altering source", () => {
  const f = fixture();
  try {
    const row = f.store.db
      .prepare("SELECT data FROM pages WHERE id=?")
      .get(f.db.id) as { data: string };
    const original = JSON.parse(row.data);
    original.database.futureField = { nested: "keep" };
    const raw = JSON.stringify(original);
    f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, f.db.id);
    expect(() => f.content()).toThrow();
    expect(
      (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.db.id) as { data: string }
      ).data,
    ).toBe(raw);
  } finally {
    f.dispose();
  }
});

it.each([
  "FOLIO-PAGE://linked",
  "  folio-page://linked",
  "folio-pa\nge://linked",
  "folio-page://link\ned",
  "FOLIO-ASSET://12345678-1234-1234-1234-123456789abc.png",
  "folio-ass\net://12345678-1234-1234-1234-123456789abc.png",
])(
  "rejects browser-normalized internal link spelling %s without changing source",
  (href) => {
    const f = fixture();
    try {
      const draft = {
        ...f.draft,
        page: {
          ...f.draft.page,
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "link",
                    marks: [{ type: "link", attrs: { href } }],
                  },
                ],
              },
            ],
          },
        },
      };
      expect(() =>
        exportPortableRecordRecovery(f.store, f.assets, [draft]),
      ).toThrow();
      expect(f.store.get(f.page.id).title).toBe("saved title");
      expect(readFileSync(join(f.assets, f.asset.id))).toEqual(
        Buffer.from("synthetic-image-bytes"),
      );
    } finally {
      f.dispose();
    }
  },
);

it("captures pending text and values, owner settings, linked pages and attachment bytes in a new workspace", () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const content = f.content(),
      bundle = parsePortableRecordRecovery(content),
      destination = join(f.root, "recovered");
    const result = restorePortableRecordRecoveryToNewWorkspace(
      content,
      destination,
    );
    expect(existsSync(join(destination, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(
      false,
    );
    expect(existsSync(join(destination, "FOLIO-RECOVERY-COMPLETE"))).toBe(true);
    restored = new Store(join(destination, "workspace.sqlite"));
    const page = restored.get(result.pageIds[f.page.id]),
      owner = restored.get(result.pageIds[f.db.id]);
    const projection = new RecordRepository(restored).projection(page.id);
    expect(page.id).not.toBe(f.page.id);
    expect(result.pageIds[f.linked.id]).not.toBe(f.linked.id);
    expect(projection.databasePageId).toBe(owner.id);
    expect(projection.values).toEqual({ status: "pending", extra: true });
    expect(page.title).toBe("pending title");
    expect(owner.title).toBe("pending DB");
    expect(owner.database).toEqual(f.db.database);
    expect(page.doc.content?.[0].content?.[0].marks?.[0].attrs?.href).toBe(
      `folio-page://${result.pageIds[f.linked.id]}`,
    );
    const assetUrl = `folio-asset://${result.assetIds[f.asset.id]}`;
    expect(page.cover).toBe(assetUrl);
    expect(page.doc.content?.[0].content?.[1].marks?.[0].attrs?.href).toBe(
      assetUrl,
    );
    expect(page.doc.content?.[1].attrs?.src).toBe(assetUrl);
    expect(
      readFileSync(join(destination, "assets", result.assetIds[f.asset.id])),
    ).toEqual(readFileSync(join(f.assets, f.asset.id)));
    expect(bundle.records[0].values).toEqual({
      status: "pending",
      extra: true,
    });
    expect(f.store.get(f.page.id).title).toBe("saved title");
    expect(f.records.projection(f.page.id).values.status).toBe("saved");
  } finally {
    restored?.close();
    f.dispose();
  }
});

it("refuses corrupt, missing, unknown or oversized data before creating a destination", () => {
  const f = fixture();
  try {
    const content = f.content(),
      original = JSON.parse(content);
    for (const mutate of [
      (b: any) => {
        b.assets[0].base64 = "YQ==";
      },
      (b: any) => {
        b.assets = [];
      },
      (b: any) => {
        b.pages[0].database.unrecognizedFutureField = 1;
      },
      (b: any) => {
        b.pages.push(b.pages[0]);
      },
      (b: any) => {
        b.pages[0].parentId = b.pages[0].id;
      },
    ]) {
      const corrupted = structuredClone(original);
      mutate(corrupted);
      const destination = join(f.root, "corrupt");
      expect(() =>
        restorePortableRecordRecoveryToNewWorkspace(
          JSON.stringify(corrupted),
          destination,
        ),
      ).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    expect(() => parsePortableRecordRecovery("あ".repeat(10_000_001))).toThrow(
      /30,000,000/,
    );
    const existing = join(f.root, "existing");
    mkdirSync(existing);
    writeFileSync(join(existing, "sentinel"), "original");
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(content, existing),
    ).toThrow();
    expect(readFileSync(join(existing, "sentinel"), "utf8")).toBe("original");
  } finally {
    f.dispose();
  }
});

it("leaves a marker and source intact after failures at each write phase", () => {
  const f = fixture();
  try {
    const content = f.content();
    for (const phase of ["assets", "database", "before-complete"] as const) {
      const dest = join(f.root, `failed-${phase}`);
      expect(() =>
        restorePortableRecordRecoveryToNewWorkspace(content, dest, (p) => {
          if (p === phase) throw new Error("injected failure");
        }),
      ).toThrow("injected failure");
      expect(existsSync(join(dest, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(true);
      expect(existsSync(join(dest, "FOLIO-RECOVERY-COMPLETE"))).toBe(false);
      expect(f.store.get(f.page.id).title).toBe("saved title");
      expect(readFileSync(join(f.assets, f.asset.id), "utf8")).toBe(
        "synthetic-image-bytes",
      );
    }
  } finally {
    f.dispose();
  }
});

it("refuses to export missing links and unselected record targets", () => {
  const f = fixture();
  try {
    const other = f.store.create(null, "page", "other record");
    f.store.transaction(() =>
      f.records.attachForMigration(other.id, f.db.id, 5, {}),
    );
    for (const id of [other.id, "missing-target"]) {
      const draft = structuredClone(f.draft);
      draft.page.doc.content![0].content![0].marks![0].attrs!.href = `folio-page://${id}`;
      expect(() =>
        exportPortableRecordRecovery(f.store, f.assets, [draft]),
      ).toThrow();
    }
  } finally {
    f.dispose();
  }
});

it("refuses to open a workspace marked as an incomplete recovery", () => {
  const root = mkdtempSync(resolve("output/recovery-incomplete-"));
  try {
    writeFileSync(join(root, "FOLIO-RECOVERY-INCOMPLETE"), "incomplete");
    expect(() => new Store(join(root, "workspace.sqlite"))).toThrow(
      "復旧が完了していない",
    );
    expect(existsSync(join(root, "workspace.sqlite"))).toBe(false);
    expect(readFileSync(join(root, "FOLIO-RECOVERY-INCOMPLETE"), "utf8")).toBe(
      "incomplete",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
