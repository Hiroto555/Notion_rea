import { afterEach, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/persistence/store";
import {
  readWorkspaceOverview,
  syncStagingBytesFromUsage,
} from "../src/persistence/workspace-overview";
import type { TreeUsage } from "../src/shared/storage-usage";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function workspace() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-overview-staging-"),
  );
  const source = join(root, "source");
  const assets = join(source, "assets");
  mkdirSync(assets, { recursive: true });
  const store = new Store(join(source, "workspace.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    assets,
    store,
    staging: join(source, ".folio-sync-assets-staging"),
  };
}

it("reports zero sync staging bytes when staging is absent", () => {
  const f = workspace();
  writeFileSync(join(f.assets, "active.bin"), "abc");

  const report = readWorkspaceOverview(f.store.path);

  expect(report.syncStagingBytes).toBe(0);
  expect(report.assetBytes).toBe(3);
  expect(report.state).toBe("complete");
});

it("exposes nested sync staging bytes alongside active asset totals", () => {
  const f = workspace();
  writeFileSync(join(f.assets, "active.bin"), "ab");
  mkdirSync(join(f.staging, "received"), { recursive: true });
  writeFileSync(join(f.staging, "received", "part.bin"), "12345");

  const report = readWorkspaceOverview(f.store.path);

  expect(report.syncStagingBytes).toBe(5);
  expect(report.assetBytes).toBe(7);
  expect(report.state).toBe("complete");
});

it("returns null staging bytes for a symlink and marks the overview unknown", () => {
  const f = workspace();
  mkdirSync(f.staging);
  writeFileSync(join(f.staging, "part.bin"), "1234");
  const outside = join(f.root, "outside.bin");
  writeFileSync(outside, "unrelated");
  symlinkSync(outside, join(f.staging, "link.bin"));

  const report = readWorkspaceOverview(f.store.path);

  expect(report.syncStagingBytes).toBeNull();
  expect(report.assetBytes).toBeNull();
  expect(report.totalBytes).toBeNull();
  expect(report.state).toBe("unknown");
});

it("returns null staging bytes when the staging scan is truncated", () => {
  const f = workspace();
  const deep = join(
    f.staging,
    ...Array.from({ length: 10 }, (_, index) => `d${index}`),
  );
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "part.bin"), "123");

  const report = readWorkspaceOverview(f.store.path);

  expect(report.syncStagingBytes).toBeNull();
  expect(report.assetBytes).toBeNull();
  expect(report.totalBytes).toBeNull();
  expect(report.state).toBe("unknown");
});

it("treats an overflowing staging measurement as unmeasured", () => {
  const overflowed: TreeUsage = {
    state: "unknown",
    bytes: null,
    measuredBytes: 0,
    measuredFiles: 0,
    unknownFiles: 1,
    unscannedEntries: 0,
    overflow: true,
    root: "present",
    directories: 0,
    symlinks: 0,
    otherEntries: 0,
    truncated: false,
  };

  expect(syncStagingBytesFromUsage(overflowed)).toBeNull();
  expect(syncStagingBytesFromUsage({...overflowed, root: "missing"})).toBeNull();
});
