import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { canonicalJson } from "../src/sync/protocol";
import {
  WORKSPACE_BLOB_CHUNK_BYTES as CHUNK,
  uploadCheckpointAssets,
  stageCheckpointAssets,
} from "../src/sync/workspace-blobs";

vi.setConfig({ testTimeout: 30_000 });
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const roots: string[] = [],
  children = new Set<ChildProcess>(),
  servers = new Set<Server>();
let transferScript: string, serverScript: string;
function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "folio-m2-process-")));
  roots.push(path);
  return path;
}
afterAll(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
beforeAll(() => {
  const buildRoot = root();
  for (const name of ["m2-transfer-child", "m2-blob-server-child"]) {
    const outfile = join(buildRoot, name + ".mjs");
    buildSync({
      entryPoints: [resolve("tests/fixtures/" + name + ".ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "bundle",
      target: "node24",
    });
    if (name === "m2-transfer-child") transferScript = outfile;
    else serverScript = outfile;
  }
});
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "exit");
  child.kill("SIGKILL");
  await closed;
}
afterEach(async () => {
  for (const child of children) await kill(child);
  children.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  servers.clear();
  // Keep the compiled scripts for subsequent tests; each data root is fresh.
  while (roots.length > 1)
    rmSync(roots.pop()!, { recursive: true, force: true });
});
function child(script: string, variable: string, input: unknown) {
  const process = spawn(globalThis.process.execPath, [script], {
    env: { ...globalThis.process.env, [variable]: JSON.stringify(input) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(process);
  const messages: any[] = [];
  let stderr = "";
  process.on("message", (message) => messages.push(message));
  process.stderr!.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-8000);
  });
  return { process, messages, stderr: () => stderr };
}
async function waitMessage(
  run: ReturnType<typeof child>,
  match: (message: any) => boolean,
) {
  await expect
    .poll(() => run.messages.some(match), {
      timeout: 15_000,
      message: "Node child checkpoint: " + run.stderr(),
    })
    .toBe(true);
  return run.messages.find(match);
}
function options(path: string, baseUrl: string, direction: string) {
  const assetsDirectory = join(path, direction);
  mkdirSync(assetsDirectory);
  const scope = {
    baseUrlHash: hash(baseUrl),
    workspaceId: "workspace",
    clientId: "client",
    bindingId: "binding",
    serverEpoch: "epoch",
  };
  return {
    baseUrl,
    workspaceId: scope.workspaceId,
    token: randomBytes(32).toString("hex"),
    assetsDirectory,
    timeoutMs: 10_000,
    transfer: { directory: join(path, "transfers"), scope },
  };
}
async function listen(server: Server) {
  servers.add(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return `http://127.0.0.1:${address.port}`;
}

for (const corrupt of [false, true])
  it(`real client SIGKILL resumes durable download; corrupt=${corrupt}`, async () => {
    const path = root(),
      bytes = randomBytes(CHUNK * 2 + 337);
    const asset = {
      id: randomUUID() + ".bin",
      sha256: hash(bytes),
      bytes: bytes.length,
    };
    let hold = true,
      blocked = false;
    const ranges: number[] = [];
    const url = await listen(
      createServer((request, response) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range));
        if (!range) {
          response.writeHead(400);
          response.end();
          return;
        }
        const start = Number(range[1]),
          end = Number(range[2]);
        ranges.push(start);
        if (hold && start >= CHUNK) {
          blocked = true;
          return;
        }
        response.writeHead(206, {
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        });
        response.end(bytes.subarray(start, end + 1));
      }),
    );
    const opts = options(path, url, "download");
    const first = child(transferScript, "FOLIO_TEST_TRANSFER", {
      direction: "download",
      options: opts,
      asset,
    });
    await expect.poll(() => blocked, { timeout: 15_000 }).toBe(true);
    await kill(first.process);
    expect(first.process.signalCode).toBe("SIGKILL");
    expect(existsSync(join(opts.assetsDirectory, asset.id))).toBe(false);
    const directory = join(
      opts.transfer.directory,
      "download-" + hash(opts.assetsDirectory),
    );
    const journal = new BlobTransferJournal(directory, opts.transfer.scope);
    const record = journal.inventory()[0];
    expect(record.offset).toBe(CHUNK);
    journal.close();
    if (corrupt) {
      const partial = readFileSync(join(directory, record.partialName));
      partial[0] ^= 0xff;
      writeFileSync(join(directory, record.partialName), partial);
    }
    hold = false;
    ranges.length = 0;
    const second = child(transferScript, "FOLIO_TEST_TRANSFER", {
      direction: "download",
      options: opts,
      asset,
    });
    const result = await waitMessage(
      second,
      (message) => message.done || message.error,
    );
    if (corrupt) {
      expect(result.error).toBeTruthy();
      expect(result.done).toBeUndefined();
      expect(ranges).toEqual([]);
      expect(existsSync(join(opts.assetsDirectory, asset.id))).toBe(false);
      expect(existsSync(join(directory, record.partialName))).toBe(true);
    } else {
      expect(result).toEqual({ done: true });
      expect(ranges[0]).toBe(CHUNK);
      expect(readFileSync(join(opts.assetsDirectory, asset.id))).toEqual(bytes);
      expect(
        readdirSync(directory).filter((name) => name.endsWith(".part")),
      ).toEqual([]);
    }
  });

it("actual client and server process restarts resume upload from the durable server prefix", async () => {
  const path = root(),
    bytes = randomBytes(CHUNK * 2 + 71);
  const asset = {
    id: randomUUID() + ".bin",
    sha256: hash(bytes),
    bytes: bytes.length,
  };
  const config = {
    directory: join(path, "blobs"),
    workspaceId: "workspace",
    token: randomBytes(32).toString("hex"),
    sha256: asset.sha256,
  };
  const firstServer = child(serverScript, "FOLIO_TEST_SERVER", {
    ...config,
    pauseAt: CHUNK,
  });
  const port = (await waitMessage(firstServer, (message) => message.port)).port;
  const opts = {
    ...options(path, `http://127.0.0.1:${port}`, "upload"),
    token: config.token,
  };
  writeFileSync(join(opts.assetsDirectory, asset.id), bytes);
  const firstClient = child(transferScript, "FOLIO_TEST_TRANSFER", {
    direction: "upload",
    options: opts,
    asset,
  });
  await waitMessage(firstServer, (message) => message.blocked);
  await kill(firstClient.process);
  await kill(firstServer.process);
  const secondServer = child(serverScript, "FOLIO_TEST_SERVER", {
    ...config,
    port,
  });
  await waitMessage(secondServer, (message) => message.port === port);
  const secondClient = child(transferScript, "FOLIO_TEST_TRANSFER", {
    direction: "upload",
    options: opts,
    asset,
  });
  expect(
    await waitMessage(secondClient, (message) => message.done || message.error),
  ).toEqual({ done: true });
  expect(
    secondServer.messages.filter((message) => message.putStart !== undefined)[0]
      ?.putStart,
  ).toBe(CHUNK);
  expect(
    readFileSync(join(config.directory, hash("workspace"), asset.sha256)),
  ).toEqual(bytes);
});

it("an upload prefix mismatch cannot send a PUT or replace local bytes", async () => {
  const path = root(),
    bytes = randomBytes(100);
  let puts = 0;
  const url = await listen(
    createServer((request, response) => {
      if (request.method === "PUT") {
        puts++;
        response.writeHead(500);
        response.end();
        return;
      }
      if (request.headers["x-folio-blob-resume"] === "1")
        response.writeHead(204, {
          "X-Folio-Blob-Resume": "1",
          "X-Folio-Blob-Received": "50",
          "X-Folio-Blob-Prefix-Sha256": "0".repeat(64),
        });
      else response.writeHead(404);
      response.end();
    }),
  );
  const opts = options(path, url, "upload"),
    asset = {
      id: randomUUID() + ".bin",
      sha256: hash(bytes),
      bytes: bytes.length,
    };
  writeFileSync(join(opts.assetsDirectory, asset.id), bytes);
  await expect(uploadCheckpointAssets(opts, [asset])).rejects.toMatchObject({
    code: "blob-resume-mismatch",
  });
  expect(puts).toBe(0);
  expect(readFileSync(join(opts.assetsDirectory, asset.id)).equals(bytes)).toBe(
    true,
  );
});

it("exhausted durable quota refuses before GET instead of falling back to unrecorded transfer", async () => {
  const path = root();
  let gets = 0;
  const url = await listen(
    createServer((_request, response) => {
      gets++;
      response.writeHead(500);
      response.end();
    }),
  );
  const opts = options(path, url, "download"),
    directory = join(
      opts.transfer.directory,
      "download-" + hash(opts.assetsDirectory),
    );
  const journal = new BlobTransferJournal(directory, opts.transfer.scope);
  for (let index = 0; index < 6; index++)
    journal.begin({
      direction: "download",
      assetId: randomUUID() + ".bin",
      sha256: hash(String(index)),
      bytes: index === 5 ? 4_857_600 : 20_000_000,
    });
  journal.close();
  const asset = { id: randomUUID() + ".bin", sha256: hash("x"), bytes: 1 };
  await expect(stageCheckpointAssets(opts, [asset])).rejects.toBeDefined();
  expect(gets).toBe(0);
  expect(existsSync(join(opts.assetsDirectory, asset.id))).toBe(false);
});

it("old scopes count toward the workspace budget and cannot trigger an unrecorded download", async () => {
  const path = root();
  let requests = 0;
  const url = await listen(
    createServer((_request, response) => {
      requests++;
      response.writeHead(500);
      response.end();
    }),
  );
  const opts = options(path, url, "download");
  const cache = join(path, ".folio-sync-transfers");
  const legacy = join(cache, "old-epoch");
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  const retained = join(legacy, "unknown.part");
  writeFileSync(retained, "evidence");
  // Logical sparse bytes exercise the real default without writing 128MiB.
  truncateSync(retained, 128 * 1024 * 1024 + 1);
  const transfer = {
    ...opts.transfer,
    workspaceDirectory: path,
    directory: join(cache, hash(canonicalJson(opts.transfer.scope))),
  };
  const asset = { id: randomUUID() + ".bin", sha256: hash("x"), bytes: 1 };
  await expect(
    stageCheckpointAssets({ ...opts, transfer }, [asset]),
  ).rejects.toMatchObject({ code: "blob-transfer-budget-held" });
  expect(requests).toBe(0);
  expect(lstatSync(retained).size).toBe(128 * 1024 * 1024 + 1);
  expect(existsSync(join(opts.assetsDirectory, asset.id))).toBe(false);
});

it("admits remaining download bytes without double reserving retained cache bytes", async () => {
  const path = root(),
    bytes = randomBytes(20_000_000);
  const url = await listen(
    createServer((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range))!;
      const start = Number(match[1]),
        end = Number(match[2]);
      response.writeHead(206, {
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      });
      response.end(bytes.subarray(start, end + 1));
    }),
  );
  const opts = options(path, url, "download");
  const cache = join(path, ".folio-sync-transfers"),
    oldScope = join(cache, "old-epoch");
  mkdirSync(oldScope, { recursive: true, mode: 0o700 });
  const retained = join(oldScope, "unknown.part");
  writeFileSync(retained, "evidence");
  truncateSync(retained, 92 * 1024 * 1024);
  const transfer = {
    ...opts.transfer,
    workspaceDirectory: path,
    directory: join(cache, hash(canonicalJson(opts.transfer.scope))),
  };
  const asset = {
    id: randomUUID() + ".bin",
    sha256: hash(bytes),
    bytes: bytes.length,
  };
  await stageCheckpointAssets({ ...opts, transfer }, [asset]);
  expect(readFileSync(join(opts.assetsDirectory, asset.id)).equals(bytes)).toBe(
    true,
  );
  expect(lstatSync(retained).size).toBe(92 * 1024 * 1024);
});

it("canonicalizes a workspace reached through an ancestor alias without scope drift", async () => {
  const path = root(),
    workspace = join(path, "workspace");
  mkdirSync(workspace);
  const alias = join(path, "alias");
  symlinkSync(path, alias);
  const aliasedWorkspace = join(alias, "workspace");
  const opts = options(workspace, "http://127.0.0.1:1", "download");
  const scope = opts.transfer.scope;
  const transfer = {
    scope,
    workspaceDirectory: aliasedWorkspace,
    directory: join(
      aliasedWorkspace,
      ".folio-sync-transfers",
      hash(canonicalJson(scope)),
    ),
  };
  await expect(
    stageCheckpointAssets({ ...opts, transfer }, []),
  ).resolves.toBeUndefined();
  expect(
    existsSync(
      join(workspace, ".folio-sync-transfers", hash(canonicalJson(scope))),
    ),
  ).toBe(true);
});

for (const linked of [false, true])
  it(`recovers verified publication before cache inventory; linked=${linked}`, async () => {
    const path = root(),
      bytes = randomBytes(127);
    let requests = 0;
    const url = await listen(
      createServer((_request, response) => {
        requests++;
        response.writeHead(500);
        response.end();
      }),
    );
    const opts = options(path, url, "download");
    const directory = join(
      opts.transfer.directory,
      "download-" + hash(opts.assetsDirectory),
    );
    const asset = {
      id: randomUUID() + ".bin",
      sha256: hash(bytes),
      bytes: bytes.length,
    };
    const target = join(opts.assetsDirectory, asset.id);
    writeFileSync(target, bytes);
    const journal = new BlobTransferJournal(directory, opts.transfer.scope);
    const record = journal.begin({
      direction: "download",
      assetId: asset.id,
      sha256: asset.sha256,
      bytes: asset.bytes,
    });
    const offset = linked ? bytes.length : 59;
    journal.checkpoint(record.key, offset, hash(bytes.subarray(0, offset)));
    journal.close();
    const partial = join(directory, record.partialName);
    if (linked) linkSync(target, partial);
    else writeFileSync(partial, bytes.subarray(0, offset + 13));
    const pin = lstatSync(target);
    await stageCheckpointAssets(opts, [asset]);
    expect(requests).toBe(0);
    expect(readFileSync(target)).toEqual(bytes);
    expect(lstatSync(target).ino).toBe(pin.ino);
    expect(lstatSync(target).nlink).toBe(1);
    expect(existsSync(partial)).toBe(false);
    const reopened = new BlobTransferJournal(directory, opts.transfer.scope);
    expect(reopened.inventory()).toEqual([]);
    reopened.close();
  });

// Reproduce a server crash after all bytes are durable but before publication.
it("a complete server partial is finalized by re-sending only its final slice", async () => {
  const path = root(),
    bytes = randomBytes(CHUNK + 71);
  const asset = {
    id: randomUUID() + ".bin",
    sha256: hash(bytes),
    bytes: bytes.length,
  };
  const config = {
    directory: join(path, "blobs"),
    workspaceId: "workspace",
    token: randomBytes(32).toString("hex"),
    sha256: asset.sha256,
  };
  const workspace = join(config.directory, hash("workspace"));
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, ".partial-" + asset.sha256), bytes);
  const server = child(serverScript, "FOLIO_TEST_SERVER", config);
  const port = (await waitMessage(server, (message) => message.port)).port;
  const opts = {
    ...options(path, `http://127.0.0.1:${port}`, "upload"),
    token: config.token,
  };
  writeFileSync(join(opts.assetsDirectory, asset.id), bytes);
  await uploadCheckpointAssets(opts, [asset]);
  expect(
    server.messages.filter((message) => message.putStart !== undefined)[0]
      ?.putStart,
  ).toBe(CHUNK);
  expect(readFileSync(join(workspace, asset.sha256))).toEqual(bytes);
});
