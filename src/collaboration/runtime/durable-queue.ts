import { canonical } from "./canonical";
import {
  CollaborationError,
  identifier,
  safeCounter,
  sameScope,
  scopeKey,
  type Attempt,
  type Cut,
  type Intent,
  type Receipt,
  type Scope,
} from "./contract";
import { digest } from "./digest";
import type { StoragePort } from "./storage-port";

export type AttemptState =
  "PREPARED" | "UNKNOWN" | "REJECTED" | "INVALIDATED" | "ACCEPTED";
export type QueueState =
  "LOCAL_DURABLE" | "UNKNOWN" | "CLIENT_RECEIPT_DURABLE" | "REJECTED";
export type QueueAttempt = {
  attempt: Attempt;
  attemptHash: string;
  state: AttemptState;
  receipt: Receipt | null;
};
export type QueueEntry = {
  intent: Intent;
  intentHash: string;
  raw: string;
  attempts: QueueAttempt[];
  state: QueueState;
};

type StoredAttempt = QueueAttempt & { retryAuthorized: boolean };
type StoredEntry = {
  v: 1;
  scope: Scope;
  writerId: string;
  intent: Intent;
  intentHash: string;
  raw: string;
  attempts: StoredAttempt[];
  state: QueueState;
};

const NAMESPACE = "client.queue";
const MAX_ENTRIES = 1000;
const MAX_BYTES = 20_000_000;
const MAX_INTENT_BYTES = 1_048_576;
const MAX_ATTEMPTS = 16;
const RECEIPT_RESERVE = 4096;
const MAX_RECEIPT_BYTES = RECEIPT_RESERVE - 256;
const ATTEMPT_WRAPPER_BYTES = 1024;
const ATTEMPT_ALLOWANCE =
  MAX_INTENT_BYTES + RECEIPT_RESERVE + ATTEMPT_WRAPPER_BYTES;
const HASH = /^[0-9a-f]{64}$/;
const COMMAND_KINDS = new Set([
  "text",
  "batch",
  "inline",
  "inline.patch",
  "inline.mark",
  "block.frame",
  "block.format",
  "block.move",
  "block.delete",
  "block.insert",
  "block.replace",
  "block.split",
  "block.join",
  "table.row.insert",
  "table.column.insert",
  "table.row.delete",
  "table.column.delete",
  "table.row.restore",
  "table.column.restore",
  "resource",
]);
const ATTEMPT_STATES = new Set<AttemptState>([
  "PREPARED",
  "UNKNOWN",
  "REJECTED",
  "INVALIDATED",
  "ACCEPTED",
]);
const QUEUE_STATES = new Set<QueueState>([
  "LOCAL_DURABLE",
  "UNKNOWN",
  "CLIENT_RECEIPT_DURABLE",
  "REJECTED",
]);

function fail(code: string): never {
  throw new CollaborationError(code);
}
function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], code: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail(code);
}
function hash(value: unknown, code: string): string {
  if (typeof value !== "string" || !HASH.test(value)) fail(code);
  return value;
}
function cloneJson<T>(value: unknown): T {
  return JSON.parse(canonical(value)) as T;
}
function checkedCut(value: unknown, code: string): Cut {
  const cut = record(value, code);
  exact(cut, ["epoch", "seq", "hash"], code);
  identifier(cut.epoch);
  safeCounter(cut.seq);
  hash(cut.hash, code);
  return cloneJson<Cut>(cut);
}
function checkedScope(value: unknown): Scope {
  const scope = record(value, "INVALID_SCOPE");
  exact(
    scope,
    ["orgId", "workspaceId", "documentId", "incarnationId"],
    "INVALID_SCOPE",
  );
  identifier(scope.orgId);
  identifier(scope.workspaceId);
  identifier(scope.documentId);
  identifier(scope.incarnationId);
  return cloneJson<Scope>(scope);
}
function checkedIntent(value: unknown): { intent: Intent; raw: string } {
  const intent = record(value, "INVALID_INTENT");
  exact(
    intent,
    ["v", "intentId", "writerId", "scope", "base", "command"],
    "INVALID_INTENT",
  );
  if (intent.v !== 1) fail("INVALID_INTENT");
  identifier(intent.intentId);
  identifier(intent.writerId);
  checkedScope(intent.scope);
  checkedCut(intent.base, "INVALID_INTENT");
  const command = record(intent.command, "INVALID_INTENT");
  if (typeof command.kind !== "string" || !COMMAND_KINDS.has(command.kind))
    fail("INVALID_INTENT");
  const raw = canonical(intent, MAX_INTENT_BYTES);
  return { intent: JSON.parse(raw) as Intent, raw };
}
function checkedAttempt(value: unknown): { attempt: Attempt; raw: string } {
  const attempt = record(value, "INVALID_ATTEMPT");
  exact(attempt, Object.hasOwn(attempt, "protocol") ? ["v", "attemptId", "intent", "base", "protocol"] : ["v", "attemptId", "intent", "base"], "INVALID_ATTEMPT");
  if (Object.hasOwn(attempt, "protocol") && attempt.protocol !== 1004) fail("INVALID_ATTEMPT");
  if (attempt.v !== 1) fail("INVALID_ATTEMPT");
  identifier(attempt.attemptId);
  checkedIntent(attempt.intent);
  checkedCut(attempt.base, "INVALID_ATTEMPT");
  const raw = canonical(attempt, MAX_INTENT_BYTES);
  return { attempt: JSON.parse(raw) as Attempt, raw };
}
function checkedReceipt(value: unknown): Receipt {
  const receipt = record(value, "INVALID_RECEIPT");
  exact(
    receipt,
    [
      "v",
      "status",
      "intentId",
      "intentHash",
      "attemptId",
      "attemptHash",
      "writerId",
      "scope",
      "cut",
      "resultHash",
      "code",
    ],
    "INVALID_RECEIPT",
  );
  if (receipt.v !== 1) fail("INVALID_RECEIPT");
  if (
    receipt.status !== "SERVER_ACCEPTED" &&
    receipt.status !== "REJECTED" &&
    receipt.status !== "INVALIDATED"
  )
    fail("INVALID_RECEIPT");
  identifier(receipt.intentId);
  identifier(receipt.attemptId);
  identifier(receipt.writerId);
  hash(receipt.intentHash, "INVALID_RECEIPT");
  hash(receipt.attemptHash, "INVALID_RECEIPT");
  hash(receipt.resultHash, "INVALID_RECEIPT");
  checkedScope(receipt.scope);
  checkedCut(receipt.cut, "INVALID_RECEIPT");
  if (receipt.code !== null && typeof receipt.code !== "string")
    fail("INVALID_RECEIPT");
  const raw = canonical(receipt, MAX_RECEIPT_BYTES);
  return JSON.parse(raw) as Receipt;
}
function checkReceiptIdentity(
  receipt: Receipt,
  intent: Intent,
  intentHash: string,
  attempt: Attempt,
  attemptHash: string,
  owner: { writerId: string; scope: Scope },
): void {
  if (receipt.intentId !== intent.intentId || receipt.intentHash !== intentHash)
    fail("RECEIPT_INTENT_MISMATCH");
  if (
    receipt.attemptId !== attempt.attemptId ||
    receipt.attemptHash !== attemptHash
  )
    fail("RECEIPT_ATTEMPT_MISMATCH");
  if (
    receipt.writerId !== owner.writerId ||
    receipt.writerId !== intent.writerId
  )
    fail("RECEIPT_WRITER_MISMATCH");
  if (
    !sameScope(receipt.scope, intent.scope) ||
    !sameScope(receipt.scope, owner.scope)
  )
    fail("RECEIPT_SCOPE_MISMATCH");
  if (receipt.cut.epoch !== attempt.base.epoch) fail("RECEIPT_EPOCH_MISMATCH");
}
function derivedState(attempts: StoredAttempt[]): QueueState {
  if (attempts.some((attempt) => attempt.state === "ACCEPTED"))
    return "CLIENT_RECEIPT_DURABLE";
  if (attempts.some((attempt) => attempt.state === "UNKNOWN")) return "UNKNOWN";
  if (attempts.some((attempt) => attempt.state === "PREPARED"))
    return "LOCAL_DURABLE";
  if (attempts.length) return "REJECTED";
  return "LOCAL_DURABLE";
}
function decodeAttempt(
  value: unknown,
  intent: Intent,
  intentRaw: string,
): StoredAttempt {
  const stored = record(value, "CORRUPT_QUEUE");
  exact(
    stored,
    ["attempt", "attemptHash", "state", "receipt", "retryAuthorized"],
    "CORRUPT_QUEUE",
  );
  const { attempt } = checkedAttempt(stored.attempt);
  if (canonical(attempt.intent) !== intentRaw) fail("CORRUPT_QUEUE");
  const attemptHash = hash(stored.attemptHash, "CORRUPT_QUEUE");
  if (attemptHash !== digest(attempt)) fail("CORRUPT_QUEUE");
  if (
    typeof stored.state !== "string" ||
    !ATTEMPT_STATES.has(stored.state as AttemptState)
  )
    fail("CORRUPT_QUEUE");
  const state = stored.state as AttemptState;
  if (typeof stored.retryAuthorized !== "boolean") fail("CORRUPT_QUEUE");
  const receipt =
    stored.receipt === null ? null : checkedReceipt(stored.receipt);
  if (receipt)
    checkReceiptIdentity(
      receipt,
      intent,
      digest(intent),
      attempt,
      attemptHash,
      {
        writerId: intent.writerId,
        scope: intent.scope,
      },
    );
  if (state === "PREPARED" || state === "UNKNOWN") {
    if (receipt !== null || stored.retryAuthorized) fail("CORRUPT_QUEUE");
  } else {
    if (receipt === null) fail("CORRUPT_QUEUE");
    if (state === "ACCEPTED" && receipt.status !== "SERVER_ACCEPTED")
      fail("CORRUPT_QUEUE");
    if (state === "REJECTED" && receipt.status !== "REJECTED")
      fail("CORRUPT_QUEUE");
    if (state === "INVALIDATED" && receipt.status !== "INVALIDATED")
      fail("CORRUPT_QUEUE");
    if (stored.retryAuthorized && receipt.status === "SERVER_ACCEPTED")
      fail("CORRUPT_QUEUE");
  }
  return {
    attempt,
    attemptHash,
    state,
    receipt,
    retryAuthorized: stored.retryAuthorized,
  };
}
function decodeEntry(
  value: unknown,
  key: string,
  owner: { writerId: string; scope: Scope },
): StoredEntry {
  try {
    const stored = record(
      JSON.parse(canonical(value, MAX_BYTES)),
      "CORRUPT_QUEUE",
    );
    exact(
      stored,
      [
        "v",
        "scope",
        "writerId",
        "intent",
        "intentHash",
        "raw",
        "attempts",
        "state",
      ],
      "CORRUPT_QUEUE",
    );
    if (stored.v !== 1) fail("CORRUPT_QUEUE");
    const scope = checkedScope(stored.scope);
    const writerId = identifier(stored.writerId);
    if (!sameScope(scope, owner.scope) || writerId !== owner.writerId)
      fail("CORRUPT_QUEUE");
    const { intent, raw } = checkedIntent(stored.intent);
    if (typeof stored.raw !== "string" || stored.raw !== raw)
      fail("CORRUPT_QUEUE");
    const expectedKey = `${scopeKey(owner.scope)}:${owner.writerId}:${intent.intentId}`;
    if (key !== expectedKey) fail("CORRUPT_QUEUE");
    const intentHash = hash(stored.intentHash, "CORRUPT_QUEUE");
    if (intentHash !== digest(intent)) fail("CORRUPT_QUEUE");
    if (
      !Array.isArray(stored.attempts) ||
      stored.attempts.length > MAX_ATTEMPTS
    )
      fail("CORRUPT_QUEUE");
    const attempts = stored.attempts.map((attempt) =>
      decodeAttempt(attempt, intent, raw),
    );
    if (
      typeof stored.state !== "string" ||
      !QUEUE_STATES.has(stored.state as QueueState)
    )
      fail("CORRUPT_QUEUE");
    const state = stored.state as QueueState;
    if (state !== derivedState(attempts)) fail("CORRUPT_QUEUE");
    return {
      v: 1,
      scope,
      writerId,
      intent,
      intentHash,
      raw,
      attempts,
      state,
    };
  } catch (error) {
    if (error instanceof CollaborationError && error.code === "CORRUPT_QUEUE")
      throw error;
    fail("CORRUPT_QUEUE");
  }
}
function exported(entry: StoredEntry): QueueEntry {
  return {
    intent: JSON.parse(canonical(entry.intent)) as Intent,
    intentHash: entry.intentHash,
    raw: entry.raw,
    attempts: entry.attempts.map((attempt) => ({
      attempt: JSON.parse(canonical(attempt.attempt)) as Attempt,
      attemptHash: attempt.attemptHash,
      state: attempt.state,
      receipt: attempt.receipt
        ? (JSON.parse(canonical(attempt.receipt)) as Receipt)
        : null,
    })),
    state: entry.state,
  };
}
function rawBytes(raw: string): number {
  return new TextEncoder().encode(raw).length;
}
function entryBudgetBytes(entry: StoredEntry): number {
  const encoded = rawBytes(canonical(entry, MAX_BYTES));
  const allowance = entry.attempts.length === 0 ? ATTEMPT_ALLOWANCE : 0;
  const reserve = entry.attempts.reduce(
    (total, attempt) =>
      total + (attempt.receipt === null ? RECEIPT_RESERVE : 0),
    0,
  );
  return encoded + allowance + reserve;
}

export class DurableQueue {
  private readonly writerId: string;
  private readonly scope: Scope;
  private readonly prefix: string;
  constructor(
    private readonly store: StoragePort,
    owner: { writerId: string; scope: Scope },
  ) {
    this.writerId = identifier(owner.writerId);
    this.scope = checkedScope(owner.scope);
    this.prefix = `${scopeKey(this.scope)}:${this.writerId}:`;
  }
  private key(intentId: string): string {
    return this.prefix + identifier(intentId);
  }
  private load(key: string): StoredEntry | null {
    const value = this.store.get(NAMESPACE, key);
    if (value === null || value === undefined) return null;
    return decodeEntry(value, key, {
      writerId: this.writerId,
      scope: this.scope,
    });
  }
  private loadAll(): StoredEntry[] {
    const result: StoredEntry[] = [];
    for (const row of this.store.all(NAMESPACE)) {
      if (typeof row.key !== "string") fail("CORRUPT_QUEUE");
      if (!row.key.startsWith(this.prefix)) continue;
      result.push(
        decodeEntry(row.value, row.key, {
          writerId: this.writerId,
          scope: this.scope,
        }),
      );
    }
    return result;
  }
  private insert(entry: StoredEntry): void {
    this.store.set(NAMESPACE, `${this.prefix}${entry.intent.intentId}`, entry);
  }
  enqueue(input: Intent): QueueEntry {
    const { intent, raw } = checkedIntent(input);
    if (
      intent.writerId !== this.writerId ||
      !sameScope(intent.scope, this.scope)
    )
      fail("SCOPE_MISMATCH");
    return this.store.transaction(() => {
      const key = this.key(intent.intentId);
      const existing = this.load(key);
      if (existing) {
        if (existing.raw !== raw || existing.intentHash !== digest(intent))
          fail("ID_REUSE");
        return exported(existing);
      }
      const all = this.loadAll();
      const entry: StoredEntry = {
        v: 1,
        scope: this.scope,
        writerId: this.writerId,
        intent,
        intentHash: digest(intent),
        raw,
        attempts: [],
        state: "LOCAL_DURABLE",
      };
      const used = all.reduce(
        (total, item) => total + entryBudgetBytes(item),
        0,
      );
      if (
        all.length >= MAX_ENTRIES ||
        used + entryBudgetBytes(entry) > MAX_BYTES
      )
        fail("QUEUE_LIMIT");
      this.insert(entry);
      return exported(entry);
    });
  }
  attempt(input: Attempt): QueueEntry {
    const { attempt } = checkedAttempt(input);
    return this.store.transaction(() => {
      const key = this.key(attempt.intent.intentId);
      const entry = this.load(key);
      if (!entry) fail("MISSING_INTENT");
      if (canonical(attempt.intent) !== entry.raw) fail("ID_REUSE");
      if (
        attempt.intent.intentId !== entry.intent.intentId ||
        attempt.intent.writerId !== entry.intent.writerId ||
        !sameScope(attempt.intent.scope, entry.intent.scope)
      )
        fail("ID_REUSE");
      const duplicate = entry.attempts.find(
        (item) => item.attempt.attemptId === attempt.attemptId,
      );
      if (duplicate) {
        if (
          duplicate.attemptHash === digest(attempt) &&
          canonical(duplicate.attempt) === canonical(attempt)
        )
          return exported(entry);
        fail("ID_REUSE");
      }
      if (entry.attempts.length >= MAX_ATTEMPTS) fail("QUEUE_LIMIT");
      if (entry.state === "UNKNOWN") fail("UNKNOWN_BLOCKS_RETRY");
      if (entry.attempts.some((item) => item.state === "UNKNOWN"))
        fail("UNKNOWN_BLOCKS_RETRY");
      if (entry.attempts.some((item) => item.state === "ACCEPTED"))
        fail("ALREADY_ACCEPTED");
      const attempts = entry.attempts.map((item) => ({ ...item }));
      if (attempts.length === 0) {
        if (attempt.base.epoch !== entry.intent.base.epoch)
          fail("BASE_EPOCH_MISMATCH");
      } else {
        const authorized = attempts.filter((item) => item.retryAuthorized);
        if (authorized.length !== 1) fail("RETRY_NOT_AUTHORIZED");
        const previous = authorized[0];
        if (
          !previous.receipt ||
          (previous.state !== "REJECTED" && previous.state !== "INVALIDATED")
        )
          fail("RETRY_NOT_AUTHORIZED");
        if (attempt.base.epoch !== previous.receipt.cut.epoch)
          fail("BASE_EPOCH_MISMATCH");
        for (const item of attempts) item.retryAuthorized = false;
      }
      const attemptHash = digest(attempt);
      attempts.push({
        attempt,
        attemptHash,
        state: "PREPARED",
        receipt: null,
        retryAuthorized: false,
      });
      const projected: StoredEntry = {
        ...entry,
        attempts,
        state: derivedState(attempts),
      };
      const otherBytes = this.loadAll()
        .filter((item) => item.intent.intentId !== entry.intent.intentId)
        .reduce((total, item) => total + entryBudgetBytes(item), 0);
      if (otherBytes + entryBudgetBytes(projected) > MAX_BYTES)
        fail("QUEUE_LIMIT");
      this.insert(projected);
      return exported(projected);
    });
  }
  markUnknown(intentId: string, attemptId: string): void {
    return this.store.transaction(() => {
      const entry = this.load(this.key(intentId));
      if (!entry) fail("MISSING_INTENT");
      const attempt = entry.attempts.find(
        (item) => item.attempt.attemptId === identifier(attemptId),
      );
      if (!attempt) fail("MISSING_ATTEMPT");
      if (attempt.state === "UNKNOWN") return;
      if (attempt.state !== "PREPARED") fail("ATTEMPT_TERMINAL");
      attempt.state = "UNKNOWN";
      attempt.receipt = null;
      attempt.retryAuthorized = false;
      entry.state = derivedState(entry.attempts);
      this.insert(entry);
    });
  }
  confirm(input: Receipt): QueueEntry {
    const receipt = checkedReceipt(input);
    return this.store.transaction(() => {
      const key = this.key(receipt.intentId);
      const entry = this.load(key);
      if (!entry) fail("MISSING_INTENT");
      const attempt = entry.attempts.find(
        (item) => item.attempt.attemptId === receipt.attemptId,
      );
      if (!attempt) fail("MISSING_ATTEMPT");
      checkReceiptIdentity(
        receipt,
        entry.intent,
        entry.intentHash,
        attempt.attempt,
        attempt.attemptHash,
        { writerId: this.writerId, scope: this.scope },
      );
      const accepted = entry.attempts.find((item) => item.state === "ACCEPTED");
      if (
        receipt.status === "SERVER_ACCEPTED" &&
        accepted &&
        accepted.attempt.attemptId !== attempt.attempt.attemptId
      )
        fail("ACCEPTED_ATTEMPT_IMMUTABLE");
      if (attempt.receipt) {
        if (canonical(attempt.receipt) !== canonical(receipt))
          fail("RECEIPT_CONFLICT");
        return exported(entry);
      }
      if (receipt.status === "SERVER_ACCEPTED") {
        attempt.state = "ACCEPTED";
      } else {
        attempt.state = receipt.status;
        attempt.retryAuthorized = false;
      }
      attempt.receipt = receipt;
      entry.state = derivedState(entry.attempts);
      this.insert(entry);
      return exported(entry);
    });
  }
  entries(): QueueEntry[] {
    return this.loadAll()
      .sort((left, right) =>
        left.intent.intentId < right.intent.intentId
          ? -1
          : left.intent.intentId > right.intent.intentId
            ? 1
            : 0,
      )
      .map(exported);
  }
  read(intentId: string): QueueEntry | null {
    const entry = this.load(this.key(intentId));
    return entry ? exported(entry) : null;
  }
  authorizeRetry(intentId: string, proof: Receipt): void {
    const receipt = checkedReceipt(proof);
    return this.store.transaction(() => {
      const entry = this.load(this.key(intentId));
      if (!entry) fail("MISSING_INTENT");
      if (receipt.intentId !== entry.intent.intentId)
        fail("RECEIPT_INTENT_MISMATCH");
      const attempt = entry.attempts.find(
        (item) => item.attempt.attemptId === receipt.attemptId,
      );
      if (!attempt) fail("MISSING_ATTEMPT");
      checkReceiptIdentity(
        receipt,
        entry.intent,
        entry.intentHash,
        attempt.attempt,
        attempt.attemptHash,
        { writerId: this.writerId, scope: this.scope },
      );
      if (receipt.status !== "REJECTED" && receipt.status !== "INVALIDATED")
        fail("RETRY_PROOF_STATUS");
      if (!attempt.receipt || canonical(attempt.receipt) !== canonical(receipt))
        fail("RETRY_PROOF_NOT_DURABLE");
      if (attempt.state !== receipt.status) fail("RETRY_PROOF_STATE");
      if (entry.attempts.some((item) => item.state === "UNKNOWN"))
        fail("UNKNOWN_BLOCKS_RETRY");
      if (entry.attempts.some((item) => item.state === "ACCEPTED"))
        fail("ALREADY_ACCEPTED");
      attempt.retryAuthorized = true;
      this.insert(entry);
    });
  }
  recover(intentId: string): { raw: string; entry: QueueEntry } {
    const entry = this.load(this.key(intentId));
    if (!entry) fail("MISSING_INTENT");
    return { raw: entry.raw, entry: exported(entry) };
  }
}
