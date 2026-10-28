import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Test seam for fault injection. Production callers must use the native fs. */
export type JournalFileOperations = Pick<
  typeof fs,
  | "openSync"
  | "closeSync"
  | "writeFileSync"
  | "readSync"
  | "fsyncSync"
  | "fstatSync"
  | "lstatSync"
  | "realpathSync"
  | "linkSync"
>;

export type PendingJournalWriteOptions = {
  /** Must synchronously throw on invalid content. */
  validate: (content: string) => unknown;
  /** Must synchronously reject destinations forbidden to the caller. */
  checkDestination: (destination: string) => unknown;
  /** For isolated tests only; omitted in production. */
  operations?: Partial<JournalFileOperations>;
  /** For isolated collision tests only; omitted in production. */
  temporaryId?: () => string;
};

/** The staging name is deliberately retained. It is a second hard link to
 * the published inode on success; no failure path deletes an unknown file. */
export type PendingJournalFileResult = { path: string; stagingPath: string };

function ensureSynchronous(result: unknown, name: string): void {
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  )
    throw new Error(`${name} must be synchronous`);
}

function sameIdentity(
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Write a validated journal into a previously nonexistent external path.
 * Publication uses a same-directory hard link, which fails if *any* object
 * already exists at the destination. Staging and destination are never
 * automatically removed, even if a failure occurs after publication.
 *
 * The caller must exclude concurrent directory/file mutation. Node's path-
 * based APIs cannot atomically bind parent and staging inode to link(2), so
 * checks detect ordinary exchanges but cannot rule out an adversarial swap
 * between syscalls. fsync success is also not proof of power-loss durability
 * on every filesystem. An error after link means publication is uncertain;
 * callers must retain pending edits and inspect/reconcile, not retry blindly.
 */
export function writePendingJournalFile(
  destination: string,
  content: string,
  options: PendingJournalWriteOptions,
): PendingJournalFileResult {
  if (
    typeof destination !== "string" ||
    !isAbsolute(destination) ||
    destination.includes("\0") ||
    typeof content !== "string" ||
    !options ||
    typeof options.validate !== "function" ||
    typeof options.checkDestination !== "function"
  )
    throw new Error("Invalid pending journal arguments");
  const ops: JournalFileOperations = { ...fs, ...options.operations };
  const path = resolve(destination);
  const parent = dirname(path);
  const name = basename(path);
  if (!name || name === "." || name === "..")
    throw new Error("Invalid pending journal destination");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content)
    throw new Error("Journal is not reversible UTF-8");
  ensureSynchronous(options.validate(content), "validate");
  ensureSynchronous(options.checkDestination(path), "checkDestination");

  const directory = ops.lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || ops.realpathSync(parent) !== parent)
    throw new Error("Journal parent is not a stable canonical directory");
  try {
    ops.lstatSync(path);
    throw new Error("Journal destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = (options.temporaryId ?? randomUUID)();
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id))
    throw new Error("Invalid journal staging identifier");
  const stagingPath = join(parent, `.${name}.folio-journal-${id}.tmp`);
  let fileFd: number | undefined;
  let directoryFd: number | undefined;
  let failure: unknown;
  try {
    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0);
    fileFd = ops.openSync(stagingPath, flags, 0o600);
    const created = ops.fstatSync(fileFd);
    if (!created.isFile() || !sameIdentity(created, ops.lstatSync(stagingPath)))
      throw new Error("Journal staging identity changed");
    ops.writeFileSync(fileFd, bytes);
    ops.fsyncSync(fileFd);
    const saved = ops.fstatSync(fileFd);
    if (!saved.isFile() || saved.size !== bytes.length || !sameIdentity(created, saved))
      throw new Error("Journal staging size or identity changed");
    const readback = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < readback.length) {
      const count = ops.readSync(fileFd, readback, offset, readback.length - offset, offset);
      if (count <= 0) throw new Error("Journal readback is incomplete");
      offset += count;
    }
    if (!readback.equals(bytes)) throw new Error("Journal readback differs");
    ensureSynchronous(options.validate(readback.toString("utf8")), "validate");
    // A close error must not lead to publication. Do not assume the fd is
    // still open after close throws; its outcome is unknown.
    const finishedFd = fileFd;
    fileFd = undefined;
    ops.closeSync(finishedFd);

    directoryFd = ops.openSync(parent, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const stableDirectory = () => {
      const byFd = ops.fstatSync(directoryFd!);
      const byPath = ops.lstatSync(parent);
      if (!byFd.isDirectory() || !byPath.isDirectory() || byPath.isSymbolicLink() ||
          ops.realpathSync(parent) !== parent || !sameIdentity(directory, byFd) || !sameIdentity(byFd, byPath))
        throw new Error("Journal parent identity changed");
    };
    const stableStaging = () => {
      const current = ops.lstatSync(stagingPath);
      if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(created, current) || current.size !== bytes.length)
        throw new Error("Journal staging identity changed");
    };
    stableDirectory();
    stableStaging();
    // Persist staging creation before allowing publication.
    ops.fsyncSync(directoryFd);
    ensureSynchronous(options.checkDestination(path), "checkDestination");
    stableDirectory();
    stableStaging();
    // Reopen after the caller's final check and compare through the descriptor;
    // this detects same-inode content changes made between the two checks.
    fileFd = ops.openSync(stagingPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const verified = ops.fstatSync(fileFd);
    if (!verified.isFile() || !sameIdentity(created, verified) || verified.size !== bytes.length)
      throw new Error("Journal staging identity changed");
    const rechecked = Buffer.alloc(bytes.length);
    offset = 0;
    while (offset < rechecked.length) {
      const count = ops.readSync(fileFd, rechecked, offset, rechecked.length - offset, offset);
      if (count <= 0) throw new Error("Journal readback is incomplete");
      offset += count;
    }
    if (!rechecked.equals(bytes)) throw new Error("Journal staging content changed");
    const checkedFd = fileFd;
    fileFd = undefined;
    ops.closeSync(checkedFd);
    stableDirectory();
    stableStaging();
    // link(2) is atomic and never overwrites a pre-existing object.
    ops.linkSync(stagingPath, path);
    const published = ops.lstatSync(path);
    if (!published.isFile() || published.isSymbolicLink() || !sameIdentity(created, published))
      throw new Error("Journal published identity changed");
    stableStaging();
    stableDirectory();
    // Publication is not acknowledged if data changed while link was made.
    // Any existing destination is deliberately retained on this error.
    fileFd = ops.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const afterLink = ops.fstatSync(fileFd);
    if (!afterLink.isFile() || !sameIdentity(created, afterLink) || afterLink.size !== bytes.length)
      throw new Error("Journal published identity changed");
    const publishedBytes = Buffer.alloc(bytes.length);
    offset = 0;
    while (offset < publishedBytes.length) {
      const count = ops.readSync(fileFd, publishedBytes, offset, publishedBytes.length - offset, offset);
      if (count <= 0) throw new Error("Journal published readback is incomplete");
      offset += count;
    }
    if (!publishedBytes.equals(bytes)) throw new Error("Journal published content changed");
    const publishedFd = fileFd;
    fileFd = undefined;
    ops.closeSync(publishedFd);
    stableStaging();
    stableDirectory();
    ops.fsyncSync(directoryFd);
    return { path, stagingPath };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    for (const fd of [fileFd, directoryFd]) {
      if (fd === undefined) continue;
      try { ops.closeSync(fd); } catch (error) { errors.push(error); }
    }
    if (errors.length)
      throw new AggregateError(failure === undefined ? errors : [failure, ...errors],
        "Journal close failed; destination may already have been published");
  }
}
