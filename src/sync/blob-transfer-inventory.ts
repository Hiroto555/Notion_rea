import { lstatSync, opendirSync, realpathSync, type Stats } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  BlobTransferLimits,
  BlobTransferRecord,
} from "./blob-transfer-types";
import { SyncError } from "./protocol";

export type BlobTransferInventoryKind =
  "active" | "completed" | "blocked" | "orphan" | "unsafe" | "metadata";

export type BlobTransferInventoryItem = {
  name: string;
  kind: BlobTransferInventoryKind;
  bytes: number | null;
  key?: string;
};

export type BlobTransferInventory = {
  items: BlobTransferInventoryItem[];
  totalBytes: number;
  unsafeCount: number;
  overLimit: boolean;
};

const DEFAULT_MAX_ENTRIES = 1000;
const METADATA_ALLOWANCE = 16;
const MAX_KEY_BYTES = 251;
const MAX_NAME_BYTES = 255;
const STATES = new Set(["active", "completed", "blocked"]);

type ValidatedRecord = {
  key: string;
  name: string;
  state: "active" | "completed" | "blocked";
  signature: string;
};

function invalidRecord(): never {
  throw new SyncError("invalid-blob-transfer-record");
}

function validateKey(value: unknown): string {
  if (typeof value !== "string") invalidRecord();
  if (value.length === 0 || Buffer.byteLength(value) > MAX_KEY_BYTES)
    invalidRecord();
  if (value === "." || value === ".." || basename(value) !== value)
    invalidRecord();
  if (/[\/\\\u0000-\u001f\u007f]/.test(value)) invalidRecord();
  return value;
}

function recordSignature(record: BlobTransferRecord): string {
  return JSON.stringify([
    record.direction,
    record.assetId,
    record.sha256,
    record.bytes,
    record.scopeHash,
    record.partialName,
    record.offset,
    record.prefixHash,
    record.state,
    record.reason,
    record.updatedAt,
  ]);
}

function validateRecords(
  records: readonly BlobTransferRecord[],
): Map<string, ValidatedRecord> {
  if (!Array.isArray(records))
    throw new SyncError("invalid-blob-transfer-records");
  const byName = new Map<string, ValidatedRecord>();
  const byKey = new Map<string, string>();
  for (const record of records) {
    if (record === null || typeof record !== "object" || Array.isArray(record))
      invalidRecord();
    const key = validateKey(record.key);
    if (!STATES.has(record.state)) invalidRecord();
    const name = `${key}.part`;
    if (Buffer.byteLength(name) > MAX_NAME_BYTES) invalidRecord();
    const signature = recordSignature(record);
    const previous = byKey.get(key);
    if (previous !== undefined) {
      if (previous === signature)
        throw new SyncError("duplicate-blob-transfer-record");
      throw new SyncError("conflicting-blob-transfer-record");
    }
    byKey.set(key, signature);
    byName.set(name, {
      key,
      name,
      state: record.state as ValidatedRecord["state"],
      signature,
    });
  }
  return byName;
}

function validateLimits(limits?: Partial<BlobTransferLimits>): {
  maxEntries: number;
  maxBytes: number;
} {
  if (limits === undefined)
    return {
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxBytes: Number.MAX_SAFE_INTEGER,
    };
  if (limits === null || typeof limits !== "object" || Array.isArray(limits))
    throw new SyncError("invalid-blob-transfer-limits");
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = limits.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
    throw new SyncError("invalid-blob-transfer-limits");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new SyncError("invalid-blob-transfer-limits");
  return { maxEntries, maxBytes };
}

function validateDirectory(directory: unknown): string {
  if (typeof directory !== "string" || directory.length === 0)
    throw new SyncError("invalid-blob-transfer-root");
  if (directory.includes("\u0000"))
    throw new SyncError("invalid-blob-transfer-root");
  let root: string;
  try {
    root = resolve(directory);
  } catch {
    throw new SyncError("invalid-blob-transfer-root");
  }
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch {
    throw new SyncError("invalid-blob-transfer-root");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new SyncError("invalid-blob-transfer-root");
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch {
    throw new SyncError("invalid-blob-transfer-root");
  }
  let canonicalStat: Stats;
  try {
    canonicalStat = lstatSync(canonical);
  } catch {
    throw new SyncError("invalid-blob-transfer-root");
  }
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory())
    throw new SyncError("invalid-blob-transfer-root");
  return canonical;
}

function isMetadataName(name: string): boolean {
  return [
    "state.sqlite",
    "state.sqlite-wal",
    "state.sqlite-shm",
    "state.sqlite-journal",
  ].includes(name);
}

function lstatEntry(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new SyncError("blob-transfer-inventory-read-failed");
  }
}

function unsafeEntry(
  item: BlobTransferInventoryItem,
): BlobTransferInventoryItem {
  return {
    name: item.name,
    kind: "unsafe",
    bytes: null,
    ...(item.key ? { key: item.key } : {}),
  };
}

function classify(
  name: string,
  stat: Stats,
  record: ValidatedRecord | undefined,
): BlobTransferInventoryItem {
  const item: BlobTransferInventoryItem = record
    ? { name, kind: record.state, bytes: null, key: record.key }
    : { name, kind: "orphan", bytes: null };
  if (stat.isSymbolicLink() || stat.isDirectory() || stat.isFIFO())
    return unsafeEntry(item);
  if (!stat.isFile()) return unsafeEntry(item);
  if (stat.nlink !== 1) return unsafeEntry(item);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    item.bytes = null;
    return item;
  }
  if (!record && isMetadataName(name))
    return { name, kind: "metadata", bytes: stat.size };
  item.bytes = stat.size;
  return item;
}

export function inspectBlobTransferInventory(
  directory: string,
  records: readonly BlobTransferRecord[],
  limits?: Partial<BlobTransferLimits>,
): BlobTransferInventory {
  const root = validateDirectory(directory);
  const recordMap = validateRecords(records);
  const { maxEntries, maxBytes } = validateLimits(limits);
  const items: BlobTransferInventoryItem[] = [];
  let dataEntries = 0;
  let metadataEntries = 0;
  let totalBytes = 0;
  let unsafeCount = 0;
  let overLimit = false;

  let handle;
  try {
    handle = opendirSync(root);
  } catch {
    throw new SyncError("invalid-blob-transfer-root");
  }
  try {
    for (;;) {
      let entry;
      try {
        entry = handle.readSync();
      } catch {
        throw new SyncError("blob-transfer-inventory-read-failed");
      }
      if (entry === null) break;
      const name = entry.name;
      const metadataName = isMetadataName(name);
      if (metadataName) {
        if (metadataEntries >= METADATA_ALLOWANCE) {
          overLimit = true;
          break;
        }
        metadataEntries++;
      } else {
        if (dataEntries >= maxEntries) {
          overLimit = true;
          break;
        }
        dataEntries++;
      }
      const stat = lstatEntry(resolve(root, name));
      if (stat === null) continue;
      const item = classify(name, stat, recordMap.get(name));
      items.push(item);
      if (item.kind === "unsafe") unsafeCount++;
      if (item.bytes !== null) {
        if (item.bytes > Number.MAX_SAFE_INTEGER - totalBytes) {
          totalBytes = Number.MAX_SAFE_INTEGER;
          overLimit = true;
        } else {
          totalBytes += item.bytes;
        }
        if (totalBytes > maxBytes) overLimit = true;
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // The traversal result stays usable; closing never mutates the source.
    }
  }

  items.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return { items, totalBytes, unsafeCount, overLimit };
}
