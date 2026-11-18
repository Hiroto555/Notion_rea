import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsPublicationJournal } from "../src/platform/windows/publication-journal";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  createWindowsPrivatePublicationV2,
  createWindowsPrivatePublicationV2ForTesting,
  WINDOWS_PRIVATE_DURABILITY_PROFILE_V1,
  WINDOWS_PRIVATE_IO_V2_MAX_BYTES,
  WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES,
  type WindowsPrivateIoV2ExecRequest,
  type WindowsPrivateIoV2ExecResult,
  type WindowsPrivateIoV2TestPort,
  type WindowsPrivatePublicationV2Options,
  type WindowsPrivatePublishV2Request,
  type WindowsPrivateReadV2Request,
} from "../src/platform/windows/private-publication-v2";
import type {
  DurablePublicationAuthority,
  PublicationReservation,
} from "../src/platform/windows/publication-contract";
import type { WindowsRuntimeFileStat } from "../src/platform/windows/runtime-platform";

const ROOT = "C:\\Folio";
const PARENT = `${ROOT}\\private`;
const TARGET = `${PARENT}\\new.bin`;
const STAGING = `${PARENT}\\caller-chosen.stage`;
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned executable fixture");
const ROOT_ID = "1".repeat(32);
const DIRECTORY_ID = "2".repeat(32);
const FILE_ID = "3".repeat(32);
const STAGE_ID = "5".repeat(32);
const VOLUME = "4".repeat(16);
const ATTEMPT = "a".repeat(32);
const OTHER_ATTEMPT = "b".repeat(32);
const SID = "S-1-5-21-1000";
const DATA = new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fold = (value: string): string => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
const BASE_OPTIONS = {
  root: ROOT, expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
  probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
};
const DIRECTORY = { fileId: DIRECTORY_ID, volumeId: VOLUME };
const publish = (overrides: Partial<WindowsPrivatePublishV2Request> = {}): WindowsPrivatePublishV2Request => ({
  path: TARGET, stagingPath: STAGING, attemptId: ATTEMPT, expectedDirectory: DIRECTORY,
  bytes: DATA, beforePublish: () => {}, ...overrides,
});
const read = (overrides: Partial<WindowsPrivateReadV2Request> = {}): WindowsPrivateReadV2Request => ({
  path: TARGET, expectedDirectory: DIRECTORY,
  expectedFile: { canonicalPath: TARGET, fileId: FILE_ID, volumeId: VOLUME },
  maxBytes: WINDOWS_PRIVATE_IO_V2_MAX_BYTES, ...overrides,
});
type Wire = {
  contractVersion: number; operation: "prepare" | "commit-prepared" | "read-private";
  path: string; root: string; rootFileId: string; rootVolumeId: string;
  directoryFileId: string; directoryVolumeId: string;
  attemptId?: string; stagingPath?: string; bytesBase64?: string;
  fileId?: string; volumeId?: string; expectedSha256?: string;
  byteLength?: number; maxBytes?: number;
};
type Response = Record<string, unknown>;
const object = (value: unknown): Response => value as Response;

function proof(wire: Wire, directory: boolean, path: string = "", fileId: string = ""): Response {
  return {
    platform: "win32", sid: SID, ownerSid: SID, daclPrivate: true, reparsePoint: false,
    linkCount: 1, localFilesystem: true,
    canonicalPath: directory ? wire.path.slice(0, wire.path.lastIndexOf("\\")) : path,
    canonicalRoot: wire.root, fileId: directory ? wire.directoryFileId : fileId,
    rootFileId: wire.rootFileId, rootVolumeId: wire.rootVolumeId, volumeId: wire.rootVolumeId,
  };
}
function envelope(wire: Wire): Response {
  return {
    contractVersion: 2, operation: wire.operation, path: wire.path, root: wire.root,
    ...(wire.attemptId !== undefined ? { attemptId: wire.attemptId, stagingPath: wire.stagingPath } : {}),
  };
}
function result(response: unknown, status = 0): WindowsPrivateIoV2ExecResult {
  return { status, signal: null, stdout: JSON.stringify(response), stderr: "" };
}

type AuthorityFault = "throw" | "ack" | "thenable";
type AuthorityFaults = Partial<Record<"reserve" | "dispatchPrepare" | "dispatchCommit" | "prepared" | "terminal", AuthorityFault>>;
// In-memory contract fixture ONLY: every method records, then optionally
// injects a throw or malformed acknowledgement. Real durability lives in the
// shared authority implementation owned by the parent layer.
function memoryAuthority(order: string[], faults: AuthorityFaults = {}) {
  const attempts = new Set<string>(), targets = new Set<string>();
  const reservations: PublicationReservation[] = [];
  const dispatches: { attemptId: string; phase: string; exactWire: string }[] = [];
  const prepared: { attemptId: string; evidence: unknown }[] = [];
  const terminals: { attemptId: string; outcome: string; evidence: unknown }[] = [];
  const act = (kind: keyof AuthorityFaults): void => {
    const fault = faults[kind];
    if (fault === "throw") throw new Error(`injected ${kind} failure`);
    if (fault === "ack") return {} as unknown as void;
    if (fault === "thenable") return Promise.resolve() as unknown as void;
    return undefined as void;
  };
  const authority: DurablePublicationAuthority = {
    reserve(reservation: PublicationReservation): void {
      order.push(`reserve:${reservation.attemptId}`);
      if (attempts.has(reservation.attemptId) || targets.has(fold(reservation.path))) throw new Error("consumed");
      attempts.add(reservation.attemptId); targets.add(fold(reservation.path));
      reservations.push(reservation);
      return act("reserve"); // record-then-throw / malformed ack AFTER durable state.
    },
    recordDispatch(attemptId: string, phase: "prepare" | "commit-prepared", exactWire: string): void {
      order.push(`dispatch:${phase}:${attemptId}`);
      dispatches.push({ attemptId, phase, exactWire });
      return act(phase === "prepare" ? "dispatchPrepare" : "dispatchCommit");
    },
    recordPrepared(attemptId: string, evidence: unknown): void {
      order.push(`prepared:${attemptId}`);
      prepared.push({ attemptId, evidence });
      return act("prepared");
    },
    recordTerminal(attemptId: string, outcome: "PUBLISHED" | "UNKNOWN" | "REJECTED", evidence: unknown): void {
      order.push(`terminal:${outcome}:${attemptId}`);
      terminals.push({ attemptId, outcome, evidence });
      return act("terminal");
    },
  };
  return { authority, attempts, targets, reservations, dispatches, prepared, terminals };
}

function fixture(faults: AuthorityFaults = {}) {
  const calls: WindowsPrivateIoV2ExecRequest[] = [];
  const wires: Wire[] = [];
  const fsCalls: string[] = [];
  const order: string[] = [];
  const state: {
    exeBytes: Uint8Array; stat: Partial<WindowsRuntimeFileStat>; missing: boolean;
    readBytes: Uint8Array; stageFileId: string; finalFileId: string;
    prepared?: { bytes: Buffer; stagingPath: string };
  } = {
    exeBytes: EXE_BYTES, stat: {}, missing: false, readBytes: DATA,
    stageFileId: STAGE_ID, finalFileId: STAGE_ID, prepared: undefined,
  };
  const behavior: {
    response?: (response: Response, wire: Wire) => Response;
    result?: (output: WindowsPrivateIoV2ExecResult, wire: Wire) => WindowsPrivateIoV2ExecResult;
    exec?: (request: WindowsPrivateIoV2ExecRequest, wire: Wire) => WindowsPrivateIoV2ExecResult;
    onPrepare?: (wire: Wire) => void;
    onCommit?: (wire: Wire) => void;
  } = {};
  const auth = memoryAuthority(order, faults);
  const port: WindowsPrivateIoV2TestPort = {
    fs: {
      lstat(path) {
        fsCalls.push(`stat:${path}`);
        if (state.missing || path !== EXE) throw new Error("fake filesystem unavailable");
        return {
          isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
          nlink: 1, dev: 1, ino: 17, size: state.exeBytes.byteLength, mtimeMs: 1, ...state.stat,
        };
      },
      readFile(path) {
        fsCalls.push(`read:${path}`);
        if (path !== EXE) throw new Error("No private path may be read by the TS filesystem port");
        return state.exeBytes;
      },
    },
    exec(request) {
      const wire = JSON.parse(Buffer.from(request.input).toString("utf8")) as Wire;
      order.push(`exec:${wire.operation}`);
      calls.push(request);
      wires.push(wire);
      if (behavior.exec) return behavior.exec(request, wire);
      let response: Response;
      if (wire.operation === "prepare") {
        const bytes = Buffer.from(wire.bytesBase64!, "base64");
        state.prepared = { bytes, stagingPath: wire.stagingPath! };
        if (behavior.onPrepare) behavior.onPrepare(wire);
        response = {
          ...envelope(wire), state: "PREPARED",
          file: proof(wire, false, wire.stagingPath!, state.stageFileId),
          directory: proof(wire, true),
          byteLength: bytes.byteLength, sha256: hash(bytes), bytesBase64: wire.bytesBase64,
          contentFlushed: true, filesystem: "NTFS",
        };
      } else if (wire.operation === "commit-prepared") {
        const staged = state.prepared;
        if (!staged || staged.stagingPath !== wire.stagingPath) throw new Error("commit without prepare");
        if (behavior.onCommit) behavior.onCommit(wire);
        response = {
          ...envelope(wire), state: "PUBLISHED",
          file: proof(wire, false, wire.path, state.finalFileId),
          directory: proof(wire, true),
          byteLength: staged.bytes.byteLength, sha256: hash(staged.bytes),
          bytesBase64: staged.bytes.toString("base64"), contentFlushed: true, filesystem: "NTFS",
          stagingDisposition: "RENAMED_TO_FINAL", namespace: "EXCLUSIVE_NO_REPLACE",
          durability: { profile: WINDOWS_PRIVATE_DURABILITY_PROFILE_V1, scope: "PROCESS_CRASH" },
        };
      } else {
        const bytes = state.readBytes;
        response = {
          ...envelope(wire), state: "READ",
          file: proof(wire, false, wire.path, wire.fileId!), directory: proof(wire, true),
          byteLength: bytes.byteLength, sha256: hash(bytes),
          bytesBase64: Buffer.from(bytes).toString("base64"), filesystem: "NTFS",
        };
      }
      if (behavior.response) response = behavior.response(response, wire);
      const output = result(response);
      return behavior.result ? behavior.result(output, wire) : output;
    },
  };
  return {
    state, behavior, calls, wires, fsCalls, order, auth, port,
    open: (overrides: Partial<WindowsPrivatePublicationV2Options> = {}) =>
      createWindowsPrivatePublicationV2ForTesting(
        { ...BASE_OPTIONS, authority: auth.authority, ...overrides }, port),
    openWith: (authority: DurablePublicationAuthority) =>
      createWindowsPrivatePublicationV2ForTesting({ ...BASE_OPTIONS, authority }, port),
  };
}
function expectNoPrivateBytes(value: unknown): void {
  expect(object(value).state).not.toBe("READ");
  expect(value).not.toHaveProperty("bytes");
  expect(value).not.toHaveProperty("bytesBase64");
  expect(value).not.toHaveProperty("readback");
}

describe.skipIf(process.platform === "win32")("private publication v2 — untrusted in-memory contract, not Windows proof", () => {
  it("runs the exact reserve→prepare→prepared→callback→commit→terminal order with an arbitrary same-parent stage", () => {
    const h = fixture(), io = h.open();
    expect(io.trust).toBe("untrusted-test");
    const callback = vi.fn((readback: Uint8Array) => {
      expect(readback).toEqual(DATA);
      h.order.push("callback");
    });
    const receipt = io.publishNew(publish({ beforePublish: callback }));
    expect(receipt).toEqual({
      contractVersion: 2, state: "PUBLISHED", path: TARGET, stagingPath: STAGING, attemptId: ATTEMPT,
      identity: { canonicalPath: TARGET, fileId: STAGE_ID, volumeId: VOLUME },
      byteLength: DATA.byteLength, sha256: hash(DATA), readback: DATA,
      stagingDisposition: "RENAMED_TO_FINAL", contentFlushed: true, namespace: "EXCLUSIVE_NO_REPLACE",
      durability: { profile: WINDOWS_PRIVATE_DURABILITY_PROFILE_V1, scope: "PROCESS_CRASH" },
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual([
      `reserve:${ATTEMPT}`, `dispatch:prepare:${ATTEMPT}`, "exec:prepare",
      `prepared:${ATTEMPT}`, "callback",
      `dispatch:commit-prepared:${ATTEMPT}`, "exec:commit-prepared",
      `terminal:PUBLISHED:${ATTEMPT}`,
    ]);
    expect(h.wires[0]).toEqual({
      contractVersion: 2, operation: "prepare", path: TARGET, root: ROOT,
      rootFileId: ROOT_ID, rootVolumeId: VOLUME, directoryFileId: DIRECTORY_ID, directoryVolumeId: VOLUME,
      attemptId: ATTEMPT, stagingPath: STAGING, bytesBase64: Buffer.from(DATA).toString("base64"),
    });
    // The dispatched UTF8 wire is byte-identical to what the authority recorded.
    expect(h.auth.dispatches.map((d) => d.exactWire)).toEqual(
      h.calls.map((call) => Buffer.from(call.input).toString("utf8")));
    expect(h.wires[1]).toEqual({
      contractVersion: 2, operation: "commit-prepared", path: TARGET, root: ROOT,
      rootFileId: ROOT_ID, rootVolumeId: VOLUME, directoryFileId: DIRECTORY_ID, directoryVolumeId: VOLUME,
      attemptId: ATTEMPT, stagingPath: STAGING, fileId: STAGE_ID, volumeId: VOLUME,
      expectedSha256: hash(DATA), byteLength: DATA.byteLength,
    });
    expect(h.auth.reservations[0]).toEqual({
      contractVersion: 2, attemptId: ATTEMPT, path: TARGET, stagingPath: STAGING,
      root: { canonicalPath: ROOT, fileId: ROOT_ID, volumeId: VOLUME },
      directory: { canonicalPath: PARENT, fileId: DIRECTORY_ID, volumeId: VOLUME },
      byteLength: DATA.byteLength, sha256: hash(DATA),
    });
    expect(object(h.auth.terminals[0].evidence).phase).toBe("commit-prepared");
    expect(object(object(h.auth.terminals[0].evidence).reply).state).toBe("PUBLISHED");
    expect(h.fsCalls.every((call) => call.endsWith(EXE))).toBe(true);
  });

  it("accepts a class-based authority and binds its methods once", () => {
    const order: string[] = [];
    class ClassAuthority {
      private log: string[] = order;
      reserve(r: PublicationReservation): void { this.log.push(`reserve:${r.attemptId}`); }
      recordDispatch(id: string, phase: string): void { this.log.push(`dispatch:${phase}:${id}`); }
      recordPrepared(id: string): void { this.log.push(`prepared:${id}`); }
      recordTerminal(id: string, outcome: string): void { this.log.push(`terminal:${outcome}:${id}`); }
    }
    const h = fixture(), io = h.openWith(new ClassAuthority());
    expect(io.publishNew(publish()).state).toBe("PUBLISHED");
    expect(order[0]).toBe(`reserve:${ATTEMPT}`);
    expect(order[order.length - 1]).toBe(`terminal:PUBLISHED:${ATTEMPT}`);
  });

  it("requires the PREPARED native identity to flow into commit and rejects a swapped final identity", () => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish()).state).toBe("PUBLISHED");
    expect(h.wires[1].fileId).toBe(STAGE_ID);
    expect(h.wires[1].volumeId).toBe(VOLUME);
    const second = fixture();
    second.state.finalFileId = "9".repeat(32);
    const io2 = second.open();
    expect(io2.publishNew(publish()).state).toBe("UNKNOWN");
    expect(second.auth.terminals[0].outcome).toBe("UNKNOWN");
    expect(second.calls).toHaveLength(2);
  });

  it("maps a commit collision to EXISTS terminal REJECTED without retry and keeps the stage", () => {
    const h = fixture(), io = h.open();
    const files = new Map<string, Uint8Array>([[TARGET, Buffer.from("original immutable bytes")]]);
    h.behavior.exec = (_request, wire) => {
      if (wire.operation === "prepare") {
        const bytes = Buffer.from(wire.bytesBase64!, "base64");
        h.state.prepared = { bytes, stagingPath: wire.stagingPath! };
        files.set(wire.stagingPath!, bytes);
        return result({
          ...envelope(wire), state: "PREPARED",
          file: proof(wire, false, wire.stagingPath!, STAGE_ID), directory: proof(wire, true),
          byteLength: bytes.byteLength, sha256: hash(bytes), bytesBase64: wire.bytesBase64,
          contentFlushed: true, filesystem: "NTFS",
        });
      }
      return result({ ...envelope(wire), state: "EXISTS", reason: "PRIVATE_IO_V2_EXISTS" }, 2);
    };
    const callback = vi.fn();
    const failure = io.publishNew(publish({ beforePublish: callback }));
    expect(failure).toEqual({
      contractVersion: 2, state: "EXISTS", path: TARGET, stagingPath: STAGING, attemptId: ATTEMPT,
      reason: "PRIVATE_IO_V2_EXISTS", preserve: true,
    });
    expect(callback).toHaveBeenCalledTimes(1); // Stage was proven before the collision.
    expect(h.calls).toHaveLength(2);
    expect(h.order.filter((e) => e.startsWith("exec:")).length).toBe(2);
    expect(h.auth.terminals[0].outcome).toBe("REJECTED");
    expect(files.get(TARGET)).toEqual(Buffer.from("original immutable bytes"));
    expect(files.get(STAGING)).toEqual(Buffer.from(DATA));
  });

  it("maps a prepare collision to EXISTS without callback or commit", () => {
    const h = fixture(), io = h.open();
    h.behavior.exec = (_request, wire) =>
      result({ ...envelope(wire), state: "EXISTS", reason: "PRIVATE_IO_V2_EXISTS" }, 2);
    const callback = vi.fn();
    expect(io.publishNew(publish({ beforePublish: callback })).state).toBe("EXISTS");
    expect(callback).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(h.auth.dispatches).toHaveLength(1);
    expect(h.auth.terminals[0].outcome).toBe("REJECTED");
  });

  it.each([
    ["throw", () => { throw new Error("caller aborted"); }],
    ["promise", () => Promise.resolve() as unknown as void],
    ["custom thenable", () => ({ then: () => {} }) as unknown as void],
  ])("a callback %s after real staging is UNKNOWN with no commit dispatch", (_label, beforePublish) => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish({ beforePublish: beforePublish as () => void }))).toMatchObject({
      contractVersion: 2, state: "UNKNOWN", path: TARGET, stagingPath: STAGING, attemptId: ATTEMPT, preserve: true,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.order).toContain(`prepared:${ATTEMPT}`);
    expect(h.order).not.toContain(`dispatch:commit-prepared:${ATTEMPT}`);
    expect(h.auth.terminals[0].outcome).toBe("UNKNOWN");
    expect(h.state.prepared?.bytes).toEqual(Buffer.from(DATA)); // Retained, never cleaned.
  });

  it.each([
    async () => {},
    async function named() {},
    function* generator() { yield 1; },
    function* () { yield 2; },
  ])("rejects a known async/generator callback before any reservation: %#", (beforePublish) => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish({ beforePublish: beforePublish as () => void })).state).toBe("REJECTED");
    expect(h.order).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects reserve failures including record-then-throw, then poisons the shared authority object", () => {
    for (const fault of ["throw", "ack", "thenable"] as const) {
      const h = fixture({ reserve: fault }), io = h.open();
      expect(io.publishNew(publish()).state).toBe("UNKNOWN");
      expect(h.calls).toHaveLength(0);
      expect(h.order).toEqual([`reserve:${ATTEMPT}`]);
      // Same factory: every later operation, reads included, is refused.
      expect(io.publishNew(publish({ attemptId: OTHER_ATTEMPT, path: `${PARENT}\\other.bin` })).state).toBe("REJECTED");
      expect(io.readPrivate(read()).state).toBe("REJECTED");
      // A fresh factory over the SAME authority object is blocked outright.
      const io2 = h.open();
      expect(io2.publishNew(publish({ attemptId: "c".repeat(32), path: `${PARENT}\\third.bin` })).state).toBe("REJECTED");
      expect(io2.readPrivate(read()).state).toBe("REJECTED");
      expect(h.calls).toHaveLength(0);
    }
  });

  it.each([
    ["dispatchPrepare", 0], ["dispatchCommit", 1], ["prepared", 1], ["terminal", 2],
  ] as const)(
    "a failing %s acknowledgement is UNKNOWN, stops dispatch and poisons the authority", (kind, execCalls) => {
      const h = fixture({ [kind]: "throw" } as AuthorityFaults), io = h.open();
      expect(io.publishNew(publish()).state).toBe("UNKNOWN");
      expect(h.calls).toHaveLength(execCalls);
      // The same authority object is now permanently poisoned.
      const io2 = h.open();
      expect(io2.publishNew(publish({ attemptId: "d".repeat(32), path: `${PARENT}\\again.bin` })).state).toBe("REJECTED");
      expect(io2.readPrivate(read()).state).toBe("REJECTED");
    },
  );

  it("lets the durable authority refuse consumed attempts and targets across factories", () => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish()).state).toBe("PUBLISHED");
    const eventsBefore = h.order.length;
    // Same-factory local latches refuse before the authority is even asked:
    // same attempt, same folded target, and a case-variant target.
    expect(io.publishNew(publish()).state).toBe("REJECTED");
    expect(io.publishNew(publish({ attemptId: OTHER_ATTEMPT })).state).toBe("REJECTED");
    expect(io.publishNew(publish({
      attemptId: "c".repeat(32), path: "C:\\FOLIO\\PRIVATE\\NEW.BIN",
    })).state).toBe("REJECTED");
    expect(h.order.length).toBe(eventsBefore);
    // A recreated factory reaches the durable authority, which refuses the
    // consumed target (new attempt, same path) and is then poisoned.
    const io2 = h.open();
    expect(io2.publishNew(publish({ attemptId: "d".repeat(32) })).state).toBe("UNKNOWN");
    expect(h.auth.terminals.length).toBe(1); // No terminal for a refused attempt.
    expect(io2.readPrivate(read()).state).toBe("REJECTED");
    expect(io2.publishNew(publish({ attemptId: "e".repeat(32), path: `${PARENT}\\fresh.bin` })).state).toBe("REJECTED");
  });
});

describe.skipIf(process.platform === "win32")("helper output and executor ambiguity", () => {
  const badPrepareResults: Array<[string, (r: WindowsPrivateIoV2ExecResult) => WindowsPrivateIoV2ExecResult | Promise<WindowsPrivateIoV2ExecResult>]> = [
    ["bad JSON", (r) => ({ ...r, stdout: "{" })],
    ["duplicate key", (r) => ({ ...r, stdout: r.stdout.replace(/^\{/, '{"state":"UNKNOWN",') })],
    ["escaped duplicate key", (r) => ({ ...r, stdout: r.stdout.replace(/^\{/, '{"st\\u0061te":"UNKNOWN",') })],
    ["trailing JSON", (r) => ({ ...r, stdout: `${r.stdout}{}` })],
    ["signal", (r) => ({ ...r, signal: "SIGTERM", status: null })],
    ["errorCode", (r) => ({ ...r, errorCode: "EIO" })],
    ["stderr", (r) => ({ ...r, stderr: "untrusted diagnostic" })],
    ["PREPARED with status 1", (r) => ({ ...r, status: 1 })],
    ["extra executor key", (r) => ({ ...r, extra: true }) as WindowsPrivateIoV2ExecResult],
    ["async executor result", async (r) => r],
  ];
  it.each(badPrepareResults)("%s is UNKNOWN, never reaches commit and records terminal evidence", (_label, corrupt) => {
    const h = fixture(), io = h.open();
    h.behavior.result = corrupt as (r: WindowsPrivateIoV2ExecResult) => WindowsPrivateIoV2ExecResult;
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
    expect(h.calls).toHaveLength(1);
    expect(h.order).not.toContain(`dispatch:commit-prepared:${ATTEMPT}`);
    expect(h.auth.terminals[0]?.outcome).toBe("UNKNOWN");
  });

  it("rejects accessor executor results without evaluating them", () => {
    const h = fixture(), io = h.open();
    const getter = vi.fn(() => "secret getter");
    h.behavior.result = (r) => {
      Object.defineProperty(r, "stdout", { enumerable: true, get: getter });
      return r;
    };
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
    expect(getter).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
  });

  it.each([
    { contractVersion: 1 }, { operation: "read-private" }, { path: `${PARENT}\\other.bin` },
    { root: "C:\\Other" }, { attemptId: OTHER_ATTEMPT }, { stagingPath: `${PARENT}\\other.stage` },
    { state: "PUBLISHED" }, { filesystem: "ReFS" }, { contentFlushed: false },
    { sha256: "0".repeat(64) }, { byteLength: DATA.byteLength + 1 },
    { bytesBase64: `${Buffer.from(DATA).toString("base64")}\n` },
    { extra: true },
  ])("rejects an inaccurate PREPARED claim %j before prepared/callback/commit", (patch) => {
    const h = fixture(), io = h.open();
    const callback = vi.fn();
    h.behavior.response = (r) => ({ ...r, ...patch });
    expect(io.publishNew(publish({ beforePublish: callback })).state).toBe("UNKNOWN");
    expect(callback).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(h.auth.prepared).toHaveLength(0);
    expect(h.order).not.toContain(`dispatch:commit-prepared:${ATTEMPT}`);
  });

  it.each([
    { stagingDisposition: "COPIED" }, { namespace: "REPLACE" },
    { durability: { profile: "OTHER", scope: "PROCESS_CRASH" } },
    { durability: { profile: WINDOWS_PRIVATE_DURABILITY_PROFILE_V1, scope: "POWER_LOSS" } },
    { filesystem: "FAT32" }, { bytesBase64: "AB==", byteLength: 1 },
  ])("rejects an inaccurate PUBLISHED claim %j and records UNKNOWN", (patch) => {
    const h = fixture(), io = h.open();
    h.behavior.response = (r, wire) => (wire.operation === "commit-prepared" ? { ...r, ...patch } : r);
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
    expect(h.calls).toHaveLength(2);
    expect(h.auth.terminals[0].outcome).toBe("UNKNOWN");
  });
});

describe.skipIf(process.platform === "win32")("authenticated reads", () => {
  it("verifies the computed digest when the optional caller hash is omitted", () => {
    const h = fixture(), io = h.open();
    const receipt = io.readPrivate(read());
    expect(receipt).toEqual({
      contractVersion: 2, state: "READ",
      identity: { canonicalPath: TARGET, fileId: FILE_ID, volumeId: VOLUME },
      bytes: DATA, byteLength: DATA.byteLength, sha256: hash(DATA),
    });
    expect(h.wires[0]).toEqual({
      contractVersion: 2, operation: "read-private", path: TARGET, root: ROOT,
      rootFileId: ROOT_ID, rootVolumeId: VOLUME, directoryFileId: DIRECTORY_ID, directoryVolumeId: VOLUME,
      fileId: FILE_ID, volumeId: VOLUME, maxBytes: WINDOWS_PRIVATE_IO_V2_MAX_BYTES,
    });
    expect(h.wires[0]).not.toHaveProperty("expectedSha256");
    expect(h.fsCalls.every((call) => call.endsWith(EXE))).toBe(true);
  });

  it("enforces an optional caller hash and rejects wrong computed hashes", () => {
    const h = fixture(), io = h.open();
    expect(io.readPrivate(read({ expectedSha256: hash(DATA) })).state).toBe("READ");
    expect(io.readPrivate(read({ expectedSha256: "0".repeat(64) })).state).toBe("UNKNOWN");
    h.behavior.response = (r) => ({ ...r, sha256: "0".repeat(64) });
    expectNoPrivateBytes(io.readPrivate(read()));
    const tampered = Uint8Array.from(DATA); tampered[0] = 1;
    h.behavior.response = (r) => ({ ...r, bytesBase64: Buffer.from(tampered).toString("base64") });
    expectNoPrivateBytes(io.readPrivate(read()));
  });

  it.each([
    { bytesBase64: "!!!!" }, { bytesBase64: `${Buffer.from(DATA).toString("base64")} ` },
    { byteLength: DATA.byteLength - 1 }, { byteLength: DATA.byteLength + 1 },
    { filesystem: "ReFS" }, { file: { wrong: true } },
  ])("drops read bytes on inaccurate read receipts %j", (patch) => {
    const h = fixture(), io = h.open();
    h.behavior.response = (r) => ({ ...r, ...patch });
    expectNoPrivateBytes(io.readPrivate(read()));
  });

  it("pins published identities and rejects a later changed expectedFile before exec", () => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish()).state).toBe("PUBLISHED");
    const callsBefore = h.calls.length;
    const wrong = io.readPrivate(read({ expectedFile: { canonicalPath: TARGET, fileId: "9".repeat(32), volumeId: VOLUME } }));
    expect(wrong.state).toBe("REJECTED");
    expect(h.calls).toHaveLength(callsBefore);
    // The pinned identity itself still reads.
    expect(io.readPrivate(read({ expectedFile: { canonicalPath: TARGET, fileId: STAGE_ID, volumeId: VOLUME } })).state).toBe("READ");
  });
});

describe.skipIf(process.platform === "win32")("bounds and dispatch boundary", () => {
  it("accepts 0 bytes and exactly 1 MiB including '+'-heavy base64 within the wire bound", () => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish({ bytes: new Uint8Array() })).state).toBe("PUBLISHED");
    const pattern = [0xfb, 0xef, 0xbe];
    const bytes = Uint8Array.from({ length: WINDOWS_PRIVATE_IO_V2_MAX_BYTES }, (_v, i) => pattern[i % 3]);
    expect(Buffer.from(bytes).toString("base64")).toContain("+".repeat(256));
    const path = `${PARENT}\\${"x".repeat(240 - PARENT.length - 1)}`;
    const longStage = `${PARENT}\\${"s".repeat(240 - PARENT.length - 1)}`;
    expect(io.publishNew(publish({
      bytes, path, stagingPath: longStage, attemptId: OTHER_ATTEMPT,
    })).state).toBe("PUBLISHED");
    const input = Buffer.from(h.calls[2].input); // Second publish's prepare wire.
    expect(input.byteLength).toBeLessThanOrEqual(WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES);
    expect(input.toString("utf8")).toContain("+");
    // The commit wire is compact: identity pins, no payload bytes.
    expect(h.wires[3]).not.toHaveProperty("bytesBase64");
    expect(Buffer.byteLength(JSON.stringify(h.wires[3]), "utf8")).toBeLessThanOrEqual(WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES);
    h.state.readBytes = bytes;
    let stdout = "";
    h.behavior.result = (output) => { stdout = output.stdout; return output; };
    const receipt = io.readPrivate(read({
      path, expectedFile: { canonicalPath: path, fileId: STAGE_ID, volumeId: VOLUME },
      maxBytes: WINDOWS_PRIVATE_IO_V2_MAX_BYTES,
    }));
    expect(receipt.state).toBe("READ");
    if (receipt.state === "READ") expect(receipt.bytes).toEqual(bytes);
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES);
    expect(stdout).toContain("+".repeat(256));
  });

  it.each([WINDOWS_PRIVATE_IO_V2_MAX_BYTES + 1, 32 * 1024 * 1024])(
    "rejects oversize %s bytes before reservation and dispatch", (size) => {
      const h = fixture(), io = h.open();
      expect(io.publishNew(publish({ bytes: new Uint8Array(size) })).state).toBe("REJECTED");
      expect(h.order).toHaveLength(0);
      expect(h.calls).toHaveLength(0);
    },
  );

  it("rejects a staging path outside the parent, equal to the target, or under another directory", () => {
    const h = fixture(), io = h.open();
    for (const stagingPath of [
      TARGET, `${ROOT}\\other\\stage.tmp`, `${ROOT}\\stage.tmp`, `${PARENT}\\..\\up.bin`,
      `${PARENT}\\stage.tmp:ads`, "C:\\Folio\\private\\stage.tmp ", "\\\\server\\s\\stage.tmp",
    ]) {
      expect(io.publishNew(publish({ stagingPath, attemptId: "e".repeat(32) })).state).toBe("REJECTED");
    }
    expect(h.order).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it("sends a clean bounded exec request with only the fixed flag, env and pipes", () => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish()).state).toBe("PUBLISHED");
    const request = h.calls[0];
    expect(request.args).toEqual(["--private-io-v2"]);
    expect(request).toMatchObject({
      executable: EXE, cwd: "C:\\Windows", timeoutMs: 15_000,
      maxBuffer: WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES,
      shell: false, windowsHide: true, stdio: "pipe", encoding: "buffer",
      env: { SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\Windows\\Temp", TMP: "C:\\Windows\\Temp" },
    });
    expect(Object.keys(request.env).sort()).toEqual(["SystemRoot", "TEMP", "TMP", "windir"]);
    expect(Object.keys(request).sort()).toEqual([
      "args", "cwd", "encoding", "env", "executable", "input", "maxBuffer", "shell", "stdio", "timeoutMs", "windowsHide",
    ]);
    const { input: _input, ...nonPrivate } = request;
    expect(JSON.stringify(nonPrivate)).not.toContain(Buffer.from(DATA).toString("base64"));
  });

  it("refuses reentrant publication from inside the callback before any nested dispatch", () => {
    const h = fixture();
    let inner: unknown;
    const io = h.open();
    const receipt = io.publishNew(publish({
      beforePublish: () => {
        inner = io.publishNew(publish({ attemptId: OTHER_ATTEMPT, path: `${PARENT}\\nested.bin` }));
      },
    }));
    expect(receipt.state).toBe("PUBLISHED");
    expect(object(inner).state).toBe("REJECTED");
    expect(h.calls).toHaveLength(2);
    expect(h.order.filter((e) => e.startsWith("reserve:"))).toHaveLength(1);
  });
});

describe.skipIf(process.platform === "win32")("trusted helper factory", () => {
  it("forbids production injection and non-Windows production on this host", () => {
    const h = fixture();
    const factory = createWindowsPrivatePublicationV2 as unknown as (...args: unknown[]) => unknown;
    expect(() => factory({ ...BASE_OPTIONS, authority: h.auth.authority }, h.port)).toThrow(CollaborationError);
    if (process.platform !== "win32") {
      expect(() => createWindowsPrivatePublicationV2({ ...BASE_OPTIONS, authority: h.auth.authority }))
        .toThrow("UNSUPPORTED_PLATFORM");
    }
    expect(h.fsCalls).toHaveLength(0);
  });

  it("rejects async or generator authority methods at bind time", () => {
    const h = fixture();
    const bad = {
      reserve: async () => {},
      recordDispatch: () => {},
      recordPrepared: () => {},
      recordTerminal: () => {},
    };
    expect(() => h.openWith(bad as unknown as DurablePublicationAuthority)).toThrow(CollaborationError);
    const gen = {
      reserve: () => {}, recordDispatch: () => {},
      recordPrepared: function* () { yield 1; }, recordTerminal: () => {},
    };
    expect(() => h.openWith(gen as unknown as DurablePublicationAuthority)).toThrow(CollaborationError);
  });

  it("rejects extra or accessor options without invoking getters", () => {
    const h = fixture();
    const getter = vi.fn(() => "secret");
    const options = { ...BASE_OPTIONS, authority: h.auth.authority };
    Object.defineProperty(options, "root", { enumerable: true, get: getter });
    expect(() => createWindowsPrivatePublicationV2ForTesting(options, h.port)).toThrow(CollaborationError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => h.open({ extra: true } as Partial<WindowsPrivatePublicationV2Options>)).toThrow(CollaborationError);
    expect(() => createWindowsPrivatePublicationV2ForTesting(
      { ...BASE_OPTIONS, authority: undefined as unknown as DurablePublicationAuthority }, h.port,
    )).toThrow(CollaborationError);
  });
});

describe("v2 source guardrails (NOT native validation)", () => {
  const csharp = readFileSync(new URL("../scripts/platform/windows/PrivateRootProbeProgram.cs", import.meta.url), "utf8");
  const v2 = csharp.slice(csharp.indexOf("// Private I/O v2"));
  it("adds a separate --private-io-v2 dispatch while keeping v1 and all legacy modes", () => {
    expect(csharp).toContain('if(args.Length==1&&args[0]=="--private-io-v1")return PrivateIoMode();');
    expect(csharp).toContain('if(args.Length==1&&args[0]=="--private-io-v2")return PrivateIoV2Mode();');
    for (const mode of ["probe", "create", "open", "directory"]) expect(csharp).toContain(`"${mode}"`);
    const ts = readFileSync(new URL("../src/platform/windows/private-publication-v2.ts", import.meta.url), "utf8");
    expect(ts).not.toContain('from "./private-publication"');
    expect(ts).toContain('"--private-io-v2"');
    expect(readFileSync(new URL("../src/platform/windows/private-publication.ts", import.meta.url), "utf8"))
      .toContain('"--private-io-v1"');
  });

  it("keeps prepare rename-free and commits only via same-handle no-replace rename then Flush(true)", () => {
    const prepare = v2.slice(v2.indexOf("IoV2Prepare"), v2.indexOf("IoV2Commit"));
    expect(prepare).not.toContain("IoRenameNoReplace");
    expect(prepare).toContain("IoCreateNew");
    const commit = v2.slice(v2.indexOf("IoV2Commit"), v2.indexOf("IoV2Read"));
    expect(commit).toContain("IoRenameNoReplace(handle");
    expect(commit.indexOf("IoRenameNoReplace(handle")).toBeLessThan(commit.indexOf("stream.Flush(true)"));
    expect(commit.indexOf("stream.Flush(true)")).toBeLessThan(commit.indexOf("IoFileProof(handle,r.Path"));
    // The rename helper itself is ABI-verified no-replace (guarded by v1 tests).
    expect(commit).toContain("IoRenameNoReplace(handle,r.Path,out int error)");
  });

  it("performs same-handle NTFS and ACL proofs with strict read-only sharing", () => {
    expect(v2).toContain('EntryPoint="GetVolumeInformationByHandleW"');
    expect(v2).toContain('EntryPoint="NtQueryVolumeInformationFile"');
    expect(v2).toContain('EntryPoint="GetSecurityInfo"');
    expect(v2).toContain('EntryPoint="GetSecurityDescriptorLength"');
    expect(v2).toContain("DiscretionaryAclProtected");
    expect(v2).toContain("IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead");
    expect(v2).toContain("IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting");
    expect(v2).not.toContain("FileShareReadWrite");
  });

  it("emits output only after owned scopes and fabricates no cleanup or temp names", () => {
    const mode = v2.slice(v2.indexOf("PrivateIoV2Mode"));
    expect(mode).toContain("IoOutput(outcome.Response,outcome.Status,ref outputAttempted,");
    expect(mode.indexOf("using(var directories")).toBeLessThan(mode.indexOf("IoOutput(outcome.Response"));
    expect(v2).not.toMatch(/MoveFileEx|File\.Move|CreateDirectory\(|ReadToEnd\(|File\.Delete/);
    expect(v2).not.toContain("Console.Write(");
    expect(v2).toContain('durability=new {profile="WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",scope="PROCESS_CRASH"}');
    expect(v2).toContain('filesystem="NTFS"');
  });
});

// Parent integration: actual disposable SQLite authority; executor is a labelled
// contract fixture and establishes no Windows/NTFS acceptance.
describe.skipIf(process.platform === "win32")("parent two-phase integration", () => {
  it("persists 1MiB publication originals within unchanged ledger limits and denies replay after reopen", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-v2-composed-")));
    function platform(): PrivatePlatform {
      const p = new PosixPrivatePlatform();
      return {kind: "windows", bind: p.bind.bind(p), assertRoot: p.assertRoot.bind(p), assertFile: p.assertFile.bind(p),
        assertSidecars: p.assertSidecars.bind(p), createExclusive: p.createExclusive.bind(p), assertEmptyFile: p.assertEmptyFile.bind(p), close: p.close.bind(p)};
    }
    let journal = new WindowsPublicationJournal(dir, platform());
    try {
      const h = fixture(), io = h.openWith(journal);
      const receipt = io.publishNew(publish({bytes: Buffer.alloc(WINDOWS_PRIVATE_IO_V2_MAX_BYTES, 0xfb), stagingPath: `${PARENT}\\.folio-private-${ATTEMPT}.tmp`}));
      expect(receipt.state).toBe("PUBLISHED");
      expect(journal.inspect(ATTEMPT)?.state).toBe("PUBLISHED");
      journal.close(); journal = new WindowsPublicationJournal(dir, platform());
      expect(journal.inspect(ATTEMPT)?.state).toBe("PUBLISHED");
      const calls = h.calls.length;
      expect(h.openWith(journal).publishNew(publish({stagingPath: `${PARENT}\\.folio-private-${ATTEMPT}.tmp`})).state).toBe("UNKNOWN");
      expect(h.calls).toHaveLength(calls);
    } finally { journal.close(); rmSync(dir, {recursive: true, force: true}); }
  });
  it.each(["{bad JSON", '{"duplicate":1,"duplicate":2}'])("retains malformed exact pipe originals privately: %s", stdout => {
    const h = fixture(); h.behavior.result = r => ({...r, stdout});
    expect(h.open().publishNew(publish()).state).toBe("UNKNOWN");
    expect(JSON.stringify(h.auth.terminals[0].evidence)).toContain(JSON.stringify(stdout).slice(1, -1));
  });
  it("retains signal and stderr originals, and helper replacement replies", () => {
    for (const change of [false, true]) {
      const h = fixture(); let actual = "";
      h.behavior.result = r => {actual = r.stdout; if (change) h.state.exeBytes = Buffer.from("changed"); return {...r, signal: change ? null : "SIGTERM", stderr: "private diagnostic"};};
      expect(h.open().publishNew(publish()).state).toBe("UNKNOWN");
      const evidence = JSON.stringify(h.auth.terminals[0].evidence);
      expect(evidence).toContain("private diagnostic");
      expect(evidence).toContain(JSON.stringify(actual).slice(1, -1));
    }
  });
  it("pins an initial read and supports an explicit wide-backup limit without widening publication", () => {
    const h = fixture(), io = h.open();
    expect(io.readPrivate(read({maxBytes: 256 * 1024 * 1024})).state).toBe("READ");
    expect(h.calls[0].maxBuffer).toBeGreaterThan(256 * 1024 * 1024);
    const calls = h.calls.length;
    expect(io.readPrivate(read({expectedFile: {canonicalPath: TARGET, fileId: STAGE_ID, volumeId: VOLUME}})).state).toBe("REJECTED");
    expect(io.readPrivate(read({maxBytes: 256 * 1024 * 1024 + 1})).state).toBe("REJECTED");
    expect(h.calls).toHaveLength(calls);
  });
  it("does not dispatch after another factory poisons the shared authority during acknowledgement", () => {
    const h = fixture(); let nested = false;
    const original = h.auth.authority.recordDispatch.bind(h.auth.authority);
    h.auth.authority.recordDispatch = (id, phase, wire) => {
      original(id, phase, wire);
      if (phase === "commit-prepared" && !nested) {
        nested = true;
        const reserve = h.auth.authority.reserve;
        h.auth.authority.reserve = () => {throw new Error("uncertain reservation");};
        h.open().publishNew(publish({path: `${PARENT}\\other.bin`, attemptId: OTHER_ATTEMPT}));
        h.auth.authority.reserve = reserve;
      }
    };
    expect(h.open().publishNew(publish()).state).toBe("UNKNOWN");
    expect(h.wires.map(w => w.operation)).toEqual(["prepare"]);
  });
});

it("captures invalid protocol bytes reversibly instead of UTF8 repair", () => {
  const h = fixture(), bytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
  h.behavior.result = r => ({...r, stdout: bytes.toString("latin1"), captureEncoding: "latin1"});
  expect(h.open().publishNew(publish()).state).toBe("UNKNOWN");
  const text = JSON.stringify(h.auth.terminals[0].evidence);
  const stored = JSON.parse(text).captured;
  expect(stored.captureEncoding).toBe("latin1"); expect(Buffer.from(stored.stdout, "latin1")).toEqual(bytes);
});

it("reserves terminal capacity before sequential native publications and still admits a smaller legal followup", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-v2-capacity-")));
  function platform(): PrivatePlatform {
    const p = new PosixPrivatePlatform(); return {kind: "windows", bind: p.bind.bind(p), assertRoot: p.assertRoot.bind(p), assertFile: p.assertFile.bind(p), assertSidecars: p.assertSidecars.bind(p), createExclusive: p.createExclusive.bind(p), assertEmptyFile: p.assertEmptyFile.bind(p), close: p.close.bind(p)};
  }
  let journal = new WindowsPublicationJournal(dir, platform()); const h = fixture();
  try {
    const first = h.openWith(journal).publishNew(publish({bytes: Buffer.alloc(600 * 1024), stagingPath: `${PARENT}\\.folio-private-${ATTEMPT}.tmp`}));
    expect(first.state).toBe("PUBLISHED"); const before = h.calls.length;
    const second = h.openWith(journal).publishNew(publish({path: `${PARENT}\\second.bin`, attemptId: OTHER_ATTEMPT, bytes: Buffer.alloc(WINDOWS_PRIVATE_IO_V2_MAX_BYTES), stagingPath: `${PARENT}\\.folio-private-${OTHER_ATTEMPT}.tmp`}));
    expect(second.state).toBe("UNKNOWN"); expect(h.calls).toHaveLength(before); expect(journal.inspect(OTHER_ATTEMPT)).toBeNull();
    journal.close(); journal = new WindowsPublicationJournal(dir, platform());
    const id = "c".repeat(32);
    expect(h.openWith(journal).publishNew(publish({path: `${PARENT}\\small.bin`, attemptId: id, stagingPath: `${PARENT}\\.folio-private-${id}.tmp`})).state).toBe("PUBLISHED");
    expect(journal.inspect(ATTEMPT)?.state).toBe("PUBLISHED");
  } finally {journal.close(); rmSync(dir, {recursive: true, force: true});}
});

it("durably retains worst bounded binary stdout and stderr after an uncertain final publication", async () => {
  const {PrivateLedger} = await import("../src/sync/private-ledger");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-v2-binary-evidence-")));
  function platform(): PrivatePlatform {
    const p = new PosixPrivatePlatform(); return {kind: "windows", bind: p.bind.bind(p), assertRoot: p.assertRoot.bind(p), assertFile: p.assertFile.bind(p), assertSidecars: p.assertSidecars.bind(p), createExclusive: p.createExclusive.bind(p), assertEmptyFile: p.assertEmptyFile.bind(p), close: p.close.bind(p)};
  }
  const journal = new WindowsPublicationJournal(dir, platform()), h = fixture();
  const stdout = Buffer.alloc(WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES, 0), stderr = Buffer.alloc(WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES, 0xff);
  try {
    h.behavior.result = (r, w) => w.operation === "commit-prepared" ? {...r, stdout: stdout.toString("latin1"), stderr: stderr.toString("latin1"), captureEncoding: "latin1"} : r;
    expect(h.openWith(journal).publishNew(publish({bytes: Buffer.alloc(WINDOWS_PRIVATE_IO_V2_MAX_BYTES), stagingPath: `${PARENT}\\.folio-private-${ATTEMPT}.tmp`})).state).toBe("UNKNOWN");
    expect(journal.inspect(ATTEMPT)?.state).toBe("UNKNOWN"); journal.close();
    const ledger = new PrivateLedger(dir, "publication-state.sqlite", "windows-publication-v2", [], platform());
    try {
      for (const [stream, original] of [["stdout", stdout], ["stderr", stderr]] as const) {
        const rows = ledger.entries(`attempt:${ATTEMPT}:terminal-capture:${stream}:`, 4096).sort((a, b) => Number(a.key.split(":").at(-1)) - Number(b.key.split(":").at(-1)));
        expect(Buffer.concat(rows.map(row => Buffer.from(row.value, "base64"))).equals(original)).toBe(true);
      }
      expect(ledger.capacity().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally {ledger.close();}
  } finally {journal.close(); rmSync(dir, {recursive: true, force: true});}
});
