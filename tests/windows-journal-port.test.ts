import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  durableFs, writeNewFileDurably, type WriteNewFileDurablyOptions,
} from "../src/persistence/durable-file";
import {
  writePendingJournalFile, type PendingJournalWriteOptions,
} from "../src/persistence/pending-journal-file";
import {
  PrivateFilePublicationUnknownError,
  type PrivateFilePort, type PrivateFilePublishRequest, type PrivateFilePublishResult,
} from "../src/platform/private-file-port";

// These fakes make no OS-native security or durability assertion.
const target = "C:\\Private\\draft.json";
const journalStage = "C:\\Private\\.draft.json.folio-journal-fixed.tmp";
const content = '{"draft":"saved"}';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const files = new Map<string, Buffer>();
  const events: string[] = [];
  const port: PrivateFilePort = {
    platform: "win32", implementation: "audited-native", auditReference: "in-memory-contract-only",
    capabilities: {
      synchronous: true, exclusivePublication: true, privateAccess: true, fileDurability: true,
      nameDurability: true, readback: true, retainedStaging: true, preservesUnknown: true,
    },
    publish: vi.fn((input: PrivateFilePublishRequest): PrivateFilePublishResult => {
      events.push("invoke");
      if (files.has(input.stagingPath)) return { status: "NOT_PUBLISHED", code: "EEXIST" };
      files.set(input.stagingPath, Buffer.from(input.bytes));
      events.push("stage", "readback");
      input.beforePublish(Buffer.from(files.get(input.stagingPath)!));
      events.push("approved");
      if (files.has(input.path)) return { status: "NOT_PUBLISHED", code: "EEXIST" };
      files.set(input.path, Buffer.from(files.get(input.stagingPath)!));
      events.push("publish", "durable");
      return { status: "PUBLISHED", path: input.path, stagingPath: input.stagingPath,
        readback: Buffer.from(files.get(input.path)!) };
    }),
  };
  const options: PendingJournalWriteOptions = {
    platform: "win32", privateFilePort: port, temporaryId: () => "fixed",
    validate(value) { events.push("validate"); JSON.parse(value); },
    checkDestination(path) { events.push("check"); expect(path).toBe(target); },
  };
  return {
    files, events, port,
    journal(value = content, overrides: Partial<PendingJournalWriteOptions> = {}) {
      return writePendingJournalFile(target, value, { ...options, ...overrides });
    },
    durable(value: string | NodeJS.ArrayBufferView = content, overrides: WriteNewFileDurablyOptions = {}) {
      return writeNewFileDurably(target, value, { platform: "win32", privateFilePort: port, ...overrides });
    },
  };
}
function failure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("Expected failure");
}
function tripwireDurableFs() {
  return (["openSync", "writeFileSync", "fsyncSync", "closeSync", "unlinkSync", "syncPath"] as const)
    .map(key => vi.spyOn(durableFs, key).mockImplementation(() => { throw new Error("POSIX operation"); }));
}

describe("Windows-selected file wrappers using an in-memory audited port", () => {
  it("writes private bytes with view offsets and stronger name durability without POSIX calls", () => {
    const spies = tripwireDurableFs();
    const f = fixture();
    const backing = new Uint8Array([9, 65, 66, 67, 8]);
    f.durable(new DataView(backing.buffer, 1, 3), { mode: 0o600 });
    const staging = [...f.files.keys()].find(path => path !== target)!;
    expect(staging).toMatch(/^C:\\Private\\\.draft\.json\.folio-private-[a-f0-9-]+\.tmp$/);
    expect(f.files.get(target)).toEqual(Buffer.from("ABC"));
    expect(f.files.get(staging)).toEqual(Buffer.from("ABC"));
    expect(f.events).toEqual(["invoke", "stage", "readback", "approved", "publish", "durable"]);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("validates/checks exactly twice synchronously before irreversible journal publication", () => {
    const spies = tripwireDurableFs();
    const f = fixture();
    const result = f.journal();
    expect(result).toEqual({ path: target, stagingPath: journalStage });
    expect(f.events).toEqual(["validate", "check", "invoke", "stage", "readback",
      "validate", "check", "approved", "publish", "durable"]);
    expect(f.files.get(target)).toEqual(Buffer.from(content));
    expect(f.files.get(journalStage)).toEqual(Buffer.from(content));
    expect(f.port.publish).toHaveBeenCalledTimes(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed on default Windows, unsupported platform, mismatched port and mixed POSIX operations", () => {
    const spies = tripwireDurableFs();
    const f = fixture();
    expect(() => f.durable(content, { privateFilePort: undefined })).toThrow();
    expect(() => f.journal(content, { privateFilePort: undefined })).toThrow();
    expect(() => f.durable(content, { platform: "plan9" as NodeJS.Platform })).toThrow();
    expect(() => f.journal(content, { platform: "plan9" as NodeJS.Platform })).toThrow();
    f.port.platform = "posix";
    expect(() => f.durable()).toThrow();
    expect(() => f.journal()).toThrow();
    f.port.platform = "win32";
    const operation = vi.fn(() => { throw new Error("must not invoke"); });
    expect(() => f.journal(content, { operations: { linkSync: operation } })).toThrow("cannot mix");
    expect(operation).not.toHaveBeenCalled();
    expect(f.port.publish).not.toHaveBeenCalled();
    expect(f.files.size).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("denies async or Promise-shaped publishers before invocation in both wrappers", () => {
    const f = fixture();
    let calls = 0;
    f.port.publish = (async () => { calls++; return {}; }) as unknown as PrivateFilePort["publish"];
    expect(() => f.durable()).toThrow("synchronous");
    expect(() => f.journal()).toThrow("synchronous");
    expect(calls).toBe(0);
    const promise = Promise.resolve(f.port) as unknown as PrivateFilePort;
    expect(() => f.durable(content, { privateFilePort: promise })).toThrow();
    expect(() => f.journal(content, { privateFilePort: promise })).toThrow();
    expect(calls).toBe(0);
  });

  it("rejects nonprivate modes, irreversible UTF-8, invalid journal paths and staging identifiers before invocation", () => {
    const f = fixture();
    expect(() => f.durable(content, { mode: 0o644 })).toThrow("0600");
    expect(() => f.durable("\ud800")).toThrow("UTF-8");
    expect(() => f.journal("\ud800")).toThrow("UTF-8");
    expect(() => f.journal(content, { temporaryId: () => "../escape" })).toThrow("identifier");
    expect(() => writePendingJournalFile("relative.json", content, {
      platform: "win32", privateFilePort: f.port, validate() {}, checkDestination() {},
    })).toThrow("arguments");
    expect(f.port.publish).not.toHaveBeenCalled();
    expect(f.files.size).toBe(0);
  });

  it.each(["validate", "checkDestination"] as const)(
    "rejects async %s initially without staging and during approval without publication", field => {
      for (const phase of [1, 2]) {
        const f = fixture();
        let calls = 0;
        const callback = () => ++calls === phase ? Promise.resolve() : undefined;
        const error = failure(() => f.journal(content, { [field]: callback }));
        expect(calls).toBe(phase);
        if (phase === 1) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("synchronous");
          expect(f.port.publish).not.toHaveBeenCalled();
          expect(f.files.size).toBe(0);
        } else {
          expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
          expect(f.port.publish).toHaveBeenCalledTimes(1);
          expect(f.files.get(journalStage)).toEqual(Buffer.from(content));
          expect(f.files.has(target)).toBe(false);
        }
      }
    },
  );

  it.each(["durable", "journal"] as const)(
    "preserves artifacts on tampered callback and final readback in %s", kind => {
      for (const phase of ["callback", "final"]) {
        const f = fixture();
        let staging = "";
        f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
          staging = input.stagingPath;
          f.files.set(staging, Buffer.from(input.bytes));
          if (phase === "callback") {
            f.files.set(staging, Buffer.alloc(input.bytes.length, 0xff));
            input.beforePublish(Buffer.from(f.files.get(staging)!));
          } else {
            input.beforePublish(Buffer.from(input.bytes));
            f.files.set(target, Buffer.alloc(input.bytes.length, 0x78));
            f.files.set(staging, Buffer.from(f.files.get(target)!));
          }
          return { status: "PUBLISHED", path: input.path, stagingPath: staging,
            readback: Buffer.from(f.files.get(target)!) };
        });
        const error = failure(() => f[kind]());
        expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
        expect(f.port.publish).toHaveBeenCalledTimes(1);
        expect(f.files.get(staging)).toEqual(Buffer.alloc(Buffer.byteLength(content), phase === "callback" ? 0xff : 0x78));
        expect(f.files.has(target)).toBe(phase === "final");
      }
    },
  );

  it.each(["durable", "journal"] as const)(
    "preserves old destination and staging on EEXIST through %s", kind => {
      const f = fixture();
      const original = Buffer.from("old destination");
      f.files.set(target, original);
      const error = failure(() => f[kind]()) as { code: string; result: unknown; stagingPath: string };
      expect(error.code).toBe("EEXIST");
      expect(error.result).toEqual({ status: "NOT_PUBLISHED", code: "EEXIST" });
      expect(f.files.get(target)).toBe(original);
      expect(f.files.get(error.stagingPath)).toEqual(Buffer.from(content));
      expect(f.port.publish).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["durable", "journal"] as const)(
    "retains all artifacts without retry for UNKNOWN, throw and thenable in %s", kind => {
      for (const outcome of ["unknown", "throw", "thenable"]) {
        const f = fixture();
        const evidence = { native: "original-evidence" };
        const artifacts: string[] = [];
        const response = outcome === "thenable" ? { then() {}, evidence } :
          { status: "UNKNOWN", evidence, artifacts };
        f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
          artifacts.push(input.stagingPath, input.path);
          f.files.set(input.stagingPath, Buffer.from(input.bytes));
          input.beforePublish(Buffer.from(input.bytes));
          f.files.set(input.path, Buffer.from(input.bytes));
          if (outcome === "throw") throw evidence;
          return response as PrivateFilePublishResult;
        });
        const error = failure(() => f[kind]()) as PrivateFilePublicationUnknownError;
        expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
        if (outcome === "throw") expect(error.cause).toBe(evidence);
        else expect(error.result).toBe(response);
        if (outcome === "unknown") {
          expect((error.result as { evidence: unknown }).evidence).toBe(evidence);
          expect((error.result as { artifacts: string[] }).artifacts).toBe(artifacts);
        }
        expect(f.port.publish).toHaveBeenCalledTimes(1);
        expect(artifacts).toHaveLength(2);
        for (const path of artifacts) expect(f.files.get(path)).toEqual(Buffer.from(content));
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("isolated legacy POSIX regressions (not Windows proof)", () => {
  function root() {
    const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-port-posix-")));
    roots.push(path);
    return path;
  }

  it("keeps default exclusive durable create and fsync-failure cleanup", () => {
    const directory = root();
    const existing = join(directory, "existing");
    writeNewFileDurably(existing, "original", { syncParentDirectory: true });
    expect(() => writeNewFileDurably(existing, "replacement")).toThrow();
    expect(fs.readFileSync(existing, "utf8")).toBe("original");
    expect(fs.statSync(existing).mode & 0o777).toBe(0o600);
    const failed = join(directory, "failed");
    vi.spyOn(durableFs, "fsyncSync").mockImplementation(() => { throw new Error("isolated fsync failure"); });
    expect(() => writeNewFileDurably(failed, "partial")).toThrow("isolated fsync failure");
    expect(fs.existsSync(failed)).toBe(false);
    expect(fs.readFileSync(existing, "utf8")).toBe("original");
  });

  it("keeps default journal retained hardlinks and never replaces an existing destination", () => {
    const directory = root();
    const path = join(directory, "journal");
    const options: PendingJournalWriteOptions = {
      validate(value) { JSON.parse(value); },
      checkDestination(destination) { expect(destination).toBe(path); },
      temporaryId: () => "fixed",
    };
    const result = writePendingJournalFile(path, content, options);
    expect(result.stagingPath).toBe(join(directory, ".journal.folio-journal-fixed.tmp"));
    expect(fs.readFileSync(path, "utf8")).toBe(content);
    expect(fs.readFileSync(result.stagingPath, "utf8")).toBe(content);
    expect(fs.statSync(path).ino).toBe(fs.statSync(result.stagingPath).ino);
    expect(() => writePendingJournalFile(path, '{"draft":"replace"}', options)).toThrow();
    expect(fs.readFileSync(path, "utf8")).toBe(content);
    expect(fs.readFileSync(result.stagingPath, "utf8")).toBe(content);
  });
});
