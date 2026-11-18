import { types as utilTypes } from "node:util";
import { Worker } from "node:worker_threads";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { CollaborationError } from "../../collaboration/runtime/contract";
import type { HotJournalSnapshot, PrivatePlatform } from "../../sync/private-platform";
import { asciiCaseFold, assertWindowsProbe, validateWindowsPath } from "./path-policy";

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_AUTHORITY_LEASE_${code}`);
}

/**
 * A native-owned held scope over the recovery archive's database file. This
 * is NOT a liveness proof of any process: the only valid implementation is a
 * dedicated helper holding the pinned file open with restricted sharing for
 * the whole writable-SQLite window. A marker file, PID or boolean can never
 * satisfy this contract.
 */
export interface PrivateAuthorityLease {
  readonly trust: "native-owned-helper" | "untrusted-test";
  /** Synchronous; returns undefined while held, throws the moment the scope
   * is lost. Never async. */
  assertHeld(): void;
  close(): void;
}

export type AcquirePrivateAuthorityLease = (databasePath: string) => PrivateAuthorityLease;

/**
 * Module-local brand: production `withPrivateAuthorityLease` accepts ONLY an
 * acquirer minted by `createNativeAuthorityLeaseAcquirer`, so a caller-chosen
 * function can never silently stand in for the owned helper.
 */
const trustedAcquirers = new WeakSet<AcquirePrivateAuthorityLease>();
const trustedPlatforms = new WeakSet<object>();
export const isAuthorityLeasePlatform = (platform: object): boolean => trustedPlatforms.has(platform);

export type NativeAuthorityLeaseOptions = Readonly<{
  root: string; probeExecutable: string; expectedHash: string; systemRoot: string;
  expectedRoot: Readonly<{rootFileId: string; volumeId: string}>;
  /** Re-prove the archive immediately before acquiring it, including its
   * persistent source/state-file binding. Fresh IDs alone are not restart
   * authority to initialize a replacement archive. */
  identityFor(databasePath: string): Readonly<{directoryFileId: string; directoryVolumeId: string; fileId: string; volumeId: string}>;
}>;

// A worker owns precisely one spawned helper and its pipes. The synchronous
// owner exchanges bounded receipts over shared memory, never PID adoption or
// a marker file. A CLOSE receipt is acknowledged only after CLOSED + exit(0).
const leaseWorker = String.raw`
const {parentPort,workerData}=require("node:worker_threads");
const {spawn}=require("node:child_process");
const {readFileSync,lstatSync}=require("node:fs");
const {createHash}=require("node:crypto");
const state=new Int32Array(workerData.shared,0,4);
const output=new Uint8Array(workerData.shared,16);
let pending=0, child, stdout=Buffer.alloc(0), stderr=Buffer.alloc(0), closedReply, exited=false, badOutput=false;
function complete(value,seq=pending){
 if(seq===null)return;
 let bytes=Buffer.from(JSON.stringify(value));
 if(bytes.length>output.length)bytes=Buffer.from('{"error":"RECEIPT_LIMIT"}');
 output.fill(0);output.set(bytes);
 Atomics.store(state,1,bytes.length);Atomics.store(state,0,seq);Atomics.notify(state,0);
 pending=null;
}
function broken(code){Atomics.store(state,3,1);complete({error:code});}
try{
 const before=lstatSync(workerData.exe), bytes=readFileSync(workerData.exe), after=lstatSync(workerData.exe);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||
    before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||
    createHash("sha256").update(bytes).digest("hex")!==workerData.hash)throw Error("HELPER_PIN");
 child=spawn(workerData.exe,["--private-authority-lease"],{
  cwd:workerData.systemRoot,env:workerData.env,shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"]
 });
 child.on("error",()=>broken("SPAWN"));
 child.stdin.on("error",()=>broken("PIPE"));
 child.stdout.on("data",chunk=>{
  if(badOutput)return;
  if(chunk.length>8193-stdout.length){badOutput=true;stdout=Buffer.alloc(0);broken("OUTPUT_LIMIT");return;}
  stdout=Buffer.concat([stdout,chunk]);
  const end=stdout.indexOf(10);
  if(end<0)return;
  if(end!==stdout.length-1){broken("EXTRA_OUTPUT");return;}
  const line=stdout.subarray(0,end);stdout=Buffer.alloc(0);
  if([...line].some(b=>b<32||b>126)){broken("OUTPUT");return;}
  let reply;try{reply=JSON.parse(line.toString("ascii"));}catch{broken("JSON");return;}
  if(pending===null||reply.nonce!==workerData.request.nonce||reply.sequence!==pending){broken("SEQUENCE");return;}
  if(reply.state==="CLOSED"){closedReply=reply;return;}
  if(reply.state!=="HELD"){broken("STATE");return;}
  complete({reply});
 });
 child.stderr.on("data",chunk=>{
  stderr=Buffer.concat([stderr,chunk.subarray(0,Math.max(0,8192-stderr.length))]);
  broken("HELPER_STDERR");
 });
 child.on("close",(code,signal)=>{
  exited=true;
  if(pending!==null&&closedReply&&code===0&&signal===null&&stderr.length===0)complete({reply:closedReply});
  else broken("HELPER_EXIT");
  Atomics.store(state,2,1);Atomics.notify(state,0);
  parentPort.close();
 });
 parentPort.on("message",message=>{
  if(pending!==null||exited){complete({error:"BUSY_OR_CLOSED"},message.sequence);return;}
  pending=message.sequence;
  if(!["CHECK","CLOSE"].includes(message.command)){broken("COMMAND");return;}
  child.stdin.write(JSON.stringify({command:message.command,nonce:workerData.request.nonce,sequence:message.sequence})+"\n");
 });
 child.stdin.write(JSON.stringify(workerData.request)+"\n");
}catch{broken("START");}
`;
const retainedWorkers = new Set<Worker>();
const TIMEOUT_MS = 15_000;
function canonicalPath(value: string): string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Z]:\\[\x20-\x7e]*$/.test(value) ||
      validateWindowsPath(value, `${value[0]}:\\`).canonical !== value) fail("PATH");
  return value;
}
function helperPin(path: string, hash: string): string {
  const before = lstatSync(path), bytes = readFileSync(path), after = lstatSync(path);
  const pin = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      pin(before) !== pin(after) || createHash("sha256").update(bytes).digest("hex") !== hash) fail("HELPER_PIN");
  return pin(after);
}

/** Native helper execution is only selected on Windows. Contract tests use the
 * explicitly untrusted wrapper below and never exercise this factory. */
export function createNativeAuthorityLeaseAcquirer(options: NativeAuthorityLeaseOptions): AcquirePrivateAuthorityLease {
  if (process.platform !== "win32") fail("PLATFORM");
  const root = canonicalPath(options.root), executable = canonicalPath(options.probeExecutable),
    systemRoot = canonicalPath(options.systemRoot), hash = options.expectedHash;
  if (!/\.exe$/i.test(executable) || !/^[0-9a-f]{64}$/.test(hash) || isAsyncLike(options.identityFor)) fail("OPTIONS");
  const rootFileId = options.expectedRoot.rootFileId, rootVolumeId = options.expectedRoot.volumeId;
  if (!/^[a-fA-F0-9]{32}$/.test(rootFileId) || !/^[a-fA-F0-9]{16}$/.test(rootVolumeId)) fail("IDENTITY");
  const identityFor = options.identityFor, pin = helperPin(executable, hash);
  const acquire: AcquirePrivateAuthorityLease = (databasePath) => {
    const path = canonicalPath(databasePath), parent = win32.dirname(path);
    if (validateWindowsPath(path, root).canonical !== path || asciiCaseFold(path) === asciiCaseFold(root)) fail("PATH");
    const identity = identityFor(path);
    if (!identity || utilTypes.isPromise(identity) || typeof (identity as {then?: unknown}).then === "function" ||
        !/^[a-fA-F0-9]{32}$/.test(identity.fileId) || !/^[a-fA-F0-9]{32}$/.test(identity.directoryFileId) ||
        asciiCaseFold(identity.volumeId) !== asciiCaseFold(rootVolumeId) ||
        asciiCaseFold(identity.directoryVolumeId) !== asciiCaseFold(rootVolumeId)) fail("IDENTITY");
    const request = Object.freeze({contractVersion: 1, nonce: randomBytes(16).toString("hex"), root, path,
      rootFileId, rootVolumeId, directoryFileId: identity.directoryFileId, directoryVolumeId: identity.directoryVolumeId,
      fileId: identity.fileId, volumeId: identity.volumeId});
    if (helperPin(executable, hash) !== pin) fail("HELPER_PIN");
    if (retainedWorkers.size >= 64) fail("OWNED_SCOPE_CAPACITY");
    const shared = new SharedArrayBuffer(16 + 16 * 1024), state = new Int32Array(shared, 0, 4);
    Atomics.store(state, 0, -1);
    const worker = new Worker(leaseWorker, {eval: true, workerData: {
      shared, request, exe: executable, hash, systemRoot,
      env: {SystemRoot: systemRoot, windir: systemRoot, TEMP: win32.join(systemRoot, "Temp"), TMP: win32.join(systemRoot, "Temp")},
    }});
    retainedWorkers.add(worker); worker.unref();
    worker.on("error", () => { Atomics.store(state, 2, 1); Atomics.notify(state, 0); });
    let sequence = 0, closed = false, failure: unknown;
    const exchange = (command?: "CHECK" | "CLOSE"): void => {
      if (command) { sequence++; worker.postMessage({command, sequence}); }
      const deadline = Date.now() + TIMEOUT_MS;
      while (Atomics.load(state, 0) !== sequence) {
        if (Atomics.load(state, 2) !== 0 || Date.now() >= deadline) fail("UNKNOWN");
        const previous = Atomics.load(state, 0);
        Atomics.wait(state, 0, previous, Math.max(1, deadline - Date.now()));
      }
      const size = Atomics.load(state, 1);
      if (size <= 0 || size > 16 * 1024) fail("UNKNOWN");
      const result = JSON.parse(Buffer.from(new Uint8Array(shared, 16, size)).toString("utf8"));
      const reply = result.reply;
      if (result.error || !reply || reply.contractVersion !== 1 || reply.nonce !== request.nonce ||
          reply.sequence !== sequence || reply.state !== (command === "CLOSE" ? "CLOSED" : "HELD")) fail("UNKNOWN");
      if (command !== "CLOSE") {
        if (Atomics.load(state, 2) !== 0 || Atomics.load(state, 3) !== 0 || helperPin(executable, hash) !== pin) fail("UNKNOWN");
        assertWindowsProbe(reply.file, {canonicalPath: path, canonicalRoot: root});
        assertWindowsProbe(reply.directory, {canonicalPath: parent, canonicalRoot: root});
        for (const [actual, expected] of [[reply.file.fileId, request.fileId],
          [reply.directory.fileId, request.directoryFileId], [reply.file.rootFileId, rootFileId],
          [reply.directory.rootFileId, rootFileId], [reply.file.volumeId, rootVolumeId],
          [reply.directory.volumeId, rootVolumeId]]) {
          if (typeof actual !== "string" || asciiCaseFold(actual) !== asciiCaseFold(expected)) fail("IDENTITY");
        }
        if (reply.file.sid !== reply.directory.sid) fail("IDENTITY");
      }
    };
    try { exchange(); } catch (error) {
      // Keep the actual owned worker reference. A lost READY is not evidence
      // of a non-acquired lease; do not adopt/kill an arbitrary process.
      failure = error;
      try { exchange("CLOSE"); closed = true; retainedWorkers.delete(worker); } catch {}
      throw error;
    }
    return Object.freeze({trust: "native-owned-helper" as const,
      assertHeld() {
        if (failure !== undefined) throw failure;
        if (closed) fail("CLOSED");
        try { exchange("CHECK"); } catch (error) { failure = error; throw error; }
      },
      close() {
        if (closed) return;
        try { exchange("CLOSE"); closed = true; retainedWorkers.delete(worker); }
        catch (error) { failure = error; throw error; }
      },
    });
  };
  trustedAcquirers.add(acquire);
  return acquire;
}

function isAsyncLike(value: unknown): boolean {
  return typeof value !== "function" ||
    utilTypes.isAsyncFunction(value) || utilTypes.isGeneratorFunction(value);
}

function checkHeld(lease: PrivateAuthorityLease): void {
  if (isAsyncLike(lease.assertHeld)) fail("HELD");
  const outcome: unknown = lease.assertHeld();
  if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
  if (outcome !== undefined) fail("HELD");
}

function wrap(
  platform: PrivatePlatform,
  acquire: AcquirePrivateAuthorityLease,
  trust: PrivateAuthorityLease["trust"],
): PrivatePlatform {
  if (platform === null || typeof platform !== "object" || isAsyncLike(acquire)) fail("ACQUIRE");
  let lease: PrivateAuthorityLease | undefined;
  let poisoned: unknown;
  let closed = false;
  const requireHeld = (): PrivateAuthorityLease => {
    if (poisoned !== undefined) throw poisoned;
    if (lease === undefined) fail("UNHELD");
    try { checkHeld(lease); } catch (error) { poisoned = error; throw error; }
    return lease;
  };
  const members: {
    -readonly [K in keyof PrivatePlatform]: PrivatePlatform[K];
  } = {
    kind: "windows" as const,
    bind(directory: string): string {
      if (closed) fail("CLOSED");
      const bound = platform.bind(directory);
      if (typeof bound !== "string" || bound.length === 0) fail("BIND");
      return bound;
    },
    assertRoot(): void { requireHeld(); platform.assertRoot(); },
    assertFile(path: string): void { requireHeld(); platform.assertFile(path); },
    assertSidecars(path: string): void { requireHeld(); platform.assertSidecars(path); },
    // The exclusive file is created first, THEN the owned scope is acquired
    // on it — before ANY writable SQLite open can follow.
    createExclusive(path: string): void {
      if (closed) fail("CLOSED");
      if (lease !== undefined) fail("ACQUIRE");
      if (poisoned !== undefined) throw poisoned;
      platform.createExclusive(path);
      let acquired: unknown;
      try { acquired = acquire(path); } catch (error) { poisoned = error; throw error; }
      try {
        if (utilTypes.isPromise(acquired)) Promise.prototype.then.call(acquired, undefined, () => undefined);
        if (utilTypes.isPromise(acquired) || acquired === null || typeof acquired !== "object" ||
            typeof (acquired as {then?: unknown}).then === "function") fail("ACQUIRE");
        const candidate = acquired as PrivateAuthorityLease;
        if (candidate.trust !== trust || isAsyncLike(candidate.assertHeld) || isAsyncLike(candidate.close))
          fail("ACQUIRE");
        // Keep ownership before the proof, including failed READY cleanup.
        lease = candidate;
        checkHeld(candidate);
      } catch (error) {
        poisoned = error;
        throw error;
      }
    },
    assertEmptyFile(path: string): void { requireHeld(); platform.assertEmptyFile(path); },
    close(): void {
      // The archive closes its DatabaseSync first; the wrapper then confirms
      // the lease close and only afterwards closes the platform. A failed
      // lease close keeps the poisoned state — never silently released.
      if (closed) return;
      if (lease !== undefined) {
        try {
          if (isAsyncLike(lease.close)) fail("CLOSE");
          const outcome: unknown = lease.close();
          if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
          if (outcome !== undefined) fail("CLOSE");
        } catch (error) { poisoned = error; throw error; }
        lease = undefined;
      }
      platform.close();
      closed = true;
    },
  };
  // Capability passthrough only — never manufactured when the inner platform
  // lacks the native hot-journal snapshot capability.
  if (platform.withHotJournalSnapshot !== undefined) {
    const snapshot = platform.withHotJournalSnapshot;
    members.withHotJournalSnapshot = (path, callback) => {
      requireHeld();
      snapshot.call(platform, path, callback);
    };
  }
  return Object.freeze(members);
}

/**
 * Production wrapper: requires the module-branded acquirer from
 * `createNativeAuthorityLeaseAcquirer`. There is no PID or marker adoption.
 */
export function withPrivateAuthorityLease(
  platform: PrivatePlatform,
  acquire: AcquirePrivateAuthorityLease,
): PrivatePlatform {
  if (!trustedAcquirers.has(acquire)) fail("UNTRUSTED_ACQUIRER");
  const wrapped = wrap(platform, acquire, "native-owned-helper");
  trustedPlatforms.add(wrapped);
  return wrapped;
}

/**
 * Explicit untrusted contract-testing seam: the fake-owned scope is tagged
 * `untrusted-test` and is forbidden on a real win32 host — it can never serve
 * as Windows acceptance evidence.
 */
export function withPrivateAuthorityLeaseForTesting(
  platform: PrivatePlatform,
  acquire: AcquirePrivateAuthorityLease,
): PrivatePlatform {
  if (process.platform === "win32") fail("UNTRUSTED_ACQUIRER");
  return wrap(platform, acquire, "untrusted-test");
}
