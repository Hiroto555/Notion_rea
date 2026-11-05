import type { DatabaseSync } from "node:sqlite";

/** Logical DB pages include live WAL changes and exclude WAL/SHM overhead. */
export function sqliteAllocatedBytes(db: DatabaseSync): number {
  function read(name: "page_count" | "page_size"): number {
    const raw = db.prepare("PRAGMA " + name).get()?.[name];
    const value = typeof raw === "bigint" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new Error("SQLite allocation exceeds the supported size range");
    return value;
  }
  const size = read("page_size"),
    bytes = read("page_count") * size;
  if (size === 0 || !Number.isSafeInteger(bytes))
    throw new Error("SQLite allocation exceeds the supported size range");
  return bytes;
}
