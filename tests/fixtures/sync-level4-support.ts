/**
 * Lane D support code for the Level 4 independent sync verification.
 *
 * The integration modules owned by Codex (`src/sync/workspace-sync.ts` plus the
 * checkpoint validator and blob store) do not exist on the base commit.  They
 * are therefore loaded through esbuild into a private temporary bundle instead
 * of being imported statically.  The bundle is only built when every expected
 * file is present, so the ordinary baseline test run is not blocked by a
 * module that another lane still owns.
 *
 * All SQLite files, assets, server databases, journals and proxies live under
 * fresh mkdtemp directories.  The only network endpoint is 127.0.0.1.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

export const REPO_ROOT = resolve(process.cwd());
export const INTEGRATION_FILES = [
  "src/sync/workspace-sync.ts",
  "src/sync/workspace-checkpoint.ts",
  "src/sync/workspace-blobs.ts",
] as const;

export type Level4Status = {
  receivedCursor: number;
  appliedRevision: number;
  generation: number;
  cleanGeneration: number;
  pending: boolean;
  conflict: boolean;
};

export type Level4Conflict = {
  operation: {
    protocol: number;
    workspaceId: string;
    clientId: string;
    operationId: string;
    serverEpoch: string;
    baseRevision: number;
    checkpointHash: string;
    checkpoint: { payload?: any; [key: string]: unknown };
  };
  result: {
    status: "conflict";
    head: { revision: number; checkpointHash: string | null; checkpoint: any };
    [key: string]: unknown;
  };
};

export type Level4Sync = {
  syncOnce(): Promise<Level4Status>;
  status(): Level4Status;
  conflict(): Level4Conflict | null;
  resolveConflict(
    choice: "local" | "remote",
    expectedRevision: number,
  ): Promise<Level4Status>;
  writeEpoch(): number;
  assertWritable(epoch: number): void;
  close?(): void;
};

export type Level4Store = {
  path?: string;
  db: any;
  pages(options?: { quarantineCorrupt?: boolean }): any[];
  get(id: string): any;
  create(
    parentId: string | null,
    kind?: "page" | "database",
    title?: string,
    doc?: any,
  ): any;
  update(id: string, revision: number, patch: any): any;
  commitSave(input: any): any;
  commitPageOperation(input: any): any;
  trash(id: string): void;
  restore(id: string): void;
  versions(id: string): any[];
  transaction<T>(work: () => T): T;
  close(): void;
};

export type Level4Server = {
  url: string;
  serverEpoch: string;
  registerDevice(options: {
    workspaceId: string;
    ownerId: string;
    clientId: string;
    token: string;
  }): void | Promise<void>;
  revokeDevice(workspaceId: string, clientId: string): void | Promise<void>;
  close(): Promise<void>;
};

export type Level4Api = {
  openWorkspaceSync(options: {
    store: Level4Store;
    baseUrl: string;
    token: string;
    workspaceId: string;
    clientId: string;
    bindingId: string;
    mode?: "publish" | "join";
    canApply: () => boolean;
    timeoutMs?: number;
    admitBytes?: (bytes: number) => void;
  }): Promise<Level4Sync>;
  startCheckpointServer(options: {
    databasePath: string;
    capabilities: any[];
    workspaces: { workspaceId: string; ownerId: string }[];
    validateCheckpoint: (checkpoint: any, previous: any) => boolean;
    blobs?: unknown;
    host?: "127.0.0.1";
    port?: number;
  }): Promise<Level4Server>;
  validateWorkspaceCheckpoint(checkpoint: any, previous?: any): boolean;
  WorkspaceBlobStore: new (root: string) => unknown;
  Store: new (path: string, options?: any) => Level4Store;
  commitDatabaseOperation(store: Level4Store, operation: any): any;
  prepareDatabaseCreation(
    title: string,
    parentId: string | null,
    settings: any,
  ): any;
  readDatabaseSnapshot(store: Level4Store, databasePageId: string): any;
  RecordRepository: new (store: Level4Store) => any;
  RecordLifecycle: new (store: Level4Store) => any;
  attachFile(
    db: any,
    assets: string,
    file: string,
    beforeWrite?: (bytes: number) => void,
  ): any;
  resolveAsset(
    db: any,
    assets: string,
    url: string,
  ): { path: string; name: string; mime: string };
  emptyDatabase(): any;
};

const API_ENTRY = `
export { openWorkspaceSync } from "./src/sync/workspace-sync.ts";
export { startCheckpointServer } from "./src/sync/checkpoint-server.ts";
export { validateWorkspaceCheckpoint } from "./src/sync/workspace-checkpoint.ts";
export { WorkspaceBlobStore } from "./src/sync/workspace-blobs.ts";
export { Store } from "./src/persistence/store.ts";
export { commitDatabaseOperation, readDatabaseSnapshot } from "./src/persistence/database-operations.ts";
export { prepareDatabaseCreation } from "./src/shared/database-operation.ts";
export { RecordRepository } from "./src/persistence/record-repository.ts";
export { RecordLifecycle } from "./src/persistence/record-lifecycle.ts";
export { attachFile, resolveAsset } from "./src/persistence/assets.ts";
export { emptyDatabase } from "./src/shared/types.ts";
`;

const CHILD_ENTRY = `
import { runProductChild } from "./tests/fixtures/sync-level4-product-child.ts";
import * as sync from "./src/sync/workspace-sync.ts";
import { startCheckpointServer } from "./src/sync/checkpoint-server.ts";
import { validateWorkspaceCheckpoint } from "./src/sync/workspace-checkpoint.ts";
import { WorkspaceBlobStore } from "./src/sync/workspace-blobs.ts";
import { Store } from "./src/persistence/store.ts";
import { commitDatabaseOperation, readDatabaseSnapshot } from "./src/persistence/database-operations.ts";
import { prepareDatabaseCreation } from "./src/shared/database-operation.ts";
import { RecordRepository } from "./src/persistence/record-repository.ts";
import { RecordLifecycle } from "./src/persistence/record-lifecycle.ts";
import { attachFile, resolveAsset } from "./src/persistence/assets.ts";
import { emptyDatabase } from "./src/shared/types.ts";
const api = { openWorkspaceSync: sync.openWorkspaceSync, startCheckpointServer,
  validateWorkspaceCheckpoint, WorkspaceBlobStore, Store, commitDatabaseOperation,
  prepareDatabaseCreation, readDatabaseSnapshot, RecordRepository, RecordLifecycle,
  attachFile, resolveAsset, emptyDatabase };
runProductChild(api, process.argv[2]).catch((error) => {
  console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  process.exitCode = 1;
});
`;

const bundleDirs: string[] = [];
let apiPromise: Promise<Level4Api> | undefined;
let childBundle: string | undefined;
let transportBundle: string | undefined;

export function integrationFilesPresent(root = REPO_ROOT): boolean {
  return INTEGRATION_FILES.every((file) => existsSync(join(root, file)));
}

/** True when at least one frozen integration file exists but not necessarily all. */
export function integrationFilesStarted(root = REPO_ROOT): boolean {
  return INTEGRATION_FILES.some((file) => existsSync(join(root, file)));
}

function bundleDir(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-sync-l4-bundle-")),
  );
  bundleDirs.push(directory);
  return directory;
}

export function disposeBundles(): void {
  apiPromise = undefined;
  childBundle = undefined;
  transportBundle = undefined;
  for (const directory of bundleDirs.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort only: the directory is in the OS temporary directory.
    }
  }
}

function buildBundle(
  contents: string,
  sourcefile: string,
  outfile: string,
): void {
  buildSync({
    stdin: { contents, resolveDir: REPO_ROOT, sourcefile, loader: "ts" },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
}

/** Load the frozen Codex integration API only when all of its files exist. */
export function loadLevel4Api(): Promise<Level4Api> {
  if (!integrationFilesPresent()) {
    return Promise.reject(
      new Error("Level 4 integration modules are not present"),
    );
  }
  apiPromise ??= (async () => {
    const outfile = join(bundleDir(), "level4-api.mjs");
    buildBundle(API_ENTRY, "sync-level4-api-entry.ts", outfile);
    const module = (await import(pathToFileURL(outfile).href)) as any;
    return module as Level4Api;
  })().catch((error) => {
    apiPromise = undefined;
    throw error;
  });
  return apiPromise;
}

export function productChildBundle(): string {
  if (!integrationFilesPresent())
    throw new Error("Level 4 integration modules are not present");
  if (!childBundle) {
    childBundle = join(bundleDir(), "level4-product-child.mjs");
    buildBundle(CHILD_ENTRY, "sync-level4-product-child-entry.ts", childBundle);
  }
  return childBundle;
}

export function transportChildBundle(): string {
  if (!transportBundle) {
    transportBundle = join(bundleDir(), "level4-transport-child.mjs");
    buildSync({
      entryPoints: [
        join(REPO_ROOT, "tests/fixtures/sync-level4-transport-child.ts"),
      ],
      outfile: transportBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
  }
  return transportBundle;
}

export function tempRoot(prefix = "folio-sync-l4-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function workspace(root: string, name: string) {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const assets = join(directory, "assets");
  mkdirSync(assets);
  return {
    directory,
    database: join(directory, "workspace.sqlite"),
    assets,
  };
}

export function childEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: root,
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
  };
}

export function token(): string {
  return createHash("sha256")
    .update(randomUUID() + randomUUID())
    .digest("hex");
}

export function identifier(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

/** JSON with sorted keys; documents produced by different processes compare stably. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          sortValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

export function paragraphDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export function imageDoc(url: string, alt = "attachment") {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: alt }] },
      { type: "image", attrs: { src: url, alt } },
    ],
  };
}

export function docText(doc: any): string {
  const parts: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(doc);
  return parts.join("");
}

export function findPage(pages: any[], id: string): any {
  const page = pages.find((candidate) => candidate.id === id);
  if (!page)
    throw new Error(
      `page ${id} not found; present: ${pages.map((p) => p.id).join(",")}`,
    );
  return page;
}

export function findPageByTitle(pages: any[], title: string): any {
  const page = pages.find((candidate) => candidate.title === title);
  if (!page)
    throw new Error(
      `page titled ${title} not found; present: ${pages.map((p) => p.title).join(",")}`,
    );
  return page;
}

/** Read a page out of a frozen checkpoint payload without trusting the wire shape. */
export function checkpointPage(checkpoint: any, pageId: string): any {
  const rows = checkpoint?.payload?.tables?.pages;
  if (!Array.isArray(rows))
    throw new Error("checkpoint payload has no pages tuples");
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2 || row[0] !== pageId) continue;
    return typeof row[1] === "string" ? JSON.parse(row[1]) : row[1];
  }
  throw new Error(`page ${pageId} is absent from checkpoint`);
}

export function safeStatus(sync: Level4Sync): Level4Status | { error: string } {
  try {
    return sync.status();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Call syncOnce until both the local outbox and the received cursor settle. */
export async function drive(
  sync: Level4Sync,
  maxCalls = 24,
): Promise<Level4Status> {
  let previous = "";
  let status = sync.status();
  for (let index = 0; index < maxCalls; index++) {
    status = await sync.syncOnce();
    const key = JSON.stringify(status);
    if (status.conflict) return status;
    if (!status.pending && key === previous) return status;
    previous = key;
  }
  return status;
}

export type Level4ServerFixture = {
  server: Level4Server;
  root: string;
  serverDatabase: string;
  blobs: string;
  workspaceId: string;
  ownerId: string;
  devices: Map<string, { clientId: string; token: string }>;
};

export async function startLevel4Server(options: {
  api: Level4Api;
  root: string;
  workspaceId?: string;
  ownerId?: string;
  extraWorkspaces?: { workspaceId: string; ownerId: string }[];
}): Promise<Level4ServerFixture> {
  const workspaceId = options.workspaceId ?? identifier("ws");
  const ownerId = options.ownerId ?? identifier("owner");
  const serverDatabase = join(options.root, "server.sqlite");
  const blobs = join(options.root, "server-blobs");
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const server = await options.api.startCheckpointServer({
    databasePath: serverDatabase,
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }, ...(options.extraWorkspaces ?? [])],
    validateCheckpoint: options.api.validateWorkspaceCheckpoint,
    blobs: new options.api.WorkspaceBlobStore(blobs),
  });
  return {
    server,
    root: options.root,
    serverDatabase,
    blobs,
    workspaceId,
    ownerId,
    devices: new Map(),
  };
}

export async function registerDevice(
  fixture: Level4ServerFixture,
  label: string,
): Promise<{ clientId: string; token: string }> {
  const device = { clientId: identifier(`client-${label}`), token: token() };
  await fixture.server.registerDevice({
    workspaceId: fixture.workspaceId,
    ownerId: fixture.ownerId,
    clientId: device.clientId,
    token: device.token,
  });
  fixture.devices.set(label, device);
  return device;
}

/** Restart the same persistent server database and blob directory on a new port. */
export async function restartLevel4Server(
  fixture: Level4ServerFixture,
  api: Level4Api,
): Promise<Level4ServerFixture> {
  await fixture.server.close();
  const server = await api.startCheckpointServer({
    databasePath: fixture.serverDatabase,
    capabilities: [],
    workspaces: [
      { workspaceId: fixture.workspaceId, ownerId: fixture.ownerId },
    ],
    validateCheckpoint: api.validateWorkspaceCheckpoint,
    blobs: new api.WorkspaceBlobStore(fixture.blobs),
  });
  fixture.server = server;
  return fixture;
}

export async function rawHead(
  baseUrl: string,
  workspaceId: string,
  deviceToken: string,
): Promise<any> {
  const response = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/head`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`head ${response.status}: ${text}`);
  return JSON.parse(text);
}

export type FaultMode =
  | "drop-ack-after-commit"
  | "abort-next-request"
  | "stale-changes-replay"
  | "reorder-changes-once";

type CapturedResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

function filterRequestHeaders(
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

function filterResponseHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (
      [
        "connection",
        "content-length",
        "transfer-encoding",
        "keep-alive",
      ].includes(name)
    )
      continue;
    result[name] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return result;
}

/**
 * A child-local proxy.  It is the only peer the child talks to and it forwards
 * to the loopback fixture server.  It can drop an ACK only after the fixture
 * server has durably answered the commit, replay a stale change page, or
 * reorder a change revision.  It never changes host network settings.
 */
export class FaultProxy {
  readonly counts = {
    commitsForwarded: 0,
    ackDropped: 0,
    changesForwarded: 0,
    changesReplayed: 0,
    changesReordered: 0,
    aborted: 0,
  };
  private cachedChanges: CapturedResponse | undefined;
  private replayArmed = false;
  private target: URL;
  private sockets = new Set<import("node:net").Socket>();

  private constructor(
    readonly mode: FaultMode,
    target: string,
    private readonly server: Server,
    readonly url: string,
  ) {
    this.target = new URL(target);
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  static async start(target: string, mode: FaultMode): Promise<FaultProxy> {
    let proxy!: FaultProxy;
    const server = createServer((request, response) => {
      void proxy.handle(request, response).catch((error) => {
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: "proxy-failure", message: String(error) }),
          );
        } else {
          response.destroy();
        }
      });
    });
    const url = await new Promise<string>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          rejectPromise(new Error("proxy address unavailable"));
          return;
        }
        resolvePromise(`http://127.0.0.1:${address.port}`);
      });
    });
    proxy = new FaultProxy(mode, target, server, url);
    return proxy;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolvePromise) =>
      this.server.close(() => resolvePromise()),
    );
    this.server.closeAllConnections();
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          rejectPromise(new Error("proxy request too large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolvePromise(Buffer.concat(chunks)));
      request.on("error", rejectPromise);
    });
  }

  private forward(
    request: IncomingMessage,
    body: Buffer,
  ): Promise<CapturedResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
      const target = httpRequest(
        {
          protocol: this.target.protocol,
          hostname: this.target.hostname,
          port: this.target.port,
          method: request.method,
          path: request.url,
          headers: filterRequestHeaders(request.headers),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolvePromise({
              status: response.statusCode ?? 502,
              headers: filterResponseHeaders(response.headers),
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", rejectPromise);
        },
      );
      target.on("error", rejectPromise);
      target.end(body);
    });
  }

  private send(response: ServerResponse, captured: CapturedResponse): void {
    if (response.destroyed) return;
    response.writeHead(captured.status, {
      ...captured.headers,
      "content-length": String(captured.body.length),
    });
    response.end(captured.body);
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(request);
    const path = request.url ?? "/";
    const isCommit = request.method === "POST" && /\/commits$/.test(path);
    const isChanges = request.method === "GET" && /\/changes\?/.test(path);

    if (this.mode === "abort-next-request" && this.counts.aborted === 0) {
      this.counts.aborted++;
      request.destroy();
      response.destroy();
      return;
    }

    if (
      this.mode === "drop-ack-after-commit" &&
      isCommit &&
      this.counts.ackDropped === 0
    ) {
      const captured = await this.forward(request, body);
      this.counts.commitsForwarded++;
      if (captured.status >= 200 && captured.status < 300) {
        // The fixture server has persisted its receipt and head.  Drop the
        // response bytes and close the child's connection instead of relaying.
        this.counts.ackDropped++;
        request.destroy();
        response.destroy();
        return;
      }
      this.send(response, captured);
      return;
    }

    if (this.mode === "stale-changes-replay" && isChanges) {
      if (this.replayArmed && this.cachedChanges) {
        this.counts.changesReplayed++;
        this.send(response, this.cachedChanges);
        return;
      }
      const captured = await this.forward(request, body);
      this.counts.changesForwarded++;
      if (captured.status === 200) {
        try {
          const parsed = JSON.parse(captured.body.toString("utf8"));
          if (Array.isArray(parsed.changes) && parsed.changes.length > 0) {
            this.cachedChanges = captured;
            this.replayArmed = true;
          }
        } catch {
          // A malformed fixture response is still relayed unchanged.
        }
      }
      this.send(response, captured);
      return;
    }

    if (
      this.mode === "reorder-changes-once" &&
      isChanges &&
      this.counts.changesReordered === 0
    ) {
      const captured = await this.forward(request, body);
      this.counts.changesForwarded++;
      if (captured.status === 200) {
        try {
          const parsed = JSON.parse(captured.body.toString("utf8"));
          if (Array.isArray(parsed.changes) && parsed.changes.length === 1) {
            parsed.changes[0].revision += 1;
            this.counts.changesReordered++;
            this.send(response, {
              ...captured,
              body: Buffer.from(JSON.stringify(parsed)),
              headers: {
                ...captured.headers,
                "content-type": "application/json",
              },
            });
            return;
          }
        } catch {
          // Fall through to the real response.
        }
      }
      this.send(response, captured);
      return;
    }

    if (isCommit) this.counts.commitsForwarded++;
    if (isChanges) this.counts.changesForwarded++;
    this.send(response, await this.forward(request, body));
  }
}

export type ProductClientConfig = {
  databasePath: string;
  assetsPath: string;
  baseUrl: string;
  token: string;
  workspaceId: string;
  clientId: string;
  bindingId: string;
  canApply?: boolean;
  timeoutMs?: number;
  steps: any[];
  outputPath: string;
};

export type ProductChild = {
  child: ChildProcess;
  pid: number;
  outputPath: string;
  result: Promise<any>;
  stderr(): string;
  kill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        rejectPromise(new Error(`timed out waiting for ${path}`));
      }
    }, 20);
    timer.unref?.();
  });
}

export function spawnProductClient(
  configPath: string,
  options: { root: string; timeoutMs?: number } = { root: dirname(configPath) },
): ProductChild {
  const parsed = JSON.parse(
    readFileSync(configPath, "utf8"),
  ) as ProductClientConfig;
  const actualOutput = parsed.outputPath;
  const child = spawn(process.execPath, [productChildBundle(), configPath], {
    cwd: options.root,
    env: childEnv(options.root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("product child has no pid");
  const pid = child.pid;
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const result = new Promise<any>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`product child timed out\n${stderr}`));
    }, options.timeoutMs ?? 45_000);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      let output: any;
      try {
        output = JSON.parse(readFileSync(actualOutput, "utf8"));
      } catch {
        output = { ok: false, missingOutput: true, stdout, stderr };
      }
      output.exit = { code, signal };
      if (code === 0 || output.ok === false) resolvePromise(output);
      else
        rejectPromise(
          new Error(
            `product child exited code=${code} signal=${signal}\n${stdout}\n${stderr}\n${JSON.stringify(output)}`,
          ),
        );
    });
  });
  return {
    child,
    pid,
    outputPath: actualOutput,
    result,
    stderr: () => stderr,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolvePromise) =>
        child.once("exit", (code, signal) => resolvePromise({ code, signal })),
      );
      child.kill("SIGKILL");
      return exited;
    },
  };
}

export function writeProductConfig(
  root: string,
  label: string,
  config: Omit<ProductClientConfig, "outputPath">,
): string {
  const path = join(root, `${label}-${randomUUID()}.json`);
  const outputPath = join(root, `${label}-${randomUUID()}.out.json`);
  writeFileSync(path, JSON.stringify({ ...config, outputPath }), {
    mode: 0o600,
  });
  return path;
}

export async function runProductClient(
  root: string,
  label: string,
  config: Omit<ProductClientConfig, "outputPath">,
): Promise<any> {
  const path = writeProductConfig(root, label, config);
  const child = spawnProductClient(path, { root });
  const output = await child.result;
  if (output.exit?.signal === "SIGKILL")
    throw new Error(`child ${label} was killed unexpectedly`);
  return output;
}

export function expectOk(output: any): any {
  if (!output || output.ok !== true) {
    throw new Error(
      `child failed: ${JSON.stringify(output?.error ?? output)}\n${output?.stderr ?? ""}`,
    );
  }
  return output;
}

export type TransportClientConfig = {
  action: "push" | "push-pending" | "pull" | "pull-twice" | "hold" | "status";
  journalPath: string;
  workspaceId: string;
  clientId: string;
  bindingId: string;
  baseUrl: string;
  token: string;
  text?: string;
  baseRevision?: number;
  readyPath?: string;
};

export type TransportChild = {
  child: ChildProcess;
  pid: number;
  outputPath: string;
  result: Promise<any>;
  stderr(): string;
  kill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

export function spawnTransportClient(
  root: string,
  config: TransportClientConfig,
): TransportChild {
  const label = `transport-${randomUUID()}`;
  const configPath = join(root, `${label}.json`);
  const outputPath = join(root, `${label}.out.json`);
  writeFileSync(configPath, JSON.stringify({ ...config, outputPath }), {
    mode: 0o600,
  });
  const child = spawn(process.execPath, [transportChildBundle(), configPath], {
    cwd: root,
    env: childEnv(root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("transport child has no pid");
  const pid = child.pid;
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = new Promise<any>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`transport child timed out\n${stderr}`));
    }, 30_000);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      let output: any;
      try {
        output = JSON.parse(readFileSync(outputPath, "utf8"));
      } catch (error) {
        output = {
          ok: false,
          missingOutput: true,
          readError: error instanceof Error ? error.message : String(error),
          stderr,
        };
      }
      output.exit = { code, signal };
      resolvePromise(output);
    });
  });
  return {
    child,
    pid,
    outputPath,
    result,
    stderr: () => stderr,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolvePromise) =>
        child.once("exit", (code, signal) => resolvePromise({ code, signal })),
      );
      child.kill("SIGKILL");
      return exited;
    },
  };
}

export async function runTransportClient(
  root: string,
  config: TransportClientConfig,
): Promise<any> {
  return spawnTransportClient(root, config).result;
}
