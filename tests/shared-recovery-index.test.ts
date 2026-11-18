import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { DurableQueue } from "../src/collaboration/runtime/durable-queue";
import {
  scopeKey,
  type Scope,
} from "../src/collaboration/runtime/contract";
import {
  SharedRecoveryError,
  SharedRecoveryIndex,
  type SharedRecoveryFilter,
} from "../src/main/shared-recovery-index";

const ORIGIN = "https://folio.example.test";
const ORG = "org-alpha";
const USER = "user-alpha";

const scope: Scope = {
  orgId: ORG,
  workspaceId: "workspace-1",
  documentId: "document-1",
  incarnationId: "incarnation-1",
};

const cut = { epoch: "epoch-1", seq: 0, hash: "a".repeat(64) };

const command = {
  kind: "text" as const,
  blockId: "block-1",
  from: 0,
  to: 0,
  text: "hello",
  before: "",
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "folio-recovery-index-"));
}

function writerDirectory(root: string, name: string): string {
  return join(root, "writers", name);
}

function seedWriter(
  directory: string,
  writerId: string,
  options: {
    unknown?: boolean;
    editing?: boolean;
    role?: "client" | "resource-client";
  } = {},
): void {
  const store = new RuntimeStore(directory);
  try {
    const writerScope = { ...scope };
    store.transaction(() =>
      store.set("meta", "role", options.role ?? "client"),
    );
    const queue = new DurableQueue(store, {
      scope: writerScope,
      writerId,
    });
    const intent = {
      v: 1 as const,
      intentId: "intent-" + writerId,
      writerId,
      scope: writerScope,
      base: cut,
      command,
    };
    store.transaction(() => queue.enqueue(intent));
    const attempt = {
      v: 1 as const,
      attemptId: "attempt-" + writerId,
      intent,
      base: cut,
    };
    store.transaction(() => queue.attempt(attempt));
    if (options.unknown !== false)
      store.transaction(() =>
        queue.markUnknown(intent.intentId, attempt.attemptId),
      );
    if (options.editing !== false)
      store.transaction(() =>
        store.set("client.editing", scopeKey(writerScope) + ":" + writerId, {
          raw: JSON.stringify({ title: "retained raw draft" }),
          cut,
        }),
      );
  } finally {
    store.close();
  }
}

function remember(
  index: SharedRecoveryIndex,
  directory: string,
  writerId: string,
): string {
  return index.remember({
    origin: ORIGIN,
    orgId: ORG,
    userId: USER,
    writerId,
    directory,
    kind: "document",
  });
}

function filter(overrides: Partial<SharedRecoveryFilter> = {}): SharedRecoveryFilter {
  return { origin: ORIGIN, orgId: ORG, userId: USER, ...overrides };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SharedRecoveryError) return error.code;
    throw error;
  }
  throw new Error("expected failure");
}

describe("SharedRecoveryIndex", () => {
  it("reads previous-writer raw recovery without replaying, rewriting or merging", () => {
    const root = tempRoot();
    const directory = writerDirectory(root, "writer-a");
    seedWriter(directory, "writer-a");
    const storeFile = join(directory, "shared-runtime.sqlite");

    const index = new SharedRecoveryIndex(root);
    expect(index.list(filter())).toEqual([]);
    expect(existsSync(join(root, "shared-recovery-index.sqlite"))).toBe(false);

    const entryId = remember(index, directory, "writer-a");
    expect(entryId).toMatch(/^rec_[0-9a-f]{64}$/);

    const summaries = index.list(filter());
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary.entryId).toBe(entryId);
    expect(summary.status).toBe("OK");
    expect(summary.pendingCount).toBe(1);
    expect(summary.unknownCount).toBe(1);
    expect(summary.selectedScope).toEqual(scope);
    expect(summary.rawFlags).toMatchObject({
      queue: true,
      editing: true,
      unknown: true,
    });

    const beforeBytes = readFileSync(storeFile);
    const beforeEntries = readdirSync(directory).sort();
    const data = index.read(entryId, filter());
    expect(data.writerId).toBe("writer-a");
    expect(data.queue).toHaveLength(1);
    expect(data.queue[0].state).toBe("UNKNOWN");
    expect(data.queue[0].attempts[0].state).toBe("UNKNOWN");
    expect(data.records.some((record) => record.namespace === "client.editing"))
      .toBe(true);
    expect(
      data.records.find((record) => record.namespace === "client.queue")?.raw,
    ).toContain("intent-writer-a");
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.queue[0])).toBe(true);

    // A read is inspection only: no file rewrite, no new sidecar, no UNKNOWN
    // transition, no replay.
    expect(readFileSync(storeFile).equals(beforeBytes)).toBe(true);
    expect(readdirSync(directory).sort()).toEqual(beforeEntries);
    const again = index.read(entryId, filter());
    expect(JSON.stringify(again)).toBe(JSON.stringify(data));
  });

  it("lets a later writer of the same user read previous writer raw", () => {
    const root = tempRoot();
    const directoryA = writerDirectory(root, "writer-a");
    const directoryB = writerDirectory(root, "writer-b");
    seedWriter(directoryA, "writer-a");
    seedWriter(directoryB, "writer-b");

    const index = new SharedRecoveryIndex(root);
    remember(index, directoryA, "writer-a");
    remember(index, directoryB, "writer-b");

    const summaries = index.list(filter());
    expect(summaries.map((summary) => summary.writerId).sort()).toEqual([
      "writer-a",
      "writer-b",
    ]);
    const previous = summaries.find(
      (summary) => summary.writerId === "writer-a",
    );
    expect(previous).toBeDefined();
    const data = index.read(previous!.entryId, filter());
    expect(data.writerId).toBe("writer-a");
    expect(data.kind).toBe("document");
    expect(data.queue[0].intent.writerId).toBe("writer-a");
  });

  it("denies another org or user without revealing or clearing metadata", () => {
    const root = tempRoot();
    const directory = writerDirectory(root, "writer-a");
    seedWriter(directory, "writer-a");
    const index = new SharedRecoveryIndex(root);
    const entryId = remember(index, directory, "writer-a");

    expect(index.list(filter({ orgId: "org-beta" }))).toEqual([]);
    expect(index.list(filter({ userId: "user-beta" }))).toEqual([]);
    expect(codeOf(() => index.read(entryId, filter({ orgId: "org-beta" }))))
      .toBe("RECOVERY_ENTRY_DENIED");
    expect(codeOf(() => index.read(entryId, filter({ userId: "user-beta" }))))
      .toBe("RECOVERY_ENTRY_DENIED");

    const still = index.list(filter());
    expect(still).toHaveLength(1);
    expect(still[0].entryId).toBe(entryId);
    expect(still[0].status).toBe("OK");
  });

  it("reports a missing store and never creates it or clears metadata", () => {
    const root = tempRoot();
    const directory = writerDirectory(root, "writer-a");
    seedWriter(directory, "writer-a");
    const storeFile = join(directory, "shared-runtime.sqlite");
    const index = new SharedRecoveryIndex(root);
    const entryId = remember(index, directory, "writer-a");

    const missingDirectory = writerDirectory(root, "writer-missing");
    expect(
      codeOf(() =>
        remember(index, missingDirectory, "writer-missing"),
      ),
    ).toBe("RECOVERY_STORE_MISSING");
    expect(existsSync(missingDirectory)).toBe(false);

    const emptyDirectory = writerDirectory(root, "writer-empty");
    mkdirSync(emptyDirectory, { recursive: true });
    remember(index, emptyDirectory, "writer-empty");
    const emptySummary = index
      .list(filter())
      .find((summary) => summary.writerId === "writer-empty");
    expect(emptySummary?.status).toBe("MISSING");
    expect(
      existsSync(join(emptyDirectory, "shared-runtime.sqlite")),
    ).toBe(false);

    unlinkSync(storeFile);
    const summary = index
      .list(filter())
      .find((candidate) => candidate.entryId === entryId)!;
    expect(summary.status).toBe("MISSING");
    expect(summary.error).toBe("RECOVERY_STORE_MISSING");
    expect(summary.pendingCount).toBe(0);
    expect(codeOf(() => index.read(entryId, filter())))
      .toBe("RECOVERY_STORE_MISSING");
    expect(existsSync(storeFile)).toBe(false);

    const still = index
      .list(filter())
      .find((candidate) => candidate.entryId === entryId);
    expect(still?.status).toBe("MISSING");
  });

  it("reports a malformed store without rewriting it or clearing metadata", () => {
    const root = tempRoot();
    const directory = writerDirectory(root, "writer-a");
    seedWriter(directory, "writer-a");
    const storeFile = join(directory, "shared-runtime.sqlite");
    const index = new SharedRecoveryIndex(root);
    const entryId = remember(index, directory, "writer-a");

    writeFileSync(storeFile, "this is not a runtime store");
    const malformed = readFileSync(storeFile);
    const summary = index.list(filter())[0];
    expect(summary.status).toBe("MALFORMED");
    const readCode = codeOf(() => index.read(entryId, filter()));
    expect(readCode).toBe(summary.error);
    expect([
      "CORRUPT_SHARED_RUNTIME",
      "NOT_SHARED_RUNTIME_FORMAT",
    ]).toContain(readCode);
    expect(readFileSync(storeFile).equals(malformed)).toBe(true);

    const still = index.list(filter());
    expect(still).toHaveLength(1);
    expect(still[0].entryId).toBe(entryId);
    expect(still[0].status).toBe("MALFORMED");
  });

  it("rejects symlinked stores and leaves the link untouched", () => {
    const root = tempRoot();
    const directory = writerDirectory(root, "writer-a");
    seedWriter(directory, "writer-a");
    const storeFile = join(directory, "shared-runtime.sqlite");
    const index = new SharedRecoveryIndex(root);
    const entryId = remember(index, directory, "writer-a");

    const target = join(root, "outside.sqlite");
    writeFileSync(target, "outside");
    unlinkSync(storeFile);
    symlinkSync(target, storeFile);

    const summary = index.list(filter())[0];
    expect(summary.status).toBe("MALFORMED");
    expect(summary.error).toBe("UNSAFE_RECOVERY_STORE_PATH");
    expect(codeOf(() => index.read(entryId, filter())))
      .toBe("UNSAFE_RECOVERY_STORE_PATH");
    expect(lstatSync(storeFile).isSymbolicLink()).toBe(true);

    const freshRoot = tempRoot();
    const linkedDirectory = writerDirectory(freshRoot, "writer-link");
    seedWriter(linkedDirectory, "writer-link");
    const linkedFile = join(linkedDirectory, "shared-runtime.sqlite");
    const linkedTarget = join(freshRoot, "target.sqlite");
    writeFileSync(linkedTarget, "target");
    unlinkSync(linkedFile);
    symlinkSync(linkedTarget, linkedFile);
    const freshIndex = new SharedRecoveryIndex(freshRoot);
    expect(
      codeOf(() =>
        remember(freshIndex, linkedDirectory, "writer-link"),
      ),
    ).toBe("UNSAFE_RECOVERY_STORE_PATH");
    expect(freshIndex.list(filter())).toEqual([]);
    expect(existsSync(join(freshRoot, "shared-recovery-index.sqlite"))).toBe(
      false,
    );
  });

  it("reads a previous resource-client generation without changing it", () => {
    const root = tempRoot();
    const directory = writerDirectory(root, "writer-resource");
    seedWriter(directory, "writer-resource", {
      role: "resource-client",
      editing: false,
    });
    const index = new SharedRecoveryIndex(root);
    const entryId = index.remember({
      origin: ORIGIN,
      orgId: ORG,
      userId: USER,
      writerId: "writer-resource",
      directory,
      kind: "resource",
    });

    const summary = index.list(filter())[0];
    expect(summary.status).toBe("OK");
    expect(summary.kind).toBe("resource");
    expect(summary.pendingCount).toBe(1);
    expect(summary.rawFlags.queue).toBe(true);
    expect(summary.rawFlags.editing).toBe(false);
    expect(summary.selectedScope).toEqual(scope);

    const data = index.read(entryId, filter());
    expect(data.kind).toBe("resource");
    expect(data.role).toBe("resource-client");
    expect(data.queue[0].state).toBe("UNKNOWN");
    expect(Object.isFrozen(data.records)).toBe(true);
  });

  it("keeps raw records for unknown and revoked receipts without forging status", () => {
    const root = tempRoot();
    const directory = writerDirectory(root, "writer-a");
    seedWriter(directory, "writer-a");
    const index = new SharedRecoveryIndex(root);
    const entryId = remember(index, directory, "writer-a");

    const first = index.read(entryId, filter());
    const queueRaw = first.records.find(
      (record) => record.namespace === "client.queue",
    )!.raw;
    expect(queueRaw).toContain('"state":"UNKNOWN"');
    expect(first.queue[0].attempts[0].receipt).toBeNull();

    const second = index.read(entryId, filter());
    expect(second.queue[0].state).toBe("UNKNOWN");
    expect(second.queue[0].attempts[0].receipt).toBeNull();
  });
});
