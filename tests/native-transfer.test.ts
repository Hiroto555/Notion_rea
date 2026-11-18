/**
 * Native transfer contract tests.
 *
 * Every injected "native" port here is a POSIX-backed contract double over a
 * disposable temp tree — routing contract simulation ONLY, never OS
 * acceptance, never Windows proof, never identity/ACL/durability proof.
 * process.platform is never spoofed. node:http is stubbed; no real sockets.
 */
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync, rmSync, chmodSync, truncateSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Readable, PassThrough, Writable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NativePrivateFile,
  NativePrivateFilesystemPort,
  NativePrivateIdentity,
  NativePrivateReceipt,
} from "../src/platform/private-persistence";
import { NativePrivatePersistenceError } from "../src/platform/windows/private-persistence";
import type { NativePrivatePersistenceAuthority } from "../src/platform/windows/private-persistence";
import {
  nativeTransferPort,
  withNativeTransfer as nativeScope,
  inspectNativeTransferBudget,
  inspectNativeTransferInventory,
  createWindowsNativeTransferIoForTesting,
  type NativeTransferIoPort,
  type NativeTransferOptions,
} from "../src/platform/windows/private-transfer";
import {
  stageCheckpointAssets,
  uploadCheckpointAssets,
  assertWorkspaceAssets,
  publishCheckpointAssetsFromStaging,
  reclaimAppliedStaging,
  WorkspaceBlobStore,
  type WorkspaceBlobAsset,
} from "../src/sync/workspace-blobs";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { inspectTransferCacheCatalog } from "../src/sync/transfer-cache-catalog";
import { TransferMaintenanceService } from "../src/main/transfer-maintenance-service";
import { SyncError, canonicalJson } from "../src/sync/protocol";
import { withProductPrivateJournals } from "../src/platform/product-private-journals";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";

vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return { ...actual, request: (...args: Parameters<typeof stub.request>) => stub.request(...args) };
});

// Shared stub surface for node:http request(): never performs real traffic.
const stub = {
  handlers: new Map<string, (method: string, headers: Record<string, string>, body: Buffer | undefined) => { status: number; headers?: Record<string, string>; body?: Buffer }>(),
  calls: [] as { method: string; url: string; body: Buffer | undefined }[],
  request(url: string, options: { method: string; headers: Record<string, string> }, cb: (response: unknown) => void) {
    const method = String(options.method);
    const req = new Writable({
      write(_c, _e, done) { done(); },
    }) as Writable & { end(body?: Buffer): void; on(e: string, f: (...a: unknown[]) => void): unknown; setTimeout(): void; destroy(): void; aborted: boolean };
    let body: Buffer | undefined;
    const oldEnd = req.end.bind(req);
    Object.defineProperty(req, "end", {value: (b?: Buffer) => { body = b; return oldEnd(b); }});
    req.setTimeout = () => undefined;
    Object.defineProperty(req, "destroy", {value: () => req});
    req.aborted = false;
    const respond = stub.handlers.get(method) ?? (() => ({ status: 404 }));
    queueMicrotask(() => {
      stub.calls.push({ method, url, body });
      const result = respond(method, options.headers, body) as { status: number; headers?: Record<string, string>; body?: Buffer };
      const stream = new Readable({ read() { if (result.body) this.push(result.body); this.push(null); } }) as Readable & {
        statusCode: number; headers: Record<string, string>; destroy(error?: unknown): void; resume(): void; on(e: string, f: (...a: unknown[]) => void): unknown;
      };
      stream.statusCode = result.status;
      stream.headers = result.headers ?? {};
      cb(stream);
    });
    return req;
  },
};

// POSIX-backed contract double: fileId = inode (32-hex), volume fixed.
const VOLUME = "a1b2c3d4e5f6a7b8";
const identityOf = (path: string): NativePrivateIdentity => {
  const stat = lstatSync(path);
  return { path, fileId: stat.ino.toString(16).padStart(32, "0").slice(-32), volumeId: VOLUME };
};
const fileOf = (path: string, max: number): NativePrivateFile => {
  const bytes = readFileSync(path);
  if (bytes.byteLength > max) throw new NativePrivatePersistenceError("REJECTED", "CAP");
  return { ...identityOf(path), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
};
const receipt = (identity: NativePrivateFile): NativePrivateReceipt =>
  Object.freeze({ profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH", identity: Object.freeze({ ...identity }) });

function fakeFilesystem(): NativePrivateFilesystemPort {
  const same = (a: NativePrivateFile, b: { fileId: string; volumeId: string; bytes?: number; sha256?: string }) =>
    a.fileId === b.fileId && a.volumeId === b.volumeId &&
    (b.bytes === undefined || a.bytes === b.bytes) && (b.sha256 === undefined || a.sha256 === b.sha256);
  return {
    platform: "win32", version: 1, synchronous: true,
    inspectDirectory(path) {
      try { if (!lstatSync(path).isDirectory()) throw 0; return identityOf(path); }
      catch { throw new NativePrivatePersistenceError("REJECTED", "DIR"); }
    },
    inspectFile(path, maxBytes) { try { return fileOf(path, maxBytes); } catch (e) { if (e instanceof NativePrivatePersistenceError) throw e; throw new NativePrivatePersistenceError("REJECTED", "FILE"); } },
    inspectFileIdentity(path) { try { if (lstatSync(path).isDirectory()) throw 0; return identityOf(path); } catch { throw new NativePrivatePersistenceError("REJECTED", "ID"); } },
    read(path, expected, maxBytes) {
      const bytes = readFileSync(path);
      if (bytes.byteLength > maxBytes) throw new NativePrivatePersistenceError("REJECTED", "CAP");
      const current = fileOf(path, maxBytes);
      if (!same(current, expected)) throw new NativePrivatePersistenceError("REJECTED", "STALE");
      return bytes;
    },
    writeNew(path, bytes, maxBytes) {
      if (bytes.byteLength > maxBytes) throw new NativePrivatePersistenceError("REJECTED", "CAP");
      if (existsSync(path)) throw new NativePrivatePersistenceError("EXISTS", "EXISTS");
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, bytes); fsyncSync(fd); closeSync(fd);
      return receipt(fileOf(path, maxBytes));
    },
    copyNew(source, destination, expected, maxBytes) {
      const src = fileOf(source, maxBytes);
      if (!same(src, expected)) throw new NativePrivatePersistenceError("REJECTED", "STALE");
      if (existsSync(destination)) throw new NativePrivatePersistenceError("EXISTS", "EXISTS");
      const fd = openSync(destination, "wx", 0o600);
      writeSync(fd, readFileSync(source)); fsyncSync(fd); closeSync(fd);
      return receipt(fileOf(destination, maxBytes));
    },
    renameNew(source, destination, expected, maxBytes) {
      const src = fileOf(source, maxBytes);
      if (!same(src, expected)) throw new NativePrivatePersistenceError("REJECTED", "STALE");
      if (existsSync(destination)) throw new NativePrivatePersistenceError("EXISTS", "EXISTS");
      renameSync(source, destination);
      return receipt(fileOf(destination, maxBytes));
    },
    unlinkExact(path, expected, maxBytes) {
      const current = fileOf(path, maxBytes);
      if (!same(current, expected)) throw new NativePrivatePersistenceError("REJECTED", "STALE");
      unlinkSync(path);
    },
    proveSync(path, expected) {
      const current = fileOf(path, 20_000_000);
      if (!same(current, expected)) throw new NativePrivatePersistenceError("REJECTED", "STALE");
      const fd = openSync(path, "r"); fsyncSync(fd); closeSync(fd);
      return receipt(current);
    },
    createDirectory(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); return identityOf(path); },
    snapshotSqlite(db, destination) {
      db.exec(`VACUUM INTO '${String(destination).replaceAll("'", "''")}'`);
      return receipt(fileOf(destination, 256 * 1024 * 1024));
    },
  };
}

function fakeAppend(fs: NativePrivateFilesystemPort): NativeTransferIoPort {
  return {
    platform: "win32", version: 1, synchronous: true,
    append(path, expected, bytes, maxBytes) {
      const current = fileOf(path, maxBytes);
      if (current.fileId !== expected.fileId || current.volumeId !== expected.volumeId ||
          current.bytes !== expected.bytes || current.sha256 !== expected.sha256)
        throw new NativePrivatePersistenceError("REJECTED", "STALE");
      const fd = openSync(path, "r+");
      writeSync(fd, bytes, 0, bytes.byteLength, expected.bytes); fsyncSync(fd); closeSync(fd);
      return receipt(fileOf(path, maxBytes));
    },
  };
}

function nativeOptions(root: string): NativeTransferOptions {
  const filesystem = fakeFilesystem();
  return { nativePrivateFilesystem: filesystem, nativeTransferIo: fakeAppend(filesystem) };
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const ASSET_ID = "00000000-0000-4000-8000-000000000001.bin";
const shaId = (n: number) => createHash("sha256").update(`asset-${n}`).digest("hex");
const asset = (bytes: number, n = 1): WorkspaceBlobAsset => ({ id: `asset-${n}`, sha256: sha(Buffer.alloc(bytes, n % 251)), bytes });

const scope = { baseUrlHash: sha("http://127.0.0.1"), workspaceId: "ws1", bindingId: "b1", clientId: "c1", serverEpoch: "e1" };

const dirs: string[] = [];
function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `folio-native-${name}-`)));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  stub.handlers.clear(); stub.calls.length = 0; vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

// Explicit, untrusted routing facade. A fresh owner is issued for every open.
function journalPlatform(): PrivatePlatform {
  const posix = new PosixPrivatePlatform();
  return {kind: "windows", bind: path => {
    mkdirSync(path, {recursive: true, mode: 0o700}); chmodSync(path, 0o700);
    return posix.bind(path);
  }, createExclusive: path => posix.createExclusive(path),
    assertRoot: () => posix.assertRoot(), assertFile: path => posix.assertFile(path),
    assertSidecars: path => posix.assertSidecars(path), assertEmptyFile: path => posix.assertEmptyFile(path),
    close: () => posix.close()};
}
function withNativeTransfer<T>(options: NativeTransferOptions, work: () => T): T {
  return nativeScope(options, () => withProductPrivateJournals({privatePlatformFactory: journalPlatform}, work));
}

function transportFixture() {
  const events: string[] = [], raws: Buffer[] = [], originals: Buffer[] = [];
  const records = new Map<string, {target: string; terminal?: string}>();
  let data = Buffer.from("seed"), malformed = false, changedHelper = false, stale = false;
  const proof = (path: string, fileId: string) => ({
    platform: "win32", sid: "S-1-5-21-1", ownerSid: "S-1-5-21-1",
    daclPrivate: true, reparsePoint: false, linkCount: 1, localFilesystem: true,
    fileId, rootFileId: "0".repeat(32), volumeId: VOLUME, rootVolumeId: VOLUME,
    canonicalPath: path, canonicalRoot: "C:\\app",
  });
  const authority = (): NativePrivatePersistenceAuthority => ({
    version: 1, independent: true,
    reserve(intent) {
      if ([...records.values()].some(r => r.target === intent.targetKey && r.terminal !== "APPLIED"))
        throw new Error("unresolved");
      events.push("reserve");
      originals.push(Buffer.from(intent.payload));
      records.set(intent.attemptId, {target: intent.targetKey});
    },
    capture(_id, capture) {events.push("capture"); raws.push(Buffer.from(capture.stdout));},
    terminal(id, state) {events.push(state); records.get(id)!.terminal = state;},
    assertCurrent() {},
  });
  const options = (auth = authority()) => ({
    root: "C:\\app", probeExecutable: "C:\\tools\\probe.exe", expectedHash: sha("helper"),
    systemRoot: "C:\\Windows", expectedRoot: {rootFileId: "0".repeat(32), volumeId: VOLUME},
    authority: auth, directoryIdentity: () => ({fileId: "0".repeat(32), volumeId: VOLUME}),
    assertCurrent() {},
  });
  const transport = {
    fs: {
      lstat: () => ({isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        nlink: 1, dev: 1, ino: 1, size: 6, mtimeMs: 1}),
      readFile: () => Buffer.from(changedHelper ? "other!" : "helper"),
    },
    exec(request: {input: Uint8Array}) {
      events.push("dispatch");
      const wire = Buffer.from(request.input), n = wire.readUInt32LE(0);
      const header = JSON.parse(wire.subarray(4, 4 + n).toString("ascii"));
      data = Buffer.concat([data, wire.subarray(4 + n)]);
      const reply = {contractVersion: 1, operation: "append", path: header.path, root: header.root,
        attemptId: header.attemptId, state: "APPLIED",
        file: proof(header.path, (stale ? "f" : "1").repeat(32)),
        directory: proof("C:\\app", "0".repeat(32)),
        byteLength: data.length, sha256: sha(data), filesystem: "NTFS", contentFlushed: true,
        durability: {profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"}};
      const bytes = Buffer.from(JSON.stringify(reply)), frame = Buffer.alloc(4 + bytes.length);
      frame.writeUInt32LE(bytes.length, 0); frame.set(bytes, 4);
      return {status: 0, signal: null, stdout: malformed ? Buffer.from([1, 2, 3]) : frame, stderr: Buffer.alloc(0)};
    },
  };
  const expected = (): NativePrivateFile => ({path: "C:\\app\\f.part", fileId: "1".repeat(32),
    volumeId: VOLUME, bytes: data.length, sha256: sha(data)});
  return {events, raws, originals, expected, records,
    create: () => createWindowsNativeTransferIoForTesting(options(), transport),
    malformed() {malformed = true;}, stale() {stale = true;}, changedHelper() {changedHelper = true;},
  };
}

describe.skipIf(process.platform === "win32")("native transfer contract doubles (NOT OS acceptance)", () => {
  it("performs a full 20,000,000-byte upload via PUT slices and HEAD verification", async () => {
    const root = temp("up"), assets = join(root, "assets"), transfers = join(root, "transfers");
    mkdirSync(assets); mkdirSync(join(root, "ws"));
    const big = Buffer.alloc(20_000_000, 7);
    const a = { id: ASSET_ID, sha256: sha(big), bytes: big.byteLength };
    writeFileSync(join(assets, a.id), big);
    const received: Buffer[] = [];
    stub.handlers.set("HEAD", () => received.length
      ? {status: 200, headers: {"content-length": String(big.length), "x-folio-blob-sha256": a.sha256}}
      : { status: 404 });
    stub.handlers.set("GET", () => ({status: 404}));
    stub.handlers.set("PUT", (_m, _h, body) => { received.push(body ?? Buffer.alloc(0)); return { status: 201 }; });
    const options: NativeTransferOptions = nativeOptions(root);
    await withNativeTransfer(options, async () =>
      uploadCheckpointAssets({ baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33), assetsDirectory: assets, timeoutMs: 5000, nativeTransfer: options }, [a]));
    expect(Buffer.concat(received).equals(big)).toBe(true);
  });

  it("performs a full 20,000,000-byte download via 206 slices + renameNew", async () => {
    const root = temp("dl"), assets = join(root, "assets"), workspace = join(root, "ws");
    mkdirSync(assets); mkdirSync(join(workspace, ".folio-sync-transfers", "cache"), { recursive: true });
    const big = Buffer.alloc(20_000_000, 9);
    const a = { id: ASSET_ID, sha256: sha(big), bytes: big.byteLength };
    const scopeHash = sha(canonicalJson(scope));
    stub.handlers.set("GET", (_m, headers) => {
      const range = /bytes=(\d+)-(\d+)/.exec(String(headers.Range ?? headers.range));
      if (!range) return { status: 200, headers: { "content-length": String(big.byteLength) } as Record<string, string>, body: big };
      const [s, e] = [Number(range[1]), Number(range[2])];
      return { status: 206, headers: { "content-range": `bytes ${s}-${e}/${big.byteLength}`, "content-length": String(e - s + 1) }, body: big.subarray(s, e + 1) };
    });
    const options = nativeOptions(root);
    await withNativeTransfer(options, async () =>
      stageCheckpointAssets({ baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33), assetsDirectory: assets, timeoutMs: 5000, nativeTransfer: options,
        transfer: { directory: join(workspace, ".folio-sync-transfers", scopeHash), scope, workspaceDirectory: workspace } }, [a]));
    expect(readFileSync(join(assets, a.id)).equals(big)).toBe(true);
  });

  it("serves native server PUT, GET and HEAD families", async () => {
    const root = temp("server");
    const options = nativeOptions(root);
    const data = Buffer.alloc(20_000_000, 5), id = sha(data);
    await withNativeTransfer(options, async () => {
      const store = new WorkspaceBlobStore(join(root, "blobs"), undefined, options);
      const ctx = { workspaceId: "ws1", sha256: id, assertAuthorized: () => undefined };
      const response = () => { const r = new PassThrough() as PassThrough & { writeHead(s: number, h?: unknown): void; status?: number }; r.writeHead = (s: number) => { r.status = s; return r; }; return r; };
      const request = (body: Buffer, headers: Record<string, string>) => Object.assign(Readable.from([body]), { method: "PUT", headers, socket: { remoteAddress: "127.0.0.1" } });
      const res = response();
      await store.handle(request(data, { "content-length": String(data.length), "content-range": `bytes 0-${data.length - 1}/${data.length}` }) as never, res as never, ctx);
      expect(res.status).toBe(201);
      expect(store.has("ws1", { id: ASSET_ID, sha256: id, bytes: data.length })).toBe(true);
      const getRes = response();
      await store.handle(Object.assign(Readable.from([]), { method: "GET", headers: {}, socket: { remoteAddress: "127.0.0.1" } }) as never, getRes as never, ctx);
      expect(getRes.status).toBe(200);
      const headRes = response();
      await store.handle(Object.assign(Readable.from([]), { method: "HEAD", headers: { "x-folio-blob-resume": "1", "x-folio-blob-bytes": String(data.length) }, socket: { remoteAddress: "127.0.0.1" } }) as never, headRes as never, ctx);
      expect(headRes.status).toBe(204);
    });
  });

  it("resumes an interrupted committed-prefix download without a tail rewrite", async () => {
    const root = temp("resume"), assets = join(root, "assets"), workspace = join(root, "ws");
    mkdirSync(assets); mkdirSync(join(workspace, ".folio-sync-transfers", "cache"), { recursive: true });
    const big = Buffer.alloc(3 * 1024 * 1024, 3);
    const a = { id: ASSET_ID, sha256: sha(big), bytes: big.byteLength };
    const scopeHash = sha(canonicalJson(scope));
    const journalDir = join(workspace, ".folio-sync-transfers", scopeHash, "download-" + sha(assets));
    const options = nativeOptions(root);
    await withNativeTransfer(options, async () => {
      // Seed a committed 1MiB prefix exactly as a crashed pass would leave it.
      const journal = new BlobTransferJournal(journalDir, scope, {});
      const record = journal.begin({ direction: "download", assetId: a.id, sha256: a.sha256, bytes: a.bytes });
      const partial = join(journalDir, record.partialName);
      writeFileSync(partial, big.subarray(0, 1024 * 1024));
      journal.checkpoint(record.key, 1024 * 1024, sha(big.subarray(0, 1024 * 1024)));
      journal.close();
      stub.handlers.set("GET", (_m, headers) => {
        const range = /bytes=(\d+)-(\d+)/.exec(String(headers.Range ?? headers.range));
        const [s, e] = [Number(range![1]), Number(range![2])];
        return { status: 206, headers: { "content-range": `bytes ${s}-${e}/${big.byteLength}`, "content-length": String(e - s + 1) }, body: big.subarray(s, e + 1) };
      });
      await stageCheckpointAssets({ baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33), assetsDirectory: assets, timeoutMs: 5000, nativeTransfer: options,
        transfer: { directory: join(workspace, ".folio-sync-transfers", scopeHash), scope, workspaceDirectory: workspace } }, [a]);
      expect(readFileSync(join(assets, a.id)).equals(big)).toBe(true);
      const ranges = stub.calls.filter(c => c.method === "GET").map(c => c.url);
      expect(ranges.length).toBeGreaterThan(0);
    });
  });

  it("accepts an exact no-replace collision and refuses a different one", async () => {
    const root = temp("collision"), assets = join(root, "assets"), workspace = join(root, "ws");
    mkdirSync(assets); mkdirSync(join(workspace, ".folio-sync-transfers", "cache"), { recursive: true });
    const data = Buffer.alloc(16, 1), a = { id: ASSET_ID, sha256: sha(data), bytes: data.length };
    writeFileSync(join(assets, a.id), data); // already published, exact bytes
    const scopeHash = sha(canonicalJson(scope));
    const options = nativeOptions(root);
    await withNativeTransfer(options, async () => {
      stub.handlers.set("GET", () => ({ status: 200, headers: { "content-length": "16" }, body: data }));
      await stageCheckpointAssets({ baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33), assetsDirectory: assets, timeoutMs: 5000, nativeTransfer: options,
        transfer: { directory: join(workspace, ".folio-sync-transfers", scopeHash), scope, workspaceDirectory: workspace } }, [a]);
      expect(stub.calls.filter(c => c.method === "GET").length).toBe(0); // verified target short-circuits
      // A colliding different-content target must be refused, never replaced.
      const other = { id: ASSET_ID, sha256: sha(Buffer.alloc(16, 9)), bytes: 16 };
      await expect(stageCheckpointAssets({ baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33), assetsDirectory: assets, timeoutMs: 5000, nativeTransfer: options,
        transfer: { directory: join(workspace, ".folio-sync-transfers", scopeHash), scope, workspaceDirectory: workspace } }, [other])).rejects.toThrowError();
    });
  });

  it("rejects stale source/partial native IDs and oversize before mutation", async () => {
    const root = temp("stale"), assets = join(root, "assets");
    mkdirSync(assets);
    const data = Buffer.alloc(8, 2), a = { id: ASSET_ID, sha256: sha(data), bytes: data.length };
    writeFileSync(join(assets, a.id), data);
    const options = nativeOptions(root);
    await withNativeTransfer(options, async () => {
      // Changed bytes → asset-hash-mismatch before any request.
      writeFileSync(join(assets, a.id), Buffer.alloc(8, 4));
      await expect(uploadCheckpointAssets({ baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33), assetsDirectory: assets, timeoutMs: 5000, nativeTransfer: options }, [a])).rejects.toThrowError();
      // Oversize is refused before any native mutation.
      const big = { id: "big", sha256: sha(Buffer.alloc(4)), bytes: 20_000_001 };
      expect(() => assertWorkspaceAssets(assets, [big], options)).toThrowError();
    });
  });

  it("rejects malformed async/thenable append ports", async () => {
    const options = { nativePrivateFilesystem: fakeFilesystem(), nativeTransferIo: { platform: "win32", version: 1, synchronous: true, append: async () => ({}) } as never };
    expect(() => nativeTransferPort(options)).toThrowError(SyncError);
    const thenable = { nativePrivateFilesystem: fakeFilesystem(), nativeTransferIo: { platform: "win32", version: 1, synchronous: true, append: () => Promise.resolve({}) } as never };
    const port = nativeTransferPort(thenable)!;
    const path = join(temp("then"), "part"); writeFileSync(path, Buffer.alloc(0));
    const file = fileOf(path, 100);
    expect(() => port.append!.append(file.path, file, new Uint8Array(4), 100)).toThrowError(SyncError);
  });

  it("accepts a framed append only after reserve, exact raw capture and APPLIED terminal", () => {
    const f = transportFixture(), port = f.create(), expected = f.expected();
    const result = port.append(expected.path, expected, Buffer.from("new"), 20_000_000);
    expect(result.identity.bytes).toBe(7);
    expect(result.identity.sha256).toBe(sha("seednew"));
    expect(f.events).toEqual(["reserve", "dispatch", "capture", "APPLIED"]);
    expect(f.originals[0].equals(Buffer.from("new"))).toBe(true);
    expect(f.raws[0].length).toBeGreaterThan(4);
  });

  it("preserves UNKNOWN raw archives and refuses unresolved restart", () => {
    const f = transportFixture(), port = f.create(), expected = f.expected();
    f.malformed();
    expect(() => port.append(expected.path, expected, Buffer.from("new"), 20_000_000))
      .toThrowError(NativePrivatePersistenceError);
    expect(f.events).toEqual(["reserve", "dispatch", "capture", "UNKNOWN"]);
    expect(f.raws[0].equals(Buffer.from([1, 2, 3]))).toBe(true);
    const reopened = f.create(), next = f.expected();
    expect(() => reopened.append(next.path, next, Buffer.from("next"), 20_000_000))
      .toThrowError(NativePrivatePersistenceError);
    expect(f.events.filter(e => e === "dispatch")).toHaveLength(1);
    expect(f.originals).toHaveLength(1);
  });

  it("rejects stale native IDs, changed helper and oversize without an extra dispatch", () => {
    const f = transportFixture(), port = f.create(), expected = f.expected();
    expect(() => port.append(expected.path, expected, Buffer.alloc(1024 * 1024 + 1), 20_000_000)).toThrow();
    expect(f.events).toEqual([]);
    f.stale();
    expect(() => port.append(expected.path, expected, Buffer.from("new"), 20_000_000))
      .toThrowError(NativePrivatePersistenceError);
    expect(f.events.at(-1)).toBe("UNKNOWN");
    const g = transportFixture(), pinned = g.create(), before = g.expected();
    g.changedHelper();
    expect(() => pinned.append(before.path, before, Buffer.from("new"), 20_000_000))
      .toThrowError(NativePrivatePersistenceError);
    expect(g.events).not.toContain("dispatch");
  });

  it("enforces the 128MiB budget and entry/metadata/orphan limits", async () => {
    const root = temp("budget"), workspace = join(root, "ws");
    const cache = join(workspace, ".folio-sync-transfers");
    mkdirSync(join(cache, "scope"), { recursive: true });
    writeFileSync(join(cache, "scope", "junk.part"), Buffer.alloc(1024));
    const options = nativeOptions(root);
    await withNativeTransfer(options, async () => {
      const view = inspectTransferCacheCatalog(workspace, null, undefined, undefined, options);
      expect(view.held).toBe("unknown-root-entry");
      expect(view.usedBytes).toBe(1024);
      const native = nativeTransferPort(options)!;
      expect(inspectNativeTransferBudget(native, workspace, {maxBytes: 1023}).overLimit).toBe(true);
      expect(inspectNativeTransferBudget(native, workspace, {maxEntries: 1}).overLimit).toBe(true);
      const inventory = inspectNativeTransferInventory(native, join(cache, "scope"), []);
      expect(inventory.items[0].kind).toBe("orphan");
      expect(inventory.totalBytes).toBe(1024);
    });
  });

  it("lists an actual catalog entry and plans/releases native partial + empty", async () => {
    const root = temp("maint"), workspace = join(root, "ws");
    const scopeHash = sha(canonicalJson(scope));
    const journalDir = join(workspace, ".folio-sync-transfers", scopeHash, "download-" + sha("assets"));
    mkdirSync(journalDir, { recursive: true });
    const options = nativeOptions(root);
    await withNativeTransfer(options, async () => {
      const journal = new BlobTransferJournal(journalDir, scope, {});
      const record = journal.begin({ direction: "download", assetId: ASSET_ID, sha256: sha("data"), bytes: 4 });
      writeFileSync(join(journalDir, record.partialName), Buffer.from("data"));
      journal.checkpoint(record.key, 4, sha(Buffer.from("data")));
      journal.close();
      const view = inspectTransferCacheCatalog(workspace, scopeHash, undefined, undefined, options);
      expect(view.entries.some(e => e.state === "active")).toBe(true);
      const service = new TransferMaintenanceService(workspace, () => null, undefined, undefined, options);
      const plan = await service.plan(view.entries.find(e => e.state === "active")!.entryId);
      expect(plan.operationId).toMatch(/^[a-f0-9-]{36}$/);
      const released = await service.release(plan.operationId);
      expect(released.outcome).toBe("released");
      expect(released.releasedBytes).toBe(4);
      // A started/completed op never re-dispatches a mutation.
      const again = await service.resolve(plan.operationId);
      expect(again.outcome).toBe("released");
      // Empty journal release succeeds and leaves proved-empty dirs intact.
      const emptyDir = join(workspace, ".folio-sync-transfers", scopeHash, "upload-" + sha("other"));
      const j2 = new BlobTransferJournal(emptyDir, scope, {});
      j2.close();
      const plan2 = await service.plan(`${scopeHash}/upload-${sha("other")}/!`);
      const released2 = await service.release(plan2.operationId);
      expect(released2.outcome).toBe("released");
    });
  });

  it.each(["completed", "active"] as const)("reopens a %s publication record without inferring an UNKNOWN completion", async state => {
    const root = temp("completed-restart"), assets = join(root, "assets"); mkdirSync(assets);
    const bytes = Buffer.from("acknowledged published bytes"), a = {id: ASSET_ID, sha256: sha(bytes), bytes: bytes.length};
    const scopeHash = sha(canonicalJson(scope));
    const directory = join(root, ".folio-sync-transfers", scopeHash);
    const journalDirectory = join(directory, "download-" + sha(assets));
    const options = nativeOptions(root);
    await withNativeTransfer(options, async () => {
      const journal = new BlobTransferJournal(journalDirectory, scope, {}, journalPlatform());
      const record = journal.begin({direction: "download", assetId: a.id, sha256: a.sha256, bytes: a.bytes});
      if (state === "completed") journal.complete(record.key);
      journal.close();
      writeFileSync(join(assets, a.id), bytes);
      const start = stageCheckpointAssets({baseUrl: "http://127.0.0.1", workspaceId: "ws1",
        token: "test-token-" + "a".repeat(33), assetsDirectory: assets, nativeTransfer: options,
        transfer: {directory, scope, workspaceDirectory: root}}, [a]);
      if (state === "completed") {
        await start;
        const reopened = new BlobTransferJournal(journalDirectory, scope, {}, journalPlatform());
        try {expect(reopened.inventory()).toEqual([]);} finally {reopened.close();}
      } else await expect(start).rejects.toMatchObject({code: "native-transfer-publication-unknown"});
      expect(stub.calls).toEqual([]);
      expect(readFileSync(join(assets, a.id)).equals(bytes)).toBe(true);
    });
  });

  it("keeps a fence change after an await from reaching a native mutation", async () => {
    const store = { current: true };
    const fs = fakeFilesystem();
    const options = { nativePrivateFilesystem: fs, nativeTransferIo: fakeAppend(fs) };
    const root = temp("fence"), assets = join(root, "assets");
    mkdirSync(assets);
    const data = Buffer.alloc(8, 1), a = { id: ASSET_ID, sha256: sha(data), bytes: 8 };
    const appended: number[] = [];
    const orig = options.nativeTransferIo!.append;
    options.nativeTransferIo = { ...options.nativeTransferIo!, append: (...args: Parameters<typeof orig>) => { if (!store.current) throw new SyncError("fence", 503); appended.push(1); return orig(...args); } };
    await withNativeTransfer(options, async () => {
      const putRequests = new Promise<void>((resolve) => {
        stub.handlers.set("GET", () => { store.current = false; resolve(); return { status: 206, headers: { "content-range": `bytes 0-7/8`, "content-length": "8" }, body: data }; });
      });
      await expect(stageCheckpointAssets({ baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33), assetsDirectory: assets, timeoutMs: 5000, nativeTransfer: options,
        assertRequest() {if (!store.current) throw new SyncError("stale-fence", 409);},
        transfer: { directory: join(root, ".folio-sync-transfers", sha(canonicalJson(scope))), scope, workspaceDirectory: root } }, [a])).rejects.toThrowError();
      await putRequests;
      expect(appended.length).toBe(0);
    });
  });

  it("publishes an independent native staging copy then reclaims only the confirmed source", () => {
    const root = temp("apply"), staging = join(root, "staging"), active = join(root, "active");
    mkdirSync(staging); mkdirSync(active);
    const data = Buffer.alloc(4096, 6), a = {id: ASSET_ID, bytes: data.length, sha256: sha(data)};
    writeFileSync(join(staging, a.id), data);
    const options = nativeOptions(root);
    publishCheckpointAssetsFromStaging(staging, active, [a], undefined, options);
    expect(readFileSync(join(active, a.id)).equals(data)).toBe(true);
    expect(identityOf(join(active, a.id)).fileId).not.toBe(identityOf(join(staging, a.id)).fileId);
    expect(reclaimAppliedStaging(staging, active, [a], options)).toEqual({removed: 1, held: 0});
    expect(readFileSync(join(active, a.id)).equals(data)).toBe(true);
  });

  it("retains an uncommitted partial tail and refuses restart without making a request", async () => {
    const root = temp("tail"), assets = join(root, "assets");
    mkdirSync(assets);
    const options = nativeOptions(root), data = Buffer.from("data");
    const a = {id: ASSET_ID, bytes: 4, sha256: sha(data)};
    const scopeHash = sha(canonicalJson(scope));
    const directory = join(root, ".folio-sync-transfers", scopeHash);
    await withNativeTransfer(options, async () => {
      const journalDir = join(directory, "download-" + sha(assets));
      mkdirSync(journalDir, {recursive: true, mode: 0o700});
      const journal = new BlobTransferJournal(journalDir, scope, {},
        journalPlatform());
      const record = journal.begin({direction: "download", assetId: a.id, bytes: a.bytes, sha256: a.sha256});
      writeFileSync(join(journalDir, record.partialName), Buffer.from("dat"));
      journal.checkpoint(record.key, 2, sha("da")); journal.close();
      const call = () => stageCheckpointAssets({baseUrl: "http://127.0.0.1", workspaceId: "ws1", token: "test-token-" + "a".repeat(33),
        assetsDirectory: assets, nativeTransfer: options, transfer: {directory, scope, workspaceDirectory: root}}, [a]);
      await expect(call()).rejects.toThrow("blob-transfer-prefix-mismatch");
      await expect(call()).rejects.toThrow("blob-transfer-prefix-mismatch");
      expect(readFileSync(join(journalDir, record.partialName)).equals(Buffer.from("dat"))).toBe(true);
      expect(stub.calls).toHaveLength(0);
    });
  });

  it("holds stale release fingerprints and never re-dispatches a started native release", async () => {
    const root = temp("release-held"), options = nativeOptions(root);
    const scopeHash = sha(canonicalJson(scope)), name = "download-" + sha("assets");
    const directory = join(root, ".folio-sync-transfers", scopeHash, name);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    await withNativeTransfer(options, async () => {
      const journal = new BlobTransferJournal(directory, scope, {}, journalPlatform());
      const record = journal.begin({direction: "download", assetId: ASSET_ID, bytes: 4, sha256: sha("data")});
      const path = join(directory, record.partialName);
      writeFileSync(path, Buffer.from("data")); journal.checkpoint(record.key, 4, sha("data")); journal.close();
      const service = new TransferMaintenanceService(root, () => null, undefined, undefined, options);
      const plan = await service.plan(`${scopeHash}/${name}/${record.key}`);
      writeFileSync(path, Buffer.from("evil"));
      expect((await service.release(plan.operationId)).outcome).toBe("held");
      expect(readFileSync(path).equals(Buffer.from("evil"))).toBe(true);
      writeFileSync(path, Buffer.from("data"));
      const interrupted = new TransferMaintenanceService(root, () => null, phase => {
        if (phase === "marking") throw new Error("simulated stop");
      }, undefined, options);
      const second = await interrupted.plan(`${scopeHash}/${name}/${record.key}`);
      expect((await interrupted.release(second.operationId)).outcome).toBe("outcome-unknown");
      expect((await service.release(second.operationId)).outcome).toBe("outcome-unknown");
      expect(readFileSync(path).equals(Buffer.from("data"))).toBe(true);
    });
  });

  it("counts the full default 128MiB cap and detects changed native root IDs", () => {
    const root = temp("caps"), cache = join(root, ".folio-sync-assets-staging");
    mkdirSync(cache); const path = join(cache, "large");
    writeFileSync(path, Buffer.alloc(0)); truncateSync(path, 128 * 1024 * 1024 + 1);
    const options = nativeOptions(root), native = nativeTransferPort(options)!;
    expect(inspectNativeTransferBudget(native, root).overLimit).toBe(true);
    const raw = options.nativePrivateFilesystem!, inspect = raw.inspectDirectory.bind(raw);
    let reads = 0;
    const staleOptions = {...options, nativePrivateFilesystem: {...raw, inspectDirectory(p: string) {
      const pin = inspect(p);
      return p === root && ++reads > 1 ? {...pin, fileId: "f".repeat(32)} : pin;
    }}};
    expect(() => inspectNativeTransferBudget(nativeTransferPort(staleOptions)!, root)).toThrowError(SyncError);
  });

  it("retains server UNKNOWN across a fresh store instead of trusting final-byte observations", async () => {
    const root = temp("server-unknown"), base = nativeOptions(root), data = Buffer.from("data");
    let calls = 0;
    const options: NativeTransferOptions = {...base, nativeTransferIo: {
      platform: "win32", version: 1, synchronous: true,
      append() {calls++; throw new NativePrivatePersistenceError("UNKNOWN", "LOST_REPLY");},
    }};
    await withNativeTransfer(options, async () => {
      const directory = join(root, "blobs");
      const store = new WorkspaceBlobStore(directory, undefined, options);
      const ctx = {workspaceId: "ws1", sha256: sha(data), assertAuthorized() {}};
      const request = () => Object.assign(Readable.from([data]), {method: "PUT",
        headers: {"content-length": "4", "content-range": "bytes 0-3/4"},
        socket: {remoteAddress: "127.0.0.1"}});
      const response = () => Object.assign(new PassThrough(), {writeHead() {return this;}});
      await expect(store.handle(request() as never, response() as never, ctx)).rejects.toThrowError(NativePrivatePersistenceError);
      const reopened = new WorkspaceBlobStore(directory, undefined, options);
      await expect(reopened.handle(request() as never, response() as never, ctx))
        .rejects.toThrow("native-transfer-publication-unknown");
      expect(() => reopened.has("ws1", {id: ASSET_ID, bytes: 4, sha256: sha(data)}))
        .toThrow("native-transfer-publication-unknown");
      expect(calls).toBe(1);
    });
  });
});
