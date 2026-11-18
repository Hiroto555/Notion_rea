import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSyncService } from "../src/main/workspace-sync-service";
import { attachFile } from "../src/persistence/assets";
import { Store } from "../src/persistence/store";
import { CheckpointRemote } from "../src/sync/client";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { canonicalJson } from "../src/sync/protocol";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import {
  WORKSPACE_BLOB_CHUNK_BYTES,
  WorkspaceBlobStore,
} from "../src/sync/workspace-blobs";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

vi.setConfig({ testTimeout: 30_000 });

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Captured = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

class HoldProxy {
  readonly log: { method: string; path: string }[] = [];
  readonly counts = { heads: 0, gets: 0, puts: 0, commits: 0, lookups: 0 };
  holdFirstPut = false;
  holdFirstCommit = false;
  holdNextLookup = false;
  firstPutHeld = false;
  commitHeld = false;
  lookupHeld = false;
  private readonly putGate = deferred();
  private readonly commitGate = deferred();
  private readonly lookupGate = deferred();
  private readonly sockets = new Set<Socket>();
  private readonly target: URL;

  private constructor(
    private readonly server: Server,
    readonly url: string,
    target: string,
  ) {
    this.target = new URL(target);
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  static async start(target: string): Promise<HoldProxy> {
    let proxy!: HoldProxy;
    const server = createServer((request, response) => {
      void proxy.handle(request, response).catch((error) => {
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(502, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "proxy-failure" }));
        } else {
          response.destroy();
        }
        void error;
      });
    });
    const url = await new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("proxy-address-unavailable"));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    proxy = new HoldProxy(server, url, target);
    return proxy;
  }

  releaseFirstPut(): void {
    this.putGate.resolve();
  }

  releaseFirstCommit(): void {
    this.commitGate.resolve();
  }

  releaseLookup(): void {
    this.lookupGate.resolve();
  }

  async close(): Promise<void> {
    this.releaseFirstPut();
    this.releaseFirstCommit();
    this.releaseLookup();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          reject(new Error("proxy-request-too-large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });
  }

  private forward(
    request: IncomingMessage,
    body: Buffer,
  ): Promise<Captured> {
    return new Promise((resolve, reject) => {
      const target = httpRequest(
        {
          protocol: this.target.protocol,
          hostname: this.target.hostname,
          port: this.target.port,
          method: request.method,
          path: request.url,
          headers: this.requestHeaders(request.headers),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 502,
              headers: this.responseHeaders(response.headers),
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        },
      );
      target.on("error", reject);
      target.end(body);
    });
  }

  private requestHeaders(
    headers: IncomingMessage["headers"],
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (
        ["host", "connection", "content-length", "transfer-encoding"].includes(
          name,
        )
      )
        continue;
      result[name] = Array.isArray(value) ? value.join(",") : String(value);
    }
    return result;
  }

  private responseHeaders(
    headers: IncomingMessage["headers"],
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue;
      if (["connection", "transfer-encoding", "keep-alive"].includes(name))
        continue;
      result[name] = Array.isArray(value) ? value.join(",") : String(value);
    }
    return result;
  }

  private send(
    request: IncomingMessage,
    response: ServerResponse,
    captured: Captured,
  ): void {
    if (response.destroyed || response.writableEnded) return;
    const headers = { ...captured.headers };
    if (request.method === "HEAD") {
      // Preserve the target's Content-Length for a bodyless HEAD.
    } else if (captured.status === 204 || captured.status === 304) {
      delete headers["content-length"];
    } else {
      headers["content-length"] = String(captured.body.length);
    }
    response.writeHead(captured.status, headers);
    if (
      request.method === "HEAD" ||
      captured.status === 204 ||
      captured.status === 304
    ) {
      response.end();
      return;
    }
    response.end(captured.body);
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(request);
    const method = request.method ?? "";
    const path = request.url ?? "/";
    this.log.push({ method, path });
    const isLookup =
      method === "GET" && /\/operations\/[^/]+\/[^/?]+(?:\?|$)/.test(path);
    const isCommit = method === "POST" && /\/commits$/.test(path);
    if (method === "HEAD") this.counts.heads++;
    if (method === "GET") this.counts.gets++;
    if (method === "PUT") this.counts.puts++;
    if (isCommit) this.counts.commits++;
    if (isLookup) this.counts.lookups++;

    const captured = await this.forward(request, body);
    if (method === "PUT" && this.holdFirstPut && this.counts.puts === 1) {
      this.holdFirstPut = false;
      this.firstPutHeld = true;
      await this.putGate.promise;
    } else if (isCommit && this.holdFirstCommit && this.counts.commits === 1) {
      this.holdFirstCommit = false;
      this.commitHeld = true;
      await this.commitGate.promise;
    } else if (isLookup && this.holdNextLookup) {
      this.holdNextLookup = false;
      this.lookupHeld = true;
      await this.lookupGate.promise;
    }
    this.send(request, response, captured);
  }
}

type Device = {
  directory: string;
  store: Store;
  options: {
    store: Store;
    workspaceId: string;
    clientId: string;
    bindingId: string;
    token: string;
    baseUrl: string;
    canApply: () => boolean;
    timeoutMs: number;
  };
};

async function makeRig() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-m3-suspend-")));
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const blobs = join(root, "server-blobs");
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
    blobs: new WorkspaceBlobStore(blobs),
  });
  const stores: Store[] = [];
  let closed = false;
  return {
    root,
    workspaceId,
    blobs,
    serverUrl: server.url,
    device(name: string): Device {
      const directory = join(root, name);
      mkdirSync(directory);
      mkdirSync(join(directory, "assets"));
      const store = new Store(join(directory, "workspace.sqlite"));
      stores.push(store);
      const clientId = randomUUID();
      const bindingId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      server.registerDevice({ workspaceId, ownerId, clientId, token });
      return {
        directory,
        store,
        options: {
          store,
          workspaceId,
          clientId,
          bindingId,
          token,
          baseUrl: server.url,
          canApply: () => true,
          timeoutMs: 30_000,
        },
      };
    },
    async close() {
      if (!closed) {
        closed = true;
        await server.close();
      }
      for (const store of stores) {
        try {
          store.close();
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function seed(device: Device, root: string, name: string) {
  device.store.create(null, "page", name);
  const bytes = randomBytes(WORKSPACE_BLOB_CHUNK_BYTES + 4096);
  const file = join(root, `${name}.bin`);
  writeFileSync(file, bytes);
  const asset = attachFile(
    device.store.db,
    join(device.directory, "assets"),
    file,
  ) as { id: string; sha256: string; size: number };
  return { asset, bytes };
}

function outbox(device: Device) {
  return device.store.db
    .prepare(
      "SELECT operation_id, result_json FROM workspace_sync_outbox ORDER BY rowid",
    )
    .all() as { operation_id: string; result_json: string | null }[];
}

function workspaceBlobPath(blobs: string, workspaceId: string, name: string) {
  return join(blobs, sha256(workspaceId), name);
}

describe("WorkspaceSyncService per-request transfer suspension", () => {
  it("holds the first upload chunk, suspends, and sends no further request", async () => {
    const rig = await makeRig();
    let proxy: HoldProxy | undefined;
    let pass: Promise<unknown> | undefined;
    try {
      const device = rig.device("a");
      const { asset, bytes } = seed(device, rig.root, "upload");
      proxy = await HoldProxy.start(rig.serverUrl);
      proxy.holdFirstPut = true;
      const sync = await openWorkspaceSync({
        ...device.options,
        baseUrl: proxy.url,
        mode: "publish",
      });
      const originalSetTransferAllowed = sync.setTransferAllowed.bind(sync);
      let transferAllowed: (() => boolean) | undefined;
      const setTransferAllowed = vi
        .spyOn(sync, "setTransferAllowed")
        .mockImplementation((allowed) => {
          transferAllowed = allowed;
          originalSetTransferAllowed(allowed);
        });
      const service = new WorkspaceSyncService(sync);
      expect(setTransferAllowed).toHaveBeenCalledTimes(1);
      expect(transferAllowed?.()).toBe(true);

      pass = service.sync();
      await expect
        .poll(() => proxy!.firstPutHeld, { timeout: 15_000 })
        .toBe(true);

      const before = proxy.log.length;
      service.suspend();
      expect(transferAllowed?.()).toBe(false);
      expect(service.status()).toMatchObject({
        connection: "disconnected",
        running: true,
      });

      const partial = workspaceBlobPath(
        rig.blobs,
        rig.workspaceId,
        `.partial-${asset.sha256}`,
      );
      expect(existsSync(partial)).toBe(true);
      expect(statSync(partial).size).toBe(WORKSPACE_BLOB_CHUNK_BYTES);
      expect(existsSync(join(device.directory, ".folio-sync-transfers"))).toBe(
        true,
      );
      expect(outbox(device)).toHaveLength(1);
      expect(outbox(device)[0].result_json).toBeNull();

      proxy.releaseFirstPut();
      const result = await pass;
      expect(result).toMatchObject({
        connection: "disconnected",
        running: false,
        lastError: "sync-disabled",
      });
      expect(proxy.log.slice(before)).toEqual([]);
      expect(proxy.counts.puts).toBe(1);
      expect(proxy.counts.commits).toBe(0);

      expect(existsSync(partial)).toBe(true);
      expect(statSync(partial).size).toBe(WORKSPACE_BLOB_CHUNK_BYTES);
      expect(outbox(device)).toHaveLength(1);
      expect(outbox(device)[0].result_json).toBeNull();
      expect(sync.status().pending).toBe(true);
      expect(sync.status().appliedRevision).toBe(0);
      expect(
        readFileSync(join(device.directory, "assets", asset.id)),
      ).toEqual(bytes);
    } finally {
      await proxy?.close();
      pass?.catch(() => {});
      await rig.close();
    }
  });

  it("holds a receipt lookup before its 404 ACK and starts no upload or commit after suspension", async () => {
    const rig = await makeRig();
    let proxy: HoldProxy | undefined;
    let pass: Promise<unknown> | undefined;
    try {
      const device = rig.device("a");
      const { asset, bytes } = seed(device, rig.root, "lookup");
      proxy = await HoldProxy.start(rig.serverUrl);
      const sync = await openWorkspaceSync({
        ...device.options,
        baseUrl: proxy.url,
        mode: "publish",
      });
      const service = new WorkspaceSyncService(sync);

      proxy.holdNextLookup = true;
      pass = service.sync();
      await expect
        .poll(() => proxy!.lookupHeld, { timeout: 15_000 })
        .toBe(true);

      const before = proxy.log.length;
      service.suspend();
      proxy.releaseLookup();
      const result = await pass;
      expect(result).toMatchObject({
        connection: "disconnected",
        running: false,
        lastError: "sync-disabled",
      });
      expect(proxy.log.slice(before)).toEqual([]);
      expect(proxy.counts.puts).toBe(0);
      expect(proxy.counts.commits).toBe(0);
      expect(
        proxy.log.some((entry) => entry.path.includes("/changes")),
      ).toBe(false);

      expect(outbox(device)).toHaveLength(1);
      expect(outbox(device)[0].result_json).toBeNull();
      expect(sync.status().pending).toBe(true);
      expect(sync.status().appliedRevision).toBe(0);
      expect(
        existsSync(
          workspaceBlobPath(
            rig.blobs,
            rig.workspaceId,
            `.partial-${asset.sha256}`,
          ),
        ),
      ).toBe(false);
      expect(
        existsSync(
          workspaceBlobPath(rig.blobs, rig.workspaceId, asset.sha256),
        ),
      ).toBe(false);
      expect(
        readFileSync(join(device.directory, "assets", asset.id)),
      ).toEqual(bytes);
    } finally {
      await proxy?.close();
      pass?.catch(() => {});
      await rig.close();
    }
  });

  it("records an accepted in-flight commit receipt but starts no receive after suspension", async () => {
    const rig = await makeRig();
    let proxy: HoldProxy | undefined;
    let pass: Promise<unknown> | undefined;
    try {
      const device = rig.device("a");
      const { asset, bytes } = seed(device, rig.root, "commit");
      proxy = await HoldProxy.start(rig.serverUrl);
      const sync = await openWorkspaceSync({
        ...device.options,
        baseUrl: proxy.url,
        mode: "publish",
      });
      const service = new WorkspaceSyncService(sync);

      proxy.holdFirstCommit = true;
      pass = service.sync();
      await expect
        .poll(() => proxy!.commitHeld, { timeout: 20_000 })
        .toBe(true);

      const before = proxy.log.length;
      service.suspend();
      proxy.releaseFirstCommit();
      const result = await pass;
      expect(result).toMatchObject({
        connection: "disconnected",
        running: false,
        lastError: "sync-disabled",
      });
      expect(proxy.log.slice(before)).toEqual([]);
      expect(proxy.counts.commits).toBe(1);
      expect(
        proxy.log.some((entry) => entry.path.includes("/changes")),
      ).toBe(false);

      const rows = outbox(device);
      expect(rows).toHaveLength(1);
      expect(rows[0].result_json).not.toBeNull();
      const stored = JSON.parse(rows[0].result_json!) as {
        status: string;
        clientId: string;
        operationId: string;
        revision: number;
      };
      expect(stored).toMatchObject({
        status: "applied",
        clientId: device.options.clientId,
        operationId: rows[0].operation_id,
        revision: 1,
      });
      const remote = new CheckpointRemote({
        baseUrl: rig.serverUrl,
        workspaceId: rig.workspaceId,
        token: device.options.token,
      });
      const lookedUp = await remote.lookup(
        device.options.clientId,
        rows[0].operation_id,
      );
      expect(lookedUp).not.toBeNull();
      expect(canonicalJson(lookedUp)).toBe(rows[0].result_json);
      expect(sync.status()).toMatchObject({
        appliedRevision: 1,
        receivedCursor: 0,
        pending: false,
        conflict: false,
      });
      expect(
        existsSync(
          workspaceBlobPath(rig.blobs, rig.workspaceId, asset.sha256),
        ),
      ).toBe(true);
      expect(
        existsSync(
          workspaceBlobPath(
            rig.blobs,
            rig.workspaceId,
            `.partial-${asset.sha256}`,
          ),
        ),
      ).toBe(false);
      expect(
        readFileSync(join(device.directory, "assets", asset.id)),
      ).toEqual(bytes);
    } finally {
      await proxy?.close();
      pass?.catch(() => {});
      await rig.close();
    }
  });
});
