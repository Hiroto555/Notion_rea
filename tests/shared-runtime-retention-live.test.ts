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
import { canonical } from "../src/collaboration/runtime/canonical";
import { digest } from "../src/collaboration/runtime/digest";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import {
  RETENTION_CHECKPOINT_KEY,
  RETENTION_CHECKPOINT_NAMESPACE,
  RetentionService,
  readRetentionCheckpoint,
  type BackupVerification,
  type RetentionCheckpoint,
} from "../src/collaboration/runtime/retention";

const EPOCH = "epoch_live";
const ORG = "org_live";
const USER = "user_live";
const WORKSPACE = "ws_live";
const DOCUMENT = "doc_live";
const WRITER_OLD = "writer_old";
const WRITER_NEW = "writer_new";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
const authorities: SharedAuthority[] = [];

function newDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-retention-live-"));
  directories.push(directory);
  return directory;
}

function newStore(): RuntimeStore {
  const store = new RuntimeStore(newDirectory());
  stores.push(store);
  return store;
}

function newAuthority(): SharedAuthority {
  const authority = new SharedAuthority(newDirectory());
  authorities.push(authority);
  return authority;
}

afterEach(() => {
  for (const authority of authorities.splice(0)) {
    try {
      authority.close();
    } catch {
      void 0;
    }
  }
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

function scope(incarnationId = "inc_live"): Scope {
  return {
    orgId: ORG,
    workspaceId: WORKSPACE,
    documentId: DOCUMENT,
    incarnationId,
  };
}

function documentWith(id: string): Doc {
  return {
    type: "doc",
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
  status: "active" | "revoked" = "revoked",
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
      status,
      generation: status === "revoked" ? 2 : 1,
    });
    store.set("identity.sessions", tokenHash, {
      orgId: ORG,
      userId: USER,
      deviceId,
      writerId,
      sessionId,
      tokenHash,
      status,
      generation: status === "revoked" ? 2 : 1,
    });
  });
}

function seedQueueUnknown(
  store: RuntimeStore,
  base: Cut,
  writerId = WRITER_OLD,
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
  store.transaction(() =>
    store.set("client.queue", `${scopeKey(target)}:${writerId}:${intentId}`, {
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
    }),
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
    .filter((event) => event.epoch === (store.get("meta", "head") as Cut).epoch)
    .sort((left, right) => left.seq - right.seq);
}

function checkpointOf(store: RuntimeStore): RetentionCheckpoint | null {
  return readRetentionCheckpoint(store);
}

function namespaces(store: RuntimeStore, selected: readonly string[]): string {
  return canonical(
    selected.map((namespace) => ({ namespace, rows: store.all(namespace) })),
  );
}

describe("retention compaction across an advancing head", () => {
  it("compacts an older verified cut and retains the active suffix writer", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_OLD);
    const prefixRun = appendEvents(
      store,
      [
        {
          writerId: WRITER_OLD,
          scope: scope(),
          state: stateWith("doc_prefix"),
        },
      ],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      prefixRun.cut,
      newStore(),
      "epoch_restore",
    );

    seedWriter(store, WRITER_NEW, "active");
    const suffixRun = appendEvents(
      store,
      [
        {
          writerId: WRITER_NEW,
          scope: scope(),
          state: stateWith("doc_suffix"),
        },
      ],
      prefixRun.cut.seq + 1,
      prefixRun.cut.hash,
    );

    const result = service.compact(prefixRun.cut, verification);

    expect(result.removed).toBe(1);
    expect(result.cut).toEqual(prefixRun.cut);
    expect(eventsOf(store)).toEqual(suffixRun.events);
    const checkpoint = checkpointOf(store)!;
    expect(checkpoint.body.cut).toEqual(prefixRun.cut);
    expect(checkpoint.body.archive.removed).toBe(1);
    expect(checkpoint.body.archive.backupHash).toBe(verification.backupHash);
    expect(checkpoint.body.writerFences).toEqual([WRITER_OLD]);
    expect(checkpoint.body.scopes).toHaveLength(1);
    expect(
      checkpoint.body.scopes[0]!.state.document.content?.[0]?.attrs?.id,
    ).toBe("doc_prefix_p");
    expect(
      store.get("authority.prefix", `${EPOCH}:${prefixRun.cut.seq}`),
    ).toEqual(prefixRun.cut);
    expect(
      store.get("authority.prefix", `${EPOCH}:${suffixRun.cut.seq}`),
    ).toEqual(suffixRun.cut);
    expect(
      store.get("identity.devices", `${ORG}/device_${WRITER_NEW}`),
    ).toMatchObject({
      status: "active",
    });
  });

  it("uses the privately issued cut, not mutable public proof fields", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_OLD);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_OLD, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_restore",
    );
    (verification.cut as { seq: number }).seq = 9_999;

    const result = service.compact(seeded.cut, verification);

    expect(result.cut).toEqual(seeded.cut);
    expect(eventsOf(store)).toHaveLength(0);
    expect(checkpointOf(store)!.body.cut).toEqual(seeded.cut);
  });

  it("still compacts at the current head exactly as before", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_OLD);
    const seeded = appendEvents(
      store,
      [
        {
          writerId: WRITER_OLD,
          scope: scope("inc_one"),
          state: stateWith("doc_a"),
        },
        {
          writerId: WRITER_OLD,
          scope: scope("inc_two"),
          state: stateWith("doc_b"),
        },
      ],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_restore",
    );

    const result = service.compact(seeded.cut, verification);

    expect(result.removed).toBe(2);
    expect(eventsOf(store)).toHaveLength(0);
    const checkpoint = checkpointOf(store)!;
    expect(checkpoint.body.cut).toEqual(seeded.cut);
    expect(checkpoint.body.scopes).toHaveLength(2);
    expect(checkpoint.body.archive.fromSeq).toBe(1);
    expect(checkpoint.body.archive.throughSeq).toBe(2);
  });

  it("refuses when a writer with events at or before the cut is still active", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_OLD, "active");
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_OLD, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_restore",
    );

    expectCode(
      () => service.compact(seeded.cut, verification),
      "WRITER_NOT_FENCED",
    );
    expect(eventsOf(store)).toHaveLength(1);
    expect(checkpointOf(store)).toBeNull();
  });

  it("refuses forged, replayed and cross-instance proofs without mutation", () => {
    const store = newStore();
    const genesis = initHead(store);
    const issuer = new RetentionService(store);
    const other = new RetentionService(store);
    const otherStore = newStore();
    initHead(otherStore);
    const crossStore = new RetentionService(otherStore);
    seedWriter(store, WRITER_OLD);
    const seeded = appendEvents(
      store,
      [{ writerId: WRITER_OLD, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verification = issuer.verifyBackup(
      seeded.cut,
      newStore(),
      "epoch_restore",
    );
    const forged = {
      ...verification,
      backupHash: digest("forged-backup"),
    } as BackupVerification;

    expectCode(
      () => other.compact(seeded.cut, verification),
      "BACKUP_NOT_VERIFIED",
    );
    expectCode(
      () => crossStore.compact(seeded.cut, verification),
      "BACKUP_NOT_VERIFIED",
    );
    expectCode(() => issuer.compact(seeded.cut, forged), "BACKUP_NOT_VERIFIED");
    expect(eventsOf(store)).toHaveLength(1);
    expect(checkpointOf(store)).toBeNull();
  });

  it("validates the retained suffix chain through the current head", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_OLD);
    seedWriter(store, WRITER_NEW, "active");
    const prefixRun = appendEvents(
      store,
      [
        {
          writerId: WRITER_OLD,
          scope: scope(),
          state: stateWith("doc_prefix"),
        },
      ],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      prefixRun.cut,
      newStore(),
      "epoch_restore",
    );
    const broken = makeEvent(
      prefixRun.cut.seq + 1,
      prefixRun.cut.hash,
      WRITER_NEW,
      scope(),
      stateWith("doc_suffix"),
      EPOCH,
      digest("wrong-previous"),
    );
    store.transaction(() => {
      store.set("authority.events", eventKey(broken.seq), broken);
      store.set(
        "authority.prefix",
        `${EPOCH}:${broken.seq}`,
        broken.receipt.cut,
      );
      store.set("meta", "head", broken.receipt.cut);
    });

    expectCode(
      () => service.compact(prefixRun.cut, verification),
      "EVENT_CHAIN_DRIFT",
    );
    expect(eventsOf(store)).toHaveLength(2);
    expect(checkpointOf(store)).toBeNull();
  });

  it("refuses an unknown queue attempt before the cut but allows one in the suffix", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_OLD);
    const prefixRun = appendEvents(
      store,
      [
        {
          writerId: WRITER_OLD,
          scope: scope(),
          state: stateWith("doc_prefix"),
        },
      ],
      1,
      genesis.hash,
    );
    const verification = service.verifyBackup(
      prefixRun.cut,
      newStore(),
      "epoch_restore",
    );
    seedQueueUnknown(store, genesis);

    expectCode(
      () => service.compact(prefixRun.cut, verification),
      "UNRESOLVED_UNKNOWN_ATTEMPT",
    );
    store.transaction(() =>
      store.set(
        "client.queue",
        `${scopeKey(scope())}:${WRITER_OLD}:intent_queue`,
        null,
      ),
    );

    seedWriter(store, WRITER_NEW, "active");
    const suffixRun = appendEvents(
      store,
      [
        {
          writerId: WRITER_NEW,
          scope: scope(),
          state: stateWith("doc_suffix"),
        },
      ],
      prefixRun.cut.seq + 1,
      prefixRun.cut.hash,
    );
    seedQueueUnknown(store, suffixRun.cut, WRITER_NEW, "intent_suffix_queue");

    const result = service.compact(prefixRun.cut, verification);
    expect(result.removed).toBe(1);
    expect(eventsOf(store)).toEqual(suffixRun.events);
    expect(service.inspect().unknownAttempts).toBe(1);
  });

  it("refuses a cut behind an existing checkpoint boundary", () => {
    const store = newStore();
    const genesis = initHead(store);
    const service = new RetentionService(store);
    seedWriter(store, WRITER_OLD);
    const first = appendEvents(
      store,
      [{ writerId: WRITER_OLD, scope: scope(), state: stateWith("doc_a") }],
      1,
      genesis.hash,
    );
    const verificationOne = service.verifyBackup(
      first.cut,
      newStore(),
      "epoch_restore_one",
    );
    const second = appendEvents(
      store,
      [{ writerId: WRITER_OLD, scope: scope(), state: stateWith("doc_b") }],
      first.cut.seq + 1,
      first.cut.hash,
    );
    const verificationTwo = service.verifyBackup(
      second.cut,
      newStore(),
      "epoch_restore_two",
    );
    service.compact(second.cut, verificationTwo);

    expectCode(() => service.compact(first.cut, verificationOne), "STALE_CUT");
    expect(checkpointOf(store)!.body.cut).toEqual(second.cut);
    expect(eventsOf(store)).toHaveLength(0);
  });
});

describe("retention with a real SharedAuthority", () => {
  it("compacts an old owner-device cut after new-device join and old-device revoke", () => {
    const authority = newAuthority();
    const bootstrap = authority.bootstrap({
      orgId: ORG,
      userId: USER,
      deviceId: "device_old",
      workspaceId: WORKSPACE,
      documentId: DOCUMENT,
      document: documentWith(DOCUMENT),
    });
    const oldCut = authority.head();
    const restoreStore = newStore();
    const verification = authority
      .retention(bootstrap.token, ORG)
      .verifyBackup(oldCut, restoreStore, "epoch_restore");

    const invite = authority.invite(bootstrap.token, ORG, USER);
    const joined = authority.join(invite, ORG, "device_new");
    authority.revokeDevice(joined.token, ORG, "device_old");

    expectCode(
      () => authority.retention(bootstrap.token, ORG),
      "TOKEN_INVALID",
    );

    const beforeState = canonical(
      authority.snapshot(joined.token, bootstrap.scope).state,
    );
    const protectedNamespaces = [
      "documents",
      "doclifecycles",
      "organization",
      "workspaces",
      "workspace.roles",
      "authority.attempts",
      "authority.intents",
      "authority.undo",
      "authority.prefix",
      "identity.devices",
      "identity.sessions",
    ];
    const before = namespaces(authority.store, protectedNamespaces);

    const result = authority
      .retention(joined.token, ORG)
      .compact(oldCut, verification);

    expect(result.removed).toBe(1);
    expect(result.cut).toEqual(oldCut);
    expect(authority.head().seq).toBe(oldCut.seq + 3);
    expect(eventsOf(authority.store).map((event) => event.seq)).toEqual([
      oldCut.seq + 1,
      oldCut.seq + 2,
      oldCut.seq + 3,
    ]);
    expect(namespaces(authority.store, protectedNamespaces)).toBe(before);
    expect(
      canonical(authority.snapshot(joined.token, bootstrap.scope).state),
    ).toBe(beforeState);

    const checkpoint = checkpointOf(authority.store)!;
    expect(checkpoint.body.cut).toEqual(oldCut);
    expect(checkpoint.body.archive.removed).toBe(1);
    expect(checkpoint.body.writerFences).toEqual([bootstrap.auth.writerId]);
    expect(checkpoint.body.scopes).toHaveLength(1);
    expect(
      checkpoint.body.scopes[0]!.state.document.content?.[0]?.attrs?.id,
    ).toBe(DOCUMENT + "_p");
    expect(checkpoint.body.writerFences.includes(joined.auth.writerId)).toBe(
      false,
    );
    expect(
      authority.store.get("identity.devices", `${ORG}/device_new`),
    ).toMatchObject({
      status: "active",
    });
    expect(
      authority.store.get("identity.devices", `${ORG}/device_old`),
    ).toMatchObject({
      status: "revoked",
    });
    expect(authority.proof(joined.token, bootstrap.scope, oldCut.seq)).toEqual(
      oldCut,
    );
    expect(() => authority.verify()).not.toThrow();

    expectCode(
      () =>
        authority.retention(bootstrap.token, ORG).compact(oldCut, verification),
      "TOKEN_INVALID",
    );
    expect(authority.store.all("authority.events")).toHaveLength(3);
    expect(
      authority.store.get(
        RETENTION_CHECKPOINT_NAMESPACE,
        RETENTION_CHECKPOINT_KEY,
      ),
    ).not.toBeNull();
  });
});
