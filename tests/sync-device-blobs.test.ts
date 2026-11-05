import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hashCheckpoint,
  SyncError,
  type Checkpoint,
  type Commit,
} from "../src/sync/protocol";
import {
  startCheckpointServer,
  type CheckpointBlobAdapter,
  type CheckpointServerHandle,
} from "../src/sync/checkpoint-server";
import { CheckpointRemote } from "../src/sync/client";

type Manifest = Checkpoint["assets"][number];
const workspaces = [
  { workspaceId: "workspace", ownerId: "owner" },
  { workspaceId: "other", ownerId: "owner" },
];
const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const assetCheckpoint = (
  text: string,
  assets: Manifest[],
): Checkpoint => ({
  format: "folio-checkpoint/v1",
  name: "test-fixture",
  version: 1,
  payload: { text },
  assets,
});
const assetCommit = (
  serverEpoch: string,
  text: string,
  baseRevision: number,
  clientId: string,
  operationId: string,
  assets: Manifest[],
): Commit => {
  const value = assetCheckpoint(text, assets);
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
};
const validateFixture = (value: Checkpoint): boolean => {
  if (
    value.name !== "test-fixture" ||
    value.version !== 1 ||
    typeof value.payload.text !== "string"
  )
    throw new Error("fixture schema");
  return true;
};

class MemoryBlobs implements CheckpointBlobAdapter {
  private readonly data = new Map<string, Buffer>();
  readonly calls: Array<{
    method: string;
    workspaceId: string;
    sha256: string;
  }> = [];
  beforeAssert?: () => void;

  private key(workspaceId: string, sha256: string): string {
    return `${workspaceId}:${sha256}`;
  }
  put(workspaceId: string, sha256: string, value: string): void {
    this.data.set(this.key(workspaceId, sha256), Buffer.from(value));
  }
  has(
    workspaceId: string,
    asset: { id: string; sha256: string; bytes: number },
  ): boolean {
    return this.data.get(this.key(workspaceId, asset.sha256))?.byteLength ===
      asset.bytes;
  }
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: {
      workspaceId: string;
      sha256: string;
      assertAuthorized: () => void;
    },
  ): Promise<void> {
    this.calls.push({
      method: request.method ?? "GET",
      workspaceId: context.workspaceId,
      sha256: context.sha256,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.beforeAssert?.();
    try {
      context.assertAuthorized();
    } catch (error) {
      const known = error instanceof SyncError;
      const content = JSON.stringify({
        error: known ? error.code : "internal-error",
      });
      if (!response.headersSent) {
        response.writeHead(known ? error.status : 500, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(content),
        });
        response.end(content);
      }
      return;
    }
    if (request.method === "PUT") {
      this.data.set(
        this.key(context.workspaceId, context.sha256),
        Buffer.concat(chunks),
      );
      const content = JSON.stringify({ stored: true });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(content),
      });
      response.end(content);
      return;
    }
    const value = this.data.get(
      this.key(context.workspaceId, context.sha256),
    );
    if (value === undefined) {
      const content = JSON.stringify({ error: "blob-not-found" });
      response.writeHead(404, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(content),
      });
      response.end(content);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": value.length,
    });
    response.end(request.method === "HEAD" ? undefined : value);
  }
}

let directory: string;
let server: CheckpointServerHandle;
const servers = new Set<CheckpointServerHandle>();
const token = (): string => randomBytes(32).toString("hex");

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
function register(clientId: string, credential: string): void {
  server.registerDevice({
    workspaceId: "workspace",
    ownerId: "owner",
    clientId,
    token: credential,
  });
}
function remote(credential: string): CheckpointRemote {
  return new CheckpointRemote({
    baseUrl: server.url,
    workspaceId: "workspace",
    token: credential,
    timeoutMs: 1_000,
  });
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
  directory = mkdtempSync(join(tmpdir(), "folio-sync-blobs-"));
  await boot();
});
afterEach(async () => {
  for (const current of servers) await current.close();
  servers.clear();
  rmSync(directory, { recursive: true, force: true });
});

describe("checkpoint blob adapter boundary", () => {
  it("authenticates and rechecks blob routes before delegating", async () => {
    const blobs = new MemoryBlobs();
    await closeServer();
    await boot({ blobs });
    const aToken = token();
    const otherToken = token();
    register("client-a", aToken);
    server.registerDevice({
      workspaceId: "other",
      ownerId: "owner",
      clientId: "client-b",
      token: otherToken,
    });
    const checksum = sha("payload");
    const url = `${server.url}/v1/workspaces/workspace/blobs/${checksum}`;
    for (const method of ["GET", "PUT", "HEAD"]) {
      const response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${otherToken}` },
        body: method === "PUT" ? "payload" : undefined,
      });
      expect(response.status).toBe(401);
      if (method !== "HEAD")
        expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    const invalid = await fetch(url, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    expect(invalid.status).toBe(401);
    expect(blobs.calls).toHaveLength(0);

    const put = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${aToken}` },
      body: "payload",
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ stored: true });
    expect(blobs.calls[0]).toEqual({
      method: "PUT",
      workspaceId: "workspace",
      sha256: checksum,
    });
    const get = await fetch(url, {
      headers: { Authorization: `Bearer ${aToken}` },
    });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("payload");
    const head = await fetch(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${aToken}` },
    });
    expect(head.status).toBe(200);

    const second = sha("second");
    blobs.beforeAssert = () => {
      server.revokeDevice("workspace", "client-a");
      blobs.beforeAssert = undefined;
    };
    const revoked = await fetch(
      `${server.url}/v1/workspaces/workspace/blobs/${second}`,
      { headers: { Authorization: `Bearer ${aToken}` } },
    );
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: "unauthorized" });
  });

  it("requires every referenced blob before accepting or persisting a commit", async () => {
    const blobs = new MemoryBlobs();
    await closeServer();
    await boot({ blobs });
    const aToken = token();
    const bToken = token();
    register("client-a", aToken);
    register("client-b", bToken);
    const presentSha = sha("present");
    const present = { id: "00000000-0000-4000-8000-000000000001", sha256: presentSha, bytes: 7 };
    const missing = {
      id: "00000000-0000-4000-8000-000000000002",
      sha256: sha("missing"),
      bytes: 7,
    };

    const missingCommit = assetCommit(
      server.serverEpoch,
      "asset-missing",
      0,
      "client-a",
      "op-missing",
      [missing],
    );
    const missingResponse = await raw("commits", {
      method: "POST",
      body: missingCommit,
      credential: aToken,
    });
    expect(missingResponse.status).toBe(409);
    expect(await missingResponse.json()).toEqual({ error: "blob-missing" });
    expect((await remote(aToken).head()).head.revision).toBe(0);
    expect(await remote(aToken).lookup("client-a", "op-missing")).toBeNull();

    blobs.put("workspace", presentSha, "present");
    const presentCommit = assetCommit(
      server.serverEpoch,
      "asset-present",
      0,
      "client-a",
      "op-present",
      [present],
    );
    const applied = await remote(aToken).commit(presentCommit);
    expect(applied).toMatchObject({
      status: "applied",
      revision: 1,
      checkpointHash: presentCommit.checkpointHash,
    });
    const db = new DatabaseSync(join(directory, "server.sqlite"), {
      readOnly: true,
    });
    const stored = db
      .prepare(
        "SELECT revision, checkpoint_json FROM checkpoint_heads WHERE workspace_id=?",
      )
      .get("workspace")!;
    expect(stored.revision).toBe(1);
    expect(JSON.parse(String(stored.checkpoint_json)).assets).toEqual([
      present,
    ]);
    db.close();

    const staleMissing = assetCommit(
      server.serverEpoch,
      "stale-missing",
      0,
      "client-b",
      "op-stale-missing",
      [{ id: "00000000-0000-4000-8000-000000000003", sha256: sha("other"), bytes: 5 }],
    );
    const staleMissingResponse = await raw("commits", {
      method: "POST",
      body: staleMissing,
      credential: bToken,
    });
    expect(staleMissingResponse.status).toBe(409);
    expect(await remote(bToken).lookup("client-b", "op-stale-missing")).toBeNull();
    const headAfterRejection = (await (
      await raw("head", { credential: aToken })
    ).json()) as { head: { revision: number } };
    expect(headAfterRejection.head.revision).toBe(1);

    const stalePresent = assetCommit(
      server.serverEpoch,
      "stale-present",
      0,
      "client-b",
      "op-stale-present",
      [{ id: "00000000-0000-4000-8000-000000000004", sha256: presentSha, bytes: 7 }],
    );
    const conflictResponse = await raw("commits", {
      method: "POST",
      body: stalePresent,
      credential: bToken,
    });
    expect(conflictResponse.status).toBe(200);
    const conflict = (await conflictResponse.json()) as {
      status: string;
      head: { revision: number; checkpoint: Checkpoint };
    };
    expect(conflict.status).toBe("conflict");
    expect(conflict.head.revision).toBe(1);
    expect(conflict.head.checkpoint.assets).toEqual([present]);
    const replay = await raw("commits", {
      method: "POST",
      body: stalePresent,
      credential: bToken,
    });
    expect(await replay.json()).toEqual(conflict);
    const lookup = await raw("operations/client-b/op-stale-present", {
      credential: bToken,
    });
    expect(await lookup.json()).toEqual(conflict);
    expect(
      (await raw("operations/client-a/op-stale-present", { credential: bToken }))
        .status,
    ).toBe(403);
  });

  it("rejects nonempty assets when no blob adapter is configured", async () => {
    const aToken = token();
    register("client-a", aToken);
    const value = {
      id: "00000000-0000-4000-8000-000000000001",
      sha256: sha("present"),
      bytes: 7,
    };
    const operation = assetCommit(
      server.serverEpoch,
      "no-adapter",
      0,
      "client-a",
      "op-no-adapter",
      [value],
    );
    const response = await raw("commits", {
      method: "POST",
      body: operation,
      credential: aToken,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "attachments-not-supported",
    });
    expect((await remote(aToken).head()).head.revision).toBe(0);
    expect(
      await remote(aToken).lookup("client-a", "op-no-adapter"),
    ).toBeNull();
  });
});
