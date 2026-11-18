import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
import { sha256 as hashText, SyncError } from "../src/sync/protocol";
import { inspectServerBlobRetention } from "../src/sync/server-blob-retention";
import { WorkspaceBlobStore } from "../src/sync/workspace-blobs";

type BlobAsset = { id: string; sha256: string; bytes: number };
type RunningBlobServer = {
  url: string;
  close(): Promise<void>;
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
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function assetFor(bytes: Buffer): BlobAsset {
  return {
    id: randomUUID(),
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

function workspaceDirectory(root: string, workspaceId: string): string {
  return join(root, "blobs", hashText(workspaceId));
}

function errorCodeOf(result: CallResult): string | undefined {
  try {
    const parsed = JSON.parse(result.body.toString()) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
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
): Promise<RunningBlobServer> {
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
        await store.handle(request, response, {
          workspaceId: match[1],
          sha256: match[2],
          assertAuthorized: () => {
            if (bearer(request) !== capabilities[match[1]])
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

function putFull(
  server: RunningBlobServer,
  workspaceId: string,
  asset: BlobAsset,
  bytes: Buffer,
  credential: string,
): Promise<CallResult> {
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

function putChunk(
  server: RunningBlobServer,
  workspaceId: string,
  asset: BlobAsset,
  bytes: Buffer,
  start: number,
  credential: string,
): Promise<CallResult> {
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

describe("WorkspaceBlobStore global admission", () => {
  it("enforces one root quota across workspaces during concurrent PUTs without overshoot", async () => {
    const root = tempRoot("folio-m3-blob-admission-global-");
    const maxBytes = 512 * 1024;
    const maxEntries = 16;
    const store = new WorkspaceBlobStore(join(root, "blobs"), {
      maxBytes,
      maxEntries,
    });
    const alphaToken = token();
    const betaToken = token();
    const server = await startBlobServer(store, {
      alpha: alphaToken,
      beta: betaToken,
    });
    const alphaBytes = randomBytes(300 * 1024);
    const betaBytes = randomBytes(300 * 1024);
    const alpha = assetFor(alphaBytes);
    const beta = assetFor(betaBytes);

    const alphaRequest = httpRequest(
      `${server.url}/v1/workspaces/alpha/blobs/${alpha.sha256}`,
      {
        method: "PUT",
        agent: false,
        headers: {
          Authorization: `Bearer ${alphaToken}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(alphaBytes.length),
        },
      },
    );
    const alphaResultPromise = new Promise<CallResult>((resolve, reject) => {
      alphaRequest.once("error", reject);
      alphaRequest.once("response", (response) => {
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
      });
    });
    try {
      alphaRequest.write(alphaBytes.subarray(0, 1024));
      await vi.waitFor(
        () =>
          expect(
            existsSync(
              join(
                workspaceDirectory(root, "alpha"),
                `.partial-${alpha.sha256}`,
              ),
            ),
          ).toBe(true),
        { timeout: 5_000 },
      );
      const betaResult = await putFull(
        server,
        "beta",
        beta,
        betaBytes,
        betaToken,
      );
      expect(betaResult.status).toBe(409);
      expect(errorCodeOf(betaResult)).toBe("blob-upload-in-progress");

      alphaRequest.end(alphaBytes.subarray(1024));
      const alphaResult = await alphaResultPromise;
      expect(alphaResult.status).toBe(201);
      expect(store.has("alpha", alpha)).toBe(true);
      expect(store.has("beta", beta)).toBe(false);
    } finally {
      alphaRequest.destroy();
      await alphaResultPromise.catch(() => {});
    }

    const canonicalBlobs = realpathSync(join(root, "blobs"));
    const admitted = inspectServerBlobRetention(canonicalBlobs, {
      maxBytes,
      maxEntries,
    });
    expect(admitted.held).toBe(false);
    expect(admitted.bytes).toBeLessThanOrEqual(maxBytes);
    expect(admitted.entries).toBeLessThanOrEqual(maxEntries);

    const retry = await putFull(server, "beta", beta, betaBytes, betaToken);
    expect(retry.status).toBe(409);
    expect(errorCodeOf(retry)).toBe("server-blob-retention-held");
    expect(store.has("beta", beta)).toBe(false);
    const afterRetry = inspectServerBlobRetention(canonicalBlobs, {
      maxBytes,
      maxEntries,
    });
    expect(afterRetry.bytes).toBeLessThanOrEqual(maxBytes);
    expect(afterRetry.entries).toBeLessThanOrEqual(maxEntries);
  });

  it("reserves only new resume bytes and keeps an owned partial inside maxEntries", async () => {
    const root = tempRoot("folio-m3-blob-admission-resume-");
    const maxBytes = 352 * 1024;
    const maxEntries = 1;
    const store = new WorkspaceBlobStore(join(root, "blobs"), {
      maxBytes,
      maxEntries,
    });
    const credential = token();
    const server = await startBlobServer(store, { resume: credential });
    const bytes = randomBytes(320 * 1024);
    const asset = assetFor(bytes);
    const firstEnd = 192 * 1024;
    const partialPath = join(
      workspaceDirectory(root, "resume"),
      `.partial-${asset.sha256}`,
    );

    const first = await putChunk(
      server,
      "resume",
      asset,
      bytes.subarray(0, firstEnd),
      0,
      credential,
    );
    expect(first.status).toBe(204);
    expect(statSync(partialPath).size).toBe(firstEnd);

    const replay = await putChunk(
      server,
      "resume",
      asset,
      bytes.subarray(0, firstEnd),
      0,
      credential,
    );
    expect(replay.status).toBe(204);
    expect(statSync(partialPath).size).toBe(firstEnd);

    const empty = assetFor(Buffer.alloc(0));
    const blockedNewFile = await putFull(
      server,
      "resume",
      empty,
      Buffer.alloc(0),
      credential,
    );
    expect(blockedNewFile.status).toBe(409);
    expect(errorCodeOf(blockedNewFile)).toBe("server-blob-retention-held");
    expect(store.has("resume", empty)).toBe(false);

    const last = await putChunk(
      server,
      "resume",
      asset,
      bytes.subarray(firstEnd),
      firstEnd,
      credential,
    );
    expect(last.status).toBe(201);
    expect(last.headers["x-folio-blob-complete"]).toBe("true");
    expect(store.has("resume", asset)).toBe(true);
    expect(
      readdirSync(workspaceDirectory(root, "resume")).filter((name) =>
        name.startsWith(".partial-"),
      ),
    ).toEqual([]);
    expect(
      (await callBlob(server, "GET", "resume", asset.sha256, credential)).body,
    ).toEqual(bytes);

    const blockedAfterPublish = await putFull(
      server,
      "resume",
      assetFor(Buffer.alloc(0)),
      Buffer.alloc(0),
      credential,
    );
    expect(blockedAfterPublish.status).toBe(409);
    expect(errorCodeOf(blockedAfterPublish)).toBe(
      "server-blob-retention-held",
    );
  });

  it("counts unknown and incomplete files toward quota admission", async () => {
    const root = tempRoot("folio-m3-blob-admission-unknown-");
    const maxBytes = 192 * 1024;
    const maxEntries = 8;
    const store = new WorkspaceBlobStore(join(root, "blobs"), {
      maxBytes,
      maxEntries,
    });
    const credential = token();
    const server = await startBlobServer(store, { counts: credential });
    const storedBytes = randomBytes(64 * 1024);
    const stored = assetFor(storedBytes);
    expect(
      (await putFull(server, "counts", stored, storedBytes, credential)).status,
    ).toBe(201);

    const directory = workspaceDirectory(root, "counts");
    writeFileSync(join(directory, "orphan-bytes"), Buffer.alloc(100 * 1024, 7));
    const incomplete = `.partial-${"a".repeat(64)}`;
    writeFileSync(join(directory, incomplete), Buffer.alloc(20 * 1024, 9));

    const inspection = inspectServerBlobRetention(
      realpathSync(join(root, "blobs")),
      { maxBytes, maxEntries },
    );
    expect(inspection.entries).toBe(2);
    expect(inspection.bytes).toBeGreaterThanOrEqual(
      storedBytes.length + 100 * 1024 + 20 * 1024,
    );
    expect(inspection.bytes).toBeLessThanOrEqual(maxBytes);

    const newBytes = randomBytes(16 * 1024);
    const newAsset = assetFor(newBytes);
    const held = await putFull(server, "counts", newAsset, newBytes, credential);
    expect(held.status).toBe(409);
    expect(errorCodeOf(held)).toBe("server-blob-retention-held");
    expect(store.has("counts", newAsset)).toBe(false);
    expect(store.has("counts", stored)).toBe(true);
  });

  it("holds unsafe hard-linked partials and symlinked finals without overwriting", async () => {
    const root = tempRoot("folio-m3-blob-admission-unsafe-");
    const store = new WorkspaceBlobStore(join(root, "blobs"));
    const credential = token();
    const server = await startBlobServer(store, {
      hard: credential,
      soft: credential,
    });

    const hardDirectory = workspaceDirectory(root, "hard");
    mkdirSync(hardDirectory, { recursive: true, mode: 0o700 });
    const owned = Buffer.from("already-owned-partial");
    const hardSha = hashText("hard-linked-partial");
    const partialPath = join(hardDirectory, `.partial-${hardSha}`);
    const aliasPath = join(hardDirectory, "partial-alias");
    writeFileSync(partialPath, owned, { mode: 0o600 });
    linkSync(partialPath, aliasPath);
    expect(lstatSync(partialPath).nlink).toBe(2);
    const hardResult = await callBlob(
      server,
      "PUT",
      "hard",
      hardSha,
      credential,
      {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(owned.length),
        "Content-Range": `bytes 0-${owned.length - 1}/${32 * 1024}`,
      },
      owned,
    );
    expect(hardResult.status).toBe(409);
    expect(errorCodeOf(hardResult)).toBe("unsafe-blob-path");
    expect(readFileSync(partialPath)).toEqual(owned);
    expect(readFileSync(aliasPath)).toEqual(owned);
    expect(lstatSync(partialPath).nlink).toBe(2);
    expect(statSync(partialPath).size).toBe(owned.length);

    const softBytes = randomBytes(8 * 1024);
    const softAsset = assetFor(softBytes);
    expect(
      (await putFull(server, "soft", softAsset, softBytes, credential)).status,
    ).toBe(201);
    const softDirectory = workspaceDirectory(root, "soft");
    const finalPath = join(softDirectory, softAsset.sha256);
    const outside = join(root, "outside-copy");
    writeFileSync(outside, softBytes);
    rmSync(finalPath);
    symlinkSync(outside, finalPath);
    expect(lstatSync(finalPath).isSymbolicLink()).toBe(true);

    const symlinked = await putFull(
      server,
      "soft",
      softAsset,
      softBytes,
      credential,
    );
    expect(symlinked.status).toBe(409);
    expect(errorCodeOf(symlinked)).toBe("server-blob-retention-unknown");
    expect(lstatSync(finalPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside)).toEqual(softBytes);
    expect(store.has("soft", softAsset)).toBe(false);
    expect(
      (await callBlob(server, "GET", "soft", softAsset.sha256, credential))
        .status,
    ).toBe(404);
  });

  it("serves existing valid blobs while quota growth is held", async () => {
    const root = tempRoot("folio-m3-blob-admission-serving-");
    const maxBytes = 192 * 1024;
    const maxEntries = 8;
    const store = new WorkspaceBlobStore(join(root, "blobs"), {
      maxBytes,
      maxEntries,
    });
    const credential = token();
    const server = await startBlobServer(store, { serving: credential });
    const storedBytes = randomBytes(64 * 1024);
    const stored = assetFor(storedBytes);
    expect(
      (await putFull(server, "serving", stored, storedBytes, credential)).status,
    ).toBe(201);
    writeFileSync(
      join(workspaceDirectory(root, "serving"), "growth-hold-bytes"),
      Buffer.alloc(120 * 1024, 3),
    );

    const growthBytes = randomBytes(16 * 1024);
    const growth = assetFor(growthBytes);
    const held = await putFull(server, "serving", growth, growthBytes, credential);
    expect(held.status).toBe(409);
    expect(errorCodeOf(held)).toBe("server-blob-retention-held");
    expect(store.has("serving", growth)).toBe(false);

    const head = await callBlob(
      server,
      "HEAD",
      "serving",
      stored.sha256,
      credential,
    );
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(storedBytes.length));
    expect(head.headers["x-folio-blob-sha256"]).toBe(stored.sha256);

    const get = await callBlob(
      server,
      "GET",
      "serving",
      stored.sha256,
      credential,
    );
    expect(get.status).toBe(200);
    expect(get.body).toEqual(storedBytes);

    const range = await callBlob(
      server,
      "GET",
      "serving",
      stored.sha256,
      credential,
      { Range: "bytes=10-19" },
    );
    expect(range.status).toBe(206);
    expect(range.body).toEqual(storedBytes.subarray(10, 20));

    expect(
      (await callBlob(server, "HEAD", "serving", growth.sha256, credential))
        .status,
    ).toBe(404);
    expect(
      (await callBlob(server, "GET", "serving", growth.sha256, credential))
        .status,
    ).toBe(404);
  });

  it("admits an upload after the root SQLite lock holder is SIGKILLed", async () => {
    const root = tempRoot("folio-m3-blob-admission-crash-");
    const blobs = join(root, "blobs");
    mkdirSync(blobs, { recursive: true, mode: 0o700 });
    chmodSync(blobs, 0o700);
    const lockPath = join(blobs, ".folio-upload-lock.sqlite");
    const script = `
      import { DatabaseSync } from "node:sqlite";
      const database = new DatabaseSync(${JSON.stringify(lockPath)});
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN EXCLUSIVE");
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `;
    let child: ChildProcess | undefined;
    try {
      child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error("lock holder timeout")),
          5_000,
        );
        child!.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("locked\n")) {
            clearTimeout(timeout);
            resolveReady();
          }
        });
        child!.once("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        child!.once("exit", (code) => {
          if (!output.includes("locked\n")) {
            clearTimeout(timeout);
            rejectReady(new Error(`lock holder exited early: ${code}`));
          }
        });
      });
      child.kill("SIGKILL");
      await once(child, "exit");
      child = undefined;

      const store = new WorkspaceBlobStore(blobs);
      const credential = token();
      const server = await startBlobServer(store, { crash: credential });
      const bytes = randomBytes(16 * 1024);
      const asset = assetFor(bytes);
      const put = await putFull(server, "crash", asset, bytes, credential);
      expect(put.status).toBe(201);
      expect(store.has("crash", asset)).toBe(true);
      expect(
        (await callBlob(server, "GET", "crash", asset.sha256, credential))
          .body,
      ).toEqual(bytes);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  }, 20_000);

  it("rejects non-private roots and enforces lower byte and entry caps", async () => {
    const root = tempRoot("folio-m3-blob-admission-limits-");
    const blobs = join(root, "blobs");
    mkdirSync(blobs, { recursive: true, mode: 0o755 });
    chmodSync(blobs, 0o755);
    const maxBytes = 16 * 1024;
    const maxEntries = 2;
    const store = new WorkspaceBlobStore(blobs, { maxBytes, maxEntries });
    const credential = token();
    const server = await startBlobServer(store, { limits: credential });
    const firstBytes = randomBytes(1024);
    const firstAsset = assetFor(firstBytes);

    const nonPrivate = await putFull(
      server,
      "limits",
      firstAsset,
      firstBytes,
      credential,
    );
    expect(nonPrivate.status).toBe(409);
    expect(errorCodeOf(nonPrivate)).toBe("server-blob-retention-unknown");
    expect(store.has("limits", firstAsset)).toBe(false);

    chmodSync(blobs, 0o700);
    expect(
      (await putFull(server, "limits", firstAsset, firstBytes, credential))
        .status,
    ).toBe(201);

    const largeBytes = randomBytes(20 * 1024);
    const large = assetFor(largeBytes);
    const largeResult = await putFull(
      server,
      "limits",
      large,
      largeBytes,
      credential,
    );
    expect(largeResult.status).toBe(409);
    expect(errorCodeOf(largeResult)).toBe("server-blob-retention-held");

    const secondBytes = randomBytes(4 * 1024);
    const second = assetFor(secondBytes);
    expect(
      (await putFull(server, "limits", second, secondBytes, credential)).status,
    ).toBe(201);

    const thirdBytes = randomBytes(1024);
    const third = assetFor(thirdBytes);
    const entryHeld = await putFull(
      server,
      "limits",
      third,
      thirdBytes,
      credential,
    );
    expect(entryHeld.status).toBe(409);
    expect(errorCodeOf(entryHeld)).toBe("server-blob-retention-held");
    expect(store.has("limits", third)).toBe(false);

    const invalidRoot = join(root, "blobs-invalid");
    mkdirSync(invalidRoot, { recursive: true, mode: 0o700 });
    chmodSync(invalidRoot, 0o700);
    const invalidStore = new WorkspaceBlobStore(invalidRoot, {
      maxBytes: 256 * 1024 * 1024 + 1,
    });
    const invalidServer = await startBlobServer(invalidStore, {
      limits: credential,
    });
    const invalidBytes = randomBytes(128);
    const invalid = await putFull(
      invalidServer,
      "limits",
      assetFor(invalidBytes),
      invalidBytes,
      credential,
    );
    expect(invalid.status).toBe(409);
    expect(errorCodeOf(invalid)).toBe("server-blob-retention-unknown");
  });
});
