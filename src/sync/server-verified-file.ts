import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { syncPath } from "../persistence/durable-file";
import { assertPrivateRoot, pinPrivateRoot, type PrivateRootPin } from "./m3-private-root";
import { requireCondition, SyncError } from "./protocol";

type FileHash = {bytes: number; sha256: string};
type OpenFile = {fd: number; path: string; stat: Stats; root: PrivateRootPin};
const unsafe = () => new SyncError("server-file-unsafe", 409);
const mismatch = () => new SyncError("server-file-mismatch", 422);
function ceiling(maxBytes: number) {
  requireCondition(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= 256 * 1024 * 1024, "server-file-unsafe", 409);
}
function same(a: Stats, b: Stats) {
  return a.isFile() && b.isFile() && !b.isSymbolicLink() && a.nlink === 1 && b.nlink === 1 &&
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function expectedHash(value: FileHash) {
  requireCondition(value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256), "server-file-unsafe", 409);
}
function stable(file: OpenFile) {
  assertPrivateRoot(file.root);
  if (!same(file.stat, fstatSync(file.fd)) || !same(file.stat, lstatSync(file.path))) throw unsafe();
}
function openSource(path: string, maxBytes: number): OpenFile {
  const absolute = resolve(path), root = pinPrivateRoot(dirname(absolute));
  const listed = lstatSync(absolute);
  if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1 || listed.uid !== root.uid || listed.size > maxBytes) throw unsafe();
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const file = {fd, path: absolute, root, stat: listed};
  try {stable(file); return file;} catch (e) {closeSync(fd); throw e;}
}
function hashFile(file: OpenFile): FileHash {
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < file.stat.size) {
    const count = readSync(file.fd, buffer, 0, Math.min(buffer.length, file.stat.size - offset), offset);
    if (count <= 0) throw mismatch();
    digest.update(buffer.subarray(0, count)); offset += count;
  }
  stable(file);
  return {bytes: offset, sha256: digest.digest("hex")};
}
function normalized(error: unknown): never {
  if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") throw new SyncError("server-file-capacity", 507);
  if (error instanceof SyncError && ["server-file-unsafe", "server-file-mismatch", "server-file-capacity"].includes(error.code)) throw error;
  throw unsafe();
}
export function inspectVerifiedServerFile(path: string, expected?: FileHash, maxBytes = 20_000_000): FileHash {
  let source: OpenFile | undefined;
  try {
    ceiling(maxBytes); if (expected) expectedHash(expected);
    source = openSource(path, maxBytes);
    const actual = hashFile(source);
    if (expected && (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)) throw mismatch();
    return actual;
  } catch (e) { return normalized(e); }
  finally {if (source) closeSync(source.fd);}
}
/** Exclusive new output only. An interrupted output is deliberately retained. */
export function copyVerifiedServerFile(sourcePath: string, destination: string, expected: FileHash, maxBytes = 20_000_000): FileHash {
  let source: OpenFile | undefined, output: number | undefined;
  try {
    ceiling(maxBytes); expectedHash(expected);
    const path = resolve(destination);
    requireCondition(path !== resolve(sourcePath), "server-file-unsafe", 409);
    source = openSource(sourcePath, maxBytes);
    const sourceHash = hashFile(source);
    if (sourceHash.bytes !== expected.bytes || sourceHash.sha256 !== expected.sha256) throw mismatch();
    const root = pinPrivateRoot(dirname(path));
    output = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const pin = fstatSync(output);
    requireCondition(pin.isFile() && pin.nlink === 1 && pin.size === 0 &&
      (pin.dev !== source.stat.dev || pin.ino !== source.stat.ino), "server-file-unsafe", 409);
    const buffer = Buffer.allocUnsafe(64 * 1024), digest = createHash("sha256");
    let offset = 0;
    while (offset < expected.bytes) {
      const count = readSync(source.fd, buffer, 0, Math.min(buffer.length, expected.bytes - offset), offset);
      if (count <= 0) throw mismatch();
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const n = writeSync(output, buffer, written, count - written, offset + written);
        if (n <= 0) throw unsafe();
        written += n;
      }
      offset += count;
    }
    stable(source);
    if (digest.digest("hex") !== expected.sha256) throw mismatch();
    fsyncSync(output); assertPrivateRoot(root);
    const listed = lstatSync(path), current = fstatSync(output);
    requireCondition(current.dev === pin.dev && current.ino === pin.ino && same(current, listed) &&
      current.size === expected.bytes && current.uid === root.uid && (current.mode & 0o777) === 0o600, "server-file-unsafe", 409);
    syncPath(root.path);
    const verified = inspectVerifiedServerFile(path, expected, maxBytes);
    assertPrivateRoot(root); return verified;
  } catch (e) {return normalized(e);}
  finally {if (source) closeSync(source.fd); if (output !== undefined) closeSync(output);}
}
