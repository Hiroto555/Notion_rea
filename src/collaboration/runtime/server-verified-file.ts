import { createHash } from "node:crypto";
import { requireCondition, SyncError } from "../../sync/protocol";
import {
  inspectVerifiedServerFile as posixInspectVerifiedServerFile,
  copyVerifiedServerFile as posixCopyVerifiedServerFile,
} from "../../sync/server-verified-file";
import {
  windowsServerNative,
  type WindowsServerNativePort,
} from "../../platform/windows/server-native";

type FileHash = { bytes: number; sha256: string };

const unsafe = () => new SyncError("server-file-unsafe", 409);
const mismatch = () => new SyncError("server-file-mismatch", 422);

function ceiling(maxBytes: number) {
  requireCondition(
    Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= 256 * 1024 * 1024,
    "server-file-unsafe",
    409,
  );
}

function expectedHash(value: FileHash) {
  requireCondition(
    value &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes >= 0 &&
      typeof value.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.sha256),
    "server-file-unsafe",
    409,
  );
}

function normalized(error: unknown): never {
  if ((error as NodeJS.ErrnoException)?.code === "ENOSPC")
    throw new SyncError("server-file-capacity", 507);
  if (
    error instanceof SyncError &&
    ["server-file-unsafe", "server-file-mismatch", "server-file-capacity"].includes(
      error.code,
    )
  )
    throw error;
  throw unsafe();
}

function nativeInspect(
  native: WindowsServerNativePort,
  path: string,
  expected: FileHash | undefined,
  maxBytes: number,
): FileHash {
  const absolute = native.canonical(path);
  const file = native.inspectFile(absolute, maxBytes);
  if (file.bytes > maxBytes) throw unsafe();
  const actual = { bytes: file.bytes, sha256: file.sha256 };
  if (
    expected &&
    (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
  )
    throw mismatch();
  return actual;
}

export function inspectVerifiedServerFile(
  path: string,
  expected?: FileHash,
  maxBytes = 20_000_000,
): FileHash {
  const native = windowsServerNative();
  if (native === undefined)
    return posixInspectVerifiedServerFile(path, expected, maxBytes);
  try {
    ceiling(maxBytes);
    if (expected) expectedHash(expected);
    return nativeInspect(native, path, expected, maxBytes);
  } catch (error) {
    return normalized(error);
  }
}

/** Exclusive new output only. An interrupted output is deliberately retained. */
export function copyVerifiedServerFile(
  sourcePath: string,
  destination: string,
  expected: FileHash,
  maxBytes = 20_000_000,
): FileHash {
  const native = windowsServerNative();
  if (native === undefined)
    return posixCopyVerifiedServerFile(sourcePath, destination, expected, maxBytes);
  try {
    ceiling(maxBytes);
    expectedHash(expected);
    const source = native.canonical(sourcePath);
    const dest = native.canonical(destination);
    requireCondition(
      !native.samePath(source, dest),
      "server-file-unsafe",
      409,
    );
    const inspected = nativeInspect(native, source, expected, maxBytes);
    const parent = native.inspectDirectory(native.parent(dest));
    if (native.kindOf(dest) !== "absent") throw unsafe();
    // K streams the copy helper-side (bounded, hashed): no wire read of a
    // giant file. The expected identity/hash pins the source.
    const receipt = native.copyNewFile(
      source,
      dest,
      {
        path: source,
        fileId: (native.inspectFileIdentity(source)).fileId,
        volumeId: (native.inspectFileIdentity(source)).volumeId,
        bytes: inspected.bytes,
        sha256: inspected.sha256,
      },
      maxBytes,
    );
    requireCondition(
      receipt.bytes === expected.bytes && receipt.sha256 === expected.sha256,
      "server-file-mismatch",
      422,
    );
    // Verify the new output by its own receipt identity, then readback-verify.
    const verified = nativeInspect(native, dest, expected, maxBytes);
    native.assertDirectory(native.parent(dest), parent);
    native.assertCurrent();
    return verified;
  } catch (error) {
    return normalized(error);
  }
}

/** Hash helper matching the POSIX import surface used by server inventory. */
export function verifiedFileSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
