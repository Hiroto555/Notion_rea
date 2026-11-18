import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertServerBlobAdmission,
  inspectServerBlobRetention,
} from "../src/sync/server-blob-retention";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const roots: string[] = [];

function tempDirectory(prefix = "folio-blob-retention-"): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), prefix)),
  );
  roots.push(root);
  return root;
}

function privateRoot(): string {
  const root = tempDirectory();
  chmodSync(root, 0o700);
  return root;
}

function workspace(root: string, name = HASH_A): string {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function writeBytes(path: string, bytes: number): void {
  writeFileSync(path, Buffer.alloc(bytes, 0x61), { mode: 0o600 });
}

function unknown(call: () => unknown): void {
  expect(call).toThrowError("server-blob-retention-unknown");
}

function held(call: () => unknown): void {
  expect(call).toThrowError("server-blob-retention-held");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("inspectServerBlobRetention", () => {
  it("returns zero for a missing root without creating it", () => {
    const parent = tempDirectory();
    const missing = join(parent, "server-blobs");
    expect(inspectServerBlobRetention(missing)).toEqual({
      bytes: 0,
      entries: 0,
      held: false,
    });
    expect(existsSync(missing)).toBe(false);
  });

  it("counts root metadata, blobs, partials, and unknown regular names", () => {
    const root = privateRoot();
    writeBytes(join(root, "server.sqlite"), 10);
    writeBytes(join(root, "server.sqlite-wal"), 3);
    const directory = workspace(root);
    writeBytes(join(directory, HASH_B), 100);
    writeBytes(join(directory, `.partial-${HASH_C}`), 20);
    writeBytes(join(directory, "legacy-notes.txt"), 5);
    expect(inspectServerBlobRetention(root)).toEqual({
      bytes: 138,
      entries: 2,
      held: false,
    });
  });

  it("counts legacy SQLite metadata files", () => {
    const root = privateRoot();
    for (const [name, bytes] of [
      ["server.sqlite", 7],
      ["server.sqlite-wal", 11],
      ["server.sqlite-shm", 13],
      ["server.sqlite-journal", 17],
    ] as const)
      writeBytes(join(root, name), bytes);
    const directory = workspace(root);
    writeBytes(join(directory, HASH_B), 50);
    expect(inspectServerBlobRetention(root)).toEqual({
      bytes: 98,
      entries: 1,
      held: false,
    });
  });

  it("counts an in-progress partial as one entry", () => {
    const root = privateRoot();
    const directory = workspace(root);
    writeBytes(join(directory, `.partial-${HASH_B}`), 40);
    expect(inspectServerBlobRetention(root)).toEqual({
      bytes: 40,
      entries: 1,
      held: false,
    });
  });

  it("uses logical size for sparse files", () => {
    const root = privateRoot();
    const directory = workspace(root);
    const path = join(directory, HASH_B);
    const descriptor = openSync(path, "w", 0o600);
    try {
      ftruncateSync(descriptor, 4 * 1024 * 1024 + 123);
    } finally {
      closeSync(descriptor);
    }
    expect(inspectServerBlobRetention(root)).toEqual({
      bytes: 4 * 1024 * 1024 + 123,
      entries: 1,
      held: false,
    });
  });

  it("counts hard links conservatively and never removes them", () => {
    const root = privateRoot();
    const first = workspace(root, HASH_A);
    const second = workspace(root, HASH_B);
    const blob = join(first, HASH_C);
    writeBytes(blob, 64);
    const link = join(second, "d".repeat(64));
    linkSync(blob, link);
    expect(statSync(blob).nlink).toBe(2);
    expect(inspectServerBlobRetention(root)).toEqual({
      bytes: 128,
      entries: 2,
      held: false,
    });
    expect(existsSync(blob)).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it("holds when bytes exceed the lower byte limit", () => {
    const root = privateRoot();
    const directory = workspace(root);
    writeBytes(join(directory, HASH_B), 100);
    expect(
      inspectServerBlobRetention(root, { maxBytes: 99 }),
    ).toEqual({ bytes: 100, entries: 1, held: true });
    expect(
      inspectServerBlobRetention(root, { maxBytes: 100 }),
    ).toEqual({ bytes: 100, entries: 1, held: false });
  });

  it("holds when entries exceed the lower entry limit", () => {
    const root = privateRoot();
    const directory = workspace(root);
    writeBytes(join(directory, HASH_A), 10);
    writeBytes(join(directory, HASH_B), 20);
    writeBytes(join(directory, `.partial-${HASH_C}`), 30);
    expect(
      inspectServerBlobRetention(root, { maxEntries: 2 }),
    ).toEqual({ bytes: 60, entries: 3, held: true });
    expect(
      inspectServerBlobRetention(root, { maxEntries: 3 }),
    ).toEqual({ bytes: 60, entries: 3, held: false });
  });

  it("rejects unknown directories, depth, symlinks, and FIFOs", () => {
    const root = privateRoot();
    mkdirSync(join(root, "not-a-workspace-hash"), { mode: 0o700 });
    unknown(() => inspectServerBlobRetention(root));

    const deeper = privateRoot();
    mkdirSync(join(workspace(deeper), "nested"), { mode: 0o700 });
    unknown(() => inspectServerBlobRetention(deeper));

    const linked = privateRoot();
    const outside = tempDirectory("folio-blob-retention-outside-");
    const target = join(outside, "target.bin");
    writeBytes(target, 12);
    symlinkSync(target, join(workspace(linked), HASH_B));
    unknown(() => inspectServerBlobRetention(linked));
    expect(statSync(target).size).toBe(12);

    const fifo = privateRoot();
    execFileSync("mkfifo", [join(workspace(fifo), HASH_B)]);
    unknown(() => inspectServerBlobRetention(fifo));
  });

  it("rejects non-canonical, non-private, non-directory, and symlink roots", () => {
    const nonCanonical = tempDirectory();
    const linkPath = join(nonCanonical, "link");
    const canonical = privateRoot();
    symlinkSync(canonical, linkPath);
    unknown(() => inspectServerBlobRetention(linkPath));

    const publicRoot = privateRoot();
    chmodSync(publicRoot, 0o755);
    unknown(() => inspectServerBlobRetention(publicRoot));

    const fileRoot = tempDirectory();
    const file = join(fileRoot, "root-file");
    writeBytes(file, 1);
    unknown(() => inspectServerBlobRetention(file));

    const missing = join(privateRoot(), "absent");
    expect(
      inspectServerBlobRetention(missing, undefined),
    ).toEqual({ bytes: 0, entries: 0, held: false });
  });

  it("does not create a root or modify files outside it", () => {
    const parent = tempDirectory();
    const root = join(parent, "server-blobs");
    const outside = join(parent, "outside.txt");
    writeFileSync(outside, "outside", { mode: 0o600 });
    const before = statSync(outside);
    expect(inspectServerBlobRetention(root)).toEqual({
      bytes: 0,
      entries: 0,
      held: false,
    });
    expect(existsSync(root)).toBe(false);
    const after = statSync(outside);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects limits above the defaults and invalid limits", () => {
    const root = privateRoot();
    for (const limits of [
      { maxBytes: 256 * 1024 * 1024 + 1 },
      { maxEntries: 4097 },
      { maxBytes: -1 },
      { maxEntries: -1 },
      { maxBytes: 1.5 },
      { maxEntries: Number.NaN },
    ])
      unknown(() => inspectServerBlobRetention(root, limits));
  });
});

describe("assertServerBlobAdmission", () => {
  it("admits only when projected bytes and entries plus one fit", () => {
    const root = privateRoot();
    const directory = workspace(root);
    writeBytes(join(directory, HASH_A), 90);
    expect(() =>
      assertServerBlobAdmission(root, 10, {
        maxBytes: 100,
        maxEntries: 2,
      }),
    ).not.toThrow();
    held(() =>
      assertServerBlobAdmission(root, 11, {
        maxBytes: 100,
        maxEntries: 2,
      }),
    );
    held(() =>
      assertServerBlobAdmission(root, 0, {
        maxBytes: 100,
        maxEntries: 1,
      }),
    );
    expect(() =>
      assertServerBlobAdmission(root, 0, {
        maxBytes: 100,
        maxEntries: 2,
      }),
    ).not.toThrow();
  });

  it("keeps conservative entry headroom for an existing partial", () => {
    const root = privateRoot();
    const directory = workspace(root);
    writeBytes(join(directory, `.partial-${HASH_B}`), 40);
    expect(() =>
      assertServerBlobAdmission(root, 0, {
        maxBytes: 100,
        maxEntries: 2,
      }),
    ).not.toThrow();
    held(() =>
      assertServerBlobAdmission(root, 0, {
        maxBytes: 100,
        maxEntries: 1,
      }),
    );
  });

  it("admits a missing root but rejects an oversized first write", () => {
    const parent = tempDirectory();
    const root = join(parent, "server-blobs");
    expect(() =>
      assertServerBlobAdmission(root, 10, {
        maxBytes: 10,
        maxEntries: 1,
      }),
    ).not.toThrow();
    held(() =>
      assertServerBlobAdmission(root, 11, {
        maxBytes: 10,
        maxEntries: 1,
      }),
    );
    expect(existsSync(root)).toBe(false);
  });

  it("propagates unknown structural state and invalid arguments", () => {
    const root = privateRoot();
    mkdirSync(join(root, "not-a-workspace-hash"), { mode: 0o700 });
    unknown(() => assertServerBlobAdmission(root, 0));
    unknown(() => assertServerBlobAdmission(root, -1));
    unknown(() => assertServerBlobAdmission(root, Number.NaN));
    unknown(() =>
      assertServerBlobAdmission(root, 0, {
        maxBytes: 256 * 1024 * 1024 + 1,
      }),
    );
  });

  it("never writes to the root during inspection", () => {
    const root = privateRoot();
    const directory = workspace(root);
    writeBytes(join(directory, HASH_A), 10);
    const before = statSync(directory).mtimeMs;
    assertServerBlobAdmission(root, 10, { maxBytes: 100, maxEntries: 2 });
    expect(statSync(directory).mtimeMs).toBe(before);
    expect(existsSync(join(directory, HASH_A))).toBe(true);
  });
});
