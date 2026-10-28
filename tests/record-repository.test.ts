import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";

function fixture() {
  const root = mkdtempSync(resolve("output/record-repository-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const db = store.create(null, "database", "DB");
  const page = store.create(null, "page", "Before");
  const records = new RecordRepository(store);
  store.transaction(() => {
    records.createSchema();
    records.attachForMigration(page.id, db.id, 0, {
      status: "old",
      date: "tomorrow",
    });
  });
  return {
    store,
    records,
    db,
    page,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("serializes title, body and per-key value changes using one page revision", () => {
  const f = fixture();
  try {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "new body" }] },
      ],
    };
    const body = f.store.updateRecordPage(f.page.id, f.db.id, 0, { doc });
    expect(() =>
      f.records.patch(f.page.id, f.db.id, 0, {
        title: "stale",
        values: { status: "bad" },
      }),
    ).toThrow("競合");
    expect(f.records.projection(f.page.id).values).toEqual({
      status: "old",
      date: "tomorrow",
    });
    const ack = f.records.patch(f.page.id, f.db.id, body.revision, {
      title: "After",
      values: { status: "new", date: null },
    });
    expect(ack).toMatchObject({
      pageId: f.page.id,
      databasePageId: f.db.id,
      title: "After",
      revision: 2,
      values: { status: "new" },
    });
    expect(ack).not.toHaveProperty("doc");
    expect(f.store.get(f.page.id).doc).toEqual(doc);
    const history = f.store.db
      .prepare(
        "SELECT v.title, v.doc, r.values_json FROM versions v JOIN record_value_versions r ON r.version_id=v.id WHERE v.pageId=? ORDER BY v.id DESC",
      )
      .get(f.page.id) as { title: string; doc: string; values_json: string };
    expect(history.title).toBe("Before");
    expect(JSON.parse(history.doc)).toEqual(doc);
    expect(JSON.parse(history.values_json)).toEqual({
      status: "old",
      date: "tomorrow",
    });
  } finally {
    f.dispose();
  }
});

it("rolls back title, values and history together when the page write fails", () => {
  const f = fixture();
  try {
    f.store.db.exec(
      "CREATE TRIGGER fail_page BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT, 'simulated page failure'); END",
    );
    expect(() =>
      f.records.patch(f.page.id, f.db.id, 0, {
        title: "lost",
        values: { status: "lost" },
      }),
    ).toThrow("simulated page failure");
    expect(f.records.projection(f.page.id)).toMatchObject({
      revision: 0,
      title: "Before",
      values: { status: "old", date: "tomorrow" },
    });
    expect(f.store.versions(f.page.id)).toHaveLength(0);
    expect(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM record_value_versions")
        .get()?.n,
    ).toBe(0);
  } finally {
    f.dispose();
  }
});

it("rejects invalid values, unknown patch fields, and a deleted owning database", () => {
  const f = fixture();
  try {
    expect(() =>
      f.records.patch(f.page.id, f.db.id, 0, { values: { status: Number.NaN } }),
    ).toThrow();
    expect(() =>
      f.records.patch(f.page.id, f.db.id, 0, { title: "bad", doc: {} } as any),
    ).toThrow();
    expect(f.records.projection(f.page.id).revision).toBe(0);
    // Fixture for a database that was already in trash when migrated.
    const owner = f.store.get(f.db.id);
    f.store.write({ ...owner, deletedAt: Date.now() });
    expect(() => f.records.patch(f.page.id, f.db.id, 0, { title: "bad" })).toThrow();
    expect(f.records.projection(f.page.id).title).toBe("Before");
  } finally {
    f.dispose();
  }
});

it("retains record identity, values, revision, and value history after reopening a dedicated store", () => {
  const f = fixture();
  const path = f.store.path;
  const expected = f.records.patch(f.page.id, f.db.id, 0, {
    title: "Saved",
    values: { status: "done" },
  });
  f.store.close();
  let reopened: Store | undefined;
  try {
    reopened = new Store(path);
    const records = new RecordRepository(reopened);
    expect(records.projection(f.page.id)).toEqual(expected);
    expect(reopened.get(f.page.id).revision).toBe(1);
    expect(
      reopened.db
        .prepare("SELECT COUNT(*) AS n FROM record_value_versions")
        .get()?.n,
    ).toBe(1);
  } finally {
    reopened?.close();
    rmSync(resolve(path, ".."), { recursive: true, force: true });
  }
});

it("restores record body, title and values together and records history of body-only edits", () => {
  const f = fixture();
  try {
    const first = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first" }] },
      ],
    };
    f.store.updateRecordPage(f.page.id, f.db.id, 0, { doc: first });
    f.records.patch(f.page.id, f.db.id, 1, {
      title: "Second",
      values: { status: "second" },
    });
    const version = f.store.versions(f.page.id)[0];
    const later = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "later" }] },
      ],
    };
    f.store.updateRecordPage(f.page.id, f.db.id, 2, { doc: later });
    f.store.handle({
      type: "restoreVersion",
      id: f.page.id,
      versionId: version.id,
      revision: f.store.get(f.page.id).revision,
    });
    expect(f.store.get(f.page.id).doc).toEqual(first);
    expect(f.records.projection(f.page.id)).toMatchObject({
      title: "Before",
      revision: 4,
      values: { status: "old", date: "tomorrow" },
    });
    expect(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM record_value_versions")
        .get()?.n,
    ).toBe(4);
  } finally {
    f.dispose();
  }
});

it("does not change a record when a history value snapshot is missing or malformed", () => {
  const f = fixture();
  try {
    f.store.updateRecordPage(f.page.id, f.db.id, 0, { title: "new" });
    const versionId = f.store.versions(f.page.id)[0].id;
    f.store.db
      .prepare(
        "UPDATE record_value_versions SET values_json=? WHERE version_id=?",
      )
      .run('{"future":{}}', versionId);
    const before = f.records.projection(f.page.id);
    expect(() =>
      f.store.handle({
        type: "restoreVersion",
        id: f.page.id,
        versionId,
        revision: f.store.get(f.page.id).revision,
      }),
    ).toThrow();
    expect(f.records.projection(f.page.id)).toEqual(before);
    expect(
      f.store.db
        .prepare(
          "SELECT values_json FROM record_value_versions WHERE version_id=?",
        )
        .get(versionId)?.values_json,
    ).toBe('{"future":{}}');
    f.store.db
      .prepare("DELETE FROM record_value_versions WHERE version_id=?")
      .run(versionId);
    expect(() =>
      f.store.handle({
        type: "restoreVersion",
        id: f.page.id,
        versionId,
        revision: f.store.get(f.page.id).revision,
      }),
    ).toThrow("完全な履歴");
    expect(f.records.projection(f.page.id)).toEqual(before);
  } finally {
    f.dispose();
  }
});

it("rejects body edits when stored values are malformed and preserves the original bytes", () => {
  const f = fixture();
  try {
    const raw = '{ "unsupported": { "future": true } }';
    f.store.db
      .prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?")
      .run(raw, f.page.id);
    expect(() =>
      f.store.updateRecordPage(f.page.id, f.db.id, 0, { title: "overwrite" }),
    ).toThrow();
    expect(f.store.get(f.page.id).title).toBe("Before");
    expect(f.store.versions(f.page.id)).toHaveLength(0);
    expect(
      f.store.db
        .prepare("SELECT values_json FROM record_memberships WHERE page_id=?")
        .get(f.page.id)?.values_json,
    ).toBe(raw);
  } finally {
    f.dispose();
  }
});

it("accepts the strict record patch request and rejects stale or extra data", async () => {
  const { requestSchema } = await import("../src/shared/types");
  const f = fixture();
  try {
    const input = {
      type: "record:patch",
      pageId: f.page.id,
      databasePageId: f.db.id,
      revision: 0,
      patch: { values: { status: "done" } },
    };
    const request = requestSchema.parse(input);
    const { databasePageId: _missingOwner, ...withoutOwner } = input;
    expect(requestSchema.safeParse(withoutOwner).success).toBe(false);
    expect(requestSchema.safeParse({ ...input, databasePageId: "" }).success).toBe(false);
    const result = f.store.handle(request);
    expect(result).toMatchObject({
      pageId: f.page.id,
      databasePageId: f.db.id,
      revision: 1,
      values: { status: "done" },
    });
    expect(result).not.toHaveProperty("doc");
    expect(() => f.store.handle(request)).toThrow("競合");
    expect(requestSchema.safeParse({ ...input, rows: [] }).success).toBe(false);
    expect(
      requestSchema.safeParse({ ...input, patch: { values: {}, doc: {} } })
        .success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        ...input,
        patch: { values: JSON.parse('{"__proto__":"bad"}') },
      }).success,
    ).toBe(false);
  } finally {
    f.dispose();
  }
});

it("rejects a moved record at the same revision without changing Page, values or history", () => {
  const f = fixture();
  try {
    const other = f.store.create(null, "database", "other owner");
    f.store.transaction(() => f.records.registerDatabase(other.id));
    const request = {
      type: "record:patch" as const,
      pageId: f.page.id,
      databasePageId: f.db.id,
      revision: f.page.revision,
      patch: { title: "stale edit", values: { status: "stale value" } },
    };
    // Simulate a membership move by another writer that does not change Page revision.
    f.store.transaction(() => f.store.db.prepare(
      "UPDATE record_memberships SET database_page_id=? WHERE page_id=?",
    ).run(other.id, f.page.id));
    const beforePage = f.store.get(f.page.id);
    const beforeMember = f.store.db.prepare(
      "SELECT database_page_id,values_json FROM record_memberships WHERE page_id=?",
    ).get(f.page.id);
    const beforeVersions = f.store.versions(f.page.id);
    expect(() => f.store.handle(request)).toThrow(/owner/i);
    expect(f.store.get(f.page.id)).toEqual(beforePage);
    expect(f.store.db.prepare(
      "SELECT database_page_id,values_json FROM record_memberships WHERE page_id=?",
    ).get(f.page.id)).toEqual(beforeMember);
    expect(f.store.versions(f.page.id)).toEqual(beforeVersions);
    expect(f.records.patch(f.page.id, other.id, beforePage.revision, {
      title: "current edit", values: { status: "current value" },
    })).toMatchObject({ databasePageId: other.id, revision: beforePage.revision + 1 });
  } finally {
    f.dispose();
  }
});

it("supports owner-bound writes on v3 and v4 and refuses an unknown marker", () => {
  const f = fixture();
  try {
    expect(f.store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    const first = f.records.patch(f.page.id, f.db.id, 0, { title: "v3" });
    f.store.transaction(() => markRecordStoreVersion(f.store.db));
    const second = f.records.patch(f.page.id, f.db.id, first.revision, { values: { status: "v4" } });
    f.store.db.prepare("UPDATE folio_record_schema SET version=99").run();
    const before = f.store.get(f.page.id);
    const member = f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(f.page.id);
    const versions = f.store.versions(f.page.id);
    expect(() => f.records.patch(f.page.id, f.db.id, second.revision, { title: "unknown schema" })).toThrow(/record store/);
    expect(f.store.get(f.page.id)).toEqual(before);
    expect(f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(f.page.id)).toEqual(member);
    expect(f.store.versions(f.page.id)).toEqual(versions);
  } finally {
    f.dispose();
  }
});

it("rejects a missing owner registration and retains all record data", () => {
  const f = fixture();
  try {
    f.store.db.prepare("DELETE FROM record_databases WHERE database_page_id=?").run(f.db.id);
    const before = f.store.get(f.page.id);
    const member = f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(f.page.id);
    const versions = f.store.versions(f.page.id);
    expect(() => f.records.patch(f.page.id, f.db.id, before.revision, {
      title: "must not save", values: { status: "must not save" },
    })).toThrow();
    expect(f.store.get(f.page.id)).toEqual(before);
    expect(f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(f.page.id)).toEqual(member);
    expect(f.store.versions(f.page.id)).toEqual(versions);
  } finally {
    f.dispose();
  }
});

it("rejects a record revision that cannot be incremented without changing data or history", () => {
  const f = fixture();
  try {
    f.store.write({ ...f.store.get(f.page.id), revision: Number.MAX_SAFE_INTEGER - 1 });
    const accepted = f.records.patch(f.page.id, f.db.id, Number.MAX_SAFE_INTEGER - 1, {
      values: { status: "last safe revision" },
    });
    expect(accepted.revision).toBe(Number.MAX_SAFE_INTEGER);
    const beforePage = f.store.get(f.page.id);
    const beforeMember = f.store.db.prepare(
      "SELECT database_page_id,values_json FROM record_memberships WHERE page_id=?",
    ).get(f.page.id);
    const beforeVersions = f.store.versions(f.page.id);
    const beforeValueVersions = f.store.db.prepare(
      "SELECT COUNT(*) AS n FROM record_value_versions",
    ).get();
    expect(() => f.records.patch(f.page.id, f.db.id, Number.MAX_SAFE_INTEGER, {
      title: "must not save", values: { status: "must not save" },
    })).toThrow(/revision limit/);
    expect(f.store.get(f.page.id)).toEqual(beforePage);
    expect(f.store.db.prepare(
      "SELECT database_page_id,values_json FROM record_memberships WHERE page_id=?",
    ).get(f.page.id)).toEqual(beforeMember);
    expect(f.store.versions(f.page.id)).toEqual(beforeVersions);
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM record_value_versions").get()).toEqual(beforeValueVersions);
  } finally {
    f.dispose();
  }
});

it("rejects whole-row updates for migrated databases including empty ones", () => {
  const f = fixture();
  try {
    const old = f.store.get(f.db.id);
    expect(() =>
      f.store.update(f.db.id, old.revision, { database: old.database }),
    ).toThrow("旧形式");
    expect(f.store.get(f.db.id)).toEqual(old);
    const empty = f.store.create(null, "database", "empty");
    f.store.transaction(() => f.records.registerDatabase(empty.id));
    expect(() =>
      f.store.update(empty.id, empty.revision, { database: empty.database }),
    ).toThrow("旧形式");
    expect(f.store.get(empty.id)).toEqual(empty);
    const legacy = f.store.create(null, "database", "legacy");
    expect(
      f.store.update(legacy.id, legacy.revision, { database: legacy.database })
        .revision,
    ).toBe(1);
  } finally {
    f.dispose();
  }
});

it("rejects stale history restore and database injection into a record", () => {
  const f = fixture();
  try {
    f.store.updateRecordPage(f.page.id, f.db.id, 0, { title: "first" });
    const history = f.store.versions(f.page.id)[0].id;
    f.store.updateRecordPage(f.page.id, f.db.id, 1, { title: "later" });
    const before = f.store.get(f.page.id);
    expect(() =>
      f.store.handle({
        type: "restoreVersion",
        id: f.page.id,
        versionId: history,
        revision: 1,
      }),
    ).toThrow("競合");
    expect(() =>
      f.store.handle({
        type: "restoreVersion",
        id: f.page.id,
        versionId: history,
      }),
    ).toThrow("競合");
    expect(() =>
      f.store.update(f.page.id, before.revision, { database: f.db.database }),
    ).toThrow("所有データベース");
    expect(f.store.get(f.page.id)).toEqual(before);
  } finally {
    f.dispose();
  }
});

it("keeps record state independent of strictly validated database settings revisions", async () => {
  const { requestSchema } = await import("../src/shared/types");
  const f = fixture();
  try {
    const projection = f.records.databaseProjection(f.db.id);
    f.records.patch(f.page.id, f.db.id, 0, {
      title: "record title",
      values: { status: "new" },
    });
    const settings = {
      ...projection.settings,
      activeViewId: projection.settings.views[0].id,
    };
    const req = requestSchema.parse({
      type: "database:settings",
      databasePageId: f.db.id,
      revision: projection.revision,
      settings,
    });
    const saved = f.store.handle(req) as {
      revision: number;
      records: {
        pageId: string;
        title: string;
        values: Record<string, unknown>;
      }[];
    };
    expect(saved.revision).toBe(1);
    expect(saved.records.find((r) => r.pageId === f.page.id)).toMatchObject({
      title: "record title",
      values: { status: "new" },
    });
    expect(() => f.store.handle(req)).toThrow("競合");
    expect(
      requestSchema.safeParse({
        type: "database:settings",
        databasePageId: f.db.id,
        revision: 1,
        settings: { ...settings, rows: [] },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        type: "database:settings",
        databasePageId: f.db.id,
        revision: 1,
        settings: { ...settings, future: true },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        type: "database:settings",
        databasePageId: f.db.id,
        revision: 1,
        settings: {
          ...settings,
          views: [
            {
              ...settings.views[0],
              filter: { ...settings.views[0].filter, future: true },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(f.records.projection(f.page.id)).toMatchObject({
      title: "record title",
      values: { status: "new" },
    });
  } finally {
    f.dispose();
  }
});

it("loads record projections and finds record body and property values without relying on legacy rows", () => {
  const f = fixture();
  try {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "unique body phrase" }],
        },
      ],
    };
    f.store.updateRecordPage(f.page.id, f.db.id, 0, { doc });
    f.records.patch(f.page.id, f.db.id, 1, {
      values: { status: "unique property phrase" },
    });
    const snapshot = f.store.load();
    expect(snapshot.recordDatabaseIds).toContain(f.db.id);
    expect(snapshot.records?.find((r) => r.pageId === f.page.id)).toMatchObject(
      { databasePageId: f.db.id, values: { status: "unique property phrase" } },
    );
    expect(
      (
        f.store.handle({ type: "search", query: "unique body phrase" }) as {
          id: string;
        }[]
      ).map((p) => p.id),
    ).toContain(f.page.id);
    expect(
      (
        f.store.handle({ type: "search", query: "unique property phrase" }) as {
          id: string;
        }[]
      ).map((p) => p.id),
    ).toContain(f.page.id);
    expect(
      f.store.handle({ type: "record:get", pageId: f.page.id }),
    ).toMatchObject({ pageId: f.page.id });
    expect(
      f.store.handle({ type: "database:load", databasePageId: f.db.id }),
    ).toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ pageId: f.page.id }),
      ]),
    });
  } finally {
    f.dispose();
  }
});
