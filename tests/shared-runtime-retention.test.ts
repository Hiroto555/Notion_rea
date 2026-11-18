import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import {
  CollaborationError,
  type Cut,
  type DocumentState,
  type Receipt,
  type RuntimeEvent,
  type Scope,
  scopeKey,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import {
  RETENTION_CHECKPOINT_KEY,
  RETENTION_CHECKPOINT_NAMESPACE,
  RetentionService,
  readRetentionCheckpoint,
  type BackupVerification,
  type RetentionCheckpoint,
} from "../src/collaboration/runtime/retention";

const EPOCH = "epoch_1";
const ORG = "org_1";
const USER = "user_1";
const WRITER_A = "writer_a";
const WRITER_B = "writer_b";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

function newStore(): RuntimeStore {
  const directory = mkdtempSync(join(tmpdir(), "folio-retention-"));
  directories.push(directory);
  const store = new RuntimeStore(directory);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      void 0;
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scope(incarnationId = "inc_1"): Scope {
  return {
    orgId: ORG,
    workspaceId: "ws_1",
    documentId: "doc_1",
    incarnationId,
  };
}

function documentWith(id: string): Doc {
  return {
    type: "doc",
    attrs: { id },
    content: [
      {
        type: "paragraph",
        attrs: { id: `${id}_p` },
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };
}

function stateWith(id: string): DocumentState {
  return {
    document: documentWith(id),
    tables: [
      {
        tableId: `${id}_table`,
        rowIds: [`${id}_row`],
        columnIds: [`${id}_col`],
      },
    ],
    tombstones: [`${id}_tomb`],
  };
}

function genesisCut(epoch = EPOCH): Cut {
  return { epoch, seq: 0, hash: digest({ epoch, genesis: 1 }) };
}

function initHead(store: RuntimeStore, epoch = EPOCH): Cut {
  const cut = genesisCut(epoch);
  store.transaction(() => {
    store.set("meta", "head", cut);
    store.set("authority.prefix", `${epoch}:0`, cut);
  });
  return cut;
}

function eventKey(seq: number): string {
  return String(seq).padStart(16, "0");
}

function makeEvent(
  seq: number,
  previousHash: string,
  writerId: string,
  targetScope: Scope,
  state: DocumentState | null,
  epoch = EPOCH,
  previousOverride?: string,
): RuntimeEvent {
  const intentId = `intent_${seq}`;
  const attemptId = `attempt_${seq}`;
  const command = { kind: "resource" as const, action: "test", payload: null };
  const status = "SERVER_ACCEPTED" as const;
  const resultHash = digest({ result: seq });
  const hash = digest({
    seq,
    epoch,
    previousHash: previousOverride ?? previousHash,
    scope: targetScope,
    intentId,
    attemptId,
    writerId,
    command,
    appliedText: null,
    state,
    status,
    code: null,
    resultHash,
  });
  const receipt: Receipt = {
    v: 1,
    status,
    intentId,
    intentHash: digest(intentId),
    attemptId,
    attemptHash: digest(attemptId),
    writerId,
    scope: targetScope,
    cut: { epoch, seq, hash },
    resultHash,
    code: null,
  };
  return {
    seq,
    epoch,
    previousHash: previousOverride ?? previousHash,
    hash,
    scope: targetScope,
    intentId,
    attemptId,
    writerId,
    command,
    appliedText: null,
    state,
    receipt,
  };
}

type Entry = { writerId: string; scope: Scope; state: DocumentState | null };

function appendEvents(
  store: RuntimeStore,
  entries: Entry[],
  startSeq: number,
  previousHash: string,
): { events: RuntimeEvent[]; cut: Cut } {
  const events: RuntimeEvent[] = [];
  let previous = previousHash;
  let seq = startSeq;
  store.transaction(() => {
    for (const entry of entries) {
      const event = makeEvent(
        seq,
        previous,
        entry.writerId,
        entry.scope,
        entry.state,
      );
      store.set("authority.events", eventKey(seq), event);
      store.set("authority.prefix", `${EPOCH}:${seq}`, event.receipt.cut);
      previous = event.hash;
      seq += 1;
      events.push(event);
    }
    const last = events[events.length - 1];
    store.set("meta", "head", last.receipt.cut);
  });
  const last = events[events.length - 1];
  return { events, cut: last.receipt.cut };
}

function seedWriter(
  store: RuntimeStore,
  writerId: string,
  deviceStatus: "active" | "revoked" = "revoked",
  sessionStatus: "active" | "revoked" = deviceStatus,
): void {
  const deviceId = `device_${writerId}`;
  const sessionId = `session_${writerId}`;
  const tokenHash = digest(`token_${writerId}`);
  store.transaction(() => {
    store.set("identity.devices", `${ORG}/${deviceId}`, {
      orgId: ORG,
      userId: USER,
      deviceId,
      writerId,
      sessionId,
      status: deviceStatus,
      generation: deviceStatus === "revoked" ? 2 : 1,
    });
    store.set("identity.sessions", tokenHash, {
      orgId: ORG,
      userId: USER,
      deviceId,
      writerId,
      sessionId,
      tokenHash,
      status: sessionStatus,
      generation: sessionStatus === "revoked" ? 2 : 1,
    });
  });
}

function seedAttempt(
  store: RuntimeStore,
  seq: number,
  writerId: string,
  target: Scope,
): void {
  const intentId = `intent_${seq}`;
  const attemptId = `attempt_${seq}`;
  const intent = {
    v: 1,
    intentId,
    writerId,
    scope: target,
    base: genesisCut(),
    command: { kind: "resource", action: "test", payload: null },
  };
  const attempt = { v: 1, attemptId, intent, base: genesisCut() };
  store.transaction(() => {
    store.set(
      "authority.attempts",
      `${scopeKey(target)}:${writerId}:${attemptId}`,
      {
        attempt,
        attemptHash: digest(attempt),
        intentHash: digest(intent),
        userId: USER,
        deviceId: `device_${writerId}`,
        state: "SERVER_ACCEPTED",
        receipt: null,
      },
    );
    store.set(
      "authority.intents",
      `${scopeKey(target)}:${writerId}:${intentId}`,
      {
        intentHash: digest(intent),
        userId: USER,
        writerId,
        accepted: null,
      },
    );
  });
}

function seedQueueUnknown(
  store: RuntimeStore,
  base: Cut,
  writerId = WRITER_A,
  intentId = "intent_queue",
): void {
  const target = scope();
  const intent = {
    v: 1,
    intentId,
    writerId,
    scope: target,
    base,
    command: { kind: "resource", action: "test", payload: null },
  };
  const attempt = { v: 1, attemptId: "attempt_queue", intent, base };
  const entry = {
    v: 1,
    scope: target,
    writerId,
    intent,
    intentHash: digest(intent),
    raw: JSON.stringify(intent),
    attempts: [
      {
        attempt,
        attemptHash: digest(attempt),
        state: "UNKNOWN",
        receipt: null,
        retryAuthorized: false,
      },
    ],
    state: "UNKNOWN",
  };
  store.transaction(() =>
    store.set(
      "client.queue",
      `${scopeKey(target)}:${writerId}:${intentId}`,
      entry,
    ),
  );
}

function expectCode(work: () => unknown, code: string): void {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CollaborationError);
  expect((caught as CollaborationError).code).toBe(code);
}

function eventsOf(store: RuntimeStore): RuntimeEvent[] {
  return store
    .all("authority.events")
    .map((entry) => entry.value as RuntimeEvent)
    .filter((event) => event.epoch === EPOCH)
    .sort((left, right) => left.seq - right.seq);
}

function checkpointOf(store: RuntimeStore): RetentionCheckpoint | null {
  return readRetentionCheckpoint(store);
}

function assertVerifySuffix(
  store: RuntimeStore,
  checkpoint: RetentionCheckpoint,
): void {
  const head = store.get("meta", "head") as Cut;
  const boundary = store.get(
    "authority.prefix",
    `${checkpoint.body.cut.epoch}:${checkpoint.body.cut.seq}`,
  ) as Cut;
  expect(boundary).toEqual(checkpoint.body.cut);
  let previous = checkpoint.body.cut;
  for (const event of eventsOf(store)) {
    expect(event.seq).toBe(previous.seq + 1);
    expect(event.previousHash).toBe(previous.hash);
    expect(event.receipt.cut).toEqual({
      epoch: event.epoch,
      seq: event.seq,
      hash: event.hash,
    });
    previous = event.receipt.cut;
  }
  expect(previous).toEqual(head);
}

describe("shared runtime retention against the real authority store", () => {
  it("prunes with a genuine verified restore while keeping dedup, receipts and the boundary prefix", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    const first = scope("inc_1");
    const second = scope("inc_2");
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [
        { writerId: WRITER_A, scope: first, state: stateWith("doc_first") },
        { writerId: WRITER_A, scope: first, state: stateWith("doc_second") },
        { writerId: WRITER_A, scope: second, state: stateWith("doc_third") },
      ],
      1,
      genesis.hash,
    );
    seedAttempt(store, 1, WRITER_A, first);
    seedQueueUnknown(store, seeded.cut);

    const destination = newStore();
    const verification = service.verifyBackup(
      seeded.cut,
      destination,
      "epoch_2",
    );
    const result = service.compact(seeded.cut, verification);

    expect(result.removed).toBe(3);
    expect(result.cut).toEqual(seeded.cut);
    expect(eventsOf(store)).toHaveLength(0);
    expect(store.get("meta", "head")).toEqual(seeded.cut);
    expect(store.get("authority.prefix", `${EPOCH}:0`)).toEqual(genesis);
    expect(store.get("authority.prefix", `${EPOCH}:3`)).toEqual(seeded.cut);
    expect(
      store.get(
        "authority.attempts",
        `${scopeKey(first)}:${WRITER_A}:attempt_1`,
      ),
    ).not.toBeNull();
    expect(
      store.get("authority.intents", `${scopeKey(first)}:${WRITER_A}:intent_1`),
    ).not.toBeNull();
    expect(
      store.get("client.queue", `${scopeKey(first)}:${WRITER_A}:intent_queue`),
    ).not.toBeNull();

    const checkpoint = checkpointOf(store);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.hash).toBe(result.checkpointHash);
    expect(digest(checkpoint!.body)).toBe(checkpoint!.hash);
    expect(checkpoint!.body.cut).toEqual(seeded.cut);
    expect(checkpoint!.body.previous).toBeNull();
    expect(checkpoint!.body.archive.removed).toBe(3);
    expect(checkpoint!.body.archive.backupHash).toBe(verification.backupHash);
    expect(checkpoint!.body.scopes).toHaveLength(2);
    const retained = checkpoint!.body.scopes.find(
      (entry) => entry.scope.incarnationId === "inc_1",
    );
    expect(retained!.state.document.attrs?.id).toBe("doc_second");
    expect(retained!.state.tables[0].tableId).toBe("doc_second_table");
    expect(checkpoint!.body.writerFences).toEqual([WRITER_A]);
    assertVerifySuffix(store, checkpoint!);
  });

  it("refuses without an issued verification and mutates nothing", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );

    expectCode(
      () => service.compact(seeded.cut, {} as BackupVerification),
      "BACKUP_NOT_VERIFIED",
    );
    expect(eventsOf(store)).toHaveLength(1);
    expect(checkpointOf(store)).toBeNull();
    expect(store.get("authority.prefix", `${EPOCH}:0`)).not.toBeNull();
  });

  it("refuses a verification issued by another service instance", () => {
    const store = newStore();
    const genesis = initHead(store);
    const writer = new RetentionService(store);
    const other = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verification = writer.verifyBackup(seeded.cut, newStore(), "epoch_2");

    expectCode(
      () => other.compact(seeded.cut, verification),
      "BACKUP_NOT_VERIFIED",
    );
    expect(eventsOf(store)).toHaveLength(1);
  });

  it("compacts an older verified prefix while preserving the later suffix", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    seedWriter(store, WRITER_B);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );
    appendEvents(
      store,
      [{ writerId: WRITER_B, scope: scope(), state: stateWith("doc_b") }],
      seeded.cut.seq + 1,
      seeded.cut.hash,
    );

    const compacted = service.compact(seeded.cut, verification);
    expect(compacted.cut).toEqual(seeded.cut);
    expect(eventsOf(store)).toHaveLength(1);
    expect(eventsOf(store)[0].seq).toBe(seeded.cut.seq + 1);
    expect(checkpointOf(store)?.body.cut).toEqual(seeded.cut);
  });

  it("refuses when any involved writer is not durably fenced", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A, "active");
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );

    expectCode(
      () => service.compact(seeded.cut, verification),
      "WRITER_NOT_FENCED",
    );
    expect(eventsOf(store)).toHaveLength(1);
    expect(checkpointOf(store)).toBeNull();
  });

  it("refuses when a revoked device still has an active session", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A, "revoked", "active");
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );

    expectCode(
      () => service.compact(seeded.cut, verification),
      "WRITER_NOT_FENCED",
    );
    expect(eventsOf(store)).toHaveLength(1);
  });

  it("refuses while a client queue attempt below the cut is UNKNOWN", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [
        { writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") },
        { writerId: WRITER_A, scope: scope(), state: stateWith("doc_b") },
      ],
      1,
      genesis.hash,
    );
    seedQueueUnknown(store, {
      epoch: EPOCH,
      seq: 1,
      hash: seeded.events[0].hash,
    });
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );

    expectCode(
      () => service.compact(seeded.cut, verification),
      "UNRESOLVED_UNKNOWN_ATTEMPT",
    );
    expect(eventsOf(store)).toHaveLength(2);
    expect(checkpointOf(store)).toBeNull();
    expect(service.inspect().unknownAttempts).toBe(1);
  });

  it("rejects an event whose stored hash does not match the authority formula", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const broken = { ...seeded.events[0], hash: "0".repeat(64) };
    store.transaction(() => store.set("authority.events", eventKey(1), broken));
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );

    expectCode(() => service.compact(seeded.cut, verification), "EVENT_DRIFT");
    expect(eventsOf(store)).toHaveLength(1);
  });

  it("rejects a broken previousHash chain even when each event hash is self-consistent", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [
        { writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") },
        { writerId: WRITER_A, scope: scope(), state: stateWith("doc_b") },
      ],
      1,
      genesis.hash,
    );
    const broken = makeEvent(
      2,
      seeded.events[1].previousHash,
      WRITER_A,
      scope(),
      stateWith("doc_b"),
      EPOCH,
      digest("wrong-previous"),
    );
    store.transaction(() => {
      store.set("authority.events", eventKey(2), broken);
      store.set("authority.prefix", `${EPOCH}:2`, broken.receipt.cut);
      store.set("meta", "head", broken.receipt.cut);
    });
    const verification = service.verifyBackup(
      broken.receipt.cut,
      newStore(),
      "epoch_2",
    );

    expectCode(
      () => service.compact(broken.receipt.cut, verification),
      "EVENT_CHAIN_DRIFT",
    );
    expect(eventsOf(store)).toHaveLength(2);
  });

  it("rejects a drifted checkpoint instead of falling back to genesis", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    store.transaction(() =>
      store.set(RETENTION_CHECKPOINT_NAMESPACE, RETENTION_CHECKPOINT_KEY, {
        v: 1,
        hash: "0".repeat(64),
        body: { v: 1 },
      }),
    );
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );

    expectCode(
      () => service.compact(seeded.cut, verification),
      "CHECKPOINT_DRIFT",
    );
    expect(eventsOf(store)).toHaveLength(1);
  });

  it("merges scopes and chains checkpoints across repeated compaction", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    const first = scope("inc_merge");
    const second = scope("inc_other");
    seedWriter(store, WRITER_A);
    const runOne = appendEvents(
      store,
      [
        { writerId: WRITER_A, scope: first, state: stateWith("first_a") },
        { writerId: WRITER_A, scope: first, state: stateWith("first_b") },
      ],
      1,
      genesis.hash,
    );
    const verificationOne = service.verifyBackup(
      runOne.cut,
      newStore(),
      "epoch_2",
    );
    const compactOne = service.compact(runOne.cut, verificationOne);
    const checkpointOne = checkpointOf(store)!;

    seedWriter(store, WRITER_B);
    const runTwo = appendEvents(
      store,
      [
        { writerId: WRITER_B, scope: first, state: stateWith("second_a") },
        { writerId: WRITER_B, scope: second, state: stateWith("second_b") },
      ],
      runOne.cut.seq + 1,
      runOne.cut.hash,
    );
    const verificationTwo = service.verifyBackup(
      runTwo.cut,
      newStore(),
      "epoch_3",
    );
    const compactTwo = service.compact(runTwo.cut, verificationTwo);
    const checkpointTwo = checkpointOf(store)!;

    expect(compactOne.removed).toBe(2);
    expect(compactTwo.removed).toBe(2);
    expect(checkpointTwo.body.cut).toEqual(runTwo.cut);
    expect(checkpointTwo.body.previous).toEqual({
      hash: checkpointOne.hash,
      cut: checkpointOne.body.cut,
    });
    const retained = checkpointTwo.body.scopes.find(
      (entry) => entry.scope.incarnationId === "inc_merge",
    );
    expect(retained!.state.document.attrs?.id).toBe("second_a");
    const other = checkpointTwo.body.scopes.find(
      (entry) => entry.scope.incarnationId === "inc_other",
    );
    expect(other!.state.document.attrs?.id).toBe("second_b");
    expect(checkpointTwo.body.writerFences).toEqual([WRITER_A, WRITER_B]);
    expect(eventsOf(store)).toHaveLength(0);
    expect(store.get("authority.prefix", `${EPOCH}:0`)).toEqual(genesis);
    expect(store.get("authority.prefix", `${EPOCH}:2`)).toEqual(runOne.cut);
    expect(store.get("authority.prefix", `${EPOCH}:4`)).toEqual(runTwo.cut);
    assertVerifySuffix(store, checkpointTwo);
  });

  it("reports real authority namespaces and client queue counts", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    seedAttempt(store, 1, WRITER_A, scope());
    seedQueueUnknown(store, seeded.cut);

    const inspection = service.inspect();
    expect(inspection.eventRows).toBe(1);
    expect(inspection.attemptRows).toBe(1);
    expect(inspection.intentRows).toBe(1);
    expect(inspection.queueEntries).toBe(1);
    expect(inspection.unknownAttempts).toBe(1);
    expect(inspection.bytes).toBeGreaterThan(0);
    expect(inspection).not.toHaveProperty("receiptRows");
  });

  it("fails closed when the genesis prefix proof is missing", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    store.transaction(() => store.set("authority.prefix", `${EPOCH}:0`, null));
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );

    expectCode(
      () => service.compact(seeded.cut, verification),
      "PREFIX_PROOF_MISSING",
    );
    expect(eventsOf(store)).toHaveLength(1);
    expect(checkpointOf(store)).toBeNull();
  });

  it("fails closed on a malformed client queue entry", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    store.transaction(() =>
      store.set("client.queue", "broken", { v: 1, attempts: [{}] }),
    );

    expectCode(() => service.inspect(), "CLIENT_QUEUE_DRIFT");
    expectCode(
      () =>
        service.compact(
          seeded.cut,
          service.verifyBackup(seeded.cut, newStore(), "epoch_2"),
        ),
      "CLIENT_QUEUE_DRIFT",
    );
    expect(eventsOf(store)).toHaveLength(1);
  });

  it("keeps the UNKNOWN boundary attempt at the cut non-blocking", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_A);
    const seeded = appendEvents(
      store,
      [
        { writerId: WRITER_A, scope: scope(), state: stateWith("doc_a") },
        { writerId: WRITER_A, scope: scope(), state: stateWith("doc_b") },
      ],
      1,
      genesis.hash,
    );
    seedQueueUnknown(store, seeded.cut);
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_2",
    );

    const result = service.compact(seeded.cut, verification);
    expect(result.removed).toBe(2);
    expect(eventsOf(store)).toHaveLength(0);
    expect(checkpointOf(store)!.body.cut).toEqual(seeded.cut);
  });
});
