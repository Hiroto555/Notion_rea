import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableQueue } from "../src/collaboration/runtime/durable-queue";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  sameScope,
  scopeKey,
  type Attempt,
  type Cut,
  type Intent,
  type Receipt,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";

class TestStore implements StoragePort {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS kv (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(namespace,key)
      );
      CREATE TABLE IF NOT EXISTS blobs (
        scope TEXT NOT NULL,
        hash TEXT NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY(scope,hash)
      );`,
    );
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(namespace: string, key: string): unknown | null {
    const row = this.db
      .prepare("SELECT value FROM kv WHERE namespace=? AND key=?")
      .get(namespace, key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  set(namespace: string, key: string, value: unknown | null): void {
    if (value === null) {
      this.db
        .prepare("DELETE FROM kv WHERE namespace=? AND key=?")
        .run(namespace, key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO kv(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
      )
      .run(namespace, key, JSON.stringify(value));
  }
  all(namespace: string): { key: string; value: unknown }[] {
    const rows = this.db
      .prepare("SELECT key,value FROM kv WHERE namespace=?")
      .all(namespace) as { key: string; value: string }[];
    return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
  }
  blobGet(scope: string, hash: string): Uint8Array | null {
    const row = this.db
      .prepare("SELECT bytes FROM blobs WHERE scope=? AND hash=?")
      .get(scope, hash) as { bytes: Uint8Array } | undefined;
    return row ? row.bytes : null;
  }
  blobPut(scope: string, hash: string, bytes: Uint8Array): void {
    this.db
      .prepare("INSERT OR REPLACE INTO blobs(scope,hash,bytes) VALUES(?,?,?)")
      .run(scope, hash, bytes);
  }
  blobDelete(scope: string, hash: string): void {
    this.db
      .prepare("DELETE FROM blobs WHERE scope=? AND hash=?")
      .run(scope, hash);
  }
  close(): void {
    this.db.close();
  }
}

const BASE_SCOPE: Scope = {
  orgId: "org-1",
  workspaceId: "workspace-1",
  documentId: "document-1",
  incarnationId: "incarnation-1",
};
const OWNER = { writerId: "writer-1", scope: BASE_SCOPE };
const KEY = `${scopeKey(BASE_SCOPE)}:writer-1:intent-1`;
const MAX_BYTES = 20_000_000;
const MAX_INTENT_BYTES = 1_048_576;
const RECEIPT_RESERVE = 4096;
const ATTEMPT_ALLOWANCE = MAX_INTENT_BYTES + RECEIPT_RESERVE + 1024;
const MAX_ATTEMPTS = 16;

type StoredShape = {
  raw: string;
  attempts: { receipt: Receipt | null }[];
};

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(canonical(value)).length;
}
function storedBudget(db: TestStore): number {
  return db.all("client.queue").reduce((total, row) => {
    const value = row.value as StoredShape;
    const allowance = value.attempts.length === 0 ? ATTEMPT_ALLOWANCE : 0;
    const reserve = value.attempts.reduce(
      (sum, attempt) => sum + (attempt.receipt === null ? RECEIPT_RESERVE : 0),
      0,
    );
    return total + encodedBytes(value) + allowance + reserve;
  }, 0);
}

function cut(epoch = "epoch-1", seq = 0): Cut {
  return { epoch, seq, hash: digest(["cut", epoch, seq]) };
}
function makeIntent(
  intentId = "intent-1",
  text = "hello",
  base = cut(),
  scope: Scope = BASE_SCOPE,
  writerId = "writer-1",
): Intent {
  return {
    v: 1,
    intentId,
    writerId,
    scope,
    base,
    command: {
      kind: "text",
      blockId: "block-1",
      from: 0,
      to: 0,
      text,
      before: "",
    },
  };
}
function makeAttempt(
  intent: Intent,
  attemptId = "attempt-1",
  base = intent.base,
): Attempt {
  return { v: 1, attemptId, intent, base };
}
function makeReceipt(
  intent: Intent,
  attempt: Attempt,
  status: Receipt["status"],
  options: {
    epoch?: string;
    cut?: Cut;
    scope?: Scope;
    writerId?: string;
    intentHash?: string;
    attemptHash?: string;
    resultHash?: string;
    code?: string | null;
  } = {},
): Receipt {
  return {
    v: 1,
    status,
    intentId: intent.intentId,
    intentHash: options.intentHash ?? digest(intent),
    attemptId: attempt.attemptId,
    attemptHash: options.attemptHash ?? digest(attempt),
    writerId: options.writerId ?? intent.writerId,
    scope: options.scope ?? intent.scope,
    cut: options.cut ?? {
      epoch: options.epoch ?? attempt.base.epoch,
      seq: attempt.base.seq + 1,
      hash: digest(["receipt", attempt.attemptId, status]),
    },
    resultHash:
      options.resultHash ?? digest(["result", attempt.attemptId, status]),
    code:
      options.code !== undefined
        ? options.code
        : status === "SERVER_ACCEPTED"
          ? null
          : "REJECTED",
  };
}

let directory = "";
let store: TestStore | null = null;
function open(): TestStore {
  if (!directory) directory = mkdtempSync(join(tmpdir(), "folio-queue-"));
  store = new TestStore(join(directory, "queue.sqlite"));
  return store;
}
afterEach(() => {
  if (store) {
    store.close();
    store = null;
  }
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    directory = "";
  }
});

describe("DurableQueue", () => {
  it("persists an accepted attempt and reconstructs it after reopen", () => {
    const db = open();
    const queue = new DurableQueue(db, OWNER);
    const intent = makeIntent();
    const attempt = makeAttempt(intent);
    const receipt = makeReceipt(intent, attempt, "SERVER_ACCEPTED");

    expect(queue.enqueue(intent).state).toBe("LOCAL_DURABLE");
    expect(queue.attempt(attempt).attempts[0].state).toBe("PREPARED");
    const confirmed = queue.confirm(receipt);
    expect(confirmed.state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(confirmed.attempts[0].state).toBe("ACCEPTED");
    expect(confirmed.attempts[0].receipt).toEqual(receipt);
    expect(confirmed.raw).toBe(canonical(intent));

    db.close();
    store = new TestStore(join(directory, "queue.sqlite"));
    const reopened = new DurableQueue(store, OWNER);
    const entries = reopened.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].intent).toEqual(intent);
    expect(entries[0].raw).toBe(canonical(intent));
    expect(entries[0].attempts[0].receipt).toEqual(receipt);
    expect(reopened.read("intent-1")?.state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(reopened.read("missing")).toBeNull();
    const recovered = reopened.recover("intent-1");
    expect(recovered.raw).toBe(entries[0].raw);
    expect(recovered.entry).toEqual(entries[0]);
  });

  it("rejects duplicate and changed intent or attempt bytes", () => {
    const queue = new DurableQueue(open(), OWNER);
    const intent = makeIntent();
    const attempt = makeAttempt(intent);
    queue.enqueue(intent);
    expect(queue.enqueue(makeIntent()).intent).toEqual(intent);
    expect(() => queue.enqueue(makeIntent("intent-1", "changed"))).toThrow(
      "ID_REUSE",
    );

    queue.attempt(attempt);
    expect(queue.attempt(makeAttempt(intent)).attempts).toHaveLength(1);
    expect(() =>
      queue.attempt(makeAttempt(intent, "attempt-1", cut("epoch-1", 9))),
    ).toThrow("ID_REUSE");
    expect(() =>
      queue.enqueue(
        makeIntent("intent-1", "hello", cut(), {
          ...BASE_SCOPE,
          documentId: "other",
        }),
      ),
    ).toThrow("SCOPE_MISMATCH");
  });

  it("keeps UNKNOWN durable and never treats a missing query as proof", () => {
    const queue = new DurableQueue(open(), OWNER);
    const intent = makeIntent();
    const attempt = makeAttempt(intent);
    queue.enqueue(intent);
    queue.attempt(attempt);
    queue.markUnknown("intent-1", "attempt-1");
    expect(queue.read("intent-1")?.state).toBe("UNKNOWN");
    expect(queue.read("intent-1")?.raw).toBe(canonical(intent));
    expect(() => queue.attempt(makeAttempt(intent, "attempt-2"))).toThrow(
      "UNKNOWN_BLOCKS_RETRY",
    );
    const invented = makeReceipt(intent, attempt, "REJECTED");
    expect(() => queue.authorizeRetry("intent-1", invented)).toThrow(
      "RETRY_PROOF_NOT_DURABLE",
    );

    const accepted = makeReceipt(intent, attempt, "SERVER_ACCEPTED");
    expect(queue.confirm(accepted).state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(queue.confirm(accepted).attempts).toHaveLength(1);
    expect(queue.read("intent-1")?.raw).toBe(canonical(intent));
    expect(() => queue.attempt(makeAttempt(intent, "attempt-2"))).toThrow(
      "ALREADY_ACCEPTED",
    );
  });

  it("allows one rebased attempt only after a durable rejected receipt", () => {
    const queue = new DurableQueue(open(), OWNER);
    const intent = makeIntent();
    const first = makeAttempt(intent);
    queue.enqueue(intent);
    queue.attempt(first);
    const rejected = makeReceipt(intent, first, "REJECTED");
    queue.confirm(rejected);
    expect(queue.read("intent-1")?.state).toBe("REJECTED");
    expect(() =>
      queue.attempt(makeAttempt(intent, "attempt-2", rejected.cut)),
    ).toThrow("RETRY_NOT_AUTHORIZED");
    expect(() =>
      queue.authorizeRetry(
        "intent-1",
        makeReceipt(intent, first, "REJECTED", {
          resultHash: digest(["different-result"]),
        }),
      ),
    ).toThrow("RETRY_PROOF_NOT_DURABLE");

    queue.authorizeRetry("intent-1", rejected);
    const second = makeAttempt(intent, "attempt-2", rejected.cut);
    const entry = queue.attempt(second);
    expect(entry.attempts.map((item) => item.attempt.attemptId)).toEqual([
      "attempt-1",
      "attempt-2",
    ]);
    expect(entry.attempts[0].state).toBe("REJECTED");
    expect(entry.attempts[1].state).toBe("PREPARED");
    expect(entry.state).toBe("LOCAL_DURABLE");
  });

  it("rejects cross-scope, cross-writer and cross-epoch receipts", () => {
    const queue = new DurableQueue(open(), OWNER);
    const intent = makeIntent();
    const attempt = makeAttempt(intent);
    queue.enqueue(intent);
    queue.attempt(attempt);

    expect(() =>
      queue.confirm(
        makeReceipt(intent, attempt, "SERVER_ACCEPTED", {
          scope: { ...BASE_SCOPE, incarnationId: "other-incarnation" },
        }),
      ),
    ).toThrow("RECEIPT_SCOPE_MISMATCH");
    expect(() =>
      queue.confirm(
        makeReceipt(intent, attempt, "SERVER_ACCEPTED", {
          writerId: "writer-2",
        }),
      ),
    ).toThrow("RECEIPT_WRITER_MISMATCH");
    expect(() =>
      queue.confirm(
        makeReceipt(intent, attempt, "SERVER_ACCEPTED", { epoch: "epoch-2" }),
      ),
    ).toThrow("RECEIPT_EPOCH_MISMATCH");
    expect(() =>
      queue.confirm(
        makeReceipt(intent, attempt, "SERVER_ACCEPTED", {
          attemptHash: digest(["wrong-attempt"]),
        }),
      ),
    ).toThrow("RECEIPT_ATTEMPT_MISMATCH");
    expect(() =>
      queue.confirm(
        makeReceipt(intent, attempt, "SERVER_ACCEPTED", {
          resultHash: "not-a-hash",
        }),
      ),
    ).toThrow("INVALID_RECEIPT");
  });

  it("cannot mark a different wire attempt accepted after the original", () => {
    const queue = new DurableQueue(open(), OWNER);
    const intent = makeIntent();
    const first = makeAttempt(intent);
    queue.enqueue(intent);
    queue.attempt(first);
    const rejected = makeReceipt(intent, first, "REJECTED");
    queue.confirm(rejected);
    queue.authorizeRetry("intent-1", rejected);
    const second = makeAttempt(intent, "attempt-2", rejected.cut);
    queue.attempt(second);
    queue.confirm(makeReceipt(intent, second, "SERVER_ACCEPTED"));

    expect(() =>
      queue.confirm(makeReceipt(intent, first, "SERVER_ACCEPTED")),
    ).toThrow("ACCEPTED_ATTEMPT_IMMUTABLE");
    expect(() =>
      queue.attempt(makeAttempt(intent, "attempt-3", rejected.cut)),
    ).toThrow("ALREADY_ACCEPTED");
  });

  it("rejects corrupted existing rows without repairing them", () => {
    const db = open();
    const queue = new DurableQueue(db, OWNER);
    queue.enqueue(makeIntent());
    const row = db.db
      .prepare("SELECT value FROM kv WHERE namespace=? AND key=?")
      .get("client.queue", KEY) as { value: string };
    const corrupted = JSON.parse(row.value) as Record<string, unknown>;
    corrupted.intentHash = "0".repeat(64);
    db.db
      .prepare("UPDATE kv SET value=? WHERE namespace=? AND key=?")
      .run(JSON.stringify(corrupted), "client.queue", KEY);

    expect(() => new DurableQueue(db, OWNER).read("intent-1")).toThrow(
      "CORRUPT_QUEUE",
    );
    const stillCorrupt = db.db
      .prepare("SELECT value FROM kv WHERE namespace=? AND key=?")
      .get("client.queue", KEY) as { value: string };
    expect(JSON.parse(stillCorrupt.value).intentHash).toBe("0".repeat(64));
  });

  it("does not resend automatically after restart", () => {
    const db = open();
    new DurableQueue(db, OWNER).enqueue(makeIntent());
    db.close();
    store = new TestStore(join(directory, "queue.sqlite"));
    const reopened = new DurableQueue(store, OWNER);
    const entry = reopened.read("intent-1");
    expect(entry?.attempts).toEqual([]);
    expect(entry?.state).toBe("LOCAL_DURABLE");
  });

  it("enforces the 1MiB canonical limit on intent and attempt inputs", () => {
    const queue = new DurableQueue(open(), OWNER);
    const oversized = makeIntent(
      "too-big",
      "x".repeat(MAX_INTENT_BYTES + 1_000),
    );
    expect(encodedBytes(oversized)).toBeGreaterThan(MAX_INTENT_BYTES);
    expect(() => queue.enqueue(oversized)).toThrow("JSON_LIMIT");

    const attemptFits = (size: number): boolean =>
      encodedBytes(makeAttempt(makeIntent("near-max", "x".repeat(size)))) <=
      MAX_INTENT_BYTES;
    let low = MAX_INTENT_BYTES;
    while (!attemptFits(low)) low -= 128;
    let high = low + 128;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (attemptFits(middle)) low = middle;
      else high = middle;
    }
    const length = low;
    const fitting = makeIntent("near-max", "x".repeat(length));
    expect(encodedBytes(fitting)).toBeLessThanOrEqual(MAX_INTENT_BYTES);
    expect(encodedBytes(makeAttempt(fitting))).toBeLessThanOrEqual(
      MAX_INTENT_BYTES,
    );

    const overAttemptIntent = makeIntent("near-max", "x".repeat(length + 1));
    expect(encodedBytes(overAttemptIntent)).toBeLessThanOrEqual(
      MAX_INTENT_BYTES,
    );
    expect(encodedBytes(makeAttempt(overAttemptIntent))).toBeGreaterThan(
      MAX_INTENT_BYTES,
    );
    queue.enqueue(overAttemptIntent);
    expect(() => queue.attempt(makeAttempt(overAttemptIntent))).toThrow(
      "JSON_LIMIT",
    );
    expect(queue.read("near-max")?.attempts).toEqual([]);
  });

  it("counts full encoded entries and reserves receipt headroom at the owner bound", () => {
    const db = open();
    const queue = new DurableQueue(db, OWNER);
    const text = "x".repeat(500_000);
    const accepted: Intent[] = [];
    let blocked: Intent | null = null;
    for (let index = 0; index < 100; index += 1) {
      const intent = makeIntent(`intent-${index}`, text);
      try {
        queue.enqueue(intent);
        accepted.push(intent);
      } catch (error) {
        expect((error as { code: string }).code).toBe("QUEUE_LIMIT");
        blocked = intent;
        break;
      }
    }
    expect(blocked).not.toBeNull();
    expect(accepted.length).toBeGreaterThanOrEqual(3);

    const rows = db.all("client.queue");
    expect(rows).toHaveLength(accepted.length);
    const values = rows.map((row) => row.value as StoredShape);
    const rawBytes = values.reduce(
      (total, value) => total + new TextEncoder().encode(value.raw).length,
      0,
    );
    const encoded = values.reduce(
      (total, value) => total + encodedBytes(value),
      0,
    );
    const budget = storedBudget(db);
    expect(encoded).toBeGreaterThan(rawBytes * 1.9);
    expect(budget).toBeLessThanOrEqual(MAX_BYTES);
    expect(budget).toBeGreaterThan(MAX_BYTES - 2_100_000);

    const probeDirectory = mkdtempSync(join(tmpdir(), "folio-queue-probe-"));
    try {
      const probeStore = new TestStore(join(probeDirectory, "probe.sqlite"));
      new DurableQueue(probeStore, OWNER).enqueue(blocked!);
      const probeBudget = storedBudget(probeStore);
      probeStore.close();
      expect(budget + probeBudget).toBeGreaterThan(MAX_BYTES);
    } finally {
      rmSync(probeDirectory, { recursive: true, force: true });
    }

    const last = accepted[accepted.length - 1];
    const attempt = makeAttempt(last);
    expect(queue.attempt(attempt).attempts[0].state).toBe("PREPARED");
    const receipt = makeReceipt(last, attempt, "SERVER_ACCEPTED");
    const confirmed = queue.confirm(receipt);
    expect(confirmed.state).toBe("CLIENT_RECEIPT_DURABLE");
    expect(confirmed.raw).toBe(canonical(last));
    expect(confirmed.intent).toEqual(last);
    expect(storedBudget(db)).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("allows sixteen attempts and rejects a seventeenth before mutation", () => {
    const queue = new DurableQueue(open(), OWNER);
    const intent = makeIntent("retry-intent", "x".repeat(50_000));
    queue.enqueue(intent);
    let base = intent.base;
    for (let index = 1; index <= MAX_ATTEMPTS; index += 1) {
      const attempt = makeAttempt(intent, `attempt-${index}`, base);
      queue.attempt(attempt);
      const receipt = makeReceipt(intent, attempt, "REJECTED");
      queue.confirm(receipt);
      queue.authorizeRetry(intent.intentId, receipt);
      base = receipt.cut;
    }
    const full = queue.read(intent.intentId)!;
    expect(full.attempts).toHaveLength(MAX_ATTEMPTS);
    expect(full.attempts[MAX_ATTEMPTS - 1].state).toBe("REJECTED");
    expect(full.raw).toBe(canonical(intent));
    const before = canonical(full);
    const next = makeAttempt(intent, `attempt-${MAX_ATTEMPTS + 1}`, base);
    expect(() => queue.attempt(next)).toThrow("QUEUE_LIMIT");
    expect(canonical(queue.read(intent.intentId))).toBe(before);
  });

  it("rejects a retry when the full encoded owner budget is exhausted", () => {
    const db = open();
    const queue = new DurableQueue(db, OWNER);
    const text = "x".repeat(550_000);
    const intents: Intent[] = [];
    for (let index = 0; index < 100; index += 1) {
      const intent = makeIntent(`fill-${index}`, text);
      try {
        queue.enqueue(intent);
        intents.push(intent);
      } catch (error) {
        expect((error as { code: string }).code).toBe("QUEUE_LIMIT");
        break;
      }
    }
    expect(intents.length).toBeGreaterThanOrEqual(3);

    for (const intent of intents) {
      const attempt = makeAttempt(intent, `${intent.intentId}-attempt-1`);
      queue.attempt(attempt);
      const receipt = makeReceipt(intent, attempt, "REJECTED");
      queue.confirm(receipt);
      queue.authorizeRetry(intent.intentId, receipt);
    }

    const target = intents[0];
    let base = queue.read(target.intentId)!.attempts[0].receipt!.cut;
    let retries = 0;
    let failure: { code: string } | null = null;
    for (let index = 2; index <= 40; index += 1) {
      const attempt = makeAttempt(
        target,
        `${target.intentId}-attempt-${index}`,
        base,
      );
      const before = canonical(queue.read(target.intentId));
      try {
        queue.attempt(attempt);
        retries += 1;
        const receipt = makeReceipt(target, attempt, "REJECTED");
        queue.confirm(receipt);
        queue.authorizeRetry(target.intentId, receipt);
        base = receipt.cut;
      } catch (error) {
        failure = error as { code: string };
        expect(canonical(queue.read(target.intentId))).toBe(before);
        break;
      }
    }

    expect(failure).not.toBeNull();
    expect(failure!.code).toBe("QUEUE_LIMIT");
    expect(retries).toBeGreaterThanOrEqual(1);
    expect(retries).toBeLessThan(MAX_ATTEMPTS - 1);
    expect(queue.read(target.intentId)?.raw).toBe(canonical(target));
    expect(storedBudget(db)).toBeLessThanOrEqual(MAX_BYTES);
  }, 30_000);

  it("keeps another owner's entries out of the queue", () => {
    const db = open();
    const otherScope = { ...BASE_SCOPE, documentId: "other-document" };
    const other = new DurableQueue(db, {
      writerId: "writer-2",
      scope: otherScope,
    });
    other.enqueue(
      makeIntent("intent-9", "hello", cut(), otherScope, "writer-2"),
    );
    const queue = new DurableQueue(db, OWNER);
    queue.enqueue(makeIntent());
    expect(queue.entries().map((entry) => entry.intent.intentId)).toEqual([
      "intent-1",
    ]);
    expect(queue.read("intent-9")).toBeNull();
    expect(sameScope(queue.read("intent-1")!.intent.scope, BASE_SCOPE)).toBe(
      true,
    );
  });
});
