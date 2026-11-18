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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectWorkspaceTransferBudget } from "../src/sync/blob-transfer-budget";
import { SyncError } from "../src/sync/protocol";

const roots: string[] = [];

function makeWorkspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-transfer-budget-"));
  roots.push(directory);
  return directory;
}

function write(base: string, relative: string, body: string): void {
  const path = join(base, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
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

function snapshot(base: string): string[] {
  const result: string[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const key = relative.length === 0 ? name : `${relative}/${name}`;
      const body = stat.isFile() ? readFileSync(path).toString("hex") : "";
      result.push(
        `${key}:${stat.mode}:${stat.size}:${stat.ino}:${stat.nlink}:${body}`,
      );
      if (stat.isDirectory()) walk(path, key);
    }
  };
  walk(base, "");
  return result;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("inspectWorkspaceTransferBudget", () => {
  it("counts actual bytes across both scopes, staging and legacy parts", () => {
    const workspace = makeWorkspace();
    write(workspace, ".folio-sync-transfers/active.part", "abcd");
    write(workspace, ".folio-sync-transfers/legacy-random.part", "12345");
    write(workspace, ".folio-sync-transfers/nested/older.part", "xy");
    write(workspace, ".folio-sync-assets-staging/staged.bin", "abcdef");

    expect(inspectWorkspaceTransferBudget(workspace)).toEqual({
      bytes: 4 + 5 + 2 + 6,
      files: 4,
      directories: 3,
      entries: 7,
      overLimit: false,
    });
  });

  it("counts hardlinks and metadata names as logical regular-file bytes", () => {
    const workspace = makeWorkspace();
    const first = join(workspace, ".folio-sync-transfers/one.part");
    write(workspace, ".folio-sync-transfers/one.part", "data");
    linkSync(first, join(workspace, ".folio-sync-transfers/two.part"));
    write(workspace, ".folio-sync-transfers/state.sqlite", "meta");

    expect(inspectWorkspaceTransferBudget(workspace)).toEqual({
      bytes: 4 + 4 + 4,
      files: 3,
      directories: 1,
      entries: 4,
      overLimit: false,
    });
  });

  it("reports entry overflow and stops walking immediately", () => {
    const workspace = makeWorkspace();
    for (let index = 0; index < 10; index++)
      write(workspace, `.folio-sync-transfers/part-${index}.part`, "x");

    const result = inspectWorkspaceTransferBudget(workspace, { maxEntries: 3 });

    expect(result.overLimit).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(2);
  });

  it("reports byte overflow without zeroing or hiding counted bytes", () => {
    const workspace = makeWorkspace();
    write(workspace, ".folio-sync-transfers/one.part", "1234");
    write(workspace, ".folio-sync-transfers/two.part", "1234567");

    const result = inspectWorkspaceTransferBudget(workspace, { maxBytes: 5 });

    expect(result.overLimit).toBe(true);
    expect(result.bytes).toBe(11);
    expect(result.files).toBe(2);
  });

  it("reports depth overflow at the fourth level under a scope root", () => {
    const workspace = makeWorkspace();
    write(workspace, ".folio-sync-transfers/d1/d2/d3/d4/five.part", "x");

    const result = inspectWorkspaceTransferBudget(workspace);

    expect(result.overLimit).toBe(true);
    expect(result.files).toBe(0);
    expect(result.bytes).toBe(0);
    expect(result.directories).toBe(5);
    expect(result.entries).toBe(5);
  });

  it("treats missing scope children as zero and never creates them", () => {
    const workspace = makeWorkspace();
    write(workspace, "assets/keep.bin", "asset");
    write(workspace, "backup/keep.db", "backup");
    write(workspace, "workspace.sqlite", "database");
    write(workspace, "settings.json", "settings");
    const before = snapshot(workspace);

    expect(inspectWorkspaceTransferBudget(workspace)).toEqual({
      bytes: 0,
      files: 0,
      directories: 0,
      entries: 0,
      overLimit: false,
    });
    expect(snapshot(workspace)).toEqual(before);
  });

  it("refuses symlinks and FIFOs without following or deleting anything", () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    write(outside, "target.bin", "secret");
    write(workspace, "assets/asset.bin", "asset");
    write(workspace, "backup/backup.db", "backup");
    write(workspace, "archive/archive.bin", "archive");
    write(workspace, "workspace.sqlite", "database");
    const scope = join(workspace, ".folio-sync-transfers");
    mkdirSync(scope);
    const link = join(scope, "link.part");
    symlinkSync(join(outside, "target.bin"), link);
    const withLink = snapshot(workspace);

    expect(errorCode(() => inspectWorkspaceTransferBudget(workspace))).toBe(
      "blob-transfer-budget-unsafe",
    );
    expect(snapshot(workspace)).toEqual(withLink);

    rmSync(link);
    const fifo = join(scope, "fifo.part");
    execFileSync("mkfifo", [fifo]);
    const withFifo = snapshot(workspace);

    expect(errorCode(() => inspectWorkspaceTransferBudget(workspace))).toBe(
      "blob-transfer-budget-unsafe",
    );
    expect(snapshot(workspace)).toEqual(withFifo);
    expect(readFileSync(join(outside, "target.bin"), "utf8")).toBe("secret");
  });

  it("rejects missing, file and symlink roots with the fixed unsafe code", () => {
    const workspace = makeWorkspace();
    const missing = join(workspace, "missing");
    expect(errorCode(() => inspectWorkspaceTransferBudget(missing))).toBe(
      "blob-transfer-budget-unsafe",
    );

    const file = join(workspace, "workspace.sqlite");
    writeFileSync(file, "x");
    expect(errorCode(() => inspectWorkspaceTransferBudget(file))).toBe(
      "blob-transfer-budget-unsafe",
    );

    const link = join(workspace, "linked");
    symlinkSync(makeWorkspace(), link);
    expect(errorCode(() => inspectWorkspaceTransferBudget(link))).toBe(
      "blob-transfer-budget-unsafe",
    );
  });
});
