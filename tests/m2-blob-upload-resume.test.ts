import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectBlobUploadPartial,
  withBlobUploadLock,
} from "../src/sync/blob-upload-resume";
import { SyncError } from "../src/sync/protocol";

const cleanup: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-upload-"));
  cleanup.push(directory);
  return directory;
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectSyncError(
  operation: () => unknown,
  code: string,
  status: number,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    const syncError = error as SyncError;
    expect(syncError.code).toBe(code);
    expect(syncError.status).toBe(status);
    return;
  }
  throw new Error(`expected SyncError ${code}`);
}

async function expectSyncErrorAsync(
  operation: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    const syncError = error as SyncError;
    expect(syncError.code).toBe(code);
    expect(syncError.status).toBe(status);
    return;
  }
  throw new Error(`expected SyncError ${code}`);
}

afterEach(() => {
  while (cleanup.length) {
    const path = cleanup.pop()!;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }
});

describe("inspectBlobUploadPartial", () => {
  it("returns null for a missing partial without creating anything", () => {
    const directory = makeDirectory();
    const sha256 = hash("missing");
    expect(
      inspectBlobUploadPartial(directory, sha256, 64),
    ).toBeNull();
    expect(lstatSync(directory).isDirectory()).toBe(true);
  });

  it("reports exact prefix bytes and hash without changing the file", () => {
    const directory = makeDirectory();
    const data = Buffer.from("0123456789abcdef");
    const sha256 = hash(data);
    const partial = join(directory, `.partial-${sha256}`);
    writeFileSync(partial, data.subarray(0, 5));

    expect(inspectBlobUploadPartial(directory, sha256, data.length)).toEqual({
      received: 5,
      prefixHash: hash(data.subarray(0, 5)),
    });
    expect(readFileSync(partial)).toEqual(data.subarray(0, 5));

    writeFileSync(partial, data);
    expect(inspectBlobUploadPartial(directory, sha256, data.length)).toEqual({
      received: data.length,
      prefixHash: sha256,
    });
    expect(readFileSync(partial)).toEqual(data);
  });

  it("scopes the fixed partial name to the given directory", () => {
    const first = makeDirectory();
    const second = makeDirectory();
    const sha256 = hash("scoped");
    writeFileSync(join(first, `.partial-${sha256}`), "first");
    writeFileSync(join(second, `.partial-${sha256}`), "second");

    expect(inspectBlobUploadPartial(first, sha256, 20)).toEqual({
      received: 5,
      prefixHash: hash("first"),
    });
    expect(inspectBlobUploadPartial(second, sha256, 20)).toEqual({
      received: 6,
      prefixHash: hash("second"),
    });
  });

  it("allows an empty partial only for an empty expectation", () => {
    const directory = makeDirectory();
    const sha256 = hash("empty");
    const partial = join(directory, `.partial-${sha256}`);
    writeFileSync(partial, Buffer.alloc(0));

    expect(inspectBlobUploadPartial(directory, sha256, 0)).toEqual({
      received: 0,
      prefixHash: hash(Buffer.alloc(0)),
    });
    writeFileSync(partial, "x");
    expectSyncError(
      () => inspectBlobUploadPartial(directory, sha256, 0),
      "blob-size-mismatch",
      422,
    );
    expect(readFileSync(partial, "utf8")).toBe("x");
  });

  it("rejects malformed hashes", () => {
    const directory = makeDirectory();
    for (const sha256 of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(64) + "0",
    ]) {
      expectSyncError(
        () => inspectBlobUploadPartial(directory, sha256, 1),
        "invalid-hash",
        400,
      );
    }
  });

  it("rejects unsafe or out-of-range expected byte counts", () => {
    const directory = makeDirectory();
    const sha256 = hash("size");
    for (const expected of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      20_000_001,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expectSyncError(
        () => inspectBlobUploadPartial(directory, sha256, expected),
        "invalid-asset-size",
        400,
      );
    }
    expect(inspectBlobUploadPartial(directory, sha256, 20_000_000)).toBeNull();
  });

  it("refuses a symlinked partial and preserves its target", () => {
    const directory = makeDirectory();
    const sha256 = hash("symlink");
    const target = join(directory, "target.bin");
    const partial = join(directory, `.partial-${sha256}`);
    writeFileSync(target, "preserve me");
    symlinkSync(target, partial);

    expectSyncError(
      () => inspectBlobUploadPartial(directory, sha256, 100),
      "unsafe-blob-path",
      409,
    );
    expect(readFileSync(target, "utf8")).toBe("preserve me");
    expect(lstatSync(partial).isSymbolicLink()).toBe(true);
  });

  it("refuses a FIFO partial without opening it", () => {
    const directory = makeDirectory();
    const sha256 = hash("fifo");
    const partial = join(directory, `.partial-${sha256}`);
    execFileSync("mkfifo", [partial]);

    expectSyncError(
      () => inspectBlobUploadPartial(directory, sha256, 100),
      "unsafe-blob-path",
      409,
    );
    expect(lstatSync(partial).isFIFO()).toBe(true);
  });

  it("refuses a hardlinked partial and preserves both names", () => {
    const directory = makeDirectory();
    const sha256 = hash("hardlink");
    const partial = join(directory, `.partial-${sha256}`);
    const other = join(directory, "other.bin");
    writeFileSync(partial, "linked bytes");
    linkSync(partial, other);

    expectSyncError(
      () => inspectBlobUploadPartial(directory, sha256, 100),
      "unsafe-blob-path",
      409,
    );
    expect(readFileSync(partial, "utf8")).toBe("linked bytes");
    expect(readFileSync(other, "utf8")).toBe("linked bytes");
    expect(lstatSync(partial).nlink).toBe(2);
  });

  it("refuses an oversized partial without truncating it", () => {
    const directory = makeDirectory();
    const sha256 = hash("oversize");
    const partial = join(directory, `.partial-${sha256}`);
    const data = Buffer.alloc(11, 7);
    writeFileSync(partial, data);

    expectSyncError(
      () => inspectBlobUploadPartial(directory, sha256, 10),
      "blob-size-mismatch",
      422,
    );
    expect(statSync(partial).size).toBe(11);
    expect(readFileSync(partial)).toEqual(data);
  });
});

describe("withBlobUploadLock", () => {
  it("serializes concurrent work and releases after success", async () => {
    const directory = makeDirectory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first = withBlobUploadLock(directory, async () => {
      entered();
      await gate;
      return "first";
    });
    await started;

    await expectSyncErrorAsync(
      withBlobUploadLock(directory, async () => "second"),
      "blob-upload-in-progress",
      409,
    );

    release();
    await expect(first).resolves.toBe("first");
    await expect(
      withBlobUploadLock(directory, async () => "third"),
    ).resolves.toBe("third");
  });

  it("releases the lock when work throws", async () => {
    const directory = makeDirectory();
    await expect(
      withBlobUploadLock(directory, async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    await expect(
      withBlobUploadLock(directory, async () => "after failure"),
    ).resolves.toBe("after failure");
  });

  it("uses a private SQLite file and leaves existing files untouched", async () => {
    const directory = makeDirectory();
    const existing = join(directory, "workspace.sqlite");
    writeFileSync(existing, "application schema");

    await expect(
      withBlobUploadLock(directory, async () => "done"),
    ).resolves.toBe("done");

    expect(readFileSync(existing, "utf8")).toBe("application schema");
    const lock = lstatSync(join(directory, ".folio-upload-lock.sqlite"));
    expect(lock.isFile()).toBe(true);
    expect(lock.nlink).toBe(1);
  });

  it("rejects an externally held SQLite lock", async () => {
    const directory = makeDirectory();
    const lockPath = join(directory, ".folio-upload-lock.sqlite");
    const external = new DatabaseSync(lockPath);
    external.exec("PRAGMA busy_timeout = 0");
    external.exec("BEGIN EXCLUSIVE");
    try {
      await expectSyncErrorAsync(
        withBlobUploadLock(directory, async () => "blocked"),
        "blob-upload-in-progress",
        409,
      );
    } finally {
      external.exec("COMMIT");
      external.close();
    }
    await expect(
      withBlobUploadLock(directory, async () => "available"),
    ).resolves.toBe("available");
  });

  it("refuses unsafe lock files without touching them", async () => {
    const symlinkDirectory = makeDirectory();
    const symlinkTarget = join(symlinkDirectory, "target");
    const symlinkLock = join(symlinkDirectory, ".folio-upload-lock.sqlite");
    writeFileSync(symlinkTarget, "sentinel");
    symlinkSync(symlinkTarget, symlinkLock);
    await expectSyncErrorAsync(
      withBlobUploadLock(symlinkDirectory, async () => "unsafe"),
      "unsafe-blob-path",
      409,
    );
    expect(readFileSync(symlinkTarget, "utf8")).toBe("sentinel");

    const hardlinkDirectory = makeDirectory();
    const hardlinkOther = join(hardlinkDirectory, "other");
    const hardlinkLock = join(
      hardlinkDirectory,
      ".folio-upload-lock.sqlite",
    );
    writeFileSync(hardlinkOther, "linked");
    linkSync(hardlinkOther, hardlinkLock);
    await expectSyncErrorAsync(
      withBlobUploadLock(hardlinkDirectory, async () => "unsafe"),
      "unsafe-blob-path",
      409,
    );
    expect(readFileSync(hardlinkOther, "utf8")).toBe("linked");
    expect(lstatSync(hardlinkLock).nlink).toBe(2);

    const directoryLockDirectory = makeDirectory();
    mkdirSync(join(directoryLockDirectory, ".folio-upload-lock.sqlite"));
    await expectSyncErrorAsync(
      withBlobUploadLock(directoryLockDirectory, async () => "unsafe"),
      "unsafe-blob-path",
      409,
    );
  });

  it("refuses symlinked and non-directory workspace roots", async () => {
    const directory = makeDirectory();
    const link = directory + "-link";
    cleanup.push(link);
    symlinkSync(directory, link, "dir");
    await expectSyncErrorAsync(
      withBlobUploadLock(link, async () => "unsafe"),
      "unsafe-directory",
      409,
    );

    const file = join(directory, "not-a-directory");
    writeFileSync(file, "x");
    await expectSyncErrorAsync(
      withBlobUploadLock(file, async () => "unsafe"),
      "unsafe-directory",
      409,
    );
  });

  it("refuses a workspace root replaced while work is running", async () => {
    const directory = makeDirectory();
    const moved = directory + "-moved";
    cleanup.push(moved);

    await expectSyncErrorAsync(
      withBlobUploadLock(directory, async () => {
        renameSync(directory, moved);
        mkdirSync(directory, { mode: 0o700 });
        return "changed";
      }),
      "unsafe-directory",
      409,
    );
    expect(lstatSync(join(moved, ".folio-upload-lock.sqlite")).isFile()).toBe(
      true,
    );
  });

  it("releases the OS lock when a child process is killed", async () => {
    const directory = makeDirectory();
    const lockPath = join(directory, ".folio-upload-lock.sqlite");
    const script = `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(${JSON.stringify(lockPath)});
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN EXCLUSIVE");
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `;
    let child: ChildProcess | undefined;
    try {
      child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error("lock holder timeout")),
          5_000,
        );
        child!.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("locked\n")) {
            clearTimeout(timeout);
            resolveReady();
          }
        });
        child!.once("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        child!.once("exit", (code) => {
          if (!output.includes("locked\n")) {
            clearTimeout(timeout);
            rejectReady(new Error(`lock holder exited early: ${code}`));
          }
        });
      });

      await expectSyncErrorAsync(
        withBlobUploadLock(directory, async () => "blocked"),
        "blob-upload-in-progress",
        409,
      );

      child.kill("SIGKILL");
      await once(child, "exit");
      child = undefined;

      await expect(
        withBlobUploadLock(directory, async () => "released"),
      ).resolves.toBe("released");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  }, 15_000);
});
