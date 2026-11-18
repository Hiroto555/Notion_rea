import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowsExclusiveDirectoryResult } from "../src/platform/windows/exclusive-directory";
const state = vi.hoisted(() => ({
  fileId: "3".repeat(32),
  journalOpens: 0,
  reads: 0,
  publications: 0,
  creates: 0,
  // fold(path) -> directory File ID; models directory existence + identity.
  dirs: new Map<string, string>(),
  // Paths that exist for the operator's own lstat target-missing check.
  existing: new Set<string>(),
  exclusiveNext: undefined as unknown,
  exclusiveCorrupt: false,
  closeThrow: false,
  acquired: [] as {root: string; path: string; fileId: string; closed: boolean}[],
}));
const fold = (path: string): string => path.toLowerCase();
// Factory wiring contract only. Persistent SQLite and independent-process
// identity comparisons have separate source-bindings tests.
vi.mock("../src/platform/windows/source-binding-guard", () => ({createWindowsSourceBindingGuard: vi.fn(() => ({directory: vi.fn(), file: vi.fn(), close: vi.fn()}))}));
vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  return {...actual, join: (...parts: string[]) => /^[A-Za-z]:\\/.test(parts[0]) ? actual.win32.join(...parts) : actual.join(...parts)};
});
vi.mock("node:fs", async original => ({...await original<typeof import("node:fs")>(),
  lstatSync(path: string) {
    if (!state.existing.has(fold(String(path))) && !state.dirs.has(fold(String(path))))
      throw Object.assign(new Error("missing"), {code: "ENOENT"});
    return {isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, nlink: 1, dev: 0, ino: 0, size: 0, mtimeMs: 0};
  }}));
// Explicit acquisition seam: real held wrapper, synthetic leases only. The
// production brand factory is never called and no Worker/helper can launch.
vi.mock("../src/platform/windows/authority-lease", async original => {
  const actual = await original<typeof import("../src/platform/windows/authority-lease")>();
  const minted = new WeakSet<Function>();
  return {...actual,
    createNativeAuthorityLeaseAcquirer(options: {root: string; expectedRoot: {rootFileId: string; volumeId: string}; identityFor(path: string): {fileId: string}}) {
      if (options.root !== "C:\\Folio" || options.expectedRoot.rootFileId !== "1".repeat(32) || options.expectedRoot.volumeId !== "4".repeat(16))
        throw new Error("SOURCE_ROOT_REQUIRED");
      const acquire = (path: string) => {
        const identity = options.identityFor(path);
        const item = {root: options.root, path, fileId: identity.fileId, closed: false}; state.acquired.push(item);
        return {trust: "untrusted-test" as const, assertHeld() {if(item.closed) throw new Error("LEASE_CLOSED");}, close() {item.closed = true;}};
      };
      minted.add(acquire); return acquire;
    },
    withPrivateAuthorityLease(platform: import("../src/sync/private-platform").PrivatePlatform, acquire: import("../src/platform/windows/authority-lease").AcquirePrivateAuthorityLease) {
      if (!minted.has(acquire)) throw new Error("ORIGINAL_ACQUIRER_REQUIRED");
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", {configurable: true, value: "darwin"});
      try {return actual.withPrivateAuthorityLeaseForTesting(platform, acquire);}
      finally {Object.defineProperty(process, "platform", descriptor);}
    },
  };
});
vi.mock("../src/platform/windows/runtime-platform", () => ({WindowsRuntimePlatform: class {
  path = "";
  closed = false;
  bound: {fileId: string; rootId: string} | undefined;
  constructor(readonly options: {root: string; databaseName?: string; expectedRoot?: {rootFileId: string; volumeId: string}; expectedDirectory?: {fileId: string; volumeId: string}}) {}
  bind(path: string) {
    const fileId = state.dirs.get(fold(path));
    if (fileId === undefined) throw new Error("DIRECTORY_MISSING");
    const expected = this.options.expectedDirectory;
    if (expected && (expected.fileId !== fileId || expected.volumeId !== "4".repeat(16))) throw new Error("DIRECTORY_IDENTITY_MISMATCH");
    const rootId = state.dirs.get(fold(this.options.root));
    if (rootId === undefined) throw new Error("ROOT_MISSING");
    const expectedRoot = this.options.expectedRoot;
    if (expectedRoot && (expectedRoot.rootFileId !== rootId || expectedRoot.volumeId !== "4".repeat(16))) throw new Error("ROOT_IDENTITY_MISMATCH");
    this.path = path;
    this.bound = {fileId, rootId};
    return path;
  }
  assertRoot() {
    if (this.closed) throw new Error("CLOSED");
    const bound = this.bound;
    if (bound === undefined) throw new Error("WINDOWS_ROOT_NOT_BOUND");
    const now = state.dirs.get(fold(this.path));
    const rootId = state.dirs.get(fold(this.options.root));
    if (now !== bound.fileId || rootId !== bound.rootId) throw new Error("IDENTITY_CHANGED");
  }
  get databaseName() {return this.options.databaseName ?? "shared-runtime.sqlite";}
  createExclusiveDurablyWithReceipt(path: string) {
    this.assertRoot(); state.existing.add(fold(path));
    return {state: "CREATED", identity: this.validatedFileIdentity(path)};
  }
  assertDatabase() {this.assertRoot();} createExclusiveDurably() {} assertEmptyFile() {} syncCreatedDatabase() {} assertFile() {} assertSidecars() {}
  close() { if (state.closeThrow) throw new Error("CLOSE_FAILED"); this.closed = true; }
  validatedDirectoryIdentity() {
    this.assertRoot();
    const bound = this.bound!;
    return {canonicalPath: this.path, directoryFileId: bound.fileId, directoryVolumeId: "4".repeat(16), rootFileId: bound.rootId, rootVolumeId: "4".repeat(16)};
  }
  createExclusiveDirectory(path: string) {
    state.creates++;
    const result = (state.exclusiveNext ?? {state: "CREATED", path, attemptId: "b".repeat(32), preserve: true,
      identity: {canonicalPath: path, directoryFileId: "5".repeat(32), directoryVolumeId: "4".repeat(16), rootFileId: this.bound?.rootId ?? "1".repeat(32), rootVolumeId: "4".repeat(16)},
      evidence: {exactWire: "{}", captured: {stdout: "", stderr: "", captureEncoding: "latin1", status: 0, signal: null}}}) as WindowsExclusiveDirectoryResult;
    if (result.state === "CREATED")
      state.dirs.set(fold(path), state.exclusiveCorrupt ? "9".repeat(32) : result.identity.directoryFileId);
    return result;
  }
  validatedPrivateFileIdentity(path: string) {return {canonicalPath: path, fileId: state.fileId, volumeId: "4".repeat(16)};}
  validatedFileIdentity(path: string) {return this.validatedPrivateFileIdentity(path);}
}}));
vi.mock("../src/platform/windows/publication-journal", () => ({WINDOWS_PUBLICATION_JOURNAL_DATABASE: "publication-state.sqlite", WindowsPublicationJournal: class {
  constructor() {state.journalOpens++;} close() {} reserve() {} recordDispatch() {} recordPrepared() {} recordTerminal() {}
}}));
vi.mock("../src/platform/windows/private-publication-v2", () => ({createWindowsPrivatePublicationV2() {return {
  readPrivate(request: {path: string}) {state.reads++; return {state: "READ", bytes: Buffer.from("private"), identity: {canonicalPath: request.path, fileId: state.fileId, volumeId: "4".repeat(16)}};},
  publishNew(request: {path: string}) {state.publications++; return {state: "REJECTED", contractVersion: 2, path: request.path, preserve: true, reason: "fixture"};},
};}}));
import { createWindowsOperatorNative, windowsOperatorConfigFromEnvironment } from "../src/platform/windows/operator-native";
import { createSharedOperatorContext } from "../src/collaboration/runtime/operator-files";
const config = {root: "C:\\Folio", probeExecutable: "C:\\Trusted\\probe.exe", expectedHash: "a".repeat(64), systemRoot: "C:\\Windows", publicationStateRoot: "C:\\Publication", publicationStateDirectory: "C:\\Publication\\journal"};
function seed() {
  state.fileId = "3".repeat(32); state.journalOpens = state.reads = state.publications = state.creates = 0;
  state.exclusiveNext = undefined; state.exclusiveCorrupt = false; state.closeThrow = false; state.acquired.length = 0;
  state.dirs.clear(); state.existing.clear();
  state.dirs.set(fold("C:\\Folio"), "1".repeat(32));
  state.dirs.set(fold("C:\\Folio\\authority"), "2".repeat(32));
  state.dirs.set(fold("C:\\Folio\\secrets"), "6".repeat(32));
}
seed();
afterEach(() => {vi.restoreAllMocks(); seed();});
function win() {vi.spyOn(process, "platform", "get").mockReturnValue("win32");}
it("refuses production factory on this non-Windows contract-test host", () => {
  expect(() => createWindowsOperatorNative(config)).toThrow("UNSUPPORTED_PLATFORM");
});
it("keeps read-only private inspection from creating a publication authority", () => {
  win(); const native = createWindowsOperatorNative(config);
  expect(native.ports.privateFiles!.readPrivateFile("C:\\Folio\\secrets\\token.json", 8192).toString()).toBe("private");
  expect(state.journalOpens).toBe(0); expect(state.reads).toBe(1); native.close();
  expect(() => native.ports.privateFiles!.assertDirectory(config.root)).toThrow("CLOSED");
});
it("creates fresh runtime adapters and preserves native database identity across reopen", () => {
  win(); const native = createWindowsOperatorNative(config), factory = native.ports.runtimeStoreOptions!;
  const a = factory("C:\\Folio\\authority").platformAdapter!, b = factory("C:\\Folio\\authority").platformAdapter!;
  expect(a).not.toBe(b); a.bind("C:\\Folio\\authority"); a.assertDatabase("C:\\Folio\\authority\\shared-runtime.sqlite"); a.close();
  expect(state.acquired).toEqual([{root: "C:\\Folio", path: "C:\\Folio\\authority\\shared-runtime.sqlite", fileId: "3".repeat(32), closed: true}]);
  state.fileId = "9".repeat(32); b.bind("C:\\Folio\\authority");
  expect(() => b.assertDatabase("C:\\Folio\\authority\\shared-runtime.sqlite")).toThrow("FILE_CHANGED"); b.close(); native.close();
});
it("opens the separate journal only on an explicit publication and keeps directory preflight side-effect free", () => {
  win(); const native = createWindowsOperatorNative(config);
  expect(() => native.ports.privateFiles!.publishNewFile("C:\\Folio\\secrets\\token.json", Buffer.from("secret"))).toThrow();
  expect(state.journalOpens).toBe(1); expect(state.publications).toBe(1);
  expect(native.ports.privateFiles!.assertNewDirectory("C:\\Folio\\restore", [])).toBe("C:\\Folio\\restore");
  expect(state.dirs.has(fold("C:\\Folio\\restore"))).toBe(false);
  expect(state.creates).toBe(0);
  expect(() => native.ports.privateFiles!.assertNewFile("C:\\Folio\\authority\\token.json", ["C:\\Folio\\authority"])).toThrow("OVERLAP"); native.close();
});
it("refuses publication state sharing the output/authority root", () => {
  win(); expect(() => createWindowsOperatorNative({...config, publicationStateRoot: config.root, publicationStateDirectory: "C:\\Folio\\journal"})).toThrow("STATE_OVERLAP");
});
it("requires all explicit environment fields and does not change configuration", () => {
  expect(windowsOperatorConfigFromEnvironment({})).toBeUndefined();
  expect(() => windowsOperatorConfigFromEnvironment({FOLIO_WINDOWS_NATIVE_ROOT: config.root})).toThrow("CONFIG_INCOMPLETE");
  const env = {FOLIO_WINDOWS_NATIVE_ROOT: config.root, FOLIO_WINDOWS_NATIVE_PROBE: config.probeExecutable, FOLIO_WINDOWS_NATIVE_SHA256: config.expectedHash,
    FOLIO_WINDOWS_PUBLICATION_STATE_ROOT: config.publicationStateRoot, FOLIO_WINDOWS_PUBLICATION_STATE_DIR: config.publicationStateDirectory};
  expect(windowsOperatorConfigFromEnvironment(env)).toEqual(config);
});

it("keeps native exports usable after a held quit and closes them only after accepted quit", async () => {
  const {EventEmitter} = await import("node:events");
  const {finishWorkspaceQuit, registerAcceptedQuitCleanup} = await import("../src/main/workspace-quit");
  win(); const native = createWindowsOperatorNative(config), lifecycle = new EventEmitter();
  registerAcceptedQuitCleanup(lifecycle, () => native.close());
  const blocked = finishWorkspaceQuit({commitRestart: () => "blocked", preventQuit() {}, reopenWindow() {}, closeStore() {throw new Error("must not close");}});
  expect(blocked).toBe("held");
  expect(native.ports.privateFiles!.assertDirectory(config.root)).toBe(config.root);
  expect(finishWorkspaceQuit({commitRestart: () => "committed", preventQuit() {throw new Error("must quit");}, reopenWindow() {}, closeStore() {}})).toBe("quit");
  lifecycle.emit("quit");
  expect(() => native.ports.privateFiles!.assertDirectory(config.root)).toThrow("CLOSED");
});

describe("exclusive directory creation (contract simulation, not OS)", () => {
  it("restore ordering: assertNewDirectory -> storeOptions before exists -> create -> assertDirectory -> adapter bind", () => {
    win(); const native = createWindowsOperatorNative(config);
    const context = createSharedOperatorContext(native.ports, "UNSUPPORTED");
    const files = context.privateFiles!;
    const destination = files.assertNewDirectory("C:\\Folio\\restore", ["C:\\Folio\\authority"]);
    const options = context.storeOptions(destination); // Before the directory exists: lazy adapter, no bind.
    expect(state.creates).toBe(0);
    files.createDirectory(destination);
    expect(files.assertDirectory(destination)).toBe(destination);
    const adapter = options.platformAdapter!;
    expect(adapter.bind(destination)).toBe(destination);
    adapter.createExclusiveDurably!(`${destination}\\shared-runtime.sqlite`);
    adapter.assertEmptyFile!(`${destination}\\shared-runtime.sqlite`);
    adapter.assertDatabase(`${destination}\\shared-runtime.sqlite`);
    adapter.syncCreatedDatabase(`${destination}\\shared-runtime.sqlite`);
    adapter.close();
    expect(state.creates).toBe(1); expect(state.journalOpens).toBe(0);
    native.close();
  });
  it("maintenance ordering: authority open -> assertNewDirectory -> storeOptions -> create -> assertDirectory", () => {
    win(); const native = createWindowsOperatorNative(config);
    const context = createSharedOperatorContext(native.ports, "UNSUPPORTED");
    const files = context.privateFiles!;
    const source = context.storeOptions("C:\\Folio\\authority", true);
    const sourceAdapter = source.platformAdapter!;
    expect(sourceAdapter.bind("C:\\Folio\\authority")).toBe("C:\\Folio\\authority");
    sourceAdapter.close();
    const destination = files.assertNewDirectory("C:\\Folio\\verify", ["C:\\Folio\\authority"]);
    const options = context.storeOptions(destination);
    files.createDirectory(destination);
    expect(files.assertDirectory(destination)).toBe(destination);
    expect(options.platformAdapter!.bind(destination)).toBe(destination);
    options.platformAdapter!.close();
    native.close();
  });
  it("bootstrap ordering: assertNewDirectory -> create -> storeOptions adapter bind", () => {
    win(); const native = createWindowsOperatorNative(config);
    const context = createSharedOperatorContext(native.ports, "UNSUPPORTED");
    const files = context.privateFiles!;
    const root = files.assertNewDirectory("C:\\Folio\\workspace", []);
    files.createDirectory(root);
    const adapter = context.storeOptions(root).platformAdapter!;
    expect(adapter.bind(root)).toBe(root);
    adapter.close();
    native.close();
  });
  it("each storeOptions call returns a fresh adapter bound only to its directory", () => {
    win(); const native = createWindowsOperatorNative(config);
    const context = createSharedOperatorContext(native.ports, "UNSUPPORTED");
    const a = context.storeOptions("C:\\Folio\\authority").platformAdapter!;
    const b = context.storeOptions("C:\\Folio\\authority").platformAdapter!;
    expect(a).not.toBe(b);
    expect(() => a.assertRoot()).toThrow("NOT_BOUND");
    a.bind("C:\\Folio\\authority");
    expect(() => a.bind("C:\\Folio\\authority")).toThrow("REUSED");
    expect(() => b.bind("C:\\Folio\\secrets")).toThrow("REUSED");
    a.close(); b.close();
    native.close();
  });
  it("rejects overlap in both directions, an existing target, a missing parent, and a duplicate preflight", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    expect(() => files.assertNewDirectory("C:\\Folio", [])).toThrow("OVERLAP");
    expect(() => files.assertNewDirectory("C:\\Folio\\authority\\restore", ["C:\\Folio\\authority"])).toThrow("OVERLAP");
    expect(() => files.assertNewDirectory("C:\\Folio\\authority", ["C:\\Folio\\authority\\restore"])).toThrow("OVERLAP");
    state.dirs.set(fold("C:\\Folio\\restore"), "7".repeat(32));
    expect(() => files.assertNewDirectory("C:\\Folio\\restore", [])).toThrow("OUTPUT_EXISTS");
    expect(state.creates).toBe(0);
    state.dirs.delete(fold("C:\\Folio\\restore"));
    expect(() => files.assertNewDirectory("C:\\Folio\\ghost\\dest", [])).toThrow("DIRECTORY_MISSING");
    files.assertNewDirectory("C:\\Folio\\restore", []);
    expect(() => files.assertNewDirectory("C:\\Folio\\restore", [])).toThrow("DUPLICATE_PREFLIGHT");
    native.close();
  });
  it("maps a native EXISTS race to an EEXIST-compatible error with retained evidence", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    const destination = files.assertNewDirectory("C:\\Folio\\restore", []);
    state.exclusiveNext = {state: "EXISTS", path: destination, attemptId: "b".repeat(32), preserve: true,
      reason: "EXCLUSIVE_DIRECTORY_EXISTS", evidence: {exactWire: "{}", captured: {stdout: "", stderr: "", captureEncoding: "latin1", status: 2, signal: null}}};
    let code: string | undefined;
    try { files.createDirectory(destination); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
    expect(code).toBe("EEXIST");
    expect(native.exclusiveDirectoryEvidence()).toHaveLength(1);
    native.close();
  });
  it("refuses create without preflight and any retry after a consumed UNKNOWN intent", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    expect(() => files.createDirectory("C:\\Folio\\restore")).toThrow("DIRECTORY_UNAVAILABLE");
    const destination = files.assertNewDirectory("C:\\Folio\\restore", []);
    state.exclusiveNext = {state: "UNKNOWN", path: destination, attemptId: "b".repeat(32), preserve: true,
      reason: "EXCLUSIVE_DIRECTORY_UNKNOWN", evidence: {exactWire: "{}", captured: {stdout: "{broken", stderr: "", captureEncoding: "latin1", status: 0, signal: null}}};
    expect(() => files.createDirectory(destination)).toThrow("WINDOWS_EXCLUSIVE_DIRECTORY_UNKNOWN");
    // Even with the target still absent, the consumed intent never retries.
    expect(() => files.createDirectory(destination)).toThrow("DIRECTORY_UNAVAILABLE");
    expect(state.creates).toBe(1);
    const evidence = native.exclusiveDirectoryEvidence();
    expect(evidence).toHaveLength(1);
    expect(evidence[0].state).toBe("UNKNOWN");
    native.close();
    expect(native.exclusiveDirectoryEvidence()).toHaveLength(1);
  });
  it("fails before dispatch when the non-root parent identity changed after preflight", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    const destination = files.assertNewDirectory("C:\\Folio\\authority\\restore", []);
    state.dirs.set(fold("C:\\Folio\\authority"), "7".repeat(32));
    expect(() => files.createDirectory(destination)).toThrow();
    expect(state.creates).toBe(0);
    expect(() => files.createDirectory(destination)).toThrow("DIRECTORY_UNAVAILABLE");
    native.close();
  });
  it("fails before dispatch when only the root identity changed after preflight", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    const destination = files.assertNewDirectory("C:\\Folio\\authority\\restore", []);
    state.dirs.set(fold("C:\\Folio"), "8".repeat(32));
    expect(() => files.createDirectory(destination)).toThrow();
    expect(state.creates).toBe(0);
    expect(() => files.createDirectory(destination)).toThrow("DIRECTORY_UNAVAILABLE");
    native.close();
  });
  it("appends a local UNKNOWN verdict after the retained CREATED result on post-create identity change", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    const destination = files.assertNewDirectory("C:\\Folio\\restore", []);
    state.exclusiveCorrupt = true;
    let code = "";
    try { files.createDirectory(destination); } catch (error) { code = String((error as Error).message); }
    expect(code).toContain("WINDOWS_EXCLUSIVE_DIRECTORY_UNKNOWN");
    const evidence = native.exclusiveDirectoryEvidence();
    expect(evidence).toHaveLength(2);
    expect(evidence[0].state).toBe("CREATED");
    expect(evidence[1].state).toBe("UNKNOWN");
    expect(evidence[1].evidence).toBe(evidence[0].evidence);
    expect(() => files.createDirectory(destination)).toThrow("DIRECTORY_UNAVAILABLE");
    native.close();
  });
  it("appends a local UNKNOWN verdict after CREATED when the parent close itself fails", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    const destination = files.assertNewDirectory("C:\\Folio\\restore", []);
    state.closeThrow = true; // Only the post-create parent close is faulted, not preflight.
    let code = "";
    try { files.createDirectory(destination); } catch (error) { code = String((error as Error).message); }
    expect(code).toContain("WINDOWS_EXCLUSIVE_DIRECTORY_UNKNOWN");
    const evidence = native.exclusiveDirectoryEvidence();
    expect(evidence).toHaveLength(2);
    expect(evidence[0].state).toBe("CREATED");
    expect(evidence[1].state).toBe("UNKNOWN");
    expect(evidence[1].evidence).toBe(evidence[0].evidence);
    expect(() => files.createDirectory(destination)).toThrow("DIRECTORY_UNAVAILABLE");
    native.close();
  });
  it("turns a structured native REJECTED into an explicit failure without retry", () => {
    win(); const native = createWindowsOperatorNative(config);
    const files = native.ports.privateFiles!;
    const destination = files.assertNewDirectory("C:\\Folio\\restore", []);
    state.exclusiveNext = {state: "REJECTED", path: destination, attemptId: "b".repeat(32), preserve: true,
      reason: "EXCLUSIVE_DIRECTORY_REJECTED", evidence: {exactWire: "{}", captured: {stdout: "", stderr: "", captureEncoding: "latin1", status: 1, signal: null}}};
    expect(() => files.createDirectory(destination)).toThrow("WINDOWS_EXCLUSIVE_DIRECTORY_REJECTED");
    expect(() => files.createDirectory(destination)).toThrow("DIRECTORY_UNAVAILABLE");
    native.close();
  });
  it("rejects adapter use before bind, after close, and after factory close", () => {
    win(); const native = createWindowsOperatorNative(config);
    const adapter = native.ports.runtimeStoreOptions!("C:\\Folio\\authority").platformAdapter!;
    expect(() => adapter.assertRoot()).toThrow("NOT_BOUND");
    adapter.close();
    adapter.close();
    expect(() => adapter.bind("C:\\Folio\\authority")).toThrow("RUNTIME_LEASE_CLOSED");
    const second = native.ports.runtimeStoreOptions!("C:\\Folio\\authority").platformAdapter!;
    native.close();
    expect(() => second.bind("C:\\Folio\\authority")).toThrow("CLOSED");
    expect(() => native.ports.runtimeStoreOptions!("C:\\Folio\\authority")).toThrow("CLOSED");
  });
});
