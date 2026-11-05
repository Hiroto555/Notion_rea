import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Loopback chunk tests can be slowed by parallel suite load; the assertions
// themselves have no dependence on wall-clock speed.
vi.setConfig({ testTimeout: 20_000 });
import { SyncError } from "../src/sync/protocol";
import {
  WORKSPACE_BLOB_MAX_BYTES,
  WorkspaceBlobStore,
  assertWorkspaceAssets,
  stageCheckpointAssets,
  uploadCheckpointAssets,
  type WorkspaceBlobAsset,
} from "../src/sync/workspace-blobs";

type Running = { url: string; close(): Promise<void> };
type CapturedCall = { method: string; workspaceId: string; sha256: string };

const roots: string[] = [];
const servers: Running[] = [];
const rawServers = new Set<Server>();
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function manifestFor(bytes: Buffer, extension = ".bin"): WorkspaceBlobAsset {
  return {
    id: randomUUID() + extension,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

function createSource(
  directory: string,
  bytes: Buffer,
  extension = ".bin",
): WorkspaceBlobAsset {
  mkdirSync(directory, { recursive: true });
  const asset = manifestFor(bytes, extension);
  writeFileSync(join(directory, asset.id), bytes);
  return asset;
}

async function listen(server: Server): Promise<Running> {
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
  const running: Running = {
    url: `http://127.0.0.1:${address.port}`,
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

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice(7)
    : "";
}

async function startStoreServer(
  store: WorkspaceBlobStore,
  capabilities: Record<string, string>,
  options: { rejectHead?: boolean } = {},
): Promise<Running & { calls: CapturedCall[] }> {
  const calls: CapturedCall[] = [];
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
        if (options.rejectHead && request.method === "HEAD") {
          response.writeHead(405).end();
          return;
        }
        calls.push({
          method: request.method || "",
          workspaceId,
          sha256: sha,
        });
        await store.handle(request, response, {
          workspaceId,
          sha256: sha,
          assertAuthorized: () => {
            if (bearer(request) !== capabilities[workspaceId])
              throw new SyncError("unauthorized", 401);
          },
        });
      } catch (error) {
        if (response.headersSent || response.destroyed) {
          response.destroy();
          return;
        }
        const status = error instanceof SyncError ? error.status : 500;
        const code = error instanceof SyncError ? error.code : "internal-error";
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
  const running = await listen(server);
  return Object.assign(running, { calls });
}

function options(
  baseUrl: string,
  assetsDirectory: string,
  overrides: Partial<Parameters<typeof uploadCheckpointAssets>[0]> = {},
) {
  return {
    baseUrl,
    workspaceId: "workspace",
    token: token(),
    assetsDirectory,
    timeoutMs: 2_000,
    ...overrides,
  };
}

function parseRequestRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } {
  if (!value) return { start: 0, end: size - 1 };
  const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(value);
  if (!match) throw new Error("unexpected range " + value);
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), size - 1);
  return { start, end };
}

function responseJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function startCorruptGetter(
  asset: WorkspaceBlobAsset,
  corrupt: Buffer,
): Promise<Running> {
  const server = createServer((request, response) => {
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Length": asset.bytes,
        "X-Folio-Blob-Sha256": asset.sha256,
        "Accept-Ranges": "bytes",
      });
      response.end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const { start, end } = parseRequestRange(
      request.headers.range,
      corrupt.length,
    );
    response.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${corrupt.length}`,
      "X-Folio-Blob-Sha256": asset.sha256,
      "Accept-Ranges": "bytes",
    });
    response.end(corrupt.subarray(start, end + 1));
  });
  return listen(server);
}

function startInterruptedGetter(
  asset: WorkspaceBlobAsset,
  bytes: Buffer,
  interruptAfter: number,
): Promise<Running & { ranges: string[] }> {
  const ranges: string[] = [];
  let interrupted = false;
  const server = createServer((request, response) => {
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Length": asset.bytes,
        "X-Folio-Blob-Sha256": asset.sha256,
        "Accept-Ranges": "bytes",
      });
      response.end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const rangeHeader = request.headers.range;
    ranges.push(rangeHeader || "");
    const { start, end } = parseRequestRange(rangeHeader, bytes.length);
    response.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      "X-Folio-Blob-Sha256": asset.sha256,
      "Accept-Ranges": "bytes",
    });
    if (!interrupted) {
      interrupted = true;
      const take = Math.min(interruptAfter, end - start + 1);
      response.write(bytes.subarray(start, start + take), () =>
        response.destroy(),
      );
      return;
    }
    response.end(bytes.subarray(start, end + 1));
  });
  return listen(server).then((running) => Object.assign(running, { ranges }));
}

function startDroppingUploadServer(
  asset: WorkspaceBlobAsset,
  bytes: Buffer,
): Promise<
  Running & { starts: number[]; received(): Buffer; complete(): boolean }
> {
  const buffer = Buffer.alloc(asset.bytes);
  const starts: number[] = [];
  let received = 0;
  let dropped = false;
  let complete = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "HEAD") {
        if (complete) {
          response.writeHead(200, {
            "Content-Length": asset.bytes,
            "X-Folio-Blob-Sha256": asset.sha256,
            "Accept-Ranges": "bytes",
          });
          response.end();
        } else {
          response.writeHead(404).end();
        }
        return;
      }
      if (request.method === "GET") {
        if (!complete) {
          response.writeHead(404).end();
          return;
        }
        const { start, end } = parseRequestRange(
          request.headers.range,
          asset.bytes,
        );
        response.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${asset.bytes}`,
          "X-Folio-Blob-Sha256": asset.sha256,
          "Accept-Ranges": "bytes",
        });
        response.end(buffer.subarray(start, end + 1));
        return;
      }
      if (request.method !== "PUT") {
        response.writeHead(405).end();
        return;
      }
      const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(
        String(request.headers["content-range"] || ""),
      );
      if (!match) {
        responseJson(response, 400, { error: "invalid-content-range" });
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = Number(match[3]);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      if (
        total !== asset.bytes ||
        body.length !== end - start + 1 ||
        end >= total
      ) {
        responseJson(response, 400, { error: "content-length-mismatch" });
        return;
      }
      if (start > buffer.length) {
        responseJson(response, 409, { error: "blob-offset-mismatch" });
        return;
      }
      starts.push(start);
      body.copy(buffer, start);
      received = Math.max(received, end + 1);
      if (!dropped && start === 0) {
        dropped = true;
        request.socket.destroy();
        return;
      }
      if (received === total) {
        if (sha256(buffer) !== asset.sha256) {
          responseJson(response, 422, { error: "blob-hash-mismatch" });
          return;
        }
        complete = true;
        response.writeHead(201, {
          "Content-Length": "0",
          "X-Folio-Blob-Sha256": asset.sha256,
          "X-Folio-Blob-Complete": "true",
        });
        response.end();
        return;
      }
      response.writeHead(204, {
        "X-Folio-Blob-Received": String(received),
      });
      response.end();
    })();
  });
  return listen(server).then((running) =>
    Object.assign(running, {
      starts,
      received: () => buffer,
      complete: () => complete,
    }),
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

describe("workspace blob client transfers", () => {
  it("uploads and stages verified files, then skips already verified targets", async () => {
    const root = tempRoot("folio-workspace-blobs-roundtrip-");
    const store = new WorkspaceBlobStore(join(root, "server"));
    const a = token();
    const server = await startStoreServer(store, { workspace: a });
    const source = join(root, "source");
    const destination = join(root, "destination");
    const bytes = randomBytes(1024 * 1024 + 1903);
    const asset = createSource(source, bytes);

    await uploadCheckpointAssets(options(server.url, source, { token: a }), [
      asset,
    ]);
    expect(store.has("workspace", asset)).toBe(true);

    // stageCheckpointAssets creates a missing workspace asset directory.
    await stageCheckpointAssets(
      options(server.url, destination, { token: a }),
      [asset],
    );
    expect(readFileSync(join(destination, asset.id))).toEqual(bytes);
    expect(() => assertWorkspaceAssets(destination, [asset])).not.toThrow();

    let admitted = 0;
    await stageCheckpointAssets(
      options(server.url, destination, {
        token: a,
        admitBytes: () => {
          admitted++;
        },
      }),
      [asset],
    );
    expect(admitted).toBe(0);
    await uploadCheckpointAssets(
      options(server.url, source, {
        token: a,
        admitBytes: () => {
          admitted++;
        },
      }),
      [asset],
    );
    expect(admitted).toBe(0);
  });

  it("fails closed for missing sources, local mismatches, and admission refusal", async () => {
    const root = tempRoot("folio-workspace-blobs-preflight-");
    const store = new WorkspaceBlobStore(join(root, "server"));
    const a = token();
    const server = await startStoreServer(store, { workspace: a });
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });

    const missing = manifestFor(Buffer.from("absent"));
    await expect(
      uploadCheckpointAssets(options(server.url, source, { token: a }), [
        missing,
      ]),
    ).rejects.toMatchObject({ code: "asset-missing" });

    const bytes = randomBytes(32 * 1024);
    const asset = createSource(source, bytes);
    let admissions = 0;
    await expect(
      uploadCheckpointAssets(
        options(server.url, source, {
          token: a,
          admitBytes: () => {
            admissions++;
            throw new Error("capacity refused");
          },
        }),
        [asset],
      ),
    ).rejects.toThrow("capacity refused");
    expect(admissions).toBe(1);
    expect(store.has("workspace", asset)).toBe(false);

    const wrongLocal = manifestFor(bytes);
    const wrongBytes = Buffer.from(bytes);
    wrongBytes[0] ^= 0xff;
    writeFileSync(join(source, wrongLocal.id), wrongBytes);
    await expect(
      uploadCheckpointAssets(options(server.url, source, { token: a }), [
        wrongLocal,
      ]),
    ).rejects.toMatchObject({ code: "asset-hash-mismatch" });
    expect(store.has("workspace", wrongLocal)).toBe(false);

    const destination = join(root, "destination");
    mkdirSync(destination, { recursive: true });
    await expect(
      stageCheckpointAssets(options(server.url, destination, { token: a }), [
        asset,
      ]),
    ).rejects.toMatchObject({ code: "blob-not-found" });
    expect(existsSync(join(destination, asset.id))).toBe(false);

    // Preload the server, then prove both admission and immutable-ID refusal
    // leave an existing local file untouched.
    await uploadCheckpointAssets(options(server.url, source, { token: a }), [
      asset,
    ]);
    await expect(
      stageCheckpointAssets(
        options(server.url, destination, {
          token: a,
          admitBytes: () => {
            admissions++;
            throw new Error("capacity refused");
          },
        }),
        [asset],
      ),
    ).rejects.toThrow("capacity refused");
    expect(existsSync(join(destination, asset.id))).toBe(false);
    writeFileSync(join(destination, asset.id), Buffer.from("local original"));
    await expect(
      stageCheckpointAssets(options(server.url, destination, { token: a }), [
        asset,
      ]),
    ).rejects.toMatchObject({ code: "asset-id-hash-conflict" });
    expect(readFileSync(join(destination, asset.id))).toEqual(
      Buffer.from("local original"),
    );
    expect(
      readdirSync(destination).filter((name) => name.endsWith(".part")),
    ).toEqual([]);
  });

  it("rejects corrupted remote bytes without publishing a target", async () => {
    const root = tempRoot("folio-workspace-blobs-corrupt-");
    const destination = join(root, "destination");
    const bytes = randomBytes(3 * 1024 * 1024 + 7);
    const asset = manifestFor(bytes);
    const corrupt = Buffer.alloc(asset.bytes, 0x61);
    const server = await startCorruptGetter(asset, corrupt);
    let admitted = 0;

    await expect(
      stageCheckpointAssets(
        options(server.url, destination, {
          token: token(),
          admitBytes: (count) => {
            admitted += count;
          },
        }),
        [asset],
      ),
    ).rejects.toMatchObject({ code: "blob-hash-mismatch" });
    expect(admitted).toBe(asset.bytes);
    expect(existsSync(join(destination, asset.id))).toBe(false);
    expect(
      readdirSync(destination).filter((name) => name.endsWith(".part")),
    ).toEqual([]);
  });

  it("resumes an interrupted download at the exact staged byte offset", async () => {
    const root = tempRoot("folio-workspace-blobs-interrupt-");
    const destination = join(root, "destination");
    const bytes = randomBytes(2 * 1024 * 1024 + 511);
    const asset = manifestFor(bytes);
    const interrupted = await startInterruptedGetter(asset, bytes, 300_000);

    await stageCheckpointAssets(
      options(interrupted.url, destination, { token: token() }),
      [asset],
    );
    expect(readFileSync(join(destination, asset.id))).toEqual(bytes);
    expect(() => assertWorkspaceAssets(destination, [asset])).not.toThrow();
    expect(interrupted.ranges.length).toBeGreaterThanOrEqual(3);
    expect(interrupted.ranges[0]).toBe("bytes=0-1048575");
    const resumed = /^bytes=([0-9]+)-/.exec(interrupted.ranges[1]);
    expect(resumed).not.toBeNull();
    const offset = Number(resumed![1]);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(300_000);
  });

  it("retries a lost upload acknowledgement without re-reading a whole file", async () => {
    const root = tempRoot("folio-workspace-blobs-upload-retry-");
    const source = join(root, "source");
    const bytes = randomBytes(2 * 1024 * 1024 + 123);
    const asset = createSource(source, bytes);
    const server = await startDroppingUploadServer(asset, bytes);

    await uploadCheckpointAssets(
      options(server.url, source, { token: token() }),
      [asset],
    );
    expect(server.complete()).toBe(true);
    expect(server.received()).toEqual(bytes);
    expect(server.starts.slice(0, 2)).toEqual([0, 0]);
    expect(server.starts).toContain(1024 * 1024);
    expect(server.starts).toContain(2 * 1024 * 1024);
  });

  it("keeps workspace/token boundaries and validates manifests before any I/O", async () => {
    const root = tempRoot("folio-workspace-blobs-boundaries-");
    const store = new WorkspaceBlobStore(join(root, "server"));
    const a = token();
    const b = token();
    const server = await startStoreServer(store, {
      workspace: a,
      other: b,
    });
    const source = join(root, "source");
    const destination = join(root, "destination");
    const bytes = randomBytes(16 * 1024);
    const asset = createSource(source, bytes);
    await uploadCheckpointAssets(options(server.url, source, { token: a }), [
      asset,
    ]);

    await expect(
      stageCheckpointAssets(
        options(server.url, destination, {
          workspaceId: "other",
          token: a,
        }),
        [asset],
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      stageCheckpointAssets(
        options(server.url, destination, {
          workspaceId: "other",
          token: b,
        }),
        [asset],
      ),
    ).rejects.toMatchObject({ code: "blob-not-found" });
    await expect(
      uploadCheckpointAssets(
        options(server.url, source, {
          workspaceId: "other",
          token: a,
        }),
        [asset],
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(existsSync(join(destination, asset.id))).toBe(false);

    let admitted = 0;
    const tooLarge = {
      id: randomUUID(),
      sha256: "a".repeat(64),
      bytes: WORKSPACE_BLOB_MAX_BYTES + 1,
    };
    await expect(
      stageCheckpointAssets(
        options(server.url, destination, {
          token: a,
          admitBytes: () => {
            admitted++;
          },
        }),
        [tooLarge],
      ),
    ).rejects.toMatchObject({ code: "invalid-asset-size" });
    await expect(
      uploadCheckpointAssets(options(server.url, source, { token: a }), [
        { ...asset, id: "../escape" },
      ]),
    ).rejects.toMatchObject({ code: "invalid-asset-id" });
    expect(admitted).toBe(0);
  });

  it("falls back to a bounded GET probe when HEAD is not implemented", async () => {
    const root = tempRoot("folio-workspace-blobs-no-head-");
    const store = new WorkspaceBlobStore(join(root, "server"));
    const a = token();
    const server = await startStoreServer(
      store,
      { workspace: a },
      { rejectHead: true },
    );
    const source = join(root, "source");
    const destination = join(root, "destination");
    const bytes = randomBytes(128 * 1024);
    const asset = createSource(source, bytes);

    await uploadCheckpointAssets(options(server.url, source, { token: a }), [
      asset,
    ]);
    expect(store.has("workspace", asset)).toBe(true);
    await stageCheckpointAssets(
      options(server.url, destination, { token: a }),
      [asset],
    );
    expect(readFileSync(join(destination, asset.id))).toEqual(bytes);
  });

  it("transfers the full 20,000,000-byte attachment bound", async () => {
    const root = tempRoot("folio-workspace-blobs-max-");
    const store = new WorkspaceBlobStore(join(root, "server"));
    const a = token();
    const server = await startStoreServer(store, { workspace: a });
    const source = join(root, "source");
    const destination = join(root, "destination");
    const bytes = randomBytes(WORKSPACE_BLOB_MAX_BYTES);
    const asset = createSource(source, bytes);

    await uploadCheckpointAssets(
      options(server.url, source, { token: a, timeoutMs: 5_000 }),
      [asset],
    );
    expect(store.has("workspace", asset)).toBe(true);
    await stageCheckpointAssets(
      options(server.url, destination, { token: a, timeoutMs: 5_000 }),
      [asset],
    );
    const staged = readFileSync(join(destination, asset.id));
    expect(staged).toHaveLength(WORKSPACE_BLOB_MAX_BYTES);
    expect(staged.equals(bytes)).toBe(true);
    expect(() => assertWorkspaceAssets(destination, [asset])).not.toThrow();
  });

  it("revalidates type, hash, and duplicate manifest consistency before apply", () => {
    const root = tempRoot("folio-workspace-blobs-revalidate-");
    const directory = join(root, "assets");
    const bytes = randomBytes(4096);
    const asset = createSource(directory, bytes, ".png");
    expect(() => assertWorkspaceAssets(directory, [asset])).not.toThrow();

    rmSync(join(directory, asset.id));
    expect(() => assertWorkspaceAssets(directory, [asset])).toThrow(
      expect.objectContaining({ code: "asset-missing" }),
    );

    writeFileSync(join(directory, asset.id), Buffer.from("wrong"));
    expect(() => assertWorkspaceAssets(directory, [asset])).toThrow(
      expect.objectContaining({ code: "asset-size-mismatch" }),
    );

    writeFileSync(join(directory, asset.id), bytes);
    const replaced = join(root, "outside");
    writeFileSync(replaced, bytes);
    rmSync(join(directory, asset.id));
    symlinkSync(replaced, join(directory, asset.id));
    expect(() => assertWorkspaceAssets(directory, [asset])).toThrow(
      expect.objectContaining({ code: "asset-symlink" }),
    );

    expect(() =>
      assertWorkspaceAssets(directory, [
        asset,
        { ...asset, sha256: "b".repeat(64) },
      ]),
    ).toThrow(expect.objectContaining({ code: "asset-manifest-conflict" }));
  });
});
