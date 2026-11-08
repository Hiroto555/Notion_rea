import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  fingerprintCommit,
  hashCheckpoint,
  type Checkpoint,
  type Commit,
  type CommitResult,
} from "../src/sync/protocol";
import {
  startCheckpointServer,
  type CheckpointServerHandle,
} from "../src/sync/checkpoint-server";
import type { SyncRetentionLimits } from "../src/sync/sync-retention";

const WORKSPACE_ID = "workspace";
const OWNER_ID = "owner";
const CLIENT_ID = "client-a";
const OTHER_CLIENT_ID = "client-b";
const DEFAULT_BYTES = 64 * 1024 * 1024;
const UUID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const STALE_EPOCH = "11111111-1111-1111-1111-111111111111";

const roots: string[] = [];
const servers = new Set<CheckpointServerHandle>();

type Fixture = {
  server: CheckpointServerHandle;
  token: string;
};

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "folio-server-retention-"));
  roots.push(root);
  return root;
}

function checkpoint(text: string): Checkpoint {
  return {
    format: "folio-checkpoint/v1",
    name: "test-fixture",
    version: 1,
    payload: { text },
    assets: [],
  };
}

function validateCheckpoint(value: Checkpoint): boolean {
  if (
    value.name !== "test-fixture" ||
    value.version !== 1 ||
    typeof value.payload.text !== "string"
  )
    throw new Error("fixture schema");
  return true;
}

function operation(
  serverEpoch: string,
  clientId: string,
  operationId: string,
  baseRevision: number,
  text: string,
): Commit {
  const value = checkpoint(text);
  return {
    protocol: 1,
    workspaceId: WORKSPACE_ID,
    clientId,
    operationId,
    serverEpoch,
    baseRevision,
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
}

async function bootCapability(
  limits?: SyncRetentionLimits,
): Promise<Fixture> {
  const token = randomBytes(32).toString("hex");
  const server = await startCheckpointServer({
    databasePath: join(tempRoot(), "server.sqlite"),
    capabilities: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID, token }],
    validateCheckpoint,
    retentionLimits: limits,
  });
  servers.add(server);
  return { server, token };
}

async function bootDevice(limits?: SyncRetentionLimits): Promise<Fixture> {
  const token = randomBytes(32).toString("hex");
  const server = await startCheckpointServer({
    databasePath: join(tempRoot(), "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID }],
    validateCheckpoint,
    retentionLimits: limits,
  });
  servers.add(server);
  server.registerDevice({
    workspaceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    clientId: CLIENT_ID,
    token,
  });
  return { server, token };
}

async function request(
  fixture: Fixture,
  route: string,
  method = "GET",
  value?: unknown,
  credential = fixture.token,
): Promise<Response> {
  return fetch(
    `${fixture.server.url}/v1/workspaces/${WORKSPACE_ID}/${route}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    },
  );
}

async function post(
  fixture: Fixture,
  value: unknown,
  credential = fixture.token,
): Promise<{ response: Response; body: unknown }> {
  const response = await request(fixture, "commits", "POST", value, credential);
  return { response, body: await response.json() };
}

type HeadBody = {
  head: {
    revision: number;
    checkpointHash: string | null;
    checkpoint: Checkpoint | null;
  };
};

async function head(fixture: Fixture): Promise<HeadBody["head"]> {
  const response = await request(fixture, "head");
  expect(response.status).toBe(200);
  return ((await response.json()) as HeadBody).head;
}

async function changeCount(fixture: Fixture, after = 0): Promise<number> {
  const response = await request(fixture, `changes?after=${after}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { changes: unknown[] };
  return body.changes.length;
}

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.close();
    } catch {}
  }
  servers.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("checkpoint server retention admission", () => {
  it("rejects the next applied commit when rows reach the cap without partial state", async () => {
    const fixture = await bootCapability({
      maxRows: 2,
      maxBytes: DEFAULT_BYTES,
    });
    const firstOperation = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-1",
      0,
      "one",
    );
    const first = await post(fixture, firstOperation);
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      status: "applied",
      revision: 1,
      checkpointHash: firstOperation.checkpointHash,
    });
    const ack = first.body as CommitResult;

    const secondOperation = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-2",
      1,
      "two",
    );
    const rejected = await post(fixture, secondOperation);
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toEqual({ error: "sync-retention-held" });

    const after = await head(fixture);
    expect(after.revision).toBe(1);
    expect(after.checkpointHash).toBe(firstOperation.checkpointHash);
    expect(after.checkpoint?.payload.text).toBe("one");
    expect(await changeCount(fixture)).toBe(1);

    const missing = await request(
      fixture,
      `operations/${CLIENT_ID}/op-2`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "operation-not-found" });

    const duplicate = await post(fixture, firstOperation);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body).toEqual(ack);

    const lookup = await request(fixture, `operations/${CLIENT_ID}/op-1`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual(ack);

    expect(await changeCount(fixture, 1)).toBe(0);
  });

  it("counts a conflict receipt against the cap and still replays it", async () => {
    const fixture = await bootCapability({
      maxRows: 3,
      maxBytes: DEFAULT_BYTES,
    });
    const appliedOperation = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-1",
      0,
      "one",
    );
    expect((await post(fixture, appliedOperation)).response.status).toBe(200);

    const conflictOperation = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-conflict",
      0,
      "loser",
    );
    const conflict = await post(fixture, conflictOperation);
    expect(conflict.response.status).toBe(200);
    expect(conflict.body).toMatchObject({
      status: "conflict",
      operationId: "op-conflict",
    });
    const conflictAck = conflict.body as CommitResult;

    expect((await head(fixture)).revision).toBe(1);
    expect(await changeCount(fixture)).toBe(1);

    const nextApplied = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-2",
      1,
      "two",
    );
    const rejected = await post(fixture, nextApplied);
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toEqual({ error: "sync-retention-held" });

    const duplicate = await post(fixture, conflictOperation);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body).toEqual(conflictAck);

    const anotherConflict = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-loser-2",
      0,
      "loser",
    );
    const conflictRejected = await post(fixture, anotherConflict);
    expect(conflictRejected.response.status).toBe(409);
    expect(conflictRejected.body).toEqual({ error: "sync-retention-held" });
    const conflictLookup = await request(
      fixture,
      `operations/${CLIENT_ID}/op-loser-2`,
    );
    expect(conflictLookup.status).toBe(404);
    expect(await changeCount(fixture)).toBe(1);
  });

  it("admits only the exact canonical bytes of a change plus its operation receipt", async () => {
    const appliedOperation = operation(
      UUID_PLACEHOLDER,
      CLIENT_ID,
      "op-1",
      0,
      "one",
    );
    const appliedFingerprint = fingerprintCommit(appliedOperation);
    const appliedChange = {
      revision: 1,
      clientId: CLIENT_ID,
      operationId: "op-1",
      fingerprint: appliedFingerprint,
      checkpointHash: appliedOperation.checkpointHash,
      checkpoint: appliedOperation.checkpoint,
    };
    const appliedResult = {
      protocol: 1,
      workspaceId: WORKSPACE_ID,
      clientId: CLIENT_ID,
      operationId: "op-1",
      serverEpoch: UUID_PLACEHOLDER,
      fingerprint: appliedFingerprint,
      status: "applied",
      revision: 1,
      checkpointHash: appliedOperation.checkpointHash,
    };
    const appliedBytes =
      Buffer.byteLength(canonicalJson(appliedChange)) +
      Buffer.byteLength(canonicalJson(appliedOperation)) +
      Buffer.byteLength(canonicalJson(appliedResult));

    const conflictOperation = operation(
      UUID_PLACEHOLDER,
      CLIENT_ID,
      "op-conflict-a",
      0,
      "loser",
    );
    const conflictFingerprint = fingerprintCommit(conflictOperation);
    const conflictResult = {
      protocol: 1,
      workspaceId: WORKSPACE_ID,
      clientId: CLIENT_ID,
      operationId: "op-conflict-a",
      serverEpoch: UUID_PLACEHOLDER,
      fingerprint: conflictFingerprint,
      status: "conflict",
      head: {
        revision: 1,
        checkpointHash: appliedOperation.checkpointHash,
        checkpoint: appliedOperation.checkpoint,
      },
    };
    const conflictBytes =
      Buffer.byteLength(canonicalJson(conflictOperation)) +
      Buffer.byteLength(canonicalJson(conflictResult));

    const fixture = await bootCapability({
      maxRows: 1024,
      maxBytes: appliedBytes + conflictBytes,
    });
    const applied = await post(
      fixture,
      operation(fixture.server.serverEpoch, CLIENT_ID, "op-1", 0, "one"),
    );
    expect(applied.response.status).toBe(200);
    expect(applied.body).toMatchObject({ status: "applied", revision: 1 });

    const conflict = await post(
      fixture,
      operation(
        fixture.server.serverEpoch,
        CLIENT_ID,
        "op-conflict-a",
        0,
        "loser",
      ),
    );
    expect(conflict.response.status).toBe(200);
    expect(conflict.body).toMatchObject({
      status: "conflict",
      operationId: "op-conflict-a",
    });

    const overCap = await post(
      fixture,
      operation(
        fixture.server.serverEpoch,
        CLIENT_ID,
        "op-conflict-b",
        0,
        "loser",
      ),
    );
    expect(overCap.response.status).toBe(409);
    expect(overCap.body).toEqual({ error: "sync-retention-held" });
    expect((await head(fixture)).revision).toBe(1);
    expect(await changeCount(fixture)).toBe(1);
  });

  it("keeps read, register, revoke and lookup usable at the cap", async () => {
    const fixture = await bootDevice({ maxRows: 2, maxBytes: DEFAULT_BYTES });
    const appliedOperation = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-1",
      0,
      "one",
    );
    expect((await post(fixture, appliedOperation)).response.status).toBe(200);
    expect((await head(fixture)).revision).toBe(1);
    expect(await changeCount(fixture)).toBe(1);

    const appliedLookup = await request(
      fixture,
      `operations/${CLIENT_ID}/op-1`,
    );
    expect(appliedLookup.status).toBe(200);
    expect(await appliedLookup.json()).toMatchObject({
      status: "applied",
      revision: 1,
    });

    const otherToken = randomBytes(32).toString("hex");
    fixture.server.registerDevice({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      clientId: OTHER_CLIENT_ID,
      token: otherToken,
    });
    fixture.server.revokeDevice(WORKSPACE_ID, OTHER_CLIENT_ID);

    const revokedHead = await request(
      fixture,
      "head",
      "GET",
      undefined,
      otherToken,
    );
    expect(revokedHead.status).toBe(401);
    expect(await revokedHead.json()).toEqual({ error: "unauthorized" });

    const stillApplied = await post(fixture, appliedOperation);
    expect(stillApplied.response.status).toBe(200);

    const next = await post(
      fixture,
      operation(
        fixture.server.serverEpoch,
        CLIENT_ID,
        "op-2",
        1,
        "two",
      ),
    );
    expect(next.response.status).toBe(409);
    expect(next.body).toEqual({ error: "sync-retention-held" });
    expect((await head(fixture)).revision).toBe(1);
  });

  it("rejects a stale epoch before duplicate receipt lookup", async () => {
    const fixture = await bootCapability({
      maxRows: 2,
      maxBytes: DEFAULT_BYTES,
    });
    const appliedOperation = operation(
      fixture.server.serverEpoch,
      CLIENT_ID,
      "op-1",
      0,
      "one",
    );
    const first = await post(fixture, appliedOperation);
    expect(first.response.status).toBe(200);
    const ack = first.body as CommitResult;

    const staleDuplicate = operation(
      STALE_EPOCH,
      CLIENT_ID,
      "op-1",
      0,
      "one",
    );
    const rejected = await post(fixture, staleDuplicate);
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toEqual({ error: "server-epoch-mismatch" });

    const lookup = await request(fixture, `operations/${CLIENT_ID}/op-1`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual(ack);
    expect((await head(fixture)).revision).toBe(1);
  });

  it("refuses retention limits above the helper defaults", async () => {
    const fixture = await bootCapability({
      maxRows: 1025,
      maxBytes: DEFAULT_BYTES,
    });
    const rejected = await post(
      fixture,
      operation(fixture.server.serverEpoch, CLIENT_ID, "op-1", 0, "one"),
    );
    expect(rejected.response.status).toBe(409);
    expect(rejected.body).toEqual({ error: "sync-retention-unknown" });
    expect((await head(fixture)).revision).toBe(0);
    expect(await changeCount(fixture)).toBe(0);
  });
});
