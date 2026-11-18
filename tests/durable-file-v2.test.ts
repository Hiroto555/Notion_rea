import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { writeNewFileDurably } from "../src/persistence/durable-file";
import {
  PrivateFilePortUnsupportedError,
  PrivateFilePublicationUnknownError,
  type PrivateFilePort,
} from "../src/platform/private-file-port";
import type { PrivateFileV2Port } from "../src/platform/private-file-v2";
import type { PrivateFileV3Port } from "../src/platform/windows/private-recovery-io";

// Contract-only explicit-port coverage. Fake ports are untrusted stand-ins,
// never Windows OS/filesystem acceptance; v1 retained semantics are not faked.
const TARGET = "C:\\Folio\\private\\out.bin";
const DATA = new Uint8Array([1, 2, 3, 4, 5]);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function v2Port(overrides: Partial<{ publish: PrivateFileV2Port["publish"] }> = {}): PrivateFileV2Port {
  return {
    contractVersion: 2,
    platform: "win32",
    publish: overrides.publish ?? ((request) => {
      request.beforePublish(Uint8Array.from(request.bytes));
      return Object.freeze({
        contractVersion: 2 as const, state: "PUBLISHED" as const,
        path: request.path, stagingPath: request.stagingPath, attemptId: request.attemptId,
        identity: Object.freeze({ canonicalPath: request.path, fileId: "9".repeat(32), volumeId: "8".repeat(16) }),
        byteLength: request.bytes.byteLength, sha256: hash(request.bytes),
        readback: Uint8Array.from(request.bytes),
        stagingDisposition: "RENAMED_TO_FINAL" as const, contentFlushed: true as const,
        namespace: "EXCLUSIVE_NO_REPLACE" as const,
        durability: Object.freeze({ profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const, scope: "PROCESS_CRASH" as const }),
      });
    }),
  };
}

function v3Port(overrides: Partial<{ publish: PrivateFileV3Port["publish"] }> = {}): PrivateFileV3Port {
  return {
    contractVersion: 3,
    platform: "win32",
    publish: overrides.publish ?? ((request) => {
      request.beforePublish(Uint8Array.from(request.bytes));
      return Object.freeze({
        contractVersion: 3 as const, state: "PUBLISHED" as const,
        path: request.path, stagingPath: request.stagingPath, attemptId: request.attemptId,
        identity: Object.freeze({ canonicalPath: request.path, fileId: "9".repeat(32), volumeId: "8".repeat(16) }),
        byteLength: request.bytes.byteLength, sha256: hash(request.bytes),
        readback: Uint8Array.from(request.bytes),
        stagingDisposition: "RENAMED_TO_FINAL" as const, contentFlushed: true as const,
        namespace: "EXCLUSIVE_NO_REPLACE" as const,
        durability: Object.freeze({ profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const, scope: "PROCESS_CRASH" as const }),
      });
    }),
  };
}

const v1Port: PrivateFilePort = {
  platform: "win32",
  implementation: "audited-native",
  auditReference: "test-fixture",
  capabilities: {
    synchronous: true, exclusivePublication: true, privateAccess: true,
    fileDurability: true, nameDurability: true, readback: true,
    retainedStaging: true, preservesUnknown: true,
  },
  publish: (request) => {
    request.beforePublish(Uint8Array.from(request.bytes));
    return { status: "PUBLISHED", path: request.path, stagingPath: request.stagingPath, readback: request.bytes };
  },
};

describe("writeNewFileDurably explicit v2/v3 ports (contract-only)", () => {
  it("returns the v2 renamed-to-final receipt for caller inspection", () => {
    const receipt = writeNewFileDurably(TARGET, DATA, { platform: "win32", privateFileV2Port: v2Port() });
    expect(receipt).toBeDefined();
    if (!receipt || receipt.contractVersion !== 2) throw new Error("expected v2 receipt");
    expect(receipt.state).toBe("PUBLISHED");
    expect(receipt.stagingDisposition).toBe("RENAMED_TO_FINAL");
    expect(receipt.namespace).toBe("EXCLUSIVE_NO_REPLACE");
  });

  it("returns the v3 renamed-to-final receipt for caller inspection", () => {
    const receipt = writeNewFileDurably(TARGET, DATA, { platform: "win32", privateFileV3Port: v3Port() });
    expect(receipt).toBeDefined();
    if (!receipt || receipt.contractVersion !== 3) throw new Error("expected v3 receipt");
    expect(receipt.stagingDisposition).toBe("RENAMED_TO_FINAL");
    expect(receipt.durability.profile).toBe("WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1");
  });

  it("rejects more than one explicit port before invoking any", () => {
    let invoked = false;
    const port = v2Port({ publish: (r) => { invoked = true; return v2Port().publish(r); } });
    expect(() =>
      writeNewFileDurably(TARGET, DATA, { platform: "win32", privateFilePort: v1Port, privateFileV2Port: port }),
    ).toThrow(PrivateFilePortUnsupportedError);
    expect(() =>
      writeNewFileDurably(TARGET, DATA, { platform: "win32", privateFileV2Port: port, privateFileV3Port: v3Port() }),
    ).toThrow(PrivateFilePortUnsupportedError);
    expect(invoked).toBe(false);
  });

  it("surfaces a v2 callback failure as UNKNOWN and never unlinks anything", () => {
    const port = v2Port({
      publish: (request) => { request.beforePublish(new Uint8Array([9, 9])); throw new Error("stage"); },
    });
    expect(() =>
      writeNewFileDurably(TARGET, DATA, { platform: "win32", privateFileV2Port: port }),
    ).toThrow(PrivateFilePublicationUnknownError);
  });

  it("surfaces malformed v3 receipts as UNKNOWN, preserving artifacts", () => {
    const port = v3Port({
      publish: (request) => {
        request.beforePublish(Uint8Array.from(request.bytes));
        return Object.freeze({ contractVersion: 3, state: "PUBLISHED" }) as ReturnType<PrivateFileV3Port["publish"]>;
      },
    });
    expect(() =>
      writeNewFileDurably(TARGET, DATA, { platform: "win32", privateFileV3Port: port }),
    ).toThrow(PrivateFilePublicationUnknownError);
  });

  it("rejects explicit ports on a non-Windows selection", () => {
    expect(() =>
      writeNewFileDurably("/tmp/out.bin", DATA, { platform: "linux", privateFileV2Port: v2Port() }),
    ).toThrow(PrivateFilePortUnsupportedError);
  });

  it("keeps the retained v1 contract: win32 without an explicit port fails unsupported", () => {
    expect(() => writeNewFileDurably(TARGET, DATA, { platform: "win32" })).toThrow(
      PrivateFilePortUnsupportedError,
    );
  });

  it("keeps the v1 port path working and returns void for legacy callers", () => {
    const result = writeNewFileDurably(TARGET, DATA, { platform: "win32", privateFilePort: v1Port });
    expect(result).toBeUndefined();
  });
});
