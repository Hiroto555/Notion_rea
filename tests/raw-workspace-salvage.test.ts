import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { createRawWorkspaceSalvage } from "../src/persistence/raw-workspace-salvage";
import { Store } from "../src/persistence/store";

const roots: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function openStore(path: string): Store {
  const store = new Store(path);
  stores.push(store);
  return store;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawPages(store: Store) {
  return store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all();
}

function onlyChild(parent: string): string {
  const names = readdirSync(parent);
  expect(names).toHaveLength(1);
  return join(parent, names[0]);
}

type ManifestEntry = { path: string; bytes: number; sha256: string };
type Manifest = {
  format: string;
  version: number;
  restorable: boolean;
  entries: ManifestEntry[];
  files: number;
  bytes: number;
};

function readManifest(directory: string): Manifest {
  return JSON.parse(
    readFileSync(join(directory, "salvage-manifest.json"), "utf8"),
  ) as Manifest;
}

function expectEntriesMatch(directory: string, manifest: Manifest): void {
  let total = 0;
  for (const entry of manifest.entries) {
    const bytes = readFileSync(join(directory, ...entry.path.split("/")));
    expect(bytes.length).toBe(entry.bytes);
    expect(sha256(bytes)).toBe(entry.sha256);
    total += entry.bytes;
  }
  expect(manifest.files).toBe(manifest.entries.length);
  expect(manifest.bytes).toBe(total);
}

it("captures malformed Page JSON, all assets and existing journals into a non-restorable diagnostic bundle", () => {
  const root = tempRoot("folio-raw-salvage-");
  const source = join(root, "workspace");
  mkdirSync(source);
  const store = openStore(join(source, "workspace.sqlite"));
  try {
    const healthy = store.create(null, "page", "Healthy searchable needle");
    const broken = store.create(null, "page", "Broken original");
    const corruptSource = '{"id": "incomplete",\n';
    store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(corruptSource, broken.id);
    const before = rawPages(store);

    const assets = join(source, "assets");
    mkdirSync(assets);
    const input = join(root, "registered.txt");
    writeFileSync(input, Buffer.from("registered attachment\n"));
    const registered = attachFile(store.db, assets, input);
    const extraName = "unregistered.bin";
    const extra = Buffer.from([0, 255, 13, 10]);
    writeFileSync(join(assets, extraName), extra);
    mkdirSync(join(assets, "nested"));
    const nested = Buffer.from("nested unregistered bytes");
    writeFileSync(join(assets, "nested", "extra.txt"), nested);

    const journal = '{"format":"crash-recovery"}\n';
    const staging = '{"format":"crash-recovery","generation":1}\n';
    writeFileSync(join(source, "crash-recovery.json"), journal);
    writeFileSync(join(source, "crash-recovery.json.stage-abc123"), staging);

    // Root-only capture: these must never be traversed or copied.
    mkdirSync(join(source, "backups"));
    writeFileSync(join(source, "backups", "secret.txt"), "do not copy");
    writeFileSync(join(source, "pre-v2.sqlite"), "do not copy");

    const external = join(root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "sentinel"), "keep");

    const result = createRawWorkspaceSalvage(store.db, source, external);
    expect(
      result.directory.startsWith(join(external, "folio-raw-salvage-")),
    ).toBe(true);
    expect(
      existsSync(join(result.directory, "FOLIO-RAW-SALVAGE-INCOMPLETE")),
    ).toBe(false);
    expect(
      existsSync(join(result.directory, "FOLIO-RECOVERY-INCOMPLETE")),
    ).toBe(false);
    expect(existsSync(join(result.directory, "manifest.json"))).toBe(false);
    expect(existsSync(join(result.directory, "workspace.sqlite"))).toBe(false);
    expect(existsSync(join(result.directory, "backups"))).toBe(false);
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("keep");
    expect(readdirSync(result.directory).sort()).toEqual([
      "assets",
      "crash-recovery.json",
      "crash-recovery.json.stage-abc123",
      "salvage-manifest.json",
      "workspace.raw.sqlite",
    ]);

    const manifest = readManifest(result.directory);
    expect(manifest).toMatchObject({
      format: "folio-raw-workspace-salvage",
      version: 1,
      restorable: false,
      files: result.files,
      bytes: result.bytes,
    });
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("workspace.raw.sqlite");
    expect(paths).toContain(`assets/${registered.storageName}`);
    expect(paths).toContain(`assets/${extraName}`);
    expect(paths).toContain("assets/nested/extra.txt");
    expect(paths).toContain("crash-recovery.json");
    expect(paths).toContain("crash-recovery.json.stage-abc123");
    expect(paths.some((path) => path.startsWith("backups/"))).toBe(false);
    expectEntriesMatch(result.directory, manifest);
    expect(result.files).toBe(manifest.entries.length);
    expect(result.bytes).toBe(manifest.bytes);

    // The raw snapshot retains the exact malformed Page row and a usable
    // healthy Page, without any Page JSON validation during salvage.
    const snapshot = new DatabaseSync(
      join(result.directory, "workspace.raw.sqlite"),
      { readOnly: true },
    );
    try {
      const rows = snapshot
        .prepare("SELECT id,data FROM pages ORDER BY id")
        .all() as { id: string; data: string }[];
      expect(rows.find((row) => row.id === broken.id)?.data).toBe(
        corruptSource,
      );
      expect(
        JSON.parse(rows.find((row) => row.id === healthy.id)!.data).title,
      ).toBe("Healthy searchable needle");
      expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      snapshot.close();
    }

    expect(
      readFileSync(join(result.directory, "assets", registered.storageName)),
    ).toEqual(readFileSync(input));
    expect(readFileSync(join(result.directory, "assets", extraName))).toEqual(
      extra,
    );
    expect(
      readFileSync(join(result.directory, "assets", "nested", "extra.txt")),
    ).toEqual(nested);
    expect(
      readFileSync(join(result.directory, "crash-recovery.json"), "utf8"),
    ).toBe(journal);
    expect(
      readFileSync(
        join(result.directory, "crash-recovery.json.stage-abc123"),
        "utf8",
      ),
    ).toBe(staging);

    // Source remains intact and usable for normal healthy-page search. The
    // corrupt Page remains read-only with its exact original bytes.
    expect(rawPages(store)).toEqual(before);
    expect(
      (
        store.handle({ type: "search", query: "searchable needle" }) as {
          id: string;
        }[]
      ).map((page) => page.id),
    ).toContain(healthy.id);
    expect(store.handle({ type: "pageSource", id: broken.id })).toBe(
      corruptSource,
    );
    expect(readFileSync(join(source, "crash-recovery.json"), "utf8")).toBe(
      journal,
    );

    // The distinct layout cannot be consumed by the verified full-backup path.
    expect(() => verifyFullBackup(result.directory)).toThrow();
  } finally {
    store.close();
  }
});

it("creates a new unique bundle for every call and never replaces an earlier one", () => {
  const root = tempRoot("folio-raw-salvage-unique-");
  const source = join(root, "workspace");
  mkdirSync(source);
  const store = openStore(join(source, "workspace.sqlite"));
  try {
    store.create(null, "page", "Unique salvage");
    mkdirSync(join(source, "assets"));
    const external = join(root, "external");
    mkdirSync(external);

    const first = createRawWorkspaceSalvage(store.db, source, external);
    const firstManifest = readFileSync(
      join(first.directory, "salvage-manifest.json"),
      "utf8",
    );
    const second = createRawWorkspaceSalvage(store.db, source, external);
    expect(second.directory).not.toBe(first.directory);
    expect(existsSync(first.directory)).toBe(true);
    expect(
      readFileSync(join(first.directory, "salvage-manifest.json"), "utf8"),
    ).toBe(firstManifest);
    expect(readdirSync(external).sort()).toEqual(
      [first.directory, second.directory]
        .map((directory) => directory.slice(external.length + 1))
        .sort(),
    );
  } finally {
    store.close();
  }
});

it("rejects destinations inside the workspace, including symlink aliases, without writing", () => {
  const root = tempRoot("folio-raw-salvage-inside-");
  const source = join(root, "workspace");
  mkdirSync(source);
  const store = openStore(join(source, "workspace.sqlite"));
  try {
    store.create(null, "page", "Inside source");
    mkdirSync(join(source, "assets"));
    const before = readdirSync(source).sort();

    expect(() => createRawWorkspaceSalvage(store.db, source, source)).toThrow(
      /ワークスペース内/,
    );
    expect(() =>
      createRawWorkspaceSalvage(store.db, source, join(source, "assets")),
    ).toThrow(/ワークスペース内/);

    const alias = join(root, "workspace-alias");
    symlinkSync(source, alias);
    expect(() => createRawWorkspaceSalvage(store.db, source, alias)).toThrow(
      /ワークスペース内/,
    );
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readdirSync(source).sort()).toEqual(before);

    expect(() =>
      createRawWorkspaceSalvage(store.db, source, join(root, "missing")),
    ).toThrow();
    expect(existsSync(join(root, "missing"))).toBe(false);
    expect(readdirSync(source).sort()).toEqual(before);
  } finally {
    store.close();
  }
});

it("leaves the unique incomplete marker and no manifest when an asset symlink cannot be captured", () => {
  const root = tempRoot("folio-raw-salvage-symlink-");
  const source = join(root, "workspace");
  mkdirSync(source);
  const store = openStore(join(source, "workspace.sqlite"));
  try {
    store.create(null, "page", "Symlink failure");
    const assets = join(source, "assets");
    mkdirSync(assets);
    const sentinel = join(root, "outside-sentinel");
    writeFileSync(sentinel, "outside bytes");
    const link = join(assets, "unsafe-link");
    symlinkSync(sentinel, link);
    const before = rawPages(store);
    const external = join(root, "external");
    mkdirSync(external);

    expect(() => createRawWorkspaceSalvage(store.db, source, external)).toThrow(
      /シンボリックリンク/,
    );
    const failed = onlyChild(external);
    expect(existsSync(join(failed, "FOLIO-RAW-SALVAGE-INCOMPLETE"))).toBe(true);
    expect(existsSync(join(failed, "salvage-manifest.json"))).toBe(false);
    expect(existsSync(join(failed, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(false);
    expect(existsSync(join(failed, "workspace.raw.sqlite"))).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside bytes");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(rawPages(store)).toEqual(before);
    expect(
      (
        store.handle({ type: "search", query: "Symlink failure" }) as {
          id: string;
        }[]
      ).length,
    ).toBe(1);
  } finally {
    store.close();
  }
});

it("fails honestly on physical SQLite corruption and never publishes a manifest", () => {
  const root = tempRoot("folio-raw-salvage-corrupt-");
  const source = join(root, "workspace");
  mkdirSync(source);
  const databasePath = join(source, "workspace.sqlite");
  const created = new DatabaseSync(databasePath);
  created.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT, body TEXT);",
  );
  for (let index = 0; index < 200; index++)
    created
      .prepare("INSERT INTO pages VALUES(?,?,?)")
      .run(
        `page-${index}`,
        JSON.stringify({ id: `page-${index}` }),
        "x".repeat(256),
      );
  created.close();

  const bytes = readFileSync(databasePath);
  expect(bytes.length).toBeGreaterThan(12_288);
  bytes.fill(0xff, 4096, 12_288);
  writeFileSync(databasePath, bytes);
  const before = sha256(readFileSync(databasePath));

  const external = join(root, "external");
  mkdirSync(external);
  const corrupt = new DatabaseSync(databasePath);
  try {
    expect(() => createRawWorkspaceSalvage(corrupt, source, external)).toThrow(
      /malformed|corrupt|database disk image/i,
    );
  } finally {
    corrupt.close();
  }
  const failed = onlyChild(external);
  expect(existsSync(join(failed, "FOLIO-RAW-SALVAGE-INCOMPLETE"))).toBe(true);
  expect(existsSync(join(failed, "salvage-manifest.json"))).toBe(false);
  expect(existsSync(join(failed, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(false);
  expect(sha256(readFileSync(databasePath))).toBe(before);
});
