import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { acquireServerDirectoryLease } from "../src/sync/server-directory-lease";
import { SyncError } from "../src/sync/protocol";

const LOCK_NAME = ".folio-server-lock.sqlite";
const MAX_LOCK_BYTES = 1024 * 1024;
const temporaryDirectories: string[] = [];

function makeRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "folio-lease-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "server");
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function lockPath(root: string): string {
  return join(root, LOCK_NAME);
}

function expectCode(
  work: () => unknown,
  code: string,
  status: number,
): SyncError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    const failure = error as SyncError;
    expect(failure.code).toBe(code);
    expect(failure.status).toBe(status);
    return failure;
  }
  throw new Error(`expected ${code}`);
}

function expectUnsafe(work: () => unknown): SyncError {
  return expectCode(work, "server-maintenance-unsafe", 409);
}

function expectBusy(work: () => unknown): SyncError {
  return expectCode(work, "server-maintenance-busy", 409);
}

function createPrivateFile(path: string): void {
  writeFileSync(path, "", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child ready timeout: ${stdout}${stderr}`));
    }, 10_000);
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
      reject(
        new Error(
          `child exited before ready (${code}/${signal}): ${stdout}${stderr}`,
        ),
      );
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onErrorOutput);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function buildChildFixture(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "folio-lease-child-"));
  temporaryDirectories.push(directory);
  const outfile = join(directory, "child.mjs");
  const modulePath = resolvePath("src/sync/server-directory-lease.ts");
  await build({
    stdin: {
      contents: `import { acquireServerDirectoryLease } from ${JSON.stringify(modulePath)};
const lease = acquireServerDirectoryLease(process.argv[2]);
lease.assertOwned();
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);
`,
      loader: "ts",
      resolveDir: resolvePath("."),
      sourcefile: "lease-child.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("server directory lease", () => {
  it("creates a private lock file and excludes simultaneous instances", () => {
    const root = makeRoot();
    const first = acquireServerDirectoryLease(root);
    try {
      first.assertOwned();
      const stat = lstatSync(lockPath(root));
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.size).toBeLessThanOrEqual(MAX_LOCK_BYTES);

      expectBusy(() => acquireServerDirectoryLease(root));
      first.assertOwned();
    } finally {
      first.close();
    }
    first.close();

    const second = acquireServerDirectoryLease(root);
    try {
      second.assertOwned();
    } finally {
      second.close();
    }
    expect(existsSync(lockPath(root))).toBe(true);
  });

  it("rejects non-private and unsafe root or lock files without changing data", () => {
    const publicRoot = makeRoot();
    chmodSync(publicRoot, 0o755);
    expectUnsafe(() => acquireServerDirectoryLease(publicRoot));
    chmodSync(publicRoot, 0o700);

    const symlinkRootParent = makeRoot();
    const realRoot = join(symlinkRootParent, "real");
    mkdirSync(realRoot, { mode: 0o700 });
    chmodSync(realRoot, 0o700);
    const rootLink = join(symlinkRootParent, "link");
    symlinkSync(realRoot, rootLink);
    expectUnsafe(() => acquireServerDirectoryLease(rootLink));

    const symlinkLockRoot = makeRoot();
    writeFileSync(join(symlinkLockRoot, "target"), "", { mode: 0o600 });
    chmodSync(join(symlinkLockRoot, "target"), 0o600);
    symlinkSync("target", lockPath(symlinkLockRoot));
    expectUnsafe(() => acquireServerDirectoryLease(symlinkLockRoot));
    expect(lstatSync(lockPath(symlinkLockRoot)).isSymbolicLink()).toBe(true);

    const hardlinkRoot = makeRoot();
    createPrivateFile(lockPath(hardlinkRoot));
    linkSync(lockPath(hardlinkRoot), join(hardlinkRoot, "extra-link"));
    const sentinel = join(hardlinkRoot, "sentinel.txt");
    writeFileSync(sentinel, "keep", "utf8");
    expectUnsafe(() => acquireServerDirectoryLease(hardlinkRoot));
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
    expect(lstatSync(lockPath(hardlinkRoot)).nlink).toBe(2);

    const modeRoot = makeRoot();
    writeFileSync(lockPath(modeRoot), "", { mode: 0o600 });
    chmodSync(lockPath(modeRoot), 0o644);
    expectUnsafe(() => acquireServerDirectoryLease(modeRoot));

    const largeRoot = makeRoot();
    writeFileSync(lockPath(largeRoot), Buffer.alloc(MAX_LOCK_BYTES + 1), {
      mode: 0o600,
    });
    chmodSync(lockPath(largeRoot), 0o600);
    expectUnsafe(() => acquireServerDirectoryLease(largeRoot));
    expect(lstatSync(lockPath(largeRoot)).size).toBe(MAX_LOCK_BYTES + 1);
  });

  it("detects root replacement and symlink substitution", () => {
    const removedRoot = makeRoot();
    const removedLease = acquireServerDirectoryLease(removedRoot);
    const movedRoot = `${removedRoot}-moved`;
    try {
      renameSync(removedRoot, movedRoot);
      mkdirSync(removedRoot, { mode: 0o700 });
      chmodSync(removedRoot, 0o700);
      expectUnsafe(() => removedLease.assertOwned());
      removedLease.close();
      removedLease.close();
    } finally {
      if (existsSync(removedRoot)) removedLease.close();
    }

    const linkedRoot = makeRoot();
    const linkedLease = acquireServerDirectoryLease(linkedRoot);
    try {
      const real = `${linkedRoot}-real`;
      renameSync(linkedRoot, real);
      symlinkSync(real, linkedRoot);
      expectUnsafe(() => linkedLease.assertOwned());
    } finally {
      linkedLease.close();
      linkedLease.close();
    }
  });

  it("detects db swap, symlink and hardlink substitution", () => {
    const swapRoot = makeRoot();
    const swapLease = acquireServerDirectoryLease(swapRoot);
    const swapPath = lockPath(swapRoot);
    const original = join(swapRoot, "original-lock");
    try {
      renameSync(swapPath, original);
      createPrivateFile(swapPath);
      expectUnsafe(() => swapLease.assertOwned());
    } finally {
      swapLease.close();
      swapLease.close();
    }
    expect(existsSync(swapPath)).toBe(true);
    expect(lstatSync(swapPath).isFile()).toBe(true);

    const symlinkRoot = makeRoot();
    const symlinkLease = acquireServerDirectoryLease(symlinkRoot);
    const symlinkPath = lockPath(symlinkRoot);
    try {
      renameSync(symlinkPath, join(symlinkRoot, "original-lock"));
      symlinkSync("original-lock", symlinkPath);
      expectUnsafe(() => symlinkLease.assertOwned());
    } finally {
      symlinkLease.close();
    }
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

    const hardlinkRoot = makeRoot();
    const hardlinkLease = acquireServerDirectoryLease(hardlinkRoot);
    const hardlinkPath = lockPath(hardlinkRoot);
    try {
      hardlinkLease.assertOwned();
      linkSync(hardlinkPath, join(hardlinkRoot, "extra-link"));
      expectUnsafe(() => hardlinkLease.assertOwned());
    } finally {
      hardlinkLease.close();
    }
    expect(lstatSync(hardlinkPath).nlink).toBe(2);
  });

  it(
    "releases the lease after an actual node child is SIGKILLed",
    async () => {
      const root = makeRoot();
      const fixture = await buildChildFixture();
      const child = spawn(process.execPath, [fixture, root], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForReady(child);
        expectBusy(() => acquireServerDirectoryLease(root));
        child.kill("SIGKILL");
        await waitForExit(child);
        const lease = acquireServerDirectoryLease(root);
        try {
          lease.assertOwned();
        } finally {
          lease.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    },
    30_000,
  );
});
