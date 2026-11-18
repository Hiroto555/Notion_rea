import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  exportBackup,
  restoreBackup,
  type RuntimeBackup,
} from "../src/collaboration/runtime/backup";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";
import type { Cut } from "../src/collaboration/runtime/contract";
import type { Doc } from "../src/shared/types";

class TestStore implements StoragePort {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_records(
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        raw TEXT NOT NULL,
        PRIMARY KEY(namespace,key)
      );
      CREATE TABLE IF NOT EXISTS runtime_blobs(
        scope TEXT NOT NULL,
        hash TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY(scope,hash)
      );
    `);
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  get(namespace: string, key: string): unknown | null {
    const row = this.db
      .prepare("SELECT raw FROM runtime_records WHERE namespace=? AND key=?")
      .get(namespace, key) as unknown as { raw: string } | undefined;
    return row ? (JSON.parse(row.raw) as unknown) : null;
  }

  set(namespace: string, key: string, value: unknown | null): void {
    if (value === null) {
      this.db
        .prepare("DELETE FROM runtime_records WHERE namespace=? AND key=?")
        .run(namespace, key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO runtime_records(namespace,key,raw) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET raw=excluded.raw",
      )
      .run(namespace, key, canonical(value));
  }

  all(namespace: string): { key: string; value: unknown }[] {
    const rows = this.db
      .prepare(
        "SELECT key,raw FROM runtime_records WHERE namespace=? ORDER BY key",
      )
      .all(namespace) as unknown as { key: string; raw: string }[];
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.raw) as unknown,
    }));
  }

  blobGet(scope: string, hash: string): Uint8Array | null {
    const row = this.db
      .prepare("SELECT bytes FROM runtime_blobs WHERE scope=? AND hash=?")
      .get(scope, hash) as unknown as { bytes: Uint8Array } | undefined;
    return row ? new Uint8Array(row.bytes) : null;
  }

  blobPut(scope: string, hash: string, bytes: Uint8Array): void {
    this.db
      .prepare(
        "INSERT INTO runtime_blobs(scope,hash,bytes) VALUES(?,?,?) ON CONFLICT(scope,hash) DO UPDATE SET bytes=excluded.bytes",
      )
      .run(scope, hash, Buffer.from(bytes));
  }

  blobDelete(scope: string, hash: string): void {
    this.db
      .prepare("DELETE FROM runtime_blobs WHERE scope=? AND hash=?")
      .run(scope, hash);
  }

  count(table: "runtime_records" | "runtime_blobs"): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as unknown as { count: number };
    return Number(row.count);
  }

  close(): void {
    this.db.close();
  }
}

class FailingStore extends TestStore {
  readonly failAt: string;

  constructor(failAt: string) {
    super();
    this.failAt = failAt;
  }

  override set(namespace: string, key: string, value: unknown | null): void {
    if (namespace === this.failAt) throw new Error("injected write failure");
    super.set(namespace, key, value);
  }
}

const OLD_CUT: Cut = { epoch: "epoch-old", seq: 7, hash: "a".repeat(64) };
const SCOPE = "org:ws:doc:inc";
const DOCUMENT: Doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text: "hello shared runtime" }],
    },
  ],
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signed(backup: RuntimeBackup): unknown {
  const { hash: _hash, ...manifest } = backup;
  return {
    ...manifest,
    hash: createHash("sha256").update(canonical(manifest)).digest("hex"),
  };
}

function cloneBackup(backup: RuntimeBackup): RuntimeBackup {
  return JSON.parse(JSON.stringify(backup)) as RuntimeBackup;
}

function source(): {
  store: TestStore;
  bytes: Uint8Array;
  blobHash: string;
  receipt: unknown;
} {
  const store = new TestStore();
  const bytes = new TextEncoder().encode("actual shared blob bytes");
  const blobHash = sha256(bytes);
  const receipt = {
    v: 1,
    status: "SERVER_ACCEPTED",
    intentId: "intent1",
    cut: OLD_CUT,
    writerId: "writer1",
  };

  store.set("meta", "head", OLD_CUT);
  store.set("documents", SCOPE, {
    schemaVersion: 1,
    document: DOCUMENT,
  });
  store.set("roles", SCOPE, { userId: "user1", role: "owner" });
  store.set("receipts", "intent1", receipt);
  store.set("intents", "intent1", {
    intentId: "intent1",
    writerId: "writer1",
    base: OLD_CUT,
  });
  store.set("identity.sessions", "session1", {
    sessionId: "session1",
    deviceId: "device1",
    writerId: "writer1",
    active: true,
    credential: { token: "secret-token", active: true },
  });
  store.set("identity.devices", "device1", {
    deviceId: "device1",
    userId: "user1",
    active: true,
    revoked: false,
  });
  store.blobPut(SCOPE, blobHash, bytes);

  return { store, bytes, blobHash, receipt };
}

describe("shared runtime backup", () => {
  it("exports a signed full manifest with actual blob bytes", () => {
    const { store, bytes, blobHash } = source();
    const backup = exportBackup(store);

    expect(backup.format).toBe("folio-shared-runtime-backup/1");
    expect(backup.head).toEqual(OLD_CUT);
    expect(backup.records).toHaveLength(7);
    expect(backup.blobs).toEqual([
      {
        scope: SCOPE,
        hash: blobHash,
        base64: Buffer.from(bytes).toString("base64"),
      },
    ]);
    expect(backup.hash).toMatch(/^[a-f0-9]{64}$/);

    const { hash: _hash, ...manifest } = backup;
    expect(createHash("sha256").update(canonical(manifest)).digest("hex")).toBe(
      backup.hash,
    );
    store.close();
  });

  it("restores bytes, roles, documents and receipts in a fresh epoch", () => {
    const { store, bytes, blobHash, receipt } = source();
    const backup = exportBackup(store);
    const before = JSON.stringify(backup);
    const destination = new TestStore();

    const result = restoreBackup(backup, destination, "epoch-new");

    expect(result.oldCut).toEqual(OLD_CUT);
    expect(result.hash).toBe(backup.hash);
    expect(result.newCut).toMatchObject({ epoch: "epoch-new", seq: 0 });
    expect(result.newCut.hash).toMatch(/^[a-f0-9]{64}$/);

    expect(destination.get("meta", "head")).toEqual(result.newCut);
    expect(destination.get("meta", "restore")).toEqual({
      originalCut: OLD_CUT,
      epoch: "epoch-new",
      backupHash: backup.hash,
      requiresReauthorization: true,
    });
    expect(destination.get("documents", SCOPE)).toEqual({
      schemaVersion: 1,
      document: DOCUMENT,
    });
    expect(destination.get("roles", SCOPE)).toEqual({
      userId: "user1",
      role: "owner",
    });
    expect(destination.get("receipts", "intent1")).toEqual(receipt);
    expect(destination.get("intents", "intent1")).toEqual({
      intentId: "intent1",
      writerId: "writer1",
      base: OLD_CUT,
    });

    expect(destination.get("identity.sessions", "session1")).toEqual({
      sessionId: "session1",
      deviceId: "device1",
      writerId: "writer1",
      active: false,
      revoked: true,
      credential: { token: "secret-token", active: false, revoked: true },
    });
    expect(destination.get("identity.devices", "device1")).toEqual({
      deviceId: "device1",
      userId: "user1",
      active: false,
      revoked: true,
    });
    expect(destination.blobGet(SCOPE, blobHash)).toEqual(bytes);
    expect(JSON.stringify(backup)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    store.close();
    destination.close();
  });

  it("reopens a restored SQLite destination and keeps head, records and blobs", () => {
    const { store, bytes, blobHash } = source();
    const backup = exportBackup(store);
    const directory = mkdtempSync(join(tmpdir(), "folio-runtime-backup-"));
    const path = join(directory, "runtime.sqlite");
    try {
      const destination = new TestStore(path);
      const result = restoreBackup(backup, destination, "epoch-reopen");
      destination.close();

      const reopened = new TestStore(path);
      expect(reopened.get("meta", "head")).toEqual(result.newCut);
      expect(reopened.get("roles", SCOPE)).toEqual({
        userId: "user1",
        role: "owner",
      });
      expect(reopened.get("identity.sessions", "session1")).toMatchObject({
        active: false,
        revoked: true,
      });
      expect(reopened.blobGet(SCOPE, blobHash)).toEqual(bytes);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
      store.close();
    }
  });

  it("rejects a manifest with a corrupted hash and leaves the destination empty", () => {
    const { store } = source();
    const backup = exportBackup(store);
    const tampered = cloneBackup(backup);
    tampered.hash = "0".repeat(64);
    const destination = new TestStore();

    expect(() => restoreBackup(tampered, destination, "epoch-new")).toThrow(
      "BACKUP_HASH_MISMATCH",
    );
    expect(destination.count("runtime_records")).toBe(0);
    expect(destination.count("runtime_blobs")).toBe(0);
    store.close();
    destination.close();
  });

  it("rejects a corrupted blob and duplicate row/blob keys before writing anything", () => {
    const { store } = source();
    const backup = exportBackup(store);

    const corruptedBlob = cloneBackup(backup);
    corruptedBlob.blobs[0].base64 =
      Buffer.from("different bytes").toString("base64");
    const first = new TestStore();
    expect(() => restoreBackup(corruptedBlob, first, "epoch-a")).toThrow(
      "BLOB_HASH_MISMATCH",
    );
    expect(first.count("runtime_records")).toBe(0);
    first.close();

    const duplicateRecord = cloneBackup(backup);
    duplicateRecord.records.push({ ...duplicateRecord.records[0] });
    const second = new TestStore();
    expect(() =>
      restoreBackup(signed(duplicateRecord), second, "epoch-b"),
    ).toThrow("DUPLICATE_RECORD");
    expect(second.count("runtime_records")).toBe(0);
    second.close();

    const duplicateBlob = cloneBackup(backup);
    duplicateBlob.blobs.push({ ...duplicateBlob.blobs[0] });
    const third = new TestStore();
    expect(() =>
      restoreBackup(signed(duplicateBlob), third, "epoch-c"),
    ).toThrow("DUPLICATE_BLOB");
    expect(third.count("runtime_records")).toBe(0);
    third.close();
    store.close();
  });

  it("rolls back every inserted row and blob when a write fails mid-restore", () => {
    const { store } = source();
    const backup = exportBackup(store);
    const destination = new FailingStore("roles");

    expect(() => restoreBackup(backup, destination, "epoch-fail")).toThrow(
      "injected write failure",
    );
    expect(destination.count("runtime_records")).toBe(0);
    expect(destination.count("runtime_blobs")).toBe(0);
    expect(destination.get("meta", "head")).toBeNull();
    store.close();
    destination.close();
  });

  it("refuses a non-empty destination and an old or invalid epoch", () => {
    const { store } = source();
    const backup = exportBackup(store);

    const destination = new TestStore();
    destination.set("legacy", "row", { kept: true });
    expect(() => restoreBackup(backup, destination, "epoch-new")).toThrow(
      "DESTINATION_NOT_EMPTY",
    );
    expect(destination.get("legacy", "row")).toEqual({ kept: true });
    expect(destination.get("meta", "head")).toBeNull();
    destination.close();

    const fresh = new TestStore();
    expect(() => restoreBackup(backup, fresh, OLD_CUT.epoch)).toThrow(
      "EPOCH_NOT_FRESH",
    );
    expect(() => restoreBackup(backup, fresh, "bad epoch")).toThrow(
      "INVALID_ID",
    );
    expect(fresh.count("runtime_records")).toBe(0);
    fresh.close();
    store.close();
  });

  it("refuses to export blob rows whose bytes do not match the stored hash", () => {
    const { store } = source();
    store.blobPut("other-scope", "f".repeat(64), new TextEncoder().encode("x"));
    expect(() => exportBackup(store)).toThrow("BLOB_HASH_MISMATCH");
    store.close();
  });
});
