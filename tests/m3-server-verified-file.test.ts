import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncError } from "../src/sync/protocol";
import { copyVerifiedServerFile, inspectVerifiedServerFile } from "../src/sync/server-verified-file";

const hooks = vi.hoisted(() => ({
  afterRead: null as null | ((fd: number) => void),
  writeLimit: 0,
  writeError: null as null | { code: string; after: number },
  fsyncError: null as null | Error,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const read = actual.readSync as (...args: any[]) => number;
  const write = actual.writeSync as (...args: any[]) => number;
  const fsync = actual.fsyncSync as (...args: any[]) => void;
  return {
    ...actual,
    readSync: (...args: any[]) => {
      const count = read(...args);
      if (count > 0 && hooks.afterRead) {
        const hook = hooks.afterRead;
        hooks.afterRead = null;
        hook(args[0] as number);
      }
      return count;
    },
    writeSync: (...args: any[]) => {
      if (hooks.writeError) {
        const failure = hooks.writeError;
        hooks.writeError = null;
        const partial = Math.min(Math.max(failure.after, 0), args[3] as number);
        if (partial > 0) write(args[0], args[1], args[2], partial, args[4]);
        const error = new Error("mock write failure") as NodeJS.ErrnoException;
        error.code = failure.code;
        throw error;
      }
      if (hooks.writeLimit > 0)
        return write(args[0], args[1], args[2], Math.min(args[3] as number, hooks.writeLimit), args[4]);
      return write(...args);
    },
    fsyncSync: (...args: any[]) => {
      if (hooks.fsyncError) {
        const error = hooks.fsyncError;
        hooks.fsyncError = null;
        throw error;
      }
      return fsync(...args);
    },
  };
});

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const hashOf = (value: Buffer) => ({ bytes: value.length, sha256: sha(value) });
const bytesOf = (size: number, seed = 0) => {
  const value = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) value[index] = (index * 31 + seed) % 251;
  return value;
};

function expectFailure(action: () => unknown, code: string, status: number, forbidden: string[] = []) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SyncError);
  const error = caught as SyncError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
  expect(error.message).toBe(code);
  for (const value of forbidden) expect(error.message.includes(value)).toBe(false);
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "folio-svf-")));
  chmodSync(root, 0o700);
  hooks.afterRead = null;
  hooks.writeLimit = 0;
  hooks.writeError = null;
  hooks.fsyncError = null;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(name: string, data: Buffer): string {
  const path = join(root, name);
  writeFileSync(path, data, { mode: 0o600 });
  return path;
}

describe("inspectVerifiedServerFile", () => {
  it("returns the exact hash and byte count for a large file", () => {
    const data = bytesOf(160 * 1024 + 7);
    const result = inspectVerifiedServerFile(file("large.bin", data));
    expect(result).toEqual(hashOf(data));
    expect(result.bytes).toBe(data.length);
    expect(result.sha256).toBe(sha(data));
  });

  it("accepts a matching expected hash and rejects a wrong one without paths", () => {
    const data = bytesOf(4096, 3);
    const path = file("expected.bin", data);
    expect(inspectVerifiedServerFile(path, hashOf(data))).toEqual(hashOf(data));
    expectFailure(() => inspectVerifiedServerFile(path, hashOf(bytesOf(4096, 4))), "server-file-mismatch", 422, [root, path]);
  });

  it("enforces the byte cap and integer ceiling", () => {
    const data = bytesOf(2048);
    const path = file("capped.bin", data);
    expect(inspectVerifiedServerFile(path, undefined, data.length)).toEqual(hashOf(data));
    expectFailure(() => inspectVerifiedServerFile(path, undefined, data.length - 1), "server-file-unsafe", 409, [root, path]);
    expectFailure(() => inspectVerifiedServerFile(path, undefined, -1), "server-file-unsafe", 409, [root, path]);
    expectFailure(() => inspectVerifiedServerFile(path, undefined, 256 * 1024 * 1024 + 1), "server-file-unsafe", 409, [root, path]);
  });

  it("rejects symlinks, hardlinks and FIFOs", () => {
    const target = file("target.bin", bytesOf(128));
    const symlink = join(root, "symlink.bin");
    symlinkSync(target, symlink);
    expectFailure(() => inspectVerifiedServerFile(symlink), "server-file-unsafe", 409, [root, symlink]);

    const linked = file("linked.bin", bytesOf(128));
    linkSync(linked, join(root, "hardlink.bin"));
    expectFailure(() => inspectVerifiedServerFile(join(root, "hardlink.bin")), "server-file-unsafe", 409, [root, "hardlink.bin"]);

    const fifo = join(root, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expectFailure(() => inspectVerifiedServerFile(fifo), "server-file-unsafe", 409, [root, fifo]);
  });

  it("rejects a source path swapped while it is being read", () => {
    const data = bytesOf(200 * 1024, 7);
    const path = file("swapped.bin", data);
    const moved = join(root, "moved.bin");
    hooks.afterRead = () => {
      renameSync(path, moved);
      writeFileSync(path, bytesOf(data.length, 9), { mode: 0o600 });
    };
    expectFailure(() => inspectVerifiedServerFile(path), "server-file-unsafe", 409, [root, path, moved]);
  });
});

describe("copyVerifiedServerFile", () => {
  it("copies exact bytes to a new independent inode and leaves the source unchanged", () => {
    const data = bytesOf(150 * 1024 + 3, 11);
    const source = file("source.bin", data);
    const destination = join(root, "copy.bin");
    const before = statSync(source);
    const result = copyVerifiedServerFile(source, destination, hashOf(data));
    expect(result).toEqual(hashOf(data));
    expect(readFileSync(destination).equals(data)).toBe(true);
    expect(readFileSync(source).equals(data)).toBe(true);
    const after = statSync(source);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(statSync(destination).ino).not.toBe(after.ino);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });

  it("leaves an existing destination untouched", () => {
    const data = bytesOf(1024);
    const source = file("source.bin", data);
    const destination = file("existing.bin", Buffer.from("keep me"));
    const before = statSync(destination);
    expectFailure(() => copyVerifiedServerFile(source, destination, hashOf(data)), "server-file-unsafe", 409, [root, source, destination]);
    expect(readFileSync(destination).equals(Buffer.from("keep me"))).toBe(true);
    expect(statSync(destination).ino).toBe(before.ino);
  });

  it("rejects a wrong expected hash before creating output", () => {
    const data = bytesOf(2048);
    const source = file("source.bin", data);
    const destination = join(root, "wrong.bin");
    expectFailure(() => copyVerifiedServerFile(source, destination, hashOf(bytesOf(2048, 1))), "server-file-mismatch", 422, [root, source, destination]);
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects an over-cap source without creating output", () => {
    const data = bytesOf(4096);
    const source = file("source.bin", data);
    const destination = join(root, "capped.bin");
    expectFailure(() => copyVerifiedServerFile(source, destination, hashOf(data), data.length - 1), "server-file-unsafe", 409, [root, source, destination]);
    expect(existsSync(destination)).toBe(false);
  });

  it("completes correctly when the kernel accepts partial writes", () => {
    const data = bytesOf(96 * 1024 + 5, 13);
    const source = file("source.bin", data);
    const destination = join(root, "partial-ok.bin");
    hooks.writeLimit = 7;
    expect(copyVerifiedServerFile(source, destination, hashOf(data))).toEqual(hashOf(data));
    expect(readFileSync(destination).equals(data)).toBe(true);
    expect(readFileSync(source).equals(data)).toBe(true);
  });

  it("retains a partial output and the source after ENOSPC", () => {
    const data = bytesOf(48 * 1024, 17);
    const source = file("source.bin", data);
    const destination = join(root, "enospc.bin");
    hooks.writeError = { code: "ENOSPC", after: 11 };
    expectFailure(() => copyVerifiedServerFile(source, destination, hashOf(data)), "server-file-capacity", 507, [root, source, destination]);
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination).equals(data.subarray(0, 11))).toBe(true);
    expect(readFileSync(source).equals(data)).toBe(true);
  });

  it("retains the new output and source after an fsync failure", () => {
    const data = bytesOf(32 * 1024, 19);
    const source = file("source.bin", data);
    const destination = join(root, "fsync.bin");
    hooks.fsyncError = Object.assign(new Error("mock fsync failure"), { code: "EIO" });
    expectFailure(() => copyVerifiedServerFile(source, destination, hashOf(data)), "server-file-unsafe", 409, [root, source, destination]);
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination).equals(data)).toBe(true);
    expect(readFileSync(source).equals(data)).toBe(true);
  });

  it("rejects a source path swapped during the copy read", () => {
    const data = bytesOf(200 * 1024, 21);
    const source = file("swapped.bin", data);
    const destination = join(root, "swapped-copy.bin");
    const moved = join(root, "moved.bin");
    hooks.afterRead = () => {
      renameSync(source, moved);
      writeFileSync(source, bytesOf(data.length, 23), { mode: 0o600 });
    };
    expectFailure(() => copyVerifiedServerFile(source, destination, hashOf(data)), "server-file-unsafe", 409, [root, source, destination]);
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(moved).equals(data)).toBe(true);
  });
});
