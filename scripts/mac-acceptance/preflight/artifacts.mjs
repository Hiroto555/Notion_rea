import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PATH_LENGTH = 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isStrictChild(parent, child) {
  const rel = relative(parent, child);
  return (
    !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)
  );
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH
  )
    throw new Error("Artifact path must be a bounded non-empty string");
  if (value.includes("\0") || value.includes("\\"))
    throw new Error("Artifact path contains a forbidden character");
  if (value.startsWith("/")) throw new Error("Artifact path must be relative");
  const parts = value.split("/");
  for (const part of parts)
    if (part === "" || part === "." || part === "..")
      throw new Error("Artifact path must be normalized without traversal");
  return parts.join("/");
}

function canonicalRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root))
    throw new Error("Artifact root must be an absolute path");
  const resolved = realpathSync(root);
  if (!statSync(resolved).isDirectory())
    throw new Error("Artifact root must be a directory");
  return resolved;
}

function snapshotDigest(files) {
  const digest = createHash("sha256");
  for (const file of files)
    digest.update(
      JSON.stringify([file.path, file.bytes, file.sha256]) + "\n",
      "utf8",
    );
  return digest.digest("hex");
}

function readArtifact(root, path, seenInodes, remainingBytes) {
  const full = join(root, path);
  const beforePath = lstatSync(full);
  if (!beforePath.isFile() || beforePath.isSymbolicLink())
    throw new Error("Artifact path must be a regular file without symlinks");
  const resolved = realpathSync(full);
  if (resolved !== full || !isStrictChild(root, resolved))
    throw new Error(
      "Artifact path escapes the canonical root or uses a symlink",
    );
  let fd;
  try {
    fd = openSync(
      full,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error("Artifact file could not be opened safely");
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1)
      throw new Error("Artifact must be a single-link regular file");
    if (before.size > MAX_FILE_BYTES)
      throw new Error("Artifact exceeds the per-file size limit");
    if (before.size > remainingBytes)
      throw new Error("Artifact total size limit exceeded");
    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const n = readSync(fd, buffer, used, buffer.length - used, null);
      if (n === 0) break;
      used += n;
    }
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      used !== before.size ||
      used !== after.size
    )
      throw new Error("Artifact identity changed while reading");
    const afterPath = lstatSync(full);
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterPath.dev !== after.dev ||
      afterPath.ino !== after.ino ||
      afterPath.nlink !== 1
    )
      throw new Error("Artifact identity changed while reading");
    const key = `${before.dev}:${before.ino}`;
    if (seenInodes.has(key))
      throw new Error("Artifact paths must resolve to unique files");
    seenInodes.add(key);
    return {
      bytes: used,
      sha256: createHash("sha256")
        .update(buffer.subarray(0, used))
        .digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

export function snapshotFiles({ root, paths } = {}) {
  if (!Array.isArray(paths)) throw new Error("Artifact paths must be an array");
  if (paths.length > MAX_FILES)
    throw new Error("Artifact count exceeds the limit");
  const canonical = canonicalRoot(root);
  const normalized = paths.map(normalizeRelativePath);
  if (new Set(normalized).size !== normalized.length)
    throw new Error("Artifact paths must be unique");
  normalized.sort(comparePaths);
  const seenInodes = new Set();
  const files = [];
  let total = 0;
  for (const path of normalized) {
    const record = readArtifact(
      canonical,
      path,
      seenInodes,
      MAX_TOTAL_BYTES - total,
    );
    total += record.bytes;
    if (total > MAX_TOTAL_BYTES)
      throw new Error("Artifact total size limit exceeded");
    files.push({ path, bytes: record.bytes, sha256: record.sha256 });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    files,
    sha256: snapshotDigest(files),
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new Error(`${label} has unexpected fields`);
}

function assertSnapshotShape(snapshot) {
  if (!isPlainObject(snapshot))
    throw new Error("Artifact snapshot must be an object");
  assertExactKeys(
    snapshot,
    ["schemaVersion", "files", "sha256"],
    "Artifact snapshot",
  );
  if (snapshot.schemaVersion !== SCHEMA_VERSION)
    throw new Error("Artifact snapshot schema version mismatch");
  if (!Array.isArray(snapshot.files))
    throw new Error("Artifact snapshot files must be an array");
  if (snapshot.files.length > MAX_FILES)
    throw new Error("Artifact count exceeds the limit");
  if (
    typeof snapshot.sha256 !== "string" ||
    !SHA256_PATTERN.test(snapshot.sha256)
  )
    throw new Error("Artifact snapshot digest is invalid");
  const seen = new Set();
  let previous = null;
  let total = 0;
  for (const file of snapshot.files) {
    if (!isPlainObject(file))
      throw new Error("Artifact file entry must be an object");
    assertExactKeys(file, ["path", "bytes", "sha256"], "Artifact file entry");
    const path = normalizeRelativePath(file.path);
    if (seen.has(path)) throw new Error("Artifact paths must be unique");
    seen.add(path);
    if (previous !== null && comparePaths(previous, path) >= 0)
      throw new Error("Artifact snapshot paths must be sorted");
    previous = path;
    if (
      !Number.isInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > MAX_FILE_BYTES
    )
      throw new Error("Artifact file size is invalid");
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256))
      throw new Error("Artifact file digest is invalid");
    total += file.bytes;
    if (total > MAX_TOTAL_BYTES)
      throw new Error("Artifact total size limit exceeded");
  }
  if (snapshotDigest(snapshot.files) !== snapshot.sha256)
    throw new Error("Artifact snapshot digest mismatch");
}

export function verifySnapshot({ root, snapshot } = {}) {
  assertSnapshotShape(snapshot);
  const fresh = snapshotFiles({
    root,
    paths: snapshot.files.map((file) => file.path),
  });
  if (
    fresh.sha256 !== snapshot.sha256 ||
    fresh.files.length !== snapshot.files.length
  )
    throw new Error("Artifact snapshot content mismatch");
  for (let index = 0; index < fresh.files.length; index++) {
    const actual = fresh.files[index];
    const expected = snapshot.files[index];
    if (
      actual.path !== expected.path ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    )
      throw new Error("Artifact snapshot content mismatch");
  }
  return snapshot;
}
