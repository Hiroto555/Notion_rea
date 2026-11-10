import { runRecoveryOperator } from "./recovery-operator";
import { runMaintenanceOperator } from "./maintenance-operator";
import { runRestoreOperator } from "./restore-operator";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { createServer, type Server } from "node:http";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { RuntimeStorePlatform } from "../../platform/runtime-store-platform";
import { writeNewFileDurably } from "../../persistence/durable-file";
import { sqliteHeader } from "../../persistence/sqlite-header";
import { documentSchema } from "../../shared/editor-schema";
import type { Doc } from "../../shared/types";
import { pinPrivateRoot } from "../../sync/m3-private-root";
import { SharedAuthority } from "./authority";
import { CollaborationError, identifier, wellFormed } from "./contract";
import { createSharedRequestListener } from "./http-server";
import { HTTP_REQUEST_TIMEOUT_MS } from "./http-provider";
import { createSharedHttpsServer } from "./https-host";
import {
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
  type RuntimeStoreOptions,
} from "./store";

const PRIVATE_FILE_MODE = 0o600;
const KEY_MAX_BYTES = 8 * 1024;
const CERT_MAX_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4_096;

const BOOTSTRAP_VALUES = [
  "root",
  "org",
  "user",
  "device",
  "workspace",
  "document",
  "credentials-output",
] as const;
const SERVE_VALUES = ["root", "host", "port"] as const;
const SERVE_OPTIONAL_VALUES = ["key", "cert"] as const;
const SERVE_FLAGS = ["loopback-http"] as const;

type Command = "bootstrap" | "serve";

type Parsed = {
  command: Command;
  values: Map<string, string>;
  flags: Set<string>;
};

/** Optional platform seam for the Windows RuntimeStore boundary. Nothing else
 * is injectable: the server always uses the real SharedAuthority and real HTTP
 * or TLS host. */
export type SharedServerPorts = Readonly<{
  platformAdapter?: RuntimeStorePlatform;
}>;

export type SharedServerHandle = Readonly<{
  state?: "restored" | "maintained" | "recovered";
  result?: unknown;
  url?: string;
  close(): Promise<void>;
}>;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function invalidArguments(): never {
  return fail("INVALID_ARGUMENT");
}

function normalize(error: unknown, fallback: string): never {
  if (error instanceof CollaborationError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(message))
    throw new CollaborationError(message);
  if (/m3-private-root-unsafe/i.test(message))
    throw new CollaborationError("UNSAFE_ROOT");
  if (/SQLite header/i.test(message))
    throw new CollaborationError("NOT_SHARED_RUNTIME_FORMAT");
  throw new CollaborationError(fallback);
}

function isCommand(value: string): value is Command {
  return value === "bootstrap" || value === "serve";
}

function parse(args: string[]): Parsed {
  if (!Array.isArray(args) || args.length === 0) invalidArguments();
  const command = args[0];
  if (!isCommand(command)) invalidArguments();
  const valueNames: readonly string[] =
    command === "bootstrap"
      ? BOOTSTRAP_VALUES
      : [...SERVE_VALUES, ...SERVE_OPTIONAL_VALUES];
  const flagNames: readonly string[] = command === "serve" ? SERVE_FLAGS : [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (
      typeof argument !== "string" ||
      argument.length === 0 ||
      argument.includes("\0") ||
      !argument.startsWith("--") ||
      argument === "--"
    )
      invalidArguments();
    const name = argument.slice(2);
    if (values.has(name) || flags.has(name)) invalidArguments();
    if (flagNames.includes(name)) {
      flags.add(name);
      continue;
    }
    if (!valueNames.includes(name)) invalidArguments();
    const value = args[++index];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      value.startsWith("--")
    )
      invalidArguments();
    values.set(name, value);
  }
  const required = command === "bootstrap" ? BOOTSTRAP_VALUES : SERVE_VALUES;
  for (const name of required) if (!values.has(name)) invalidArguments();
  if (command === "serve") {
    const hasKey = values.has("key");
    const hasCert = values.has("cert");
    const loopback = flags.has("loopback-http");
    if (hasKey !== hasCert) invalidArguments();
    if (loopback === (hasKey && hasCert)) invalidArguments();
  }
  return { command, values, flags };
}

function value(parsed: Parsed, name: string): string {
  const found = parsed.values.get(name);
  if (found === undefined) invalidArguments();
  return found;
}

function absolutePath(raw: string): string {
  if (
    raw.length === 0 ||
    raw.length > MAX_PATH_LENGTH ||
    raw.includes("\0") ||
    !isAbsolute(raw)
  )
    invalidArguments();
  return resolve(raw);
}

function id(raw: string): string {
  try {
    return identifier(raw);
  } catch {
    return invalidArguments();
  }
}

function isLoopbackHost(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every(
    (part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255,
  );
}

function port(raw: string): number {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(raw)) invalidArguments();
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535)
    invalidArguments();
  return parsed;
}

function inside(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const rest = relative(parent, candidate);
  return (
    rest !== "" &&
    rest !== ".." &&
    !rest.startsWith(".." + sep) &&
    !isAbsolute(rest)
  );
}

/** Resolve every existing ancestor so the comparison does not trust a path
 * that will be redirected by a symlink above a not-yet-created root. */
function canonicalCandidate(raw: string): string {
  const absolute = resolve(raw);
  const tail: string[] = [];
  let current = absolute;
  for (let depth = 0; depth < MAX_PATH_LENGTH; depth++) {
    try {
      const canonical = realpathSync(current);
      return tail.length === 0 ? canonical : join(canonical, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.push(basename(current));
      current = parent;
    }
  }
  return fail("INVALID_PATH");
}

function optionalStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function canonicalExistingDirectory(path: string, missingCode: string): string {
  const stat = optionalStat(path);
  if (stat === undefined) fail(missingCode);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("INVALID_ROOT");
  let canonical: string;
  try {
    canonical = realpathSync(path);
    pinPrivateRoot(canonical);
  } catch {
    return fail("UNSAFE_ROOT");
  }
  return canonical;
}

function assertBootstrapRoot(root: string): void {
  if (optionalStat(root) === undefined) return;
  canonicalExistingDirectory(root, "INVALID_ROOT");
}

function assertServeRoot(rawRoot: string): string {
  const root = absolutePath(rawRoot);
  const pinned = canonicalExistingDirectory(root, "ROOT_MISSING");
  const database = join(pinned, SHARED_RUNTIME_FILE);
  const dbStat = optionalStat(database);
  if (dbStat === undefined) fail("NOT_BOOTSTRAPPED");
  if (dbStat.isSymbolicLink() || !dbStat.isFile() || dbStat.nlink !== 1)
    fail("INVALID_ROOT");
  let header: ReturnType<typeof sqliteHeader> | undefined;
  try {
    header = sqliteHeader(database);
  } catch {
    return fail("NOT_SHARED_RUNTIME_FORMAT");
  }
  if (
    !header ||
    header.version !== SHARED_RUNTIME_VERSION ||
    header.applicationId !== SHARED_RUNTIME_APPLICATION_ID
  )
    fail("NOT_SHARED_RUNTIME_FORMAT");
  return pinned;
}

/** The credential file is a new, exclusive, private sibling of a private
 * parent directory outside the authority root. The preflight runs before the
 * authority is opened so an existing destination cannot destroy anything. */
function assertCredentialTarget(rawRoot: string, rawOutput: string): string {
  if (
    rawOutput.length === 0 ||
    rawOutput.length > MAX_PATH_LENGTH ||
    rawOutput.includes("\0") ||
    !isAbsolute(rawOutput)
  )
    invalidArguments();
  const root = canonicalCandidate(rawRoot);
  const output = canonicalCandidate(rawOutput);
  if (inside(root, output)) fail("CREDENTIALS_INSIDE_ROOT");
  const existing = optionalStat(output);
  if (existing !== undefined) fail("CREDENTIALS_EXIST");
  const name = basename(output);
  if (name === "" || name === "." || name === "..")
    return fail("INVALID_ARGUMENT");
  const parent = dirname(output);
  if (parent === output) fail("INVALID_ARGUMENT");
  let pinned: string | undefined;
  try {
    pinned = pinPrivateRoot(parent).path;
  } catch {
    return fail("UNSAFE_CREDENTIALS_PATH");
  }
  if (pinned === undefined) return fail("UNSAFE_CREDENTIALS_PATH");
  const target = join(pinned, name);
  if (inside(root, target)) fail("CREDENTIALS_INSIDE_ROOT");
  return target;
}

function seedDocument(): Doc {
  return documentSchema
    .nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: randomUUID() } }],
    })
    .toJSON() as Doc;
}

function storeOptions(ports: SharedServerPorts): RuntimeStoreOptions {
  return ports.platformAdapter === undefined
    ? {}
    : { platformAdapter: ports.platformAdapter };
}

async function bootstrapCommand(
  parsed: Parsed,
  ports: SharedServerPorts,
): Promise<SharedServerHandle> {
  const root = absolutePath(value(parsed, "root"));
  const orgId = id(value(parsed, "org"));
  const userId = id(value(parsed, "user"));
  const deviceId = id(value(parsed, "device"));
  const workspaceId = id(value(parsed, "workspace"));
  const documentId = id(value(parsed, "document"));
  assertBootstrapRoot(root);
  const target = assertCredentialTarget(
    root,
    value(parsed, "credentials-output"),
  );

  let authority: SharedAuthority;
  try {
    authority = new SharedAuthority(root, storeOptions(ports));
  } catch (error) {
    return normalize(error, "BOOTSTRAP_FAILED");
  }

  let published = false;
  try {
    authority.store.transaction(() => {
      const issued = authority.bootstrap({
        orgId,
        userId,
        deviceId,
        workspaceId,
        documentId,
        document: seedDocument(),
      });
      writeNewFileDurably(
        target,
        JSON.stringify({
          token: issued.token,
          recoveryKey: issued.recoveryKey,
        }),
        { mode: PRIVATE_FILE_MODE, syncParentDirectory: true },
      );
      published = true;
    });
  } catch (error) {
    const remains = optionalStat(target) !== undefined;
    try {
      authority.close();
    } catch {
      // The bootstrap outcome is already the error being reported.
    }
    if (!published && (error as NodeJS.ErrnoException).code === "EEXIST")
      return fail("CREDENTIALS_EXIST");
    if (published || remains) return fail("BOOTSTRAP_UNKNOWN");
    return normalize(error, "BOOTSTRAP_FAILED");
  }

  return {
    async close() {
      authority.close();
    },
  };
}

function readTlsMaterial(rawPath: string, maxBytes: number): string {
  const path = absolutePath(rawPath);
  const before = optionalStat(path);
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > maxBytes
  )
    return fail("INVALID_TLS_FILE");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    const opened = fstatSync(descriptor);
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size <= 0 ||
      opened.size > maxBytes
    )
      return fail("INVALID_TLS_FILE");
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (read <= 0) return fail("INVALID_TLS_FILE");
      offset += read;
    }
    const closed = fstatSync(descriptor);
    if (
      closed.size !== opened.size ||
      closed.dev !== opened.dev ||
      closed.ino !== opened.ino
    )
      return fail("INVALID_TLS_FILE");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      return fail("INVALID_TLS_FILE");
    }
    if (text.length === 0 || !wellFormed(text)) return fail("INVALID_TLS_FILE");
    return text;
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    return fail("INVALID_TLS_FILE");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The validated material has already been detached from the file.
      }
    }
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
    server.closeAllConnections();
  });
}

function listenLoopback(
  authority: SharedAuthority,
  host: string,
  portNumber: number,
): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer(createSharedRequestListener(authority));
    server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    const onError = () => {
      server.off("listening", onListening);
      rejectListen(new CollaborationError("SERVER_LISTEN_FAILED"));
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        void closeServer(server).finally(() =>
          rejectListen(new CollaborationError("INVALID_ADDRESS")),
        );
        return;
      }
      resolveListen({
        url: `http://${host}:${address.port}`,
        close: () => closeServer(server),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(portNumber, host);
  });
}

async function serveCommand(
  parsed: Parsed,
  ports: SharedServerPorts,
): Promise<SharedServerHandle> {
  const root = assertServeRoot(value(parsed, "root"));
  const host = value(parsed, "host");
  if (!isLoopbackHost(host)) fail("INVALID_HOST");
  const portNumber = port(value(parsed, "port"));
  const loopback = parsed.flags.has("loopback-http");

  let authority: SharedAuthority;
  try {
    authority = new SharedAuthority(root, storeOptions(ports));
  } catch (error) {
    return normalize(error, "SERVE_FAILED");
  }

  let bound: { url: string; close(): Promise<void> } | undefined;
  try {
    if (authority.store.get("meta", "primary-org") === null)
      fail("NOT_BOOTSTRAPPED");
    if (loopback) {
      bound = await listenLoopback(authority, host, portNumber);
    } else {
      const keyText = readTlsMaterial(value(parsed, "key"), KEY_MAX_BYTES);
      const certText = readTlsMaterial(value(parsed, "cert"), CERT_MAX_BYTES);
      const tls = createSharedHttpsServer(authority, {
        key: keyText,
        cert: certText,
        host,
        port: portNumber,
      });
      const listening = await tls.listen();
      bound = { url: listening.url, close: () => tls.close() };
    }
  } catch (error) {
    try {
      authority.close();
    } catch {
      // Keep the startup failure as the reported outcome.
    }
    return normalize(error, loopback ? "SERVE_FAILED" : "TLS_SERVE_FAILED");
  }

  if (bound === undefined) return fail("SERVE_FAILED");
  const active = bound;
  let closed = false;
  return {
    url: active.url,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await active.close();
      } finally {
        authority.close();
      }
    },
  };
}

/** Execute one CLI command. The returned handle owns any opened authority and
 * server; callers must close it. No process-wide signal handler is installed
 * here, and nothing is written to stdout or stderr. */
export async function runSharedServer(
  args: string[],
  ports: SharedServerPorts = {},
): Promise<SharedServerHandle> {
  if (args[0] === "recover")
    return runRecoveryOperator(args.slice(1), storeOptions(ports));
  if (args[0] === "maintain")
    return runMaintenanceOperator(args.slice(1), storeOptions(ports));
  if (args[0] === "restore")
    return runRestoreOperator(args.slice(1), storeOptions(ports));
  const parsed = parse(args);
  if (parsed.command === "bootstrap") return bootstrapCommand(parsed, ports);
  return serveCommand(parsed, ports);
}

function waitForSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolveSignal();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

/** Console entry used only by the bundled CJS launcher. Fixed output fields
 * ({state} for bootstrap, {state,url} for serve) never include secrets. */
export async function main(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  const handle = await runSharedServer(args);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  try {
    if (handle.url === undefined) {
      process.stdout.write(
        JSON.stringify({
          state: handle.state ?? "bootstrapped",
          ...(handle.result === undefined ? {} : { result: handle.result }),
        }) + "\n",
      );
      return;
    }
    process.stdout.write(
      JSON.stringify({ state: "ready", url: handle.url }) + "\n",
    );
    await waitForSignal();
  } finally {
    await close();
  }
}

function invokedAsCjsEntry(): boolean {
  try {
    return (
      typeof require === "function" &&
      typeof module !== "undefined" &&
      require.main === module
    );
  } catch {
    return false;
  }
}

if (invokedAsCjsEntry()) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof CollaborationError &&
      /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "INTERNAL_ERROR";
    process.stderr.write(JSON.stringify({ state: "error", code }) + "\n");
    process.exitCode = 1;
  });
}
