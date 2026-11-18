import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertBackupRetention,
  inspectBackupRetention,
} from "../src/sync/backup-retention";
import { SyncError } from "../src/sync/protocol";

const MIB = 1024 * 1024;
const UNKNOWN_CODE = "sync-backup-retention-unknown";

let workspace: string;
const temporaryDirectories: string[] = [];

function backups(): string {
  return join(workspace, "backups");
}

function generation(name: string): string {
  const path = join(backups(), name);
  mkdirSync(path, { recursive: true });
  return path;
}

function fileWithBytes(path: string, bytes: number): void {
  writeFileSync(path, Buffer.alloc(bytes, 7));
}

function expectUnknown(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe(UNKNOWN_CODE);
    expect((error as SyncError).status).toBe(409);
    return;
  }
  throw new Error("expected " + UNKNOWN_CODE);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "folio-backup-retention-"));
  temporaryDirectories.push(workspace);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("inspectBackupRetention", () => {
  it("returns zero for a missing backups root without creating it", () => {
    expect(inspectBackupRetention(workspace)).toEqual({
      generations: 0,
      bytes: 0,
      held: false,
    });
    expect(existsSync(backups())).toBe(false);
  });

  it("does not modify the workspace when the root is missing", () => {
    writeFileSync(join(workspace, "keep.txt"), "keep");
    const before = readdirSync(workspace).sort();
    const first = inspectBackupRetention(workspace);
    const second = inspectBackupRetention(workspace);
    expect(first).toEqual(second);
    expect(readdirSync(workspace).sort()).toEqual(before);
    expect(existsSync(backups())).toBe(false);
  });

  it("counts every top-level entry and logical bytes including hard links", () => {
    const first = generation("first");
    const second = generation("second");
    fileWithBytes(join(first, "a.bin"), 3);
    const linked = join(second, "b.bin");
    fileWithBytes(linked, 5);
    linkSync(linked, join(second, "c.bin"));
    expect(inspectBackupRetention(workspace)).toEqual({
      generations: 2,
      bytes: 13,
      held: false,
    });
  });

  it("counts incomplete and unknown top-level entries as generations", () => {
    const incomplete = generation("2026-incomplete");
    fileWithBytes(join(incomplete, "FOLIO-RECOVERY-INCOMPLETE"), 1);
    mkdirSync(join(backups(), "no-manifest"));
    expect(
      inspectBackupRetention(workspace, { maxGenerations: 2 }).generations,
    ).toBe(2);
  });

  it("holds only once an exact generation or byte cap is exceeded", () => {
    const first = generation("a");
    fileWithBytes(join(first, "x"), 4);
    const second = generation("b");
    fileWithBytes(join(second, "y"), 6);
    expect(
      inspectBackupRetention(workspace, { maxGenerations: 2, maxBytes: 10 }),
    ).toEqual({ generations: 2, bytes: 10, held: false });
    fileWithBytes(join(second, "extra"), 1);
    expect(
      inspectBackupRetention(workspace, { maxGenerations: 2, maxBytes: 10 }),
    ).toEqual({ generations: 2, bytes: 11, held: true });
    expect(
      inspectBackupRetention(workspace, { maxGenerations: 1, maxBytes: 100 })
        .held,
    ).toBe(true);
  });

  it("uses actual logical bytes when limits are lower than the defaults", () => {
    const directory = generation("g");
    fileWithBytes(join(directory, "blob"), 100);
    expect(inspectBackupRetention(workspace, { maxBytes: 99 }).held).toBe(true);
    expect(inspectBackupRetention(workspace, { maxBytes: 100 }).held).toBe(
      false,
    );
  });

  it("counts a sparse 512 MiB file by logical size without reading it", () => {
    const directory = generation("sparse");
    const path = join(directory, "sparse.bin");
    writeFileSync(path, "");
    truncateSync(path, 512 * MIB);
    expect(inspectBackupRetention(workspace)).toEqual({
      generations: 1,
      bytes: 512 * MIB,
      held: false,
    });
  });

  it("accepts a canonical 0755 workspace parent", () => {
    chmodSync(workspace, 0o755);
    const directory = generation("g");
    fileWithBytes(join(directory, "a"), 1);
    expect(inspectBackupRetention(workspace).bytes).toBe(1);
  });

  it("rejects a symlink inside the fixed tree", () => {
    const directory = generation("g");
    symlinkSync(join(directory, "missing"), join(directory, "alias"));
    expectUnknown(() => inspectBackupRetention(workspace));
  });

  it("rejects a FIFO inside the fixed tree", () => {
    const directory = generation("g");
    execFileSync("mkfifo", [join(directory, "pipe")]);
    expectUnknown(() => inspectBackupRetention(workspace));
  });

  it("rejects a backup child that is a leaf alias", () => {
    const target = mkdtempSync(join(tmpdir(), "folio-backup-retention-alias-"));
    temporaryDirectories.push(target);
    symlinkSync(target, backups());
    expectUnknown(() => inspectBackupRetention(workspace));
  });

  it("rejects depth beyond four below the backups root", () => {
    const depthFour = join(backups(), "g", "a", "b", "c");
    mkdirSync(depthFour, { recursive: true });
    expect(inspectBackupRetention(workspace).generations).toBe(1);
    writeFileSync(join(depthFour, "too-deep"), "");
    expectUnknown(() => inspectBackupRetention(workspace));
  });

  it("rejects more than 8192 visited entries", () => {
    const directory = generation("g");
    for (let index = 0; index < 8191; index += 1) {
      writeFileSync(join(directory, String(index)), "");
    }
    expect(inspectBackupRetention(workspace).generations).toBe(1);
    writeFileSync(join(directory, "overflow"), "");
    expectUnknown(() => inspectBackupRetention(workspace));
  });

  it("accepts only positive integer limits and never raises the defaults", () => {
    const directory = generation("g");
    fileWithBytes(join(directory, "a"), 1);
    expectUnknown(() =>
      inspectBackupRetention(workspace, { maxGenerations: 0 }),
    );
    expectUnknown(() => inspectBackupRetention(workspace, { maxBytes: 1.5 }));
    expectUnknown(() => inspectBackupRetention(workspace, { maxGenerations: 99 }));
  });
});

describe("assertBackupRetention", () => {
  it("requires room for the next generation and its bytes", () => {
    const first = generation("a");
    fileWithBytes(join(first, "x"), 4);
    const second = generation("b");
    fileWithBytes(join(second, "y"), 6);
    expect(() =>
      assertBackupRetention(workspace, 5, {
        maxGenerations: 3,
        maxBytes: 15,
      }),
    ).not.toThrow();
    expect(() =>
      assertBackupRetention(workspace, 0, { maxGenerations: 2 }),
    ).toThrow();
    expect(() =>
      assertBackupRetention(workspace, 6, {
        maxGenerations: 3,
        maxBytes: 15,
      }),
    ).toThrow(expect.objectContaining({code: "sync-backup-retention-held"}));
  });

  it("rejects invalid additional bytes", () => {
    expectUnknown(() => assertBackupRetention(workspace, -1));
    expectUnknown(() => assertBackupRetention(workspace, 1.5));
  });
});
