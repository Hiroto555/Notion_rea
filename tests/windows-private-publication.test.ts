import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  createWindowsPrivatePublication,
  createWindowsPrivatePublicationForTesting,
  WINDOWS_PRIVATE_IO_MAX_BYTES,
  WINDOWS_PRIVATE_IO_MAX_STDIN_BYTES,
  WINDOWS_PRIVATE_IO_MAX_OUTPUT_BYTES,
  type WindowsPrivateIoExecRequest,
  type WindowsPrivateIoExecResult,
  type WindowsPrivateIoTestPort,
  type WindowsPrivatePublicationOptions,
  type WindowsPrivatePublishRequest,
  type WindowsPrivateReadRequest,
} from "../src/platform/windows/private-publication";
import type { WindowsRuntimeFileStat } from "../src/platform/windows/runtime-platform";

const ROOT = "C:\\Folio";
const PARENT = `${ROOT}\\private`;
const TARGET = `${PARENT}\\new.bin`;
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned executable fixture");
const ROOT_ID = "1".repeat(32);
const DIRECTORY_ID = "2".repeat(32);
const FILE_ID = "3".repeat(32);
const VOLUME = "4".repeat(16);
const ATTEMPT = "a".repeat(32);
const OTHER_ATTEMPT = "b".repeat(32);
const SID = "S-1-5-21-1000";
const DATA = new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const stage = (attempt = ATTEMPT, parent = PARENT): string => `${parent}\\.folio-private-${attempt}.tmp`;
const OPTIONS: WindowsPrivatePublicationOptions = {
  root: ROOT, expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
  probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
};
const DIRECTORY = { fileId: DIRECTORY_ID, volumeId: VOLUME };
const publish = (overrides: Partial<WindowsPrivatePublishRequest> = {}): WindowsPrivatePublishRequest => ({
  path: TARGET, attemptId: ATTEMPT, expectedDirectory: DIRECTORY, bytes: DATA, ...overrides,
});
const read = (overrides: Partial<WindowsPrivateReadRequest> = {}): WindowsPrivateReadRequest => ({
  path: TARGET, expectedDirectory: DIRECTORY,
  expectedFile: { canonicalPath: TARGET, fileId: FILE_ID, volumeId: VOLUME },
  expectedSha256: hash(DATA), maxBytes: WINDOWS_PRIVATE_IO_MAX_BYTES, ...overrides,
});
type Wire = {
  version: number; operation: "publish-new" | "read-private"; path: string; root: string;
  rootFileId: string; rootVolumeId: string; directoryFileId: string; directoryVolumeId: string;
  attemptId?: string; bytesBase64?: string;
  fileId?: string; volumeId?: string; expectedSha256?: string; maxBytes?: number;
};
type Response = Record<string, unknown>;
const object = (value: unknown): Response => value as Response;
function proof(wire: Wire, directory = false): Response {
  return {
    platform: "win32", sid: SID, ownerSid: SID, daclPrivate: true, reparsePoint: false,
    linkCount: 1, localFilesystem: true,
    canonicalPath: directory ? wire.path.slice(0, wire.path.lastIndexOf("\\")) : wire.path,
    canonicalRoot: wire.root, fileId: directory ? wire.directoryFileId : (wire.fileId ?? FILE_ID),
    rootFileId: wire.rootFileId, rootVolumeId: wire.rootVolumeId, volumeId: wire.rootVolumeId,
  };
}
function envelope(wire: Wire): Response {
  return {
    version: 1, operation: wire.operation, path: wire.path, root: wire.root,
    ...(wire.operation === "publish-new" ? {
      attemptId: wire.attemptId,
      stagingPath: stage(wire.attemptId, wire.path.slice(0, wire.path.lastIndexOf("\\"))),
    } : {}),
  };
}
function result(response: unknown, status = 0): WindowsPrivateIoExecResult {
  return { status, signal: null, stdout: JSON.stringify(response), stderr: "" };
}
function fixture() {
  const calls: WindowsPrivateIoExecRequest[] = [];
  const wires: Wire[] = [];
  const fsCalls: string[] = [];
  const state: {
    exeBytes: Uint8Array; stat: Partial<WindowsRuntimeFileStat>; missing: boolean; readBytes: Uint8Array;
  } = { exeBytes: EXE_BYTES, stat: {}, missing: false, readBytes: DATA };
  const behavior: {
    response?: (response: Response, wire: Wire) => Response;
    result?: (output: WindowsPrivateIoExecResult, wire: Wire) => WindowsPrivateIoExecResult;
    exec?: (request: WindowsPrivateIoExecRequest, wire: Wire) => WindowsPrivateIoExecResult;
  } = {};
  const port: WindowsPrivateIoTestPort = {
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
      calls.push(request);
      const wire = JSON.parse(Buffer.from(request.input).toString("utf8")) as Wire;
      wires.push(wire);
      if (behavior.exec) return behavior.exec(request, wire);
      const bytes = wire.operation === "publish-new"
        ? Buffer.from(wire.bytesBase64!, "base64") : state.readBytes;
      let response: Response = {
        ...envelope(wire), file: proof(wire), directory: proof(wire, true),
        byteLength: bytes.byteLength, sha256: hash(bytes),
        ...(wire.operation === "publish-new"
          ? { state: "PUBLISHED", contentFlushed: true, namespace: "EXCLUSIVE_NO_REPLACE", namespaceDurability: "UNPROVEN" }
          : { state: "READ", bytesBase64: Buffer.from(bytes).toString("base64") }),
      };
      if (behavior.response) response = behavior.response(response, wire);
      const output = result(response);
      return behavior.result ? behavior.result(output, wire) : output;
    },
  };
  return { state, behavior, calls, wires, fsCalls, port,
    open: (options = OPTIONS) => createWindowsPrivatePublicationForTesting(options, port) };
}
function expectNoPrivateBytes(value: unknown): void {
  expect(object(value).state).not.toBe("READ");
  expect(value).not.toHaveProperty("bytes");
  expect(value).not.toHaveProperty("bytesBase64");
}

describe.skipIf(process.platform === "win32")("private publication v1 — untrusted in-memory contract, not Windows proof", () => {
  it("accepts complete publication proof and explicitly UNPROVEN namespace durability", () => {
    const h = fixture(), io = h.open();
    expect(io.trust).toBe("untrusted-test");
    expect(io.publishNew(publish())).toEqual({
      state: "PUBLISHED", path: TARGET, stagingPath: stage(), attemptId: ATTEMPT,
      identity: { canonicalPath: TARGET, fileId: FILE_ID, volumeId: VOLUME },
      byteLength: DATA.byteLength, sha256: hash(DATA), contentFlushed: true,
      namespace: "EXCLUSIVE_NO_REPLACE", namespaceDurability: "UNPROVEN",
    });
    expect(h.calls).toHaveLength(1);
    expect(h.wires[0]).toEqual({
      version: 1, operation: "publish-new", path: TARGET, root: ROOT,
      rootFileId: ROOT_ID, rootVolumeId: VOLUME,
      directoryFileId: DIRECTORY_ID, directoryVolumeId: VOLUME,
      attemptId: ATTEMPT, bytesBase64: Buffer.from(DATA).toString("base64"),
    });
    expect(h.fsCalls.every((call) => call.endsWith(EXE))).toBe(true);
  });

  it("preserves original and staging on exclusive collision with exactly one dispatch", () => {
    const h = fixture(), io = h.open();
    const original = Buffer.from("original immutable bytes");
    const files = new Map<string, Uint8Array>([[TARGET, original]]);
    h.behavior.exec = (_request, wire) => {
      files.set(stage(), Buffer.from(wire.bytesBase64!, "base64"));
      return result({ ...envelope(wire), state: "EXISTS", reason: "PRIVATE_IO_EXISTS" }, 2);
    };
    expect(io.publishNew(publish())).toEqual({
      state: "EXISTS", path: TARGET, stagingPath: stage(), attemptId: ATTEMPT,
      preserve: true, reason: "PRIVATE_IO_EXISTS",
    });
    expect(files.get(TARGET)).toBe(original);
    expect(files.get(stage())).toEqual(Buffer.from(DATA));
    expect(h.calls).toHaveLength(1);
  });

  it.each(["REJECTED", "UNKNOWN"] as const)("accepts only the exact %s failure envelope", (state) => {
    const h = fixture(), io = h.open();
    h.behavior.exec = (_request, wire) => result({
      ...envelope(wire), state, reason: `PRIVATE_IO_${state}`,
    }, state === "REJECTED" ? 1 : 3);
    expect(io.publishNew(publish())).toMatchObject({
      state, path: TARGET, attemptId: ATTEMPT, stagingPath: stage(), preserve: true,
    });
  });

  it("consumes both attempt and case-folded target before UNKNOWN, even with changed bytes", () => {
    const h = fixture(), io = h.open();
    h.behavior.exec = () => { throw new Error("executor failed"); };
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
    expect(() => io.publishNew(publish({ bytes: new Uint8Array([9]) }))).toThrow(CollaborationError);
    expect(() => io.publishNew(publish({ path: `${PARENT}\\other.bin` }))).toThrow(CollaborationError);
    expect(() => io.publishNew(publish({ attemptId: OTHER_ATTEMPT }))).toThrow(CollaborationError);
    expect(() => io.publishNew(publish({ path: "C:\\FOLIO\\PRIVATE\\NEW.BIN", attemptId: OTHER_ATTEMPT }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(1);
    // A separate, explicit authenticated read is not an automatic retry.
    h.behavior.exec = undefined;
    expect(io.readPrivate(read()).state).toBe("READ");
    expect(h.calls).toHaveLength(2);
  });

  it("also consumes successful/REJECTED/EXISTS attempts rather than silently reusing them", () => {
    for (const state of ["PUBLISHED", "REJECTED", "EXISTS"] as const) {
      const h = fixture(), io = h.open();
      if (state !== "PUBLISHED") h.behavior.exec = (_r, wire) => result({
        ...envelope(wire), state, reason: `PRIVATE_IO_${state}`,
      }, state === "EXISTS" ? 2 : 1);
      expect(io.publishNew(publish()).state).toBe(state);
      expect(() => io.publishNew(publish())).toThrow(CollaborationError);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("supports a preexisting parent equal to the pinned private root", () => {
    const h = fixture(), io = h.open();
    expect(io.publishNew(publish({
      path: `${ROOT}\\direct.bin`, expectedDirectory: { fileId: ROOT_ID, volumeId: VOLUME },
    })).state).toBe("PUBLISHED");
    expect(() => io.publishNew(publish({ path: `${ROOT}\\bad.bin`, attemptId: OTHER_ATTEMPT }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(1);
  });
});

const badProofs: Array<[string, "file" | "directory", string, unknown]> = [
  ["public ACL", "file", "daclPrivate", false],
  ["other owner", "file", "ownerSid", "S-1-5-21-9999"],
  ["reparse point", "file", "reparsePoint", true],
  ["multiple links", "file", "linkCount", 2],
  ["remote filesystem", "file", "localFilesystem", false],
  ["wrong platform", "file", "platform", "darwin"],
  ["bad file ID", "file", "fileId", "bad"],
  ["root identity swap", "file", "rootFileId", "9".repeat(32)],
  ["root volume swap", "file", "rootVolumeId", "9".repeat(16)],
  ["file volume swap", "file", "volumeId", "9".repeat(16)],
  ["target path swap", "file", "canonicalPath", `${PARENT}\\other.bin`],
  ["root path swap", "file", "canonicalRoot", "C:\\Other"],
  ["parent identity swap", "directory", "fileId", "9".repeat(32)],
  ["parent volume swap", "directory", "volumeId", "9".repeat(16)],
  ["parent path swap", "directory", "canonicalPath", ROOT],
  ["parent ACL", "directory", "daclPrivate", false],
  ["parent root identity", "directory", "rootFileId", "9".repeat(32)],
  ["extra evidence", "file", "extra", true],
];
describe.skipIf(process.platform === "win32")("strict native evidence and authentication", () => {
  it.each(badProofs)("rejects %s for publish and drops all read bytes", (_label, field, key, value) => {
    const h = fixture(), io = h.open();
    h.behavior.response = (r) => ({ ...r, [field]: { ...object(r[field]), [key]: value } });
    expect(io.publishNew(publish())).toMatchObject({ state: "UNKNOWN", path: TARGET, stagingPath: stage(), preserve: true });
    expectNoPrivateBytes(io.readPrivate(read()));
  });

  it("requires current SID agreement across file and directory and across receipts", () => {
    const h = fixture(), io = h.open();
    h.behavior.response = (r) => ({
      ...r, file: { ...object(r.file), sid: "S-1-5-21-8888", ownerSid: "S-1-5-21-8888" },
    });
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
    expectNoPrivateBytes(io.readPrivate(read()));
    h.behavior.response = undefined;
    expect(io.readPrivate(read()).state).toBe("READ");
    h.behavior.response = (r) => ({
      ...r,
      file: { ...object(r.file), sid: "S-1-5-21-8888", ownerSid: "S-1-5-21-8888" },
      directory: { ...object(r.directory), sid: "S-1-5-21-8888", ownerSid: "S-1-5-21-8888" },
    });
    expectNoPrivateBytes(io.readPrivate(read()));
  });

  it("authenticates exact binary bytes and mandatory caller file identity/hash", () => {
    const h = fixture(), io = h.open();
    const receipt = io.readPrivate(read());
    expect(receipt).toEqual({
      state: "READ", identity: { canonicalPath: TARGET, fileId: FILE_ID, volumeId: VOLUME },
      bytes: DATA, byteLength: DATA.byteLength, sha256: hash(DATA),
    });
    expect(h.wires[0]).toEqual({
      version: 1, operation: "read-private", path: TARGET, root: ROOT,
      rootFileId: ROOT_ID, rootVolumeId: VOLUME, directoryFileId: DIRECTORY_ID, directoryVolumeId: VOLUME,
      fileId: FILE_ID, volumeId: VOLUME, expectedSha256: hash(DATA), maxBytes: WINDOWS_PRIVATE_IO_MAX_BYTES,
    });
    h.behavior.response = (r) => ({ ...r, file: { ...object(r.file), fileId: "9".repeat(32) } });
    expectNoPrivateBytes(io.readPrivate(read()));
  });

  it("computes hash of decoded bytes rather than trusting the helper's hash claim", () => {
    const h = fixture(), io = h.open();
    const bad = Uint8Array.from(DATA);
    bad[0] = 1;
    h.behavior.response = (r) => ({ ...r, bytesBase64: Buffer.from(bad).toString("base64") });
    expectNoPrivateBytes(io.readPrivate(read()));
  });

  it.each([
    ["invalid alphabet", "!!!!"],
    ["whitespace", `${Buffer.from(DATA).toString("base64")}\n`],
    ["missing padding", Buffer.from(DATA).toString("base64").replace(/=+$/, "")],
    ["noncanonical pad bits", "AB=="],
  ])("rejects noncanonical base64: %s", (_label, bytesBase64) => {
    const h = fixture(), io = h.open();
    h.behavior.response = (r) => ({ ...r, bytesBase64, byteLength: bytesBase64 === "AB==" ? 1 : DATA.byteLength });
    expectNoPrivateBytes(io.readPrivate(read()));
  });

  it.each([
    { byteLength: -1 }, { byteLength: 1.5 }, { byteLength: DATA.byteLength + 1 },
    { byteLength: WINDOWS_PRIVATE_IO_MAX_BYTES + 1 }, { sha256: "0".repeat(64) },
    { sha256: hash(DATA).toUpperCase() }, { contentFlushed: false },
    { namespace: "REPLACE" }, { namespaceDurability: "DURABLE" }, { extra: true },
  ])("does not accept inaccurate publication claims %j", (patch) => {
    const h = fixture(), io = h.open();
    h.behavior.response = (r) => ({ ...r, ...patch });
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
  });

  it.each([{ byteLength: -1 }, { byteLength: 1.5 }, { byteLength: DATA.byteLength - 1 }, { sha256: "0".repeat(64) }, { extra: true }])(
    "does not expose bytes for inaccurate read claims %j", (patch) => {
      const h = fixture(), io = h.open();
      h.behavior.response = (r) => ({ ...r, ...patch });
      expectNoPrivateBytes(io.readPrivate(read()));
    },
  );
});

const badResults: Array<[string, (r: WindowsPrivateIoExecResult) => WindowsPrivateIoExecResult]> = [
  ["timeout", (r) => ({ ...r, status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" })],
  ["executor error", (r) => ({ ...r, errorCode: "EIO" })],
  ["wrong status", (r) => ({ ...r, status: 1 })],
  ["null status", (r) => ({ ...r, status: null })],
  ["stderr", (r) => ({ ...r, stderr: "untrusted diagnostic" })],
  ["bad JSON", (r) => ({ ...r, stdout: "{" })],
  ["BOM", (r) => ({ ...r, stdout: `\ufeff${r.stdout}` })],
  ["trailing JSON", (r) => ({ ...r, stdout: `${r.stdout}{}` })],
  ["invalid UTF8 replacement", (r) => ({ ...r, stdout: `${r.stdout}\ufffd` })],
  ["duplicate state", (r) => ({ ...r, stdout: r.stdout.replace(/^\{/, '{"state":"UNKNOWN",') })],
  ["escaped duplicate state", (r) => ({ ...r, stdout: r.stdout.replace(/^\{/, '{"st\\u0061te":"UNKNOWN",') })],
  ["duplicate nested key", (r) => ({ ...r, stdout: r.stdout.replace('"file":{', '"file":{"daclPrivate":true,') })],
  ["extra envelope key", (r) => ({ ...r, stdout: r.stdout.replace(/^\{/, '{"extra":0,') })],
  ["oversize output", (r) => ({ ...r, stdout: " ".repeat(WINDOWS_PRIVATE_IO_MAX_OUTPUT_BYTES + 1) })],
  ["deep output", (r) => ({ ...r, stdout: '{"x":'.repeat(20) + "0" + "}".repeat(20) })],
  ["extra executor key", (r) => ({ ...r, extra: true }) as WindowsPrivateIoExecResult],
];
describe.skipIf(process.platform === "win32")("ambiguity always preserves known metadata and drops read bytes", () => {
  it.each(badResults)("%s", (_label, corrupt) => {
    const h = fixture(), io = h.open();
    h.behavior.result = corrupt;
    expect(io.publishNew(publish())).toEqual({
      state: "UNKNOWN", reason: "PRIVATE_IO_UNCONFIRMED", preserve: true,
      path: TARGET, attemptId: ATTEMPT, stagingPath: stage(),
    });
    expectNoPrivateBytes(io.readPrivate(read()));
    expect(h.calls).toHaveLength(2);
  });

  it.each([
    { version: 2 }, { operation: "other" }, { path: `${PARENT}\\other.bin` }, { root: "C:\\Other" },
    { attemptId: OTHER_ATTEMPT }, { stagingPath: stage(OTHER_ATTEMPT) },
  ])("requires request-bound publication envelope %j", (patch) => {
    const h = fixture(), io = h.open();
    h.behavior.response = (r) => ({ ...r, ...patch });
    expect(io.publishNew(publish())).toMatchObject({ state: "UNKNOWN", path: TARGET, attemptId: ATTEMPT, stagingPath: stage() });
  });

  it("does not allow failure envelopes to smuggle private bytes or arbitrary reasons", () => {
    for (const patch of [{ bytesBase64: Buffer.from(DATA).toString("base64") }, { reason: "secret diagnostic" }]) {
      const h = fixture(), io = h.open();
      h.behavior.exec = (_r, wire) => result({
        ...envelope(wire), state: "UNKNOWN", reason: "PRIVATE_IO_UNKNOWN", ...patch,
      }, 3);
      expect(io.publishNew(publish())).toMatchObject({ state: "UNKNOWN", reason: "PRIVATE_IO_UNCONFIRMED" });
      expectNoPrivateBytes(io.readPrivate(read()));
    }
  });

  it("rejects accessor executor results without evaluating them", () => {
    const h = fixture(), io = h.open();
    const getter = vi.fn(() => "secret getter");
    h.behavior.result = (r) => {
      Object.defineProperty(r, "stdout", { enumerable: true, get: getter });
      return r;
    };
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
    expectNoPrivateBytes(io.readPrivate(read()));
    expect(getter).not.toHaveBeenCalled();
  });

  it("sanitizes a throwing read executor without exposing bytes or error messages", () => {
    const h = fixture(), io = h.open();
    h.behavior.exec = () => { throw new Error("untrusted-private-diagnostic"); };
    const failure = io.readPrivate(read());
    expect(failure).toEqual({ state: "UNKNOWN", path: TARGET, reason: "PRIVATE_IO_UNCONFIRMED", preserve: true });
    expectNoPrivateBytes(failure);
    expect(h.calls).toHaveLength(1);
  });
});

describe.skipIf(process.platform === "win32")("bounds and dispatch boundary", () => {
  it("accepts exactly 1 MiB and bounds final encoded stdin including metadata overhead", () => {
    const h = fixture(), io = h.open(), bytes = new Uint8Array(WINDOWS_PRIVATE_IO_MAX_BYTES).fill(255);
    const path = `${PARENT}\\${"x".repeat(240 - PARENT.length - 1)}`;
    expect(io.publishNew(publish({ bytes, path })).state).toBe("PUBLISHED");
    const encoded = h.calls[0].input.byteLength;
    expect(encoded).toBeGreaterThan(Buffer.from(bytes).toString("base64").length);
    expect(encoded).toBeLessThanOrEqual(WINDOWS_PRIVATE_IO_MAX_STDIN_BYTES);
    expect(encoded).toBe(Buffer.byteLength(JSON.stringify(h.wires[0]), "utf8"));
    h.state.readBytes = bytes;
    const receipt = io.readPrivate(read({ expectedSha256: hash(bytes) }));
    expect(receipt.state).toBe("READ");
    if (receipt.state === "READ") expect(receipt.bytes).toEqual(bytes);
  });

  it("accepts a 1 MiB plus-heavy base64 read within the complete pipe bounds", () => {
    const h = fixture(), io = h.open();
    const pattern = [0xfb, 0xef, 0xbe];
    const bytes = Uint8Array.from({ length: WINDOWS_PRIVATE_IO_MAX_BYTES }, (_value, i) => pattern[i % pattern.length]);
    const base64 = Buffer.from(bytes).toString("base64");
    expect(base64).toContain("+".repeat(256));
    h.state.readBytes = bytes;
    let stdout = "";
    h.behavior.result = (output) => { stdout = output.stdout; return output; };
    const receipt = io.readPrivate(read({
      expectedSha256: hash(bytes), maxBytes: WINDOWS_PRIVATE_IO_MAX_BYTES,
    }));
    expect(receipt.state).toBe("READ");
    if (receipt.state === "READ") {
      expect(receipt.byteLength).toBe(WINDOWS_PRIVATE_IO_MAX_BYTES);
      expect(receipt.bytes).toEqual(bytes);
    }
    expect(stdout).toContain("+".repeat(256));
    expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(WINDOWS_PRIVATE_IO_MAX_OUTPUT_BYTES);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].input.byteLength).toBeLessThanOrEqual(WINDOWS_PRIVATE_IO_MAX_STDIN_BYTES);
  });

  it("rejects oversized payload before exec; no attempt is consumed before dispatch", () => {
    const h = fixture(), io = h.open();
    expect(() => io.publishNew(publish({ bytes: new Uint8Array(WINDOWS_PRIVATE_IO_MAX_BYTES + 1) }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(0);
    expect(io.publishNew(publish()).state).toBe("PUBLISHED");
  });

  it("allows empty files with maxBytes zero but never leaks nonempty/oversize reads", () => {
    const h = fixture(), io = h.open();
    expectNoPrivateBytes(io.readPrivate(read({ maxBytes: 0 })));
    expectNoPrivateBytes(io.readPrivate(read({ maxBytes: DATA.byteLength - 1 })));
    h.state.readBytes = new Uint8Array();
    expect(io.readPrivate(read({ expectedSha256: hash(new Uint8Array()), maxBytes: 0 }))).toMatchObject({
      state: "READ", byteLength: 0, bytes: new Uint8Array(),
    });
    expect(io.publishNew(publish({ bytes: new Uint8Array() })).state).toBe("PUBLISHED");
  });

  it.each([-1, 0.5, Number.NaN, Infinity, WINDOWS_PRIVATE_IO_MAX_BYTES + 1])("rejects invalid maxBytes %s before dispatch", (maxBytes) => {
    const h = fixture(), io = h.open();
    expect(() => io.readPrivate(read({ maxBytes }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ROOT, "C:\\Other\\new.bin", "\\\\server\\private\\new.bin", "\\\\?\\C:\\Folio\\new.bin",
    `${PARENT}\\..\\new.bin`, `${PARENT}\\new.bin:ads`, `${PARENT}\\new.bin.`,
    `${PARENT}\\new.bin `, `${PARENT}\\NUL`, `${PARENT}\\short~1.bin`,
    `${PARENT}/new.bin`, "c:\\Folio\\private\\new.bin", `${PARENT}\\日本語.bin`,
    `${PARENT}\\${"x".repeat(241)}`, stage(),
  ])("rejects unsafe/noncanonical path without exec: %s", (path) => {
    const h = fixture(), io = h.open();
    expect(() => io.publishNew(publish({ path }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(0);
  });

  it("bounds staging as well as target paths, and accepts a 240-character target", () => {
    const h = fixture(), io = h.open();
    const target = `${PARENT}\\${"x".repeat(240 - PARENT.length - 1)}`;
    expect(target).toHaveLength(240);
    expect(io.publishNew(publish({ path: target })).state).toBe("PUBLISHED");
    const longParent = `${ROOT}\\${"d".repeat(205)}`;
    expect(() => io.publishNew(publish({ path: `${longParent}\\x`, attemptId: OTHER_ATTEMPT }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(1);
  });

  it.each(["", "A".repeat(32), "a".repeat(31), "a".repeat(33), "../bad"])("requires an explicit lowercase 32-hex attempt: %s", (attemptId) => {
    const h = fixture(), io = h.open();
    expect(() => io.publishNew(publish({ attemptId }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(0);
  });

  it.each(["", "a".repeat(63), "A".repeat(64), "g".repeat(64)])("requires mandatory lowercase caller SHA256: %s", (expectedSha256) => {
    const h = fixture(), io = h.open();
    expect(() => io.readPrivate(read({ expectedSha256 }))).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects wrong caller volume, identity path, and extra/accessor request fields before dispatch", () => {
    const h = fixture(), io = h.open();
    expect(() => io.publishNew(publish({ expectedDirectory: { ...DIRECTORY, volumeId: "9".repeat(16) } }))).toThrow(CollaborationError);
    expect(() => io.readPrivate(read({ expectedFile: { canonicalPath: `${PARENT}\\other`, fileId: FILE_ID, volumeId: VOLUME } }))).toThrow(CollaborationError);
    expect(() => io.readPrivate(read({ expectedFile: { canonicalPath: TARGET, fileId: FILE_ID, volumeId: "9".repeat(16) } }))).toThrow(CollaborationError);
    expect(() => io.publishNew({ ...publish(), extra: true } as WindowsPrivatePublishRequest)).toThrow(CollaborationError);
    const getter = vi.fn(() => DATA);
    const request = { ...publish() };
    Object.defineProperty(request, "bytes", { enumerable: true, get: getter });
    expect(() => io.publishNew(request)).toThrow(CollaborationError);
    expect(getter).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it("keeps secret bytes in the pipe input only, with sanitized errors and no logging", () => {
    const secret = "private-test-only-do-not-log";
    const bytes = Buffer.from(secret), encoded = bytes.toString("base64");
    const h = fixture(), io = h.open();
    const logs = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    try {
      h.behavior.exec = () => { throw new Error(`${secret}:${encoded}`); };
      const failure = io.publishNew(publish({ bytes }));
      expect(failure.state).toBe("UNKNOWN");
      // Assert outside exec: the port intentionally sanitizes thrown executor
      // errors, which would otherwise also swallow a failing test assertion.
      const request = h.calls[0];
      expect(Buffer.from(request.input).toString("utf8")).toContain(encoded);
      const { input: _input, ...nonPrivate } = request;
      expect(JSON.stringify(nonPrivate)).not.toContain(secret);
      expect(JSON.stringify(nonPrivate)).not.toContain(encoded);
      expect(request.args).toEqual(["--private-io-v1"]);
      expect(request).toMatchObject({
        executable: EXE, cwd: "C:\\Windows", timeoutMs: 15_000,
        maxBuffer: WINDOWS_PRIVATE_IO_MAX_OUTPUT_BYTES,
        shell: false, windowsHide: true, stdio: "pipe", encoding: "utf8",
        env: { SystemRoot: "C:\\Windows", windir: "C:\\Windows", TEMP: "C:\\Windows\\Temp", TMP: "C:\\Windows\\Temp" },
      });
      expect(Object.keys(request.env).sort()).toEqual(["SystemRoot", "TEMP", "TMP", "windir"]);
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(encoded);
      h.behavior.exec = () => ({ status: 1, signal: null, stdout: encoded, stderr: secret });
      expectNoPrivateBytes(io.readPrivate(read()));
      expect(() => io.publishNew(publish({ bytes }))).toThrow("WINDOWS_PRIVATE_IO_PUBLISH_REJECTED");
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { for (const log of logs) log.mockRestore(); }
  });
});

describe.skipIf(process.platform === "win32")("trusted helper factory and executable pins", () => {
  it("rejects production fake injection before touching an executable; native Mac capability is unsupported", () => {
    const h = fixture();
    const factory = createWindowsPrivatePublication as unknown as (...args: unknown[]) => unknown;
    expect(() => factory(OPTIONS, h.port)).toThrow(CollaborationError);
    if (process.platform !== "win32") expect(() => createWindowsPrivatePublication(OPTIONS)).toThrow("UNSUPPORTED_PLATFORM");
    expect(h.fsCalls).toHaveLength(0);
  });

  it("requires a present exact SHA256 and regular single-link helper", () => {
    const h = fixture();
    expect(() => h.open({ ...OPTIONS, expectedHash: "" })).toThrow(CollaborationError);
    expect(() => h.open({ ...OPTIONS, expectedHash: "0".repeat(64) })).toThrow(CollaborationError);
    const { expectedHash: _hash, ...missing } = OPTIONS;
    expect(() => h.open(missing as WindowsPrivatePublicationOptions)).toThrow(CollaborationError);
    h.state.missing = true;
    expect(() => h.open()).toThrow(CollaborationError);
    h.state.missing = false;
    for (const stat of [{ nlink: 2 }, { isFile: () => false }, { isSymbolicLink: () => true }, { isDirectory: () => true }]) {
      h.state.stat = stat;
      expect(() => h.open()).toThrow(CollaborationError);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("rejects extra or accessor options, identities and test ports without invoking getters", () => {
    const h = fixture();
    expect(() => h.open({ ...OPTIONS, untrustedTestPort: h.port } as WindowsPrivatePublicationOptions)).toThrow(CollaborationError);
    expect(() => createWindowsPrivatePublicationForTesting(OPTIONS, { ...h.port, extra: true } as WindowsPrivateIoTestPort)).toThrow(CollaborationError);
    expect(() => h.open({ ...OPTIONS, expectedRoot: { ...OPTIONS.expectedRoot, extra: true } } as WindowsPrivatePublicationOptions)).toThrow(CollaborationError);
    const getter = vi.fn(() => "secret");
    const options = { ...OPTIONS };
    Object.defineProperty(options, "root", { enumerable: true, get: getter });
    expect(() => h.open(options)).toThrow(CollaborationError);
    expect(getter).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it.each(["hash", "stat", "missing"] as const)("rejects a changed helper %s before dispatch", (kind) => {
    const h = fixture(), io = h.open();
    if (kind === "hash") h.state.exeBytes = new Uint8Array(EXE_BYTES.byteLength).fill(0);
    if (kind === "stat") h.state.stat = { ino: 999 };
    if (kind === "missing") h.state.missing = true;
    expect(() => io.publishNew(publish())).toThrow(CollaborationError);
    expect(() => io.readPrivate(read())).toThrow(CollaborationError);
    expect(h.calls).toHaveLength(0);
  });

  it.each(["hash", "stat", "missing"] as const)("rejects a changed helper %s after dispatch, without returning read bytes", (kind) => {
    for (const operation of ["publish", "read"] as const) {
      const h = fixture(), io = h.open();
      h.behavior.result = (r) => {
        if (kind === "hash") h.state.exeBytes = new Uint8Array(EXE_BYTES.byteLength).fill(0);
        if (kind === "stat") h.state.stat = { mtimeMs: 2 };
        if (kind === "missing") h.state.missing = true;
        return r;
      };
      const receipt = operation === "publish" ? io.publishNew(publish()) : io.readPrivate(read());
      expect(receipt.state).toBe("UNKNOWN");
      expectNoPrivateBytes(receipt);
      expect(h.calls).toHaveLength(1);
    }
  });

  it("pins even after a throwing executor and detects mutation during a hash read", () => {
    const h = fixture(), io = h.open();
    const before = h.fsCalls.length;
    h.behavior.exec = () => { throw new Error("failed"); };
    expect(io.publishNew(publish()).state).toBe("UNKNOWN");
    expect(h.fsCalls.length - before).toBe(6); // stat/read/stat both before AND after.
    let counter = 0;
    const changing: WindowsPrivateIoTestPort = {
      exec: h.port.exec,
      fs: {
        readFile: h.port.fs.readFile,
        lstat(path) { return { ...h.port.fs.lstat(path), mtimeMs: counter++ }; },
      },
    };
    expect(() => createWindowsPrivatePublicationForTesting(OPTIONS, changing)).toThrow(CollaborationError);
  });
});

describe.skipIf(process.platform !== "win32")("Windows test-port host boundary", () => {
  it("forbids the contract-test factory before any filesystem or executor call", () => {
    const h = fixture();
    expect(() => createWindowsPrivatePublicationForTesting(OPTIONS, h.port)).toThrow("WINDOWS_PRIVATE_IO_TEST_PORT_FORBIDDEN");
    expect(h.fsCalls).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });
});

describe("helper source guardrails (NOT native validation)", () => {
  it("adds pipe-only bounded v1 dispatch without removing legacy modes or adding deletion", () => {
    const source = readFileSync(new URL("../scripts/platform/windows/PrivateRootProbeProgram.cs", import.meta.url), "utf8");
    expect(source).toContain('if(args.Length==1&&args[0]=="--private-io-v1")return PrivateIoMode();');
    for (const mode of ["probe", "create", "open", "directory"]) expect(source).toContain(`"${mode}"`);
    expect(source).toContain("FileMode.CreateNew");
    expect(source).toContain("OpenDirectoryHandle");
    expect(source).not.toContain("Delete(");
    const added = source.slice(source.indexOf("// Private I/O v1"));
    expect(added).toContain("GetFileType(GetStdHandle(IoStdInputHandle))==IoFileTypePipe");
    expect(added).toContain("GetFileType(GetStdHandle(IoStdOutputHandle))==IoFileTypePipe");
    expect(added).toContain("new System.Text.UTF8Encoding(false,true)");
    expect(added).toContain("PrivateIoMaxStdinBytes+1");
    expect(added).toContain("obj.EnumerateObject()");
    expect(added).toContain("!fields.ContainsKey(property.Name)");
    expect(added).not.toContain("ReadToEnd(");
    expect(added).not.toContain("Console.Write(");
    expect(added).not.toContain("Console.IsOutputRedirected");
    expect(added).toContain("Console.OpenStandardOutput()");
    // Source guard only: this does not execute the native JSON serializer.
    const ioOutput = added.slice(added.indexOf(" static int IoOutput("), added.indexOf(" static int IoFailure("));
    expect(ioOutput).toContain("JsonSerializer.SerializeToUtf8Bytes(response,new JsonSerializerOptions {");
    expect(ioOutput).toContain("Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping");
    expect(added).toContain('string sddl="O:"+sid+"G:"+sid+"D:P(A;;FA;;;"+sid+")";');
    expect(added).toContain("InheritHandle=false");
    expect(added).toContain("IoCreateNew=1");
    expect(added).toContain("FileReadAttributes|IoReadControl,IoShareRead");
    expect(added).toContain("IoGenericRead|IoGenericWrite|IoDeleteAccess|IoReadControl,IoShareRead");
    expect(added).toContain("IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting");
    expect(added).toContain('EntryPoint="SetFileInformationByHandle"');
    expect(added).toContain("IoFileRenameInfo=3");
    expect(added).toContain("Marshal.OffsetOf<IO_RENAME_INFO>");
    expect(added).toContain("Marshal.WriteByte(buffer,replaceOffset,0)");
    expect(added).toContain("Marshal.WriteIntPtr(buffer,rootOffset,IntPtr.Zero)");
    expect(added).toContain("IoLocalFree(descriptor)");
    expect(added).toContain("stream.Flush(true)");
    expect(added).toContain("CryptographicOperations.FixedTimeEquals");
    expect(added).toContain('namespaceDurability="UNPROVEN"');
    expect(added).not.toMatch(/MoveFileEx|File\.Move|CreateDirectory\(/);
  });
});
