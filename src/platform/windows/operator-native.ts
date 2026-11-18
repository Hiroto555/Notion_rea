import { lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { CollaborationError } from "../../collaboration/runtime/contract";
import type { SharedOperatorPorts, SharedOperatorFilePort } from "../../collaboration/runtime/operator-files";
import type { RuntimeStorePlatform } from "../runtime-store-platform";
import type { PrivateFileV2Port } from "../private-file-v2";
import { publishPrivateFileV2 } from "../private-file-v2";
import { WindowsPrivatePlatform } from "../../sync/private-platform";
import { WindowsRuntimePlatform, type WindowsRuntimePreparedDirectory, type WindowsRuntimeFileIdentity } from "./runtime-platform";
import type { WindowsExclusiveDirectoryResult } from "./exclusive-directory";
import { createWindowsPrivatePublicationV2, type WindowsPrivatePublicationV2Port } from "./private-publication-v2";
import { WindowsPublicationJournal, WINDOWS_PUBLICATION_JOURNAL_DATABASE } from "./publication-journal";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import type { WindowsAppPrivateConfig } from "./app-private";
import { createWindowsSourceBindingGuard } from "./source-binding-guard";
import { createPublicationResolutionPort, readPublicationAuthorization, type PublicationSourceIdentity, type PublicationResolutionPort } from "./publication-resolution";
import {createNativeAuthorityLeaseAcquirer} from "./authority-lease";
import {withRuntimeAuthorityLease} from "./held-runtime-platform";

export type WindowsOperatorConfig = WindowsAppPrivateConfig & {
  /** A separate private root: publication records must survive authority rollback. */
  publicationStateRoot: string;
  publicationStateDirectory: string;
};
function fail(code: string): never { throw new CollaborationError(code); }
const key = asciiCaseFold;
function overlaps(a: string, b: string): boolean {
  const left = key(a).replace(/\\$/, ""), right = key(b).replace(/\\$/, "");
  return left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`);
}

/** Production-only wiring. Existing private parents are required; new
 * destination directories are created exclusively through the native helper
 * with immutable per-target intent and preserved UNKNOWN evidence, never
 * through the older create-or-open directory helper. */
export function createWindowsOperatorNative(config: WindowsOperatorConfig, options: Readonly<{enrollExistingSources?: boolean}> = {}): Readonly<{
  ports: SharedOperatorPorts; privateFilePortV2: PrivateFileV2Port;
  exclusiveDirectoryEvidence(): readonly WindowsExclusiveDirectoryResult[]; close(): void;
}> {
  if (process.platform !== "win32") fail("WINDOWS_OPERATOR_UNSUPPORTED_PLATFORM");
  const root = validateWindowsPath(config.root, config.root).canonical;
  const stateRoot = validateWindowsPath(config.publicationStateRoot, config.publicationStateRoot).canonical;
  const stateDirectory = validateWindowsPath(config.publicationStateDirectory, stateRoot).canonical;
  if (overlaps(root, stateRoot)) fail("WINDOWS_PUBLICATION_STATE_OVERLAP");
  if (!/^[a-f0-9]{64}$/.test(config.expectedHash)) fail("WINDOWS_PRIVATE_EXPECTED_HASH_REQUIRED");
  const sourceBindings = createWindowsSourceBindingGuard({...config, root, publicationStateRoot: stateRoot, publicationStateDirectory: stateDirectory}, options.enrollExistingSources === true);
  const createdDirectories = new Set<string>();
  const dirs = new Map<string, WindowsRuntimePreparedDirectory>();
  const files = new Map<string, WindowsRuntimeFileIdentity>();
  // Immutable per-target exclusive-create intent captured at preflight plus
  // process-lifetime outcome evidence. Neither survives as a durable binding;
  // a consumed intent is never retried, not even after UNKNOWN.
  type ExclusiveDirectoryIntent = Readonly<{
    canonical: string;
    parent: string;
    parentIdentity: WindowsRuntimePreparedDirectory;
  }>;
  const directoryIntents = new Map<string, ExclusiveDirectoryIntent>();
  const directoryConsumed = new Set<string>();
  // Append-only history: the native result is never overwritten; a local
  // UNKNOWN verdict is appended after it when local proof/close fails.
  const directoryResults: WindowsExclusiveDirectoryResult[] = [];
  let rootIdentity: {rootFileId: string; volumeId: string} | undefined;
  let sourceDefinition: Readonly<{sourceRoot: string; orgId: string; genesisHash: string}> | undefined;
  let closed = false, journal: WindowsPublicationJournal | undefined, publication: WindowsPrivatePublicationV2Port | undefined;
  const assertOpen = () => { if (closed) fail("WINDOWS_OPERATOR_CLOSED"); };
  const pinFile = (identity: WindowsRuntimeFileIdentity) => {
    sourceBindings.file(identity, createdDirectories.has(key(win32.dirname(identity.canonicalPath))));
    const old = files.get(key(identity.canonicalPath));
    if (old && (key(old.fileId) !== key(identity.fileId) || key(old.volumeId) !== key(identity.volumeId))) fail("WINDOWS_OPERATOR_FILE_CHANGED");
    files.set(key(identity.canonicalPath), identity);
  };
  function runtime(directory: string, name = "shared-runtime.sqlite"): WindowsRuntimePlatform {
    assertOpen();
    const canonical = validateWindowsPath(directory, root).canonical;
    const prior = dirs.get(key(canonical));
    const port = new WindowsRuntimePlatform({root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, databaseName: name, expectedRoot: rootIdentity,
      expectedDirectory: prior ? {fileId: prior.directoryFileId, volumeId: prior.directoryVolumeId} : undefined});
    try {
      port.bind(canonical);
      const identity = port.validatedDirectoryIdentity();
      sourceBindings.directory(identity, createdDirectories.has(key(canonical)));
      rootIdentity ??= {rootFileId: identity.rootFileId, volumeId: identity.rootVolumeId};
      dirs.set(key(canonical), identity);
      return port;
    } catch (error) { try {port.close();} catch (cleanup) {throw new AggregateError([error, cleanup], "Native bind and cleanup failed");} throw error; }
  }
  function directory(path: string): WindowsRuntimePreparedDirectory {
    const p = runtime(path);
    try { return p.validatedDirectoryIdentity(); } finally {p.close();}
  }
  function bindPublicationSource(source: Readonly<{sourceRoot: string; orgId: string; genesisHash: string}>): void {
    assertOpen();
    const sourceRoot = validateWindowsPath(source.sourceRoot, root).canonical;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(source.orgId) || !/^[a-f0-9]{64}$/.test(source.genesisHash)) fail("WINDOWS_PUBLICATION_SOURCE_INVALID");
    const next = Object.freeze({sourceRoot, orgId: source.orgId, genesisHash: source.genesisHash});
    if (sourceDefinition && (key(sourceDefinition.sourceRoot) !== key(sourceRoot) || sourceDefinition.orgId !== next.orgId || sourceDefinition.genesisHash !== next.genesisHash))
      fail("WINDOWS_PUBLICATION_SOURCE_CHANGED");
    sourceDefinition = next;
  }
  function captureSource(): PublicationSourceIdentity {
    if (!sourceDefinition) fail("WINDOWS_PUBLICATION_SOURCE_REQUIRED");
    const native = runtime(sourceDefinition.sourceRoot);
    try {
      const dir = native.validatedDirectoryIdentity();
      const database = native.validatedFileIdentity(win32.join(dir.canonicalPath, "shared-runtime.sqlite"));
      pinFile(database);
      return Object.freeze({...sourceDefinition,
        root: Object.freeze({canonicalPath: root, fileId: dir.rootFileId, volumeId: dir.rootVolumeId}),
        directory: Object.freeze({canonicalPath: dir.canonicalPath, fileId: dir.directoryFileId, volumeId: dir.directoryVolumeId}), database});
    } finally {native.close();}
  }
  function newFile(path: string, forbidden: readonly string[]): string {
    assertOpen();
    const canonical = validateWindowsPath(path, root).canonical;
    if (key(canonical) === key(root) || forbidden.some(r => overlaps(canonical, validateWindowsPath(r, r).canonical))) fail("WINDOWS_OPERATOR_OUTPUT_OVERLAP");
    directory(win32.dirname(canonical));
    try { lstatSync(canonical); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return canonical; throw error; }
    return fail("WINDOWS_OPERATOR_OUTPUT_EXISTS");
  }
  // Pure preflight: same path/overlap/missing checks as a new file plus the
  // pinned parent proof. No filesystem mutation; the parent must exist.
  function newDirectory(path: string, forbidden: readonly string[]): string {
    const canonical = newFile(path, forbidden);
    const k = key(canonical);
    if (directoryIntents.has(k)) fail("WINDOWS_OPERATOR_DIRECTORY_DUPLICATE_PREFLIGHT");
    const parent = win32.dirname(canonical);
    const parentIdentity = directory(parent);
    directoryIntents.set(k, Object.freeze({canonical, parent, parentIdentity}));
    return canonical;
  }
  function exclusiveUnknown(intent: ExclusiveDirectoryIntent, result: WindowsExclusiveDirectoryResult | undefined, cause?: unknown): CollaborationError {
    // The thrown verdict is always UNKNOWN; the original native result is
    // retained verbatim and, when it claimed a terminal state, followed by
    // this appended local UNKNOWN record — never replaced.
    const outcome: WindowsExclusiveDirectoryResult | undefined = result === undefined ? undefined :
      result.state === "UNKNOWN" ? result : Object.freeze({
        state: "UNKNOWN", path: result.path, attemptId: result.attemptId,
        preserve: true, reason: "EXCLUSIVE_DIRECTORY_UNKNOWN",
        evidence: result.evidence,
      });
    if (outcome !== undefined && outcome !== result) directoryResults.push(outcome);
    const error = new CollaborationError("WINDOWS_EXCLUSIVE_DIRECTORY_UNKNOWN");
    const detail: Record<string, unknown> = {canonicalPath: intent.canonical};
    if (result !== undefined) {
      detail.nativeResult = result;
      detail.evidence = result.evidence;
      detail.result = outcome;
    }
    if (cause !== undefined) detail.cause = cause instanceof Error ? cause.message : String(cause);
    Object.assign(error, {exclusiveDirectory: Object.freeze(detail)});
    return error;
  }
  // Exclusive create of a previously preflighted directory. The intent is
  // consumed BEFORE any native invocation and is never retried: an UNKNOWN
  // preserves the immutable result/evidence, an EXISTS becomes an EEXIST-
  // compatible error, and nothing is deleted or re-sent.
  function createExclusive(path: string): void {
    assertOpen();
    const canonical = validateWindowsPath(path, root).canonical;
    const k = key(canonical);
    const intent = directoryIntents.get(k);
    if (intent === undefined || directoryConsumed.has(k)) fail("WINDOWS_OPERATOR_DIRECTORY_UNAVAILABLE");
    directoryConsumed.add(k);
    const parent = runtime(intent.parent);
    let result: WindowsExclusiveDirectoryResult | undefined;
    let dispatched = false;
    let closeFailure: unknown;
    try {
      const current = parent.validatedDirectoryIdentity();
      if (
        current.directoryFileId !== intent.parentIdentity.directoryFileId ||
        current.directoryVolumeId !== intent.parentIdentity.directoryVolumeId ||
        current.rootFileId !== intent.parentIdentity.rootFileId ||
        current.rootVolumeId !== intent.parentIdentity.rootVolumeId
      )
        fail("WINDOWS_OPERATOR_DIRECTORY_PARENT_CHANGED");
      // Everything after this line is potentially post-dispatch: no failure
      // may be reinterpreted as "nothing happened".
      dispatched = true;
      result = parent.createExclusiveDirectory(intent.canonical);
      directoryResults.push(result);
      if (result.state === "CREATED") {
        sourceBindings.directory(result.identity, true);
        createdDirectories.add(k);
        dirs.set(k, result.identity);
      }
    } catch (error) {
      try { parent.close(); } catch (closeError) { closeFailure = closeError; }
      if (!dispatched) {
        if (closeFailure === undefined) throw error;
        throw exclusiveUnknown(intent, result, [error, closeFailure]);
      }
      throw exclusiveUnknown(intent, result, closeFailure === undefined ? error : [error, closeFailure]);
    }
    try { parent.close(); } catch (error) { closeFailure = error; }
    if (closeFailure !== undefined) throw exclusiveUnknown(intent, result, closeFailure);
    const outcome = result!;
    if (outcome.state === "CREATED") {
      let readback: WindowsRuntimePreparedDirectory;
      try { readback = directory(intent.canonical); }
      catch (error) { throw exclusiveUnknown(intent, outcome, error); }
      if (
        readback.directoryFileId !== outcome.identity.directoryFileId ||
        readback.directoryVolumeId !== outcome.identity.directoryVolumeId ||
        readback.rootFileId !== outcome.identity.rootFileId ||
        readback.rootVolumeId !== outcome.identity.rootVolumeId
      )
        throw exclusiveUnknown(intent, outcome);
      return;
    }
    if (outcome.state === "EXISTS") {
      const error = new Error(`EEXIST: directory already exists, mkdir '${intent.canonical}'`) as NodeJS.ErrnoException;
      error.code = "EEXIST"; error.syscall = "mkdir"; error.path = intent.canonical;
      throw error;
    }
    if (outcome.state === "UNKNOWN") throw exclusiveUnknown(intent, outcome);
    fail("WINDOWS_EXCLUSIVE_DIRECTORY_REJECTED");
  }
  function publisher(): WindowsPrivatePublicationV2Port {
    assertOpen();
    if (publication) return publication;
    directory(root);
    const stateRuntime = new WindowsRuntimePlatform({root: stateRoot, probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash, systemRoot: config.systemRoot, databaseName: WINDOWS_PUBLICATION_JOURNAL_DATABASE});
    try {
      journal = new WindowsPublicationJournal(stateDirectory, new WindowsPrivatePlatform(stateRuntime), [root], sourceDefinition ? captureSource : undefined);
      publication = createWindowsPrivatePublicationV2({root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
        systemRoot: config.systemRoot, expectedRoot: rootIdentity!, authority: journal});
      return publication;
    } catch (error) { if (journal) journal.close(); else stateRuntime.close(); throw error; }
  }
  let readingPort: WindowsPrivatePublicationV2Port | undefined;
  function reader(): WindowsPrivatePublicationV2Port {
    assertOpen(); directory(root);
    readingPort ??= createWindowsPrivatePublicationV2({root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, expectedRoot: rootIdentity!, authority: {
        reserve() {fail("READ_ONLY_PUBLICATION_AUTHORITY");}, recordDispatch() {fail("READ_ONLY_PUBLICATION_AUTHORITY");},
        recordPrepared() {fail("READ_ONLY_PUBLICATION_AUTHORITY");}, recordTerminal() {fail("READ_ONLY_PUBLICATION_AUTHORITY");},
      }});
    return readingPort;
  }
  const privateFilePortV2: PrivateFileV2Port = {contractVersion: 2, platform: "win32", publish(request) {
    const dir = directory(win32.dirname(request.path));
    const receipt = publisher().publishNew({...request, expectedDirectory: {fileId: dir.directoryFileId, volumeId: dir.directoryVolumeId}});
    if (receipt.state === "PUBLISHED") { sourceBindings.file(receipt.identity, true); pinFile(receipt.identity); }
    return receipt;
  }};
  const privateFiles: SharedOperatorFilePort = {kind: "windows",
    assertDirectory(path) {return directory(path).canonicalPath;},
    assertNewFile: newFile,
    assertNewDirectory: newDirectory,
    createDirectory: createExclusive,
    readPrivateFile(path, maxBytes) {
      const canonical = validateWindowsPath(path, root).canonical;
      const p = runtime(win32.dirname(canonical));
      try {
        const dir = p.validatedDirectoryIdentity(), identity = p.validatedPrivateFileIdentity(canonical);
        pinFile(identity);
        const result = reader().readPrivate({path: canonical, expectedDirectory: {fileId: dir.directoryFileId, volumeId: dir.directoryVolumeId}, expectedFile: identity, maxBytes});
        if (result.state !== "READ") fail("WINDOWS_OPERATOR_READ_UNCONFIRMED");
        pinFile(result.identity);
        return Buffer.from(result.bytes);
      } finally {p.close();}
    },
    publishNewFile(path, bytes) {
      const canonical = newFile(path, []), attemptId = randomUUID().replace(/-/g, "");
      publishPrivateFileV2(privateFilePortV2, {path: canonical, stagingPath: win32.join(win32.dirname(canonical), `.folio-private-${attemptId}.tmp`), attemptId, bytes, beforePublish() {}});
    },
  };
  const nativePublication: PublicationResolutionPort = {
    inspect(request, authorization) {
      const auth = readPublicationAuthorization(authorization); bindPublicationSource(auth); publisher();
      return resolution().inspect(request, authorization);
    },
    resolve(request, authorization) {
      const auth = readPublicationAuthorization(authorization); bindPublicationSource(auth); publisher();
      const observed = resolution().resolve(request, authorization);
      try {sourceBindings.file(observed.observed.file, true); pinFile(observed.observed.file);}
      catch (cause) {throw new Error("UNKNOWN: publication observation retained; source binding acknowledgment failed", {cause});}
      return observed;
    },
  };
  function resolution(): PublicationResolutionPort {
    return createPublicationResolutionPort({journal: journal!, readCurrent(request) {
      const source = captureSource();
      const output = runtime(win32.dirname(request.reservation.path));
      try {
        const dir = output.validatedDirectoryIdentity();
        const receipt = reader().readPrivate({path: request.reservation.path,
          expectedDirectory: {fileId: dir.directoryFileId, volumeId: dir.directoryVolumeId},
          expectedFile: request.preparedFile, expectedSha256: request.reservation.sha256, maxBytes: request.reservation.byteLength});
        return {root: source.root, directory: {canonicalPath: dir.canonicalPath, fileId: dir.directoryFileId, volumeId: dir.directoryVolumeId},
          sourceDirectory: source.directory, sourceDatabase: source.database, receipt};
      } finally {output.close();}
    }});
  }
  return Object.freeze({privateFilePortV2, ports: {privateFiles, nativePublication, bindPublicationSource, runtimeStoreOptions(directory) {
    // Fresh LAZY adapter on every call: the bound runtime is only created
    // when bind() runs, so callers may preflight and storeOptions a
    // destination directory that does not exist yet. Detached native
    // identity pins are still shared across opens through dirs/files.
    assertOpen();
    const canonical = validateWindowsPath(directory, root).canonical;
    let native: WindowsRuntimePlatform | undefined, bound = false, adapterClosed = false;
    const current = (): WindowsRuntimePlatform => {
      assertOpen();
      if (adapterClosed) fail("WINDOWS_OPERATOR_ADAPTER_CLOSED");
      if (native === undefined) fail("WINDOWS_ROOT_NOT_BOUND");
      return native;
    };
    // Mint the original C acquirer from the SOURCE root, before binding the
    // destination adapter. A missing destination never needs an early probe.
    const sourceRoot = (() => {
      const probe = runtime(root);
      let failed = false, failure: unknown;
      try {return probe.validatedDirectoryIdentity();}
      catch (error) {failed = true; failure = error; throw error;}
      finally {try {probe.close();} catch (cleanup) {
        if (failed) throw new AggregateError([failure, cleanup], "Source root proof and cleanup failed");
        throw cleanup;
      }}
    })();
    const rawSourceAcquirer = createNativeAuthorityLeaseAcquirer({...config, root,
      expectedRoot: {rootFileId: sourceRoot.rootFileId, volumeId: sourceRoot.rootVolumeId},
      identityFor(path) {
        const n = current();
        if (key(path) !== key(win32.join(canonical, n.databaseName))) fail("WINDOWS_OPERATOR_DATABASE_PATH");
        const d = n.validatedDirectoryIdentity();
        sourceBindings.directory(d, createdDirectories.has(key(canonical)));
        const f = n.validatedFileIdentity(path); pinFile(f);
        return {directoryFileId: d.directoryFileId, directoryVolumeId: d.directoryVolumeId,
          fileId: f.fileId, volumeId: f.volumeId};
      },
    });
    const adapter: RuntimeStorePlatform = {
      bind(path) {
        assertOpen();
        if (adapterClosed) fail("WINDOWS_OPERATOR_ADAPTER_CLOSED");
        if (bound || key(path) !== key(canonical)) fail("WINDOWS_OPERATOR_ADAPTER_REUSED");
        bound = true;
        native = runtime(canonical);
        return canonical;
      },
      assertRoot() {current().assertRoot();},
      assertDatabase(path) {const n = current(); n.assertDatabase(path); pinFile(n.validatedFileIdentity(path));},
      createExclusiveDurably(path) {
        const n = current(), receipt = n.createExclusiveDurablyWithReceipt(path), f = n.validatedFileIdentity(path);
        if (key(receipt.identity.fileId) !== key(f.fileId) || key(receipt.identity.volumeId) !== key(f.volumeId))
          fail("WINDOWS_OPERATOR_FILE_CHANGED");
        if (receipt.state === "CREATED") {n.assertEmptyFile(path); sourceBindings.file(f, true);}
        pinFile(f);
      },
      assertEmptyFile(path) {current().assertEmptyFile(path);},
      withHotJournalSnapshot(path, callback) {current().withHotJournalSnapshot(path, callback);},
      syncCreatedDatabase(path) {const n = current(); n.syncCreatedDatabase(path); pinFile(n.validatedFileIdentity(path));},
      close() {if (adapterClosed) return; native?.close(); adapterClosed = true;},
    };
    return {platformAdapter: withRuntimeAuthorityLease(adapter, rawSourceAcquirer)};
  }},
  // Process-lifetime exclusive-create outcomes, immutable and readable after
  // close. This is evidence retention, NOT a durable source binding.
  exclusiveDirectoryEvidence(): readonly WindowsExclusiveDirectoryResult[] {
    return Object.freeze([...directoryResults]);
  },
  close() {
    if (closed) return;
    const failures: unknown[] = [];
    try {journal?.close();} catch (error) {failures.push(error);}
    try {sourceBindings.close();} catch (error) {failures.push(error);}
    if (failures.length) throw new AggregateError(failures, "Native operator cleanup failed");
    closed = true;
  }});
}

export function windowsOperatorConfigFromEnvironment(env: NodeJS.ProcessEnv): WindowsOperatorConfig | undefined {
  const values = [env.FOLIO_WINDOWS_NATIVE_ROOT, env.FOLIO_WINDOWS_NATIVE_PROBE, env.FOLIO_WINDOWS_NATIVE_SHA256,
    env.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT, env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR];
  if (values.every(v => v === undefined)) return undefined;
  if (values.some(v => !v)) fail("WINDOWS_OPERATOR_CONFIG_INCOMPLETE");
  return {root: values[0]!, probeExecutable: values[1]!, expectedHash: values[2]!, publicationStateRoot: values[3]!,
    publicationStateDirectory: values[4]!, systemRoot: env.SystemRoot ?? "C:\\Windows"};
}
