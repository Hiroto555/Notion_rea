import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, storeInitializationRetainsNativeLease } from "../src/persistence/store";
import { publishSchemaSnapshot } from "../src/persistence/schema-startup";
import { createMigrationSnapshot } from "../src/persistence/migration-snapshot";
import { attachFile } from "../src/persistence/assets";
import {
  previewLegacyMigration,
  commitLegacyMigration,
  resolveLegacyMigration,
} from "../src/persistence/legacy-migration-operation";
import { prepareLegacyMigration } from "../src/shared/legacy-migration-operation";
import { startupRetainsNativeLease } from "../src/persistence/startup-connection-owner";
import { openWorkspaceAtStartup } from "../src/main/workspace-startup";
import {
  withPrivatePersistence,
  type NativePrivateFile,
  type NativePrivateFilesystemPort,
  type NativePrivateIdentity,
  type NativePrivateSqliteLease,
} from "../src/platform/private-persistence";

const roots: string[] = [];
const stores: Store[] = [];
const connections: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) try { store.close(); } catch {}
  for (const connection of connections.splice(0)) try { connection.close(); } catch {}
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface RecordedLease extends NativePrivateSqliteLease {
  path: string;
  closed: boolean;
  closeCount: number;
}

/** Disposable POSIX contract adapter ONLY. NOT Windows acceptance, NTFS,
 * DACL, handle-sharing or power-loss evidence. Never used by production.
 * Records per-path lease acquire/release order and SQLite close ordinals so
 * tests can prove a hidden live reader keeps its own lease. */
function adapter() {
  const events: string[] = [];
  const leases: RecordedLease[] = [];
  /** Connections whose real close the current test's close spy observed. A
   * lease release asserts the most recently observed close is truly closed. */
  const observed: DatabaseSync[] = [];
  const identity = (path: string): NativePrivateIdentity => {
    const st = fs.lstatSync(path, { bigint: true });
    return { path, fileId: st.ino.toString(16).padStart(32, "0"), volumeId: st.dev.toString(16).padStart(16, "0") };
  };
  const inspect = (path: string, max: number): NativePrivateFile => {
    const st = fs.lstatSync(path);
    if (st.size > max) throw new Error("capacity");
    return { ...identity(path), bytes: st.size, sha256: createHash("sha256").update(fs.readFileSync(path)).digest("hex") };
  };
  const receipt = (path: string, max: number) => ({
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const,
    scope: "PROCESS_CRASH" as const,
    identity: inspect(path, max),
  });
  const unused = (): never => { throw new Error("unexpected filesystem operation"); };
  const port: NativePrivateFilesystemPort = {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory: identity,
    inspectFileIdentity: identity,
    inspectFile: inspect,
    read: unused,
    createDirectory(path) { fs.mkdirSync(path, { mode: 0o700 }); return identity(path); },
    writeNew(path, bytes, max) {
      if (bytes.length > max) throw new Error("capacity");
      fs.writeFileSync(path, bytes, { flag: "wx" });
      return receipt(path, max);
    },
    copyNew(source, destination, expected, max) {
      expect(inspect(source, max)).toEqual(expected);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      return receipt(destination, max);
    },
    renameNew: unused,
    unlinkExact: unused,
    proveSync(path, expected) { events.push("prove"); return receipt(path, expected.bytes); },
    snapshotSqlite(db, path) {
      events.push("snapshot");
      fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      db.prepare("VACUUM INTO ?").run(path);
      return receipt(path, 256 * 1024 * 1024);
    },
    acquireSqliteLease(path, expected) {
      expect(identity(path)).toEqual({ path: expected.path, fileId: expected.fileId, volumeId: expected.volumeId });
      events.push("lease-acquire");
      const lease: RecordedLease = {
        path, closed: false, closeCount: 0,
        assertHeld() { if (lease.closed) throw new Error("lease lost"); },
        close() {
          if (lease.closed) throw new Error("lease closed");
          lease.closeCount++;
          events.push(`lease-close:${path}`);
          if (observed.length) expect(observed[observed.length - 1]!.isOpen).toBe(false);
          lease.closed = true;
        },
      };
      leases.push(lease);
      return lease;
    },
  };
  return {
    port, events, leases, observed,
    /** Simulate a native backend without a raw-reader lease facility. */
    dropLease() { delete port.acquireSqliteLease; },
  };
}

/** "before-closure" makes the target close throw before SQLite closes (the
 * reader stays live); "after-closure" closes for real and then throws (the
 * close outcome is known). Only the ordinal `failAt` close is faulted. */
type CloseMode = "before-closure" | "after-closure";
function closeFault(f: { events: string[]; observed: DatabaseSync[] }, mode: CloseMode, failAt: number, sentinel: Error) {
  const original = DatabaseSync.prototype.close;
  const state = { calls: 0, target: undefined as DatabaseSync | undefined };
  const spy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
    const ordinal = ++state.calls;
    f.events.push(`db-close:${ordinal}`);
    if (ordinal !== failAt) {
      const result = original.call(this);
      f.observed.push(this);
      return result;
    }
    state.target = this;
    if (mode === "after-closure") {
      original.call(this);
      f.observed.push(this);
    }
    throw sentinel;
  });
  return { spy, state };
}

/** Pass-through close spy for positive paths: every real close is recorded so
 * the adapter's lease.close can prove the released reader was already closed. */
function observeCloses(f: { events: string[]; observed: DatabaseSync[] }) {
  const original = DatabaseSync.prototype.close;
  return vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
    const result = original.call(this);
    f.observed.push(this);
    f.events.push(`db-close:${f.observed.length}`);
    return result;
  });
}

/** Thrown values may legitimately be undefined; a flag is required. */
function capture<T>(fn: () => T) {
  let caught = false, error: unknown, value: T | undefined;
  try { value = fn(); } catch (e) { caught = true; error = e; }
  return { caught, error, value };
}

const SCHEMA_TABLES =
  "CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL,body TEXT NOT NULL);" +
  "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);" +
  "CREATE TABLE versions(id INTEGER PRIMARY KEY,pageId TEXT,createdAt INTEGER,title TEXT,doc TEXT,database TEXT);" +
  "CREATE TABLE save_receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL);";

function schemaFiles(version: 1 | 2 = 1) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-reader-ownership-")));
  roots.push(root);
  const dir = join(root, "workspace"); fs.mkdirSync(dir);
  const path = join(dir, "workspace.sqlite");
  const setup = new DatabaseSync(path);
  setup.exec(SCHEMA_TABLES + `PRAGMA user_version=${version};`);
  setup.exec("INSERT INTO pages VALUES('p1','{}','payload')");
  setup.close();
  const canonical = `${path}.pre-v${version + 1}.sqlite`;
  fs.writeFileSync(canonical, "retain original");
  return { root, dir, path, canonical, ...adapter() };
}

function schemaFixture(version: 1 | 2 = 1) {
  const f = schemaFiles(version);
  const connection = new DatabaseSync(f.path);
  connections.push(connection);
  return { ...f, connection };
}

function storeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-reader-ownership-store-")));
  roots.push(root);
  const workspace = join(root, "workspace"), assetsPath = join(workspace, "assets");
  fs.mkdirSync(assetsPath, { recursive: true });
  const store = new Store(join(workspace, "workspace.sqlite")); stores.push(store);
  const legacy = store.create(null, "database", "Selected legacy");
  const current = store.update(legacy.id, legacy.revision, {
    database: {
      ...legacy.database!,
      rows: [{ id: "row-1", title: "Kept row", values: { status: "未着手" } }],
    },
  });
  const input = join(root, "input.txt");
  fs.writeFileSync(input, "reader-ownership asset bytes");
  const asset = attachFile(store.db, assetsPath, input);
  const raw = store.db.prepare("SELECT data FROM pages WHERE id=?").get(current.id)?.data;
  const snapshotRoot = join(root, "snapshots");
  return { root, workspace, assetsPath, snapshotRoot, store, legacy: current, asset, raw, ...adapter() };
}

/** The four production readers routed through withNativeSqliteReader. */
type Site = "schema-staged" | "schema-published" | "migration-snapshot" | "legacy-fingerprint";
const SITES: Site[] = ["schema-staged", "schema-published", "migration-snapshot", "legacy-fingerprint"];

type SchemaF = ReturnType<typeof schemaFixture>;
type StoreF = ReturnType<typeof storeFixture>;
type Operation = ReturnType<typeof prepareLegacyMigration>;

interface Harness {
  site: Site;
  sentinel: Error;
  state: { calls: number; target: DatabaseSync | undefined };
  invoke: () => unknown;
  leasePath: () => string;
  schema?: SchemaF;
  store?: StoreF;
  target?: string;
  operation?: Operation;
}

function harness(site: Site, mode: CloseMode): Harness {
  const sentinel = new Error(`${site} close sentinel`);
  if (site === "schema-staged" || site === "schema-published") {
    const f = schemaFixture();
    const { state } = closeFault(f, mode, site === "schema-staged" ? 1 : 2, sentinel);
    return {
      site, sentinel, state, schema: f,
      invoke: () => publishSchemaSnapshot(f.connection, f.path, 1, { nativePrivateFilesystem: f.port }),
      leasePath: () => {
        const names = fs.readdirSync(f.dir);
        if (site === "schema-staged") return join(f.dir, names.find((n) => n.includes(".staging-"))!);
        return join(f.dir, names.find((n) => n.startsWith("workspace.sqlite.pre-v2.sqlite.") && !n.includes("staging"))!);
      },
    };
  }
  const f = storeFixture();
  const { state } = closeFault(f, mode, site === "migration-snapshot" ? 1 : 2, sentinel);
  if (site === "migration-snapshot") {
    const target = join(f.root, "migration-copy");
    return {
      site, sentinel, state, store: f, target,
      invoke: () => createMigrationSnapshot(f.store.db, f.assetsPath, target, { nativePrivateFilesystem: f.port }),
      leasePath: () => join(target, "workspace.sqlite"),
    };
  }
  const operation = prepareLegacyMigration(previewLegacyMigration(f.store, f.legacy.id));
  const environment = { assetsPath: f.assetsPath, snapshotRoot: f.snapshotRoot, nativePrivateFilesystem: f.port };
  return {
    site, sentinel, state, store: f, operation,
    invoke: () => commitLegacyMigration(f.store, operation, environment),
    leasePath: () => join(f.snapshotRoot, fs.readdirSync(f.snapshotRoot)[0], "workspace.sqlite"),
  };
}

function leases(h: Harness): RecordedLease[] {
  return (h.schema ?? h.store)!.leases;
}
function events(h: Harness): string[] {
  return (h.schema ?? h.store)!.events;
}
function targetLease(h: Harness): RecordedLease {
  // The target reader's lease is the last one acquired for its path; an
  // earlier reader may have leased the same file and been released normally.
  const matches = leases(h).filter((l) => l.path === h.leasePath());
  return matches[matches.length - 1];
}

/** Per-site evidence a retained live reader blocked publication/acknowledgement. */
function expectRetainedArtifacts(h: Harness): void {
  if (h.site === "schema-staged" || h.site === "schema-published") {
    const f = h.schema!;
    expect(fs.existsSync(h.leasePath())).toBe(true); // verified image is kept, not published
    expect(events(h)).not.toContain("prove");
    expect(fs.readFileSync(f.canonical, "utf8")).toBe("retain original");
    expect(f.connection.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
    expect(f.connection.prepare("SELECT body FROM pages WHERE id='p1'").get()?.body).toBe("payload");
    return;
  }
  if (h.site === "migration-snapshot") {
    const f = h.store!;
    expect(fs.existsSync(join(h.target!, "workspace.sqlite"))).toBe(true);
    expect(fs.existsSync(join(h.target!, "assets", f.asset.id))).toBe(true);
    expect(fs.existsSync(join(h.target!, "manifest.json"))).toBe(false);
    expect(fs.existsSync(join(h.target!, ".manifest-pending.json"))).toBe(false);
    expect(fs.existsSync(join(f.assetsPath, f.asset.id))).toBe(true);
    return;
  }
  const f = h.store!;
  const snapshotDir = fs.readdirSync(f.snapshotRoot)[0];
  expect(fs.existsSync(join(f.snapshotRoot, snapshotDir, "manifest.json"))).toBe(true);
  expect(f.store.db.prepare("SELECT 1 FROM save_receipts WHERE operation_id=?").get(h.operation!.operationId)).toBeUndefined();
  expect(resolveLegacyMigration(f.store, h.operation!).status).toBe("unknown");
  expect(f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(f.legacy.id)?.data).toBe(f.raw);
}

describe("native migration readers — POSIX simulation, NOT Windows acceptance (authored, NOT_RUN)", () => {
  it.each(SITES)("retains the exact-path lease of a live %s reader, closing and publishing nothing further", (site) => {
    const h = harness(site, "before-closure");
    const { caught, error } = capture(h.invoke);
    expect(caught).toBe(true);
    expect(startupRetainsNativeLease(error)).toBe(true);
    const branded = error as AggregateError & { retainedConnection?: unknown };
    expect(branded.errors).toContain(h.sentinel);
    expect(branded.retainedConnection).toBe(h.state.target);
    expect(h.state.target?.isOpen).toBe(true);
    const expectedCloses = site === "schema-published" || site === "legacy-fingerprint" ? 2 : 1;
    expect(h.state.calls).toBe(expectedCloses); // exactly one attempt per reader, no retry
    const lease = targetLease(h);
    expect(lease.closed).toBe(false);
    expect(lease.closeCount).toBe(0);
    if (site === "schema-published") {
      // The first reader was proven closed and its lease released exactly once.
      expect(leases(h)[0].closed).toBe(true);
      expect(leases(h)[0].closeCount).toBe(1);
    }
    if (site === "legacy-fingerprint") {
      // The snapshot reader used the same path and was released normally; only
      // that earlier lease may have emitted a close event for this path.
      expect(leases(h)[0].closed).toBe(true);
      expect(leases(h)[0].closeCount).toBe(1);
      expect(events(h).filter((e) => e === `lease-close:${lease.path}`)).toHaveLength(1);
    } else {
      expect(events(h).filter((e) => e === `lease-close:${lease.path}`)).toHaveLength(0);
    }
    expectRetainedArtifacts(h);
    // Spies are restored before the only manual cleanup close; the production
    // path must never attempt a second close of the retained reader.
    vi.restoreAllMocks();
    if (h.state.target?.isOpen) h.state.target.close();
  });

  it.each(SITES)("releases the %s reader lease once after a proven close and preserves the close failure", (site) => {
    const h = harness(site, "after-closure");
    const { caught, error, value } = capture(h.invoke);
    const lease = targetLease(h);
    if (site === "legacy-fingerprint") {
      // The legacy contract converts an ordinary failure into a rejected
      // result carrying the original failure text; nothing is retried.
      expect(caught).toBe(false);
      const result = value as ReturnType<typeof commitLegacyMigration>;
      expect(result.status).toBe("rejected");
      expect(result.message).toContain(h.sentinel.message);
      expect(typeof result.snapshotPath).toBe("string");
      expect(h.state.target?.isOpen).toBe(false);
      expect(lease.closed).toBe(true);
      expect(lease.closeCount).toBe(1);
      expect(h.state.calls).toBe(2);
      const closes = events(h).filter((e) => e.startsWith("lease-close:"));
      expect(closes).toHaveLength(2);
      expect(events(h).lastIndexOf(closes[1])).toBeGreaterThan(events(h).indexOf("db-close:2"));
      expect(h.store!.store.db.prepare("SELECT data FROM pages WHERE id=?").get(h.store!.legacy.id)?.data).toBe(h.store!.raw);
      expect(resolveLegacyMigration(h.store!.store, h.operation!).status).toBe("rejected");
      return;
    }
    expect(caught).toBe(true);
    expect(error).toBe(h.sentinel);
    expect(h.state.target?.isOpen).toBe(false);
    expect(lease.closed).toBe(true);
    expect(lease.closeCount).toBe(1);
    const closes = events(h).filter((e) => e.startsWith("lease-close:"));
    expect(events(h).lastIndexOf(closes[closes.length - 1])).toBeGreaterThan(events(h).lastIndexOf(`db-close:${h.state.calls}`));
    expectRetainedArtifacts(h);
  });

  it.each(["before-closure", "after-closure"] as const)(
    "preserves a thrown-undefined verification fault and the %s close sentinel on the schema staging reader",
    (mode) => {
      const f = schemaFixture();
      const sentinel = new Error("close sentinel");
      const realExec = DatabaseSync.prototype.exec;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
        if (this === f.connection) return realExec.call(this, sql);
        throw undefined; // verification faults are not required to be Errors
      });
      const { state } = closeFault(f, mode, 1, sentinel);
      const { caught, error } = capture(() =>
        publishSchemaSnapshot(f.connection, f.path, 1, { nativePrivateFilesystem: f.port }),
      );
      expect(caught).toBe(true);
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError & { retainedConnection?: unknown };
      expect(aggregate.errors).toContain(undefined);
      expect(aggregate.errors).toContain(sentinel);
      const staged = join(f.dir, fs.readdirSync(f.dir).find((n) => n.includes(".staging-"))!);
      const lease = f.leases.find((l) => l.path === staged)!;
      if (mode === "before-closure") {
        expect(startupRetainsNativeLease(error)).toBe(true);
        expect(aggregate.retainedConnection).toBe(state.target);
        expect(state.target?.isOpen).toBe(true);
        expect(lease.closed).toBe(false);
      } else {
        expect(startupRetainsNativeLease(error)).toBe(false);
        expect(state.target?.isOpen).toBe(false);
        expect(lease.closed).toBe(true);
        expect(lease.closeCount).toBe(1);
      }
      expect(fs.readFileSync(f.canonical, "utf8")).toBe("retain original");
      vi.restoreAllMocks();
      if (state.target?.isOpen) state.target.close();
    },
  );

  it.each([1, 2] as const)(
    "verifies and publishes a native v%s schema snapshot without replacing an existing canonical file",
    (version) => {
      const f = schemaFixture(version);
      observeCloses(f);
      const published = publishSchemaSnapshot(f.connection, f.path, version, { nativePrivateFilesystem: f.port });
      expect(published).not.toBe(f.canonical);
      expect(fs.existsSync(published)).toBe(true);
      expect(fs.readFileSync(f.canonical, "utf8")).toBe("retain original");
      expect(f.events.filter((e) => e === "prove")).toHaveLength(1);
      expect(f.leases).toHaveLength(2);
      expect(f.leases.every((l) => l.closed && l.closeCount === 1)).toBe(true);
      expect(f.observed).toHaveLength(2);
      expect(f.observed.every((db) => db.isOpen === false)).toBe(true);
      const check = new DatabaseSync(published, { readOnly: true });
      connections.push(check);
      try {
        expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
        expect(check.prepare("SELECT body FROM pages WHERE id='p1'").get()?.body).toBe("payload");
        const columns = (check.prepare("PRAGMA table_info(versions)").all() as { name: string }[]).map((c) => c.name);
        expect(columns).toContain("database");
      } finally {
        check.close();
      }
    },
  );

  it("fails closed before opening any reader when the configured port cannot lease one", () => {
    const f = schemaFixture();
    f.dropLease();
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const { caught, error } = capture(() =>
      publishSchemaSnapshot(f.connection, f.path, 1, { nativePrivateFilesystem: f.port }),
    );
    expect(caught).toBe(true);
    expect((error as Error).message).toMatch(/raw-reader lease/);
    expect(exec).not.toHaveBeenCalled(); // zero verifier execution; the helper throws before any reader admission
    expect(f.leases).toHaveLength(0);
    const names = fs.readdirSync(f.dir);
    expect(names.some((n) => n.includes(".staging-"))).toBe(true); // incomplete output retained
    expect(names.some((n) => n.startsWith("workspace.sqlite.pre-v2.sqlite.") && !n.includes("staging"))).toBe(false);
    expect(f.events).not.toContain("prove");
    expect(fs.readFileSync(f.canonical, "utf8")).toBe("retain original");
  });

  it("creates a verified native migration snapshot whose reader lease is released only after close", () => {
    const f = storeFixture();
    observeCloses(f);
    const target = join(f.root, "migration-copy");
    createMigrationSnapshot(f.store.db, f.assetsPath, target, { nativePrivateFilesystem: f.port });
    expect(f.leases).toHaveLength(1);
    expect(f.leases[0].path).toBe(join(target, "workspace.sqlite"));
    expect(f.leases[0].closed).toBe(true);
    expect(f.leases[0].closeCount).toBe(1);
    // The reader whose lease was released is a real observed close: SQLite was
    // known-closed before the lease release ran (also asserted inside close()).
    expect(f.observed).toHaveLength(1);
    expect(f.observed[0].isOpen).toBe(false);
    expect(f.events.indexOf("lease-acquire")).toBeLessThan(f.events.indexOf(`lease-close:${f.leases[0].path}`));
    const manifest = JSON.parse(fs.readFileSync(join(target, "manifest.json"), "utf8"));
    expect(manifest.format).toBe("folio-pre-migration-snapshot");
    expect(manifest.sqlite).toBe("workspace.sqlite");
    const check = new DatabaseSync(join(target, "workspace.sqlite"), { readOnly: true });
    connections.push(check);
    try {
      expect(check.prepare("SELECT id FROM assets").all()).toHaveLength(1);
      expect(check.prepare("SELECT id FROM pages").all().length).toBeGreaterThan(0);
    } finally {
      check.close();
    }
    expect(fs.readFileSync(join(target, "assets", f.asset.id))).toEqual(fs.readFileSync(join(f.assetsPath, f.asset.id)));
  });

  it("commits a native legacy migration with independently leased verification readers", () => {
    const f = storeFixture();
    observeCloses(f);
    const operation = prepareLegacyMigration(previewLegacyMigration(f.store, f.legacy.id));
    const result = commitLegacyMigration(f.store, operation, {
      assetsPath: f.assetsPath,
      snapshotRoot: f.snapshotRoot,
      nativePrivateFilesystem: f.port,
    });
    expect(result.status).toBe("applied");
    expect(typeof result.snapshotPath).toBe("string");
    expect(fs.existsSync(join(result.snapshotPath!, "manifest.json"))).toBe(true);
    expect(fs.existsSync(join(result.snapshotPath!, "assets", f.asset.id))).toBe(true);
    expect(f.leases).toHaveLength(2); // snapshot verification reader, fingerprint reader
    expect(f.leases.every((l) => l.closed && l.closeCount === 1)).toBe(true);
    expect(f.observed).toHaveLength(2);
    expect(f.observed.every((db) => db.isOpen === false)).toBe(true);
    expect(resolveLegacyMigration(f.store, operation).status).toBe("applied");
  });

  it.each(["main-normal", "before-main-close", "after-main-close"] as const)(
    "propagates a retained staging-reader brand through openWorkspaceAtStartup (%s primary close)",
    (mode) => {
      const f = schemaFiles();
      const schemaSentinel = new Error("staging reader close sentinel");
      const primarySentinel = new Error("primary close sentinel");
      const original = DatabaseSync.prototype.close;
      const seen: DatabaseSync[] = [];
      // ordinal1 = preflight reader (real close), ordinal2 = staging reader
      // (throw before close), ordinal3 = primary connection cleanup (mode).
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
        const ordinal = seen.push(this);
        f.events.push(`db-close:${ordinal}`);
        if (ordinal === 2) throw schemaSentinel;
        if (ordinal === 3 && mode === "before-main-close") throw primarySentinel;
        original.call(this);
        f.observed.push(this);
        if (ordinal === 3 && mode === "after-main-close") throw primarySentinel;
        return undefined;
      });
      const { caught, error } = capture(() =>
        openWorkspaceAtStartup(f.dir, () => {}, { nativePrivateFilesystem: f.port }),
      );
      expect(caught).toBe(true);
      expect(startupRetainsNativeLease(error)).toBe(true);
      expect(storeInitializationRetainsNativeLease(error)).toBe(true);
      // Exactly one production close attempt per owned connection; no reclose.
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);
      const reader = seen[1], main = seen[2];
      expect(reader.isOpen).toBe(true); // hidden live reader stays open
      expect(main.isOpen).toBe(mode === "before-main-close");
      // Neither the main lease nor the staging reader lease is released.
      expect(f.leases).toHaveLength(2);
      expect(f.leases[0].path).toBe(f.path);
      expect(f.leases[1].path).toContain(".staging-");
      expect(f.leases.every((l) => l.closeCount === 0 && !l.closed)).toBe(true);
      expect(f.events.filter((e) => e.startsWith("lease-close:"))).toHaveLength(0);
      const root = error as AggregateError & { retainedConnection?: unknown };
      const nested = mode === "main-normal" ? root : (root.errors?.[0] as typeof root);
      // The schema sentinel survives nested inside the root AggregateError.
      expect(nested.errors).toContain(schemaSentinel);
      expect(nested.retainedConnection).toBe(reader);
      if (mode === "main-normal") {
        expect(root.retainedConnection).toBe(reader);
      } else {
        expect(root.errors).toContain(primarySentinel);
        if (mode === "before-main-close") expect(root.retainedConnection).toBe(main);
      }
      expect(fs.readFileSync(f.canonical, "utf8")).toBe("retain original");
      vi.restoreAllMocks();
      // Fresh test-only reader: the source file is untouched.
      const probe = new DatabaseSync(f.path, { readOnly: true });
      try {
        expect(probe.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
        expect(probe.prepare("SELECT body FROM pages WHERE id='p1'").get()?.body).toBe("payload");
      } finally {
        probe.close();
      }
      // Manual cleanup only after spies are restored; production never recloses.
      if (reader.isOpen) reader.close();
      if (main.isOpen) main.close();
      for (const lease of f.leases) try { lease.close(); } catch {}
    },
  );

  it("retains the fingerprint-reader brand when the native port is inherited via ambient scope", () => {
    const f = storeFixture();
    const operation = prepareLegacyMigration(previewLegacyMigration(f.store, f.legacy.id));
    const sentinel = new Error("als fingerprint close sentinel");
    const { state } = closeFault(f, "before-closure", 2, sentinel);
    // Environment carries no explicit port; the ambient context supplies it.
    const { caught, error } = capture(() =>
      withPrivatePersistence({ nativePrivateFilesystem: f.port }, () =>
        commitLegacyMigration(f.store, operation, {
          assetsPath: f.assetsPath,
          snapshotRoot: f.snapshotRoot,
        }),
      ),
    );
    expect(caught).toBe(true);
    expect(startupRetainsNativeLease(error)).toBe(true);
    const branded = error as AggregateError & { retainedConnection?: unknown };
    expect(branded.retainedConnection).toBe(state.target);
    expect(state.target?.isOpen).toBe(true);
    expect(f.leases).toHaveLength(2); // snapshot reader, then fingerprint reader on the same path
    expect(f.leases[0].closed).toBe(true);
    expect(f.leases[0].closeCount).toBe(1);
    expect(f.leases[1].closed).toBe(false);
    expect(f.leases[1].closeCount).toBe(0);
    expect(f.store.db.prepare("SELECT 1 FROM save_receipts WHERE operation_id=?").get(operation.operationId)).toBeUndefined();
    expect(resolveLegacyMigration(f.store, operation).status).toBe("unknown");
    vi.restoreAllMocks();
    if (state.target?.isOpen) state.target.close();
  });
});
