import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { TransferMaintenanceService } from "../src/main/transfer-maintenance-service";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import type { BlobTransferRecord } from "../src/sync/blob-transfer-types";
import { SyncError } from "../src/sync/protocol";
import { PrivateLedger } from "../src/sync/private-ledger";

vi.setConfig({ testTimeout: 60_000 });

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const children = new Set<ChildProcess>();
let buildRoot = "";
let helperScript = "";

type JournalFixture = {
  workspace: string;
  cacheRoot: string;
  scopeDir: string;
  path: string;
  scopeHash: string;
  journalName: string;
  journal: BlobTransferJournal;
};

function createWorkspace(): string {
  const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-m3-maintenance-")),
  );
  roots.push(workspace);
  return workspace;
}

function addJournal(
  workspace: string,
  options: { scopeHash?: string; journalName?: string } = {},
): JournalFixture {
  const scopeHash = options.scopeHash ?? hash("scope:" + randomUUID());
  const journalName =
    options.journalName ?? "download-" + hash("assets:" + randomUUID());
  const cacheRoot = join(workspace, ".folio-sync-transfers");
  const scopeDir = join(cacheRoot, scopeHash);
  const path = join(scopeDir, journalName);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  chmodSync(cacheRoot, 0o700);
  for (const directory of [scopeDir, path]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const journal = new BlobTransferJournal(path, { scopeHash });
  return {
    workspace,
    cacheRoot,
    scopeDir,
    path,
    scopeHash,
    journalName,
    journal,
  };
}

function createJournal(
  options: { scopeHash?: string; journalName?: string } = {},
): JournalFixture {
  return addJournal(createWorkspace(), options);
}

function reopen(fixture: JournalFixture): BlobTransferJournal {
  return new BlobTransferJournal(fixture.path, {
    scopeHash: fixture.scopeHash,
  });
}

function addPartial(
  fixture: JournalFixture,
  options: {
    assetId: string;
    content: string | null;
    bytes?: number;
    direction?: "download" | "upload";
  },
): BlobTransferRecord {
  const direction = options.direction ?? "download";
  const record = fixture.journal.begin({
    direction,
    assetId: options.assetId,
    sha256: hash(direction + "\0" + options.assetId + "\0" + options.assetId),
    bytes: options.bytes ?? (options.content?.length ?? 0),
  });
  if (options.content !== null) {
    writeFileSync(join(fixture.path, record.partialName), options.content, {
      mode: 0o600,
    });
  }
  return record;
}

function entryId(fixture: JournalFixture, record: BlobTransferRecord): string {
  return `${fixture.scopeHash}/${fixture.journalName}/${record.key}`;
}

function emptyEntryId(fixture: JournalFixture): string {
  return `${fixture.scopeHash}/${fixture.journalName}/!`;
}

async function rejection(
  run: () => Promise<unknown>,
): Promise<SyncError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SyncError) return error;
    throw error;
  }
  throw new Error("expected SyncError");
}

function snapshotTree(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const child = join(relative, name);
      if (stat.isDirectory()) {
        result.push(`d:${child}:${stat.ino}`);
        visit(path, child);
      } else {
        result.push(
          `f:${child}:${stat.size}:${stat.ino}:${stat.mtimeMs}:${readFileSync(
            path,
          ).toString("hex")}`,
        );
      }
    }
  };
  visit(root, "");
  return result;
}

type ChildRun = {
  process: ChildProcess;
  messages: any[];
  stderr: () => string;
};

function spawnChild(input: unknown): ChildRun {
  const child = spawn(globalThis.process.execPath, [helperScript], {
    env: {
      ...globalThis.process.env,
      FOLIO_MAINTENANCE_CHILD: JSON.stringify(input),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const messages: any[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data) => {
    stdout += String(data);
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* ignore partial/non-JSON output */
      }
    }
  });
  child.stderr!.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-8000);
  });
  return { process: child, messages, stderr: () => stderr };
}

async function waitForPhase(
  run: ChildRun,
  phase: string,
  operationId: string,
): Promise<void> {
  await expect
    .poll(
      () =>
        run.messages.some(
          (message) =>
            message?.phase === phase && message?.operationId === operationId,
        ),
      {
        timeout: 15_000,
        message: "maintenance child phase notification",
      },
    )
    .toBe(true);
}

async function stop(run: ChildRun): Promise<void> {
  const child = run.process;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("child did not exit after SIGKILL")),
        5_000,
      ),
    ),
  ]);
  expect(child.signalCode).toBe("SIGKILL");
}

beforeAll(() => {
  buildRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-m3-maintenance-build-")),
  );
  const servicePath = resolve("src/main/transfer-maintenance-service.ts");
  const source = join(buildRoot, "m3-maintenance-child.ts");
  writeFileSync(
    source,
    `
import { writeSync } from "node:fs";
import { TransferMaintenanceService } from ${JSON.stringify(servicePath)};
const input = JSON.parse(process.env.FOLIO_MAINTENANCE_CHILD || "{}");
const notify = (message) => {
  try {
    writeSync(1, JSON.stringify(message) + "\\n");
  } catch {}
};
const service = new TransferMaintenanceService(
  input.workspace,
  () => (input.currentScope === undefined ? null : input.currentScope),
  (phase, operationId) => {
    notify({ phase, operationId });
    if (input.killAfter && phase === input.killAfter && operationId === input.operationId) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
);
service.release(input.operationId)
  .then((result) => {
    notify({ result });
    process.exit(0);
  })
  .catch((error) => {
    notify({ error: error && error.code ? error.code : String(error) });
    process.exit(1);
  });
`,
    "utf8",
  );
  helperScript = join(buildRoot, "m3-maintenance-child.mjs");
  buildSync({
    entryPoints: [source],
    outfile: helperScript,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "bundle",
    target: "node24",
  });
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise((done) => setTimeout(done, 2_000)),
      ]);
    }
  }
  children.clear();
  while (roots.length)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

afterAll(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

it("plans and releases only the pinned partial bytes", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-partial",
    content: "abc",
    bytes: 10,
  });
  const id = entryId(fixture, record);
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);

  const view = await service.view();
  expect(view.entries.find((entry) => entry.entryId === id)).toMatchObject({
    scopeHash: fixture.scopeHash,
    assetId: "asset-partial",
    bytes: 3,
    offset: 0,
    state: "active",
    currentScope: false,
    canRelease: true,
  });

  const plan = await service.plan(id);
  expect(plan.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(plan.entry).toMatchObject({
    entryId: id,
    state: "active",
    bytes: 3,
    canRelease: true,
  });
  expect(plan.expiresAt).toBeGreaterThan(Date.now());

  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    operationId: plan.operationId,
    outcome: "released",
    releasedBytes: 3,
    reason: null,
  });
  expect(existsSync(join(fixture.path, record.partialName))).toBe(false);
  const journal = reopen(fixture);
  expect(journal.get(record.key)).toBeNull();
  journal.close();
  expect(await service.resolve(plan.operationId)).toMatchObject({
    outcome: "released",
    releasedBytes: 3,
  });
});

it("releases a record whose partial file is already missing", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-missing",
    content: null,
    bytes: 7,
  });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);

  const plan = await service.plan(entryId(fixture, record));
  expect(plan.entry).toMatchObject({ bytes: 0, canRelease: true });
  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    outcome: "released",
    releasedBytes: 0,
    reason: null,
  });
  const journal = reopen(fixture);
  expect(journal.get(record.key)).toBeNull();
  journal.close();
});

it("returns the same completed result on a double release", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-double",
    content: "four",
  });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);
  const plan = await service.plan(entryId(fixture, record));

  const first = await service.release(plan.operationId);
  const second = await service.release(plan.operationId);
  expect(first).toMatchObject({ outcome: "released", releasedBytes: 4 });
  expect(second).toEqual(first);
  expect(await service.resolve(plan.operationId)).toEqual(first);
});

it("holds a release when the journal record changed after planning", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-stale-record",
    content: "abc",
    bytes: 10,
  });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);
  const plan = await service.plan(entryId(fixture, record));

  const journal = reopen(fixture);
  journal.checkpoint(record.key, 3, hash("abc"));
  journal.close();

  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    outcome: "held",
    reason: "cache-release-stale",
    releasedBytes: 0,
  });
  expect(readFileSync(join(fixture.path, record.partialName), "utf8")).toBe(
    "abc",
  );
  const after = reopen(fixture);
  expect(after.get(record.key)).toMatchObject({ state: "active", offset: 3 });
  after.close();
});

it("holds a release when the partial file changed after planning", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-stale-file",
    content: "abc",
    bytes: 10,
  });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);
  const plan = await service.plan(entryId(fixture, record));

  writeFileSync(join(fixture.path, record.partialName), "abcdef", {
    mode: 0o600,
  });
  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    outcome: "held",
    reason: "cache-release-stale",
  });
  expect(readFileSync(join(fixture.path, record.partialName), "utf8")).toBe(
    "abcdef",
  );
});

it("holds a release when the journal root inode changed after planning", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-stale-root",
    content: "root",
  });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);
  const plan = await service.plan(entryId(fixture, record));

  const moved = fixture.path + ".old";
  renameSync(fixture.path, moved);
  mkdirSync(fixture.path, { mode: 0o700 });
  chmodSync(fixture.path, 0o700);

  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    outcome: "held",
    reason: "cache-release-stale",
  });
  expect(existsSync(join(moved, record.partialName))).toBe(true);
  expect(existsSync(join(moved, "state.sqlite"))).toBe(true);
});

it("holds a release when the journal database inode changed after planning", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-stale-db",
    content: "db!!",
  });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);
  const plan = await service.plan(entryId(fixture, record));

  const database = join(fixture.path, "state.sqlite");
  const copy = database + ".copy";
  writeFileSync(copy, readFileSync(database));
  renameSync(copy, database);

  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    outcome: "held",
    reason: "cache-release-stale",
  });
  expect(existsSync(join(fixture.path, record.partialName))).toBe(true);
});

it("rejects a symlinked partial without following it", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-symlink",
    content: null,
    bytes: 4,
  });
  const target = join(fixture.workspace, "outside-target.bin");
  writeFileSync(target, "secret-target", { mode: 0o600 });
  symlinkSync(target, join(fixture.path, record.partialName));
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);

  const error = await rejection(() =>
    service.plan(entryId(fixture, record)),
  );
  expect(error.code).toBe("cache-release-stale");
  expect(readFileSync(target, "utf8")).toBe("secret-target");
});

it("rejects a hardlinked partial and leaves both links intact", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-hardlink",
    content: null,
    bytes: 4,
  });
  const target = join(fixture.workspace, "outside-hardlink.bin");
  writeFileSync(target, "hard-target", { mode: 0o600 });
  linkSync(target, join(fixture.path, record.partialName));
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);

  const error = await rejection(() =>
    service.plan(entryId(fixture, record)),
  );
  expect(error.code).toBe("cache-release-stale");
  expect(readFileSync(target, "utf8")).toBe("hard-target");
  expect(
    lstatSync(join(fixture.path, record.partialName)).nlink,
  ).toBe(2);
});

it("retires an old empty journal metadata-only", async () => {
  const fixture = createJournal();
  fixture.journal.close();
  const database = lstatSync(join(fixture.path, "state.sqlite"));
  const service = new TransferMaintenanceService(fixture.workspace, () => null);

  const view = await service.view();
  expect(view.entries.find((entry) => entry.entryId === emptyEntryId(fixture))).toMatchObject({
    state: "empty-scope",
    currentScope: false,
    canRelease: true,
    bytes: database.size,
  });

  const plan = await service.plan(emptyEntryId(fixture));
  expect(plan.entry).toMatchObject({
    state: "empty-scope",
    canRelease: true,
    bytes: database.size,
  });
  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    outcome: "released",
    releasedBytes: database.size,
    reason: null,
  });
  expect(existsSync(fixture.path)).toBe(false);
  expect(existsSync(fixture.scopeDir)).toBe(false);
  expect(existsSync(fixture.cacheRoot)).toBe(true);
});

it("forbids retiring the current scope", async () => {
  const fixture = createJournal();
  fixture.journal.close();
  let current: string | null = null;
  const service = new TransferMaintenanceService(
    fixture.workspace,
    () => current,
  );
  const id = emptyEntryId(fixture);
  const plan = await service.plan(id);

  current = fixture.scopeHash;
  const view = await service.view();
  expect(view.entries.find((entry) => entry.entryId === id)).toMatchObject({
    currentScope: true,
    canRelease: false,
    reason: "current-scope",
  });

  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({
    outcome: "held",
    reason: "cache-release-stale",
  });
  expect(existsSync(join(fixture.path, "state.sqlite"))).toBe(true);
  expect((await rejection(() => service.plan(id))).code).toBe(
    "cache-release-stale",
  );
});

it("preserves unknown files in a journal directory", async () => {
  const fixture = createJournal();
  const record = addPartial(fixture, {
    assetId: "asset-unknown",
    content: "known",
  });
  const orphan = join(fixture.path, "orphan.bin");
  writeFileSync(orphan, "keep-me", { mode: 0o600 });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);

  const plan = await service.plan(entryId(fixture, record));
  const result = await service.release(plan.operationId);
  expect(result).toMatchObject({ outcome: "released" });
  expect(readFileSync(orphan, "utf8")).toBe("keep-me");
  expect(existsSync(join(fixture.path, record.partialName))).toBe(false);

  const empty = createJournal();
  empty.journal.close();
  const unknown = join(empty.path, "orphan.bin");
  writeFileSync(unknown, "keep-this", { mode: 0o600 });
  const second = new TransferMaintenanceService(empty.workspace, () => null);
  expect((await rejection(() => second.plan(emptyEntryId(empty)))).code).toBe(
    "cache-release-stale",
  );
  expect(readFileSync(unknown, "utf8")).toBe("keep-this");
  expect(existsSync(join(empty.path, "state.sqlite"))).toBe(true);
});

it("leaves live assets, staging and backups byte-for-byte unchanged", async () => {
  const workspace = createWorkspace();
  const live = addJournal(workspace);
  const record = addPartial(live, {
    assetId: "asset-live",
    content: "live-partial",
  });
  const empty = addJournal(workspace);
  live.journal.close();
  empty.journal.close();

  const files: Array<[string, string, string]> = [
    ["assets", "live.bin", "live-asset-bytes"],
    [".folio-sync-assets-staging", "staged.bin", "staged-bytes"],
    ["backups", "backup.bin", "backup-bytes"],
  ];
  for (const [directory, name, content] of files) {
    const root = join(workspace, directory);
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    writeFileSync(join(root, name), content, { mode: 0o600 });
  }
  const before = snapshotTree(join(workspace, "assets"))
    .concat(snapshotTree(join(workspace, ".folio-sync-assets-staging")))
    .concat(snapshotTree(join(workspace, "backups")));

  const service = new TransferMaintenanceService(workspace, () => null);
  const partialPlan = await service.plan(entryId(live, record));
  expect((await service.release(partialPlan.operationId)).outcome).toBe(
    "released",
  );
  const emptyPlan = await service.plan(emptyEntryId(empty));
  expect((await service.release(emptyPlan.operationId)).outcome).toBe(
    "released",
  );

  const after = snapshotTree(join(workspace, "assets"))
    .concat(snapshotTree(join(workspace, ".folio-sync-assets-staging")))
    .concat(snapshotTree(join(workspace, "backups")));
  expect(after).toEqual(before);
});

for (const phase of ["marking", "releasing", "trashed", "unlinked", "completed"] as const) {
  it(`reopens and completes after SIGKILL at durable ${phase} phase`, async () => {
    const fixture = createJournal();
    const record = addPartial(fixture, {
      assetId: `asset-kill-${phase}`,
      content: "abcdef",
      bytes: 12,
    });
    fixture.journal.close();
    const service = new TransferMaintenanceService(
      fixture.workspace,
      () => null,
    );
    const plan = await service.plan(entryId(fixture, record));
    const run = spawnChild({
      workspace: fixture.workspace,
      operationId: plan.operationId,
      killAfter: phase,
    });
    await waitForPhase(run, phase, plan.operationId);
    await stop(run);

    const partial = join(fixture.path, record.partialName);
    const trash = join(fixture.path, `.release-${plan.operationId}.part`);

    const journal = reopen(fixture);
    const durable = journal.get(record.key);
    journal.close();
    if (phase === "marking") {
      expect(durable).toEqual(record);
    } else if (phase === "completed") {
      expect(durable).toBeNull();
    } else {
      expect(durable).toMatchObject({
        state: "releasing",
        reason: plan.operationId,
      });
    }
    if (phase === "marking" || phase === "releasing") {
      expect(existsSync(partial)).toBe(true);
      expect(existsSync(trash)).toBe(false);
    } else if (phase === "trashed") {
      expect(existsSync(partial)).toBe(false);
      expect(existsSync(trash)).toBe(true);
    } else {
      expect(existsSync(partial)).toBe(false);
      expect(existsSync(trash)).toBe(false);
    }

    const resumed = await service.release(plan.operationId);
    expect(resumed).toMatchObject({
      outcome: "released",
      releasedBytes: 6,
      reason: null,
    });
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(trash)).toBe(false);
    const after = reopen(fixture);
    expect(after.get(record.key)).toBeNull();
    after.close();
    expect(await service.resolve(plan.operationId)).toMatchObject({
      outcome: "released",
      releasedBytes: 6,
    });
  });
}

it("resumes a journal COMMIT whose acknowledgement was lost after plan expiry", async () => {
  const fixture = createJournal(), record = addPartial(fixture, {assetId: "lost-mark", content: "kept"});
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);
  const plan = await service.plan(entryId(fixture, record));
  const original = BlobTransferJournal.prototype.markRelease;
  const mark = vi.spyOn(BlobTransferJournal.prototype, "markRelease").mockImplementationOnce(function(this: BlobTransferJournal, expected, operationId) {
    original.call(this, expected, operationId); throw new SyncError("sync-storage-unavailable", 503);
  });
  try {expect(await service.release(plan.operationId)).toMatchObject({outcome: "outcome-unknown"});} finally {mark.mockRestore();}
  const clock = vi.spyOn(Date, "now").mockReturnValue(plan.expiresAt + 1);
  try {
    expect((await service.view()).entries.some(e => e.operationId === plan.operationId)).toBe(true);
    expect(await service.release(plan.operationId)).toMatchObject({outcome: "released", releasedBytes: 4});
  } finally {clock.mockRestore();}
});

it("reclaims 1000 expired unstarted plans and retains a recent completion receipt", async () => {
  const fixture = createJournal(), record = addPartial(fixture, {assetId: "plans", content: "data"});
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null), plan = await service.plan(entryId(fixture, record));
  const ledger = new PrivateLedger(fixture.cacheRoot, "cache-maintenance.sqlite", "cache-maintenance");
  const source = JSON.parse(ledger.read("release:" + plan.operationId)!);
  ledger.transaction(() => {
    ledger.write("release:" + plan.operationId, null);
    for (let n = 0; n < 1000; n++) {const id = randomUUID(); ledger.write("release:" + id, JSON.stringify({...source, id, expiresAt: Date.now() - 1000}));}
  });
  ledger.close();
  const next = await service.plan(entryId(fixture, record));
  expect(await service.release(next.operationId)).toMatchObject({outcome: "released"});
  expect(await service.resolve(next.operationId)).toMatchObject({outcome: "released"});
});

it("does not delete a new transfer record when resuming an interrupted release", async () => {
  const fixture = createJournal();
  const old = addPartial(fixture, {
    assetId: "old-asset",
    content: "old-bytes",
    bytes: 9,
  });
  fixture.journal.close();
  const service = new TransferMaintenanceService(fixture.workspace, () => null);
  const plan = await service.plan(entryId(fixture, old));
  const run = spawnChild({
    workspace: fixture.workspace,
    operationId: plan.operationId,
    killAfter: "trashed",
  });
  await waitForPhase(run, "trashed", plan.operationId);
  await stop(run);

  const journal = reopen(fixture);
  const fresh = journal.begin({
    direction: "download",
    assetId: "new-asset",
    sha256: hash("new-asset-bytes"),
    bytes: 11,
  });
  writeFileSync(join(fixture.path, fresh.partialName), "new-content", {
    mode: 0o600,
  });
  journal.close();
  const newPartial = join(fixture.path, fresh.partialName);
  const newBytes = readFileSync(newPartial);
  const newStat = lstatSync(newPartial);

  const resumed = await service.release(plan.operationId);
  expect(resumed).toMatchObject({
    outcome: "released",
    releasedBytes: 9,
    reason: null,
  });

  const after = reopen(fixture);
  expect(after.get(old.key)).toBeNull();
  expect(after.get(fresh.key)).toMatchObject({
    assetId: "new-asset",
    state: "active",
  });
  after.close();
  expect(readFileSync(newPartial)).toEqual(newBytes);
  expect(lstatSync(newPartial).ino).toBe(newStat.ino);
  expect(existsSync(join(fixture.path, `.release-${plan.operationId}.part`))).toBe(
    false,
  );
});
