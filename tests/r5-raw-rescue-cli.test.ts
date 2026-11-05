/**
 * R5 headless raw-rescue CLI tests.
 *
 * Every test builds the real entry point with esbuild and spawns it as a child
 * Node process. Only disposable mkdtemp workspaces/destinations are used; the
 * tests never launch Electron, a browser, a GUI or the normal Store.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";

const MARKER = "FOLIO-RAW-SALVAGE-INCOMPLETE";
const roots: string[] = [];
const children = new Set<ChildProcess>();
let buildRoot = "";
let cliPath = "";

beforeAll(() => {
  buildRoot = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-r5-rescue-build-")),
  );
  cliPath = join(buildRoot, "raw-rescue.cjs");
  buildSync({
    entryPoints: [resolve("src/main/raw-rescue-cli.ts")],
    outfile: cliPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["node:sqlite"],
    logLevel: "silent",
  });
}, 60_000);

afterAll(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const child of [...children]) await terminate(child);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  roots.push(root);
  return root;
}

function childEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
  };
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: childEnv(cwd),
  });
}

function terminate(child: ChildProcess): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolvePromise();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    try {
      child.kill("SIGKILL");
    } catch {
      clearTimeout(timer);
      resolvePromise();
    }
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timeout waiting for " + label);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hash every source file so tests can prove the CLI never rewrote data,
 * attachments or journals. Symlinks are recorded by target, never followed. */
function snapshotTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const relativePath = relative(root, path).split(sep).join("/");
      if (info.isDirectory()) {
        pending.push(path);
      } else if (info.isSymbolicLink()) {
        entries[relativePath] = "link:" + readlinkSync(path);
      } else if (info.isFile()) {
        entries[relativePath] = sha256(readFileSync(path));
      } else {
        entries[relativePath] = "other";
      }
    }
  }
  return entries;
}

function treeNames(root: string): string[] {
  return Object.keys(snapshotTree(root)).sort();
}

function onlyBundle(parent: string): string {
  const names = readdirSync(parent).filter((name) =>
    name.startsWith("folio-raw-salvage-"),
  );
  expect(names).toHaveLength(1);
  return join(parent, names[0]);
}

function rescueBundles(parent: string): string[] {
  return readdirSync(parent)
    .filter((name) => name.startsWith("folio-raw-salvage-"))
    .sort()
    .map((name) => join(parent, name));
}

type Manifest = {
  format: string;
  version: number;
  restorable: boolean;
  entries: { path: string; bytes: number; sha256: string }[];
  files: number;
  bytes: number;
};

function readManifest(bundle: string): Manifest {
  return JSON.parse(
    readFileSync(join(bundle, "salvage-manifest.json"), "utf8"),
  ) as Manifest;
}

function expectManifestBytes(bundle: string, manifest: Manifest): void {
  let total = 0;
  for (const entry of manifest.entries) {
    const bytes = readFileSync(join(bundle, ...entry.path.split("/")));
    expect(bytes.length, entry.path).toBe(entry.bytes);
    expect(sha256(bytes), entry.path).toBe(entry.sha256);
    total += entry.bytes;
  }
  expect(manifest.files).toBe(manifest.entries.length);
  expect(manifest.bytes).toBe(total);
}

function schemaRows(db: DatabaseSync): unknown {
  return JSON.parse(
    JSON.stringify(
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        )
        .all(),
    ),
  );
}

function readOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

type Fixture = {
  root: string;
  workspace: string;
  destination: string;
  database: string;
};

function minimalWorkspace(prefix: string): Fixture {
  const root = tempRoot(prefix);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "assets"));
  const database = join(workspace, "workspace.sqlite");
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA user_version=3; CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT);",
  );
  db.prepare("INSERT INTO pages VALUES(?,?)").run(
    "page-1",
    JSON.stringify({ id: "page-1", title: "rescue" }),
  );
  db.close();
  const destination = join(root, "destination");
  mkdirSync(destination);
  return { root, workspace, destination, database };
}

it("builds without Electron/Store and prints help or usage errors without creating output", () => {
  const bundleText = readFileSync(cliPath, "utf8");
  expect(bundleText).not.toContain('require("electron")');
  expect(bundleText).not.toContain("class Store");
  const root = tempRoot("folio-r5-rescue-usage-");
  const destination = join(root, "destination");
  mkdirSync(destination);

  const help = runCli(["--help"], root);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--workspace-closed");
  expect(help.stdout).toContain("復元には使えません");
  expect(help.stderr).toBe("");

  const none = runCli([], root);
  expect(none.status).toBe(2);
  expect(none.stderr).toContain("使用方法の誤り");
  expect(none.stderr).toContain("--workspace");

  const missingClosed = runCli(
    ["--workspace", join(root, "workspace"), "--destination", destination],
    root,
  );
  expect(missingClosed.status).toBe(2);
  expect(missingClosed.stderr).toContain("--workspace-closed");

  const unknown = runCli(["--bogus"], root);
  expect(unknown.status).toBe(2);
  expect(unknown.stderr).toContain("不明なオプション");

  const duplicate = runCli(
    [
      "--workspace",
      join(root, "workspace"),
      "--workspace",
      join(root, "other"),
      "--destination",
      destination,
      "--workspace-closed",
    ],
    root,
  );
  expect(duplicate.status).toBe(2);
  expect(duplicate.stderr).toContain("重複");

  expect(readdirSync(destination)).toEqual([]);
});

it("exports an older schema and malformed Page row, then leaves the source byte-for-byte unchanged", () => {
  const root = tempRoot("folio-r5-rescue-success-");
  const workspace = join(root, "workspace");
  const assets = join(workspace, "assets");
  mkdirSync(assets, { recursive: true });
  const database = join(workspace, "workspace.sqlite");
  const malformed = '{"id":"broken","title":';
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA user_version=2;" +
      "CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT);" +
      "CREATE TABLE legacy_values(key TEXT PRIMARY KEY, value TEXT);",
  );
  db.prepare("INSERT INTO pages VALUES(?,?)").run(
    "healthy",
    JSON.stringify({ id: "healthy", title: "still searchable" }),
  );
  db.prepare("INSERT INTO pages VALUES(?,?)").run("broken", malformed);
  db.prepare("INSERT INTO legacy_values VALUES(?,?)").run("old", "kept");
  db.close();

  const registered = Buffer.from("registered attachment\n");
  writeFileSync(join(assets, "registered.bin"), registered);
  writeFileSync(join(assets, "empty.bin"), Buffer.alloc(0));
  mkdirSync(join(assets, "nested"));
  const nested = Buffer.from("nested unregistered bytes");
  writeFileSync(join(assets, "nested", "extra.txt"), nested);
  const journal = '{"format":"crash-recovery"}\n';
  const staged = '{"format":"crash-recovery","generation":1}\n';
  writeFileSync(join(workspace, "crash-recovery.json"), journal);
  writeFileSync(join(workspace, "crash-recovery.json.stage-abc123"), staged);
  mkdirSync(join(workspace, "backups"));
  writeFileSync(join(workspace, "backups", "secret.txt"), "do not copy");
  writeFileSync(join(workspace, "pre-v2.sqlite"), "do not copy");

  const destination = join(root, "destination");
  mkdirSync(destination);
  writeFileSync(join(destination, "sentinel.txt"), "keep");
  const before = snapshotTree(workspace);
  const beforeNames = treeNames(workspace);

  const result = runCli(
    [
      "--workspace",
      workspace,
      "--destination",
      destination,
      "--workspace-closed",
    ],
    root,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("出力先:");
  expect(result.stdout).toContain("復元には使えません");

  const bundle = onlyBundle(destination);
  expect(readFileSync(join(destination, "sentinel.txt"), "utf8")).toBe("keep");
  expect(existsSync(join(bundle, MARKER))).toBe(false);
  expect(existsSync(join(bundle, "manifest.json"))).toBe(false);
  expect(existsSync(join(bundle, "workspace.sqlite"))).toBe(false);
  expect(existsSync(join(bundle, "backups"))).toBe(false);
  expect(readdirSync(bundle).sort()).toEqual([
    "assets",
    "crash-recovery.json",
    "crash-recovery.json.stage-abc123",
    "salvage-manifest.json",
    "workspace.raw.sqlite",
  ]);

  const manifest = readManifest(bundle);
  expect(manifest).toMatchObject({
    format: "folio-raw-workspace-salvage",
    version: 1,
    restorable: false,
  });
  const paths = manifest.entries.map((entry) => entry.path);
  expect(paths).toContain("workspace.raw.sqlite");
  expect(paths).toContain("assets/registered.bin");
  expect(paths).toContain("assets/empty.bin");
  expect(paths).toContain("assets/nested/extra.txt");
  expect(paths).toContain("crash-recovery.json");
  expect(paths).toContain("crash-recovery.json.stage-abc123");
  expect(paths.some((path) => path.startsWith("backups/"))).toBe(false);
  expectManifestBytes(bundle, manifest);
  expect(() => verifyFullBackup(bundle)).toThrow();

  const snapshot = readOnly(join(bundle, "workspace.raw.sqlite"));
  const source = readOnly(database);
  try {
    expect(snapshot.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 2,
    });
    expect(schemaRows(snapshot)).toEqual(schemaRows(source));
    expect(
      JSON.parse(
        JSON.stringify(
          snapshot.prepare("SELECT id,data FROM pages ORDER BY id").all(),
        ),
      ),
    ).toEqual([
      { id: "broken", data: malformed },
      {
        id: "healthy",
        data: JSON.stringify({ id: "healthy", title: "still searchable" }),
      },
    ]);
    expect(
      JSON.parse(
        JSON.stringify(
          snapshot.prepare("SELECT key,value FROM legacy_values").all(),
        ),
      ),
    ).toEqual([{ key: "old", value: "kept" }]);
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  } finally {
    snapshot.close();
    source.close();
  }

  expect(readFileSync(join(bundle, "assets", "registered.bin"))).toEqual(
    registered,
  );
  expect(readFileSync(join(bundle, "assets", "nested", "extra.txt"))).toEqual(
    nested,
  );
  expect(readFileSync(join(bundle, "crash-recovery.json"), "utf8")).toBe(
    journal,
  );
  expect(
    readFileSync(join(bundle, "crash-recovery.json.stage-abc123"), "utf8"),
  ).toBe(staged);

  expect(snapshotTree(workspace)).toEqual(before);
  expect(treeNames(workspace)).toEqual(beforeNames);
});

it("rejects unsafe paths, hardlinks, symlinks and sidecars before creating output", () => {
  const cases: {
    prefix: string;
    prepare: (fixture: Fixture) => { args: string[]; pattern: RegExp };
  }[] = [
    {
      prefix: "inside-",
      prepare: (fixture) => ({
        args: [
          "--workspace",
          fixture.workspace,
          "--destination",
          fixture.workspace,
          "--workspace-closed",
        ],
        pattern: /ワークスペース内/,
      }),
    },
    {
      prefix: "alias-",
      prepare: (fixture) => {
        const alias = join(fixture.root, "workspace-alias");
        symlinkSync(fixture.workspace, alias);
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            alias,
            "--workspace-closed",
          ],
          pattern: /ワークスペース内/,
        };
      },
    },
    {
      prefix: "workspace-link-",
      prepare: (fixture) => {
        const link = join(fixture.root, "workspace-link");
        symlinkSync(fixture.workspace, link);
        return {
          args: [
            "--workspace",
            link,
            "--destination",
            fixture.destination,
            "--workspace-closed",
          ],
          pattern: /通常のディレクトリではありません/,
        };
      },
    },
    {
      prefix: "db-link-",
      prepare: (fixture) => {
        const outside = join(fixture.root, "outside.sqlite");
        writeFileSync(outside, readFileSync(fixture.database));
        unlinkSync(fixture.database);
        symlinkSync(outside, fixture.database);
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            fixture.destination,
            "--workspace-closed",
          ],
          pattern: /workspace\.sqlite は安全な通常ファイル/,
        };
      },
    },
    {
      prefix: "sidecar-link-",
      prepare: (fixture) => {
        const outside = join(fixture.root, "outside-wal");
        writeFileSync(outside, "not a wal");
        symlinkSync(outside, fixture.database + "-wal");
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            fixture.destination,
            "--workspace-closed",
          ],
          pattern: /sidecar/,
        };
      },
    },
    {
      prefix: "db-hardlink-",
      prepare: (fixture) => {
        linkSync(fixture.database, join(fixture.root, "db-hardlink"));
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            fixture.destination,
            "--workspace-closed",
          ],
          pattern: /workspace\.sqlite は安全な通常ファイル/,
        };
      },
    },
    {
      prefix: "journal-link-",
      prepare: (fixture) => {
        const outside = join(fixture.root, "outside-journal");
        writeFileSync(outside, "outside journal");
        symlinkSync(outside, join(fixture.workspace, "crash-recovery.json"));
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            fixture.destination,
            "--workspace-closed",
          ],
          pattern: /クラッシュ復旧ジャーナルが通常ファイルではありません/,
        };
      },
    },
    {
      prefix: "asset-link-",
      prepare: (fixture) => {
        const outside = join(fixture.root, "outside-asset");
        writeFileSync(outside, "outside bytes");
        symlinkSync(outside, join(fixture.workspace, "assets", "link"));
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            fixture.destination,
            "--workspace-closed",
          ],
          pattern: /シンボリックリンク/,
        };
      },
    },
    {
      prefix: "asset-hardlink-",
      prepare: (fixture) => {
        const outside = join(fixture.root, "outside-asset");
        writeFileSync(outside, "outside bytes");
        linkSync(outside, join(fixture.workspace, "assets", "hard"));
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            fixture.destination,
            "--workspace-closed",
          ],
          pattern: /通常ファイル以外/,
        };
      },
    },
    {
      prefix: "backup-parent-",
      prepare: (fixture) => {
        const backupParent = join(fixture.root, "backup-parent");
        mkdirSync(backupParent);
        writeFileSync(join(backupParent, "workspace.sqlite"), "marker");
        return {
          args: [
            "--workspace",
            fixture.workspace,
            "--destination",
            backupParent,
            "--workspace-closed",
          ],
          pattern: /ワークスペースやバックアップ内/,
        };
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = minimalWorkspace("folio-r5-rescue-" + testCase.prefix);
    const { args, pattern } = testCase.prepare(fixture);
    const before = snapshotTree(fixture.workspace);
    const result = runCli(args, fixture.root);
    expect(result.status, testCase.prefix + " " + result.stderr).toBe(1);
    expect(result.stderr).toMatch(pattern);
    expect(result.stderr).toContain("出力は作成していません");
    expect(rescueBundles(fixture.destination)).toEqual([]);
    expect(snapshotTree(fixture.workspace)).toEqual(before);
  }
});

it("reports missing paths and refuses a missing destination without creating it", () => {
  const root = tempRoot("folio-r5-rescue-missing-");
  const destination = join(root, "destination");
  mkdirSync(destination);

  const missingWorkspace = runCli(
    [
      "--workspace",
      join(root, "not-there"),
      "--destination",
      destination,
      "--workspace-closed",
    ],
    root,
  );
  expect(missingWorkspace.status).toBe(1);
  expect(missingWorkspace.stderr).toContain("ワークスペースが見つかりません");
  expect(missingWorkspace.stderr).toContain("出力は作成していません");
  expect(readdirSync(destination)).toEqual([]);

  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const db = new DatabaseSync(join(workspace, "workspace.sqlite"));
  db.exec("CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT);");
  db.close();
  const absentDestination = join(root, "absent-destination");
  const missingDestination = runCli(
    [
      "--workspace",
      workspace,
      "--destination",
      absentDestination,
      "--workspace-closed",
    ],
    root,
  );
  expect(missingDestination.status).toBe(1);
  expect(missingDestination.stderr).toContain(
    "退避先の親フォルダが見つかりません",
  );
  expect(missingDestination.stderr).toContain("出力は作成していません");
  expect(existsSync(absentDestination)).toBe(false);
});

it("leaves an incomplete marker and no manifest when SQLite cannot be snapshotted", () => {
  const fixture = minimalWorkspace("folio-r5-rescue-corrupt-");
  const created = new DatabaseSync(fixture.database);
  created.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE filler(id INTEGER PRIMARY KEY, value TEXT);",
  );
  for (let index = 0; index < 250; index++)
    created.prepare("INSERT INTO filler(value) VALUES(?)").run("x".repeat(256));
  created.close();

  const bytes = readFileSync(fixture.database);
  expect(bytes.length).toBeGreaterThan(12_288);
  bytes.fill(0xff, 4096, 12_288);
  writeFileSync(fixture.database, bytes);
  const before = snapshotTree(fixture.workspace);

  const result = runCli(
    [
      "--workspace",
      fixture.workspace,
      "--destination",
      fixture.destination,
      "--workspace-closed",
    ],
    fixture.root,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("救出できませんでした");
  expect(result.stderr).toContain("復元には使えません");
  expect(snapshotTree(fixture.workspace)).toEqual(before);

  for (const bundle of rescueBundles(fixture.destination)) {
    expect(existsSync(join(bundle, MARKER))).toBe(true);
    expect(existsSync(join(bundle, "salvage-manifest.json"))).toBe(false);
  }
});

function writeWalWriter(root: string): string {
  const path = join(root, "wal-writer.mjs");
  writeFileSync(
    path,
    [
      'import { DatabaseSync } from "node:sqlite";',
      'import { writeFileSync } from "node:fs";',
      "const [database, ready] = process.argv.slice(2);",
      "const db = new DatabaseSync(database);",
      'db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");',
      'db.exec("CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT);");',
      'db.prepare("INSERT INTO pages VALUES(?,?)").run("wal-page",',
      '  JSON.stringify({ id: "wal-page", title: "committed in WAL" }));',
      'writeFileSync(ready, "ready");',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  return path;
}

it("preserves committed WAL frames from a SIGKILLed writer without rewriting the source", async () => {
  const root = tempRoot("folio-r5-rescue-wal-");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const destination = join(root, "destination");
  mkdirSync(destination);
  const ready = join(root, "writer-ready");
  const writer = spawn(
    process.execPath,
    [writeWalWriter(root), join(workspace, "workspace.sqlite"), ready],
    { cwd: root, env: childEnv(root), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(writer);
  await waitFor(() => existsSync(ready), "WAL writer ready");
  expect(
    lstatSync(join(workspace, "workspace.sqlite-wal")).size,
  ).toBeGreaterThan(0);
  writer.kill("SIGKILL");
  await terminate(writer);
  unlinkSync(ready);

  const walPath = join(workspace, "workspace.sqlite-wal");
  const databasePath = join(workspace, "workspace.sqlite");
  // A killed writer can leave -shm behind. Removing it here proves that the
  // read-only reader recovers committed WAL frames. SQLite controls any
  // rebuilt shared-memory index; the CLI must not unlink another reader's file.
  unlinkSync(join(workspace, "workspace.sqlite-shm"));
  const databaseBefore = sha256(readFileSync(databasePath));
  const walBefore = sha256(readFileSync(walPath));
  const namesBefore = treeNames(workspace);

  const result = runCli(
    [
      "--workspace",
      workspace,
      "--destination",
      destination,
      "--workspace-closed",
    ],
    root,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(sha256(readFileSync(databasePath))).toBe(databaseBefore);
  expect(sha256(readFileSync(walPath))).toBe(walBefore);
  expect(treeNames(workspace).filter(name => !name.endsWith("-shm"))).toEqual(namesBefore.filter(name => !name.endsWith("-shm")));


  const bundle = onlyBundle(destination);
  expect(existsSync(join(bundle, MARKER))).toBe(false);
  expect(readManifest(bundle).restorable).toBe(false);
  const snapshot = readOnly(join(bundle, "workspace.raw.sqlite"));
  try {
    expect(
      JSON.parse(
        JSON.stringify(
          snapshot.prepare("SELECT id,data FROM pages ORDER BY id").all(),
        ),
      ),
    ).toEqual([
      {
        id: "wal-page",
        data: JSON.stringify({ id: "wal-page", title: "committed in WAL" }),
      },
    ]);
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  } finally {
    snapshot.close();
  }
}, 30_000);

it("detects a writer committing during capture even when --workspace-closed was given", async () => {
  const root = tempRoot("folio-r5-rescue-live-");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "assets"));
  const destination = join(root, "destination");
  mkdirSync(destination);
  const database = join(workspace, "workspace.sqlite");
  const initial = new DatabaseSync(database);
  initial.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;" +
      "CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT);",
  );
  initial
    .prepare("INSERT INTO pages VALUES(?,?)")
    .run("initial", JSON.stringify({ id: "initial" }));
  initial.close();

  // The large file plus many small files make the asset phase long enough for
  // the writer to commit after the destination has been reserved.
  writeFileSync(join(workspace, "assets", "large.bin"), Buffer.alloc(64 << 20));
  for (let index = 0; index < 400; index++)
    writeFileSync(
      join(workspace, "assets", `small-${index}.bin`),
      Buffer.alloc(1024, index % 251),
    );

  const ready = join(root, "writer-ready");
  const go = join(root, "writer-go");
  const writerPath = join(root, "late-writer.mjs");
  writeFileSync(
    writerPath,
    [
      'import { DatabaseSync } from "node:sqlite";',
      'import { existsSync, writeFileSync } from "node:fs";',
      "const [database, ready, go] = process.argv.slice(2);",
      "const db = new DatabaseSync(database, { timeout: 5000 });",
      'db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");',
      'writeFileSync(ready, "ready");',
      "for (let i = 0; i < 4000; i++) {",
      "  if (existsSync(go)) break;",
      "  await new Promise((resolve) => setTimeout(resolve, 5));",
      "}",
      'db.prepare("INSERT INTO pages VALUES(?,?)").run("late",',
      '  JSON.stringify({ id: "late" }));',
      "db.close();",
      "",
    ].join("\n"),
  );
  const writer = spawn(process.execPath, [writerPath, database, ready, go], {
    cwd: root,
    env: childEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(writer);
  await waitFor(() => existsSync(ready), "late writer ready");

  const cli = spawn(
    process.execPath,
    [
      cliPath,
      "--workspace",
      workspace,
      "--destination",
      destination,
      "--workspace-closed",
    ],
    { cwd: root, env: childEnv(root), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(cli);
  let stdout = "";
  let stderr = "";
  cli.stdout!.setEncoding("utf8");
  cli.stderr!.setEncoding("utf8");
  cli.stdout!.on("data", (chunk) => (stdout += chunk));
  cli.stderr!.on("data", (chunk) => (stderr += chunk));
  const cliExit = new Promise<number | null>((resolvePromise) =>
    cli.once("exit", (code) => resolvePromise(code)),
  );
  const writerExit = new Promise<number | null>((resolvePromise) =>
    writer.once("exit", (code) => resolvePromise(code)),
  );

  await waitFor(
    () => rescueBundles(destination).length === 1,
    "rescue destination reserved",
  );
  writeFileSync(go, "1");

  expect(await writerExit).toBe(0);
  expect(await cliExit).toBe(1);
  children.delete(cli);
  children.delete(writer);
  expect(stdout).toBe("");
  expect(stderr).toContain("救出中にワークスペースが変更されました");
  expect(stderr).toContain("復元には使えません");

  const bundle = onlyBundle(destination);
  expect(existsSync(join(bundle, MARKER))).toBe(true);
  const manifest = readManifest(bundle);
  expect(manifest.restorable).toBe(false);
}, 30_000);
