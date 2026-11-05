import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceStoragePressure,
  type StoragePressureProbe,
} from "../src/main/storage-pressure";
import { DEFAULT_STORAGE_RESERVE_BYTES } from "../src/shared/storage-pressure";

const checkedAt = new Date("2026-11-05T03:04:05.000Z");
const now = () => new Date(checkedAt);
const directory = "/tmp/folio-pressure-unit";

function withStat(bsize: bigint, bavail: bigint, reserveBytes = 0) {
  return new WorkspaceStoragePressure(directory, {
    reserveBytes,
    probe: () => ({ bsize, bavail }),
    now,
  });
}

describe("storage pressure", () => {
  it("exports the documented 256 MiB default reserve", () => {
    expect(DEFAULT_STORAGE_RESERVE_BYTES).toBe(256 * 1024 * 1024);
    const pressure = new WorkspaceStoragePressure(directory, {
      probe: () => ({
        bsize: 1n,
        bavail: BigInt(DEFAULT_STORAGE_RESERVE_BYTES),
      }),
      now,
    });
    const snapshot = pressure.inspect();
    expect(snapshot.state).toBe("ready");
    expect(snapshot.reserveBytes).toBe(DEFAULT_STORAGE_RESERVE_BYTES);
    expect(snapshot.additionalBytes).toBe(0);
    expect(snapshot.availableBytes).toBe(DEFAULT_STORAGE_RESERVE_BYTES);
  });

  it("is ready at the exact threshold and blocked one byte below", () => {
    const exact = withStat(1n, 1_000n, 1_000);
    expect(exact.inspect()).toEqual({
      state: "ready",
      checkedAt: checkedAt.toISOString(),
      availableBytes: 1_000,
      reserveBytes: 1_000,
      additionalBytes: 0,
    });

    const withAdditional = withStat(2n, 750n, 1_000);
    expect(withAdditional.inspect(500)).toMatchObject({
      state: "ready",
      availableBytes: 1_500,
      additionalBytes: 500,
    });
    expect(withAdditional.inspect(501)).toMatchObject({
      state: "blocked",
      availableBytes: 1_500,
      additionalBytes: 501,
      reason: "capacity-exceeded",
    });
    expect(withStat(1n, 999n, 1_000).inspect().state).toBe("blocked");
  });

  it("treats zero available space as measured, not unknown", () => {
    expect(withStat(4_096n, 0n, 0).inspect()).toMatchObject({
      state: "ready",
      availableBytes: 0,
    });
    expect(withStat(4_096n, 0n, 1).inspect()).toMatchObject({
      state: "blocked",
      availableBytes: 0,
      reason: "capacity-exceeded",
    });
  });

  it("uses bavail and calls the probe only once per inspect", () => {
    const probe = vi.fn<StoragePressureProbe>(() => ({
      bsize: 4_096n,
      bavail: 1_000n,
    }));
    const pressure = new WorkspaceStoragePressure(directory, {
      reserveBytes: 0,
      probe,
      now,
    });
    expect(pressure.inspect().availableBytes).toBe(4_096_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(directory);
    pressure.assertWritable();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("reports a zero block size or negative block counts as unknown", () => {
    for (const [bsize, bavail] of [
      [0n, 10n],
      [-1n, 10n],
      [1n, -1n],
    ] as const) {
      const snapshot = withStat(bsize, bavail).inspect();
      expect(snapshot.state).toBe("unknown");
      expect(snapshot.availableBytes).toBeNull();
      expect(snapshot.reason).toBe("capacity-unknown");
    }
  });

  it("reports malformed probe values as unknown", () => {
    const values: unknown[] = [
      null,
      {},
      { bsize: 1, bavail: 1n },
      { bsize: 1n, bavail: 1 },
      { bsize: 2n, bavail: BigInt(Number.MAX_SAFE_INTEGER) },
    ];
    for (const value of values) {
      const pressure = new WorkspaceStoragePressure(directory, {
        reserveBytes: 0,
        probe: () => value as { bsize: bigint; bavail: bigint },
        now,
      });
      expect(pressure.inspect()).toMatchObject({
        state: "unknown",
        availableBytes: null,
        reason: "capacity-unknown",
      });
    }
  });

  it("reports overflow of the required headroom as unknown", () => {
    const pressure = new WorkspaceStoragePressure(directory, {
      reserveBytes: Number.MAX_SAFE_INTEGER - 1,
      probe: () => ({
        bsize: 1n,
        bavail: BigInt(Number.MAX_SAFE_INTEGER),
      }),
      now,
    });
    const snapshot = pressure.inspect(2);
    expect(snapshot).toMatchObject({
      state: "unknown",
      availableBytes: Number.MAX_SAFE_INTEGER,
      reason: "capacity-unknown",
    });
    expect(() => pressure.assertWritable(2)).toThrow(/capacity-unknown/);
  });

  it("keeps a probe failure out of the snapshot and stops writes", () => {
    const secret = "/private-test-data/secret-person/Folio";
    const pressure = new WorkspaceStoragePressure(secret, {
      reserveBytes: 0,
      probe: () => {
        throw new Error(`EACCES: permission denied, stat '${secret}'`);
      },
      now,
    });
    const snapshot = pressure.inspect();
    expect(snapshot).toMatchObject({
      state: "unknown",
      availableBytes: null,
      reserveBytes: 0,
      additionalBytes: 0,
      reason: "capacity-unknown",
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret-person");
    expect(serialized).not.toContain("EACCES");
    expect(serialized).not.toContain("permission");
    expect(() => pressure.assertWritable()).toThrow(/capacity-unknown/);
  });

  it("reports a real statfs failure without leaking the path", () => {
    const missing = join(
      tmpdir(),
      `folio-storage-pressure-missing-${randomUUID()}`,
    );
    const pressure = new WorkspaceStoragePressure(missing, {
      reserveBytes: 0,
      now,
    });
    const snapshot = pressure.inspect();
    expect(snapshot).toMatchObject({
      state: "unknown",
      availableBytes: null,
      reason: "capacity-unknown",
    });
    expect(JSON.stringify(snapshot)).not.toContain(missing);
    expect(JSON.stringify(snapshot)).not.toContain("ENOENT");
  });

  it("reads real free blocks with the default probe on a disposable directory", () => {
    const disposable = mkdtempSync(join(tmpdir(), "folio-storage-pressure-"));
    try {
      const pressure = new WorkspaceStoragePressure(disposable, {
        reserveBytes: 0,
        now,
      });
      const snapshot = pressure.inspect();
      expect(["ready", "blocked"]).toContain(snapshot.state);
      expect(snapshot.checkedAt).toBe(checkedAt.toISOString());
      expect(typeof snapshot.availableBytes).toBe("number");
      expect(Number.isSafeInteger(snapshot.availableBytes)).toBe(true);
      expect(snapshot.availableBytes).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(snapshot)).not.toContain(disposable);
    } finally {
      rmSync(disposable, { recursive: true, force: true });
    }
  });

  it("throws a Japanese stop-and-preserve message when blocked", () => {
    let error: unknown;
    try {
      withStat(1n, 499n, 500).assertWritable();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("capacity-exceeded");
    expect(message).toContain("保存を停止");
    expect(message).toContain("入力は保持");
    expect(message).toContain("再試行");
    expect(message).not.toContain(directory);
  });

  it("throws a Japanese stop-and-preserve message when unknown", () => {
    const pressure = new WorkspaceStoragePressure(directory, {
      reserveBytes: 0,
      probe: () => {
        throw new Error("stat failed");
      },
      now,
    });
    expect(() => pressure.assertWritable()).toThrow(/capacity-unknown/);
    expect(() => pressure.assertWritable()).toThrow(/保存を停止/);
    expect(() => pressure.assertWritable()).toThrow(/入力は保持/);
    expect(() => pressure.assertWritable()).toThrow(/再試行/);
  });

  it("does not throw from assertWritable when ready", () => {
    expect(() => withStat(1n, 1_000n, 1_000).assertWritable()).not.toThrow();
  });

  it("uses one clock read and a fixed ISO timestamp", () => {
    const clock = vi.fn(now);
    const pressure = new WorkspaceStoragePressure(directory, {
      reserveBytes: 0,
      probe: () => ({ bsize: 1n, bavail: 1n }),
      now: clock,
    });
    expect(pressure.inspect().checkedAt).toBe(checkedAt.toISOString());
    expect(pressure.inspect().checkedAt).toBe(checkedAt.toISOString());
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid options and directory values", () => {
    const cases: [string, unknown, unknown][] = [
      ["null options", null, directory],
      ["array options", [], directory],
      ["unknown option", { reserveBytes: 0, extra: true }, directory],
      ["negative reserve", { reserveBytes: -1 }, directory],
      ["fractional reserve", { reserveBytes: 1.5 }, directory],
      ["NaN reserve", { reserveBytes: Number.NaN }, directory],
      [
        "infinite reserve",
        { reserveBytes: Number.POSITIVE_INFINITY },
        directory,
      ],
      [
        "unsafe reserve",
        { reserveBytes: Number.MAX_SAFE_INTEGER + 1 },
        directory,
      ],
      ["string reserve", { reserveBytes: "1024" }, directory],
      ["null reserve", { reserveBytes: null }, directory],
      ["non-function probe", { probe: 1 }, directory],
      ["null probe", { probe: null }, directory],
      ["non-function now", { now: "2026-11-05" }, directory],
      ["null now", { now: null }, directory],
      ["empty directory", { reserveBytes: 0 }, ""],
      ["null directory", { reserveBytes: 0 }, null],
      ["numeric directory", { reserveBytes: 0 }, 42],
    ];
    for (const [label, options, target] of cases)
      expect(
        () => new WorkspaceStoragePressure(target as never, options as never),
        label,
      ).toThrow(TypeError);
  });

  it("rejects invalid additionalBytes", () => {
    const pressure = withStat(1n, 0n, 0);
    const values: unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0",
      null,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const value of values) {
      expect(() => pressure.inspect(value as never)).toThrow(TypeError);
      expect(() => pressure.assertWritable(value as never)).toThrow(TypeError);
    }
  });

  it("rejects an invalid clock instead of fabricating a timestamp", () => {
    const pressure = new WorkspaceStoragePressure(directory, {
      reserveBytes: 0,
      probe: () => ({ bsize: 1n, bavail: 1n }),
      now: () => new Date(Number.NaN),
    });
    expect(() => pressure.inspect()).toThrow(TypeError);
    expect(() => pressure.assertWritable()).toThrow(TypeError);
  });

  it("omits reason only for ready snapshots", () => {
    expect(Object.keys(withStat(1n, 1n, 0).inspect()).sort()).toEqual([
      "additionalBytes",
      "availableBytes",
      "checkedAt",
      "reserveBytes",
      "state",
    ]);
    expect(Object.keys(withStat(1n, 0n, 1).inspect()).sort()).toEqual([
      "additionalBytes",
      "availableBytes",
      "checkedAt",
      "reason",
      "reserveBytes",
      "state",
    ]);
  });
});
