import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { inspectTransferCacheCatalog } from "../src/sync/transfer-cache-catalog";
import { TransferMaintenanceService } from "../src/main/transfer-maintenance-service";

vi.setConfig({ testTimeout: 30_000 });

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const children = new Set<ChildProcess>();

const CHILD_SOURCE = `
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.env.FOLIO_CATALOG_CHILD_DB);
database.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; PRAGMA cache_spill=ON; PRAGMA synchronous=FULL;");
database.exec("BEGIN IMMEDIATE");
database.exec("UPDATE transfer_identity SET version=2");
const insert = database.prepare("INSERT INTO blob_transfers VALUES(?,?)");
for (let index = 0; index < 32; index++) insert.run("uncommitted-" + index, "x".repeat(8192));
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);
`;

function makeWorkspace(): string {
  const workspace = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-catalog-counter-")),
  );
  roots.push(workspace);
  return workspace;
}

function ensurePrivate(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function journalDirectory(
  workspace: string,
  scopeHash: string,
  journalName: string,
): string {
  const cacheRoot = ensurePrivate(join(workspace, ".folio-sync-transfers"));
  const scope = ensurePrivate(join(cacheRoot, scopeHash));
  return ensurePrivate(join(scope, journalName));
}

function createJournal(
  workspace: string,
  scopeHash: string,
  journalName: string,
): string {
  const directory = journalDirectory(workspace, scopeHash, journalName);
  new BlobTransferJournal(directory, { scopeHash }).close();
  return directory;
}

/** Real filesystem enumeration, independent of the product budget inspector. */
function diskBytes(root: string): number {
  let total = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) total += diskBytes(path);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

function spawnHotJournal(databasePath: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", CHILD_SOURCE],
    {
      env: { ...process.env, FOLIO_CATALOG_CHILD_DB: databasePath },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  return child;
}

function waitForHotJournal(
  child: ChildProcess,
  sidecar: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const deadline = Date.now() + 15_000;
    const timer = setInterval(() => {
      if (!existsSync(sidecar)) {
        if (Date.now() > deadline) {
          cleanup();
          reject(new Error(`hot journal timeout: ${stdout}${stderr}`));
        }
        return;
      }
      if (stdout.includes("READY")) {
        cleanup();
        resolve();
      }
    }, 20);
    function cleanup(): void {
      clearInterval(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onOutput);
      child.off("error", onError);
      child.off("exit", onExit);
    }
    function onData(chunk: Buffer | string): void {
      stdout += chunk.toString();
    }
    function onOutput(chunk: Buffer | string): void {
      stderr += chunk.toString();
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup();
      reject(
        new Error(
          `child exited before hot journal (${code}/${signal}): ${stdout}${stderr}`,
        ),
      );
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onOutput);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function killChild(child: ChildProcess): Promise<void> {
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

async function createHotSidecar(
  workspace: string,
  scopeHash: string,
  journalName: string,
): Promise<{ directory: string; sidecar: string }> {
  const directory = createJournal(workspace, scopeHash, journalName);
  const sidecar = join(directory, "state.sqlite-journal");
  const child = spawnHotJournal(join(directory, "state.sqlite"));
  await waitForHotJournal(child, sidecar);
  await killChild(child);
  expect(existsSync(sidecar)).toBe(true);
  return { directory, sidecar };
}

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
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("transfer cache catalog counter", () => {
  it("samples the diagnostic view after both its ledger and first mutex COMMIT have closed", async () => {
    const workspace = makeWorkspace(), scope = "c".repeat(64);
    createJournal(workspace, scope, "download-" + "d".repeat(64));
    const service = new TransferMaintenanceService(workspace, () => null);
    for (let pass = 0; pass < 2; pass++) {
      const view = await service.view();
      expect(view.held).toBeNull();
      expect(view.usedBytes).toBe(diskBytes(workspace));
      expect(view.entries[0].state).toBe("empty-scope");
    }
  });
  it("samples usedBytes after an owned hot journal closes and removes its sidecar", async () => {
    const workspace = makeWorkspace();
    const scopeHash = "a".repeat(64);
    const { sidecar } = await createHotSidecar(
      workspace,
      scopeHash,
      "download-" + "b".repeat(64),
    );
    const sidecarBytes = lstatSync(sidecar).size;
    const before = diskBytes(workspace);
    expect(before).toBeGreaterThan(sidecarBytes);

    const view = inspectTransferCacheCatalog(workspace, null);
    const after = diskBytes(workspace);

    expect(view.held).toBeNull();
    expect(view.entries).not.toHaveLength(0);
    expect(existsSync(sidecar)).toBe(false);
    expect(after).toBeLessThan(before);
    // Rollback may shrink the main DB pages spilled by the killed child too.
    expect(before - after).toBeGreaterThanOrEqual(sidecarBytes);
    expect(view.usedBytes).toBe(after);
    expect(view.usedBytes).not.toBe(before);
    expect(view.held).toBeNull();
    expect(view.nextCursor).toBeNull();
    expect(view.overLimit).toBe(false);
  });

  it("samples usedBytes after every journal closes on a paginated return", async () => {
    const workspace = makeWorkspace();
    const hotScope = "0".repeat(64);
    const recordsScope = "f".repeat(64);
    const { sidecar } = await createHotSidecar(
      workspace,
      hotScope,
      "download-" + "0".repeat(64),
    );

    const recordsDirectory = journalDirectory(
      workspace,
      recordsScope,
      "download-" + "f".repeat(64),
    );
    const journal = new BlobTransferJournal(recordsDirectory, {
      scopeHash: recordsScope,
    });
    try {
      for (let index = 0; index < 57; index++) {
        const assetId = `asset-${String(index).padStart(3, "0")}`;
        journal.begin({
          direction: "download",
          assetId,
          sha256: sha(`pagination-${index}`),
          bytes: 1,
        });
      }
    } finally {
      journal.close();
    }

    const first = inspectTransferCacheCatalog(workspace, null);
    const afterFirst = diskBytes(workspace);

    expect(existsSync(sidecar)).toBe(false);
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect(first.usedBytes).toBe(afterFirst);
    expect(first.held).toBeNull();

    const collected = [...first.entries];
    let cursor = first.nextCursor;
    for (let page = 0; cursor && page < 5; page++) {
      const next = inspectTransferCacheCatalog(workspace, null, cursor);
      expect(next.usedBytes).toBe(diskBytes(workspace));
      collected.push(...next.entries);
      cursor = next.nextCursor;
    }

    expect(cursor).toBeNull();
    expect(collected).toHaveLength(58);
    expect(new Set(collected.map((entry) => entry.entryId)).size).toBe(58);
  });
});
