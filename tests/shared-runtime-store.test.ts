import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHARED_RUNTIME_MAX_BYTES,
  DEFAULT_SHARED_RUNTIME_MAX_ROWS,
  RuntimeStore,
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
} from "../src/collaboration/runtime/store";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-runtime-store-"));
  directories.push(directory);
  return directory;
}

function databasePath(directory: string): string {
  return join(directory, SHARED_RUNTIME_FILE);
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("RuntimeStore records", () => {
  it("stores canonical JSON, lists keys in order and survives reopen", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    store.transaction(() => {
      store.set("org:alpha", "b", { z: 1, a: [true, 2, "x"] });
      store.set("org:alpha", "a:colon", 42);
      store.set("org:alpha", "c", "text");
      store.set("other", "only", ["array"]);
    });

    expect(store.get("org:alpha", "b")).toEqual({
      z: 1,
      a: [true, 2, "x"],
    });
    expect(store.get("org:alpha", "a:colon")).toBe(42);
    expect(store.get("org:alpha", "missing")).toBeNull();
    expect(store.all("org:alpha").map((entry) => entry.key)).toEqual([
      "a:colon",
      "b",
      "c",
    ]);

    const raw = store.db
      .prepare("SELECT raw FROM runtime_records WHERE namespace=? AND key=?")
      .get("org:alpha", "b") as unknown as { raw: string };
    expect(raw.raw).toBe('{"a":[true,2,"x"],"z":1}');

    store.transaction(() => store.set("org:alpha", "c", null));
    expect(store.get("org:alpha", "c")).toBeNull();
    store.close();

    const reopened = new RuntimeStore(directory);
    expect(reopened.get("org:alpha", "b")).toEqual({
      z: 1,
      a: [true, 2, "x"],
    });
    expect(reopened.get("other", "only")).toEqual(["array"]);
    reopened.close();
  });

  it("rejects unsafe JSON and invalid names without mutating records", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    expect(() => store.set("ns", "key", 1)).toThrow(
      "SHARED_RUNTIME_TRANSACTION_REQUIRED",
    );
    expect(() => store.transaction(() => store.set("ns", "neg", -0))).toThrow(
      "UNSAFE_NUMBER",
    );
    expect(() =>
      store.transaction(() => store.set("ns", "huge", Infinity)),
    ).toThrow("UNSAFE_NUMBER");
    expect(() =>
      store.transaction(() => store.set("ns", "bigint", BigInt(1) as never)),
    ).toThrow("INVALID_JSON");
    expect(() =>
      store.transaction(() => store.set("ns", "surrogate", "\ud800")),
    ).toThrow("UNICODE");
    expect(() =>
      store.transaction(() => store.set("bad\ud800", "key", 1)),
    ).toThrow("INVALID_SHARED_RUNTIME_NAMESPACE");
    expect(() =>
      store.transaction(() => store.set("ns", "k".repeat(513), 1)),
    ).toThrow("INVALID_SHARED_RUNTIME_KEY");
    expect(() =>
      store.transaction(() => store.set("ns", "nul\0key", 1)),
    ).toThrow("INVALID_SHARED_RUNTIME_KEY");
    expect(store.all("ns")).toEqual([]);
    store.close();
  });

  it("rolls back a failed transaction and joins an existing transaction", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    expect(() =>
      store.transaction(() => {
        store.set("ns", "rolled-back", 1);
        throw new Error("stop");
      }),
    ).toThrow("stop");
    expect(store.get("ns", "rolled-back")).toBeNull();

    let joined = 0;
    store.transaction(() => {
      store.set("ns", "outer", 1);
      joined = store.transaction(() => {
        store.set("ns", "inner", 2);
        return 7;
      });
      store.set("ns", "outer-2", 3);
    });
    expect(joined).toBe(7);
    expect(store.get("ns", "outer")).toBe(1);
    expect(store.get("ns", "inner")).toBe(2);
    expect(store.get("ns", "outer-2")).toBe(3);
    store.close();
  });

  it("rejects corrupted raw values on read without dropping other data", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    store.transaction(() => store.set("ns", "good", { a: 1 }));
    store.transaction(() => store.set("ns", "bad", { a: 1 }));
    store.db
      .prepare("UPDATE runtime_records SET raw=? WHERE namespace=? AND key=?")
      .run('{"b":2,"a":1}', "ns", "bad");
    expect(() => store.get("ns", "bad")).toThrow("CORRUPT_SHARED_RUNTIME");
    expect(() => store.all("ns")).toThrow("CORRUPT_SHARED_RUNTIME");
    expect(store.get("ns", "good")).toEqual({ a: 1 });
    store.close();
  });
});

describe("RuntimeStore transactions and quota", () => {
  it("enforces row quota before mutation across records and blobs", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory, { maxRows: 2 });
    store.transaction(() => store.set("ns", "a", 1));
    store.transaction(() => store.set("ns", "b", 2));
    expect(() => store.transaction(() => store.set("ns", "c", 3))).toThrow(
      "SHARED_RUNTIME_LIMIT",
    );
    expect(store.get("ns", "c")).toBeNull();
    expect(store.all("ns")).toHaveLength(2);

    const bytes = Uint8Array.from([1, 2, 3]);
    expect(() =>
      store.transaction(() => store.blobPut("scope", hashOf(bytes), bytes)),
    ).toThrow("SHARED_RUNTIME_LIMIT");
    expect(store.blobGet("scope", hashOf(bytes))).toBeNull();
    store.close();
  });

  it("rejects byte growth but allows shrinking updates at quota", () => {
    const directory = tempDirectory();
    const maxBytes = 500;
    const store = new RuntimeStore(directory, { maxBytes });
    const large = "x".repeat(400);
    store.transaction(() => store.set("ns", "a", large));
    const medium = "y".repeat(120);
    expect(() => store.transaction(() => store.set("ns", "b", medium))).toThrow(
      "SHARED_RUNTIME_LIMIT",
    );
    expect(store.get("ns", "b")).toBeNull();
    expect(store.get("ns", "a")).toBe(large);

    store.transaction(() => store.set("ns", "a", "z"));
    expect(store.get("ns", "a")).toBe("z");
    store.transaction(() => store.set("ns", "b", medium));
    expect(store.get("ns", "b")).toBe(medium);
    expect(byteLength(medium)).toBeLessThan(maxBytes);
    store.close();
  });

  it("rejects oversized individual values before writing", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory, { maxBytes: 50 });
    expect(() =>
      store.transaction(() => store.set("ns", "too-big", "x".repeat(100))),
    ).toThrow("JSON_LIMIT");
    expect(store.get("ns", "too-big")).toBeNull();
    store.close();
  });

  it("rejects reopening when the requested quota is smaller than the data", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    store.transaction(() => store.set("ns", "a", 1));
    store.transaction(() => store.set("ns", "b", 2));
    store.close();
    expect(() => new RuntimeStore(directory, { maxRows: 1 })).toThrow(
      "SHARED_RUNTIME_LIMIT",
    );
  });
});

describe("RuntimeStore blobs", () => {
  it("verifies hashes, treats identical writes as no-ops and persists", () => {
    const directory = tempDirectory();
    const bytes = Uint8Array.from([0, 1, 2, 3, 250]);
    const hash = hashOf(bytes);
    const store = new RuntimeStore(directory);
    expect(() => store.blobPut("doc:one", hash, bytes)).toThrow(
      "SHARED_RUNTIME_TRANSACTION_REQUIRED",
    );
    store.transaction(() => store.blobPut("doc:one", hash, bytes));
    expect(store.blobGet("doc:one", hash)).toEqual(bytes);
    store.transaction(() => store.blobPut("doc:one", hash, bytes));
    store.close();

    const reopened = new RuntimeStore(directory);
    expect(reopened.blobGet("doc:one", hash)).toEqual(bytes);
    reopened.transaction(() => reopened.blobDelete("doc:one", hash));
    expect(reopened.blobGet("doc:one", hash)).toBeNull();
    reopened.transaction(() => reopened.blobDelete("doc:one", hash));
    reopened.close();
  });

  it("rejects hash mismatch, malformed hashes and oversized blobs", () => {
    const directory = tempDirectory();
    const bytes = Uint8Array.from([1, 2, 3]);
    const hash = hashOf(bytes);
    const store = new RuntimeStore(directory, { maxBytes: 64 });
    expect(() =>
      store.transaction(() =>
        store.blobPut("scope", hash, Uint8Array.from([1, 2, 4])),
      ),
    ).toThrow("SHARED_RUNTIME_BLOB_HASH_MISMATCH");
    expect(store.blobGet("scope", hash)).toBeNull();
    expect(() =>
      store.transaction(() =>
        store.blobPut("scope", hash.toUpperCase(), bytes),
      ),
    ).toThrow("INVALID_SHARED_RUNTIME_HASH");
    expect(() =>
      store.transaction(() => store.blobPut("scope", "not-a-hash", bytes)),
    ).toThrow("INVALID_SHARED_RUNTIME_HASH");

    const large = new Uint8Array(65).fill(7);
    expect(() =>
      store.transaction(() => store.blobPut("scope", hashOf(large), large)),
    ).toThrow("SHARED_RUNTIME_LIMIT");
    store.close();
  });

  it("detects tampered stored bytes on read and reopen", () => {
    const directory = tempDirectory();
    const bytes = Uint8Array.from([9, 8, 7]);
    const hash = hashOf(bytes);
    const store = new RuntimeStore(directory);
    store.transaction(() => store.blobPut("scope", hash, bytes));
    store.db
      .prepare("UPDATE runtime_blobs SET bytes=? WHERE scope=? AND hash=?")
      .run(Uint8Array.from([9, 8, 6]), "scope", hash);
    expect(() => store.blobGet("scope", hash)).toThrow(
      "CORRUPT_SHARED_RUNTIME",
    );
    store.close();
    expect(() => new RuntimeStore(directory)).toThrow("CORRUPT_SHARED_RUNTIME");
  });
});

describe("RuntimeStore file format and safety", () => {
  it("writes the exact format metadata and tables", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    const application = store.db
      .prepare("PRAGMA application_id")
      .get() as unknown as { application_id: number };
    const version = store.db
      .prepare("PRAGMA user_version")
      .get() as unknown as { user_version: number };
    expect(application.application_id).toBe(SHARED_RUNTIME_APPLICATION_ID);
    expect(version.user_version).toBe(SHARED_RUNTIME_VERSION);
    const tables = store.db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as unknown as { name: string; sql: string }[];
    expect(tables).toEqual([
      {
        name: "runtime_blobs",
        sql: "CREATE TABLE runtime_blobs(scope TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(scope,hash))",
      },
      {
        name: "runtime_records",
        sql: "CREATE TABLE runtime_records(namespace TEXT NOT NULL,key TEXT NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(namespace,key))",
      },
    ]);
    expect(DEFAULT_SHARED_RUNTIME_MAX_ROWS).toBe(10_000);
    expect(DEFAULT_SHARED_RUNTIME_MAX_BYTES).toBe(64 * 1024 * 1024);
    store.close();
  });

  it("refuses a foreign private database without changing it or creating sidecars", () => {
    const directory = tempDirectory();
    const path = databasePath(directory);
    const foreign = new DatabaseSync(path);
    foreign.exec(
      "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep')",
    );
    foreign.close();
    const before = readFileSync(path);

    expect(() => new RuntimeStore(directory)).toThrow(
      "NOT_SHARED_RUNTIME_FORMAT",
    );
    expect(readFileSync(path).equals(before)).toBe(true);
    for (const suffix of ["-wal", "-shm", "-journal"])
      expect(existsSync(path + suffix)).toBe(false);
  });

  it("refuses malformed existing files and orphan sidecars", () => {
    const directory = tempDirectory();
    const path = databasePath(directory);
    writeFileSync(path, "not a sqlite database");
    const before = readFileSync(path);
    expect(() => new RuntimeStore(directory)).toThrow();
    expect(readFileSync(path).equals(before)).toBe(true);
    for (const suffix of ["-wal", "-shm", "-journal"])
      expect(existsSync(path + suffix)).toBe(false);

    const orphanDirectory = tempDirectory();
    writeFileSync(databasePath(orphanDirectory) + "-journal", "orphan");
    expect(() => new RuntimeStore(orphanDirectory)).toThrow(
      "ORPHAN_SHARED_RUNTIME_SIDECAR",
    );
  });

  it("refuses symlink, hardlink and replaced-format paths", () => {
    const symlinkDirectory = tempDirectory();
    symlinkSync(
      join(symlinkDirectory, "missing-target"),
      databasePath(symlinkDirectory),
    );
    expect(() => new RuntimeStore(symlinkDirectory)).toThrow(
      "UNSAFE_SHARED_RUNTIME_PATH",
    );

    const sourceDirectory = tempDirectory();
    const source = new RuntimeStore(sourceDirectory);
    source.close();
    const linkedDirectory = tempDirectory();
    linkSync(databasePath(sourceDirectory), databasePath(linkedDirectory));
    expect(() => new RuntimeStore(linkedDirectory)).toThrow(
      "UNSAFE_SHARED_RUNTIME_PATH",
    );

    const driftedDirectory = tempDirectory();
    const drifted = new RuntimeStore(driftedDirectory);
    drifted.close();
    const drift = new DatabaseSync(databasePath(driftedDirectory));
    drift.exec("PRAGMA application_id=0");
    drift.close();
    expect(() => new RuntimeStore(driftedDirectory)).toThrow(
      "NOT_SHARED_RUNTIME_FORMAT",
    );
  });

  it("does not reinitialize missing tables or accept schema drift", () => {
    const missingDirectory = tempDirectory();
    const missing = new RuntimeStore(missingDirectory);
    missing.close();
    const drop = new DatabaseSync(databasePath(missingDirectory));
    drop.exec("DROP TABLE runtime_blobs");
    drop.close();
    expect(() => new RuntimeStore(missingDirectory)).toThrow(
      "CORRUPT_SHARED_RUNTIME_SCHEMA",
    );

    const driftDirectory = tempDirectory();
    const driftStore = new RuntimeStore(driftDirectory);
    driftStore.close();
    const drift = new DatabaseSync(databasePath(driftDirectory));
    drift.exec("ALTER TABLE runtime_records ADD COLUMN extra TEXT");
    drift.close();
    expect(() => new RuntimeStore(driftDirectory)).toThrow(
      "CORRUPT_SHARED_RUNTIME_SCHEMA",
    );
  });

  it("accepts ordinary row deletion without recreating the row", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    store.transaction(() => {
      store.set("ns", "keep", 1);
      store.set("ns", "remove", 2);
    });
    store.close();
    const external = new DatabaseSync(databasePath(directory));
    external
      .prepare("DELETE FROM runtime_records WHERE namespace=? AND key=?")
      .run("ns", "remove");
    external.close();

    const reopened = new RuntimeStore(directory);
    expect(reopened.get("ns", "keep")).toBe(1);
    expect(reopened.get("ns", "remove")).toBeNull();
    reopened.transaction(() => reopened.set("ns", "new", 3));
    expect(reopened.get("ns", "new")).toBe(3);
    reopened.close();
  });

  it("rejects corrupted persisted raw records before writable journal setup", () => {
    const directory = tempDirectory();
    const store = new RuntimeStore(directory);
    store.transaction(() => store.set("ns", "key", { a: 1 }));
    store.close();
    const external = new DatabaseSync(databasePath(directory));
    external
      .prepare("UPDATE runtime_records SET raw=? WHERE namespace=? AND key=?")
      .run('{"z":1,"a":2}', "ns", "key");
    external.close();
    expect(() => new RuntimeStore(directory)).toThrow("CORRUPT_SHARED_RUNTIME");
  });
});
