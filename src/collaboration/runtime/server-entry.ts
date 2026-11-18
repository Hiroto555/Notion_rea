import { createWindowsOperatorNative, windowsOperatorConfigFromEnvironment } from "../../platform/windows/operator-native";
import { runRecoveryOperator } from "./recovery-operator";
import { runMaintenanceOperator } from "./maintenance-operator";
import { runRestoreOperator } from "./restore-operator";
import { createSharedOperatorContext, readSharedOperatorFile, type SharedOperatorPorts } from "./operator-files";
import { synchronousPort } from "../../platform/synchronous-port";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
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
import { writeNewFileDurably } from "../../persistence/durable-file";
import { sqliteHeader } from "../../persistence/sqlite-header";
import { documentSchema } from "../../shared/editor-schema";
import type { Doc } from "../../shared/types";
import { pinPrivateRoot, assertPrivateRoot } from "../../sync/m3-private-root";
import { SharedAuthority } from "./authority";
import { canonical } from "./canonical";
import { CollaborationError, identifier, wellFormed, type Cut } from "./contract";
import { digest } from "./digest";
import {
  ProductionRetentionHost,
  RetentionHostRegistry,
} from "./retention-host-environment";
import { createSharedRequestListener } from "./http-server";
import { HTTP_REQUEST_TIMEOUT_MS } from "./http-provider";
import { createSharedHttpsServer } from "./https-host";
import { DatabaseSync } from "node:sqlite";
import {
  RuntimeStore,
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
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

/** Optional platform seam for the Windows RuntimeStore boundary plus the
 * trusted in-process retention host used by `maintain` actions. Nothing else
 * is injectable: the server always uses the real SharedAuthority and real
 * HTTP or TLS host. Host registration is trusted owner configuration, never
 * a serialized CLI coverage flag. */
export type SharedServerPorts = Readonly<
  SharedOperatorPorts & {
    retentionHost?: RetentionHostRegistry;
    retentionHostFactory?: (authority: SharedAuthority) => Readonly<{
      host: RetentionHostRegistry;
      close(): void;
    }>;
  }
>;

/** Strict DISPOSABLE_OFFLINE_V1 host profile: a finite declared roster for a
 * known disposable offline host, never arbitrary UI coverage claims. All
 * fields except unaccountedStores are required; a serialized `clients`
 * section is intentionally absent — an offline profile has no live UI
 * history to declare, and real clients must register in-process instead. */
export type MaintenanceRetentionHostConfig = Readonly<{
  profile: "DISPOSABLE_OFFLINE_V1";
  /** Canonical absolute directory containing the authority runtime file. */
  sourceRoot: string;
  orgId: string;
  /** sha256(canonical(meta/genesis)) of the declared source. */
  sourceGenesisHash: string;
  expectedCut: Cut;
  runtimeStores: readonly Readonly<{
    id: string;
    /** RuntimeStore DIRECTORY containing the shared runtime file. */
    path: string;
    /** Required semantic role: client | resource-client | connection-cache. */
    role: string;
  }>[];
  retainedStores: readonly Readonly<{
    id: string;
    /** Existing opaque SQLite journal FILE path. */
    path: string;
    role: string;
    /** Exact retained identity.binding, when the journal has one. */
    binding?: string;
  }>[];
  unaccountedStores?: readonly string[];
}>;

const RETENTION_CONFIG_KEYS = [
  "expectedCut",
  "orgId",
  "profile",
  "retainedStores",
  "runtimeStores",
  "sourceGenesisHash",
  "sourceRoot",
  "unaccountedStores",
];
const RETENTION_REQUIRED_KEYS = [
  "expectedCut",
  "orgId",
  "profile",
  "retainedStores",
  "runtimeStores",
  "sourceGenesisHash",
  "sourceRoot",
];
const RUNTIME_STORE_ROLES = new Set([
  "client",
  "resource-client",
  "connection-cache",
]);
const MAX_RETENTION_CONFIG_BYTES = 64 * 1024;
const retentionConfigOrigins = new WeakMap<object, Readonly<{
  path: string;
  canonical: string;
  assertCurrent(): void;
}>>();

function configIdentifier(value: unknown): string {
  return identifier(value);
}

function configPathCheck(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !wellFormed(value)
  )
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  return value;
}

function configStoreList(
  value: unknown,
  roles: ReadonlySet<string> | null,
): readonly { id: string; path: string; role: string; binding?: string }[] {
  if (!Array.isArray(value) || value.length > 15)
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  return value.map((raw) => {
    const entry = raw as Record<string, unknown> | null;
    if (
      entry === null ||
      typeof entry !== "object" ||
      !["id,path,role", ...(roles === null ? ["binding,id,path,role"] : [])]
        .includes(Object.keys(entry).sort().join(","))
    )
      throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
    const role = entry.role;
    if (
      typeof role !== "string" ||
      (roles !== null && !roles.has(role)) ||
      !/^[a-z0-9-]{1,64}$/.test(role) ||
      (entry.binding !== undefined &&
        (typeof entry.binding !== "string" || entry.binding.length === 0 || entry.binding.length > 16_384))
    )
      throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
    return {
      id: configIdentifier(entry.id),
      path: configPathCheck(entry.path),
      role,
      ...(entry.binding === undefined ? {} : { binding: entry.binding as string }),
    };
  });
}

function configCut(value: unknown): Cut {
  const entry = value as Record<string, unknown> | null;
  if (
    entry === null ||
    typeof entry !== "object" ||
    Object.keys(entry).sort().join(",") !== "epoch,hash,seq" ||
    typeof entry.seq !== "number" ||
    !Number.isSafeInteger(entry.seq) ||
    entry.seq < 0 ||
    typeof entry.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.hash)
  )
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  return {
    epoch: configIdentifier(entry.epoch),
    seq: entry.seq,
    hash: entry.hash,
  } as Cut;
}

/** Strict schema validation shared by file read and direct object input;
 * the returned config is a detached canonical snapshot — never a mutable
 * caller alias. */
function parseRetentionHostConfig(
  value: unknown,
): MaintenanceRetentionHostConfig {
  const entry = value as Record<string, unknown> | null;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  const keys = Object.keys(entry).sort();
  for (const key of keys)
    if (!RETENTION_CONFIG_KEYS.includes(key))
      throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  for (const key of RETENTION_REQUIRED_KEYS)
    if (!keys.includes(key))
      throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  if (entry.profile !== "DISPOSABLE_OFFLINE_V1")
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  if (
    entry.unaccountedStores !== undefined &&
    (!Array.isArray(entry.unaccountedStores) || entry.unaccountedStores.length > 16)
  )
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  const genesis = entry.sourceGenesisHash;
  if (typeof genesis !== "string" || !/^[a-f0-9]{64}$/.test(genesis))
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  const runtimeStores = configStoreList(entry.runtimeStores, RUNTIME_STORE_ROLES);
  const retainedStores = configStoreList(entry.retainedStores, null);
  if (runtimeStores.length + retainedStores.length > 15)
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  const ids = ["authority", ...runtimeStores.map(({id}) => id), ...retainedStores.map(({id}) => id)];
  if (new Set(ids).size !== ids.length)
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  const config: MaintenanceRetentionHostConfig = {
    profile: "DISPOSABLE_OFFLINE_V1",
    sourceRoot: configPathCheck(entry.sourceRoot),
    orgId: configIdentifier(entry.orgId),
    sourceGenesisHash: genesis,
    expectedCut: configCut(entry.expectedCut),
    runtimeStores,
    retainedStores,
    ...(entry.unaccountedStores !== undefined
      ? {
          unaccountedStores: (entry.unaccountedStores as unknown[]).map(
            (id) => configIdentifier(id),
          ),
        }
      : {}),
  };
  return Object.freeze(
    JSON.parse(canonical(config, MAX_RETENTION_CONFIG_BYTES)),
  ) as MaintenanceRetentionHostConfig;
}

/** POSIX pinned private read: canonical parent pin, owner-only single-link
 * regular file, size preflight, O_NOFOLLOW open with fstat identity, then
 * the parent pin re-asserted after the read. */
function readPinnedPrivateFile(path: string, expected?: Stats): Buffer {
  const parent = pinPrivateRoot(dirname(path));
  if (!existsSync(path))
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  const stat = lstatSync(path);
  const uid =
    typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_RETENTION_CONFIG_BYTES ||
    (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino ||
      stat.mtimeMs !== expected.mtimeMs || stat.ctimeMs !== expected.ctimeMs))
  )
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== stat.size ||
      !opened.isFile() || opened.nlink !== 1 || opened.uid !== uid ||
      (opened.mode & 0o077) !== 0
    )
      throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
    const bytes = Buffer.alloc(MAX_RETENTION_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const read = readSync(fd, bytes, length, bytes.byteLength - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (length !== stat.size || after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
        named.dev !== stat.dev || named.ino !== stat.ino || named.nlink !== 1)
      throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
    assertPrivateRoot(parent);
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the trusted offline host profile from FOLIO_RETENTION_HOST_CONFIG
 * (or the given path). Absent configuration is NOT an error — the caller
 * keeps ports unchanged and retention actions fail with
 * RETENTION_HOST_REQUIRED. When a native private-files port is supplied it
 * performs the bounded private read; otherwise a POSIX pinned read is used
 * (a native platform with no port fails RETENTION_NATIVE_EVIDENCE_REQUIRED).
 * Non-canonical or malformed content always fails closed.
 */
export function readRetentionHostConfig(
  envPath?: string,
  ports?: SharedServerPorts,
): MaintenanceRetentionHostConfig | null {
  const path = envPath ?? process.env.FOLIO_RETENTION_HOST_CONFIG;
  if (path === undefined || path === "") return null;
  if (!isAbsolute(path))
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  let read: () => Buffer;
  if (ports?.privateFiles !== undefined) {
    const files = synchronousPort(ports.privateFiles, {
      readPrivateFile: { result: "buffer" },
    });
    read = () => files.readPrivateFile(path, MAX_RETENTION_CONFIG_BYTES);
  } else {
    if (process.platform === "win32")
      throw new CollaborationError("RETENTION_NATIVE_EVIDENCE_REQUIRED");
    const expected = lstatSync(path);
    read = () => readPinnedPrivateFile(path, expected);
  }
  const raw = read();
  if (raw.byteLength > MAX_RETENTION_CONFIG_BYTES)
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
  } catch {
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  }
  const config = parseRetentionHostConfig(parsed);
  if (canonical(config) !== raw.toString("utf8"))
    throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
  retentionConfigOrigins.set(config, {
    path: realpathSync(path),
    canonical: raw.toString("utf8"),
    assertCurrent: () => {
      if (!read().equals(raw))
        throw new CollaborationError("RETENTION_HOST_CONFIG_CHANGED");
    },
  });
  return config;
}

function noRetentionSidecars(file: string): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { lstatSync(file + suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
  }
}

/** Pin the actual existing source, not merely a caller's path string.
 * Native private reads preserve the factory's file-ID/ACL proof. */
function pinRetentionEvidenceFile(file: string, ports: SharedServerPorts): () => void {
  const files = ports.privateFiles === undefined ? undefined : synchronousPort(
    ports.privateFiles,
    { readPrivateFile: { result: "buffer" }, assertDirectory: { result: "string" } },
  );
  if (process.platform === "win32" && files === undefined)
    throw new CollaborationError("RETENTION_NATIVE_EVIDENCE_REQUIRED");
  const root = files ? undefined : pinPrivateRoot(dirname(file));
  const original = lstatSync(file);
  const assert = () => {
    if (files) {
      if (files.assertDirectory(dirname(file)) !== dirname(file))
        throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
      files.readPrivateFile(file, 8_000_000);
    } else {
      assertPrivateRoot(root!);
      const current = lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
          current.uid !== root!.uid || (current.mode & 0o077) !== 0 ||
          current.dev !== original.dev || current.ino !== original.ino)
        throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
    }
    noRetentionSidecars(file);
  };
  assert();
  return assert;
}

/** Read-only semantic-role proof on an EXISTING runtime file before the
 * RuntimeStore constructor runs — a wrong-role or missing store is rejected
 * without any pragma mutation or directory creation. */
function preflightRuntimeRole(file: string, role: string): void {
  const header = sqliteHeader(file);
  if (header?.applicationId !== SHARED_RUNTIME_APPLICATION_ID ||
      header.version !== SHARED_RUNTIME_VERSION)
    throw new CollaborationError("RETENTION_HOST_ROLE_MISMATCH");
  let db: DatabaseSync;
  let failure: unknown;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new CollaborationError("RETENTION_HOST_STORE_MISSING");
  }
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=0");
    const row = db
      .prepare(
        "SELECT raw FROM runtime_records WHERE namespace = ? AND key = ?",
      )
      .get("meta", "role");
    const raw = row === undefined ? undefined : (row as { raw: unknown }).raw;
    if (typeof raw !== "string" || raw !== canonical(role))
      throw new CollaborationError("RETENTION_HOST_ROLE_MISMATCH");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { db.close(); }
    catch (cleanup) {
      if (failure !== undefined)
        throw new AggregateError([failure, cleanup], "UNKNOWN: retained runtime preflight cleanup");
      throw cleanup;
    }
  }
}

export function createMaintenanceRetentionPorts(
  basePorts: SharedServerPorts,
  config: MaintenanceRetentionHostConfig | null,
): SharedServerPorts {
  if (
    config === null ||
    basePorts.retentionHost !== undefined ||
    basePorts.retentionHostFactory !== undefined
  )
    return basePorts;
  // Re-validate and detach: the declared profile is a canonical snapshot,
  // never a mutable caller alias.
  const declared = parseRetentionHostConfig(config);
  const origin = retentionConfigOrigins.get(config);
  if (origin !== undefined && canonical(declared) !== origin.canonical)
    throw new CollaborationError("RETENTION_HOST_CONFIG_CHANGED");
  return {
    ...basePorts,
    retentionHostFactory: (authority: SharedAuthority) => {
      origin?.assertCurrent();
      const context = createSharedOperatorContext(basePorts, "RETENTION_NATIVE_EVIDENCE_REQUIRED");
      // A native platform needs its trusted file port for the default
      // offline factory; there is no POSIX fallback pretending coverage.
      if (
        process.platform === "win32" &&
        basePorts.privateFiles === undefined
      )
        throw new CollaborationError("RETENTION_NATIVE_EVIDENCE_REQUIRED");
      // Source binding: canonical root directory, primary organization,
      // sha256(canonical(genesis)), and the exact expected authority cut.
      const sourceRoot = realpathSync(dirname(authority.store.path));
      if (
        realpathSync(declared.sourceRoot) !== sourceRoot ||
        declared.sourceRoot !== sourceRoot
      )
        throw new CollaborationError("RETENTION_HOST_SOURCE_CHANGED");
      if (authority.store.get("meta", "primary-org") !== declared.orgId)
        throw new CollaborationError("RETENTION_HOST_SOURCE_CHANGED");
      const genesis = authority.store.get("meta", "genesis");
      if (
        genesis === null ||
        createHash("sha256").update(canonical(genesis)).digest("hex") !==
          declared.sourceGenesisHash
      )
        throw new CollaborationError("RETENTION_HOST_SOURCE_CHANGED");
      if (canonical(authority.head()) !== canonical(declared.expectedCut))
        throw new CollaborationError("RETENTION_HOST_SOURCE_CHANGED");
      // The trusted config file must live outside the source and every
      // declared store directory once the source is known.
      if (origin !== undefined) {
        let file = origin.path;
        try {
          file = realpathSync(file);
        } catch {
          throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
        }
        const dirs = [
          declared.sourceRoot,
          ...declared.runtimeStores.map((entry) => entry.path),
          ...declared.retainedStores.map((entry) => dirname(entry.path)),
        ].map((dir) => {
          try {
            return realpathSync(dir);
          } catch {
            return dir;
          }
        });
        for (const dir of dirs)
          if (
            file === dir ||
            file.startsWith(dir + sep) ||
            dir.startsWith(file + sep)
          )
            throw new CollaborationError("RETENTION_HOST_CONFIG_INVALID");
      }
      const opened: RuntimeStore[] = [];
      const proofs: (() => void)[] = [];
      try {
        const host = new ProductionRetentionHost({
          authority,
          expectedServiceIds: [
            ...declared.runtimeStores.map((entry) => entry.id),
            ...declared.retainedStores.map((entry) => entry.id),
          ],
          unaccountedStores: declared.unaccountedStores ?? [],
        });
        for (const entry of declared.runtimeStores) {
          const file = join(entry.path, SHARED_RUNTIME_FILE);
          if (
            !existsSync(file) ||
            !lstatSync(file).isFile() ||
            lstatSync(file).isSymbolicLink()
          )
            throw new CollaborationError("RETENTION_HOST_STORE_MISSING");
          const assertOwned = pinRetentionEvidenceFile(file, basePorts);
          proofs.push(assertOwned);
          preflightRuntimeRole(file, entry.role);
          assertOwned();
          const store = new RuntimeStore(entry.path, {
            ...context.storeOptions(entry.path),
            ...(entry.role === "client" ? { requiredExistingRole: "client" as const } : {}),
          });
          opened.push(store);
          assertOwned();
          host.registerRuntimeStore(entry.id, store);
        }
        for (const entry of declared.retainedStores) {
          // A native file-ID/ACL proof alone does not prove which authority
          // a journal belongs to. Other native ledger layouts need their
          // actual owner's in-process factory/semantic binding proof.
          if (context.privateFiles !== undefined && entry.binding === undefined)
            throw new CollaborationError("RETENTION_NATIVE_EVIDENCE_REQUIRED");
          const assertOwned = pinRetentionEvidenceFile(entry.path, basePorts);
          proofs.push(assertOwned);
          host.registerRetainedSqlite(entry.id, {
            path: entry.path,
            role: entry.role,
            ...(entry.binding === undefined ? {} : { binding: entry.binding }),
            assertOwned,
          });
        }
        const registry = host.registry(authority);
        const checkRoster = registry.rosterCheck!;
        registry.rosterCheck = () => {
          checkRoster();
          origin?.assertCurrent();
          for (const proof of proofs) proof();
        };
        return {
          host: registry,
          close: () => {
            const failures: unknown[] = [];
            for (const store of [...opened].reverse())
              try {
                store.close();
              } catch (error) {
                failures.push(error);
              }
            if (failures.length > 0)
              throw new Error("UNKNOWN: retention host cleanup", {
                cause: new AggregateError(failures),
              });
          },
        };
      } catch (error) {
        const failures: unknown[] = [error];
        for (const store of [...opened].reverse())
          try {
            store.close();
          } catch (closeError) {
            failures.push(closeError);
          }
        throw failures.length === 1
          ? error
          : new Error("UNKNOWN: retention host cleanup", {
              cause: new AggregateError(failures),
            });
      }
    },
  };
}

function retentionPortsWithDefaults(
  ports: SharedServerPorts,
): SharedServerPorts {
  if (
    ports.retentionHost !== undefined ||
    ports.retentionHostFactory !== undefined
  )
    return ports;
  return createMaintenanceRetentionPorts(
    ports,
    readRetentionHostConfig(undefined, ports),
  );
}

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
  const context = createSharedOperatorContext(ports, "WINDOWS_BOOTSTRAP_OPERATOR_UNSUPPORTED");
  const files = context.privateFiles;
  let target: string;
  if (files) {
    // Preflight the external credential name before creating any authority.
    target = files.assertNewFile(absolutePath(value(parsed, "credentials-output")), [root]);
    if (optionalStat(root) === undefined) {
      const destination = files.assertNewDirectory(root, []);
      if (destination !== root) fail("UNSAFE_ROOT");
      files.createDirectory(root);
    } else if (files.assertDirectory(root) !== root) fail("UNSAFE_ROOT");
  } else {
    assertBootstrapRoot(root);
    target = assertCredentialTarget(root, value(parsed, "credentials-output"));
  }

  let authority: SharedAuthority;
  try {
    authority = new SharedAuthority(root, context.storeOptions(root));
  } catch (error) {
    return normalize(error, "BOOTSTRAP_FAILED");
  }

  let published = false, publicationAttempted = false;
  let expectedCredentials: string | undefined;
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
      context.bindPublicationSource(authority);
      expectedCredentials = JSON.stringify({token: issued.token, recoveryKey: issued.recoveryKey});
      if (files) {
        files.assertNewFile(target, [root]);
        publicationAttempted = true;
        files.publishNewFile(target, Buffer.from(expectedCredentials, "utf8"));
        if (readSharedOperatorFile(files, target, KEY_MAX_BYTES, "CREDENTIALS_PROOF_FAILED").toString("utf8") !== expectedCredentials)
          fail("CREDENTIALS_PROOF_FAILED");
      } else writeNewFileDurably(target, expectedCredentials, {mode: PRIVATE_FILE_MODE, syncParentDirectory: true});
      published = true;
    });
    if (files && readSharedOperatorFile(files, target, KEY_MAX_BYTES, "CREDENTIALS_PROOF_FAILED").toString("utf8") !== expectedCredentials)
      fail("CREDENTIALS_PROOF_FAILED");
  } catch (error) {
    const remains = optionalStat(target) !== undefined;
    try {
      authority.close();
    } catch {
      // The bootstrap outcome is already the error being reported.
    }
    if (!published && (error as NodeJS.ErrnoException).code === "EEXIST")
      return fail("CREDENTIALS_EXIST");
    if (published || publicationAttempted || remains) return fail("BOOTSTRAP_UNKNOWN");
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
  const context = createSharedOperatorContext(ports, "WINDOWS_SERVE_OPERATOR_UNSUPPORTED");
  const files = context.privateFiles;
  const requestedRoot = absolutePath(value(parsed, "root"));
  const root = files ? files.assertDirectory(requestedRoot) : assertServeRoot(requestedRoot);
  const host = value(parsed, "host");
  if (!isLoopbackHost(host)) fail("INVALID_HOST");
  const portNumber = port(value(parsed, "port"));
  const loopback = parsed.flags.has("loopback-http");

  let authority: SharedAuthority;
  try {
    authority = context.openAuthority(root, context.storeOptions(root, true));
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
      const material = (path: string, max: number) => files
        ? new TextDecoder("utf-8", {fatal: true}).decode(readSharedOperatorFile(files, absolutePath(path), max, "INVALID_TLS_FILE"))
        : readTlsMaterial(path, max);
      const keyText = material(value(parsed, "key"), KEY_MAX_BYTES);
      const certText = material(value(parsed, "cert"), CERT_MAX_BYTES);
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
    return runRecoveryOperator(args.slice(1), ports);
  if (args[0] === "maintain") {
    const actionIndex = args.indexOf("--action");
    const retentionAction =
      actionIndex !== -1 && args[actionIndex + 1]?.startsWith("retention-");
    return runMaintenanceOperator(
      args.slice(1),
      retentionAction ? retentionPortsWithDefaults(ports) : ports,
    );
  }
  if (args[0] === "restore")
    return runRestoreOperator(args.slice(1), ports);
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
  const nativeConfig = process.platform === "win32" ? windowsOperatorConfigFromEnvironment(process.env) : undefined;
  const native = nativeConfig ? createWindowsOperatorNative(nativeConfig, {enrollExistingSources: args[0] === "bootstrap" || process.env.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES === "1"}) : undefined;
  let handle: SharedServerHandle;
  try { handle = await runSharedServer(args, native?.ports); }
  catch (error) { try {native?.close();} catch (cleanup) {throw new AggregateError([error, cleanup], "Native operator cleanup failed");} throw error; }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {await handle.close();} finally {native?.close();}
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
