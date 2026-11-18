import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TransferMaintenanceEntry,
  TransferMaintenanceView,
} from "../src/shared/sync-management";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import type { BlobTransferDescriptor } from "../src/sync/blob-transfer-types";
import { SyncError } from "../src/sync/protocol";
import { inspectTransferCacheCatalog } from "../src/sync/transfer-cache-catalog";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
const journals: BlobTransferJournal[] = [];

function makeWorkspace(): string {
  const workspace = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-catalog-")),
  );
  roots.push(workspace);
  return workspace;
}

function ensurePrivate(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function cacheRoot(workspace: string): string {
  return join(workspace, ".folio-sync-transfers");
}

function ensureScope(workspace: string, scopeHash: string): string {
  ensurePrivate(cacheRoot(workspace));
  return ensurePrivate(join(cacheRoot(workspace), scopeHash));
}

function journalDirectory(
  workspace: string,
  scopeHash: string,
  index: number,
): string {
  ensureScope(workspace, scopeHash);
  return ensurePrivate(
    join(cacheRoot(workspace), scopeHash, `download-${sha(`${scopeHash}:${index}`)}`),
  );
}

function descriptor(
  assetId: string,
  overrides: Partial<BlobTransferDescriptor> = {},
): BlobTransferDescriptor {
  return {
    direction: "download",
    assetId,
    sha256: sha(assetId),
    bytes: 32,
    ...overrides,
  };
}

function openJournal(directory: string, scopeHash: string): BlobTransferJournal {
  const journal = new BlobTransferJournal(directory, { scopeHash });
  journals.push(journal);
  return journal;
}

function createEmptyJournal(
  workspace: string,
  scopeHash: string,
  index: number,
): string {
  const directory = journalDirectory(workspace, scopeHash, index);
  openJournal(directory, scopeHash).close();
  return directory;
}

function entryByAsset(
  view: TransferMaintenanceView,
  assetId: string,
): TransferMaintenanceEntry {
  const entry = view.entries.find((candidate) => candidate.assetId === assetId);
  expect(entry).toBeDefined();
  return entry!;
}

function entryByScope(
  view: TransferMaintenanceView,
  scopeHash: string,
): TransferMaintenanceEntry {
  const entry = view.entries.find((candidate) => candidate.scopeHash === scopeHash);
  expect(entry).toBeDefined();
  return entry!;
}

function expectSyncError(fn: () => unknown, code: string): SyncError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    const syncError = error as SyncError;
    expect(syncError.code).toBe(code);
    expect(syncError.status).toBe(409);
    return syncError;
  }
  throw new Error(`expected SyncError ${code}`);
}

afterEach(() => {
  for (const journal of journals.splice(0)) {
    try {
      journal.close();
    } catch {}
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("inspectTransferCacheCatalog", () => {
  it("returns an empty read-only view when the cache root is absent", () => {
    const workspace = makeWorkspace();

    expect(inspectTransferCacheCatalog(workspace, null)).toEqual({
      entries: [],
      nextCursor: null,
      usedBytes: 0,
      overLimit: false,
      held: null,
    });
  });

  it("retires empty current scopes only while leaving old scopes releasable", () => {
    const workspace = makeWorkspace();
    const current = sha("current-scope");
    const old = sha("old-scope");
    createEmptyJournal(workspace, current, 0);
    createEmptyJournal(workspace, old, 0);

    const view = inspectTransferCacheCatalog(workspace, current);

    expect(view.entries).toHaveLength(2);
    expect(entryByScope(view, current)).toMatchObject({
      state: "empty-scope",
      assetId: null,
      currentScope: true,
      canRelease: false,
      reason: "current-scope",
    });
    expect(entryByScope(view, old)).toMatchObject({
      state: "empty-scope",
      assetId: null,
      currentScope: false,
      canRelease: true,
      reason: null,
    });
    expect(view.nextCursor).toBeNull();
    expect(view.held).toBeNull();
    expect(view.usedBytes).toBeGreaterThan(0);
    expect(view.overLimit).toBe(false);
  });

  it("reports active, blocked and releasing records including a missing partial", () => {
    const workspace = makeWorkspace();
    const scope = sha("state-scope");
    const directory = journalDirectory(workspace, scope, 0);
    const journal = openJournal(directory, scope);
    const active = journal.begin(
      descriptor("asset-active", { bytes: 16, sha256: sha("active") }),
    );
    writeFileSync(join(directory, active.partialName), "abc");
    const blocked = journal.begin(
      descriptor("asset-blocked", { bytes: 20, sha256: sha("blocked") }),
    );
    journal.block(blocked.key, "network");
    const releasing = journal.begin(
      descriptor("asset-releasing", { bytes: 24, sha256: sha("releasing") }),
    );
    const operationId = randomUUID();
    journal.markRelease(releasing, operationId);
    journal.close();

    const view = inspectTransferCacheCatalog(workspace, scope);

    expect(entryByAsset(view, "asset-active")).toMatchObject({
      state: "active",
      bytes: 3,
      offset: 0,
      currentScope: true,
      canRelease: true,
      reason: null,
    });
    expect(entryByAsset(view, "asset-blocked")).toMatchObject({
      state: "blocked",
      bytes: 0,
      offset: 0,
      currentScope: true,
      canRelease: true,
      reason: "network",
    });
    const releasingEntry = entryByAsset(view, "asset-releasing");
    expect(releasingEntry).toMatchObject({
      state: "releasing",
      bytes: 0,
      offset: 0,
      currentScope: true,
      canRelease: false,
      reason: operationId,
      operationId,
    });
    expect(view.entries).toHaveLength(3);
    expect(view.nextCursor).toBeNull();
    expect(view.held).toBeNull();
  });

  it("pages more than fifty records without duplicates or omissions", () => {
    const workspace = makeWorkspace();
    const scope = sha("pagination-scope");
    const directory = journalDirectory(workspace, scope, 0);
    const journal = openJournal(directory, scope);
    const assetIds: string[] = [];
    for (let index = 0; index < 57; index++) {
      const assetId = `asset-${String(index).padStart(3, "0")}`;
      assetIds.push(assetId);
      journal.begin(
        descriptor(assetId, { bytes: 1, sha256: sha(`pagination-${index}`) }),
      );
    }
    journal.close();

    const first = inspectTransferCacheCatalog(workspace, scope);
    expect(first.entries).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();

    const collected = [...first.entries];
    let cursor = first.nextCursor;
    for (let page = 0; cursor && page < 5; page++) {
      const next = inspectTransferCacheCatalog(workspace, scope, cursor);
      expect(next.entries.length).toBeGreaterThan(0);
      collected.push(...next.entries);
      cursor = next.nextCursor;
    }

    expect(cursor).toBeNull();
    expect(collected).toHaveLength(assetIds.length);
    expect(new Set(collected.map((entry) => entry.entryId)).size).toBe(
      assetIds.length,
    );
    expect(collected.map((entry) => entry.assetId).sort()).toEqual(
      assetIds.sort(),
    );
  });

  it("advances past more than thirty-two empty journals with a cursor", () => {
    const workspace = makeWorkspace();
    const scope = sha("many-empty-scopes");
    for (let index = 0; index < 70; index++)
      createEmptyJournal(workspace, scope, index);

    const first = inspectTransferCacheCatalog(workspace, null);
    expect(first.entries).toHaveLength(32);
    expect(first.entries.every((entry) => entry.state === "empty-scope")).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const collected = [...first.entries];
    let cursor = first.nextCursor;
    let pages = 0;
    while (cursor && pages < 10) {
      const next = inspectTransferCacheCatalog(workspace, null, cursor);
      collected.push(...next.entries);
      cursor = next.nextCursor;
      pages++;
    }

    expect(cursor).toBeNull();
    expect(collected).toHaveLength(70);
    expect(new Set(collected.map((entry) => entry.entryId)).size).toBe(70);
    expect(collected.every((entry) => entry.state === "empty-scope")).toBe(true);
  });

  it("rejects malformed cursors and scope hashes before inspecting the cache", () => {
    const workspace = makeWorkspace();
    const validHash = "a".repeat(64);
    const validJournal = "download-" + "b".repeat(64);
    const malformedCursors = [
      "not-a-cursor",
      `${validHash}/${validJournal}`,
      `${validHash}/${validJournal}/nope`,
      `${validHash}/${validJournal}/!extra`,
      `${"A".repeat(64)}/${validJournal}/!`,
      `${validHash}/other-${"b".repeat(64)}/!`,
      `${validHash}/${validJournal}/${"c".repeat(63)}`,
    ];
    for (const cursor of malformedCursors)
      expectSyncError(
        () => inspectTransferCacheCatalog(workspace, null, cursor),
        "cache-inventory-cursor",
      );

    for (const scopeHash of ["", "short", "A".repeat(64), "g".repeat(64)])
      expectSyncError(
        () => inspectTransferCacheCatalog(workspace, scopeHash),
        "cache-inventory-scope",
      );
  });

  it("diagnoses a journal created for a foreign scope and a non-database state file", () => {
    const workspace = makeWorkspace();
    const originalScope = sha("original-scope");
    const foreignScope = sha("foreign-scope");
    const source = journalDirectory(workspace, originalScope, 0);
    const journal = openJournal(source, originalScope);
    const record = journal.begin(descriptor("foreign-asset", { bytes: 9 }));
    journal.close();
    const destination = join(
      ensureScope(workspace, foreignScope),
      "download-" + sha("foreign-journal"),
    );
    renameSync(source, destination);
    const partial = join(destination, record.partialName);
    writeFileSync(partial, "foreign-bytes");

    const malformedScope = sha("malformed-db-scope");
    const malformed = journalDirectory(workspace, malformedScope, 1);
    writeFileSync(join(malformed, "state.sqlite"), "not a sqlite database");

    const view = inspectTransferCacheCatalog(workspace, originalScope);

    expect(view.held).toBe("journal-unavailable");
    const foreign = view.entries.find(
      (entry) => entry.scopeHash === foreignScope && entry.state === "unknown",
    );
    expect(foreign).toMatchObject({
      scopeHash: foreignScope,
      assetId: null,
      bytes: 0,
      state: "unknown",
      currentScope: false,
      canRelease: false,
      reason: "journal-unavailable",
    });
    const malformedEntry = view.entries.find(
      (entry) => entry.scopeHash === malformedScope && entry.state === "unknown",
    );
    expect(malformedEntry).toMatchObject({
      scopeHash: malformedScope,
      assetId: null,
      state: "unknown",
      canRelease: false,
      reason: "journal-unavailable",
    });
    expect(existsSync(partial)).toBe(true);
    expect(readFileSync(partial, "utf8")).toBe("foreign-bytes");
    expect(readFileSync(join(malformed, "state.sqlite"), "utf8")).toBe(
      "not a sqlite database",
    );
  });

  it("diagnoses symlinked and hardlinked partials without following or deleting them", () => {
    const outside = makeWorkspace();
    const symlinkTarget = join(outside, "symlink-target.bin");
    const hardlinkTarget = join(outside, "hardlink-target.bin");
    writeFileSync(symlinkTarget, "secret-target");
    writeFileSync(hardlinkTarget, "hard-target");

    const workspace = makeWorkspace();
    const scope = sha("unsafe-partial-scope");
    const directory = journalDirectory(workspace, scope, 0);
    const journal = openJournal(directory, scope);
    const linked = journal.begin(descriptor("asset-symlink", { bytes: 8 }));
    const hard = journal.begin(descriptor("asset-hardlink", { bytes: 8 }));
    const safe = journal.begin(descriptor("asset-safe", { bytes: 8 }));
    journal.close();

    symlinkSync(symlinkTarget, join(directory, linked.partialName));
    linkSync(hardlinkTarget, join(directory, hard.partialName));
    writeFileSync(join(directory, safe.partialName), "safe");

    const view = inspectTransferCacheCatalog(workspace, scope);

    expect(view.held).toBe("unsafe-cache-entry");
    expect(entryByAsset(view, "asset-symlink")).toMatchObject({
      state: "active",
      bytes: 0,
      canRelease: false,
      reason: "unsafe-partial",
    });
    expect(entryByAsset(view, "asset-hardlink")).toMatchObject({
      state: "active",
      bytes: 0,
      canRelease: false,
      reason: "unsafe-partial",
    });
    expect(entryByAsset(view, "asset-safe")).toMatchObject({
      state: "active",
      bytes: 4,
      canRelease: true,
      reason: null,
    });
    expect(lstatSync(join(directory, linked.partialName)).isSymbolicLink()).toBe(
      true,
    );
    expect(lstatSync(join(directory, hard.partialName)).nlink).toBe(2);
    expect(readFileSync(symlinkTarget, "utf8")).toBe("secret-target");
    expect(readFileSync(hardlinkTarget, "utf8")).toBe("hard-target");
  });

  it("diagnoses and preserves unknown files inside a journal", () => {
    const workspace = makeWorkspace();
    const scope = sha("unknown-file-scope");
    const directory = journalDirectory(workspace, scope, 0);
    const journal = openJournal(directory, scope);
    const record = journal.begin(descriptor("asset-known", { bytes: 8 }));
    journal.close();
    writeFileSync(join(directory, record.partialName), "known");
    const orphan = join(directory, "orphan.bin");
    writeFileSync(orphan, "orphan-kept");

    const view = inspectTransferCacheCatalog(workspace, scope);

    expect(view.held).toBe("unknown-cache-files");
    expect(entryByAsset(view, "asset-known")).toMatchObject({
      state: "active",
      bytes: 5,
      canRelease: true,
    });
    const unknown = view.entries.find((entry) => entry.state === "unknown");
    expect(unknown).toMatchObject({
      scopeHash: scope,
      assetId: null,
      bytes: 0,
      state: "unknown",
      canRelease: false,
      reason: "unknown-cache-files",
    });
    expect(existsSync(orphan)).toBe(true);
    expect(readFileSync(orphan, "utf8")).toBe("orphan-kept");
  });

  it("diagnoses and preserves unknown root and scope entries", () => {
    const workspace = makeWorkspace();
    const rootOrphan = join(ensurePrivate(cacheRoot(workspace)), "foreign.db");
    writeFileSync(rootOrphan, "root-kept");

    const rootView = inspectTransferCacheCatalog(workspace, null);
    expect(rootView.held).toBe("unknown-root-entry");
    expect(rootView.entries).toEqual([]);
    expect(readFileSync(rootOrphan, "utf8")).toBe("root-kept");

    rmSync(rootOrphan);

    const scope = sha("scope-with-unknown-entry");
    const scopeOrphan = join(ensureScope(workspace, scope), "notes.txt");
    writeFileSync(scopeOrphan, "scope-kept");

    const scopeView = inspectTransferCacheCatalog(workspace, null);
    expect(scopeView.held).toBe("unknown-scope-entry");
    expect(scopeView.entries).toEqual([]);
    expect(readFileSync(scopeOrphan, "utf8")).toBe("scope-kept");
  });

  it("is semantically read-only: records and files survive inspection", () => {
    const workspace = makeWorkspace();
    const scope = sha("read-only-scope");
    const directory = journalDirectory(workspace, scope, 0);
    const journal = openJournal(directory, scope);
    const record = journal.begin(descriptor("asset-kept", { bytes: 12 }));
    journal.close();
    const partial = join(directory, record.partialName);
    writeFileSync(partial, "partial-kept");
    const orphan = join(directory, "orphan.bin");
    writeFileSync(orphan, "orphan-kept");

    const before = openJournal(directory, scope).inventory();
    journals.at(-1)!.close();

    const view = inspectTransferCacheCatalog(workspace, scope);

    expect(entryByAsset(view, "asset-kept")).toMatchObject({
      state: "active",
      bytes: 12,
      offset: 0,
      currentScope: true,
    });
    expect(readFileSync(partial, "utf8")).toBe("partial-kept");
    expect(readFileSync(orphan, "utf8")).toBe("orphan-kept");
    expect(existsSync(partial)).toBe(true);
    expect(existsSync(orphan)).toBe(true);

    const after = openJournal(directory, scope).inventory();
    journals.at(-1)!.close();
    expect(after).toEqual(before);
  });
});
