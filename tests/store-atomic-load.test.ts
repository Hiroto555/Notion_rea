import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";

function fixture() {
  const root = mkdtempSync(resolve("output/atomic-load-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "owner before");
  const record = store.create(null, "page", "record before");
  const repo = new RecordRepository(store);
  store.transaction(() => {
    repo.createSchema();
    repo.attachForMigration(record.id, owner.id, 0, { state: "before" });
  });
  store.handle({ type: "setting", key: "theme", value: "light" });
  return {
    root,
    store,
    owner,
    record,
    dispose() {
      vi.restoreAllMocks();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("rejects unavailable SQLite state APIs without assuming a closed connection or starting a transaction", () => {
  const f = fixture(),
    db = f.store.db;
  try {
    const transaction = vi
      .spyOn(f.store as any, "readTransactionFlag")
      .mockReturnValue(undefined);
    const exec = vi.spyOn(db, "exec");
    expect(() => f.store.load()).toThrow("transaction state is unavailable");
    expect(exec).not.toHaveBeenCalled();
    transaction.mockRestore();
    exec.mockRestore();
    const open = vi
      .spyOn(f.store as any, "readConnectionFlag")
      .mockReturnValue(undefined);
    const close = vi.spyOn(db, "close");
    expect(() => f.store.close()).toThrow("connection state is unavailable");
    expect(close).not.toHaveBeenCalled();
    open.mockRestore();
    close.mockRestore();
    expect(f.store.load().pages.some((page) => page.id === f.record.id)).toBe(
      true,
    );
  } finally {
    f.dispose();
  }
});

it("reads membership, Page, owner IDs and settings from one WAL snapshot despite an intervening external commit", () => {
  const f = fixture();
  const writer = new DatabaseSync(f.store.path);
  try {
    writer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const owner = {
      ...f.owner,
      id: "synthetic-external-owner",
      title: "owner after",
      position: 10,
    };
    const updated = { ...f.record, title: "record after", revision: 1 };
    const originalGet = f.store.get.bind(f.store);
    let injected = false;
    vi.spyOn(f.store, "get").mockImplementation((id) => {
      // projection() has already read the membership row before get().
      if (id === f.record.id && !injected) {
        injected = true;
        writer.exec("BEGIN IMMEDIATE");
        try {
          writer
            .prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)")
            .run(owner.id, JSON.stringify(owner), owner.title);
          writer
            .prepare("INSERT INTO record_databases(database_page_id) VALUES(?)")
            .run(owner.id);
          writer
            .prepare("UPDATE pages SET data=?,body=? WHERE id=?")
            .run(JSON.stringify(updated), updated.title, updated.id);
          writer
            .prepare(
              "UPDATE record_memberships SET database_page_id=?, values_json=? WHERE page_id=?",
            )
            .run(owner.id, JSON.stringify({ state: "after" }), updated.id);
          writer
            .prepare("UPDATE settings SET value=? WHERE key='theme'")
            .run("dark");
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      return originalGet(id);
    });
    const before = f.store.load();
    expect(injected).toBe(true);
    expect(
      before.records?.find((row) => row.pageId === f.record.id),
    ).toMatchObject({
      databasePageId: f.owner.id,
      title: "record before",
      revision: 0,
      values: { state: "before" },
    });
    expect(before.pages.find((item) => item.id === f.record.id)).toMatchObject({
      title: "record before",
      revision: 0,
    });
    expect(before.pages.some((item) => item.id === owner.id)).toBe(false);
    expect(before.recordDatabaseIds).toContain(f.owner.id);
    expect(before.recordDatabaseIds).not.toContain(owner.id);
    expect(before.settings.theme).toBe("light");
    expect(f.store.db.isTransaction).toBe(false);
    const after = f.store.load();
    expect(
      after.records?.find((row) => row.pageId === f.record.id),
    ).toMatchObject({
      databasePageId: owner.id,
      title: "record after",
      revision: 1,
      values: { state: "after" },
    });
    expect(after.pages.find((item) => item.id === f.record.id)).toMatchObject({
      title: "record after",
      revision: 1,
    });
    expect(after.recordDatabaseIds).toContain(owner.id);
    expect(after.pages.some((item) => item.id === owner.id)).toBe(true);
    expect(after.settings.theme).toBe("dark");
  } finally {
    writer.close();
    f.dispose();
  }
});

it("rolls back its own read transaction after failure and remains usable", () => {
  const f = fixture();
  try {
    const failure = vi.spyOn(f.store, "pages").mockImplementationOnce(() => {
      throw new Error("injected page read failure");
    });
    expect(() => f.store.load()).toThrow("injected page read failure");
    expect(f.store.db.isTransaction).toBe(false);
    failure.mockRestore();
    f.store.handle({ type: "setting", key: "theme", value: "dark" });
    expect(f.store.load().settings.theme).toBe("dark");
    expect(f.store.db.isTransaction).toBe(false);
  } finally {
    f.dispose();
  }
});

it("neither commits nor rolls back a caller-owned transaction on success or failure", () => {
  const f = fixture();
  try {
    f.store.db.exec("BEGIN IMMEDIATE");
    f.store.db
      .prepare("UPDATE settings SET value=? WHERE key='theme'")
      .run("pending");
    expect(f.store.load().settings.theme).toBe("pending");
    expect(f.store.db.isTransaction).toBe(true);
    const failure = vi.spyOn(f.store, "pages").mockImplementationOnce(() => {
      throw new Error("caller read failure");
    });
    expect(() => f.store.load()).toThrow("caller read failure");
    expect(f.store.db.isTransaction).toBe(true);
    expect(
      f.store.db.prepare("SELECT value FROM settings WHERE key='theme'").get()
        ?.value,
    ).toBe("pending");
    failure.mockRestore();
    f.store.db.exec("ROLLBACK");
    expect(f.store.db.isTransaction).toBe(false);
    expect(f.store.load().settings.theme).toBe("light");
  } finally {
    if (f.store.db.isTransaction) f.store.db.exec("ROLLBACK");
    f.dispose();
  }
});

it("keeps legacy classification and Page reads in one snapshot when record tables appear concurrently", () => {
  const root = mkdtempSync(resolve("output/atomic-load-legacy-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "owner"),
    record = store.create(null, "page", "record");
  const writer = new DatabaseSync(store.path);
  try {
    writer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const originalPages = store.pages.bind(store);
    let injected = false;
    vi.spyOn(store, "pages").mockImplementation(() => {
      if (!injected) {
        injected = true;
        writer.exec("BEGIN IMMEDIATE");
        try {
          writer.exec(
            "CREATE TABLE record_databases(database_page_id TEXT PRIMARY KEY REFERENCES pages(id)); CREATE TABLE record_memberships(page_id TEXT PRIMARY KEY REFERENCES pages(id),database_page_id TEXT NOT NULL REFERENCES pages(id),position INTEGER NOT NULL,values_json TEXT NOT NULL);",
          );
          writer
            .prepare("INSERT INTO record_databases VALUES(?)")
            .run(owner.id);
          writer
            .prepare("INSERT INTO record_memberships VALUES(?,?,?,?)")
            .run(record.id, owner.id, 0, "{}");
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      return originalPages();
    });
    const before = store.load();
    expect(injected).toBe(true);
    expect(before.records).toBeUndefined();
    expect(before.recordDatabaseIds).toBeUndefined();
    expect(before.pages.find((p) => p.id === record.id)?.title).toBe("record");
    const after = store.load();
    expect(
      after.records?.find((p) => p.pageId === record.id)?.databasePageId,
    ).toBe(owner.id);
    expect(after.recordDatabaseIds).toContain(owner.id);
  } finally {
    vi.restoreAllMocks();
    writer.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function expectDisabled(store: Store, pageId: string) {
  expect(() => store.db).toThrow(/connection is unusable/);
  expect(() => store.load()).toThrow(/connection is unusable/);
  expect(() => store.get(pageId)).toThrow(/connection is unusable/);
  expect(() =>
    store.handle({ type: "setting", key: "theme", value: "changed" }),
  ).toThrow(/connection is unusable/);
}

it.each(["before", "after"])(
  "disables the connection when BEGIN fails %s execution",
  (where) => {
    const f = fixture(),
      db = f.store.db,
      exec = db.exec.bind(db);
    try {
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "BEGIN") {
          if (where === "after") exec(sql);
          throw new Error("injected BEGIN failure");
        }
        return exec(sql);
      });
      expect(() => f.store.load()).toThrow(/BEGIN failed/);
      expectDisabled(f.store, f.record.id);
      expect(() => db.prepare("SELECT 1")).toThrow(); // Existing handle was closed.
      const fresh = new Store(f.store.path);
      try {
        expect(fresh.get(f.record.id).title).toBe("record before");
        expect(fresh.load().settings.theme).toBe("light");
      } finally {
        fresh.close();
      }
    } finally {
      f.dispose();
    }
  },
);

it.each(["before", "after"])(
  "disables the connection when COMMIT fails %s execution",
  (where) => {
    const f = fixture(),
      db = f.store.db,
      exec = db.exec.bind(db);
    try {
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "COMMIT") {
          if (where === "after") exec(sql);
          throw new Error("injected COMMIT failure");
        }
        return exec(sql);
      });
      expect(() => f.store.load()).toThrow(/COMMIT failed/);
      expectDisabled(f.store, f.record.id);
      expect(() => db.prepare("SELECT 1")).toThrow();
      const fresh = new Store(f.store.path);
      try {
        expect(fresh.get(f.record.id).title).toBe("record before");
        expect(fresh.load().settings.theme).toBe("light");
      } finally {
        fresh.close();
      }
    } finally {
      f.dispose();
    }
  },
);

it.each(["before", "after"])(
  "disables the connection when a failed read is followed by a ROLLBACK error %s execution",
  (where) => {
    const f = fixture(),
      db = f.store.db,
      exec = db.exec.bind(db);
    try {
      vi.spyOn(f.store, "pages").mockImplementation(() => {
        throw new Error("injected read failure");
      });
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        if (sql === "ROLLBACK") {
          if (where === "after") exec(sql);
          throw new Error("injected ROLLBACK failure");
        }
        return exec(sql);
      });
      let failure: unknown;
      try {
        f.store.load();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(
        (failure as AggregateError).errors.map((error: Error) => error.message),
      ).toEqual(["injected read failure", "injected ROLLBACK failure"]);
      expectDisabled(f.store, f.record.id);
      expect(() => db.prepare("SELECT 1")).toThrow();
      const fresh = new Store(f.store.path);
      try {
        expect(fresh.get(f.record.id).title).toBe("record before");
        expect(fresh.load().settings.theme).toBe("light");
      } finally {
        fresh.close();
      }
    } finally {
      f.dispose();
    }
  },
);

it("keeps Store disabled even if underlying close fails, then permits an explicit close retry", () => {
  const f = fixture(),
    db = f.store.db,
    exec = db.exec.bind(db);
  try {
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN") throw new Error("injected BEGIN failure");
      return exec(sql);
    });
    const close = vi.spyOn(db, "close").mockImplementationOnce(() => {
      throw new Error("injected close failure");
    });
    let failure: unknown;
    try {
      f.store.load();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual(["injected BEGIN failure", "injected close failure"]);
    expectDisabled(f.store, f.record.id);
    close.mockRestore();
    f.store.close();
    expect(() => db.prepare("SELECT 1")).toThrow();
  } finally {
    f.dispose();
  }
});

it("retains a post-close error, disables access and does not close the already-closed connection twice", () => {
  const f = fixture(),
    db = f.store.db,
    exec = db.exec.bind(db),
    actualClose = db.close.bind(db);
  try {
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN") throw new Error("injected BEGIN failure");
      return exec(sql);
    });
    const close = vi.spyOn(db, "close").mockImplementation(() => {
      actualClose();
      throw new Error("injected error after close");
    });
    let failure: unknown;
    try {
      f.store.load();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual(["injected BEGIN failure", "injected error after close"]);
    expect(db.isOpen).toBe(false);
    expectDisabled(f.store, f.record.id);
    expect(() => f.store.close()).not.toThrow();
    expect(() => f.store.close()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    const fresh = new Store(f.store.path);
    try {
      expect(fresh.get(f.record.id).title).toBe("record before");
      expect(fresh.load().settings.theme).toBe("light");
    } finally {
      fresh.close();
    }
  } finally {
    f.dispose();
  }
});

it("preserves close and state-probe errors while disabling a connection with unknown close outcome", () => {
  const f = fixture(),
    db = f.store.db,
    exec = db.exec.bind(db),
    actualClose = db.close.bind(db);
  try {
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN") throw new Error("injected BEGIN failure");
      return exec(sql);
    });
    const close = vi.spyOn(db, "close").mockImplementation(() => {
      actualClose();
      throw new Error("injected close result failure");
    });
    const probe = vi
      .spyOn(f.store as any, "readConnectionFlag")
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        throw new Error("injected open-state failure");
      });
    let failure: unknown;
    try {
      f.store.load();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const failures = (failure as AggregateError).errors;
    expect(failures[0].message).toBe("injected BEGIN failure");
    expect(failures[1]).toBeInstanceOf(AggregateError);
    expect(failures[1].errors.map((error: Error) => error.message)).toEqual([
      "injected close result failure",
      "injected open-state failure",
    ]);
    expectDisabled(f.store, f.record.id);
    probe.mockRestore();
    close.mockRestore();
    expect(db.isOpen).toBe(false);
    expect(() => f.store.close()).not.toThrow();
  } finally {
    f.dispose();
  }
});

it("does not run transaction control or disable a caller-owned transaction on read failure", () => {
  const f = fixture(),
    db = f.store.db;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE settings SET value=? WHERE key='theme'").run(
      "caller pending",
    );
    const exec = vi.spyOn(db, "exec");
    vi.spyOn(f.store, "pages").mockImplementationOnce(() => {
      throw new Error("caller read failure");
    });
    expect(() => f.store.load()).toThrow("caller read failure");
    expect(exec).not.toHaveBeenCalled();
    expect(f.store.db.isTransaction).toBe(true);
    expect(
      f.store.db.prepare("SELECT value FROM settings WHERE key='theme'").get()
        ?.value,
    ).toBe("caller pending");
    exec.mockRestore();
    db.exec("ROLLBACK");
    expect(f.store.load().settings.theme).toBe("light");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    f.dispose();
  }
});
