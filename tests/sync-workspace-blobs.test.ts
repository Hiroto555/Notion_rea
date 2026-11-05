import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Loopback chunk tests can be slowed by parallel suite load; the assertions
// themselves have no dependence on wall-clock speed.
vi.setConfig({ testTimeout: 20_000 });
import { sha256 as hashText, SyncError } from "../src/sync/protocol";
import {
  WORKSPACE_BLOB_MAX_BYTES,
  WorkspaceBlobStore,
} from "../src/sync/workspace-blobs";

type BlobAsset = { id: string; sha256: string; bytes: number };
type CallRecord = {
  method: string;
  workspaceId: string;
  sha256: string;
  assertion: number;
};
type RunningBlobServer = {
  url: string;
  close(): Promise<void>;
  calls: CallRecord[];
};
type CallResult = {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

const roots: string[] = [];
const servers: RunningBlobServer[] = [];
const rawServers = new Set<Server>();
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function assetFor(bytes: Buffer, extension = ""): BlobAsset {
  return {
    id: randomUUID() + extension,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice(7)
    : "";
}

async function startBlobServer(
  store: WorkspaceBlobStore,
  capabilities: Record<string, string>,
  options: { failAssertAfter?: number } = {},
): Promise<RunningBlobServer> {
  const calls: CallRecord[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        const match =
          /^\/v1\/workspaces\/([A-Za-z0-9_-]+)\/blobs\/([a-f0-9]{64})$/.exec(
            url.pathname,
          );
        if (!match) {
          response.writeHead(404).end();
          return;
        }
        const workspaceId = match[1];
        const sha = match[2];
        let assertion = 0;
        await store.handle(request, response, {
          workspaceId,
          sha256: sha,
          assertAuthorized: () => {
            assertion++;
            calls.push({
              method: request.method || "",
              workspaceId,
              sha256: sha,
              assertion,
            });
            if (bearer(request) !== capabilities[workspaceId])
              throw new SyncError("unauthorized", 401);
            if (
              options.failAssertAfter !== undefined &&
              assertion > options.failAssertAfter
            )
              throw new SyncError("unauthorized", 401);
          },
        });
      } catch (error) {
        if (response.headersSent || response.destroyed) {
          response.destroy();
          return;
        }
        const code = error instanceof SyncError ? error.code : "internal-error";
        const status = error instanceof SyncError ? error.status : 500;
        const body = JSON.stringify({ error: code });
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
        });
        response.end(body);
      }
    })();
  });
  rawServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const running: RunningBlobServer = {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      rawServers.delete(server);
    },
  };
  servers.push(running);
  return running;
}

function callBlob(
  server: RunningBlobServer,
  method: string,
  workspaceId: string,
  sha: string,
  credential: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${server.url}/v1/workspaces/${workspaceId}/blobs/${sha}`,
      {
        method,
        agent: false,
        headers: {
          Authorization: `Bearer ${credential}`,
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function putFull(
  server: RunningBlobServer,
  workspaceId: string,
  asset: BlobAsset,
  bytes: Buffer,
  credential: string,
) {
  return callBlob(
    server,
    "PUT",
    workspaceId,
    asset.sha256,
    credential,
    {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
    },
    bytes,
  );
}

async function putChunk(
  server: RunningBlobServer,
  workspaceId: string,
  asset: BlobAsset,
  bytes: Buffer,
  start: number,
  credential: string,
) {
  const end = start + bytes.length;
  return callBlob(
    server,
    "PUT",
    workspaceId,
    asset.sha256,
    credential,
    {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Range": `bytes ${start}-${end - 1}/${asset.bytes}`,
    },
    bytes,
  );
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const server of rawServers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rawServers.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceBlobStore", () => {
  it("stores and serves exact workspace bytes, ranges, and HEAD without redirects", async () => {
    const root = tempRoot("folio-workspace-blobs-store-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token();
    const b = token();
    const server = await startBlobServer(store, {
      workspace: a,
      other: b,
    });
    const bytes = randomBytes(1024 * 1024 + 137);
    const asset = assetFor(bytes, ".bin");

    expect(store.has("workspace", asset)).toBe(false);
    const put = await putFull(server, "workspace", asset, bytes, a);
    expect(put.status).toBe(201);
    expect(put.headers["location"]).toBeUndefined();
    expect(put.headers["x-folio-blob-sha256"]).toBe(asset.sha256);
    expect(store.has("workspace", asset)).toBe(true);
    expect(store.has("other", asset)).toBe(false);

    const head = await callBlob(server, "HEAD", "workspace", asset.sha256, a);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(asset.bytes));
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.body).toHaveLength(0);

    const get = await callBlob(server, "GET", "workspace", asset.sha256, a);
    expect(get.status).toBe(200);
    expect(get.headers["location"]).toBeUndefined();
    expect(get.body).toEqual(bytes);

    const range = await callBlob(server, "GET", "workspace", asset.sha256, a, {
      Range: "bytes=100-199",
    });
    expect(range.status).toBe(206);
    expect(range.headers["content-range"]).toBe(`bytes 100-199/${asset.bytes}`);
    expect(range.headers["content-length"]).toBe("100");
    expect(range.body).toEqual(bytes.subarray(100, 200));

    const suffix = await callBlob(server, "GET", "workspace", asset.sha256, a, {
      Range: "bytes=-17",
    });
    expect(suffix.status).toBe(206);
    expect(suffix.body).toEqual(bytes.subarray(bytes.length - 17));

    const badRange = await callBlob(
      server,
      "GET",
      "workspace",
      asset.sha256,
      a,
      { Range: "bytes=999999999-" },
    );
    expect(badRange.status).toBe(416);

    // The stored file is verified on every "present" answer.
    const finalPath = join(root, "blobs", hashText("workspace"), asset.sha256);
    writeFileSync(finalPath, Buffer.from("damaged"));
    expect(store.has("workspace", asset)).toBe(false);
    expect(
      (await callBlob(server, "GET", "workspace", asset.sha256, a)).status,
    ).toBe(404);
    expect(
      (await callBlob(server, "HEAD", "workspace", asset.sha256, a)).status,
    ).toBe(404);
  });

  it("isolates case-variant workspaces and excludes a second writer while a partial is open", async () => {
    const root = tempRoot("folio-workspace-blobs-parallel-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token(),
      b = token();
    const server = await startBlobServer(store, { workspace: a, Workspace: b });
    const bytes = randomBytes(32 * 1024),
      asset = assetFor(bytes);
    const first = httpRequest(
      `${server.url}/v1/workspaces/workspace/blobs/${asset.sha256}`,
      {
        method: "PUT",
        agent: false,
        headers: {
          Authorization: `Bearer ${a}`,
          "Content-Length": String(bytes.length),
          "Content-Type": "application/octet-stream",
        },
      },
    );
    const result = new Promise<number | undefined>((resolve, reject) => {
      first.once("error", reject);
      first.once("response", (response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });
    try {
      first.write(bytes.subarray(0, 1024));
      await vi.waitFor(() =>
        expect(
          existsSync(
            join(
              root,
              "blobs",
              hashText("workspace"),
              `.partial-${asset.sha256}`,
            ),
          ),
        ).toBe(true),
      );
      const concurrent = await putFull(
        server,
        "workspace",
        asset,
        Buffer.alloc(bytes.length),
        a,
      );
      expect(concurrent.status).toBe(409);
      expect(JSON.parse(concurrent.body.toString())).toEqual({
        error: "blob-upload-in-progress",
      });
      first.end(bytes.subarray(1024));
      expect(await result).toBe(201);
      expect(
        (await callBlob(server, "GET", "workspace", asset.sha256, a)).body,
      ).toEqual(bytes);
      expect(
        (await callBlob(server, "GET", "Workspace", asset.sha256, b)).status,
      ).toBe(404);
    } finally {
      first.destroy();
      await result.catch(() => {});
    }
  });

  it("requires another authorization check after body handling and leaves no published file", async () => {
    const root = tempRoot("folio-workspace-blobs-auth-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token();
    const server = await startBlobServer(
      store,
      { workspace: a },
      { failAssertAfter: 1 },
    );
    const bytes = randomBytes(32 * 1024);
    const asset = assetFor(bytes);

    const put = await putFull(server, "workspace", asset, bytes, a);
    expect(put.status).toBe(401);
    expect(JSON.parse(put.body.toString())).toEqual({ error: "unauthorized" });
    expect(store.has("workspace", asset)).toBe(false);
    // The file was never published, so the later read is a normal 404.
    expect(
      (await callBlob(server, "GET", "workspace", asset.sha256, a)).status,
    ).toBe(404);
    // The second assertion comes from the PUT path itself, not the wrapper.
    expect(
      server.calls
        .filter((entry) => entry.method === "PUT")
        .map((entry) => entry.assertion),
    ).toEqual([1, 2]);
  });

  it("resumes Content-Range chunks, never exposes partials, and checks the final hash", async () => {
    const root = tempRoot("folio-workspace-blobs-range-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token();
    const server = await startBlobServer(store, { workspace: a });
    const bytes = randomBytes(2 * 1024 * 1024 + 333);
    const asset = assetFor(bytes);
    const firstEnd = 1024 * 1024;

    const first = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(0, firstEnd),
      0,
      a,
    );
    expect(first.status).toBe(204);
    expect(first.headers["x-folio-blob-received"]).toBe(String(firstEnd));
    expect(store.has("workspace", asset)).toBe(false);
    expect(
      (await callBlob(server, "HEAD", "workspace", asset.sha256, a)).status,
    ).toBe(404);
    expect(
      (await callBlob(server, "GET", "workspace", asset.sha256, a)).status,
    ).toBe(404);
    const partialName = `.partial-${asset.sha256}`;
    expect(
      readdirSync(join(root, "blobs", hashText("workspace"))).includes(
        partialName,
      ),
    ).toBe(true);

    // A client that lost the first acknowledgement resends an overlapping
    // chunk. The server truncates to the requested start before appending.
    const replay = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(0, firstEnd),
      0,
      a,
    );
    expect(replay.status).toBe(204);

    const second = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(firstEnd, 2 * 1024 * 1024),
      firstEnd,
      a,
    );
    expect(second.status).toBe(204);

    const last = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(2 * 1024 * 1024),
      2 * 1024 * 1024,
      a,
    );
    expect(last.status).toBe(201);
    expect(last.headers["x-folio-blob-complete"]).toBe("true");
    expect(store.has("workspace", asset)).toBe(true);
    expect(
      readdirSync(join(root, "blobs", hashText("workspace"))).filter((name) =>
        name.startsWith(".partial-"),
      ),
    ).toEqual([]);
    const get = await callBlob(server, "GET", "workspace", asset.sha256, a);
    expect(get.body).toEqual(bytes);

    const beyond = await putChunk(
      server,
      "workspace",
      asset,
      Buffer.from("x"),
      2 * 1024 * 1024 + 100,
      a,
    );
    expect(beyond.status).toBe(409);
    expect(JSON.parse(beyond.body.toString())).toEqual({
      error: "blob-offset-mismatch",
    });
  });

  it("keeps a transport-interrupted partial and resumes from its stored byte offset", async () => {
    const root = tempRoot("folio-workspace-blobs-interrupted-put-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token();
    const server = await startBlobServer(store, { workspace: a });
    const bytes = randomBytes(2 * 1024 * 1024 + 19);
    const asset = assetFor(bytes);
    const firstEnd = 1024 * 1024;
    const partialPath = join(
      root,
      "blobs",
      hashText("workspace"),
      `.partial-${asset.sha256}`,
    );

    const interrupted = httpRequest(
      `${server.url}/v1/workspaces/workspace/blobs/${asset.sha256}`,
      {
        method: "PUT",
        agent: false,
        headers: {
          Authorization: `Bearer ${a}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(firstEnd),
          "Content-Range": `bytes 0-${firstEnd - 1}/${asset.bytes}`,
        },
      },
      (response) => response.resume(),
    );
    interrupted.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      interrupted.write(bytes.subarray(0, 400_000), (error) => {
        if (error) {
          reject(error);
          return;
        }
        interrupted.destroy();
        resolve();
      });
    });

    let stable = -1;
    for (let attempt = 0; attempt < 200; attempt++) {
      let size = 0;
      try {
        size = statSync(partialPath).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size === stable) break;
      stable = size;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(stable).toBeGreaterThan(0);
    expect(stable).toBeLessThanOrEqual(400_000);

    if (stable < firstEnd) {
      const resumed = await putChunk(
        server,
        "workspace",
        asset,
        bytes.subarray(stable, firstEnd),
        stable,
        a,
      );
      expect(resumed.status).toBe(204);
    }
    const second = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(firstEnd, 2 * 1024 * 1024),
      firstEnd,
      a,
    );
    expect(second.status).toBe(204);
    const last = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(2 * 1024 * 1024),
      2 * 1024 * 1024,
      a,
    );
    expect(last.status).toBe(201);
    expect(store.has("workspace", asset)).toBe(true);
    expect(
      (await callBlob(server, "GET", "workspace", asset.sha256, a)).body,
    ).toEqual(bytes);
  });

  it("rejects size caps, bad ranges, and malformed chunk lengths before publication", async () => {
    const root = tempRoot("folio-workspace-blobs-limits-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token();
    const server = await startBlobServer(store, { workspace: a });
    const bytes = randomBytes(64 * 1024);
    const asset = assetFor(bytes);

    const tooLarge = await callBlob(
      server,
      "PUT",
      "workspace",
      asset.sha256,
      a,
      {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(WORKSPACE_BLOB_MAX_BYTES + 1),
      },
    );
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.body.toString())).toEqual({
      error: "blob-too-large",
    });
    expect(store.has("workspace", asset)).toBe(false);

    const tooLargeRange = await callBlob(
      server,
      "PUT",
      "workspace",
      asset.sha256,
      a,
      {
        "Content-Type": "application/octet-stream",
        "Content-Length": "1",
        "Content-Range": `bytes 0-0/${WORKSPACE_BLOB_MAX_BYTES + 1}`,
      },
      Buffer.from("x"),
    );
    expect(tooLargeRange.status).toBe(413);
    expect(store.has("workspace", asset)).toBe(false);

    const badContentRange = await callBlob(
      server,
      "PUT",
      "workspace",
      asset.sha256,
      a,
      {
        "Content-Type": "application/octet-stream",
        "Content-Length": "1",
        "Content-Range": "bytes 5-1/10",
      },
      Buffer.from("x"),
    );
    expect(badContentRange.status).toBe(400);

    const wrongLength = await callBlob(
      server,
      "PUT",
      "workspace",
      asset.sha256,
      a,
      {
        "Content-Type": "application/octet-stream",
        "Content-Length": "50",
        "Content-Range": `bytes 0-99/${asset.bytes}`,
      },
      bytes.subarray(0, 50),
    );
    expect(wrongLength.status).toBe(400);

    const before = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(0, 1024),
      0,
      a,
    );
    expect(before.status).toBe(204);
    const beyond = await putChunk(
      server,
      "workspace",
      asset,
      bytes.subarray(0, 1024),
      4096,
      a,
    );
    expect(beyond.status).toBe(409);
    expect(store.has("workspace", asset)).toBe(false);
  });

  it("keeps an existing mismatched final file and rejects a wrong hash", async () => {
    const root = tempRoot("folio-workspace-blobs-immutable-");
    const directory = join(root, "blobs", hashText("workspace"));
    mkdirSync(directory, { recursive: true });
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token();
    const server = await startBlobServer(store, { workspace: a });
    const bytes = randomBytes(8 * 1024);
    const asset = assetFor(bytes);
    const finalPath = join(directory, asset.sha256);
    writeFileSync(finalPath, Buffer.from("existing-original"));

    const conflicted = await putFull(server, "workspace", asset, bytes, a);
    expect(conflicted.status).toBe(409);
    expect(JSON.parse(conflicted.body.toString())).toEqual({
      error: "blob-id-hash-conflict",
    });
    expect(readFileSync(finalPath)).toEqual(Buffer.from("existing-original"));
    expect(store.has("workspace", asset)).toBe(false);

    const missing = Buffer.from("not the manifest bytes");
    const wrong = await putFull(server, "workspace", asset, missing, a);
    expect(wrong.status).toBe(422);
    expect(JSON.parse(wrong.body.toString())).toEqual({
      error: "blob-hash-mismatch",
    });
    expect(readFileSync(finalPath)).toEqual(Buffer.from("existing-original"));
  });

  it("separates workspaces from tokens and rejects symlinked stored files", async () => {
    const root = tempRoot("folio-workspace-blobs-isolation-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const a = token();
    const b = token();
    const server = await startBlobServer(store, {
      workspace: a,
      other: b,
    });
    const bytes = randomBytes(4096);
    const asset = assetFor(bytes);

    expect((await putFull(server, "workspace", asset, bytes, a)).status).toBe(
      201,
    );
    expect((await putFull(server, "other", asset, bytes, b)).status).toBe(201);
    expect(store.has("workspace", asset)).toBe(true);
    expect(store.has("other", asset)).toBe(true);

    const crossToken = await callBlob(
      server,
      "GET",
      "workspace",
      asset.sha256,
      b,
    );
    expect(crossToken.status).toBe(401);
    expect(JSON.parse(crossToken.body.toString())).toEqual({
      error: "unauthorized",
    });
    expect(
      (await callBlob(server, "GET", "other", asset.sha256, a)).status,
    ).toBe(401);

    // A symlink at the final name is never followed, and `has` is false.
    const finalPath = join(root, "blobs", hashText("workspace"), asset.sha256);
    const elsewhere = join(root, "outside-copy");
    writeFileSync(elsewhere, bytes);
    rmSync(finalPath);
    symlinkSync(elsewhere, finalPath);
    expect(lstatSync(finalPath).isSymbolicLink()).toBe(true);
    expect(store.has("workspace", asset)).toBe(false);
    expect(
      (await callBlob(server, "GET", "workspace", asset.sha256, a)).status,
    ).toBe(404);
    expect(existsSync(elsewhere)).toBe(true);
  });
});
