import type * as fs from "node:fs";
import { expect, it } from "vitest";
import {
  scanDirectoryTree,
  type StorageScanOperations,
} from "../src/persistence/storage-usage";
import {
  addCounts,
  DEFAULT_STORAGE_SCAN_LIMITS,
  evaluateStorageCapacity,
  mergeUsageStates,
  sumNullable,
  type StorageUsageReport,
  type UsageState,
} from "../src/shared/storage-usage";

type VirtualNode =
  | { kind: "dir"; children: string[] }
  | { kind: "file"; size: number }
  | { kind: "symlink" }
  | { kind: "other" };

function virtualOps(
  nodes: Record<string, VirtualNode>,
  failures: Record<string, string> = {},
  reads: string[] = [],
): Partial<StorageScanOperations> {
  const stats = (node: VirtualNode): fs.Stats =>
    ({
      isFile: () => node.kind === "file",
      isDirectory: () => node.kind === "dir",
      isSymbolicLink: () => node.kind === "symlink",
      size: node.kind === "file" ? node.size : 0,
    }) as unknown as fs.Stats;
  const failure = (path: string, fallback = "ENOENT"): never => {
    const code = failures[path] ?? fallback;
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  };
  return {
    lstatSync: ((path: string) => {
      const key = String(path);
      reads.push(key);
      if (failures[key]) failure(key);
      const node = nodes[key];
      if (!node) return failure(key);
      return stats(node);
    }) as unknown as typeof fs.lstatSync,
    readdirSync: ((path: string) => {
      const key = String(path);
      if (failures[key]) failure(key);
      const node = nodes[key];
      if (!node || node.kind !== "dir") return failure(key);
      return node.children;
    }) as unknown as typeof fs.readdirSync,
    realpathSync: ((path: string) => String(path)) as typeof fs.realpathSync,
    readFileSync: (() => {
      throw new Error("unexpected read");
    }) as unknown as typeof fs.readFileSync,
  };
}

const ROOT = "/virtual/assets";

function scan(
  nodes: Record<string, VirtualNode>,
  limits: { maxEntries?: number; maxDepth?: number } = {},
  failures: Record<string, string> = {},
  reads: string[] = [],
) {
  return scanDirectoryTree(ROOT, {
    scanLimits: limits,
    operations: virtualOps(nodes, failures, reads),
  });
}

it("measures nested regular files and counts directories", () => {
  const { usage, issues } = scan({
    [ROOT]: { kind: "dir", children: ["a", "sub"] },
    [`${ROOT}/a`]: { kind: "file", size: 3 },
    [`${ROOT}/sub`]: { kind: "dir", children: ["b"] },
    [`${ROOT}/sub/b`]: { kind: "file", size: 4 },
  });
  expect(usage).toMatchObject({
    root: "present",
    state: "complete",
    bytes: 7,
    measuredBytes: 7,
    measuredFiles: 2,
    directories: 1,
    unknownFiles: 0,
    truncated: false,
  });
  expect(issues).toEqual([]);
});

it("never follows a symbolic link", () => {
  const reads: string[] = [];
  const { usage } = scan(
    {
      [ROOT]: { kind: "dir", children: ["link"] },
      [`${ROOT}/link`]: { kind: "symlink" },
      "/outside/target": { kind: "file", size: 9_999 },
    },
    {},
    {},
    reads,
  );
  expect(usage).toMatchObject({
    state: "partial",
    symlinks: 1,
    measuredFiles: 0,
    measuredBytes: 0,
    bytes: 0,
  });
  expect(reads).not.toContain("/outside/target");
});

it("reports truncation as unknown instead of counting a partial total", () => {
  const { usage, issues } = scan(
    {
      [ROOT]: { kind: "dir", children: ["a", "b", "c", "d", "e"] },
      [`${ROOT}/a`]: { kind: "file", size: 1 },
      [`${ROOT}/b`]: { kind: "file", size: 1 },
      [`${ROOT}/c`]: { kind: "file", size: 1 },
      [`${ROOT}/d`]: { kind: "file", size: 1 },
      [`${ROOT}/e`]: { kind: "file", size: 1 },
    },
    { maxEntries: 3 },
  );
  expect(usage).toMatchObject({
    state: "unknown",
    bytes: null,
    measuredFiles: 3,
    measuredBytes: 3,
    unscannedEntries: 2,
    truncated: true,
  });
  expect(issues.map((entry) => entry.code)).toContain("scan-truncated");
});

it("stops at the configured depth and does not report zero bytes", () => {
  const nodes: Record<string, VirtualNode> = {
    [ROOT]: { kind: "dir", children: ["d1"] },
    [`${ROOT}/d1`]: { kind: "dir", children: ["d2"] },
    [`${ROOT}/d1/d2`]: { kind: "dir", children: ["f"] },
    [`${ROOT}/d1/d2/f`]: { kind: "file", size: 10 },
  };
  const limited = scan(nodes, { maxDepth: 2 });
  expect(limited.usage).toMatchObject({
    state: "unknown",
    bytes: null,
    measuredFiles: 0,
    truncated: true,
  });
  expect(limited.issues.map((entry) => entry.code)).toContain("depth-limit");
  const deeper = scan(nodes, { maxDepth: 4 });
  expect(deeper.usage).toMatchObject({
    state: "complete",
    bytes: 10,
    measuredFiles: 1,
  });
});

it("treats an entry that vanishes mid-scan as unknown, not zero bytes", () => {
  const { usage, issues } = scan(
    {
      [ROOT]: { kind: "dir", children: ["a", "gone"] },
      [`${ROOT}/a`]: { kind: "file", size: 2 },
    },
    {},
    { [`${ROOT}/gone`]: "ENOENT" },
  );
  expect(usage).toMatchObject({
    state: "unknown",
    bytes: null,
    measuredFiles: 1,
    unknownFiles: 1,
  });
  expect(issues.map((entry) => entry.code)).toContain("entry-vanished");
});

it("treats permission failures on stat and readdir as unknown", () => {
  const statDenied = scan(
    {
      [ROOT]: { kind: "dir", children: ["locked", "ok"] },
      [`${ROOT}/ok`]: { kind: "file", size: 1 },
    },
    {},
    { [`${ROOT}/locked`]: "EACCES" },
  );
  expect(statDenied.usage).toMatchObject({
    state: "unknown",
    bytes: null,
    unknownFiles: 1,
  });
  expect(statDenied.issues.map((entry) => entry.code)).toContain(
    "permission-denied",
  );

  const readDenied = scan(
    {
      [ROOT]: { kind: "dir", children: ["sub"] },
      [`${ROOT}/sub`]: { kind: "dir", children: [] },
    },
    {},
    { [`${ROOT}/sub`]: "EPERM" },
  );
  expect(readDenied.usage).toMatchObject({
    state: "unknown",
    bytes: null,
    unknownFiles: 1,
  });
  expect(readDenied.issues.map((entry) => entry.code)).toContain(
    "permission-denied",
  );
});

it("rejects path escape names from a compromised directory listing", () => {
  const { usage, issues } = scan({
    [ROOT]: { kind: "dir", children: ["../escape", "ok"] },
    [`${ROOT}/ok`]: { kind: "file", size: 1 },
  });
  expect(usage).toMatchObject({
    state: "unknown",
    bytes: null,
    measuredFiles: 1,
    unknownFiles: 1,
  });
  expect(issues.map((entry) => entry.code)).toContain("path-escape");
});

it("surfaces counter overflow instead of wrapping", () => {
  const { usage, issues } = scan({
    [ROOT]: { kind: "dir", children: ["a", "b"] },
    [`${ROOT}/a`]: { kind: "file", size: Number.MAX_SAFE_INTEGER },
    [`${ROOT}/b`]: { kind: "file", size: Number.MAX_SAFE_INTEGER },
  });
  expect(usage).toMatchObject({
    state: "unknown",
    bytes: null,
    overflow: true,
  });
  expect(issues.map((entry) => entry.code)).toContain("counter-overflow");
});

it("reports unsupported entry types as unknown", () => {
  const { usage, issues } = scan({
    [ROOT]: { kind: "dir", children: ["fifo"] },
    [`${ROOT}/fifo`]: { kind: "other" },
  });
  expect(usage).toMatchObject({
    state: "unknown",
    bytes: null,
    otherEntries: 1,
    unknownFiles: 1,
  });
  expect(issues.map((entry) => entry.code)).toContain("unsupported-entry");
});

it("reports a missing root as empty and an unsafe root as unknown", () => {
  const missing = scan({});
  expect(missing.usage).toMatchObject({
    root: "missing",
    state: "complete",
    bytes: 0,
  });
  const unsafe = scan({ [ROOT]: { kind: "symlink" } });
  expect(unsafe.usage).toMatchObject({
    root: "unknown",
    state: "unknown",
    bytes: null,
  });
  expect(unsafe.issues.map((entry) => entry.code)).toContain("root-unsafe");
});

it("does not wrap addition or hide unknown subtotals", () => {
  expect(addCounts(1, 2)).toEqual({ value: 3, overflow: false });
  expect(addCounts(Number.MAX_SAFE_INTEGER, 1)).toEqual({
    value: 0,
    overflow: true,
  });
  expect(addCounts(-1, 2).overflow).toBe(true);
  expect(addCounts(1.5, 2).overflow).toBe(true);
  expect(sumNullable([1, 2, 3])).toEqual({ value: 6, overflow: false });
  expect(sumNullable([1, null])).toEqual({ value: null, overflow: false });
  expect(sumNullable([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).toEqual(
    { value: null, overflow: true },
  );
  expect(mergeUsageStates(["complete", "partial"])).toBe("partial");
  expect(mergeUsageStates(["complete", "unknown", "partial"])).toBe("unknown");
  expect(mergeUsageStates([])).toBe("complete");
});

function reportWith(
  overrides: {
    state?: UsageState;
    totals?: Partial<StorageUsageReport["totals"]>;
    receipts?: Partial<StorageUsageReport["database"]["receipts"]>;
  } = {},
): StorageUsageReport {
  const receipts = {
    state: "complete",
    rows: 5,
    storedBytes: 100,
    fingerprintBytes: 10,
    largestResultBytes: 50,
    corruptRows: 0,
    inspectedRows: 5,
    byStatus: { applied: 5, rejected: 0, unknown: 0, other: 0 },
    overflow: false,
    ...overrides.receipts,
  };
  return {
    format: "folio-storage-usage",
    version: 1,
    generatedAt: new Date(0).toISOString(),
    state: overrides.state ?? "complete",
    limits: DEFAULT_STORAGE_SCAN_LIMITS,
    database: { receipts },
    workspace: {},
    totals: {
      state: "complete",
      databaseFileBytes: 10,
      assetFileBytes: 20,
      backupFileBytes: 30,
      otherWorkspaceFileBytes: 0,
      totalFileBytes: 60,
      storedTextBytes: 1_000,
      unknownFileCount: 0,
      overflow: false,
      ...overrides.totals,
    },
    issues: [],
  } as unknown as StorageUsageReport;
}

it("evaluates configured capacity limits conservatively", () => {
  const report = reportWith();
  expect(evaluateStorageCapacity(report, {})).toEqual({
    status: "not-configured",
  });
  expect(
    evaluateStorageCapacity(report, {
      maxDatabaseFileBytes: 10,
      maxAssetFileBytes: 20,
      maxBackupFileBytes: 30,
      maxTotalFileBytes: 60,
      maxReceiptRows: 5,
      maxReceiptStoredBytes: 100,
    }),
  ).toMatchObject({ status: "within" });

  expect(
    evaluateStorageCapacity(report, { maxAssetFileBytes: 19 }),
  ).toMatchObject({
    status: "exceeded",
    violations: [{ limit: "maxAssetFileBytes", actual: 20, maximum: 19 }],
  });

  expect(
    evaluateStorageCapacity(report, { maxReceiptRows: 4 }),
  ).toMatchObject({
    status: "exceeded",
    violations: [{ limit: "maxReceiptRows", actual: 5, maximum: 4 }],
  });

  // A measured value under its bound is not evidence of safety when another
  // part of the report is incomplete.
  expect(
    evaluateStorageCapacity(reportWith({ state: "partial" }), {
      maxAssetFileBytes: 1_000,
    }),
  ).toMatchObject({
    status: "unknown",
    unknownLimits: ["maxAssetFileBytes"],
  });

  expect(
    evaluateStorageCapacity(
      reportWith({ totals: { assetFileBytes: null } }),
      { maxAssetFileBytes: 1_000 },
    ),
  ).toMatchObject({
    status: "unknown",
    unknownLimits: ["maxAssetFileBytes"],
  });

  expect(
    evaluateStorageCapacity(
      reportWith({ receipts: { rows: null } }),
      { maxReceiptRows: 1_000 },
    ),
  ).toMatchObject({
    status: "unknown",
    unknownLimits: ["maxReceiptRows"],
  });

  // Exceeded wins even when another configured source is unknown.
  expect(
    evaluateStorageCapacity(
      reportWith({
        state: "partial",
        totals: { assetFileBytes: null, backupFileBytes: 30 },
      }),
      { maxAssetFileBytes: 1_000, maxBackupFileBytes: 10 },
    ),
  ).toMatchObject({ status: "exceeded" });
});

it("rejects malformed limits and reports", () => {
  const report = reportWith();
  expect(() =>
    evaluateStorageCapacity(report, { maxAssetFileBytes: -1 }),
  ).toThrow(TypeError);
  expect(() =>
    evaluateStorageCapacity(report, { maxAssetFileBytes: 1.5 }),
  ).toThrow(TypeError);
  expect(() =>
    evaluateStorageCapacity(report, {
      maxAssetFileBytes: Number.NaN,
    }),
  ).toThrow(TypeError);
  expect(() =>
    evaluateStorageCapacity(report, {
      maxAssetFileBytes: "1" as unknown as number,
    }),
  ).toThrow(TypeError);
  expect(() =>
    evaluateStorageCapacity(report, {
      maxEverything: 1,
    } as never),
  ).toThrow(TypeError);
  expect(() =>
    evaluateStorageCapacity(
      { ...report, format: "other" } as unknown as StorageUsageReport,
      { maxAssetFileBytes: 1 },
    ),
  ).toThrow(TypeError);
});
