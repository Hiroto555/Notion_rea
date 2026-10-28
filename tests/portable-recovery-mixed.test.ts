import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { attachFile } from "../src/persistence/assets";
import {
  exportMixedPortableRecovery,
  exportPortableRecordRecovery,
  parsePortableRecordRecovery,
  restorePortableRecordRecoveryToNewWorkspace,
} from "../src/persistence/portable-recovery";

function fixture() {
  const root = mkdtempSync(resolve("output/mixed-recovery-"));
  const assets = join(root, "assets");
  mkdirSync(assets);
  const store = new Store(join(root, "source.sqlite"));
  const db = store.create(null, "database", "saved DB");
  const empty = store.create(null, "database", "empty DB");
  const record = store.create(null, "page", "saved record");
  const normal = store.create(null, "page", "saved normal");
  const linked = store.create(null, "page", "saved linked");
  const repo = new RecordRepository(store);
  store.transaction(() => {
    repo.createSchema();
    repo.registerDatabase(empty.id);
    repo.attachForMigration(record.id, db.id, 3, {
      status: "saved",
      untouched: "preserve",
      old: "remove",
    });
  });
  const sourceFile = join(root, "image.png");
  writeFileSync(sourceFile, "synthetic bytes");
  const asset = attachFile(store.db, assets, sourceFile);
  const { rows: _rows, ...settings } = structuredClone(db.database!);
  settings.views[0].name = "pending settings";
  const { rows: _emptyRows, ...emptySettings } = structuredClone(
    empty.database!,
  );
  emptySettings.views[0].name = "empty pending settings";
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "pending record body",
            marks: [
              { type: "link", attrs: { href: `folio-page://${linked.id}` } },
            ],
          },
        ],
      },
      { type: "image", attrs: { src: asset.url } },
    ],
  };
  const generation = {
    normalPages: [
      {
        page: { ...normal, title: "normal pending" },
        baseRevision: normal.revision,
      },
      {
        page: { ...linked, title: "linked pending" },
        baseRevision: linked.revision,
      },
    ],
    records: [
      {
        page: { ...record, title: "record pending", doc, cover: asset.url },
        baseRevision: record.revision,
        baseValues: { status: "saved", untouched: "preserve", old: "remove" },
        valuesPatch: { status: "pending", old: null },
      },
    ],
    databaseSettings: [
      { databasePageId: db.id, baseRevision: db.revision, settings },
      {
        databasePageId: empty.id,
        baseRevision: empty.revision,
        settings: emptySettings,
      },
    ],
    ownerPatches: {
      [db.id]: { baseRevision: db.revision, patch: { title: "owner pending" } },
    },
  };
  return {
    root,
    assets,
    store,
    db,
    empty,
    record,
    normal,
    linked,
    repo,
    asset,
    generation,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("captures one SQLite snapshot even if another writer commits during export", () => {
  const f = fixture();
  const other = new Store(f.store.path);
  try {
    const get = f.store.get.bind(f.store);
    let updated = false;
    const spy = vi.spyOn(f.store, "get").mockImplementation((id) => {
      const page = get(id);
      if (id === f.record.id && !updated) {
        updated = true;
        new RecordRepository(other).patch(id, f.db.id, f.record.revision, {
          values: { status: "external" },
        });
      }
      return page;
    });
    const content = exportMixedPortableRecovery(
      f.store,
      f.assets,
      f.generation,
    );
    spy.mockRestore();
    const bundle = parsePortableRecordRecovery(content);
    expect(updated).toBe(true);
    expect(bundle.records[0].values.status).toBe("pending");
    expect(
      new RecordRepository(other).projection(f.record.id).values.status,
    ).toBe("external");
    expect(f.generation.records[0].baseValues.status).toBe("saved");
  } finally {
    other.close();
    f.dispose();
  }
});

it("releases the read transaction when mixed export refuses a draft", () => {
  const f = fixture();
  try {
    const draft = structuredClone(f.generation);
    draft.records[0].baseRevision += 1;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, draft),
    ).toThrow();
    expect(f.store.db.isTransaction).toBe(false);
    expect(f.store.get(f.record.id).title).toBe("saved record");
  } finally {
    f.dispose();
  }
});

it("refuses export inside a caller-owned transaction without changing that transaction", () => {
  const f = fixture();
  try {
    f.store.db.exec("BEGIN IMMEDIATE");
    const before = f.store.get(f.normal.id);
    f.store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(JSON.stringify({ ...before, title: "uncommitted" }), before.id);
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow(/transaction/);
    expect(f.store.db.isTransaction).toBe(true);
    expect(f.store.get(before.id).title).toBe("uncommitted");
    f.store.db.exec("ROLLBACK");
    expect(f.store.get(before.id).title).toBe("saved normal");
  } finally {
    if (f.store.db.isTransaction) f.store.db.exec("ROLLBACK");
    f.dispose();
  }
});

it("roundtrips one frozen mixed generation including pending link target and attachment", () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const before = structuredClone(f.generation);
    const content = exportMixedPortableRecovery(
      f.store,
      f.assets,
      f.generation,
    );
    const bundle = parsePortableRecordRecovery(content);
    expect(bundle.schemaVersion).toBe(4); // Recovery JSON format, not SQLite version.
    if (bundle.schemaVersion !== 4)
      throw new Error("unexpected recovery format");
    expect(bundle.databaseMembers).toEqual(
      expect.arrayContaining([
        { databasePageId: f.db.id, pageIds: [f.record.id] },
        { databasePageId: f.empty.id, pageIds: [] },
      ]),
    );
    const expectedIds = [
      f.normal.id,
      f.linked.id,
      f.record.id,
      f.db.id,
      f.empty.id,
    ];
    expect(bundle.pages.map((p) => p.id).sort()).toEqual(expectedIds.sort());
    const result = restorePortableRecordRecoveryToNewWorkspace(
      content,
      join(f.root, "restored"),
    );
    restored = new Store(join(result.path, "workspace.sqlite"));
    const normal = restored.get(result.pageIds[f.normal.id]);
    const linked = restored.get(result.pageIds[f.linked.id]);
    const record = restored.get(result.pageIds[f.record.id]);
    const owner = restored.get(result.pageIds[f.db.id]);
    const empty = restored.get(result.pageIds[f.empty.id]);
    expect(normal.title).toBe("normal pending");
    expect(linked.title).toBe("linked pending");
    expect(record.title).toBe("record pending");
    expect(owner.title).toBe("owner pending");
    expect(normal.position).toBe(f.normal.position);
    expect(linked.position).toBe(f.linked.position);
    expect(record.position).toBe(f.record.position);
    expect(owner.position).toBe(f.db.position);
    expect(empty.position).toBe(f.empty.position);
    const restoredOrder = [normal, linked, owner, empty]
      .sort((a, b) => a.position - b.position)
      .map((p) => p.title);
    const sourceOrder = [f.normal, f.linked, f.db, f.empty]
      .sort((a, b) => a.position - b.position)
      .map((p) => result.pageIds[p.id]);
    expect(
      [normal, linked, owner, empty]
        .sort((a, b) => a.position - b.position)
        .map((p) => p.id),
    ).toEqual(sourceOrder);
    expect(restoredOrder).toContain("linked pending");
    expect(owner.database?.views[0].name).toBe("pending settings");
    expect(empty.database?.views[0].name).toBe("empty pending settings");
    const projection = new RecordRepository(restored).projection(record.id);
    expect(projection.databasePageId).toBe(owner.id);
    expect(projection.values).toEqual({
      status: "pending",
      untouched: "preserve",
    });
    expect(record.doc.content?.[0].content?.[0].marks?.[0].attrs?.href).toBe(
      `folio-page://${linked.id}`,
    );
    const assetId = result.assetIds[f.asset.id];
    expect(record.cover).toBe(`folio-asset://${assetId}`);
    expect(record.doc.content?.[1].attrs?.src).toBe(`folio-asset://${assetId}`);
    expect(readFileSync(join(result.path, "assets", assetId), "utf8")).toBe(
      "synthetic bytes",
    );
    expect(
      new RecordRepository(restored).databaseProjection(empty.id).records,
    ).toEqual([]);
    expect(restored.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      4,
    );
    expect(f.generation).toEqual(before);
    expect(f.store.get(f.linked.id).title).toBe("saved linked");
    expect(f.repo.projection(f.record.id).values).toEqual({
      status: "saved",
      untouched: "preserve",
      old: "remove",
    });
  } finally {
    restored?.close();
    f.dispose();
  }
});

it("roundtrips distinct Page timestamps for normal, record, owner, empty DB and linked closure", () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const stamps = [
      [f.normal, 101, 201],
      [f.record, 102, 202],
      [f.db, 103, 203],
      [f.empty, 104, 204],
      [f.linked, 105, 205],
    ] as const;
    for (const [page, createdAt, updatedAt] of stamps)
      f.store.write({ ...page, createdAt, updatedAt });
    f.generation.normalPages[0].page = {
      ...f.generation.normalPages[0].page,
      createdAt: 101,
      updatedAt: 201,
    };
    f.generation.normalPages.splice(1, 1); // linked is captured through closure
    f.generation.records[0].page = {
      ...f.generation.records[0].page,
      createdAt: 102,
      updatedAt: 202,
    };
    const content = exportMixedPortableRecovery(
      f.store,
      f.assets,
      f.generation,
    );
    const bundle = parsePortableRecordRecovery(content);
    if (bundle.schemaVersion !== 4) throw new Error("unexpected format");
    for (const [page, createdAt, updatedAt] of stamps)
      expect(bundle.pages.find((item) => item.id === page.id)).toMatchObject({
        createdAt,
        updatedAt,
      });
    const result = restorePortableRecordRecoveryToNewWorkspace(
      content,
      join(f.root, "timestamps"),
    );
    restored = new Store(join(result.path, "workspace.sqlite"));
    for (const [page, createdAt, updatedAt] of stamps)
      expect(restored.get(result.pageIds[page.id])).toMatchObject({
        createdAt,
        updatedAt,
      });
  } finally {
    restored?.close();
    f.dispose();
  }
});

it.each(["normal", "record", "owner", "linked"])(
  "rejects missing, invalid or unknown timestamp values in raw %s source",
  (kind) => {
    const f = fixture();
    try {
      const page =
        kind === "normal"
          ? f.normal
          : kind === "record"
            ? f.record
            : kind === "owner"
              ? f.db
              : f.linked;
      if (kind === "linked") f.generation.normalPages.splice(1, 1);
      const row = f.store.db
        .prepare("SELECT data FROM pages WHERE id=?")
        .get(page.id) as { data: string };
      for (const variant of ["missing", "negative", "unknown", "null"]) {
        const value = JSON.parse(row.data);
        if (variant === "missing") delete value.createdAt;
        if (variant === "negative") value.updatedAt = -1;
        if (variant === "unknown") value.createdAt = { future: "keep" };
        if (variant === "null") value.updatedAt = null;
        const source = JSON.stringify(value, null, 2);
        f.store.db
          .prepare("UPDATE pages SET data=? WHERE id=?")
          .run(source, page.id);
        expect(() =>
          exportMixedPortableRecovery(f.store, f.assets, f.generation),
        ).toThrow();
        expect(
          (
            f.store.db
              .prepare("SELECT data FROM pages WHERE id=?")
              .get(page.id) as { data: string }
          ).data,
        ).toBe(source);
      }
    } finally {
      f.dispose();
    }
  },
);

it.each(["normal", "record"])(
  "rejects fabricated or invalid %s draft timestamps",
  (kind) => {
    const f = fixture();
    try {
      const pending = structuredClone(f.generation);
      const target =
        kind === "normal"
          ? pending.normalPages[0].page
          : pending.records[0].page;
      target.createdAt++;
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, pending),
      ).toThrow();
      target.createdAt--;
      target.updatedAt = NaN;
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, pending),
      ).toThrow();
      target.updatedAt = Infinity;
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, pending),
      ).toThrow();
      expect(
        f.store.get(kind === "normal" ? f.normal.id : f.record.id),
      ).toMatchObject({
        createdAt: kind === "normal" ? f.normal.createdAt : f.record.createdAt,
      });
    } finally {
      f.dispose();
    }
  },
);

it.each(["normal", "record"])(
  "rejects a fabricated %s parent even when the alternate page exists",
  (kind) => {
    const f = fixture();
    try {
      const pending = structuredClone(f.generation);
      const target =
        kind === "normal"
          ? pending.normalPages[0].page
          : pending.records[0].page;
      target.parentId = f.linked.id;
      const sourceId = kind === "normal" ? f.normal.id : f.record.id;
      const raw = (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(sourceId) as { data: string }
      ).data;
      const before = structuredClone(pending);
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, pending),
      ).toThrow();
      expect(pending).toEqual(before);
      expect(
        (
          f.store.db
            .prepare("SELECT data FROM pages WHERE id=?")
            .get(sourceId) as { data: string }
        ).data,
      ).toBe(raw);
    } finally {
      f.dispose();
    }
  },
);

it("exports settings-only and owner-patch-only empty DBs with no records", () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const content = exportMixedPortableRecovery(f.store, f.assets, {
      normalPages: [],
      records: [],
      databaseSettings: [f.generation.databaseSettings[1]],
      ownerPatches: {
        [f.empty.id]: {
          baseRevision: f.empty.revision,
          patch: { title: "empty pending" },
        },
      },
    });
    const bundle = parsePortableRecordRecovery(content);
    expect(bundle.records).toEqual([]);
    expect(bundle.pages).toHaveLength(1);
    const result = restorePortableRecordRecoveryToNewWorkspace(
      content,
      join(f.root, "settings-only"),
    );
    restored = new Store(join(result.path, "workspace.sqlite"));
    const owner = restored.get(result.pageIds[f.empty.id]);
    expect(owner.title).toBe("empty pending");
    expect(
      new RecordRepository(restored).databaseProjection(owner.id).settings
        .views[0].name,
    ).toBe("empty pending settings");
  } finally {
    restored?.close();
    f.dispose();
  }
});

it("accepts a normal-only draft and refuses an entirely empty generation", () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, {
        normalPages: [],
        records: [],
        databaseSettings: [],
      }),
    ).toThrow();
    const content = exportMixedPortableRecovery(f.store, f.assets, {
      normalPages: [f.generation.normalPages[0]],
      records: [],
      databaseSettings: [],
    });
    const bundle = parsePortableRecordRecovery(content);
    expect(bundle.records).toEqual([]);
    expect(bundle.pages).toHaveLength(1);
    const result = restorePortableRecordRecoveryToNewWorkspace(
      content,
      join(f.root, "normal-only"),
    );
    restored = new Store(join(result.path, "workspace.sqlite"));
    expect(restored.get(result.pageIds[f.normal.id]).title).toBe(
      "normal pending",
    );
  } finally {
    restored?.close();
    f.dispose();
  }
});

it("refuses settings-only for a nonempty database and refuses omitted records including trashed members", () => {
  const f = fixture();
  try {
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, {
        normalPages: [],
        records: [],
        databaseSettings: [f.generation.databaseSettings[0]],
      }),
    ).toThrow(/全レコード/);
    const other = f.store.create(null, "page", "unselected member");
    f.store.transaction(() =>
      f.repo.attachForMigration(other.id, f.db.id, 5, { status: "other" }),
    );
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow(/全レコード/);
    const linked = structuredClone(f.generation) as any;
    linked.records[0].page.doc.content[0].content[0].marks[0].attrs.href = `folio-page://${other.id}`;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, linked),
    ).toThrow();
    f.store.write({ ...other, deletedAt: 123 });
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow(/全レコード/);
    const includeDeleted = structuredClone(f.generation) as any;
    includeDeleted.records.push({
      page: f.store.get(other.id),
      baseValues: { status: "other" },
    });
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, includeDeleted),
    ).toThrow();
    expect(f.repo.projection(other.id)).toMatchObject({
      deletedAt: 123,
      values: { status: "other" },
    });
    expect(f.store.get(f.db.id).title).toBe("saved DB");
  } finally {
    f.dispose();
  }
});

it("retains old v3 export and accepts it with the new parser and restore", () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const old = exportPortableRecordRecovery(
      f.store,
      f.assets,
      f.generation.records,
    );
    expect(parsePortableRecordRecovery(old).schemaVersion).toBe(3);
    expect(
      JSON.parse(old).pages.every(
        (page: any) => !Object.hasOwn(page, "position"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(old).pages.every(
        (page: any) =>
          !Object.hasOwn(page, "createdAt") &&
          !Object.hasOwn(page, "updatedAt"),
      ),
    ).toBe(true);
    const result = restorePortableRecordRecoveryToNewWorkspace(
      old,
      join(f.root, "v3"),
    );
    restored = new Store(join(result.path, "workspace.sqlite"));
    expect(
      new RecordRepository(restored).projection(result.pageIds[f.record.id])
        .values.status,
    ).toBe("pending");
    expect(restored.get(result.pageIds[f.record.id]).position).toBe(0);
  } finally {
    restored?.close();
    f.dispose();
  }
});

it("rejects duplicate, lossy, unknown or missing drafts and keeps inputs and source intact", () => {
  const f = fixture();
  try {
    const before = structuredClone(f.generation),
      raw = (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.db.id) as { data: string }
      ).data;
    const duplicate = structuredClone(f.generation);
    duplicate.normalPages.push(duplicate.normalPages[0]);
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, duplicate),
    ).toThrow();
    const invalidSettings = structuredClone(f.generation) as any;
    invalidSettings.databaseSettings[0].settings.views[0].future = "keep";
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, invalidSettings),
    ).toThrow();
    const unknownDraft = structuredClone(f.generation) as any;
    unknownDraft.records[0].unhandledPending = "keep";
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, unknownDraft),
    ).toThrow();
    const orphan = structuredClone(f.generation) as any;
    orphan.ownerPatches["missing"] = {
      baseRevision: 0,
      patch: { title: "not dropped" },
    };
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, orphan),
    ).toThrow();
    const badLink = structuredClone(f.generation) as any;
    badLink.records[0].page.doc.content[0].content[0].marks[0].attrs.href =
      "folio-page://not-present";
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, badLink),
    ).toThrow();
    const missingAsset = structuredClone(f.generation) as any;
    missingAsset.records[0].page.cover =
      "folio-asset://12345678-1234-1234-1234-123456789abc";
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, missingAsset),
    ).toThrow();
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, {
        ...f.generation,
        futurePending: "keep",
      } as any),
    ).toThrow();
    expect(f.generation).toEqual(before);
    expect(
      (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.db.id) as { data: string }
      ).data,
    ).toBe(raw);
    expect(readFileSync(join(f.assets, f.asset.id), "utf8")).toBe(
      "synthetic bytes",
    );
  } finally {
    f.dispose();
  }
});

it("requires a complete observed record base at the current revision without filling missing values", () => {
  const f = fixture();
  try {
    const before = structuredClone(f.generation);
    const missing = structuredClone(f.generation) as any;
    delete missing.records[0].baseValues.untouched;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, missing),
    ).toThrow(/観測値/);
    const extra = structuredClone(f.generation) as any;
    extra.records[0].baseValues.unobserved = "value";
    expect(() => exportMixedPortableRecovery(f.store, f.assets, extra)).toThrow(
      /観測値/,
    );
    const wrong = structuredClone(f.generation) as any;
    wrong.records[0].baseValues.untouched = "different";
    expect(() => exportMixedPortableRecovery(f.store, f.assets, wrong)).toThrow(
      /観測値/,
    );
    const noRevision = structuredClone(f.generation) as any;
    delete noRevision.records[0].baseRevision;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, noRevision),
    ).toThrow(/revision/);
    const stale = structuredClone(f.generation) as any;
    stale.records[0].baseRevision++;
    expect(() => exportMixedPortableRecovery(f.store, f.assets, stale)).toThrow(
      /revision/,
    );
    f.repo.patch(f.record.id, f.db.id, f.record.revision, {
      values: { status: "concurrent" },
    });
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow(/revision/);
    expect(f.generation).toEqual(before);
    expect(f.repo.projection(f.record.id).values).toEqual({
      status: "concurrent",
      untouched: "preserve",
      old: "remove",
    });
  } finally {
    f.dispose();
  }
});

it("refuses stale normal-page title drafts after an external document update", () => {
  const f = fixture();
  try {
    const pending = structuredClone(f.generation);
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "external document" }],
        },
      ],
    };
    const current = f.store.update(f.normal.id, f.normal.revision, { doc });
    const raw = (
      f.store.db
        .prepare("SELECT data FROM pages WHERE id=?")
        .get(f.normal.id) as { data: string }
    ).data;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow();
    expect(f.generation).toEqual(pending);
    expect(
      (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.normal.id) as { data: string }
      ).data,
    ).toBe(raw);
    expect(f.store.get(f.normal.id)).toMatchObject({
      revision: current.revision,
      doc,
    });
  } finally {
    f.dispose();
  }
});

it("refuses stale DB settings after an external property change", () => {
  const f = fixture();
  try {
    const pending = structuredClone(f.generation);
    const { rows: _rows, ...settings } = structuredClone(f.db.database!);
    settings.properties.push({
      id: "external",
      name: "External",
      type: "text",
    });
    const result = f.repo.updateSettings(f.db.id, f.db.revision, settings);
    const raw = (
      f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(f.db.id) as {
        data: string;
      }
    ).data;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow();
    expect(f.generation).toEqual(pending);
    expect(
      (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.db.id) as { data: string }
      ).data,
    ).toBe(raw);
    expect(f.store.get(f.db.id).revision).toBe(result.revision);
    expect(f.store.get(f.db.id).database?.properties).toContainEqual({
      id: "external",
      name: "External",
      type: "text",
    });
  } finally {
    f.dispose();
  }
});

it("refuses a stale owner Page patch after an external document update", () => {
  const f = fixture();
  try {
    const generation = {
      normalPages: [],
      records: [],
      databaseSettings: [],
      ownerPatches: {
        [f.empty.id]: {
          baseRevision: f.empty.revision,
          patch: { title: "pending owner" },
        },
      },
    };
    const pending = structuredClone(generation);
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "owner external" }],
        },
      ],
    };
    const current = f.store.update(f.empty.id, f.empty.revision, { doc });
    const raw = (
      f.store.db
        .prepare("SELECT data FROM pages WHERE id=?")
        .get(f.empty.id) as { data: string }
    ).data;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, generation),
    ).toThrow();
    expect(generation).toEqual(pending);
    expect(
      (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.empty.id) as { data: string }
      ).data,
    ).toBe(raw);
    expect(f.store.get(f.empty.id)).toMatchObject({
      revision: current.revision,
      doc,
    });
  } finally {
    f.dispose();
  }
});

it("refuses missing or inconsistent observed revisions in each v4 draft", () => {
  const f = fixture();
  try {
    const missingNormal = structuredClone(f.generation) as any;
    delete missingNormal.normalPages[0].baseRevision;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, missingNormal),
    ).toThrow();
    const mismatchPage = structuredClone(f.generation) as any;
    mismatchPage.normalPages[0].page.revision++;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, mismatchPage),
    ).toThrow();
    const missingSettings = structuredClone(f.generation) as any;
    delete missingSettings.databaseSettings[0].baseRevision;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, missingSettings),
    ).toThrow();
    const missingOwner = structuredClone(f.generation) as any;
    delete missingOwner.ownerPatches[f.db.id].baseRevision;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, missingOwner),
    ).toThrow();
    const mixedOwner = structuredClone(f.generation) as any;
    mixedOwner.ownerPatches[f.db.id].baseRevision++;
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, mixedOwner),
    ).toThrow();
  } finally {
    f.dispose();
  }
});

it("refuses unknown or malformed attachment metadata for v4 while preserving raw bytes and v3 behavior", () => {
  const f = fixture();
  try {
    const original = f.store.db
      .prepare("SELECT metadata FROM assets WHERE id=?")
      .get(f.asset.id) as { metadata: string };
    const source = JSON.parse(original.metadata);
    source.future = { keep: "raw" };
    const unknown = JSON.stringify(source, null, 2);
    f.store.db
      .prepare("UPDATE assets SET metadata=? WHERE id=?")
      .run(unknown, f.asset.id);
    const pending = structuredClone(f.generation);
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow();
    expect(f.generation).toEqual(pending);
    expect(
      (
        f.store.db
          .prepare("SELECT metadata FROM assets WHERE id=?")
          .get(f.asset.id) as { metadata: string }
      ).metadata,
    ).toBe(unknown);
    expect(readFileSync(join(f.assets, f.asset.id), "utf8")).toBe(
      "synthetic bytes",
    );
    expect(
      parsePortableRecordRecovery(
        exportPortableRecordRecovery(f.store, f.assets, f.generation.records),
      ).schemaVersion,
    ).toBe(3);
    delete source.future;
    source.mime = 17;
    const invalid = JSON.stringify(source, null, 2);
    f.store.db
      .prepare("UPDATE assets SET metadata=? WHERE id=?")
      .run(invalid, f.asset.id);
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow();
    expect(
      (
        f.store.db
          .prepare("SELECT metadata FROM assets WHERE id=?")
          .get(f.asset.id) as { metadata: string }
      ).metadata,
    ).toBe(invalid);
  } finally {
    f.dispose();
  }
});

it("preserves known recovery provenance for normal, record, and owner pages", () => {
  const f = fixture();
  let restored: Store | undefined;
  try {
    const priorNormal = { pageId: "prior-normal", recoveredAt: 1234 };
    const priorRecord = { pageId: "prior-record", recoveredAt: 5678 };
    const priorOwner = { pageId: "prior-owner", recoveredAt: 9012 };
    const priorLinked = { pageId: "prior-linked", recoveredAt: 3456 };
    f.store.write({ ...f.normal, recoveredFrom: priorNormal });
    f.store.write({ ...f.record, recoveredFrom: priorRecord });
    f.store.write({ ...f.db, recoveredFrom: priorOwner });
    f.store.write({ ...f.linked, recoveredFrom: priorLinked });
    f.generation.normalPages[0].page = {
      ...f.generation.normalPages[0].page,
      recoveredFrom: priorNormal,
    };
    f.generation.normalPages.splice(1, 1); // Linked page comes from saved closure.
    f.generation.records[0].page = {
      ...f.generation.records[0].page,
      recoveredFrom: priorRecord,
    };
    const content = exportMixedPortableRecovery(
      f.store,
      f.assets,
      f.generation,
    );
    const result = restorePortableRecordRecoveryToNewWorkspace(
      content,
      join(f.root, "provenance"),
    );
    restored = new Store(join(result.path, "workspace.sqlite"));
    expect(restored.get(result.pageIds[f.normal.id]).recoveredFrom).toEqual(
      priorNormal,
    );
    expect(restored.get(result.pageIds[f.record.id]).recoveredFrom).toEqual(
      priorRecord,
    );
    expect(restored.get(result.pageIds[f.db.id]).recoveredFrom).toEqual(
      priorOwner,
    );
    expect(restored.get(result.pageIds[f.linked.id]).recoveredFrom).toEqual(
      priorLinked,
    );
  } finally {
    restored?.close();
    f.dispose();
  }
});

it.each(["normal", "record", "owner", "linked"])(
  "rejects unknown nested recovery provenance in raw %s data",
  (kind) => {
    const f = fixture();
    try {
      const page =
        kind === "normal"
          ? f.normal
          : kind === "record"
            ? f.record
            : kind === "owner"
              ? f.db
              : f.linked;
      if (kind === "linked") f.generation.normalPages.splice(1, 1);
      const row = f.store.db
        .prepare("SELECT data FROM pages WHERE id=?")
        .get(page.id) as { data: string };
      const raw = JSON.parse(row.data);
      raw.recoveredFrom = {
        pageId: "prior",
        recoveredAt: 1,
        future: { keep: true },
      };
      const source = JSON.stringify(raw, null, 2);
      f.store.db
        .prepare("UPDATE pages SET data=? WHERE id=?")
        .run(source, page.id);
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, f.generation),
      ).toThrow();
      expect(
        (
          f.store.db
            .prepare("SELECT data FROM pages WHERE id=?")
            .get(page.id) as { data: string }
        ).data,
      ).toBe(source);
    } finally {
      f.dispose();
    }
  },
);

it.each(["normal", "record"])(
  "rejects invalid or unknown provenance in supplied %s drafts",
  (kind) => {
    const f = fixture();
    try {
      const bad = structuredClone(f.generation) as any;
      const page =
        kind === "normal" ? bad.normalPages[0].page : bad.records[0].page;
      page.recoveredFrom = { pageId: "prior", recoveredAt: 1, future: "keep" };
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, bad),
      ).toThrow();
      page.recoveredFrom = { pageId: "prior", recoveredAt: -1 };
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, bad),
      ).toThrow();
      page.recoveredFrom = { pageId: "prior", recoveredAt: 1 };
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, bad),
      ).toThrow(); // conflicts with absent source provenance
    } finally {
      f.dispose();
    }
  },
);

it.each(["normal", "record"])(
  "refuses a %s draft that omits valid source provenance",
  (kind) => {
    const f = fixture();
    try {
      const page = kind === "normal" ? f.normal : f.record;
      const previous = { pageId: "prior", recoveredAt: 123 };
      f.store.write({ ...page, recoveredFrom: previous });
      expect(() =>
        exportMixedPortableRecovery(f.store, f.assets, f.generation),
      ).toThrow();
      expect(f.store.get(page.id).recoveredFrom).toEqual(previous);
    } finally {
      f.dispose();
    }
  },
);

it("rolls back empty DB registration on failure and leaves the input and source unchanged", () => {
  const f = fixture();
  try {
    const content = exportMixedPortableRecovery(
      f.store,
      f.assets,
      f.generation,
    );
    const before = structuredClone(f.generation),
      dest = join(f.root, "interrupted");
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(content, dest, (phase) => {
        if (phase === "database") throw new Error("injected failure");
      }),
    ).toThrow("injected failure");
    expect(existsSync(join(dest, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(true);
    expect(existsSync(join(dest, "FOLIO-RECOVERY-COMPLETE"))).toBe(false);
    const db = new DatabaseSync(join(dest, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='record_databases'")
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
    expect(f.generation).toEqual(before);
    expect(f.store.get(f.empty.id).title).toBe("empty DB");
    expect(f.repo.projection(f.record.id).values).toEqual({
      status: "saved",
      untouched: "preserve",
      old: "remove",
    });
  } finally {
    f.dispose();
  }
});

it("refuses unknown serialized fields and source schema without creating output", () => {
  const f = fixture();
  try {
    const content = exportMixedPortableRecovery(
      f.store,
      f.assets,
      f.generation,
    );
    const bundle = JSON.parse(content);
    bundle.pages[0].future = "unknown";
    const dest = join(f.root, "bad");
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(JSON.stringify(bundle), dest),
    ).toThrow();
    expect(existsSync(dest)).toBe(false);
    const missingRecord = JSON.parse(content);
    missingRecord.records = [];
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(
        JSON.stringify(missingRecord),
        dest,
      ),
    ).toThrow();
    expect(existsSync(dest)).toBe(false);
    const missingManifest = JSON.parse(content);
    missingManifest.databaseMembers = [];
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(
        JSON.stringify(missingManifest),
        dest,
      ),
    ).toThrow();
    expect(existsSync(dest)).toBe(false);
    const invalidPosition = JSON.parse(content);
    invalidPosition.pages[0].position = null;
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(
        JSON.stringify(invalidPosition),
        dest,
      ),
    ).toThrow();
    const oldPrototype = JSON.parse(content);
    delete oldPrototype.pages[0].position;
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(
        JSON.stringify(oldPrototype),
        dest,
      ),
    ).toThrow();
    const missingCreated = JSON.parse(content);
    delete missingCreated.pages[0].createdAt;
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(
        JSON.stringify(missingCreated),
        dest,
      ),
    ).toThrow();
    const badUpdated = JSON.parse(content);
    badUpdated.pages[0].updatedAt = -1;
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(
        JSON.stringify(badUpdated),
        dest,
      ),
    ).toThrow();
    const unknownProvenance = JSON.parse(content);
    unknownProvenance.pages[0].recoveredFrom = {
      pageId: "prior",
      recoveredAt: 1,
      future: "keep",
    };
    expect(() =>
      restorePortableRecordRecoveryToNewWorkspace(
        JSON.stringify(unknownProvenance),
        dest,
      ),
    ).toThrow();
    expect(existsSync(dest)).toBe(false);
    const row = f.store.db
      .prepare("SELECT data FROM pages WHERE id=?")
      .get(f.linked.id) as { data: string };
    const raw = JSON.parse(row.data);
    raw.future = "keep";
    const original = JSON.stringify(raw, null, 2);
    f.store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(original, f.linked.id);
    expect(() =>
      exportMixedPortableRecovery(f.store, f.assets, f.generation),
    ).toThrow();
    expect(
      (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.linked.id) as { data: string }
      ).data,
    ).toBe(original);
  } finally {
    f.dispose();
  }
});
