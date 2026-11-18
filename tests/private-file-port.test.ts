import { describe, expect, it, vi } from "vitest";
import {
  PrivateFileNotPublishedError,
  PrivateFilePublicationUnknownError,
  publishPrivateFile,
  selectPrivateFilePlatform,
  type PrivateFilePort,
  type PrivateFilePublishRequest,
  type PrivateFilePublishResult,
} from "../src/platform/private-file-port";

// In-memory contract coverage only: this is not Windows/native/ACL proof.
const target = "C:\\Private\\draft.json";
const stage = "C:\\Private\\.draft.json.folio-private-fixed.tmp";
const bytes = Buffer.from("draft");
function request(beforePublish: PrivateFilePublishRequest["beforePublish"] = () => {}): PrivateFilePublishRequest {
  return { path: target, stagingPath: stage, bytes: Buffer.from(bytes), beforePublish };
}
function fixture() {
  const files = new Map<string, Buffer>();
  const events: string[] = [];
  const port: PrivateFilePort = {
    platform: "win32", implementation: "audited-native", auditReference: "contract-fixture-only",
    capabilities: {
      synchronous: true, exclusivePublication: true, privateAccess: true, fileDurability: true,
      nameDurability: true, readback: true, retainedStaging: true, preservesUnknown: true,
    },
    publish: vi.fn((input: PrivateFilePublishRequest): PrivateFilePublishResult => {
      events.push("invoke");
      if (files.has(input.stagingPath)) return { status: "NOT_PUBLISHED", code: "EEXIST" };
      files.set(input.stagingPath, Buffer.from(input.bytes));
      events.push("stage", "approval");
      input.beforePublish(Buffer.from(files.get(input.stagingPath)!));
      if (files.has(input.path)) return { status: "NOT_PUBLISHED", code: "EEXIST" };
      events.push("publish");
      files.set(input.path, Buffer.from(files.get(input.stagingPath)!));
      return { status: "PUBLISHED", path: input.path, stagingPath: input.stagingPath,
        readback: Buffer.from(files.get(input.path)!) };
    }),
  };
  return { port, files, events };
}
function failure(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("Expected failure");
}
function published(input: PrivateFilePublishRequest): Extract<PrivateFilePublishResult, { status: "PUBLISHED" }> {
  return { status: "PUBLISHED", path: input.path, stagingPath: input.stagingPath,
    readback: Buffer.from(input.bytes) };
}

describe("synchronous private file publication contract", () => {
  it("approves exact staging once, verifies exact final bytes, and retains staging", () => {
    const f = fixture();
    const approval = vi.fn((readback: Uint8Array) => {
      expect(Buffer.from(readback)).toEqual(bytes);
      f.events.push("approved");
    });
    const result = publishPrivateFile(f.port, request(approval), "win32");
    expect(result).toEqual({ status: "PUBLISHED", path: target, stagingPath: stage, readback: bytes });
    expect(f.events).toEqual(["invoke", "stage", "approval", "approved", "publish"]);
    expect(approval).toHaveBeenCalledTimes(1);
    expect(f.files.get(target)).toEqual(bytes);
    expect(f.files.get(stage)).toEqual(bytes);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    "synchronous", "exclusivePublication", "privateAccess", "fileDurability",
    "nameDurability", "readback", "retainedStaging", "preservesUnknown",
  ])("denies missing or false capability %s before invocation", key => {
    for (const value of [undefined, false]) {
      const f = fixture();
      (f.port.capabilities as unknown as Record<string, unknown>)[key] = value;
      expect(() => publishPrivateFile(f.port, request(), "win32")).toThrow();
      expect(f.port.publish).not.toHaveBeenCalled();
      expect(f.files.size).toBe(0);
    }
  });

  it.each(["platform", "implementation", "auditReference", "capabilities"])(
    "denies invalid %s metadata before invocation", key => {
      const replacements = { platform: "posix", implementation: "posix", auditReference: " ", capabilities: null };
      for (const value of [undefined, replacements[key as keyof typeof replacements]]) {
        const f = fixture();
        (f.port as unknown as Record<string, unknown>)[key] = value;
        expect(() => publishPrivateFile(f.port, request(), "win32")).toThrow();
        expect(f.port.publish).not.toHaveBeenCalled();
      }
    },
  );

  it("denies known async methods, Promise-shaped ports and unsupported platforms without calling", () => {
    const f = fixture();
    let asyncCalls = 0;
    const asyncMethod = async () => { asyncCalls++; return { status: "NOT_PUBLISHED", code: "DENIED" }; };
    f.port.publish = asyncMethod as unknown as PrivateFilePort["publish"];
    expect(() => publishPrivateFile(f.port, request(), "win32")).toThrow("synchronous");
    expect(asyncCalls).toBe(0);
    const promisePort = Object.assign(Promise.resolve(f.port), { publish: vi.fn() });
    expect(() => publishPrivateFile(promisePort as unknown as PrivateFilePort, request(), "win32")).toThrow();
    expect(promisePort.publish).not.toHaveBeenCalled();
    expect(() => publishPrivateFile(f.port, request(), "plan9" as NodeJS.Platform)).toThrow();
    expect(asyncCalls).toBe(0);
    if (process.platform === "win32")
      expect(() => selectPrivateFilePlatform("linux")).toThrow();
    else {
      expect(selectPrivateFilePlatform("linux")).toBe("posix");
      expect(selectPrivateFilePlatform("win32")).toBe("win32");
      expect(() => publishPrivateFile(f.port, request(), "linux")).toThrow();
    }
  });

  it("treats an ordinary function returning a thenable as UNKNOWN, with no retry or deletion", () => {
    const f = fixture();
    const response = { then() {}, evidence: { operation: "already acted" } };
    f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
      f.files.set(stage, Buffer.from(input.bytes));
      f.files.set(target, Buffer.from(input.bytes));
      return response as unknown as PrivateFilePublishResult;
    });
    const error = failure(() => publishPrivateFile(f.port, request(), "win32"));
    expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(error).toMatchObject({ code: "PRIVATE_FILE_PUBLICATION_UNKNOWN", path: target, stagingPath: stage });
    expect((error as PrivateFilePublicationUnknownError).result).toBe(response);
    expect(f.files.get(stage)).toEqual(bytes);
    expect(f.files.get(target)).toEqual(bytes);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
  });

  it("denies missing publisher and invalid requests before any invocation", () => {
    const f = fixture();
    const invoke = f.port.publish;
    f.port.publish = undefined as unknown as PrivateFilePort["publish"];
    expect(() => publishPrivateFile(f.port, request(), "win32")).toThrow();
    f.port.publish = invoke;
    for (const input of [
      { ...request(), path: "relative" },
      { ...request(), stagingPath: target },
      { ...request(), stagingPath: "C:\\Other\\stage.tmp" },
      { ...request(), beforePublish: async () => {} },
    ])
      expect(() => publishPrivateFile(f.port, input, "win32")).toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(f.files.size).toBe(0);
  });

  it.each(["null", "status", "missing-callback", "path", "stage", "readback"])(
    "classifies malformed success %s as UNKNOWN", fault => {
      const f = fixture();
      let response: unknown;
      f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
        f.files.set(stage, Buffer.from(input.bytes));
        if (fault !== "missing-callback") input.beforePublish(Buffer.from(input.bytes));
        f.files.set(target, Buffer.from(input.bytes));
        response = fault === "null" ? null : {
          ...published(input),
          ...(fault === "status" ? { status: "OTHER" } : {}),
          ...(fault === "path" ? { path: `${target}.other` } : {}),
          ...(fault === "stage" ? { stagingPath: `${stage}.other` } : {}),
          ...(fault === "readback" ? { readback: Buffer.from("wrong") } : {}),
        };
        return response as PrivateFilePublishResult;
      });
      const error = failure(() => publishPrivateFile(f.port, request(), "win32"));
      expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
      expect((error as PrivateFilePublicationUnknownError).result).toBe(response);
      expect(f.files.size).toBe(2);
      expect(f.port.publish).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["repeat", "validation", "async-approval"])("rejects swallowed %s callback errors", fault => {
    const f = fixture();
    f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
      f.files.set(stage, Buffer.from(input.bytes));
      try {
        input.beforePublish(Buffer.from(input.bytes));
        if (fault === "repeat") input.beforePublish(Buffer.from(input.bytes));
      } catch {}
      f.files.set(target, Buffer.from(input.bytes));
      return published(input);
    });
    const approve = fault === "validation" ? () => { throw new Error("invalid"); } :
      fault === "async-approval" ? () => ({ then() {} }) : () => {};
    expect(failure(() => publishPrivateFile(f.port, request(approve), "win32")))
      .toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(f.files.size).toBe(2);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
  });

  it("closes approval after return and after throw", () => {
    for (const throws of [false, true]) {
      const f = fixture();
      let late: PrivateFilePublishRequest["beforePublish"] | undefined;
      f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
        late = input.beforePublish;
        input.beforePublish(input.bytes);
        if (throws) throw { native: "uncertain" };
        return published(input);
      });
      if (throws) expect(() => publishPrivateFile(f.port, request(), "win32")).toThrow();
      else publishPrivateFile(f.port, request(), "win32");
      expect(() => late!(bytes)).toThrow(PrivateFilePublicationUnknownError);
      expect(f.port.publish).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects a repeated callback hidden inside final readback access", () => {
    const f = fixture();
    f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
      input.beforePublish(input.bytes);
      return {
        status: "PUBLISHED", path: input.path, stagingPath: input.stagingPath,
        get readback() {
          try { input.beforePublish(input.bytes); } catch {}
          return Buffer.from(input.bytes);
        },
      };
    });
    expect(failure(() => publishPrivateFile(f.port, request(), "win32")))
      .toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
  });

  it("snapshots caller bytes and does not let adapter or approval copies forge readback", () => {
    const f = fixture();
    const input = request(readback => { readback.fill(0); });
    f.port.publish = vi.fn<PrivateFilePort["publish"]>(native => {
      input.bytes.fill(0); // Mutation of caller memory cannot alter expected bytes.
      native.beforePublish(Buffer.from(bytes));
      return { ...published(native), readback: Buffer.from(bytes) };
    });
    expect(publishPrivateFile(f.port, input, "win32").readback).toEqual(bytes);
    for (const mutate of ["callback", "final"]) {
      const g = fixture();
      g.port.publish = vi.fn<PrivateFilePort["publish"]>(native => {
        native.bytes.fill(0);
        if (mutate === "callback") {
          try { native.beforePublish(native.bytes); } catch {}
        } else native.beforePublish(Buffer.from(bytes));
        return published(native);
      });
      expect(failure(() => publishPrivateFile(g.port, request(), "win32")))
        .toBeInstanceOf(PrivateFilePublicationUnknownError);
      expect(g.port.publish).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves EEXIST response/evidence, original destination and retained stage", () => {
    const f = fixture();
    const original = Buffer.from("original");
    const evidence = { identity: "existing-native-object" };
    const response: PrivateFilePublishResult = { status: "NOT_PUBLISHED", code: "EEXIST", evidence };
    f.files.set(target, original);
    f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
      f.files.set(stage, Buffer.from(input.bytes));
      return response;
    });
    const error = failure(() => publishPrivateFile(f.port, request(), "win32"));
    expect(error).toBeInstanceOf(PrivateFileNotPublishedError);
    expect((error as PrivateFileNotPublishedError).code).toBe("EEXIST");
    expect((error as PrivateFileNotPublishedError).result).toBe(response);
    expect((error as PrivateFileNotPublishedError).result.evidence).toBe(evidence);
    expect(f.files.get(target)).toBe(original);
    expect(f.files.get(stage)).toEqual(bytes);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
  });

  it("retains explicit UNKNOWN response, evidence and artifacts by reference", () => {
    const f = fixture();
    const evidence = { nativeHandle: { retained: true } };
    const artifacts = [stage, target];
    const response: PrivateFilePublishResult = { status: "UNKNOWN", evidence, artifacts };
    f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
      f.files.set(stage, Buffer.from(input.bytes));
      f.files.set(target, Buffer.from(input.bytes));
      return response;
    });
    const error = failure(() => publishPrivateFile(f.port, request(), "win32")) as PrivateFilePublicationUnknownError;
    expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(error.result).toBe(response);
    expect((error.result as typeof response).evidence).toBe(evidence);
    expect((error.result as typeof response).artifacts).toBe(artifacts);
    expect(f.files.size).toBe(2);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
  });

  it("retains the original thrown native object as cause and never cleans or retries", () => {
    const f = fixture();
    const cause = { operation: "flush-name", nativeEvidence: new Uint8Array([1, 2]) };
    f.port.publish = vi.fn<PrivateFilePort["publish"]>(input => {
      f.files.set(stage, Buffer.from(input.bytes));
      f.files.set(target, Buffer.from(input.bytes));
      throw cause;
    });
    const error = failure(() => publishPrivateFile(f.port, request(), "win32")) as PrivateFilePublicationUnknownError;
    expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(error.cause).toBe(cause);
    expect(error.path).toBe(target);
    expect(error.stagingPath).toBe(stage);
    expect(f.files.size).toBe(2);
    expect(f.port.publish).toHaveBeenCalledTimes(1);
  });
});
