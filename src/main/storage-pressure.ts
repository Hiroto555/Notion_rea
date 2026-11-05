import { statfsSync } from "node:fs";
import {
  DEFAULT_STORAGE_RESERVE_BYTES,
  type StoragePressureSnapshot,
} from "../shared/storage-pressure";

export type StoragePressureProbe = (directory: string) => {
  bsize: bigint;
  bavail: bigint;
};

export type WorkspaceStoragePressureOptions = {
  reserveBytes?: number;
  probe?: StoragePressureProbe;
  now?: () => Date;
};

const OPTION_KEYS = ["reserveBytes", "probe", "now"] as const;

const BLOCKED_MESSAGE =
  "保存を停止しました (capacity-exceeded)。空き容量が安全余裕を下回っています。" +
  "入力は保持されています。空き容量を確保してから、同じ操作を再試行してください。";
const UNKNOWN_MESSAGE =
  "保存を停止しました (capacity-unknown)。空き容量を確認できません。" +
  "入力は保持されています。保存先の空き容量を確認してから、同じ操作を再試行してください。";

function isSafeByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** One statfs call on the workspace filesystem; no directory walk. `bavail`
 * (blocks available to an unprivileged process), never `bfree`, is used. */
function defaultProbe(directory: string): { bsize: bigint; bavail: bigint } {
  const stats = statfsSync(directory, { bigint: true });
  return { bsize: stats.bsize, bavail: stats.bavail };
}

function validateOptions(options: WorkspaceStoragePressureOptions): {
  reserveBytes: number;
  probe: StoragePressureProbe;
  now: () => Date;
} {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Storage pressure options must be an object");
  for (const key of Object.keys(options)) {
    if (!(OPTION_KEYS as readonly string[]).includes(key))
      throw new TypeError("Unknown storage pressure option");
  }
  const reserveBytes =
    options.reserveBytes === undefined
      ? DEFAULT_STORAGE_RESERVE_BYTES
      : options.reserveBytes;
  if (!isSafeByteCount(reserveBytes))
    throw new TypeError("reserveBytes must be a non-negative safe integer");
  const probe = options.probe === undefined ? defaultProbe : options.probe;
  if (typeof probe !== "function")
    throw new TypeError("probe must be a function");
  const now = options.now === undefined ? () => new Date() : options.now;
  if (typeof now !== "function") throw new TypeError("now must be a function");
  return { reserveBytes, probe, now };
}

/** Returns null when the filesystem did not report usable free space. A zero
 * block size or a negative block count is invalid, not "zero available". */
function availableFrom(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const { bsize, bavail } = value as {
    bsize?: unknown;
    bavail?: unknown;
  };
  if (typeof bsize !== "bigint" || typeof bavail !== "bigint") return null;
  if (bsize <= 0n || bavail < 0n) return null;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (bavail > maximum / bsize) return null;
  return Number(bsize * bavail);
}

export class WorkspaceStoragePressure {
  private readonly directory: string;
  private readonly reserveBytes: number;
  private readonly probe: StoragePressureProbe;
  private readonly now: () => Date;

  constructor(
    directory: string,
    options: WorkspaceStoragePressureOptions = {},
  ) {
    if (typeof directory !== "string" || directory.length === 0)
      throw new TypeError("directory must be a non-empty string");
    this.directory = directory;
    const validated = validateOptions(options);
    this.reserveBytes = validated.reserveBytes;
    this.probe = validated.probe;
    this.now = validated.now;
  }

  inspect(additionalBytes = 0): StoragePressureSnapshot {
    if (!isSafeByteCount(additionalBytes))
      throw new TypeError(
        "additionalBytes must be a non-negative safe integer",
      );
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new TypeError("Invalid storage pressure clock");
    const checkedAt = now.toISOString();
    const base = {
      checkedAt,
      reserveBytes: this.reserveBytes,
      additionalBytes,
    };

    let availableBytes: number | null;
    try {
      availableBytes = availableFrom(this.probe(this.directory));
    } catch {
      availableBytes = null;
    }
    if (availableBytes === null)
      return {
        state: "unknown",
        ...base,
        availableBytes: null,
        reason: "capacity-unknown",
      };

    const required = this.reserveBytes + additionalBytes;
    if (!Number.isSafeInteger(required))
      return {
        state: "unknown",
        ...base,
        availableBytes,
        reason: "capacity-unknown",
      };
    if (availableBytes < required)
      return {
        state: "blocked",
        ...base,
        availableBytes,
        reason: "capacity-exceeded",
      };
    return { state: "ready", ...base, availableBytes };
  }

  assertWritable(additionalBytes = 0): void {
    const snapshot = this.inspect(additionalBytes);
    if (snapshot.state === "ready") return;
    throw new Error(
      snapshot.state === "blocked" ? BLOCKED_MESSAGE : UNKNOWN_MESSAGE,
    );
  }
}
