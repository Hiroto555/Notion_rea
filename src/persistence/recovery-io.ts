import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  realpathSync, writeSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { requireCondition } from "../sync/protocol";

export type RecoveryFault = (stage: string) => void;
export function assertRecoveryDirectory(path: string): string {
  requireCondition(isAbsolute(path) && !path.includes("\0"), "invalid-recovery-directory");
  const canonical = resolve(path), stat = lstatSync(canonical);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(canonical) === canonical,
    "unsafe-recovery-directory");
  return canonical;
}
export function recoveryPath(root: string, relative: string): string {
  assertRecoveryDirectory(root);
  requireCondition(relative.length > 0 && !relative.includes("\\") && !relative.includes("\0") &&
    !isAbsolute(relative) && relative.split("/").every(p => p && p !== "." && p !== ".."), "unsafe-recovery-path");
  const path = join(root, relative);
  assertRecoveryDirectory(dirname(path));
  return path;
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs && b.isFile() && b.nlink === 1;
}
export function withRecoveryRead<T>(root: string, relative: string, max: number,
  use: (fd: number, stat: Stats) => T): T {
  const path = recoveryPath(root, relative), parent = lstatSync(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    requireCondition(before.isFile() && before.nlink === 1 && Number.isSafeInteger(before.size) &&
      before.size >= 0 && before.size <= max, "invalid-recovery-file");
    const value = use(fd, before);
    requireCondition(same(before, fstatSync(fd)) && same(before, lstatSync(path)), "recovery-file-changed");
    const afterParent = lstatSync(dirname(path));
    requireCondition(parent.dev === afterParent.dev && parent.ino === afterParent.ino, "recovery-directory-changed");
    assertRecoveryDirectory(dirname(path));
    return value;
  } finally {closeSync(fd);}
}
export function readRecoveryFile(root: string, relative: string, max: number): Buffer {
  return withRecoveryRead(root, relative, max, (fd, stat) => {
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireCondition(n > 0, "recovery-file-truncated"); offset += n; }
    return bytes;
  });
}
export function hashRecoveryFile(root: string, relative: string, max: number): {bytes: number; sha256: string} {
  return withRecoveryRead(root, relative, max, (fd, stat) => {
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
    while (offset < stat.size) {const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size-offset), offset);
      requireCondition(n > 0, "recovery-file-truncated");hash.update(buffer.subarray(0,n));offset += n;}
    return {bytes: offset, sha256: hash.digest("hex")};
  });
}
export function syncRecoveryDirectory(path: string): void {
  assertRecoveryDirectory(path); const fd = openSync(path, constants.O_RDONLY);
  try {fsyncSync(fd);} finally {closeSync(fd);}
}
export function createRecoveryDirectory(path: string): string {
  requireCondition(isAbsolute(path) && resolve(path) === path, "invalid-recovery-destination");
  assertRecoveryDirectory(dirname(path)); mkdirSync(path, {mode: 0o700});
  syncRecoveryDirectory(path); syncRecoveryDirectory(dirname(path)); return path;
}
/** Fresh file only. On uncertain failure retain all bytes; never clean up a path. */
export function writeRecoveryFile(root: string, relative: string, bytes: Buffer | string, fault?: RecoveryFault): void {
  const path = recoveryPath(root, relative), data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {let offset = 0; while (offset < data.length) {const n = writeSync(fd, data, offset, data.length-offset);
    requireCondition(n > 0, "recovery-write-incomplete"); offset += n;}
    fault?.("before-file-sync"); fsyncSync(fd); fault?.("after-file-sync");
  } finally {closeSync(fd);}
  requireCondition(readRecoveryFile(root, relative, data.length).equals(data), "recovery-write-mismatch");
  fault?.("before-directory-sync");syncRecoveryDirectory(dirname(path));fault?.("after-directory-sync");
}
