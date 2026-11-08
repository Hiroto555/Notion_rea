import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { SyncError } from "../src/sync/protocol";
import type {
  BlobTransferDescriptor,
  BlobTransferLimits,
  BlobTransferScope,
} from "../src/sync/blob-transfer-types";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const directoryHash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const roots: string[] = [];
const openJournals: BlobTransferJournal[] = [];

function makeRoot() {
  const directory = mkdtempSync(join(tmpdir(), "folio-blob-journal-"));
  roots.push(directory);
  return directory;
}

function scope(overrides: Partial<BlobTransferScope> = {}): BlobTransferScope {
  return {
    baseUrlHash: sha("https://example.test"),
    workspaceId: "workspace-1",
    clientId: "client-1",
    bindingId: "binding-1",
    serverEpoch: "epoch-1",
    ...overrides,
  };
}

function descriptor(
  overrides: Partial<BlobTransferDescriptor> = {},
): BlobTransferDescriptor {
  return {
    direction: "download",
    assetId: "asset-1",
    sha256: sha("asset-1"),
    bytes: 16,
    ...overrides,
  };
}

function open(
  directory: string,
  options: {
    scope?: BlobTransferScope;
    limits?: Partial<BlobTransferLimits>;
  } = {},
) {
  const journal = new BlobTransferJournal(
    directory,
    options.scope ?? scope(),
    options.limits,
  );
  openJournals.push(journal);
  return journal;
}

function errorText(error: unknown) {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const message = typeof value?.message === "string" ? value.message : "";
  return `${code} ${message}`;
}

function expectSyncError(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SyncError);
  expect(errorText(caught)).toContain(code);
  return caught as SyncError;
}

afterEach(() => {
  for (const journal of openJournals.splice(0)) {
    try {
      journal.close();
    } catch {}
  }
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("blob transfer journal adversarial", () => {
  it("reopens with every state and checkpoint intact", () => {
    const directory = makeRoot();
    const first = open(directory);
    const active = first.begin(
      descriptor({ assetId: "asset-active", bytes: 32, sha256: sha("active") }),
    );
    expect(first.checkpoint(active.key, 12, sha("active-12")).offset).toBe(12);
    const completed = first.begin(
      descriptor({
        assetId: "asset-complete",
        bytes: 9,
        sha256: sha("complete"),
      }),
    );
    first.complete(completed.key);
    const blocked = first.begin(
      descriptor({
        assetId: "asset-blocked",
        bytes: 4,
        sha256: sha("blocked"),
      }),
    );
    first.block(blocked.key, "network");
    first.close();

    const second = open(directory);
    const byAsset = Object.fromEntries(
      second.inventory().map((record) => [record.assetId, record]),
    );
    expect(Object.keys(byAsset).sort()).toEqual([
      "asset-active",
      "asset-blocked",
      "asset-complete",
    ]);
    expect(byAsset["asset-active"]).toMatchObject({
      state: "active",
      offset: 12,
      prefixHash: sha("active-12"),
    });
    expect(byAsset["asset-complete"]).toMatchObject({
      state: "completed",
      offset: 9,
      prefixHash: sha("complete"),
    });
    expect(byAsset["asset-blocked"]).toMatchObject({
      state: "blocked",
      reason: "network",
    });
    expect(second.get(active.key)?.assetId).toBe("asset-active");
    expect(second.get("0".repeat(64))).toBeNull();
  });

  it("rejects a different client scope without changing journal bytes", () => {
    const directory = makeRoot();
    const journal = open(directory);
    journal.begin(descriptor());
    journal.close();
    const before = directoryHash(join(directory, "state.sqlite"));
    expectSyncError(
      () => new BlobTransferJournal(directory, scope({ clientId: "client-2" })),
      "blob-transfer-scope-mismatch",
    );
    expect(directoryHash(join(directory, "state.sqlite"))).toBe(before);
  });

  it("rejects a different server epoch without changing journal bytes", () => {
    const directory = makeRoot();
    const journal = open(directory);
    journal.begin(descriptor());
    journal.close();
    const before = directoryHash(join(directory, "state.sqlite"));
    expectSyncError(
      () =>
        new BlobTransferJournal(directory, scope({ serverEpoch: "epoch-2" })),
      "blob-transfer-scope-mismatch",
    );
    expect(directoryHash(join(directory, "state.sqlite"))).toBe(before);
  });

  it("rejects strictly corrupt records and preserves database bytes", () => {
    const mutations: Array<(record: Record<string, unknown>) => void> = [
      (record) => {
        record.extra = true;
      },
      (record) => {
        record.offset = Number(record.bytes) + 1;
      },
      (record) => {
        record.key = sha("wrong-key");
      },
      (record) => {
        record.state = "completed";
      },
    ];
    for (const mutate of mutations) {
      const directory = makeRoot();
      const journal = open(directory);
      journal.begin(
        descriptor({
          assetId: "corrupt-me",
          bytes: 8,
          sha256: sha("corrupt"),
        }),
      );
      journal.close();
      const database = new DatabaseSync(join(directory, "state.sqlite"));
      const row = database
        .prepare("SELECT key,data FROM blob_transfers LIMIT 1")
        .get() as { key: string; data: string };
      const record = JSON.parse(row.data) as Record<string, unknown>;
      mutate(record);
      database
        .prepare("UPDATE blob_transfers SET data=? WHERE key=?")
        .run(JSON.stringify(record), row.key);
      database.close();
      const before = directoryHash(join(directory, "state.sqlite"));
      expectSyncError(
        () => new BlobTransferJournal(directory, scope()),
        "blob-transfer-corrupt",
      );
      expect(directoryHash(join(directory, "state.sqlite"))).toBe(before);
    }
  });

  it("rejects an unknown table and preserves the existing database bytes", () => {
    const directory = makeRoot();
    const journal = open(directory);
    journal.begin(descriptor({ assetId: "keep-me" }));
    journal.close();
    const database = new DatabaseSync(join(directory, "state.sqlite"));
    database.exec("CREATE TABLE foreign_table(value TEXT)");
    database.close();
    const before = directoryHash(join(directory, "state.sqlite"));
    expectSyncError(
      () => new BlobTransferJournal(directory, scope()),
      "blob-transfer-corrupt",
    );
    expect(directoryHash(join(directory, "state.sqlite"))).toBe(before);
  });

  it("rejects symlinked roots and hardlinked journals, including live hardlinks", () => {
    const real = makeRoot();
    const parent = makeRoot();
    const linked = join(parent, "linked-root");
    symlinkSync(real, linked, "dir");
    expectSyncError(
      () => new BlobTransferJournal(linked, scope()),
      "unsafe-blob-transfer-root",
    );

    const directory = makeRoot();
    const journal = open(directory);
    journal.begin(descriptor({ assetId: "linked-journal" }));
    journal.close();
    const databasePath = join(directory, "state.sqlite");
    linkSync(databasePath, join(directory, "state.alias"));
    expectSyncError(
      () => new BlobTransferJournal(directory, scope()),
      "unsafe-blob-transfer-journal",
    );

    rmSync(join(directory, "state.alias"));
    const live = open(directory);
    live.begin(descriptor({ assetId: "still-live" }));
    linkSync(databasePath, join(directory, "live.alias"));
    expectSyncError(() => live.inventory(), "unsafe-blob-transfer-journal");
  });

  it("holds an owner lock until close and then releases it", () => {
    const directory = makeRoot();
    const owner = open(directory);
    const record = owner.begin(descriptor({ assetId: "locked" }));
    expectSyncError(
      () => new BlobTransferJournal(directory, scope()),
      "blob-transfer-locked",
    );
    owner.close();
    const next = open(directory);
    expect(next.inventory().map((row) => row.key)).toContain(record.key);
  });

  it("enforces descriptor shape, zero size, and the 20MB ceiling", () => {
    const directory = makeRoot();
    const journal = open(directory);
    const missing: Record<string, unknown> = { ...descriptor() };
    delete missing.sha256;
    const bad: BlobTransferDescriptor[] = [
      descriptor({ bytes: -1 }),
      descriptor({ bytes: 1.5 }),
      descriptor({ bytes: 20_000_001 }),
      descriptor({ sha256: "abc" }),
      descriptor({ assetId: "../escape" }),
      descriptor({ assetId: ".hidden" }),
      descriptor({
        direction: "sideways" as BlobTransferDescriptor["direction"],
      }),
      { ...descriptor(), extra: true } as unknown as BlobTransferDescriptor,
      missing as unknown as BlobTransferDescriptor,
    ];
    for (const candidate of bad) {
      expectSyncError(
        () => journal.begin(candidate),
        "invalid-blob-transfer-descriptor",
      );
    }
    expect(
      journal.begin(
        descriptor({ assetId: "empty", bytes: 0, sha256: sha("empty") }),
      ).bytes,
    ).toBe(0);
    expect(
      journal.begin(
        descriptor({
          assetId: "ceiling",
          bytes: 20_000_000,
          sha256: sha("ceiling"),
        }),
      ).bytes,
    ).toBe(20_000_000);
  });

  it("enforces monotonic offsets and prefix hashes at the boundaries", () => {
    const directory = makeRoot();
    const journal = open(directory);
    const record = journal.begin(
      descriptor({ assetId: "offsets", bytes: 8, sha256: sha("offsets") }),
    );
    const invalid = [
      [9, sha("nine")],
      [-1, sha("negative")],
      [1.5, sha("fractional")],
    ] as const;
    for (const [offset, prefixHash] of invalid) {
      expectSyncError(
        () => journal.checkpoint(record.key, offset, prefixHash),
        "invalid-blob-transfer-checkpoint",
      );
    }
    expect(journal.checkpoint(record.key, 4, sha("four")).offset).toBe(4);
    expectSyncError(
      () => journal.checkpoint(record.key, 3, sha("three")),
      "invalid-blob-transfer-checkpoint",
    );
    expectSyncError(
      () => journal.checkpoint(record.key, 4, sha("different")),
      "invalid-blob-transfer-checkpoint",
    );
    expect(journal.checkpoint(record.key, 8, sha("eight")).offset).toBe(8);
    expect(journal.checkpoint(record.key, 8, sha("eight")).offset).toBe(8);
    expectSyncError(
      () => journal.checkpoint("f".repeat(64), 0, sha("missing")),
      "blob-transfer-missing",
    );
  });

  it("enforces entry and byte quotas while excluding completed bytes", () => {
    const entryDirectory = makeRoot();
    const entries = open(entryDirectory, { limits: { maxEntries: 2 } });
    const first = entries.begin(
      descriptor({ assetId: "entry-a", bytes: 1, sha256: sha("entry-a") }),
    );
    entries.begin(
      descriptor({ assetId: "entry-b", bytes: 1, sha256: sha("entry-b") }),
    );
    expectSyncError(
      () =>
        entries.begin(
          descriptor({
            assetId: "entry-c",
            bytes: 1,
            sha256: sha("entry-c"),
          }),
        ),
      "blob-transfer-limit",
    );
    entries.complete(first.key);
    expectSyncError(
      () =>
        entries.begin(
          descriptor({
            assetId: "entry-c",
            bytes: 1,
            sha256: sha("entry-c"),
          }),
        ),
      "blob-transfer-limit",
    );
    expect(entries.compactCompleted()).toBe(1);
    expect(
      entries.begin(
        descriptor({ assetId: "entry-c", bytes: 1, sha256: sha("entry-c") }),
      ).assetId,
    ).toBe("entry-c");

    const byteDirectory = makeRoot();
    const bytes = open(byteDirectory, { limits: { maxBytes: 10 } });
    const six = bytes.begin(
      descriptor({ assetId: "bytes-six", bytes: 6, sha256: sha("six") }),
    );
    expectSyncError(
      () =>
        bytes.begin(
          descriptor({
            assetId: "bytes-five",
            bytes: 5,
            sha256: sha("five"),
          }),
        ),
      "blob-transfer-limit",
    );
    bytes.complete(six.key);
    expect(
      bytes.begin(
        descriptor({ assetId: "bytes-five", bytes: 5, sha256: sha("five") }),
      ).bytes,
    ).toBe(5);
    expectSyncError(
      () =>
        bytes.begin(
          descriptor({
            assetId: "bytes-six-more",
            bytes: 6,
            sha256: sha("six-more"),
          }),
        ),
      "blob-transfer-limit",
    );
  });

  it("guards invalid state transitions", () => {
    const directory = makeRoot();
    const journal = open(directory);
    const blocked = journal.begin(
      descriptor({ assetId: "blocked", sha256: sha("blocked") }),
    );
    expectSyncError(
      () => journal.block(blocked.key, "Bad Reason"),
      "invalid-blob-transfer-reason",
    );
    expect(journal.block(blocked.key, "network").state).toBe("blocked");
    expectSyncError(
      () =>
        journal.begin(
          descriptor({ assetId: "blocked", sha256: sha("blocked") }),
        ),
      "blob-transfer-blocked",
    );
    expectSyncError(
      () => journal.complete(blocked.key),
      "blob-transfer-blocked",
    );
    expectSyncError(
      () => journal.checkpoint(blocked.key, 0, sha("blocked")),
      "invalid-blob-transfer-checkpoint",
    );

    const completed = journal.begin(
      descriptor({ assetId: "completed", sha256: sha("completed") }),
    );
    journal.complete(completed.key);
    expectSyncError(
      () => journal.block(completed.key, "late"),
      "blob-transfer-completed",
    );
    expect(journal.get(blocked.key)?.reason).toBe("network");
  });

  it("compacts only completed rows and never removes any file", () => {
    const directory = makeRoot();
    const journal = open(directory);
    const active = journal.begin(
      descriptor({ assetId: "active", sha256: sha("active") }),
    );
    const completed = journal.begin(
      descriptor({ assetId: "complete", sha256: sha("complete") }),
    );
    const blocked = journal.begin(
      descriptor({ assetId: "blocked", sha256: sha("blocked") }),
    );
    journal.complete(completed.key);
    journal.block(blocked.key, "offline");
    const partPath = join(directory, `${completed.key}.part`);
    const sentinel = join(directory, "unrelated.bin");
    writeFileSync(partPath, "completed-part-bytes");
    writeFileSync(sentinel, "sentinel");
    const before = readdirSync(directory);
    expect(journal.compactCompleted()).toBe(1);
    for (const name of before) {
      expect(existsSync(join(directory, name))).toBe(true);
    }
    expect(readFileSync(partPath, "utf8")).toBe("completed-part-bytes");
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
    expect(journal.get(completed.key)).toBeNull();
    expect(journal.get(active.key)?.state).toBe("active");
    expect(journal.get(blocked.key)?.state).toBe("blocked");
    journal.close();

    const reopened = open(directory);
    expect(
      reopened
        .inventory()
        .map((row) => row.assetId)
        .sort(),
    ).toEqual(["active", "blocked"]);
  });
});
