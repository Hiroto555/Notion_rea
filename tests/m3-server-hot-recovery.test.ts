import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointServerHandle } from "../src/sync/checkpoint-server";
import {
  initializeOperationalServer,
  startOperationalServer,
} from "../src/sync/operational-server";
import { SyncError } from "../src/sync/protocol";
import { acquireServerDirectoryLease, type ServerDirectoryLease } from "../src/sync/server-directory-lease";
import { createServerFullBackup } from "../src/sync/server-full-backup";
import { inspectFullServerBackup } from "../src/sync/server-full-inspection";
import { inspectServerHistory } from "../src/sync/server-history-validation";

const WORKSPACE_ID = "hot-recovery";
const OWNER_ID = "owner";
const DEVICE_COUNT = 480;
const JOURNAL = "-journal";
const roots: string[] = [];

const CHILD_SOURCE = `import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; PRAGMA cache_spill=ON; PRAGMA synchronous=FULL;");
db.exec("BEGIN IMMEDIATE");
db.exec("UPDATE checkpoint_devices SET revoked=1");
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);
`;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "folio-hot-recovery-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("missing loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function initialize(root: string): Promise<string> {
  const directory = join(root, "server");
  const result = await initializeOperationalServer(directory, {
    format: "folio-server-config/v1",
    workspaceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    port: await freeLoopbackPort(),
  });
  return result.directory;
}

function seedDevices(directory: string): void {
  const db = new DatabaseSync(join(directory, "server.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    const insert = db.prepare(
      "INSERT INTO checkpoint_devices(workspace_id,client_id,owner_id,token_hash,revoked) VALUES(?,?,?,?,0)",
    );
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < DEVICE_COUNT; index++) {
      insert.run(
        WORKSPACE_ID,
        `device-${index}`,
        OWNER_ID,
        createHash("sha256").update(`token-${index}`).digest("hex"),
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function writeChild(root: string): string {
  const path = join(root, "crash-child.mjs");
  writeFileSync(path, CHILD_SOURCE, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child ready timeout: ${stdout}${stderr}`));
    }, 20_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onErrorOutput);
      child.off("error", onError);
      child.off("exit", onExit);
    }
    function onData(chunk: Buffer | string): void {
      stdout += chunk.toString();
      if (stdout.includes("READY")) {
        cleanup();
        resolve();
      }
    }
    function onErrorOutput(chunk: Buffer | string): void {
      stderr += chunk.toString();
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      reject(new Error(`child exited before ready (${code}/${signal}): ${stdout}${stderr}`));
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onErrorOutput);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("child exit timeout after SIGKILL"));
    }, 10_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    function onExit(): void {
      cleanup();
      resolve();
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function withLease<T>(directory: string, work: (lease: ServerDirectoryLease) => T): T {
  const lease = acquireServerDirectoryLease(directory);
  try {
    return work(lease);
  } finally {
    lease.close();
  }
}

function backupNow(sourceDirectory: string, destination: string) {
  return withLease(sourceDirectory, (lease) =>
    createServerFullBackup({ sourceDirectory, destination, lease }),
  );
}

function removeSidecars(databasePath: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) rmSync(databasePath + suffix, { force: true });
}

afterEach(() => {
  while (roots.length > 0) {
    const directory = roots.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("operational server hot journal recovery", () => {
  it(
    "a real SIGKILL leaves a hot journal; backup refuses it and start recovers all devices",
    async () => {
      const root = makeRoot();
      const directory = await initialize(root);
      seedDevices(directory);
      const databasePath = join(directory, "server.sqlite");
      const journalPath = databasePath + JOURNAL;
      const child = spawn(process.execPath, [writeChild(root), databasePath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let server: CheckpointServerHandle | undefined;
      try {
        await waitForReady(child);
        const exited = waitForExit(child);
        child.kill("SIGKILL");
        await exited;

        const journal = lstatSync(journalPath);
        expect(journal.isFile()).toBe(true);
        expect(journal.size).toBeGreaterThan(0);

        const sourceBefore = readFileSync(databasePath);
        const journalBefore = readFileSync(journalPath);
        const destination = join(root, "backup");
        let failure: unknown;
        try {
          backupNow(directory, destination);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(SyncError);
        const syncFailure = failure as SyncError;
        expect(syncFailure.code).toBe("server-recovery-required");
        expect(syncFailure.status).toBe(409);
        expect(readFileSync(databasePath).equals(sourceBefore)).toBe(true);
        expect(readFileSync(journalPath).equals(journalBefore)).toBe(true);
        expect(lstatSync(journalPath).size).toBeGreaterThan(0);
        expect(existsSync(destination)).toBe(false);

        server = await startOperationalServer(directory);
        await server.close();
        server = undefined;

        expect(!existsSync(journalPath) || lstatSync(journalPath).size === 0).toBe(true);
        const db = new DatabaseSync(databasePath, { readOnly: true });
        try {
          const history = inspectServerHistory(db);
          expect(history.devices).toBe(DEVICE_COUNT);
          expect(history.activeDevices).toBe(DEVICE_COUNT);
          expect(history.revokedDevices).toBe(0);
          expect(history.workspaces).toEqual([
            { workspaceId: WORKSPACE_ID, ownerId: OWNER_ID, revision: 0, checkpointHash: null },
          ]);
          const rows = db
            .prepare("SELECT revoked, COUNT(*) AS n FROM checkpoint_devices GROUP BY revoked ORDER BY revoked")
            .all();
          expect(rows).toEqual([{ revoked: 0, n: DEVICE_COUNT }]);
        } finally {
          db.close();
        }

        const backup = backupNow(directory, destination);
        expect(backup.manifest.counts).toMatchObject({
          devices: DEVICE_COUNT,
          activeDevices: DEVICE_COUNT,
          revokedDevices: 0,
        });
        expect(inspectFullServerBackup(backup.destination).counts).toMatchObject({
          devices: DEVICE_COUNT,
          activeDevices: DEVICE_COUNT,
          revokedDevices: 0,
        });
      } finally {
        if (server) {
          try {
            await server.close();
          } catch {}
        }
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }
    },
    60_000,
  );

  it("refuses a symlinked SQLite sidecar without modifying its target", async () => {
    const root = makeRoot();
    const directory = await initialize(root);
    const databasePath = join(directory, "server.sqlite");
    removeSidecars(databasePath);
    const target = join(root, "symlink-target.bin");
    writeFileSync(target, "keep-symlink-target", { mode: 0o600 });
    chmodSync(target, 0o600);
    const journalPath = databasePath + JOURNAL;
    symlinkSync(target, journalPath);
    const targetBefore = readFileSync(target);
    const sourceBefore = readFileSync(databasePath);

    await expect(startOperationalServer(directory)).rejects.toMatchObject({
      code: "m3-private-root-unsafe",
      status: 409,
    });

    expect(lstatSync(journalPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target).equals(targetBefore)).toBe(true);
    expect(readFileSync(databasePath).equals(sourceBefore)).toBe(true);
  });

  it("refuses a hardlinked SQLite sidecar without modifying its target", async () => {
    const root = makeRoot();
    const directory = await initialize(root);
    const databasePath = join(directory, "server.sqlite");
    removeSidecars(databasePath);
    const target = join(root, "hardlink-target.bin");
    writeFileSync(target, "keep-hardlink-target", { mode: 0o600 });
    chmodSync(target, 0o600);
    const journalPath = databasePath + JOURNAL;
    linkSync(target, journalPath);
    expect(lstatSync(journalPath).nlink).toBe(2);
    const targetBefore = readFileSync(target);
    const sourceBefore = readFileSync(databasePath);

    await expect(startOperationalServer(directory)).rejects.toMatchObject({
      code: "m3-private-root-unsafe",
      status: 409,
    });

    expect(lstatSync(journalPath).nlink).toBe(2);
    expect(readFileSync(target).equals(targetBefore)).toBe(true);
    expect(readFileSync(databasePath).equals(sourceBefore)).toBe(true);
  });
});
