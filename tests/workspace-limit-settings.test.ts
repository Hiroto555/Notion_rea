import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { GrowthLimits } from "../src/main/workspace-growth";
import { WorkspaceLimitSettings } from "../src/persistence/workspace-limit-settings";

const KEY = "folio.workspace.growthLimits";

type Fixture = {
  root: string;
  path: string;
  db: DatabaseSync;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "folio-limit-settings-"));
  const path = join(root, "workspace.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  return { root, path, db };
}

function close(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    // Already closed by the test.
  }
}

function dispose(f: Fixture): void {
  close(f.db);
  rmSync(f.root, { recursive: true, force: true });
}

function storedValue(db: DatabaseSync): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(KEY) as
    { value?: string } | undefined;
  return row?.value;
}

function settingsCount(db: DatabaseSync): number {
  return (
    db.prepare("SELECT COUNT(*) AS count FROM settings").get() as {
      count: number;
    }
  ).count;
}

function totalChanges(db: DatabaseSync): number {
  return (
    db.prepare("SELECT total_changes() AS count").get() as { count: number }
  ).count;
}

it("reads absence as null plus the operator ceiling without writing", () => {
  const f = fixture();
  try {
    const settings = new WorkspaceLimitSettings(f.db, {
      maxAssetBytes: 10,
      maxBackupBytes: 5,
    });
    expect(settings.read()).toEqual({
      revision: null,
      configured: {},
      effective: { maxAssetBytes: 10, maxBackupBytes: 5 },
    });
    expect(settings.apply(null, {})).toEqual({
      revision: null,
      configured: {},
      effective: { maxAssetBytes: 10, maxBackupBytes: 5 },
    });
    expect(storedValue(f.db)).toBeUndefined();
    expect(settingsCount(f.db)).toBe(0);
    expect(totalChanges(f.db)).toBe(0);
  } finally {
    dispose(f);
  }
});

it("persists a versioned UUID revision and survives a real reopen", () => {
  const f = fixture();
  try {
    const first = new WorkspaceLimitSettings(f.db, {});
    const written = first.apply(null, { maxAssetBytes: 20 });
    expect(written.revision).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const raw = storedValue(f.db);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as {
      version: number;
      revision: string;
      limits: GrowthLimits;
    };
    expect(parsed).toEqual({
      version: 1,
      revision: written.revision,
      limits: { maxAssetBytes: 20 },
    });

    const beforeChanges = totalChanges(f.db);
    expect(first.apply(written.revision, { maxAssetBytes: 20 })).toEqual(
      written,
    );
    expect(totalChanges(f.db)).toBe(beforeChanges);
    expect(storedValue(f.db)).toBe(raw);

    close(f.db);
    const reopenedDb = new DatabaseSync(f.path);
    try {
      const reopened = new WorkspaceLimitSettings(reopenedDb, {});
      expect(reopened.read()).toEqual(written);
    } finally {
      close(reopenedDb);
    }
  } finally {
    close(f.db);
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("raises and removes user limits while keeping a revision chain", () => {
  const f = fixture();
  try {
    const settings = new WorkspaceLimitSettings(f.db, {
      maxAssetBytes: 100,
    });
    const first = settings.apply(null, { maxAssetBytes: 20 });
    const raised = settings.apply(first.revision, { maxAssetBytes: 40 });
    expect(raised.revision).not.toBe(first.revision);
    expect(raised.configured).toEqual({ maxAssetBytes: 40 });
    expect(raised.effective).toEqual({ maxAssetBytes: 40 });

    const removed = settings.apply(raised.revision, {});
    expect(removed.revision).not.toBe(raised.revision);
    expect(removed.configured).toEqual({});
    expect(removed.effective).toEqual({ maxAssetBytes: 100 });
    expect(storedValue(f.db)).toBeDefined();
    expect(JSON.parse(storedValue(f.db)!).limits).toEqual({});

    const again = settings.apply(removed.revision, {});
    expect(again).toEqual(removed);
    expect(settingsCount(f.db)).toBe(1);
  } finally {
    dispose(f);
  }
});

it("applies the operator ceiling per key with a minimum", () => {
  const f = fixture();
  try {
    const settings = new WorkspaceLimitSettings(f.db, {
      maxDatabaseBytes: 25,
      maxAssetBytes: 50,
      maxBackupBytes: 0,
    });
    const state = settings.apply(null, {
      maxDatabaseBytes: 10,
      maxAssetBytes: 80,
      maxBackupBytes: 30,
    });
    expect(state.configured).toEqual({
      maxDatabaseBytes: 10,
      maxAssetBytes: 80,
      maxBackupBytes: 30,
    });
    expect(state.effective).toEqual({
      maxDatabaseBytes: 10,
      maxAssetBytes: 50,
      maxBackupBytes: 0,
    });

    close(f.db);
    const reopenedDb = new DatabaseSync(f.path);
    try {
      const reopened = new WorkspaceLimitSettings(reopenedDb, {
        maxDatabaseBytes: 5,
        maxAssetBytes: 500,
      });
      expect(reopened.read()).toEqual({
        revision: state.revision,
        configured: {
          maxDatabaseBytes: 10,
          maxAssetBytes: 80,
          maxBackupBytes: 30,
        },
        effective: {
          maxDatabaseBytes: 5,
          maxAssetBytes: 80,
          maxBackupBytes: 30,
        },
      });
    } finally {
      close(reopenedDb);
    }
  } finally {
    close(f.db);
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("rejects stale instances for both insert and update CAS", () => {
  const f = fixture();
  const secondDb = new DatabaseSync(f.path);
  try {
    const first = new WorkspaceLimitSettings(f.db, {});
    const second = new WorkspaceLimitSettings(secondDb, {});
    expect(first.read().revision).toBeNull();
    expect(second.read().revision).toBeNull();

    const inserted = first.apply(null, { maxAssetBytes: 10 });
    expect(() => second.apply(null, { maxAssetBytes: 20 })).toThrow(
      /workspace-limit-settings-stale/,
    );
    expect(second.read().revision).toBe(inserted.revision);
    expect(second.read().configured).toEqual({ maxAssetBytes: 10 });
    expect(settingsCount(f.db)).toBe(1);

    const raised = first.apply(inserted.revision, { maxAssetBytes: 30 });
    expect(() =>
      second.apply(inserted.revision, { maxAssetBytes: 40 }),
    ).toThrow(/workspace-limit-settings-stale/);
    expect(second.read().revision).toBe(raised.revision);
    expect(second.read().configured).toEqual({ maxAssetBytes: 30 });

    // Even an unchanged payload must not bypass a stale expectation.
    expect(() =>
      second.apply(inserted.revision, { maxAssetBytes: 30 }),
    ).toThrow(/workspace-limit-settings-stale/);
    expect(settingsCount(f.db)).toBe(1);
  } finally {
    close(secondDb);
    dispose(f);
  }
});

it("rejects invalid limits and corrupt stored JSON without overwriting", () => {
  const f = fixture();
  try {
    const invalidOperators: unknown[] = [
      null,
      { maxAssetBytes: -1 },
      { maxAssetBytes: 1.5 },
      { maxAssetBytes: Number.NaN },
      { maxAssetBytes: "1" },
      { maxEverything: 1 },
    ];
    for (const operator of invalidOperators) {
      expect(
        () =>
          new WorkspaceLimitSettings(f.db, operator as unknown as GrowthLimits),
      ).toThrow(/workspace-limit-settings-invalid/);
    }

    const settings = new WorkspaceLimitSettings(f.db, {});
    const invalidConfigured: unknown[] = [
      null,
      { maxAssetBytes: -1 },
      { maxAssetBytes: 1.5 },
      { maxAssetBytes: Number.POSITIVE_INFINITY },
      { maxAssetBytes: "1" },
      { maxEverything: 1 },
    ];
    for (const configured of invalidConfigured) {
      expect(() =>
        settings.apply(null, configured as unknown as GrowthLimits),
      ).toThrow(/workspace-limit-settings-invalid/);
    }
    expect(storedValue(f.db)).toBeUndefined();

    const corruptValues = [
      "not-json",
      JSON.stringify({ version: 2, revision: "r", limits: {} }),
      JSON.stringify({ version: 1, revision: "", limits: {} }),
      JSON.stringify({
        version: 1,
        revision: "r",
        limits: { maxAssetBytes: -1 },
      }),
      JSON.stringify({
        version: 1,
        revision: "r",
        limits: { maxAssetBytes: 1, extra: 2 },
      }),
    ];
    f.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .run(KEY, corruptValues[0]);
    for (const raw of corruptValues) {
      f.db.prepare("UPDATE settings SET value=? WHERE key=?").run(raw, KEY);
      expect(() => settings.read()).toThrow(/workspace-limit-settings-corrupt/);
      expect(() => settings.apply(null, { maxAssetBytes: 1 })).toThrow(
        /workspace-limit-settings-corrupt/,
      );
      expect(storedValue(f.db)).toBe(raw);
    }
  } finally {
    dispose(f);
  }
});

it("preserves the stored policy when an insert or update fails", () => {
  const f = fixture();
  try {
    f.db.exec(
      "CREATE TRIGGER reject_growth_insert BEFORE INSERT ON settings WHEN NEW.key='folio.workspace.growthLimits' BEGIN SELECT RAISE(ABORT,'blocked'); END",
    );
    const settings = new WorkspaceLimitSettings(f.db, {});
    expect(() => settings.apply(null, { maxAssetBytes: 10 })).toThrow(
      /workspace-limit-settings-write-failed/,
    );
    expect(storedValue(f.db)).toBeUndefined();
    f.db.exec("DROP TRIGGER reject_growth_insert");

    const first = settings.apply(null, { maxAssetBytes: 10 });
    const raw = storedValue(f.db);
    f.db.exec(
      "CREATE TRIGGER reject_growth_update BEFORE UPDATE ON settings WHEN OLD.key='folio.workspace.growthLimits' BEGIN SELECT RAISE(ABORT,'blocked'); END",
    );
    expect(() => settings.apply(first.revision, { maxAssetBytes: 99 })).toThrow(
      /workspace-limit-settings-write-failed/,
    );
    expect(storedValue(f.db)).toBe(raw);
    expect(settings.read()).toEqual(first);
    f.db.exec("DROP TRIGGER reject_growth_update");

    expect(
      settings.apply(first.revision, { maxAssetBytes: 99 }).configured,
    ).toEqual({ maxAssetBytes: 99 });
  } finally {
    dispose(f);
  }
});

it("leaves pages, receipts and unrelated settings untouched", () => {
  const f = fixture();
  try {
    f.db.exec(
      "CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL,body TEXT NOT NULL);" +
        "CREATE TABLE save_receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL);",
    );
    f.db
      .prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)")
      .run("page-1", "{}", "body");
    f.db
      .prepare(
        "INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)",
      )
      .run("op-1", "f".repeat(64), "{}");
    f.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .run("theme", "dark");

    const settings = new WorkspaceLimitSettings(f.db, {});
    settings.apply(null, { maxDatabaseBytes: 1024 });

    expect(
      (
        f.db.prepare("SELECT body FROM pages WHERE id='page-1'").get() as {
          body: string;
        }
      ).body,
    ).toBe("body");
    expect(
      f.db
        .prepare(
          "SELECT result_json FROM save_receipts WHERE operation_id='op-1'",
        )
        .get(),
    ).toEqual({ result_json: "{}" });
    expect(
      f.db.prepare("SELECT value FROM settings WHERE key='theme'").get(),
    ).toEqual({ value: "dark" });
    expect(settingsCount(f.db)).toBe(2);
  } finally {
    dispose(f);
  }
});
