import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { assertPrivateApplicationId, readUserVersion, validateV5WorkspaceSchema } from "../../persistence/schema-startup";
import { validateRecordStoreVersion } from "../../persistence/record-version";
import { createNativeAuthorityLeaseAcquirer, type PrivateAuthorityLease } from "./authority-lease";
import { createWindowsHotJournalSnapshot, type WindowsHotJournalSnapshotProfile,
  type WindowsHotJournalSnapshotReference, type WindowsHotJournalReleaseCapture } from "./hot-journal-snapshot";
import { windowsOperatorConfigFromEnvironment } from "./operator-native";
import type { WindowsOperatorConfig } from "./operator-native";
import { assertWindowsProbe, validateWindowsPath, type WindowsProbeEvidence } from "./path-policy";
import { acquireWindowsPrivateOwner, type WindowsPrivateOwner } from "./private-owner";
import { createWindowsProductNative, type WindowsProductNative } from "./product-native";
import { WindowsRuntimePlatform } from "./runtime-platform";
import { createWindowsSourceBindingGuard } from "./source-binding-guard";
import type { WindowsPrivateMaintenanceContext, WindowsPrivatePersistenceJournal,
  WindowsPrivatePersistenceMaintenanceProof } from "./private-persistence-journal";

export type { WindowsPrivateMaintenanceContext } from "./private-persistence-journal";
export type WindowsPrivateMaintenanceFamily = "checkpoint" | "raw-export" | "filesystem" | "transfer";
export type WindowsPrivateMaintenanceAuthority = WindowsPrivateMaintenanceContext & Readonly<{assertCurrent(): void}>;
/** Additive product factory hook. Implementations use the factory's existing
 * archive/journal instance and run authority.assertCurrent INSIDE their CAS. */
export type WindowsPrivateMaintenancePort = Readonly<{
  inspect(family: WindowsPrivateMaintenanceFamily, attemptId?: string): unknown;
  resolve(family: WindowsPrivateMaintenanceFamily, attemptId: string, fingerprint: string): unknown;
}>;
export type WindowsPrivateMaintenanceProductHook = Readonly<{
  maintenancePort(authority: WindowsPrivateMaintenanceAuthority): WindowsPrivateMaintenancePort;
}>;
export type PrivateSnapshotMaintenanceCommand = "snapshot-inspect" | "snapshot-release" |
  "snapshot-commit-release-evidence" | "snapshot-capture-inspect";
export type PrivateMaintenanceCommand = "inspect" | "resolve" | PrivateSnapshotMaintenanceCommand;
export type PrivateMaintenanceArguments = Readonly<{command: PrivateMaintenanceCommand; workspace: string; requestFile: string}>;
type ArchiveRequest = Readonly<{family: WindowsPrivateMaintenanceFamily; attemptId?: string; fingerprint?: string}>;
export type SnapshotRequest = Readonly<{
  path: string; profile: WindowsHotJournalSnapshotProfile; reference?: WindowsHotJournalSnapshotReference;
  archived?: boolean; fingerprint?: string; capture?: WindowsHotJournalReleaseCapture;
  captureId?: string;
}>;
export type PrivateMaintenanceSession = Readonly<{
  context: WindowsPrivateMaintenanceContext;
  assertCurrent(): void;
  maintenance: WindowsPrivateMaintenancePort;
  snapshot(command: PrivateSnapshotMaintenanceCommand, request: SnapshotRequest): unknown;
  close(): void;
}>;
// A release-evidence request may contain the H lifecycle wire (1 MiB) plus
// two 64 KiB pipes as base64. This is separate from every journal's value cap.
const MAX_REQUEST = 2 * 1024 * 1024, MAX_INLINE = 64 * 1024, MAX_OUTPUT = 8 * 1024 * 1024, MAX_SOURCE = 512 * 1024 * 1024;
const HELP = `Folio private maintenance (Windows Node CLI)
  inspect          --workspace DIRECTORY --request FILE
  resolve          --workspace DIRECTORY --request FILE
  snapshot-inspect --workspace DIRECTORY --request FILE
  snapshot-release --workspace DIRECTORY --request FILE
  snapshot-commit-release-evidence --workspace DIRECTORY --request FILE
  snapshot-capture-inspect --workspace DIRECTORY --request FILE

Archive request: {"family":"filesystem|checkpoint|raw-export|transfer","attemptId":"32 lower hex"}
resolve additionally requires the exact inspection "fingerprint".
Snapshot request: {"path":"absolute database path","profile":"small-ledger|recovery-archive|backup-artifact",
 "reference":{"attemptId":"32 lower hex","slot":0,"slotFileId":"32 hex","slotVolumeId":"16 hex"}}
snapshot-release additionally requires the exact inspection "fingerprint".
snapshot-commit-release-evidence requires "capture":{"request":"base64","response":"base64","stderr":"base64"}.
snapshot-capture-inspect requires "captureId":"32 lower hex"; it does not require a slot reference.
Snapshot profile and authority role must match the configured database basename.
Native executable/root/state pins come only from trusted installation environment.
The shared private-owner SQLite lock must be acquired; a closed-workspace declaration is not proof.
Missing native application evidence remains UNKNOWN_UNRESOLVABLE. No mutation replay or automatic deletion.
`;
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`WINDOWS_PRIVATE_MAINTENANCE_${code}`);
}
function sync(call: () => void): void {
  check(typeof call === "function" && !types.isAsyncFunction(call) && !types.isGeneratorFunction(call), "ASYNC");
  const value: unknown = call();
  if (types.isPromise(value)) Promise.prototype.then.call(value, undefined, () => undefined);
  check(value === undefined, "ACK");
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "REQUEST");
  const r = value as Record<string, unknown>;
  check(required.every(key => Object.hasOwn(r, key)) &&
    Object.keys(r).every(key => required.includes(key) || optional.includes(key)), "REQUEST");
  return r;
}
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function parsePrivateMaintenanceArguments(args: readonly string[]): PrivateMaintenanceArguments | "help" {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
  check(args.length === 5 && ["inspect", "resolve", "snapshot-inspect", "snapshot-release",
    "snapshot-commit-release-evidence", "snapshot-capture-inspect"].includes(args[0]), "ARGUMENTS");
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    check(["--workspace", "--request"].includes(args[i]) && !values.has(args[i]) &&
      typeof args[i + 1] === "string" && args[i + 1].length > 0 && !args[i + 1].includes("\0"), "ARGUMENTS");
    values.set(args[i], args[i + 1]);
  }
  check(values.has("--workspace") && values.has("--request"), "ARGUMENTS");
  return Object.freeze({command: args[0] as PrivateMaintenanceCommand,
    workspace: values.get("--workspace")!, requestFile: values.get("--request")!});
}
function parseRequest(command: PrivateMaintenanceCommand, value: unknown): ArchiveRequest | SnapshotRequest {
  if (command === "inspect" || command === "resolve") {
    const r = record(value, command === "resolve" ? ["family", "attemptId", "fingerprint"] : ["family"], ["attemptId"]);
    check(["checkpoint", "raw-export", "filesystem", "transfer"].includes(String(r.family)), "FAMILY");
    if (r.attemptId !== undefined) check(typeof r.attemptId === "string" && /^[a-f0-9]{32}$/.test(r.attemptId), "ATTEMPT");
    if (command === "resolve") check(typeof r.fingerprint === "string" && /^[a-f0-9]{64}$/.test(r.fingerprint), "FINGERPRINT");
    return r as ArchiveRequest;
  }
  const r = record(value, command === "snapshot-capture-inspect" ? ["path", "profile", "captureId"] : ["path", "profile", "reference"],
    command === "snapshot-commit-release-evidence" ? ["capture"] :
      command === "snapshot-capture-inspect" ? [] : ["archived", "fingerprint"]);
  check(typeof r.path === "string" && ["small-ledger", "recovery-archive", "backup-artifact"].includes(String(r.profile)), "SNAPSHOT");
  if (command === "snapshot-capture-inspect") {
    check(typeof r.captureId === "string" && /^[a-f0-9]{32}$/.test(r.captureId), "CAPTURE_ID");
  } else {
    const ref = record(r.reference, ["attemptId", "slot", "slotFileId", "slotVolumeId"]);
    check(typeof ref.attemptId === "string" && /^[a-f0-9]{32}$/.test(ref.attemptId) &&
      Number.isInteger(ref.slot) && Number(ref.slot) >= 0 && Number(ref.slot) < 4 &&
      typeof ref.slotFileId === "string" && /^[a-fA-F0-9]{32}$/.test(ref.slotFileId) &&
      typeof ref.slotVolumeId === "string" && /^[a-fA-F0-9]{16}$/.test(ref.slotVolumeId), "SNAPSHOT_REFERENCE");
  }
  if (command === "snapshot-commit-release-evidence") {
    const capture = record(r.capture, ["request", "response", "stderr"]);
    for (const name of ["request", "response", "stderr"]) {
      check(typeof capture[name] === "string", "CAPTURE");
      const b = Buffer.from(capture[name] as string, "base64");
      check(b.toString("base64") === capture[name] && b.length <= (name === "request" ? 1024 * 1024 : 64 * 1024), "CAPTURE");
    }
  }
  check(r.archived === undefined || typeof r.archived === "boolean", "SNAPSHOT");
  if (command === "snapshot-release") check(r.archived !== true && typeof r.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(r.fingerprint), "FINGERPRINT");
  return r as SnapshotRequest;
}
/** Exact bytes remain in the immutable archive. Output includes a digest and,
 * for small values, canonical base64. No misleading truncated byte string. */
function printable(value: unknown, depth = 0): unknown {
  check(depth <= 32, "OUTPUT_DEPTH");
  if (value instanceof Uint8Array) return {byteLength: value.length, sha256: hash(value),
    ...(value.length <= MAX_INLINE ? {base64: Buffer.from(value).toString("base64")} : {retainedInArchive: true})};
  if (Array.isArray(value)) { check(value.length <= 4096, "OUTPUT_ROWS"); return value.map(v => printable(v, depth + 1)); }
  if (value && typeof value === "object") {
    const entries = Object.entries(value); check(entries.length <= 4096, "OUTPUT_ROWS");
    return Object.fromEntries(entries.map(([key, v]) => [key, printable(v, depth + 1)]));
  }
  return value;
}
/** Installation-owned names select the role/profile. Request JSON cannot
 * reinterpret a state journal as a workspace source or enlarge its profile. */
export function privateMaintenanceSnapshotTarget(config: WindowsOperatorConfig, workspace: string, request: SnapshotRequest) {
  const stateRoles: Record<string, readonly [string, WindowsHotJournalSnapshotProfile]> = {
    "source-bindings.sqlite": ["windows-source-bindings", "small-ledger"],
    "publication-state.sqlite": ["windows-publication-v2", "small-ledger"],
    "windows-recovery-v3.sqlite": ["windows-recovery-v3", "recovery-archive"],
    "raw-export-v3.sqlite": ["windows-raw-export-v3", "recovery-archive"],
    "private-persistence-v1.sqlite": ["private-persistence-v1", "recovery-archive"],
    "private-transfer-v1.sqlite": ["append-v1", "recovery-archive"],
    "windows-backup-artifact-v1.sqlite": ["windows-backup-artifact-v1", "backup-artifact"],
  };
  const sourceRoles: Record<string, readonly [string, WindowsHotJournalSnapshotProfile]> = {
    "workspace.sqlite": ["workspace", "recovery-archive"],
    "shared-runtime.sqlite": ["shared-runtime", "small-ledger"],
    "private-owner.sqlite": ["folio-private-owner", "small-ledger"],
    "state.sqlite": ["blob-transfer", "small-ledger"],
    "transfer-outcomes.sqlite": ["blob-transfer-outcomes", "small-ledger"],
    "secrets.sqlite": ["secrets", "small-ledger"],
  };
  const name = win32.basename(request.path);
  const state = win32.dirname(request.path).toLowerCase() === config.publicationStateDirectory.toLowerCase();
  const root = state ? config.publicationStateRoot : config.root;
  const path = validateWindowsPath(request.path, root).canonical;
  const role = (state ? stateRoles : sourceRoles)[name];
  check(path === request.path && role !== undefined && role[1] === request.profile &&
    (state || path.toLowerCase().startsWith(workspace.toLowerCase().replace(/\\$/, "") + "\\")), "SNAPSHOT_ROLE");
  return {path, root, name, role: role[0], profile: role[1], state};
}
export function executePrivateMaintenance(
  command: PrivateMaintenanceCommand, requestValue: unknown, session: PrivateMaintenanceSession,
): unknown {
  const request = parseRequest(command, requestValue);
  sync(session.assertCurrent);
  let outcome: unknown;
  if (command === "inspect" || command === "resolve") {
    const r = request as ArchiveRequest;
    const method = command === "inspect" ? session.maintenance.inspect : session.maintenance.resolve;
    check(typeof method === "function" && !types.isAsyncFunction(method) && !types.isGeneratorFunction(method), "ASYNC");
    outcome = command === "inspect" ? session.maintenance.inspect(r.family, r.attemptId) :
      session.maintenance.resolve(r.family, r.attemptId!, r.fingerprint!);
  } else {
    check(typeof session.snapshot === "function" && !types.isAsyncFunction(session.snapshot) &&
      !types.isGeneratorFunction(session.snapshot), "ASYNC");
    outcome = session.snapshot(command, request as SnapshotRequest);
  }
  if (types.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
  check(!types.isPromise(outcome) && !(outcome && typeof (outcome as {then?: unknown}).then === "function"), "ASYNC");
  sync(session.assertCurrent);
  return {context: session.context, result: printable(outcome)};
}
/** Concrete K adapter reused by the parent's product maintenance hook. */
export function filesystemMaintenancePort(journal: WindowsPrivatePersistenceJournal,
  proof: WindowsPrivatePersistenceMaintenanceProof, authority: WindowsPrivateMaintenanceAuthority): WindowsPrivateMaintenancePort {
  const context: WindowsPrivateMaintenanceContext = {workspace: authority.workspace, workspaceId: authority.workspaceId,
    workspaceFingerprint: authority.workspaceFingerprint, writerId: authority.writerId, sessionId: authority.sessionId, osSid: authority.osSid};
  for (const method of ["assertCurrent", "directory", "file", "tree", "missing"] as const)
    check(typeof proof[method] === "function" && !types.isAsyncFunction(proof[method]) &&
      !types.isGeneratorFunction(proof[method]), "ASYNC");
  return Object.freeze({
    inspect(family: WindowsPrivateMaintenanceFamily, id?: string) {
      check(family === "filesystem", "FAMILY");
      sync(authority.assertCurrent);
      const result = id === undefined ? journal.listAttempts() : journal.inspect(id);
      sync(authority.assertCurrent); return result;
    },
    resolve(family: WindowsPrivateMaintenanceFamily, attemptId: string, fingerprint: string) {
      check(family === "filesystem", "FAMILY");
      sync(authority.assertCurrent);
      return journal.investigate({attemptId, fingerprint, context}, {...proof, assertCurrent(c: WindowsPrivateMaintenanceContext) {
        sync(authority.assertCurrent); sync(() => proof.assertCurrent(c)); sync(authority.assertCurrent);
      }});
    },
  });
}

// A close failure must keep the real DB, raw lease, owner and product alive.
const retainedSessions = new Set<object>();
export function openPrivateMaintenanceSession(workspaceValue: string, env: NodeJS.ProcessEnv): PrivateMaintenanceSession {
  check(process.platform === "win32", "PLATFORM");
  check(retainedSessions.size < 64, "CAPACITY");
  const config = windowsOperatorConfigFromEnvironment(env);
  check(config, "CONFIG_REQUIRED");
  const workspace = validateWindowsPath(workspaceValue, config.root).canonical;
  check(workspace === workspaceValue, "WORKSPACE_PATH");
  const stateRoot = validateWindowsPath(config.publicationStateRoot, config.publicationStateRoot).canonical;
  const rootKey = config.root.toLowerCase().replace(/\\$/, ""), stateKey = stateRoot.toLowerCase().replace(/\\$/, "");
  check(rootKey !== stateKey && !rootKey.startsWith(stateKey + "\\") && !stateKey.startsWith(rootKey + "\\"), "STATE_OVERLAP");
  validateWindowsPath(config.publicationStateDirectory, stateRoot);
  const databasePath = win32.join(workspace, "workspace.sqlite");
  let active = true, owner: WindowsPrivateOwner | undefined, db: DatabaseSync | undefined;
  let rawLease: PrivateAuthorityLease | undefined, sourceFence: (() => void) | undefined;
  const baseFence = () => check(active, "CLOSED");
  const product = createWindowsProductNative(config, {enrollExistingSources: false,
    assertCurrent() { baseFence(); owner?.assertCurrent(); sourceFence?.(); }});
  const runtime = new WindowsRuntimePlatform({...config, databaseName: "workspace.sqlite", snapshotProfile: "recovery-archive"});
  const bindings = createWindowsSourceBindingGuard(config, false);
  const snapshots = new Set<{close(): void}>();
  const holder = {product, runtime, bindings, get owner() {return owner;}, get db() {return db;}, get lease() {return rawLease;}, snapshots};
  retainedSessions.add(holder);
  const close = () => {
    if (!active) return;
    // Stop immediately on uncertain SQLite/lease cleanup; never release the
    // exclusion owner while a workspace connection might remain alive.
    if (db?.isOpen) sync(() => db!.close());
    check(!db || db.isOpen === false, "SQLITE_CLOSE_UNKNOWN");
    if (rawLease) sync(() => rawLease!.close());
    for (const snapshot of snapshots) { snapshot.close(); snapshots.delete(snapshot); }
    // Store/readonly source is closed before the shared owner. Product
    // authorities also close before releasing exclusion.
    product.close();
    bindings.close(); runtime.close();
    owner?.close();
    active = false; retainedSessions.delete(holder);
  };
  try {
    owner = acquireWindowsPrivateOwner(config, workspace, product.privateFilesystem,
      {enrollExistingSources: false, assertCurrent: baseFence});
    runtime.bind(workspace);
    const directory = runtime.validatedDirectoryIdentity(), file = runtime.validatedFileIdentity(databasePath);
    bindings.directory(directory); bindings.file(file);
    const nativeProof = () => {
      baseFence(); owner!.assertCurrent();
      bindings.directory(runtime.validatedDirectoryIdentity());
      bindings.file(runtime.validatedFileIdentity(databasePath));
      runtime.assertSidecars(databasePath);
    };
    rawLease = createNativeAuthorityLeaseAcquirer({...config, expectedRoot: {
      rootFileId: directory.rootFileId, volumeId: directory.rootVolumeId},
      identityFor(path) {
        check(path === databasePath, "DATABASE_PATH"); nativeProof();
        const d = runtime.validatedDirectoryIdentity(), f = runtime.validatedFileIdentity(path);
        return {directoryFileId: d.directoryFileId, directoryVolumeId: d.directoryVolumeId, fileId: f.fileId, volumeId: f.volumeId};
      }})(databasePath);
    nativeProof(); rawLease.assertHeld();
    db = new DatabaseSync(databasePath, {readOnly: true});
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
    assertPrivateApplicationId(db);
    const version = readUserVersion(db);
    check(version >= 3 && version <= 5, "WORKSPACE_SCHEMA");
    if (version === 4) validateRecordStoreVersion(db);
    if (version === 5) validateV5WorkspaceSchema(db);
    for (const [table, columns] of [["pages", ["id", "data", "body"]], ["settings", ["key", "value"]],
      ["versions", ["id", "pageId", "createdAt", "title", "doc"]], ["assets", ["id", "metadata"]]] as const) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all();
      check(columns.every(column => actual.some(row => row.name === column)), "WORKSPACE_SCHEMA");
    }
    const workspaceId = db.prepare("SELECT value FROM settings WHERE key='folio.recovery.workspaceId'").get()?.value;
    check(typeof workspaceId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(workspaceId), "WORKSPACE_ID");
    // This native helper proves the current process SID and exact workspace
    // file identity. The pin is independent installation config, never JSON.
    const sidProof = (): string => {
      const executable = lstatSync(config.probeExecutable);
      check(executable.isFile() && !executable.isSymbolicLink() && executable.nlink === 1 && executable.size <= 64 * 1024 * 1024 &&
        hash(readFileSync(config.probeExecutable)) === config.expectedHash, "HELPER_PIN");
      const result = spawnSync(config.probeExecutable, [databasePath, config.root], {shell: false, windowsHide: true,
        cwd: config.systemRoot, env: {SystemRoot: config.systemRoot, windir: config.systemRoot,
          TEMP: win32.join(config.systemRoot, "Temp"), TMP: win32.join(config.systemRoot, "Temp")},
        timeout: 15_000, maxBuffer: MAX_REQUEST, encoding: "utf8"});
      check(!result.error && result.status === 0 && result.signal === null && result.stderr === "" &&
        hash(readFileSync(config.probeExecutable)) === config.expectedHash, "SID_PROOF");
      const evidence: unknown = JSON.parse(result.stdout);
      assertWindowsProbe(evidence, {canonicalPath: databasePath, canonicalRoot: config.root});
      const p = evidence as WindowsProbeEvidence;
      check(p.fileId === file.fileId && p.volumeId === file.volumeId &&
        p.rootFileId === directory.rootFileId && p.rootVolumeId === directory.rootVolumeId, "SID_IDENTITY");
      return p.sid;
    };
    const sid = sidProof();
    const physicalFingerprint = (): string => {
      nativeProof(); rawLease!.assertHeld();
      const beforeVersion = db!.prepare("PRAGMA data_version").get()?.data_version;
      const parts: unknown[] = [];
      let total = 0;
      for (const suffix of ["", "-wal", "-journal"]) {
        const path = databasePath + suffix;
        let stat;
        try { stat = lstatSync(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && suffix !== "") { parts.push({suffix, absentHint: true}); continue; }
          throw error;
        }
        total += stat.size;
        check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && total <= MAX_SOURCE, "SOURCE_BOUND");
        const fd = openSync(path, "r"), digest = createHash("sha256");
        try {
          const buffer = Buffer.alloc(64 * 1024);
          let offset = 0;
          while (offset < stat.size) {
            const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
            check(n > 0, "SOURCE_CHANGED"); digest.update(buffer.subarray(0, n)); offset += n;
          }
          const after = fstatSync(fd);
          check(after.size === stat.size && after.ino === stat.ino && after.dev === stat.dev &&
            after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, "SOURCE_CHANGED");
          parts.push({suffix, size: stat.size, sha256: digest.digest("hex")});
        } finally { closeSync(fd); }
      }
      nativeProof(); rawLease!.assertHeld();
      check(db!.isOpen && !db!.isTransaction &&
        beforeVersion === db!.prepare("PRAGMA data_version").get()?.data_version, "SOURCE_CHANGED");
      return hash(JSON.stringify({directory, file, workspaceId, version, dataVersion: beforeVersion, parts}));
    };
    const fingerprint = physicalFingerprint();
    const dataVersion = db.prepare("PRAGMA data_version").get()?.data_version;
    const context = Object.freeze({workspace, workspaceId, workspaceFingerprint: fingerprint,
      writerId: owner.writerId, sessionId: owner.sessionId, osSid: sid});
    sourceFence = () => {
      nativeProof(); rawLease!.assertHeld();
      check(db!.isOpen && !db!.isTransaction && db!.prepare("PRAGMA data_version").get()?.data_version === dataVersion &&
        db!.prepare("SELECT value FROM settings WHERE key='folio.recovery.workspaceId'").get()?.value === workspaceId &&
        sidProof() === sid && physicalFingerprint() === fingerprint, "CURRENT_AUTHORITY_CHANGED");
    };
    sourceFence();
    product.bindWorkspace(workspace, workspaceId, sourceFence);
    const authority = Object.freeze({...context, assertCurrent: sourceFence});
    let maintenance: WindowsPrivateMaintenancePort | undefined;
    const getMaintenance = () => {
      if (maintenance) return maintenance;
      const hook = (product as WindowsProductNative & Partial<WindowsPrivateMaintenanceProductHook>).maintenancePort;
      check(typeof hook === "function" && !types.isAsyncFunction(hook) && !types.isGeneratorFunction(hook),
        "PRODUCTION_MAINTENANCE_HOOK_REQUIRED");
      maintenance = hook.call(product, authority);
      check(maintenance && typeof maintenance.inspect === "function" && typeof maintenance.resolve === "function", "HOOK");
      return maintenance;
    };
    return Object.freeze({context, assertCurrent: sourceFence,
      maintenance: {
        inspect: (family: WindowsPrivateMaintenanceFamily, id?: string) => getMaintenance().inspect(family, id),
        resolve: (family: WindowsPrivateMaintenanceFamily, id: string, fp: string) => getMaintenance().resolve(family, id, fp),
      },
      snapshot(command: PrivateSnapshotMaintenanceCommand, request: SnapshotRequest) {
        sourceFence!();
        const target = privateMaintenanceSnapshotTarget(config, workspace, request), {path} = target;
        const controllerRuntime = new WindowsRuntimePlatform({root: target.root, probeExecutable: config.probeExecutable,
          expectedHash: config.expectedHash, systemRoot: config.systemRoot, databaseName: target.name, snapshotProfile: target.profile});
        snapshots.add(controllerRuntime);
        controllerRuntime.bind(win32.dirname(path));
        const expectedDirectory = controllerRuntime.validatedDirectoryIdentity();
        if (target.state) bindings.stateDirectory(expectedDirectory); else bindings.directory(expectedDirectory);
        // Inspection/release may concern a source that no longer exists. Its
        // original association comes from retained bindings, not a missing-file
        // probe, request-supplied identity or a writable create/open operation.
        const expectedFile = bindings.retainedFile(path);
        const nativeRequest = {path, expectedDirectory, expectedFile, profile: target.profile};
        const current = () => {
          sourceFence!();
          const d = controllerRuntime.validatedDirectoryIdentity();
          if (target.state) bindings.stateDirectory(d); else bindings.directory(d);
          check(JSON.stringify(bindings.retainedFile(path)) === JSON.stringify(expectedFile), "SOURCE_BINDING_CHANGED");
        };
        let result: unknown;
        if (command === "snapshot-capture-inspect") {
          const directoryPath = win32.join(win32.dirname(path), `.folio-hot-capture-${request.captureId}`);
          const captureRuntime = new WindowsRuntimePlatform({root: target.root, probeExecutable: config.probeExecutable,
            expectedHash: config.expectedHash, systemRoot: config.systemRoot,
            expectedRoot: {rootFileId: expectedDirectory.rootFileId, volumeId: expectedDirectory.rootVolumeId}});
          snapshots.add(captureRuntime); captureRuntime.bind(directoryPath);
          const captureDirectory = captureRuntime.validatedDirectoryIdentity();
          const names = readdirSync(directoryPath);
          const allowed = ["intent.json", "ready.json", "output.json", "stdout.bin", "stderr.bin", "metadata.bin",
            ...Array.from({length: 16}, (_, i) => `wire-${String(i).padStart(2, "0")}.bin`)];
          check(names.length <= 22 && names.every(n => allowed.includes(n)), "CAPTURE_INVENTORY");
          const files: Record<string, Uint8Array> = {};
          for (const name of names) {
            current();
            const filePath = win32.join(directoryPath, name), before = captureRuntime.validatedPrivateFileIdentity(filePath);
            const stat = lstatSync(filePath);
            check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 64 * 1024, "CAPTURE_BOUND");
            const fd = openSync(filePath, "r");
            try {
              const opened = fstatSync(fd);
              check(opened.ino === stat.ino && opened.dev === stat.dev && opened.size === stat.size, "CAPTURE_CHANGED");
              const bytes = readFileSync(fd), after = fstatSync(fd);
              check(bytes.length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs &&
                after.ctimeMs === stat.ctimeMs &&
                JSON.stringify(captureRuntime.validatedPrivateFileIdentity(filePath)) === JSON.stringify(before), "CAPTURE_CHANGED");
              files[name] = bytes;
            } finally { closeSync(fd); }
          }
          check(files["intent.json"], "CAPTURE_INTENT");
          const intent = JSON.parse(Buffer.from(files["intent.json"]).toString("utf8"));
          const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
          check(intent.version === 1 && intent.operation === "capture-intent" && intent.path === path &&
            intent.root === target.root && intent.profile === target.profile && intent.captureId === request.captureId &&
            same(intent.captureFileId, captureDirectory.directoryFileId) && same(intent.fileId, expectedFile.fileId) &&
            same(intent.volumeId, expectedFile.volumeId) && same(intent.rootFileId, expectedDirectory.rootFileId) &&
            same(intent.rootVolumeId, expectedDirectory.rootVolumeId) &&
            same(intent.directoryFileId, expectedDirectory.directoryFileId) &&
            same(intent.directoryVolumeId, expectedDirectory.directoryVolumeId) &&
            Number.isSafeInteger(intent.wireByteLength) && intent.wireByteLength > 0 && intent.wireByteLength <= 1024 * 1024 &&
            /^[a-f0-9]{64}$/.test(intent.wireSha256), "CAPTURE_ASSOCIATION");
          const chunks = Array.from({length: Math.ceil(intent.wireByteLength / (64 * 1024))},
            (_, i) => files[`wire-${String(i).padStart(2, "0")}.bin`]);
          let complete = chunks.every(Boolean) && !!files["ready.json"] && !!files["output.json"];
          if (chunks.every(Boolean)) {
            const wire = Buffer.concat(chunks);
            check(wire.length === intent.wireByteLength && hash(wire) === intent.wireSha256, "CAPTURE_WIRE");
          }
          if (complete) {
            for (const manifest of ["ready.json", "output.json"]) {
              const body = JSON.parse(Buffer.from(files[manifest]).toString("utf8"));
              check(body.version === 1 && body.captureId === intent.captureId && body.captureFileId === intent.captureFileId &&
                body.wireByteLength === intent.wireByteLength && body.wireSha256 === intent.wireSha256, "CAPTURE_MANIFEST");
              if (manifest === "output.json") for (const part of ["stdout", "stderr", "metadata"]) {
                const bytes = files[`${part}.bin`];
                check(bytes && bytes.length === body[`${part}ByteLength`] && hash(bytes) === body[`${part}Sha256`], "CAPTURE_OUTPUT");
              }
            }
            const metadata = JSON.parse(Buffer.from(files["metadata.bin"]).toString("utf8"));
            if (metadata.complete === false) complete = false;
          }
          current();
          check(JSON.stringify(captureRuntime.validatedDirectoryIdentity()) === JSON.stringify(captureDirectory), "CAPTURE_CHANGED");
          result = {state: complete ? "CAPTURE_RETAINED" : "CAPTURE_INCOMPLETE", role: target.role,
            source: nativeRequest, captureDirectory, files};
          captureRuntime.close(); snapshots.delete(captureRuntime);
        } else {
          const controller = createWindowsHotJournalSnapshot({root: target.root, probeExecutable: config.probeExecutable,
            expectedHash: config.expectedHash, systemRoot: config.systemRoot, profile: target.profile});
          current();
          if (command === "snapshot-commit-release-evidence") {
            controller.commitReleaseEvidence(nativeRequest, request.reference!, request.capture!);
            current();
            result = {state: "RELEASE_EVIDENCE_COMMITTED", role: target.role, reference: request.reference,
              evidence: controller.inspectEvidence()};
          } else {
            const inspection = controller.inspectSnapshot(nativeRequest, request.reference!, request.archived);
            if (command === "snapshot-release") {
              check(inspection.fingerprint === request.fingerprint, "CONFLICT");
              current();
              controller.releaseSnapshot(nativeRequest, inspection, {fingerprint: request.fingerprint!, assertCurrent: current});
            }
            current();
            result = command === "snapshot-release" ? {state: "RELEASED", role: target.role, reference: request.reference,
              evidence: controller.inspectEvidence()} : {role: target.role, ...inspection, captures: controller.inspectEvidence()};
          }
        }
        current(); controllerRuntime.close(); snapshots.delete(controllerRuntime);
        return result;
      }, close});
  } catch (error) {
    try { close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "WINDOWS_PRIVATE_MAINTENANCE_CLOSE_UNKNOWN"); }
    throw error;
  }
}

export function runPrivateMaintenanceCli(args: readonly string[],
  io: Readonly<{out(text: string): void; err(text: string): void}> = {out: text => process.stdout.write(text), err: text => process.stderr.write(text)},
  env: NodeJS.ProcessEnv = process.env,
): number {
  let session: PrivateMaintenanceSession | undefined, failure: unknown, failed = false, output: string | undefined;
  try {
    const parsed = parsePrivateMaintenanceArguments(args);
    if (parsed === "help") { io.out(HELP); return 0; }
    check(process.platform === "win32", "PLATFORM");
    const before = lstatSync(parsed.requestFile);
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= MAX_REQUEST, "REQUEST_FILE");
    const bytes = readFileSync(parsed.requestFile), after = lstatSync(parsed.requestFile);
    check(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeMs === after.mtimeMs && bytes.length === before.size, "REQUEST_CHANGED");
    const request = JSON.parse(bytes.toString("utf8"));
    parseRequest(parsed.command, request);
    session = openPrivateMaintenanceSession(parsed.workspace, env);
    output = JSON.stringify(executePrivateMaintenance(parsed.command, request, session));
    check(Buffer.byteLength(output) <= MAX_OUTPUT, "OUTPUT_BOUND");
  } catch (error) { failed = true; failure = error; }
  try { session?.close(); } catch (cleanup) {
    failure = new AggregateError(failed ? [failure, cleanup] : [cleanup], "WINDOWS_PRIVATE_MAINTENANCE_CLOSE_UNKNOWN"); failed = true;
  }
  if (failed) { io.err(`${failure instanceof Error ? failure.message : String(failure)}\n`); return 1; }
  io.out(output! + "\n"); return 0;
}
const invokedDirectly = typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;
if (invokedDirectly) process.exitCode = runPrivateMaintenanceCli(process.argv.slice(2));
