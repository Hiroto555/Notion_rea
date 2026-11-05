import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hashCheckpoint,
  type Checkpoint,
  type Commit,
  type HeadResponse,
} from "../src/sync/protocol";
import {
  startCheckpointServer,
  type CheckpointServerHandle,
} from "../src/sync/checkpoint-server";
import {
  CheckpointClient,
  CheckpointRemote,
} from "../src/sync/client";
import { SyncTransportJournal } from "../src/sync/transport-journal";

const workspaces = [
  { workspaceId: "workspace", ownerId: "owner" },
  { workspaceId: "other", ownerId: "owner" },
];
const checkpoint = (text: string): Checkpoint => ({
  format: "folio-checkpoint/v1",
  name: "test-fixture",
  version: 1,
  payload: { text },
  assets: [],
});
const validateFixture = (value: Checkpoint): boolean => {
  if (
    value.name !== "test-fixture" ||
    value.version !== 1 ||
    typeof value.payload.text !== "string"
  )
    throw new Error("fixture schema");
  return true;
};
const token = (): string => randomBytes(32).toString("hex");

let directory: string;
let server: CheckpointServerHandle;
const servers = new Set<CheckpointServerHandle>();
const journals = new Set<SyncTransportJournal>();

async function boot(
  overrides: Partial<Parameters<typeof startCheckpointServer>[0]> = {},
): Promise<CheckpointServerHandle> {
  const handle = await startCheckpointServer({
    databasePath: join(directory, "server.sqlite"),
    capabilities: [],
    workspaces,
    validateCheckpoint: validateFixture,
    ...overrides,
  });
  servers.add(handle);
  server = handle;
  return handle;
}
function register(
  clientId: string,
  credential: string,
  workspaceId = "workspace",
): void {
  server.registerDevice({
    workspaceId,
    ownerId: "owner",
    clientId,
    token: credential,
  });
}
function remote(
  credential: string,
  workspaceId = "workspace",
): CheckpointRemote {
  return new CheckpointRemote({
    baseUrl: server.url,
    workspaceId,
    token: credential,
    timeoutMs: 1_000,
  });
}
function makeCommit(
  serverEpoch: string,
  text: string,
  baseRevision: number,
  clientId: string,
  operationId: string,
): Commit {
  const value = checkpoint(text);
  return {
    protocol: 1,
    workspaceId: "workspace",
    clientId,
    operationId,
    serverEpoch,
    baseRevision,
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
}
async function raw(
  route: string,
  options: {
    method?: string;
    body?: unknown;
    credential?: string;
    workspaceId?: string;
  } = {},
): Promise<Response> {
  return fetch(
    `${server.url}/v1/workspaces/${options.workspaceId ?? "workspace"}/${route}`,
    {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${options.credential ?? ""}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    },
  );
}
async function closeServer(): Promise<void> {
  await server.close();
  servers.delete(server);
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "folio-sync-device-"));
  await boot();
});
afterEach(async () => {
  for (const current of servers) await current.close();
  servers.clear();
  for (const journal of journals) journal.close();
  journals.clear();
  rmSync(directory, { recursive: true, force: true });
});

describe("device-scoped checkpoint authorization", () => {
  it("scopes receipts to a device while sibling devices may pull the workspace", async () => {
    const aToken = token();
    const bToken = token();
    const otherToken = token();
    register("client-a", aToken);
    register("client-b", bToken);
    register("client-c", otherToken, "other");

    const a = remote(aToken);
    const b = remote(bToken);
    const head = await a.head();
    expect(head.head).toEqual({
      revision: 0,
      checkpointHash: null,
      checkpoint: null,
    });
    const operation = makeCommit(
      head.serverEpoch,
      "alpha",
      0,
      "client-a",
      "op-a",
    );
    const applied = await a.commit(operation);
    expect(applied).toMatchObject({ status: "applied", revision: 1 });
    expect(await a.lookup("client-a", "op-a")).toEqual(applied);
    expect(await a.commit(operation)).toEqual(applied);

    const page = await b.changes(0);
    expect(page.headRevision).toBe(1);
    expect(page.changes[0].checkpoint.payload.text).toBe("alpha");
    expect((await b.changes(1)).changes).toHaveLength(0);

    const existing = await raw("operations/client-a/op-a", {
      credential: bToken,
    });
    const missing = await raw("operations/client-a/not-an-operation", {
      credential: bToken,
    });
    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(await existing.json()).toEqual({ error: "client-mismatch" });
    expect(await missing.json()).toEqual({ error: "client-mismatch" });
    expect(await b.lookup("client-b", "not-an-operation")).toBeNull();

    const stolen = { ...operation, operationId: "op-stolen" };
    const denied = await raw("commits", {
      method: "POST",
      body: stolen,
      credential: bToken,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "client-mismatch" });
    expect((await a.head()).head.revision).toBe(1);

    for (const route of [
      "head",
      "changes?after=0",
      "operations/client-a/op-a",
    ]) {
      const response = await raw(route, { credential: otherToken });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    const wrongWorkspaceToken = await raw("commits", {
      method: "POST",
      body: { ...operation, operationId: "op-cross-workspace" },
      credential: otherToken,
    });
    expect(wrongWorkspaceToken.status).toBe(401);
    const randomToken = token();
    const absent = await raw("operations/client-a/not-an-operation", {
      credential: randomToken,
    });
    const present = await raw("operations/client-a/op-a", {
      credential: randomToken,
    });
    expect(absent.status).toBe(401);
    expect(present.status).toBe(401);
    expect(await absent.json()).toEqual(await present.json());
    expect((await raw("head", { workspaceId: "missing" })).status).toBe(401);
  });

  it("supports multiple journal clients pulling device-scoped history", async () => {
    const aToken = token();
    const bToken = token();
    register("client-a", aToken);
    register("client-b", bToken);
    const journalA = new SyncTransportJournal({
      path: join(directory, "a.sqlite"),
      workspaceId: "workspace",
      clientId: "client-a",
      bindingId: "binding-a",
    });
    const journalB = new SyncTransportJournal({
      path: join(directory, "b.sqlite"),
      workspaceId: "workspace",
      clientId: "client-b",
      bindingId: "binding-b",
    });
    journals.add(journalA);
    journals.add(journalB);
    const a = new CheckpointClient({
      baseUrl: server.url,
      token: aToken,
      journal: journalA,
      timeoutMs: 1_000,
    });
    const b = new CheckpointClient({
      baseUrl: server.url,
      token: bToken,
      journal: journalB,
      timeoutMs: 1_000,
    });
    await a.head();
    a.prepare(checkpoint("device journal"), 0);
    expect((await a.push())?.status).toBe("applied");
    await b.head();
    expect((await b.pull()).changes).toHaveLength(1);
    expect(b.journal.pendingInbox()[0].checkpoint.payload.text).toBe(
      "device journal",
    );
    expect(b.journal.status()).toMatchObject({
      receivedCursor: 1,
      staged: 1,
      application: "not-connected",
    });
    expect((await b.pull()).changes).toHaveLength(0);
    expect(a.journal.status().receivedCursor).toBe(0);
  });

  it("does not let a capability token bypass a device-scoped workspace", async () => {
    const capability = token();
    const otherCapability = token();
    const deviceToken = token();
    await closeServer();
    await boot({
      capabilities: [
        { workspaceId: "workspace", ownerId: "owner", token: capability },
        { workspaceId: "legacy", ownerId: "owner", token: otherCapability },
      ],
      workspaces: [{ workspaceId: "workspace", ownerId: "owner" }],
    });
    expect((await raw("head", { credential: capability })).status).toBe(401);
    expect((await raw("head", { credential: deviceToken })).status).toBe(401);
    register("client-a", deviceToken);
    expect((await raw("head", { credential: deviceToken })).status).toBe(200);
    expect((await raw("head", { credential: capability })).status).toBe(401);
    expect(
      (
        await raw("head", {
          credential: otherCapability,
          workspaceId: "legacy",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await raw("commits", {
          method: "POST",
          credential: capability,
          body: makeCommit("epoch", "bypass", 0, "client-a", "op-bypass"),
        })
      ).status,
    ).toBe(401);
    await closeServer();
    await expect(boot({
      capabilities: [{ workspaceId: "workspace", ownerId: "owner", token: capability }],
      workspaces: [],
    })).rejects.toThrow("workspace-device-mode-required");
  });

  it("validates registration ownership, token collision and revocation targets", async () => {
    const credential = token();
    expect(() =>
      register("client-a", credential, "missing"),
    ).toThrow("workspace-not-found");
    expect(() =>
      server.registerDevice({
        workspaceId: "workspace",
        ownerId: "different-owner",
        clientId: "client-a",
        token: credential,
      }),
    ).toThrow("workspace-owner-mismatch");
    register("client-a", credential);
    expect(() => register("client-b", credential)).toThrow("token-in-use");
    expect(() =>
      server.revokeDevice("workspace", "client-missing"),
    ).toThrow("device-not-found");
  });

  it("rotates only by explicit registration and keeps revocation across restart", async () => {
    const first = token();
    const second = token();
    const keeper = token();
    const afterRevoke = token();
    register("client-a", first);
    register("client-b", keeper);

    const a = remote(first);
    const head = await a.head();
    const operation = makeCommit(
      head.serverEpoch,
      "before rotation",
      0,
      "client-a",
      "op-rotate",
    );
    const applied = await a.commit(operation);

    register("client-a", second);
    const oldHead = await raw("head", { credential: first });
    expect(oldHead.status).toBe(401);
    expect(await oldHead.json()).toEqual({ error: "unauthorized" });
    expect((await remote(second).head()).head.revision).toBe(1);
    expect(await remote(second).lookup("client-a", "op-rotate")).toEqual(
      applied,
    );
    expect(
      (await raw("operations/client-a/op-rotate", { credential: first }))
        .status,
    ).toBe(401);
    expect(() => register("client-a", second)).not.toThrow();
    expect(() => register("client-b", second)).toThrow("token-in-use");

    server.revokeDevice("workspace", "client-a");
    const revoked = await raw("head", { credential: second });
    expect(revoked.status).toBe(401);
    expect(
      (await raw("operations/client-a/op-rotate", { credential: second }))
        .status,
    ).toBe(401);
    expect(() => register("client-a", afterRevoke)).toThrow("device-revoked");
    expect(() => server.revokeDevice("workspace", "client-a")).not.toThrow();

    await closeServer();
    await boot();
    expect((await raw("head", { credential: second })).status).toBe(401);
    expect((await raw("head", { credential: first })).status).toBe(401);
    expect((await raw("head", { credential: keeper })).status).toBe(200);
    expect(() => register("client-a", afterRevoke)).toThrow("device-revoked");

    const db = new DatabaseSync(join(directory, "server.sqlite"), {
      readOnly: true,
    });
    const serialized = JSON.stringify(
      db.prepare("SELECT * FROM checkpoint_devices").all(),
    );
    for (const credential of [first, second, keeper, afterRevoke])
      expect(serialized).not.toContain(credential);
    expect(serialized).toContain(
      createHash("sha256").update(second).digest("hex"),
    );
    expect(serialized).toContain(
      createHash("sha256").update(keeper).digest("hex"),
    );
    db.close();
  });

  it("rechecks authorization after awaiting a commit body", async () => {
    const aToken = token();
    const bToken = token();
    register("client-a", aToken);
    register("client-b", bToken);
    const head = await remote(aToken).head();
    const operation = makeCommit(
      head.serverEpoch,
      "revoked mid-upload",
      0,
      "client-a",
      "op-mid-upload",
    );
    const payload = JSON.stringify(operation);
    const split = Math.floor(payload.length / 2);
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${server.url}/v1/workspaces/workspace/commits`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${aToken}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        request.write(payload.slice(0, split));
        setTimeout(() => {
          server.revokeDevice("workspace", "client-a");
          request.end(payload.slice(split));
        }, 100);
      },
    );
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: "unauthorized" });
    const after = await remote(bToken).head();
    expect(after.head.revision).toBe(0);
    await expect(
      remote(bToken).lookup("client-a", "op-mid-upload"),
    ).rejects.toThrow("client-mismatch");
  });
});

describe("validator base semantics and stale receipts", () => {
  it("passes previous only when base equals head and keeps stale conflicts", async () => {
    const calls: Array<{ text: string; previous: string | null }> = [];
    const validator = (
      value: Checkpoint,
      previous: Checkpoint | null,
    ): boolean => {
      calls.push({
        text: String(value.payload.text),
        previous:
          previous === null ? null : String(previous.payload.text),
      });
      if (previous !== null) previous.payload.text = "mutated-by-validator";
      if (
        value.name !== "test-fixture" ||
        value.version !== 1 ||
        typeof value.payload.text !== "string"
      )
        throw new Error("fixture schema");
      if (value.payload.text === "invalid-schema") return false;
      if (previous !== null && value.payload.text === "omitted-successor")
        return false;
      return true;
    };
    await closeServer();
    await boot({ validateCheckpoint: validator });
    const aToken = token();
    const bToken = token();
    register("client-a", aToken);
    register("client-b", bToken);
    const a = remote(aToken);
    const b = remote(bToken);
    const base = await a.head();

    const one = makeCommit(base.serverEpoch, "one", 0, "client-a", "op-one");
    expect((await a.commit(one)).status).toBe("applied");
    expect(calls.at(-1)).toEqual({ text: "one", previous: null });
    const two = makeCommit(base.serverEpoch, "two", 1, "client-a", "op-two");
    expect((await a.commit(two)).status).toBe("applied");
    expect(calls.at(-1)).toEqual({ text: "two", previous: "one" });

    const stale = makeCommit(
      base.serverEpoch,
      "omitted-successor",
      0,
      "client-b",
      "op-stale",
    );
    const staleResponse = await raw("commits", {
      method: "POST",
      body: stale,
      credential: bToken,
    });
    expect(staleResponse.status).toBe(200);
    const conflict = (await staleResponse.json()) as {
      status: string;
      head: { revision: number; checkpoint: Checkpoint };
    };
    expect(conflict.status).toBe("conflict");
    expect(conflict.head.revision).toBe(2);
    expect(conflict.head.checkpoint.payload.text).toBe("two");
    expect(calls.at(-1)).toEqual({
      text: "omitted-successor",
      previous: null,
    });
    expect(await b.lookup("client-b", "op-stale")).toEqual(conflict);

    const invalid = makeCommit(
      base.serverEpoch,
      "invalid-schema",
      0,
      "client-b",
      "op-invalid",
    );
    const invalidResponse = await raw("commits", {
      method: "POST",
      body: invalid,
      credential: bToken,
    });
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toEqual({
      error: "checkpoint-schema-rejected",
    });
    expect(await b.lookup("client-b", "op-invalid")).toBeNull();
    expect((await b.head()).head.revision).toBe(2);

    const omitted = makeCommit(
      base.serverEpoch,
      "omitted-successor",
      2,
      "client-b",
      "op-omitted",
    );
    const omittedResponse = await raw("commits", {
      method: "POST",
      body: omitted,
      credential: bToken,
    });
    expect(omittedResponse.status).toBe(422);
    expect(calls.at(-1)).toEqual({
      text: "omitted-successor",
      previous: "two",
    });
    expect(await b.lookup("client-b", "op-omitted")).toBeNull();
    expect((await b.head()).head.revision).toBe(2);

    let afterRestartValidations = 0;
    await closeServer();
    await boot({
      validateCheckpoint: () => {
        afterRestartValidations++;
        return false;
      },
    });
    const restartedB = remote(bToken);
    expect(await restartedB.lookup("client-b", "op-stale")).toEqual(conflict);
    const replay = await raw("commits", {
      method: "POST",
      body: stale,
      credential: bToken,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(conflict);
    expect(afterRestartValidations).toBe(0);
    expect((await restartedB.head()).head.revision).toBe(2);
  });
});
