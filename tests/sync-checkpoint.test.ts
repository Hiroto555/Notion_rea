import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  fingerprintCommit,
  hashCheckpoint,
  MAX_CHECKPOINT_BYTES,
  MAX_WIRE_BYTES,
  parseCheckpoint,
  parseCommit,
  type ChangePage,
  type Checkpoint,
  type Commit,
  type CommitResult,
} from "../src/sync/protocol";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { SyncTransportJournal } from "../src/sync/transport-journal";
import { CheckpointClient } from "../src/sync/client";
import {
  SyncSqliteGuard,
  SyncStorageUnavailable,
} from "../src/sync/sqlite-guard";

type RunningServer = Awaited<ReturnType<typeof startCheckpointServer>>;
let directory: string;
let server: RunningServer;
let token: string;
let otherToken: string;
const servers = new Set<RunningServer>();
const journals = new Set<SyncTransportJournal>();
const nativeExec = DatabaseSync.prototype.exec;
const nativeClose = DatabaseSync.prototype.close;
const checkpoint = (text: string): Checkpoint => ({
  format: "folio-checkpoint/v1",
  name: "test-fixture",
  version: 1,
  payload: { text },
  assets: [],
});
const validateCheckpoint = (value: Checkpoint) => {
  if (
    value.name !== "test-fixture" ||
    value.version !== 1 ||
    typeof value.payload.text !== "string"
  )
    throw new Error("fixture schema");
  return true;
};
async function boot(
  database = "server.sqlite",
  validator = validateCheckpoint,
): Promise<RunningServer> {
  const result = await startCheckpointServer({
    databasePath: join(directory, database),
    capabilities: [
      { workspaceId: "workspace", ownerId: "owner", token },
      { workspaceId: "other", ownerId: "owner", token: otherToken },
    ],
    validateCheckpoint: validator,
  });
  servers.add(result);
  server = result;
  return result;
}
function makeJournal(
  name: string,
  path = join(directory, `${name}.sqlite`),
  bindingId = `binding-${name}`,
): SyncTransportJournal {
  const result = new SyncTransportJournal({
    path,
    workspaceId: "workspace",
    clientId: `client-${name}`,
    bindingId,
  });
  journals.add(result);
  return result;
}
function makeClient(
  journal: SyncTransportJournal,
  credential = token,
): CheckpointClient {
  return new CheckpointClient({
    baseUrl: server.url,
    token: credential,
    journal,
    timeoutMs: 1000,
  });
}
function closeJournal(journal: SyncTransportJournal): void {
  journal.close();
  journals.delete(journal);
}
async function closeServer(): Promise<void> {
  await server.close();
  servers.delete(server);
}
async function raw(
  route: string,
  method = "GET",
  value?: unknown,
  credential = token,
  workspace = "workspace",
) {
  return fetch(`${server.url}/v1/workspaces/${workspace}/${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "folio-sync-foundation-"));
  token = randomBytes(32).toString("hex");
  otherToken = randomBytes(32).toString("hex");
  await boot();
});
afterEach(async () => {
  DatabaseSync.prototype.exec = nativeExec;
  DatabaseSync.prototype.close = nativeClose;
  for (const current of servers) await current.close();
  servers.clear();
  for (const journal of journals) journal.close();
  journals.clear();
  rmSync(directory, { recursive: true, force: true });
});

function throwSql(sqlToFail: string, afterExecution = false): () => void {
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql !== sqlToFail) return nativeExec.call(this, sql);
    if (afterExecution) nativeExec.call(this, sql);
    throw new Error(`injected ${sqlToFail} failure`);
  };
  return () => {
    DatabaseSync.prototype.exec = nativeExec;
  };
}

async function expectServerUnavailable(operation: Commit): Promise<void> {
  for (const route of [
    "head",
    "changes?after=0",
    `operations/${operation.clientId}/${operation.operationId}`,
  ]) {
    const response = await raw(route);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "sync-storage-unavailable",
    });
  }
  expect((await raw("commits", "POST", operation)).status).toBe(503);
}

function expectJournalUnavailable(
  journal: SyncTransportJournal,
  operation: Commit,
  page: ChangePage,
): void {
  const receipt: CommitResult = {
    protocol: 1,
    workspaceId: operation.workspaceId,
    clientId: operation.clientId,
    operationId: operation.operationId,
    fingerprint: fingerprintCommit(operation),
    serverEpoch: operation.serverEpoch,
    status: "applied",
    revision: 1,
    checkpointHash: operation.checkpointHash,
  };
  for (const access of [
    () => journal.status(),
    () => journal.pending(),
    () => journal.pendingInbox(),
    () => journal.conflicts(),
    () => journal.bindServer(operation.serverEpoch),
    () => journal.enqueue(operation),
    () => journal.recordResult(receipt),
    () => journal.stageChanges(page),
  ])
    expect(access).toThrow("sync-storage-unavailable");
}

describe("checkpoint protocol and isolation", () => {
  it("hashes canonical JSON and rejects lossy/non-JSON or oversized values", () => {
    expect(canonicalJson({ b: 2, a: [1, null] })).toBe(
      canonicalJson({ a: [1, null], b: 2 }),
    );
    expect(() => canonicalJson({ x: undefined })).toThrow("invalid-json");
    expect(() => canonicalJson({ x: Infinity })).toThrow("invalid-number");
    expect(() => canonicalJson(new Date())).toThrow("invalid-object");
    expect(() => canonicalJson(new Array(2))).toThrow("invalid-array");
    expect(() =>
      canonicalJson({
        get x() {
          throw new Error("getter ran");
        },
      }),
    ).toThrow("invalid-accessor");
    const accessorArray = [1];
    Object.defineProperty(accessorArray, "0", {
      get() {
        throw new Error("getter ran");
      },
      enumerable: true,
    });
    expect(() => canonicalJson(accessorArray)).toThrow("invalid-array");
    const inherited = [1];
    Object.setPrototypeOf(inherited, {
      [Symbol.iterator]() {
        throw new Error("iterator ran");
      },
    });
    expect(() => canonicalJson(inherited)).toThrow("invalid-array");
    expect(() =>
      canonicalJson({ a: "x".repeat(10), b: "y".repeat(10) }, 25),
    ).toThrow("payload-too-large");
    expect(() =>
      parseCheckpoint(checkpoint("x".repeat(MAX_CHECKPOINT_BYTES))),
    ).toThrow("payload-too-large");
    expect(() =>
      parseCheckpoint({ ...checkpoint("x"), assets: [{ id: "asset" }] }),
    ).toThrow("invalid-asset-manifest");
    const asset = { id: randomUUID(), sha256: "a".repeat(64), bytes: 20_000_000 };
    expect(parseCheckpoint({ ...checkpoint("x"), assets: [asset] }).assets).toEqual([asset]);
    expect(() =>
      parseCheckpoint({ ...checkpoint("x"), assets: [asset, asset] }),
    ).toThrow("duplicate-asset-id");
    expect(() =>
      parseCheckpoint({ ...checkpoint("x"), assets: [{ ...asset, bytes: asset.bytes + 1 }] }),
    ).toThrow("invalid-asset-manifest");
    expect(() =>
      parseCheckpoint({ ...checkpoint("x"), surprise: true }),
    ).toThrow("unexpected-fields");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow("json-complexity");
  });

  it("requires loopback endpoints and refuses server binding elsewhere", async () => {
    const journal = makeJournal("a");
    const credentialUrl = new URL("http://127.0.0.1");
    credentialUrl.username = "u"; credentialUrl.password = "p";
    for (const baseUrl of [
      "http://example.com",
      "http://localhost:1234",
      "https://127.0.0.1",
      credentialUrl.href,
      `${server.url}/path`,
      `${server.url}?x=1`,
    ]) {
      expect(() => new CheckpointClient({ baseUrl, token, journal })).toThrow(
        "loopback-only",
      );
    }
    await expect(
      startCheckpointServer({
        databasePath: join(directory, "bad.sqlite"),
        capabilities: [{ token, workspaceId: "workspace", ownerId: "owner" }],
        validateCheckpoint,
        host: "0.0.0.0" as "127.0.0.1",
      }),
    ).rejects.toThrow("loopback-only");
  });

  it("rejects wrong-workspace credentials for every route and mismatched commit workspace", async () => {
    const client = makeClient(makeJournal("a"));
    await client.head();
    const operation = client.prepare(checkpoint("secret"), 0);
    for (const route of [
      "head",
      "changes?after=0",
      `operations/${operation.clientId}/${operation.operationId}`,
    ]) {
      expect((await raw(route, "GET", undefined, otherToken)).status).toBe(401);
    }
    expect((await raw("commits", "POST", operation, otherToken)).status).toBe(
      401,
    );
    expect(
      (await raw("commits", "POST", operation, otherToken, "other")).status,
    ).toBe(403);
    expect(
      (await fetch(`${server.url}/v1/workspaces/workspace/head`)).status,
    ).toBe(401);
    expect((await client.head()).head.revision).toBe(0);
  });

  it("rejects malformed/hash/schema/attachment/oversize inputs without changing head", async () => {
    const client = makeClient(makeJournal("a"));
    await client.head();
    const operation = client.prepare(checkpoint("valid"), 0);
    expect(
      (
        await raw("commits", "POST", {
          ...operation,
          checkpointHash: "0".repeat(64),
        })
      ).status,
    ).toBe(400);
    const unknown = { ...checkpoint("unknown"), name: "unregistered" };
    expect(
      (
        await raw("commits", "POST", {
          ...operation,
          checkpoint: unknown,
          checkpointHash: hashCheckpoint(unknown),
        })
      ).status,
    ).toBe(422);
    const withAsset = { ...checkpoint("blob"), assets: [
      { id: randomUUID(), sha256: "a".repeat(64), bytes: 1 },
    ] };
    expect(
      (
        await raw("commits", "POST", {
          ...operation,
          checkpoint: withAsset,
          checkpointHash: hashCheckpoint(withAsset),
        })
      ).status,
    ).toBe(422);
    const invalidJson = await fetch(
      `${server.url}/v1/workspaces/workspace/commits`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
    );
    expect(invalidJson.status).toBe(400);
    const oversized = await fetch(
      `${server.url}/v1/workspaces/workspace/commits`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: " ".repeat(MAX_WIRE_BYTES + 1),
      },
    );
    expect(oversized.status).toBe(413);
    expect((await client.head()).head.revision).toBe(0);
    expect(client.journal.status().pending).toBe(1);
    expect(await client.recoverPending()).toBeNull();
  });

  it("does not open a product or unrelated DB as a transport journal", () => {
    const path = join(directory, "unrelated.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE precious(data TEXT); INSERT INTO precious VALUES('retained')",
    );
    db.close();
    expect(() => makeJournal("x", path)).toThrow("not-a-transport-journal");
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT data FROM precious").get()!.data).toBe(
      "retained",
    );
    expect(
      check
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='transport_identity'",
        )
        .get()!.n,
    ).toBe(0);
    check.close();
  });

  it("rejects false and asynchronous validators without a head, receipt or change", async () => {
    const predicates = [
      () => false,
      async () => true,
      async () => {
        await Promise.resolve();
        throw new Error("late validation failure");
      },
    ];
    for (let index = 0; index < predicates.length; index++) {
      const isolated = await startCheckpointServer({
        databasePath: join(directory, `validator-${index}.sqlite`),
        capabilities: [{ token, workspaceId: "workspace", ownerId: "owner" }],
        validateCheckpoint: predicates[index] as (value: Checkpoint) => boolean,
      });
      servers.add(isolated);
      const journal = makeJournal(`validator-client-${index}`);
      const client = new CheckpointClient({
        baseUrl: isolated.url,
        token,
        journal,
      });
      await client.head();
      client.prepare(checkpoint("must not commit"), 0);
      await expect(client.push()).rejects.toThrow("checkpoint-schema-rejected");
      expect((await client.head()).head.revision).toBe(0);
      expect(await client.recoverPending()).toBeNull();
      expect((await client.pull()).changes).toHaveLength(0);
      expect(journal.status()).toMatchObject({ pending: 1, receivedCursor: 0 });
    }
  });

  it("rejects a restored journal with different external device binding", async () => {
    const journal = makeJournal("a");
    await makeClient(journal).head();
    closeJournal(journal);
    copyFileSync(
      join(directory, "a.sqlite"),
      join(directory, "restored.sqlite"),
    );
    expect(() =>
      makeJournal("a", join(directory, "restored.sqlite"), "new-device"),
    ).toThrow("journal-binding-mismatch");
    expect(makeJournal("a").status().serverEpoch).toBe(server.serverEpoch);
  });
});

describe("durable checkpoint transport (no host application)", () => {
  it("transfers to a separate client inbox and never claims application", async () => {
    const a = makeClient(makeJournal("a"));
    const b = makeClient(makeJournal("b"));
    await a.head();
    const value = checkpoint("A document");
    const operation = a.prepare(value, 0);
    value.payload.text = "caller mutation";
    operation.checkpoint.payload.text = "returned mutation";
    expect(a.journal.pending()[0].checkpoint.payload.text).toBe("A document");
    expect((await a.push())?.status).toBe("applied");
    await b.pull();
    expect(b.journal.pendingInbox()[0].checkpoint.payload.text).toBe(
      "A document",
    );
    expect(b.journal.status()).toMatchObject({
      receivedCursor: 1,
      staged: 1,
      pending: 0,
      application: "not-connected",
    });
    expect(a.journal.clientId).not.toBe(b.journal.clientId);
    expect(a.journal.status().receivedCursor).toBe(0);
  });

  it("keeps an offline outbox through client and server restart", async () => {
    let journal = makeJournal("a");
    let client = makeClient(journal);
    await client.head();
    const operation = client.prepare(checkpoint("offline work"), 0);
    const fingerprint = fingerprintCommit(operation);
    await closeServer();
    await expect(client.push()).rejects.toThrow();
    expect(journal.pending()[0].operationId).toBe(operation.operationId);
    closeJournal(journal);
    journal = makeJournal("a");
    expect(fingerprintCommit(journal.pending()[0])).toBe(fingerprint);
    await boot();
    client = makeClient(journal);
    expect((await client.push())?.status).toBe("applied");
    expect((await client.head()).head.revision).toBe(1);
    expect(journal.status().pending).toBe(0);
  });

  it("replays the same operation after committed server ACK loss, once only", async () => {
    let journal = makeJournal("a");
    let client = makeClient(journal);
    await client.head();
    const operation = client.prepare(checkpoint("ACK lost"), 0);
    // Server persists successfully; deliberately never hand its ACK to the journal.
    const lostResult = await (await raw("commits", "POST", operation)).json();
    expect(journal.status().pending).toBe(1);
    await closeServer();
    closeJournal(journal);
    await boot();
    journal = makeJournal("a");
    client = makeClient(journal);
    expect(await client.push()).toEqual(lostResult);
    expect((await client.head()).head.revision).toBe(1);
    expect((await client.pull()).changes).toHaveLength(1);
    expect((await client.pull()).changes).toHaveLength(0);
  });

  it("looks up a lost receipt without constructing a new operation", async () => {
    const journal = makeJournal("a");
    const client = makeClient(journal);
    await client.head();
    const operation = client.prepare(checkpoint("receipt"), 0);
    expect(await client.recoverPending()).toBeNull();
    const result = await (await raw("commits", "POST", operation)).json();
    expect(await client.recoverPending()).toEqual(result);
    expect(journal.status().pending).toBe(0);
    expect((await client.head()).head.revision).toBe(1);
  });

  it("preserves a committed receipt when a later server predicate changes", async () => {
    const journal = makeJournal("a");
    const client = makeClient(journal);
    await client.head();
    const operation = client.prepare(checkpoint("previously validated"), 0);
    const accepted = await (await raw("commits", "POST", operation)).json();
    await closeServer();
    await boot("server.sqlite", () => false);
    const restarted = makeClient(journal);
    expect(await restarted.push()).toEqual(accepted);
    expect((await restarted.head()).head.revision).toBe(1);
    restarted.prepare(checkpoint("new validation required"), 1);
    await expect(restarted.push()).rejects.toThrow(
      "checkpoint-schema-rejected",
    );
    expect((await restarted.head()).head.revision).toBe(1);
  });

  it("retains both sides of CAS conflict on client and server across restart", async () => {
    const a = makeClient(makeJournal("a"));
    let bJournal = makeJournal("b");
    let b = makeClient(bJournal);
    await a.head();
    await b.head();
    a.prepare(checkpoint("winning A"), 0);
    const candidate = b.prepare(checkpoint("retained B"), 0);
    await a.push();
    const conflict = await b.push();
    expect(conflict?.status).toBe("conflict");
    expect(bJournal.conflicts()[0].local.checkpoint.payload.text).toBe(
      "retained B",
    );
    expect(bJournal.conflicts()[0].remote.head.checkpoint?.payload.text).toBe(
      "winning A",
    );
    expect(() => b.prepare(checkpoint("silent rebase"), 1)).toThrow(
      "outbox-blocked",
    );
    await closeServer();
    closeJournal(bJournal);
    await boot();
    bJournal = makeJournal("b");
    b = makeClient(bJournal);
    expect(bJournal.conflicts()).toHaveLength(1);
    expect(
      await (
        await raw(`operations/${candidate.clientId}/${candidate.operationId}`)
      ).json(),
    ).toEqual(conflict);
    const db = new DatabaseSync(join(directory, "server.sqlite"), {
      readOnly: true,
    });
    const retained = db
      .prepare(
        "SELECT commit_json FROM checkpoint_operations WHERE operation_id=?",
      )
      .get(candidate.operationId)!;
    expect(
      JSON.parse(String(retained.commit_json)).checkpoint.payload.text,
    ).toBe("retained B");
    db.close();
    await b.pull();
    expect(bJournal.conflicts()[0].local.checkpoint.payload.text).toBe(
      "retained B",
    );
    expect(bJournal.status().application).toBe("not-connected");
  });

  it("serializes simultaneous same-base commits with exactly one winner", async () => {
    const a = makeClient(makeJournal("a"));
    const b = makeClient(makeJournal("b"));
    await Promise.all([a.head(), b.head()]);
    a.prepare(checkpoint("a"), 0);
    b.prepare(checkpoint("b"), 0);
    const results = await Promise.all([a.push(), b.push()]);
    expect(results.map((result) => result!.status).sort()).toEqual([
      "applied",
      "conflict",
    ]);
    expect((await a.head()).head.revision).toBe(1);
  });

  it("rejects changing an operation body locally and remotely", async () => {
    const client = makeClient(makeJournal("a"));
    await client.head();
    const original = client.prepare(checkpoint("first"), 0);
    await client.push();
    const changed = checkpoint("different");
    const reused = {
      ...original,
      checkpoint: changed,
      checkpointHash: hashCheckpoint(changed),
    };
    expect(() => client.journal.enqueue(reused)).toThrow("operation-id-reused");
    expect((await raw("commits", "POST", reused)).status).toBe(409);
    expect((await client.head()).head.checkpoint?.payload.text).toBe("first");
    expect((await raw("commits", "POST", original)).status).toBe(200);
    expect((await client.head()).head.revision).toBe(1);
  });

  it("resumes inbox cursor across restart and keeps previous staged content", async () => {
    const a = makeClient(makeJournal("a"));
    let bJournal = makeJournal("b");
    let b = makeClient(bJournal);
    await a.head();
    a.prepare(checkpoint("one"), 0);
    await a.push();
    a.prepare(checkpoint("two"), 1);
    await a.push();
    await b.pull();
    expect(bJournal.status().receivedCursor).toBe(1);
    closeJournal(bJournal);
    bJournal = makeJournal("b");
    b = makeClient(bJournal);
    expect((await b.pull()).after).toBe(1);
    expect(
      bJournal.pendingInbox().map((change) => change.checkpoint.payload.text),
    ).toEqual(["one", "two"]);
    expect((await b.pull()).changes).toHaveLength(0);
    expect(bJournal.status().receivedCursor).toBe(2);
  });

  it("refuses server replacement and does not erase pending work", async () => {
    const journal = makeJournal("a");
    const a = makeClient(journal);
    await a.head();
    a.prepare(checkpoint("retained"), 0);
    await closeServer();
    await boot("replacement.sqlite");
    const replaced = makeClient(journal);
    await expect(replaced.head()).rejects.toThrow("server-epoch-mismatch");
    await expect(replaced.push()).rejects.toThrow("server-epoch-mismatch");
    expect(journal.pending()[0].checkpoint.payload.text).toBe("retained");
  });

  it("rejects owner reassignment on restart and never stores capabilities in SQL", async () => {
    const a = makeClient(makeJournal("a"));
    await a.head();
    a.prepare(checkpoint("doc"), 0);
    await a.push();
    await closeServer();
    await expect(
      startCheckpointServer({
        databasePath: join(directory, "server.sqlite"),
        capabilities: [
          { workspaceId: "workspace", ownerId: "different-owner", token },
        ],
        validateCheckpoint,
      }),
    ).rejects.toThrow("workspace-owner-mismatch");
    await boot();
    const db = new DatabaseSync(join(directory, "server.sqlite"), {
      readOnly: true,
    });
    for (const table of [
      "checkpoint_server_identity",
      "checkpoint_heads",
      "checkpoint_operations",
      "checkpoint_changes",
    ]) {
      const contents = JSON.stringify(
        db.prepare(`SELECT * FROM ${table}`).all(),
      );
      expect(contents).not.toContain(token);
      expect(contents).not.toContain(otherToken);
    }
    db.close();
  });

  it("rolls back server head and change if durable receipt insertion fails", async () => {
    const journal = makeJournal("a");
    const client = makeClient(journal);
    await client.head();
    const operation = client.prepare(checkpoint("atomic server commit"), 0);
    const injector = new DatabaseSync(join(directory, "server.sqlite"));
    injector.exec(
      "CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON checkpoint_operations BEGIN SELECT RAISE(ABORT,'fixture-receipt-failure'); END",
    );
    try {
      await expect(client.push()).rejects.toThrow("internal-error");
      expect((await client.head()).head.revision).toBe(0);
      expect(await client.recoverPending()).toBeNull();
      expect((await client.pull()).changes).toHaveLength(0);
      expect(
        injector.prepare("SELECT count(*) AS n FROM checkpoint_changes").get()!
          .n,
      ).toBe(0);
      expect(
        injector
          .prepare("SELECT count(*) AS n FROM checkpoint_operations")
          .get()!.n,
      ).toBe(0);
      expect(journal.pending()[0]).toEqual(operation);
      injector.exec("DROP TRIGGER fixture_receipt_failure");
      expect((await client.push())?.status).toBe("applied");
      expect((await client.head()).head.revision).toBe(1);
    } finally {
      injector.close();
    }
  });
});

describe("journal acceptance boundaries", () => {
  it("only accepts exact receipt identity, fingerprint, revision, and hash", async () => {
    const journal = makeJournal("a");
    const client = makeClient(journal);
    await client.head();
    const operation = client.prepare(checkpoint("pending"), 0);
    const result = (await (
      await raw("commits", "POST", operation)
    ).json()) as CommitResult;
    expect(result.status).toBe("applied");
    for (const changed of [
      { ...result, fingerprint: "0".repeat(64) },
      { ...result, operationId: "wrong-operation" },
      { ...result, clientId: "wrong-client" },
      { ...result, workspaceId: "wrong-workspace" },
      { ...result, serverEpoch: "wrong-server" },
      { ...result, revision: 9 },
      { ...result, checkpointHash: "0".repeat(64) },
    ]) {
      expect(() => journal.recordResult(changed as CommitResult)).toThrow();
      expect(journal.status().pending).toBe(1);
    }
    journal.recordResult(result);
    journal.recordResult(result);
    expect(journal.status().pending).toBe(0);
  });

  it("atomically rejects gaps, changed duplicates, wrong workspace and epoch", async () => {
    const a = makeClient(makeJournal("a"));
    const journal = makeJournal("b");
    const b = makeClient(journal);
    await a.head();
    await b.head();
    a.prepare(checkpoint("first"), 0);
    await a.push();
    const page = (await (await raw("changes?after=0")).json()) as ChangePage;
    for (const invalid of [
      { ...page, workspaceId: "wrong" },
      { ...page, serverEpoch: "wrong" },
      {
        ...page,
        after: 1,
        headRevision: 2,
        changes: [{ ...page.changes[0], revision: 2 }],
      },
      {
        ...page,
        changes: [{ ...page.changes[0], revision: 2 }],
        headRevision: 2,
      },
    ]) {
      expect(() => journal.stageChanges(invalid)).toThrow();
      expect(journal.status()).toMatchObject({ receivedCursor: 0, staged: 0 });
    }
    journal.stageChanges(page);
    journal.stageChanges(page);
    expect(journal.status()).toMatchObject({ receivedCursor: 1, staged: 1 });
    const different = checkpoint("rewritten");
    expect(() =>
      journal.stageChanges({
        ...page,
        changes: [
          {
            ...page.changes[0],
            checkpoint: different,
            checkpointHash: hashCheckpoint(different),
          },
        ],
      }),
    ).toThrow("change-rewritten");
    expect(journal.pendingInbox()[0].checkpoint.payload.text).toBe("first");
  });

  it("does not allow a second prepared operation to replace unacknowledged work", async () => {
    const client = makeClient(makeJournal("a"));
    await client.head();
    const operation = client.prepare(checkpoint("held"), 0);
    expect(() => client.prepare(checkpoint("replacement"), 0)).toThrow(
      "outbox-blocked",
    );
    client.journal.enqueue(parseCommit(operation));
    expect(client.journal.pending()).toEqual([operation]);
  });

  it("rolls back inserted inbox data if its received cursor update fails", async () => {
    const a = makeClient(makeJournal("a"));
    await a.head();
    a.prepare(checkpoint("atomic inbox"), 0);
    await a.push();
    let journal = makeJournal("b");
    let b = makeClient(journal);
    await b.head();
    const injector = new DatabaseSync(join(directory, "b.sqlite"));
    injector.exec(
      "CREATE TRIGGER fixture_cursor_failure BEFORE UPDATE OF received_cursor ON transport_identity BEGIN SELECT RAISE(ABORT,'fixture-cursor-failure'); END",
    );
    try {
      await expect(b.pull()).rejects.toThrow("fixture-cursor-failure");
      expect(journal.status()).toMatchObject({ receivedCursor: 0, staged: 0 });
      expect(journal.pendingInbox()).toHaveLength(0);
      closeJournal(journal);
      journal = makeJournal("b");
      b = makeClient(journal);
      expect(journal.status()).toMatchObject({ receivedCursor: 0, staged: 0 });
      injector.exec("DROP TRIGGER fixture_cursor_failure");
      await b.pull();
      expect(journal.status()).toMatchObject({ receivedCursor: 1, staged: 1 });
      expect(journal.pendingInbox()[0].checkpoint.payload.text).toBe(
        "atomic inbox",
      );
    } finally {
      injector.close();
    }
  });
});

describe("uncertain SQLite outcomes disable the connection until reopen", () => {
  it.each([false, true])(
    "retries server storage cleanup after close throws (closed first: %s)",
    async (afterExecution) => {
      let captured: DatabaseSync | undefined;
      DatabaseSync.prototype.close = function () {
        captured = this;
        if (afterExecution) nativeClose.call(this);
        throw new Error("injected close failure");
      };
      try {
        await expect(server.close()).rejects.toThrow("injected close failure");
      } finally {
        DatabaseSync.prototype.close = nativeClose;
      }
      expect(captured).toBeDefined();
      expect(captured!.isOpen).toBe(!afterExecution);
      await server.close();
      expect(captured!.isOpen).toBe(false);
      servers.delete(server);
    },
  );

  it("returns 503 on every server route after receipt failure plus ROLLBACK failure", async () => {
    const a = makeClient(makeJournal("a"));
    const bJournal = makeJournal("b");
    const b = makeClient(bJournal);
    await a.head();
    await b.head();
    const operation = a.prepare(checkpoint("must not leak"), 0);
    const observer = new DatabaseSync(join(directory, "server.sqlite"));
    observer.exec(
      "CREATE TRIGGER fixture_poison_receipt BEFORE INSERT ON checkpoint_operations BEGIN SELECT RAISE(ABORT,'receipt insertion failed'); END",
    );
    const restore = throwSql("ROLLBACK");
    try {
      await expect(a.push()).rejects.toThrow("sync-storage-unavailable");
    } finally {
      restore();
    }
    try {
      await expectServerUnavailable(operation);
      await expect(b.pull()).rejects.toThrow("sync-storage-unavailable");
      expect(bJournal.status()).toMatchObject({ receivedCursor: 0, staged: 0 });
      expect(a.journal.status().pending).toBe(1);
      expect(
        observer
          .prepare("SELECT revision FROM checkpoint_heads WHERE workspace_id=?")
          .get("workspace")!.revision,
      ).toBe(0);
      expect(
        observer.prepare("SELECT count(*) AS n FROM checkpoint_changes").get()!
          .n,
      ).toBe(0);
      expect(
        observer
          .prepare("SELECT count(*) AS n FROM checkpoint_operations")
          .get()!.n,
      ).toBe(0);
      await closeServer();
      observer.exec("DROP TRIGGER fixture_poison_receipt");
      await boot();
      const restarted = makeClient(a.journal);
      expect((await restarted.head()).head.revision).toBe(0);
      expect((await restarted.push())?.status).toBe("applied");
      expect((await restarted.head()).head.revision).toBe(1);
    } finally {
      observer.close();
    }
  });

  it("keeps both original and rollback errors and blocks every journal DB method", async () => {
    const a = makeClient(makeJournal("a"));
    await a.head();
    a.prepare(checkpoint("inbox must not leak"), 0);
    await a.push();
    let journal = makeJournal("b");
    const b = makeClient(journal);
    await b.head();
    const page = (await (await raw("changes?after=0")).json()) as ChangePage;
    const operation: Commit = {
      protocol: 1,
      workspaceId: "workspace",
      clientId: journal.clientId,
      operationId: "local-check",
      serverEpoch: server.serverEpoch,
      baseRevision: 0,
      checkpoint: checkpoint("local candidate"),
      checkpointHash: hashCheckpoint(checkpoint("local candidate")),
    };
    const observer = new DatabaseSync(join(directory, "b.sqlite"));
    observer.exec(
      "CREATE TRIGGER fixture_poison_cursor BEFORE UPDATE OF received_cursor ON transport_identity BEGIN SELECT RAISE(ABORT,'cursor update failed'); END",
    );
    const restore = throwSql("ROLLBACK");
    let failure: unknown;
    try {
      journal.stageChanges(page);
    } catch (error) {
      failure = error;
    } finally {
      restore();
    }
    try {
      expect(failure).toBeInstanceOf(SyncStorageUnavailable);
      expect(
        (failure as AggregateError).errors.map((error) => error.message),
      ).toEqual(["cursor update failed", "injected ROLLBACK failure"]);
      expectJournalUnavailable(journal, operation, page);
      expect(
        observer.prepare("SELECT count(*) AS n FROM transport_inbox").get()!.n,
      ).toBe(0);
      expect(
        observer
          .prepare("SELECT received_cursor FROM transport_identity")
          .get()!.received_cursor,
      ).toBe(0);
      closeJournal(journal);
      observer.exec("DROP TRIGGER fixture_poison_cursor");
      journal = makeJournal("b");
      expect(journal.status()).toMatchObject({ receivedCursor: 0, staged: 0 });
      await makeClient(journal).pull();
      expect(journal.status()).toMatchObject({ receivedCursor: 1, staged: 1 });
    } finally {
      observer.close();
    }
  });

  it.each([
    ["BEGIN IMMEDIATE", false],
    ["BEGIN IMMEDIATE", true],
    ["COMMIT", false],
    ["COMMIT", true],
  ] as const)(
    "blocks server after %s throws (executed first: %s)",
    async (sql, afterExecution) => {
      const journal = makeJournal("a");
      const client = makeClient(journal);
      await client.head();
      const operation = client.prepare(checkpoint("uncertain commit"), 0);
      const restore = throwSql(sql, afterExecution);
      try {
        await expect(client.push()).rejects.toThrow("sync-storage-unavailable");
      } finally {
        restore();
      }
      await expectServerUnavailable(operation);
      expect(journal.status().pending).toBe(1);
      const expectedDurableRevision =
        sql === "COMMIT" && afterExecution ? 1 : 0;
      const observer = new DatabaseSync(join(directory, "server.sqlite"), {
        readOnly: true,
      });
      expect(
        observer
          .prepare("SELECT revision FROM checkpoint_heads WHERE workspace_id=?")
          .get("workspace")!.revision,
      ).toBe(expectedDurableRevision);
      observer.close();
      await closeServer();
      await boot();
      const restarted = makeClient(journal);
      expect((await restarted.head()).head.revision).toBe(
        expectedDurableRevision,
      );
      expect((await restarted.push())?.status).toBe("applied");
      expect((await restarted.head()).head.revision).toBe(1);
    },
  );

  it.each([
    ["BEGIN IMMEDIATE", false],
    ["BEGIN IMMEDIATE", true],
    ["COMMIT", false],
    ["COMMIT", true],
  ] as const)(
    "blocks journal after %s throws (executed first: %s)",
    async (sql, afterExecution) => {
      let journal = makeJournal("a");
      const client = makeClient(journal);
      await client.head();
      const operation: Commit = {
        protocol: 1,
        workspaceId: "workspace",
        clientId: journal.clientId,
        operationId: "uncertain-enqueue",
        serverEpoch: server.serverEpoch,
        baseRevision: 0,
        checkpoint: checkpoint("uncertain outbox"),
        checkpointHash: hashCheckpoint(checkpoint("uncertain outbox")),
      };
      const page: ChangePage = {
        protocol: 1,
        workspaceId: "workspace",
        serverEpoch: server.serverEpoch,
        after: 0,
        headRevision: 0,
        changes: [],
      };
      const restore = throwSql(sql, afterExecution);
      try {
        expect(() => journal.enqueue(operation)).toThrow(
          "sync-storage-unavailable",
        );
      } finally {
        restore();
      }
      expectJournalUnavailable(journal, operation, page);
      const expectedPending = sql === "COMMIT" && afterExecution ? 1 : 0;
      const observer = new DatabaseSync(join(directory, "a.sqlite"), {
        readOnly: true,
      });
      expect(
        observer.prepare("SELECT count(*) AS n FROM transport_outbox").get()!.n,
      ).toBe(expectedPending);
      observer.close();
      closeJournal(journal);
      journal = makeJournal("a");
      expect(journal.status().pending).toBe(expectedPending);
      journal.enqueue(operation);
      expect((await makeClient(journal).push())?.status).toBe("applied");
    },
  );

  it.each(["isOpen", "isTransaction"] as const)(
    "refuses an unavailable %s API and still closes",
    (property) => {
      const connection = new DatabaseSync(":memory:");
      const proxy = new Proxy(connection, {
        get(target, key) {
          if (key === property) return undefined;
          const result = Reflect.get(target, key, target);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
      expect(() => new SyncSqliteGuard(proxy)).toThrow(
        "sync-storage-unavailable",
      );
      expect(connection.isOpen).toBe(false);
    },
  );

  it.each(["BEGIN IMMEDIATE", "COMMIT"])(
    "poisons when the state API disappears after %s",
    (sqlToFault) => {
      const path = join(directory, "state-unknown.sqlite");
      const connection = new DatabaseSync(path);
      connection.exec("CREATE TABLE durable(value TEXT)");
      let unavailable = false;
      const proxy = new Proxy(connection, {
        get(target, key) {
          if (key === "isTransaction" && unavailable) return undefined;
          if (key === "exec")
            return (sql: string) => {
              nativeExec.call(target, sql);
              if (sql === sqlToFault) unavailable = true;
            };
          const result = Reflect.get(target, key, target);
          return typeof result === "function" ? result.bind(target) : result;
        },
      });
      const storage = new SyncSqliteGuard(proxy);
      expect(() =>
        storage.transaction(() =>
          storage.db.prepare("INSERT INTO durable VALUES(?)").run("candidate"),
        ),
      ).toThrow("sync-storage-unavailable");
      unavailable = false;
      expect(() => storage.db.prepare("SELECT * FROM durable").all()).toThrow(
        "sync-storage-unavailable",
      );
      expect(() => storage.transaction(() => {})).toThrow(
        "sync-storage-unavailable",
      );
      storage.close();
      storage.close();
      const observer = new DatabaseSync(path);
      expect(
        observer.prepare("SELECT count(*) AS n FROM durable").get()!.n,
      ).toBe(sqlToFault === "COMMIT" ? 1 : 0);
      observer.close();
    },
  );
});
