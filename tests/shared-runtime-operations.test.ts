import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CollaborationError,
  scopeKey,
  type AuthContext,
  type Cut,
  type DocumentState,
  type RuntimeEvent,
  type Scope,
} from "../src/collaboration/runtime/contract";
import {
  BASE_PROTOCOL_VERSION,
  BASE_STORAGE_FORMAT,
  OPERATIONS_NAMESPACES,
  RuntimeOperations,
  SUPPORTED_TARGET_VERSION,
  type MigrationContext,
} from "../src/collaboration/runtime/operations";
import { RuntimeStore } from "../src/collaboration/runtime/store";

const ORG_A = "orgA";
const ORG_B = "orgB";
const EPOCH = "epoch_1";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const EVENT_HASH = "d".repeat(64);

const openDirectories: string[] = [];
const openStores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      // A failed assertion may already have poisoned or closed the store.
    }
  }
  openStores.length = 0;
  for (const directory of openDirectories)
    rmSync(directory, { recursive: true, force: true });
  openDirectories.length = 0;
});

function openStore(): RuntimeStore {
  const directory = mkdtempSync(join(tmpdir(), "folio-operations-"));
  openDirectories.push(directory);
  const store = new RuntimeStore(directory);
  openStores.push(store);
  return store;
}

function put(
  store: RuntimeStore,
  namespace: string,
  key: string,
  value: unknown,
): void {
  store.transaction(() => store.set(namespace, key, value));
}

function auth(userId = "user_1"): AuthContext {
  return {
    userId,
    deviceId: "device_1",
    writerId: "writer_1",
    sessionId: "session_1",
  };
}

function cut(seq: number, mark = "a"): Cut {
  return { epoch: EPOCH, seq, hash: mark.repeat(64) };
}

function scope(orgId = ORG_A, documentId = "doc_1"): Scope {
  return {
    orgId,
    workspaceId: "workspace_1",
    documentId,
    incarnationId: "incarnation_1",
  };
}

function allow(): void {}

function operations(
  store: RuntimeStore,
  authorize: (
    auth: AuthContext,
    orgId: string,
    action: "audit" | "manage",
  ) => void = allow,
  migrationRunner?: (context: MigrationContext) => void,
): RuntimeOperations {
  return new RuntimeOperations(store, authorize, migrationRunner);
}

function expectCode(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error(`expected CollaborationError ${code}`);
}

function seedHead(store: RuntimeStore, value: Cut): void {
  put(store, "meta", "head", value);
}

function seedDocument(store: RuntimeStore, value: Scope): void {
  const state: DocumentState = {
    document: { type: "doc", attrs: { id: `body_${value.documentId}` } },
    tables: [],
    tombstones: [],
  };
  put(store, "documents", scopeKey(value), state);
}

function eventValue(
  seq: number,
  valueScope: Scope,
  options: {
    epoch?: string;
    status?: "SERVER_ACCEPTED" | "REJECTED" | "INVALIDATED";
    code?: string | null;
  } = {},
): RuntimeEvent {
  const epoch = options.epoch ?? EPOCH;
  const status = options.status ?? "SERVER_ACCEPTED";
  const code = options.code ?? null;
  const receiptCut: Cut = { epoch, seq, hash: EVENT_HASH };
  return {
    seq,
    epoch,
    previousHash: "0".repeat(64),
    hash: EVENT_HASH,
    scope: valueScope,
    intentId: `intent_${seq}`,
    attemptId: `attempt_${seq}`,
    writerId: "writer_1",
    command: {
      kind: "resource",
      action: "secret.command",
      payload: { token: "do-not-return-this" },
    },
    appliedText: null,
    state: {
      document: { type: "doc", attrs: { id: "secret_body" } },
      tables: [],
      tombstones: [],
    },
    receipt: {
      v: 1,
      status,
      intentId: `intent_${seq}`,
      intentHash: "e".repeat(64),
      attemptId: `attempt_${seq}`,
      attemptHash: "f".repeat(64),
      writerId: "writer_1",
      scope: valueScope,
      cut: receiptCut,
      resultHash: "1".repeat(64),
      code,
    },
  };
}

function seedEvent(
  store: RuntimeStore,
  seq: number,
  valueScope: Scope,
  options: {
    epoch?: string;
    status?: "SERVER_ACCEPTED" | "REJECTED" | "INVALIDATED";
    code?: string | null;
    key?: string;
  } = {},
): void {
  put(
    store,
    "authority.events",
    options.key ?? String(seq).padStart(16, "0"),
    eventValue(seq, valueScope, options),
  );
}

function seedIntent(
  store: RuntimeStore,
  valueScope: Scope,
  writerId: string,
  intentId: string,
  accepted: unknown | null,
): void {
  put(
    store,
    "authority.intents",
    `${scopeKey(valueScope)}:${writerId}:${intentId}`,
    {
      intentHash: "e".repeat(64),
      userId: "user_1",
      writerId,
      accepted,
    },
  );
}

function seedTerminalAttempt(
  store: RuntimeStore,
  valueScope: Scope,
  writerId: string,
  intentId: string,
): void {
  const base = cut(1);
  put(
    store,
    "authority.attempts",
    `${scopeKey(valueScope)}:${writerId}:attempt_${intentId}`,
    {
      attempt: {
        v: 1,
        attemptId: `attempt_${intentId}`,
        intent: {
          v: 1,
          intentId,
          writerId,
          scope: valueScope,
          base,
          command: { kind: "resource", action: "record.patch", payload: {} },
        },
        base,
      },
      attemptHash: "f".repeat(64),
      intentHash: "e".repeat(64),
      userId: "user_1",
      deviceId: "device_1",
      state: "REJECTED",
      receipt: {
        v: 1,
        status: "REJECTED",
        intentId,
        intentHash: "e".repeat(64),
        attemptId: `attempt_${intentId}`,
        attemptHash: "f".repeat(64),
        writerId,
        scope: valueScope,
        cut: cut(2, "c"),
        resultHash: "1".repeat(64),
        code: "REJECTED",
      },
    },
  );
}

function seedVerification(
  store: RuntimeStore,
  backupHash: string,
  value: Cut,
  key = backupHash,
): void {
  put(store, OPERATIONS_NAMESPACES.verifications, key, {
    backupHash,
    epoch: value.epoch,
    cut: value,
  });
}

function bytesHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("shared runtime operations against the actual runtime store", () => {
  it("reports the actual head, documents, events, intents, backups and capacity", () => {
    const store = openStore();
    const runtime = operations(store);
    const head = cut(5);
    const scopeA = scope(ORG_A);
    const scopeB = scope(ORG_B, "doc_b");

    seedHead(store, head);
    seedDocument(store, scopeA);
    seedDocument(store, scope(ORG_A, "doc_2"));
    seedDocument(store, scopeB);

    seedEvent(store, 1, scopeA);
    seedEvent(store, 2, scopeA, {
      status: "REJECTED",
      code: "BASE_MISMATCH",
    });
    seedEvent(store, 4, scopeA);
    seedEvent(store, 5, scope(ORG_A, "doc_event_only"));
    seedEvent(store, 3, scopeB);
    seedEvent(store, 6, scopeA, { epoch: "epoch_0" });

    seedIntent(store, scopeA, "writer_1", "intent_applied", {
      status: "SERVER_ACCEPTED",
    });
    seedIntent(store, scopeA, "writer_1", "intent_rejected", null);
    seedTerminalAttempt(store, scopeA, "writer_1", "intent_rejected");
    seedIntent(store, scopeA, "writer_1", "intent_unknown", null);
    seedIntent(store, scopeB, "writer_2", "intent_other", null);

    seedVerification(store, HASH_A, head);
    runtime.recordBackup(auth(), ORG_A, {
      hash: HASH_A,
      cut: head,
      verified: true,
    });

    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const blobHash = bytesHash(blob);
    store.transaction(() =>
      store.blobPut(`${ORG_A}:${scopeKey(scopeA)}`, blobHash, blob),
    );

    const overview = runtime.overview(auth(), ORG_A);
    expect(overview.cut).toEqual(head);
    expect(overview.documents).toBe(2);
    expect(overview.pending).toBe(1);
    expect(overview.backups).toEqual([
      { hash: HASH_A, cut: head, verified: true },
    ]);
    expect(overview.retention.events).toBe(4);
    expect(overview.retention.intents).toBe(3);
    expect(overview.retention.attempts).toBe(1);
    expect(overview.retention.prefixes).toBe(0);
    expect(overview.retention.verifications).toBe(1);
    expect(overview.recordBytes).toBeGreaterThan(0);
    expect(overview.blobBytes).toBe(5);
    expect(overview.status).toBe("READY");
  });

  it("audits only the current epoch and requested organization without content leakage", () => {
    const store = openStore();
    const runtime = operations(store);
    const head = cut(5);
    const scopeA = scope(ORG_A);
    const scopeB = scope(ORG_B, "doc_b");
    seedHead(store, head);
    seedEvent(store, 1, scopeA);
    seedEvent(store, 2, scopeA, {
      status: "REJECTED",
      code: "BASE_MISMATCH",
    });
    seedEvent(store, 3, scopeB);
    seedEvent(store, 4, scopeA);
    seedEvent(store, 7, scopeA, { epoch: "epoch_0" });

    const audit = runtime.audit(auth(), ORG_A, 1, 10);
    expect(audit.cut).toEqual(head);
    expect(audit.events.map((event) => event.seq)).toEqual([2, 4]);
    expect(audit.events[0]).toEqual({
      seq: 2,
      intentId: "intent_2",
      writerId: "writer_1",
      scope: scopeA,
      status: "REJECTED",
      code: "BASE_MISMATCH",
    });
    for (const event of audit.events) {
      expect(Object.keys(event).sort()).toEqual([
        "code",
        "intentId",
        "scope",
        "seq",
        "status",
        "writerId",
      ]);
      expect(JSON.stringify(event)).not.toContain("do-not-return-this");
      expect(JSON.stringify(event)).not.toContain("secret_body");
    }

    expect(runtime.audit(auth(), ORG_A, 1, 1).events.map((e) => e.seq)).toEqual(
      [2],
    );
    expect(runtime.audit(auth(), ORG_A, 0, 0).events).toEqual([]);
    expect(runtime.audit(auth(), ORG_B).events.map((e) => e.seq)).toEqual([3]);
    expectCode(() => runtime.audit(auth(), ORG_A, 0, 1001), "INVALID_LIMIT");
  });

  it("rejects a fabricated green backup and only trusts restore verification records", () => {
    const store = openStore();
    const runtime = operations(store);
    const head = cut(3);
    seedHead(store, head);

    expectCode(
      () =>
        runtime.recordBackup(auth(), ORG_A, {
          hash: HASH_A,
          cut: head,
          verified: true,
        }),
      "BACKUP_VERIFICATION_REQUIRED",
    );
    expect(
      store.get(OPERATIONS_NAMESPACES.backups, `${ORG_A}:${HASH_A}`),
    ).toBeNull();

    seedVerification(store, HASH_A, cut(2, "b"));
    expectCode(
      () =>
        runtime.recordBackup(auth(), ORG_A, {
          hash: HASH_A,
          cut: head,
          verified: true,
        }),
      "BACKUP_VERIFICATION_REQUIRED",
    );

    seedVerification(store, HASH_A, head);
    runtime.recordBackup(auth(), ORG_A, {
      hash: HASH_A,
      cut: head,
      verified: true,
    });
    expect(runtime.overview(auth(), ORG_A).backups).toEqual([
      { hash: HASH_A, cut: head, verified: true },
    ]);

    put(store, OPERATIONS_NAMESPACES.verifications, HASH_A, null);
    expect(runtime.overview(auth(), ORG_A).backups).toEqual([
      { hash: HASH_A, cut: head, verified: false },
    ]);

    put(store, OPERATIONS_NAMESPACES.verifications, HASH_A, {
      hash: HASH_A,
      cut: head,
    });
    expectCode(() => runtime.overview(auth(), ORG_A), "CORRUPT_VERIFICATION");
  });

  it("refuses a successful no-op migration without the registered runner", () => {
    const store = openStore();
    const runtime = operations(store);
    const head = cut(7);
    seedHead(store, head);
    seedVerification(store, HASH_A, head);
    runtime.recordBackup(auth(), ORG_A, {
      hash: HASH_A,
      cut: head,
      verified: true,
    });

    expect(
      runtime.planUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION),
    ).toEqual({
      current: BASE_PROTOCOL_VERSION,
      target: SUPPORTED_TARGET_VERSION,
      canWrite: true,
      requiresBackup: true,
    });
    expectCode(
      () => runtime.planUpgrade(auth(), ORG_A, 1005),
      "UNSUPPORTED_UPGRADE",
    );
    expectCode(
      () => runtime.planUpgrade(auth(), ORG_A, BASE_PROTOCOL_VERSION),
      "NOT_AN_UPGRADE",
    );

    runtime.beginUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION, HASH_A);
    expect(runtime.overview(auth(), ORG_A).status).toBe("PRESSURE");
    expectCode(
      () => runtime.assertWriter(BASE_PROTOCOL_VERSION),
      "WRITER_FENCED",
    );
    expectCode(
      () => runtime.finishUpgrade(auth(), ORG_A, true),
      "MIGRATION_REQUIRED",
    );
    expectCode(
      () => runtime.assertWriter(BASE_PROTOCOL_VERSION),
      "WRITER_FENCED",
    );
    const state = store.get(OPERATIONS_NAMESPACES.upgrades, ORG_A) as {
      status?: unknown;
    };
    expect(state.status).toBe("ACTIVE");

    runtime.finishUpgrade(auth(), ORG_A, false);
    expect(runtime.overview(auth(), ORG_A).status).toBe("RECOVERY_REQUIRED");
    expectCode(
      () => runtime.assertWriter(BASE_PROTOCOL_VERSION),
      "RECOVERY_REQUIRED",
    );
    expectCode(
      () => runtime.finishUpgrade(auth(), ORG_A, true),
      "NO_ACTIVE_UPGRADE",
    );
  });

  it("applies protocol current and fences only after the runner succeeds", () => {
    const store = openStore();
    const calls: MigrationContext[] = [];
    const runtime = operations(store, allow, (context) => {
      calls.push(context);
    });
    const head = cut(7);
    seedHead(store, head);
    seedVerification(store, HASH_A, head);
    runtime.recordBackup(auth(), ORG_A, {
      hash: HASH_A,
      cut: head,
      verified: true,
    });

    runtime.beginUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION, HASH_A);
    runtime.finishUpgrade(auth(), ORG_A, true);

    expect(calls).toHaveLength(1);
    expect(calls[0].orgId).toBe(ORG_A);
    expect(calls[0].storageFormat).toBe(BASE_STORAGE_FORMAT);
    expect(calls[0].fromProtocol).toBe(BASE_PROTOCOL_VERSION);
    expect(calls[0].toProtocol).toBe(SUPPORTED_TARGET_VERSION);
    expect(calls[0].backupHash).toBe(HASH_A);

    expect(() => runtime.assertWriter(SUPPORTED_TARGET_VERSION)).not.toThrow();
    expectCode(
      () => runtime.assertWriter(BASE_PROTOCOL_VERSION),
      "WRITER_VERSION_MISMATCH",
    );
    expect(runtime.overview(auth(), ORG_A).status).toBe("READY");
    expectCode(
      () => runtime.planUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION),
      "NOT_AN_UPGRADE",
    );

    const version = store.db.prepare("PRAGMA user_version").get() as {
      user_version?: unknown;
    };
    expect(version.user_version).toBe(BASE_STORAGE_FORMAT);
  });

  it("rolls back runner writes and keeps the old writer fenced when the runner fails", () => {
    const store = openStore();
    const runtime = operations(store, allow, (context) => {
      context.store.transaction(() =>
        context.store.set("migration.probe", "touched", { value: true }),
      );
      throw new Error("migration failed");
    });
    const head = cut(2);
    seedHead(store, head);
    seedVerification(store, HASH_A, head);
    runtime.recordBackup(auth(), ORG_A, {
      hash: HASH_A,
      cut: head,
      verified: true,
    });

    runtime.beginUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION, HASH_A);
    expect(() => runtime.finishUpgrade(auth(), ORG_A, true)).toThrow(
      "migration failed",
    );
    expect(store.get("migration.probe", "touched")).toBeNull();
    expectCode(
      () => runtime.assertWriter(BASE_PROTOCOL_VERSION),
      "WRITER_FENCED",
    );
    const state = store.get(OPERATIONS_NAMESPACES.upgrades, ORG_A) as {
      status?: unknown;
    };
    expect(state.status).toBe("ACTIVE");
  });

  it("keeps authority data and blocks every writer after a failed upgrade", () => {
    const store = openStore();
    const runtime = operations(store);
    const head = cut(3);
    const scopeA = scope(ORG_A);
    seedHead(store, head);
    seedDocument(store, scopeA);
    seedEvent(store, 1, scopeA);
    seedVerification(store, HASH_A, head);
    runtime.recordBackup(auth(), ORG_A, {
      hash: HASH_A,
      cut: head,
      verified: true,
    });
    const blob = new Uint8Array([9, 8, 7, 6]);
    store.transaction(() =>
      store.blobPut(`${ORG_A}:${scopeKey(scopeA)}`, bytesHash(blob), blob),
    );

    const before = runtime.overview(auth(), ORG_A);
    runtime.beginUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION, HASH_A);
    runtime.finishUpgrade(auth(), ORG_A, false);
    const after = runtime.overview(auth(), ORG_A);

    expect(after.status).toBe("RECOVERY_REQUIRED");
    expect(after.documents).toBe(before.documents);
    expect(after.blobBytes).toBe(before.blobBytes);
    expect(after.backups).toEqual(before.backups);
    expect(after.retention.events).toBe(before.retention.events);
    expect(runtime.audit(auth(), ORG_A).events.map((e) => e.seq)).toEqual([1]);
    expectCode(
      () => runtime.assertWriter(BASE_PROTOCOL_VERSION),
      "RECOVERY_REQUIRED",
    );
    expectCode(
      () => runtime.assertWriter(SUPPORTED_TARGET_VERSION),
      "RECOVERY_REQUIRED",
    );
  });

  it("rejects stale and unrecorded backups before writing upgrade state", () => {
    const store = openStore();
    const runtime = operations(store);
    const head = cut(7);
    seedHead(store, head);
    seedVerification(store, HASH_B, cut(6, "b"));
    runtime.recordBackup(auth(), ORG_A, {
      hash: HASH_B,
      cut: cut(6, "b"),
      verified: true,
    });

    expectCode(
      () =>
        runtime.beginUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION, HASH_A),
      "BACKUP_MISSING",
    );
    put(store, OPERATIONS_NAMESPACES.verifications, HASH_B, null);
    expectCode(
      () =>
        runtime.beginUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION, HASH_B),
      "BACKUP_NOT_VERIFIED",
    );
    seedVerification(store, HASH_B, cut(6, "b"));
    expectCode(
      () =>
        runtime.beginUpgrade(auth(), ORG_A, SUPPORTED_TARGET_VERSION, HASH_B),
      "STALE_BACKUP",
    );
    expectCode(
      () => runtime.beginUpgrade(auth(), ORG_A, 1005, HASH_B),
      "UNSUPPORTED_UPGRADE",
    );
    expect(store.get(OPERATIONS_NAMESPACES.upgrades, ORG_A)).toBeNull();
    expect(store.get(OPERATIONS_NAMESPACES.fences, ORG_A)).toBeNull();
  });

  it("authorizes every read and write before mutating", () => {
    const store = openStore();
    const denied = (
      value: AuthContext,
      _orgId: string,
      action: "audit" | "manage",
    ): void => {
      if (value.userId === "intruder")
        throw new CollaborationError("FORBIDDEN");
      if (action === "manage") throw new CollaborationError("READ_ONLY");
    };
    const runtime = operations(store, denied);
    const head = cut(1);
    seedHead(store, head);
    seedVerification(store, HASH_A, head);

    expectCode(() => runtime.overview(auth("intruder"), ORG_A), "FORBIDDEN");
    expectCode(() => runtime.audit(auth("intruder"), ORG_A), "FORBIDDEN");
    expectCode(
      () =>
        runtime.recordBackup(auth(), ORG_A, {
          hash: HASH_A,
          cut: head,
          verified: true,
        }),
      "READ_ONLY",
    );
    expectCode(
      () =>
        runtime.beginUpgrade(
          auth("intruder"),
          ORG_A,
          SUPPORTED_TARGET_VERSION,
          HASH_A,
        ),
      "FORBIDDEN",
    );
    expect(
      store.get(OPERATIONS_NAMESPACES.backups, `${ORG_A}:${HASH_A}`),
    ).toBeNull();
    expect(store.get(OPERATIONS_NAMESPACES.upgrades, ORG_A)).toBeNull();
    expect(store.get(OPERATIONS_NAMESPACES.fences, ORG_A)).toBeNull();
  });

  it("refuses corrupt authority rows rather than inventing a clean report", () => {
    const store = openStore();
    const runtime = operations(store);
    expectCode(() => runtime.overview(auth(), ORG_A), "HEAD_MISSING");

    seedHead(store, { epoch: EPOCH, seq: 1, hash: "not-a-hash" } as Cut);
    expectCode(() => runtime.overview(auth(), ORG_A), "CORRUPT_HEAD");

    const scopeA = scope(ORG_A);
    seedHead(store, cut(1));
    seedEvent(store, 1, scopeA, { key: "1" });
    expectCode(() => runtime.audit(auth(), ORG_A), "ROW_KEY_MISMATCH");

    put(store, "authority.events", "1", null);
    put(store, "documents", `${ORG_A}:workspace_1:doc_1`, {
      document: { type: "doc", attrs: { id: "body" } },
      tables: [],
      tombstones: [],
    });
    expectCode(() => runtime.overview(auth(), ORG_A), "ROW_KEY_MISMATCH");
  });
});
