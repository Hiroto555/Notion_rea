import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointBlobTransferPartial,
  closeBlobTransferPartial,
  openBlobTransferPartial,
  reconcilePublishedPartial,
} from "../src/sync/blob-transfer-partial";
import { SyncError } from "../src/sync/protocol";
import type { BlobTransferRecord } from "../src/sync/blob-transfer-types";
import { afterEach, expect, test, vi } from "vitest";

const fsProbe = vi.hoisted(() => ({ events: [] as string[], openFailure: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (fsProbe.openFailure && String(args[0]).endsWith(".part"))
        throw Object.assign(new Error("injected open failure"), {
          code: fsProbe.openFailure,
        });
      return actual.openSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      fsProbe.events.push(`fsync:${String(args[0])}`);
      return actual.fsyncSync(...args);
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      fsProbe.events.push("read");
      return actual.readSync(...args);
    },
  };
});

const directories: string[] = [];

function sha(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function tempDir() {
  const value = fs.mkdtempSync(join(tmpdir(), "folio-partial-"));
  directories.push(value);
  return value;
}

function contentOf(length: number, seed = 1) {
  const value = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    value[index] = (index * 31 + seed) % 251;
  }
  return value;
}

function recordFor(
  content: Buffer,
  offset: number,
  overrides: Partial<BlobTransferRecord> = {},
): BlobTransferRecord {
  const key = sha("partial-key");
  return {
    direction: "download",
    assetId: "asset-1",
    sha256: sha(content),
    bytes: content.length,
    key,
    scopeHash: sha("scope"),
    partialName: `${key}.part`,
    offset,
    prefixHash: sha(content.subarray(0, offset)),
    state: "active",
    reason: null,
    updatedAt: 1,
    ...overrides,
  };
}

function partialPath(root: string, record: BlobTransferRecord) {
  return join(root, record.partialName);
}

afterEach(() => {
  fsProbe.openFailure = "";
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("temporary descriptor exhaustion remains retryable and preserves the prefix", () => {
  const root = tempDir(),
    content = contentOf(100),
    record = recordFor(content, 50);
  const path = partialPath(root, record);
  fs.writeFileSync(path, content.subarray(0, 50));
  fsProbe.openFailure = "EMFILE";
  expect(() => openBlobTransferPartial(root, record)).toThrow(
    expect.objectContaining({
      code: "blob-transfer-open-failed",
      status: 503,
    }),
  );
  fsProbe.openFailure = "";
  expect(fs.readFileSync(path)).toEqual(content.subarray(0, 50));
  const part = openBlobTransferPartial(root, record);
  expect(part.offset).toBe(50);
  closeBlobTransferPartial(part);
});

test("a removed cache root yields a typed safety hold without changing the open inode", () => {
  const root = tempDir(),
    content = contentOf(100),
    record = recordFor(content, 50);
  const path = partialPath(root, record);
  fs.writeFileSync(path, content.subarray(0, 50));
  const part = openBlobTransferPartial(root, record);
  try {
    fs.unlinkSync(path);
    fs.rmdirSync(root);
    expect(() => checkpointBlobTransferPartial(part, 50)).toThrow(
      expect.objectContaining({
        code: "blob-transfer-partial-changed",
      }),
    );
    expect(fs.readFileSync(part.descriptor)).toEqual(content.subarray(0, 50));
  } finally {
    closeBlobTransferPartial(part);
  }
});

test("prefix-verified resume rewinds an uncommitted tail", () => {
  const root = tempDir();
  const content = contentOf(200);
  const record = recordFor(content, 100);
  const path = partialPath(root, record);
  fs.writeFileSync(path, content.subarray(0, 150));

  const part = openBlobTransferPartial(root, record);
  try {
    expect(part.offset).toBe(100);
    expect(fs.statSync(path).size).toBe(100);
    expect(fs.readFileSync(path)).toEqual(content.subarray(0, 100));
  } finally {
    closeBlobTransferPartial(part);
  }
});

test("a shorter part is rejected without truncation or removal", () => {
  const root = tempDir();
  const content = contentOf(200);
  const record = recordFor(content, 100);
  const path = partialPath(root, record);
  const short = content.subarray(0, 50);
  fs.writeFileSync(path, short);

  expect(() => openBlobTransferPartial(root, record)).toThrow(SyncError);
  expect(fs.readFileSync(path)).toEqual(short);
});

test("a modified part is rejected and preserved", () => {
  const root = tempDir();
  const content = contentOf(200);
  const record = recordFor(content, 100);
  const path = partialPath(root, record);
  const modified = Buffer.from(content.subarray(0, 100));
  modified[50] ^= 0xff;
  fs.writeFileSync(path, modified);

  expect(() => openBlobTransferPartial(root, record)).toThrow(SyncError);
  expect(fs.readFileSync(path)).toEqual(modified);
});

test("a symlink partial is rejected", () => {
  const root = tempDir();
  const content = contentOf(32);
  const record = recordFor(content, 0);
  const path = partialPath(root, record);
  const real = join(root, "real.bin");
  fs.writeFileSync(real, content);
  fs.symlinkSync(real, path);

  expect(() => openBlobTransferPartial(root, record)).toThrow(SyncError);
  expect(fs.readFileSync(real)).toEqual(content);
});

test("a FIFO partial is rejected", () => {
  const root = tempDir();
  const content = contentOf(32);
  const record = recordFor(content, 0);
  const path = partialPath(root, record);
  const made = spawnSync("mkfifo", [path]);
  expect(made.status).toBe(0);

  expect(() => openBlobTransferPartial(root, record)).toThrow(SyncError);
});

test("an unexpected hardlink is rejected", () => {
  const root = tempDir();
  const content = contentOf(200);
  const record = recordFor(content, 100);
  const path = partialPath(root, record);
  const payload = content.subarray(0, 100);
  fs.writeFileSync(path, payload);
  const link = join(root, "extra-link.bin");
  fs.linkSync(path, link);

  expect(() => openBlobTransferPartial(root, record)).toThrow(SyncError);
  expect(fs.readFileSync(path)).toEqual(payload);
  expect(fs.readFileSync(link)).toEqual(payload);
});

test("a swapped partial path is refused at checkpoint", () => {
  const root = tempDir();
  const content = contentOf(200);
  const record = recordFor(content, 100);
  const path = partialPath(root, record);
  fs.writeFileSync(path, content.subarray(0, 150));
  const part = openBlobTransferPartial(root, record);
  try {
    const moved = join(root, "moved.part");
    fs.renameSync(path, moved);
    const replacement = content.subarray(0, 100);
    fs.writeFileSync(path, replacement);

    expect(() => checkpointBlobTransferPartial(part, 100)).toThrow(SyncError);
    expect(part.offset).toBe(100);
    expect(fs.readFileSync(path)).toEqual(replacement);
    expect(fs.readFileSync(moved)).toEqual(replacement);
  } finally {
    closeBlobTransferPartial(part);
  }
});

test("a swapped transfer root is refused at checkpoint", () => {
  const root = tempDir();
  const content = contentOf(200);
  const record = recordFor(content, 100);
  const path = partialPath(root, record);
  fs.writeFileSync(path, content.subarray(0, 100));
  const part = openBlobTransferPartial(root, record);
  try {
    const moved = `${root}-moved`;
    directories.push(moved);
    fs.renameSync(root, moved);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.renameSync(
      join(moved, record.partialName),
      join(root, record.partialName),
    );

    expect(() => checkpointBlobTransferPartial(part, 100)).toThrow(SyncError);
    expect(fs.readFileSync(join(root, record.partialName))).toEqual(
      content.subarray(0, 100),
    );
  } finally {
    closeBlobTransferPartial(part);
  }
});

test("hardlinked completed target reconciliation never changes the target", () => {
  const root = tempDir();
  const targets = tempDir();
  const content = contentOf(160);
  const record = recordFor(content, content.length, { state: "completed" });
  const target = join(targets, "final.bin");
  const path = partialPath(root, record);
  fs.writeFileSync(target, content);
  fs.linkSync(target, path);
  const before = fs.statSync(target);

  reconcilePublishedPartial(root, record, target);

  const after = fs.statSync(target);
  expect(fs.existsSync(path)).toBe(false);
  expect(after.ino).toBe(before.ino);
  expect(after.dev).toBe(before.dev);
  expect(after.nlink).toBe(1);
  expect(fs.readFileSync(target)).toEqual(content);
});

test("a missing part lets a verified completion stand", () => {
  const root = tempDir();
  const targets = tempDir();
  const content = contentOf(80);
  const record = recordFor(content, content.length, { state: "completed" });
  const target = join(targets, "final.bin");
  fs.writeFileSync(target, content);

  expect(() => reconcilePublishedPartial(root, record, target)).not.toThrow();
  expect(fs.readFileSync(target)).toEqual(content);
});

test("a wrong target hash is rejected and the part is preserved", () => {
  const root = tempDir();
  const targets = tempDir();
  const content = contentOf(80);
  const record = recordFor(content, content.length, { state: "completed" });
  const wrong = Buffer.from(content);
  wrong[0] ^= 0xff;
  const target = join(targets, "final.bin");
  fs.writeFileSync(target, wrong);
  const path = partialPath(root, record);
  fs.writeFileSync(path, content);

  expect(() => reconcilePublishedPartial(root, record, target)).toThrow(
    SyncError,
  );
  expect(fs.readFileSync(path)).toEqual(content);
  expect(fs.readFileSync(target)).toEqual(wrong);
});

test("checkpoint fsyncs the part and directory before hashing", () => {
  const root = tempDir();
  const content = contentOf(64);
  const record = recordFor(content, content.length);
  const path = partialPath(root, record);
  fs.writeFileSync(path, content);
  const part = openBlobTransferPartial(root, record);
  try {
    fsProbe.events.length = 0;
    const digest = checkpointBlobTransferPartial(part, content.length);
    const events = fsProbe.events;
    expect(digest).toBe(record.sha256);
    expect(events[0]).toBe(`fsync:${part.descriptor}`);
    const firstRead = events.indexOf("read");
    const lastFsync = events.reduce(
      (last: number, event: string, index: number) =>
        event.startsWith("fsync:") ? index : last,
      -1,
    );
    expect(firstRead).toBeGreaterThan(lastFsync);
    expect(events.filter((event) => event === "read").length).toBeGreaterThan(
      0,
    );
  } finally {
    closeBlobTransferPartial(part);
  }
});
