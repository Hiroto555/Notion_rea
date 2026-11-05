/**
 * L3-C independent non-GUI fault tests: real child Node processes are killed
 * with SIGKILL at explicit IPC barriers, then the parent reopens the workspace.
 *
 * The child is always a process spawned by this test file. No existing process,
 * Electron app, browser, clipboard, or other worktree is touched. Every SQLite
 * database and attachment lives under a fresh mkdtemp directory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import {
  commitPageOperation,
  resolvePageOperation,
} from "../src/persistence/page-operations";
import { Store } from "../src/persistence/store";
import {
  preparePageCreation,
  preparePageDuplication,
  type PageOperation,
  type PageOperationResult,
} from "../src/shared/page-operation";

const MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const roots: string[] = [];
const children = new Set<ChildProcess>();
let bundleRoot = "";
let workerBundle = "";

beforeAll(() => {
  bundleRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-l3-crash-bundle-")),
  );
  workerBundle = join(bundleRoot, "worker.cjs");
  buildSync({
    entryPoints: [resolve("tests/fixtures/l3-crash-worker.ts")],
    outfile: workerBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    logLevel: "silent",
  });
}, 60_000);

afterAll(() => {
  if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const child of [...children]) await terminate(child);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  // Canonicalize /var -> /private/var up front. The backup creator and the
  // child barrier both canonicalize their own paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function workspace(prefix: string) {
  const root = tempRoot(prefix);
  const directory = join(root, "workspace");
  mkdirSync(directory);
  const database = join(directory, "workspace.sqlite");
  return { root, directory, database };
}

function terminate(child: ChildProcess): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolvePromise) => {
    const done = () => resolvePromise();
    child.once("exit", done);
    try {
      child.kill("SIGKILL");
    } catch {
      done();
    }
    const timer = setTimeout(done, 5_000);
    timer.unref();
  });
}

/** Explicit child environment: no inherited FOLIO/Electron/display settings. */
function childEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: root,
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
  };
}

type Worker = {
  /** Kept so tests can prove the kill target is the process they spawned. */
  pid: number;
  child: ChildProcess;
  messages: any[];
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function startWorker(
  mode: string,
  payload: unknown,
  root: string,
): Worker {
  const payloadPath = join(root, `payload-${mode}-${randomUUID()}.json`);
  writeFileSync(payloadPath, JSON.stringify(payload), { mode: 0o600 });
  const child = spawn(process.execPath, [workerBundle, mode, payloadPath], {
    cwd: root,
    env: childEnv(root),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  if (!child.pid) throw new Error("spawned worker has no pid");
  const pid = child.pid;
  children.add(child);
  const messages: any[] = [];
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (message) => messages.push(message));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolvePromise({ code, signal });
    });
  });
  // A spawn error can arrive while the test is awaiting the barrier/done
  // message instead. Mark the exit promise as observed; callers that await it
  // still receive the rejection.
  exited.catch(() => {});
  return { pid, child, messages, stderr: () => stderr, exited };
}

function waitForMessage(
  worker: Worker,
  type: "barrier" | "done",
  timeoutMs = 20_000,
): Promise<any> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.child.off("message", onMessage);
      worker.child.off("exit", onExit);
      fn();
    };
    const onMessage = (message: any) => {
      if (message?.type === type)
        finish(() => resolvePromise(message));
      else if (message?.type === "error")
        finish(() =>
          rejectPromise(
            new Error(
              `worker reported an error before ${type}: ${String(message.message)}`,
            ),
          ),
        );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() =>
        rejectPromise(
          new Error(
            `worker exited before ${type}: code=${code} signal=${signal}\n${worker.stderr()}`,
          ),
        ),
      );
    const timer = setTimeout(
      () =>
        finish(() =>
          rejectPromise(
            new Error(
              `timed out waiting for ${type}\n${worker.stderr()}`,
            ),
          ),
        ),
      timeoutMs,
    );
    timer.unref();
    worker.child.on("message", onMessage);
    worker.child.once("exit", onExit);
    // A message can arrive between startWorker() and this listener. Check the
    // already-collected messages after subscribing so no notification is lost.
    const existing = worker.messages.find((message) => message?.type === type);
    if (existing) finish(() => resolvePromise(existing));
  });
}

async function runKilledAtBarrier(
  mode: string,
  payload: unknown,
  root: string,
  expectedPoint: string,
): Promise<{ signal: NodeJS.Signals | null }> {
  const worker = startWorker(mode, payload, root);
  expect(Number.isSafeInteger(worker.pid)).toBe(true);
  const barrier = await waitForMessage(worker, "barrier");
  expect(barrier.point).toBe(expectedPoint);
  worker.child.kill("SIGKILL");
  const exit = await worker.exited;
  expect(exit.signal).toBe("SIGKILL");
  return { signal: exit.signal };
}

async function runCompletedWorker(
  mode: string,
  payload: unknown,
  root: string,
): Promise<any> {
  const worker = startWorker(mode, payload, root);
  const done = await waitForMessage(worker, "done");
  const exit = await worker.exited;
  expect(exit.code).toBe(0);
  return done.result;
}

function integrity(store: Store): string {
  const rows = store.db
    .prepare("PRAGMA integrity_check")
    .all() as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  return String(Object.values(rows[0])[0]);
}

function count(store: Store, table: string): number {
  return (
    store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

function receipt(
  store: Store,
  operationId: string,
): { fingerprint: string; result: PageOperationResult } {
  const row = store.db
    .prepare(
      "SELECT fingerprint,result_json FROM save_receipts WHERE operation_id=?",
    )
    .get(operationId) as
    | { fingerprint: string; result_json: string }
    | undefined;
  if (!row) throw new Error("expected a receipt for " + operationId);
  return {
    fingerprint: row.fingerprint,
    result: JSON.parse(row.result_json) as PageOperationResult,
  };
}

function rawPages(store: Store) {
  return store.db
    .prepare("SELECT id,data,body FROM pages ORDER BY id")
    .all();
}

function captureWorkspace(store: Store) {
  return {
    pages: rawPages(store),
    versions: store.db
      .prepare(
        "SELECT id,pageId,createdAt,title,doc,database FROM versions ORDER BY id",
      )
      .all(),
    settings: store.db
      .prepare("SELECT key,value FROM settings ORDER BY key")
      .all(),
    receipts: store.db
      .prepare(
        "SELECT operation_id,fingerprint,result_json FROM save_receipts ORDER BY operation_id",
      )
      .all(),
    assets: store.db
      .prepare("SELECT id,metadata FROM assets ORDER BY id")
      .all(),
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function pageOperationPayload(
  database: string,
  operation: PageOperation,
) {
  return { kind: "page" as const, database, operation };
}

const crashInitialDoc = {
  type: "doc", schemaVersion: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: "初期本文の原子性" }] }],
};

describe("Page operation crash boundaries", () => {
  it(
    "kills a create before COMMIT: no Page and no receipt survive, then one retry creates exactly one Page",
    async () => {
      const f = workspace("folio-l3-crash-create-before-");
      new Store(f.database).close();
      const operation = preparePageCreation("COMMIT前の作成", null, crashInitialDoc);

      await runKilledAtBarrier(
        "page-before-commit",
        pageOperationPayload(f.database, operation),
        f.root,
        "before-commit",
      );

      const store = new Store(f.database);
      try {
        expect(integrity(store)).toBe("ok");
        expect(count(store, "pages")).toBe(0);
        expect(count(store, "save_receipts")).toBe(0);
        expect(resolvePageOperation(store, operation).status).toBe("unknown");

        const applied = commitPageOperation(store, operation);
        expect(applied.status).toBe("applied");
        expect(applied.page?.title).toBe("COMMIT前の作成");
        expect(applied.page?.doc).toEqual(crashInitialDoc);
        expect(store.get(applied.page!.id).doc).toEqual(crashInitialDoc);
        expect(count(store, "pages")).toBe(1);
        expect(count(store, "save_receipts")).toBe(1);
        expect(receipt(store, operation.operationId).result).toEqual(applied);

        expect(commitPageOperation(store, operation)).toEqual(applied);
        expect(count(store, "pages")).toBe(1);
        expect(count(store, "save_receipts")).toBe(1);
        expect(integrity(store)).toBe("ok");
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "kills a create after the Page INSERT but before its receipt: both roll back and a retry is applied once",
    async () => {
      const f = workspace("folio-l3-crash-create-between-");
      new Store(f.database).close();
      const operation = preparePageCreation("途中で停止", null, crashInitialDoc);

      await runKilledAtBarrier(
        "page-between-writes",
        pageOperationPayload(f.database, operation),
        f.root,
        "between-page-and-receipt",
      );

      const store = new Store(f.database);
      try {
        expect(integrity(store)).toBe("ok");
        expect(count(store, "pages")).toBe(0);
        expect(count(store, "save_receipts")).toBe(0);
        expect(resolvePageOperation(store, operation).status).toBe("unknown");

        const applied = commitPageOperation(store, operation);
        expect(applied.status).toBe("applied");
        expect(applied.page?.doc).toEqual(crashInitialDoc);
        expect(count(store, "pages")).toBe(1);
        expect(count(store, "save_receipts")).toBe(1);
        expect(commitPageOperation(store, operation)).toEqual(applied);
        expect(count(store, "pages")).toBe(1);
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "kills a create after COMMIT: Page and receipt coexist, resolve is applied, and retry cannot double-create",
    async () => {
      const f = workspace("folio-l3-crash-create-after-");
      new Store(f.database).close();
      const operation = preparePageCreation("COMMIT後の作成", null, crashInitialDoc);

      await runKilledAtBarrier(
        "page-after-commit",
        pageOperationPayload(f.database, operation),
        f.root,
        "after-commit",
      );

      const store = new Store(f.database);
      try {
        expect(integrity(store)).toBe("ok");
        expect(count(store, "pages")).toBe(1);
        expect(count(store, "save_receipts")).toBe(1);
        const resolved = resolvePageOperation(store, operation);
        expect(resolved.status).toBe("applied");
        expect(resolved.page?.title).toBe("COMMIT後の作成");
        expect(resolved.page?.doc).toEqual(crashInitialDoc);
        expect(store.get(resolved.page!.id).doc).toEqual(crashInitialDoc);
        expect(receipt(store, operation.operationId).result).toEqual(resolved);

        expect(commitPageOperation(store, operation)).toEqual(resolved);
        expect(count(store, "pages")).toBe(1);
        expect(count(store, "save_receipts")).toBe(1);
        expect(store.pages()[0].id).toBe(resolved.page?.id);
        expect(integrity(store)).toBe("ok");
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "kills a subtree duplicate before COMMIT: the source subtree and receipt table stay untouched, then one retry copies once",
    async () => {
      const f = workspace("folio-l3-crash-duplicate-before-");
      const seed = new Store(f.database);
      const source = seed.create(null, "page", "原本");
      const child = seed.create(source.id, "page", "子");
      const grandchild = seed.create(child.id, "page", "孫");
      seed.create(grandchild.id, "page", "曾孫");
      const sourceIds = [...seed.descendants(source.id)];
      const sourceBytes = rawPages(seed);
      seed.close();

      const operation = preparePageDuplication(source.id, source.revision);
      await runKilledAtBarrier(
        "page-before-commit",
        pageOperationPayload(f.database, operation),
        f.root,
        "before-commit",
      );

      const store = new Store(f.database);
      try {
        expect(integrity(store)).toBe("ok");
        expect(count(store, "pages")).toBe(sourceIds.length);
        expect(count(store, "save_receipts")).toBe(0);
        expect(rawPages(store)).toEqual(sourceBytes);
        expect(resolvePageOperation(store, operation).status).toBe("unknown");

        const applied = commitPageOperation(store, operation);
        expect(applied.status).toBe("applied");
        expect(count(store, "pages")).toBe(sourceIds.length * 2);
        expect(count(store, "save_receipts")).toBe(1);
        const copyId = applied.page!.id;
        expect(copyId).not.toBe(source.id);
        expect([...store.descendants(copyId)]).toHaveLength(sourceIds.length);
        expect(
          [...store.descendants(copyId)].some((id) => sourceIds.includes(id)),
        ).toBe(false);
        expect(rawPages(store).filter((row: any) => sourceIds.includes(row.id))).toEqual(
          sourceBytes,
        );

        expect(commitPageOperation(store, operation)).toEqual(applied);
        expect(count(store, "pages")).toBe(sourceIds.length * 2);
        expect(count(store, "save_receipts")).toBe(1);
        expect(integrity(store)).toBe("ok");
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "kills a subtree duplicate after its first copied Page INSERT: the partial subtree rolls back and a retry copies exactly once",
    async () => {
      const f = workspace("folio-l3-crash-duplicate-between-");
      const seed = new Store(f.database);
      const source = seed.create(null, "page", "原本");
      seed.create(source.id, "page", "子");
      seed.create(source.id, "page", "もう一人の子");
      const sourceIds = [...seed.descendants(source.id)];
      const sourceBytes = rawPages(seed);
      seed.close();

      const operation = preparePageDuplication(source.id, source.revision);
      await runKilledAtBarrier(
        "page-between-writes",
        pageOperationPayload(f.database, operation),
        f.root,
        "between-page-and-receipt",
      );

      const store = new Store(f.database);
      try {
        expect(integrity(store)).toBe("ok");
        expect(count(store, "pages")).toBe(sourceIds.length);
        expect(count(store, "save_receipts")).toBe(0);
        expect(rawPages(store)).toEqual(sourceBytes);
        expect(resolvePageOperation(store, operation).status).toBe("unknown");

        const applied = commitPageOperation(store, operation);
        expect(applied.status).toBe("applied");
        expect(count(store, "pages")).toBe(sourceIds.length * 2);
        expect(count(store, "save_receipts")).toBe(1);
        expect([...store.descendants(applied.page!.id)]).toHaveLength(
          sourceIds.length,
        );
        expect(commitPageOperation(store, operation)).toEqual(applied);
        expect(count(store, "pages")).toBe(sourceIds.length * 2);
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "kills a subtree duplicate after COMMIT: copied Pages and the receipt coexist and retry returns the same copy",
    async () => {
      const f = workspace("folio-l3-crash-duplicate-after-");
      const seed = new Store(f.database);
      const source = seed.create(null, "page", "原本");
      const child = seed.create(source.id, "page", "子");
      seed.create(child.id, "page", "孫");
      const sourceIds = [...seed.descendants(source.id)];
      const sourceBytes = rawPages(seed);
      seed.close();

      const operation = preparePageDuplication(source.id, source.revision);
      await runKilledAtBarrier(
        "page-after-commit",
        pageOperationPayload(f.database, operation),
        f.root,
        "after-commit",
      );

      const store = new Store(f.database);
      try {
        expect(integrity(store)).toBe("ok");
        expect(count(store, "pages")).toBe(sourceIds.length * 2);
        expect(count(store, "save_receipts")).toBe(1);
        const resolved = resolvePageOperation(store, operation);
        expect(resolved.status).toBe("applied");
        expect(resolved.page?.title).toBe("原本 のコピー");
        const copyId = resolved.page!.id;
        expect([...store.descendants(copyId)]).toHaveLength(sourceIds.length);
        expect(
          [...store.descendants(copyId)].some((id) => sourceIds.includes(id)),
        ).toBe(false);
        expect(rawPages(store).filter((row: any) => sourceIds.includes(row.id))).toEqual(
          sourceBytes,
        );
        expect(receipt(store, operation.operationId).result).toEqual(resolved);

        expect(commitPageOperation(store, operation)).toEqual(resolved);
        expect(count(store, "pages")).toBe(sourceIds.length * 2);
        expect(count(store, "save_receipts")).toBe(1);
        expect(integrity(store)).toBe("ok");
      } finally {
        store.close();
      }
    },
    30_000,
  );
});

describe("Backup crash boundary", () => {
  it(
    "kills a backup after DB/assets are flushed but before manifest: marker stays, source is unchanged, and verify/restore/open refuse it",
    async () => {
      const f = workspace("folio-l3-crash-backup-");
      const seed = new Store(f.database);
      const operation = preparePageCreation("バックアップ元", null);
      const applied = commitPageOperation(seed, operation);
      expect(applied.status).toBe("applied");
      const edited = seed.update(applied.page!.id, applied.page!.revision, {
        title: "バックアップ元 更新",
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "履歴も保護する" }],
            },
          ],
        },
      });
      seed.handle({ type: "setting", key: "activePage", value: edited.id });
      const assets = join(f.directory, "assets");
      mkdirSync(assets);
      const input = join(f.root, "attachment.txt");
      const body = Buffer.from("L3-C attachment body\n", "utf8");
      writeFileSync(input, body);
      const asset = attachFile(seed.db, assets, input) as { id: string };
      const sourceBefore = captureWorkspace(seed);
      seed.close();

      const destination = join(f.root, "backup");
      await runKilledAtBarrier(
        "backup-before-manifest",
        {
          kind: "backup",
          database: f.database,
          source: f.directory,
          destination,
        },
        f.root,
        "backup-before-manifest",
      );

      // Incomplete publication: marker and copied DB/assets, no manifest.
      expect(readdirSync(destination).sort()).toEqual([
        MARKER,
        "assets",
        "workspace.sqlite",
      ]);
      expect(readFileSync(join(destination, MARKER), "utf8")).toContain(
        "Backup incomplete",
      );
      const copiedAsset = join(destination, "assets", asset.id);
      expect(sha256File(copiedAsset)).toBe(sha256(body));
      const snapshot = new DatabaseSync(join(destination, "workspace.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check,
        ).toBe("ok");
        expect(
          (
            snapshot.prepare("SELECT count(*) AS n FROM pages").get() as {
              n: number;
            }
          ).n,
        ).toBe(1);
        expect(
          (
            snapshot.prepare("SELECT count(*) AS n FROM assets").get() as {
              n: number;
            }
          ).n,
        ).toBe(1);
        expect(
          (
            snapshot.prepare("SELECT count(*) AS n FROM versions").get() as {
              n: number;
            }
          ).n,
        ).toBe(1);
        expect(
          (
            snapshot.prepare("SELECT count(*) AS n FROM save_receipts").get() as {
              n: number;
            }
          ).n,
        ).toBe(1);
      } finally {
        snapshot.close();
      }

      // The source workspace is still logically identical and usable.
      const source = new Store(f.database);
      try {
        expect(integrity(source)).toBe("ok");
        expect(captureWorkspace(source)).toEqual(sourceBefore);
        expect(source.get(applied.page!.id).title).toBe("バックアップ元 更新");
        expect(resolvePageOperation(source, operation)).toEqual(applied);
        expect(sha256File(join(assets, asset.id))).toBe(sha256(body));
      } finally {
        source.close();
      }

      // The marker is authoritative: verification, Store open and restore all
      // refuse the incomplete directory before any write.
      expect(() => verifyFullBackup(destination)).toThrow(
        /FOLIO-RECOVERY-INCOMPLETE|Unexpected backup entry/,
      );
      expect(() => new Store(join(destination, "workspace.sqlite"))).toThrow(
        /復旧が完了していない/,
      );
      const restoreTarget = join(f.root, "restore-attempt");
      expect(() => restoreFullBackup(destination, restoreTarget)).toThrow();
      expect(existsSync(restoreTarget)).toBe(false);
    },
    30_000,
  );

  it(
    "kills a backup after manifest publication but before marker removal: complete-looking content is still refused by the guard",
    async () => {
      const f = workspace("folio-l3-crash-backup-marker-");
      const seed = new Store(f.database);
      const operation = preparePageCreation("manifest後の停止", null);
      const applied = commitPageOperation(seed, operation);
      expect(applied.status).toBe("applied");
      const assets = join(f.directory, "assets");
      mkdirSync(assets);
      const input = join(f.root, "attachment.txt");
      const body = Buffer.from("marker guard attachment\n", "utf8");
      writeFileSync(input, body);
      const asset = attachFile(seed.db, assets, input) as { id: string };
      const sourceBefore = captureWorkspace(seed);
      seed.close();

      const destination = join(f.root, "backup");
      await runKilledAtBarrier(
        "backup-before-marker-removal",
        {
          kind: "backup",
          database: f.database,
          source: f.directory,
          destination,
        },
        f.root,
        "backup-before-marker-removal",
      );

      // The manifest is already published and the copied DB/assets are
      // complete, but the incomplete guard was not removed.
      expect(readdirSync(destination).sort()).toEqual([
        MARKER,
        "assets",
        "manifest.json",
        "workspace.sqlite",
      ]);
      expect(readFileSync(join(destination, MARKER), "utf8")).toContain(
        "Backup incomplete",
      );
      expect(sha256File(join(destination, "assets", asset.id))).toBe(
        sha256(body),
      );
      const manifest = JSON.parse(
        readFileSync(join(destination, "manifest.json"), "utf8"),
      ) as {
        database: { sha256: string };
        assets: { path: string; sha256: string }[];
      };
      expect(manifest.database.sha256).toBe(
        sha256File(join(destination, "workspace.sqlite")),
      );
      expect(manifest.assets).toHaveLength(1);
      expect(manifest.assets[0]).toMatchObject({
        path: `assets/${asset.id}`,
        sha256: sha256(body),
      });
      const snapshot = new DatabaseSync(join(destination, "workspace.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check,
        ).toBe("ok");
        expect(
          (
            snapshot.prepare("SELECT count(*) AS n FROM save_receipts").get() as {
              n: number;
            }
          ).n,
        ).toBe(1);
      } finally {
        snapshot.close();
      }

      // The guard, not the manifest alone, decides completeness.
      expect(() => verifyFullBackup(destination)).toThrow(
        /FOLIO-RECOVERY-INCOMPLETE|Unexpected backup entry/,
      );
      expect(() => new Store(join(destination, "workspace.sqlite"))).toThrow(
        /復旧が完了していない/,
      );
      const restoreTarget = join(f.root, "restore-attempt");
      expect(() => restoreFullBackup(destination, restoreTarget)).toThrow();
      expect(existsSync(restoreTarget)).toBe(false);

      const source = new Store(f.database);
      try {
        expect(integrity(source)).toBe("ok");
        expect(captureWorkspace(source)).toEqual(sourceBefore);
      } finally {
        source.close();
      }
    },
    30_000,
  );

  it(
    "creates a complete backup in a child, then the parent verifies and restores it to a separate directory with matching attachment digests",
    async () => {
      const f = workspace("folio-l3-complete-backup-");
      const seed = new Store(f.database);
      const operation = preparePageCreation("完全バックアップ", null);
      const applied = commitPageOperation(seed, operation);
      expect(applied.status).toBe("applied");
      const assets = join(f.directory, "assets");
      mkdirSync(assets);
      const input = join(f.root, "complete.txt");
      const body = Buffer.from("complete backup attachment\n", "utf8");
      writeFileSync(input, body);
      const asset = attachFile(seed.db, assets, input) as {
        id: string;
        sha256: string;
      };
      const sourceBefore = captureWorkspace(seed);
      seed.close();

      const destination = join(f.root, "complete-backup");
      const result = await runCompletedWorker(
        "backup-complete",
        {
          kind: "backup",
          database: f.database,
          source: f.directory,
          destination,
        },
        f.root,
      );
      expect(result.directory).toBe(realpathSync(destination));
      expect(existsSync(join(destination, MARKER))).toBe(false);

      const verified = verifyFullBackup(destination);
      expect(verified.fingerprint).toBe(result.fingerprint);
      expect(verified.manifest.database.sha256).toBe(
        sha256File(join(destination, "workspace.sqlite")),
      );
      expect(verified.manifest.assets).toHaveLength(1);
      expect(verified.manifest.assets[0]).toMatchObject({
        path: `assets/${asset.id}`,
        sha256: asset.sha256,
        bytes: body.length,
      });

      const restoreTarget = join(f.root, "restored-workspace");
      const restored = restoreFullBackup(destination, restoreTarget);
      expect(restored.sourceFingerprint).toBe(verified.fingerprint);
      expect(restored.manifest).toEqual(verified.manifest);
      expect(existsSync(join(restoreTarget, MARKER))).toBe(false);
      expect(sha256File(join(restoreTarget, "workspace.sqlite"))).toBe(
        verified.manifest.database.sha256,
      );
      expect(sha256File(join(restoreTarget, "assets", asset.id))).toBe(
        asset.sha256,
      );

      const restoredStore = new Store(join(restoreTarget, "workspace.sqlite"));
      try {
        expect(integrity(restoredStore)).toBe("ok");
        expect(restoredStore.get(applied.page!.id).title).toBe(
          "完全バックアップ",
        );
        expect(resolvePageOperation(restoredStore, operation)).toEqual(applied);
        expect(count(restoredStore, "save_receipts")).toBe(1);
      } finally {
        restoredStore.close();
      }

      // The source remains untouched by the backup and the restore.
      const source = new Store(f.database);
      try {
        expect(integrity(source)).toBe("ok");
        expect(captureWorkspace(source)).toEqual(sourceBefore);
        expect(sha256File(join(assets, asset.id))).toBe(asset.sha256);
      } finally {
        source.close();
      }
    },
    30_000,
  );
});
