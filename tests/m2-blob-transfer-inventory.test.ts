import { execFileSync } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectBlobTransferInventory } from "../src/sync/blob-transfer-inventory";
import type { BlobTransferRecord } from "../src/sync/blob-transfer-types";
import { SyncError } from "../src/sync/protocol";

const roots: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-blob-inventory-"));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRecord(
  key: string,
  state: BlobTransferRecord["state"] = "active",
  overrides: Partial<BlobTransferRecord> = {},
): BlobTransferRecord {
  return {
    direction: "download",
    assetId: `asset-${key}`,
    sha256: "a".repeat(64),
    bytes: 1,
    key,
    scopeHash: "scope",
    partialName: `${key}.part`,
    offset: 0,
    prefixHash: "prefix",
    state,
    reason: null,
    updatedAt: 1,
    ...overrides,
  };
}

function write(directory: string, name: string, bytes: string): void {
  writeFileSync(join(directory, name), bytes);
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncError) return error.code;
    throw error;
  }
  throw new Error("expected SyncError");
}

function snapshot(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const stat = lstatSync(join(directory, name));
      const bytes = stat.isFile()
        ? readFileSync(join(directory, name)).toString("hex")
        : "";
      return `${name}:${stat.size}:${stat.mode}:${stat.ino}:${bytes}`;
    });
}

describe("inspectBlobTransferInventory", () => {
  it("classifies known transfer states and metadata", () => {
    const directory = makeDirectory();
    write(directory, "active.part", "abc");
    write(directory, "completed.part", "hello");
    write(directory, "blocked.part", "1234567");
    write(directory, "state.sqlite", "meta");
    write(directory, "state.sqlite-wal", "xx");

    const result = inspectBlobTransferInventory(directory, [
      makeRecord("active"),
      makeRecord("completed", "completed"),
      makeRecord("blocked", "blocked"),
    ]);

    expect(result.overLimit).toBe(false);
    expect(result.unsafeCount).toBe(0);
    expect(result.totalBytes).toBe(3 + 5 + 7 + 4 + 2);
    expect(result.items).toEqual([
      { name: "active.part", kind: "active", bytes: 3, key: "active" },
      { name: "blocked.part", kind: "blocked", bytes: 7, key: "blocked" },
      { name: "completed.part", kind: "completed", bytes: 5, key: "completed" },
      { name: "state.sqlite", kind: "metadata", bytes: 4 },
      { name: "state.sqlite-wal", kind: "metadata", bytes: 2 },
    ]);
  });

  it("reports unknown and legacy files as orphans without treating SQLite files as blobs", () => {
    const directory = makeDirectory();
    write(directory, "orphan.bin", "data");
    write(directory, "legacy.part", "legacy");
    write(directory, "unknown.sqlite", "meta");

    const result = inspectBlobTransferInventory(directory, []);

    expect(result.items).toEqual([
      { name: "legacy.part", kind: "orphan", bytes: 6 },
      { name: "orphan.bin", kind: "orphan", bytes: 4 },
      { name: "unknown.sqlite", kind: "orphan", bytes: 4 },
    ]);
    expect(result.totalBytes).toBe(14);
    expect(result.unsafeCount).toBe(0);
    expect(result.overLimit).toBe(false);
  });

  it("marks symlinks, FIFOs, directories and unexpected hardlinks unsafe without following targets", () => {
    const outside = makeDirectory();
    const target = join(outside, "target.bin");
    const hardTarget = join(outside, "hard-target.bin");
    write(outside, "target.bin", "secret-target");
    write(outside, "hard-target.bin", "hard-target");

    const directory = makeDirectory();
    symlinkSync(target, join(directory, "link.part"));
    execFileSync("mkfifo", [join(directory, "fifo.part")]);
    linkSync(hardTarget, join(directory, "hard.part"));
    mkdirSync(join(directory, "nested.part"));

    const result = inspectBlobTransferInventory(directory, [
      makeRecord("link"),
      makeRecord("fifo"),
      makeRecord("hard"),
    ]);

    expect(result.items).toEqual([
      { name: "fifo.part", kind: "unsafe", bytes: null, key: "fifo" },
      { name: "hard.part", kind: "unsafe", bytes: null, key: "hard" },
      { name: "link.part", kind: "unsafe", bytes: null, key: "link" },
      { name: "nested.part", kind: "unsafe", bytes: null },
    ]);
    expect(result.unsafeCount).toBe(4);
    expect(result.totalBytes).toBe(0);
    expect(result.overLimit).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("secret-target");
    expect(readFileSync(hardTarget, "utf8")).toBe("hard-target");
  });

  it("reports entry and byte quota overflows without unbounded traversal", () => {
    const directory = makeDirectory();
    for (let index = 0; index < 4; index++)
      write(directory, `file-${index}.bin`, "x");

    const byCount = inspectBlobTransferInventory(directory, [], {
      maxEntries: 3,
    });
    expect(byCount.overLimit).toBe(true);
    expect(byCount.items).toHaveLength(3);
    expect(byCount.totalBytes).toBe(3);

    const byBytes = inspectBlobTransferInventory(directory, [], {
      maxEntries: 10,
      maxBytes: 2,
    });
    expect(byBytes.overLimit).toBe(true);
    expect(byBytes.items).toHaveLength(4);
    expect(byBytes.totalBytes).toBe(4);
  });

  it("unknown SQLite names cannot bypass the data entry limit", () => {
    const directory = makeDirectory();
    for (let index = 0; index < 17; index++)
      write(directory, `m${index}.sqlite`, "x");

    const result = inspectBlobTransferInventory(directory, [], {
      maxEntries: 4,
    });

    expect(result.overLimit).toBe(true);
    expect(result.items).toHaveLength(4);
    expect(result.items.every((item) => item.kind === "orphan")).toBe(true);
    expect(result.totalBytes).toBe(4);
  });

  it("leaves every source byte and entry unchanged", () => {
    const directory = makeDirectory();
    write(directory, "known.part", "known-bytes");
    write(directory, "orphan.part", "orphan-bytes");
    write(directory, "state.sqlite", "database");
    const before = snapshot(directory);

    inspectBlobTransferInventory(directory, [makeRecord("known")]);
    expect(snapshot(directory)).toEqual(before);
  });

  it("rejects invalid roots with a fixed SyncError code", () => {
    const missing = join(makeDirectory(), "missing");
    expect(errorCode(() => inspectBlobTransferInventory(missing, []))).toBe(
      "invalid-blob-transfer-root",
    );

    const fileRoot = join(makeDirectory(), "file");
    writeFileSync(fileRoot, "x");
    expect(errorCode(() => inspectBlobTransferInventory(fileRoot, []))).toBe(
      "invalid-blob-transfer-root",
    );

    const realDirectory = makeDirectory();
    const linkRoot = join(makeDirectory(), "link");
    symlinkSync(realDirectory, linkRoot);
    expect(errorCode(() => inspectBlobTransferInventory(linkRoot, []))).toBe(
      "invalid-blob-transfer-root",
    );
  });

  it("rejects invalid and ambiguous records with fixed SyncError codes", () => {
    const directory = makeDirectory();

    for (const key of [
      "",
      ".",
      "..",
      "a/b",
      "a\\b",
      "x\u0000y",
      "a".repeat(252),
    ])
      expect(
        errorCode(() =>
          inspectBlobTransferInventory(directory, [makeRecord(key)]),
        ),
      ).toBe("invalid-blob-transfer-record");

    expect(
      errorCode(() =>
        inspectBlobTransferInventory(directory, [
          makeRecord("k", "active", {
            state: "unknown" as BlobTransferRecord["state"],
          }),
        ]),
      ),
    ).toBe("invalid-blob-transfer-record");

    const duplicated = makeRecord("k");
    expect(
      errorCode(() =>
        inspectBlobTransferInventory(directory, [duplicated, duplicated]),
      ),
    ).toBe("duplicate-blob-transfer-record");

    expect(
      errorCode(() =>
        inspectBlobTransferInventory(directory, [
          makeRecord("k", "active"),
          makeRecord("k", "blocked"),
        ]),
      ),
    ).toBe("conflicting-blob-transfer-record");

    expect(
      errorCode(() =>
        inspectBlobTransferInventory(
          directory,
          null as unknown as readonly BlobTransferRecord[],
        ),
      ),
    ).toBe("invalid-blob-transfer-records");

    expect(
      errorCode(() =>
        inspectBlobTransferInventory(directory, [], { maxEntries: -1 }),
      ),
    ).toBe("invalid-blob-transfer-limits");
    expect(
      errorCode(() =>
        inspectBlobTransferInventory(directory, [], { maxBytes: 1.5 }),
      ),
    ).toBe("invalid-blob-transfer-limits");
  });
});
