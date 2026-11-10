import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createHash } from "node:crypto";
import { durableFs } from "../../persistence/durable-file";
import {
  assertPrivateRoot,
  pinPrivateRoot,
  type PrivateRootPin,
} from "../../sync/m3-private-root";
import { SharedAuthority } from "./authority";
import { CollaborationError, identifier, wellFormed } from "./contract";
import {
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
  type RuntimeStoreOptions,
} from "./store";

const VALUES = [
  "root",
  "org",
  "recovery-key-file",
  "device",
  "credentials-output",
] as const;
const MAX_SECRET_BYTES = 8192;

type Hooks = { beforeCommit?: () => void; afterCommit?: () => void };
export type RecoveryOperatorHandle = {
  state: "recovered";
  close(): Promise<void>;
};
function fail(code: string): never {
  throw new CollaborationError(code);
}
function absolute(raw: string): string {
  if (
    !raw ||
    raw.length > 4096 ||
    !isAbsolute(raw) ||
    raw.includes("\0") ||
    !wellFormed(raw)
  )
    fail("INVALID_ARGUMENT");
  return resolve(raw);
}
function argumentsMap(args: string[]): Map<string, string> {
  if (!Array.isArray(args) || args.length !== VALUES.length * 2)
    fail("INVALID_ARGUMENT");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (
      typeof flag !== "string" ||
      !flag.startsWith("--") ||
      !(VALUES as readonly string[]).includes(flag.slice(2)) ||
      values.has(flag.slice(2)) ||
      typeof value !== "string" ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0") ||
      !wellFormed(value)
    )
      fail("INVALID_ARGUMENT");
    values.set(flag.slice(2), value);
  }
  return values;
}
function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.nlink === 1 &&
    b.nlink === 1 &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function privateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    typeof process.getuid !== "function" ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600
  )
    fail("UNSAFE_PRIVATE_FILE");
}
function readPinned(
  path: string,
  maxBytes: number,
  limitRead = maxBytes,
): { bytes: Buffer; stat: Stats } {
  let fd: number | undefined;
  try {
    if (realpathSync(path) !== path) fail("UNSAFE_PRIVATE_FILE");
    const listed = lstatSync(path);
    privateFile(listed);
    if (listed.size <= 0 || listed.size > maxBytes)
      fail("INVALID_PRIVATE_FILE");
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(fd);
    privateFile(opened);
    if (!sameFile(listed, opened)) fail("UNSAFE_PRIVATE_FILE");
    const bytes = Buffer.alloc(Math.min(opened.size, limitRead));
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n <= 0) fail("INVALID_PRIVATE_FILE");
      offset += n;
    }
    if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(path)))
      fail("UNSAFE_PRIVATE_FILE");
    return { bytes, stat: opened };
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    return fail("INVALID_PRIVATE_FILE");
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}
function readPrivate(path: string, maxBytes: number): Buffer {
  return readPinned(path, maxBytes).bytes;
}
function keyFromFile(path: string): string {
  const bytes = readPrivate(path, MAX_SECRET_BYTES);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return fail("INVALID_RECOVERY_KEY_FILE");
  }
  let key: unknown = text;
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail("INVALID_RECOVERY_KEY_FILE");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail("INVALID_RECOVERY_KEY_FILE");
    const record = parsed as Record<string, unknown>,
      keys = Object.keys(record).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "recoveryKey" ||
      keys[1] !== "token" ||
      typeof record.token !== "string" ||
      !record.token ||
      record.token.length > 256 ||
      !wellFormed(record.token)
    )
      fail("INVALID_RECOVERY_KEY_FILE");
    key = record.recoveryKey;
  }
  if (typeof key !== "string" || !key || key.length > 256 || !wellFormed(key))
    fail("INVALID_RECOVERY_KEY_FILE");
  return key;
}
function existingRoot(raw: string): { pin: PrivateRootPin; database: Stats } {
  const path = absolute(raw);
  let pin: PrivateRootPin;
  try {
    pin = pinPrivateRoot(path);
  } catch {
    return fail("UNSAFE_ROOT");
  }
  const file = join(path, SHARED_RUNTIME_FILE);
  // Validate through the pinned descriptor before any SQLite constructor or sidecar open.
  let header: Buffer, database: Stats;
  try {
    ({ bytes: header, stat: database } = readPinned(
      file,
      Number.MAX_SAFE_INTEGER,
      100,
    ));
  } catch {
    return fail("NOT_SHARED_RUNTIME_FORMAT");
  }
  if (
    header.length < 100 ||
    header.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
    header.readUInt32BE(60) !== SHARED_RUNTIME_VERSION ||
    header.readUInt32BE(68) !== SHARED_RUNTIME_APPLICATION_ID
  )
    fail("NOT_SHARED_RUNTIME_FORMAT");
  return { pin, database };
}
function within(parent: string, path: string): boolean {
  const rest = relative(parent, path);
  return (
    !rest ||
    (rest !== ".." && !rest.startsWith(".." + sep) && !isAbsolute(rest))
  );
}
function target(
  raw: string,
  source: PrivateRootPin,
): { path: string; parent: PrivateRootPin } {
  const path = absolute(raw),
    parentPath = dirname(path);
  if (within(source.path, path)) fail("CREDENTIALS_INSIDE_ROOT");
  let parent: PrivateRootPin;
  try {
    parent = pinPrivateRoot(parentPath, [source.path]);
  } catch {
    return fail("UNSAFE_CREDENTIALS_PATH");
  }
  if (join(parent.path, basename(path)) !== path)
    fail("UNSAFE_CREDENTIALS_PATH");
  try {
    lstatSync(path);
    return fail("CREDENTIALS_EXIST");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path, parent };
}
function assertSource(source: { pin: PrivateRootPin; database: Stats }): void {
  assertPrivateRoot(source.pin);
  const current = lstatSync(join(source.pin.path, SHARED_RUNTIME_FILE));
  privateFile(current);
  if (
    current.dev !== source.database.dev ||
    current.ino !== source.database.ino
  )
    fail("UNSAFE_ROOT");
}
/** No unlink on failure: even an uncertain publication retains its private recovery material. */
function publish(
  path: string,
  parent: PrivateRootPin,
  raw: string,
  onCreated: () => void,
): Stats {
  let fd: number | undefined, dir: number | undefined;
  try {
    assertPrivateRoot(parent);
    dir = openSync(
      parent.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedParent = fstatSync(dir);
    if (
      openedParent.dev !== parent.dev ||
      openedParent.ino !== parent.ino ||
      !openedParent.isDirectory()
    )
      fail("UNSAFE_CREDENTIALS_PATH");
    fd = durableFs.openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    onCreated();
    const created = fstatSync(fd);
    privateFile(created);
    durableFs.writeFileSync(fd, raw);
    durableFs.fsyncSync(fd);
    const written = fstatSync(fd);
    privateFile(written);
    if (written.dev !== created.dev || written.ino !== created.ino)
      fail("UNSAFE_PRIVATE_FILE");
    const actual = readPrivate(path, MAX_SECRET_BYTES);
    if (
      createHash("sha256").update(actual).digest("hex") !==
        createHash("sha256").update(raw).digest("hex") ||
      !sameFile(written, lstatSync(path))
    )
      fail("CREDENTIALS_PROOF_FAILED");
    durableFs.fsyncSync(dir);
    assertPrivateRoot(parent);
    if (!sameFile(written, lstatSync(path))) fail("CREDENTIALS_PROOF_FAILED");
    return written;
  } finally {
    let closeFailed = false;
    if (fd !== undefined)
      try {
        durableFs.closeSync(fd);
      } catch {
        closeFailed = true;
      }
    if (dir !== undefined)
      try {
        closeSync(dir);
      } catch {
        closeFailed = true;
      }
    if (closeFailed) fail("CREDENTIALS_CLOSE_UNKNOWN");
  }
}

/** Local, headless recovery: publish the rotated secrets before the identity transaction commits. */
export async function runRecoveryOperator(
  args: string[],
  options: RuntimeStoreOptions = {},
  hooks: Hooks = {},
): Promise<RecoveryOperatorHandle> {
  if (process.platform === "win32")
    fail("WINDOWS_RECOVERY_OPERATOR_UNSUPPORTED");
  const values = argumentsMap(args);
  let org: string, device: string;
  try {
    org = identifier(values.get("org"));
    device = identifier(values.get("device"));
  } catch {
    return fail("INVALID_ARGUMENT");
  }
  const source = existingRoot(values.get("root")!);
  const output = target(values.get("credentials-output")!, source.pin);
  const recoveryKey = keyFromFile(absolute(values.get("recovery-key-file")!));
  assertSource(source);
  let authority: SharedAuthority;
  try {
    authority = new SharedAuthority(source.pin.path, options);
  } catch {
    return fail("RECOVERY_OPEN_FAILED");
  }
  let created = false,
    committed = false;
  try {
    let credentials: { token: string; recoveryKey: string } | undefined;
    authority.store.transaction(() => {
      assertSource(source);
      assertPrivateRoot(output.parent);
      const issued = authority.recover(org, recoveryKey, device);
      credentials = { token: issued.token, recoveryKey: issued.recoveryKey };
      const outputPin = publish(
        output.path,
        output.parent,
        JSON.stringify(credentials),
        () => {
          created = true;
        },
      );
      hooks.beforeCommit?.();
      assertSource(source);
      assertPrivateRoot(output.parent);
      const finalOutput = readPinned(output.path, MAX_SECRET_BYTES);
      if (
        !sameFile(outputPin, finalOutput.stat) ||
        finalOutput.bytes.toString("utf8") !== JSON.stringify(credentials)
      )
        fail("CREDENTIALS_PROOF_FAILED");
    });
    committed = true;
    hooks.afterCommit?.();
    const published = JSON.parse(
      readPrivate(output.path, MAX_SECRET_BYTES).toString("utf8"),
    ) as { token: string; recoveryKey: string };
    if (
      !credentials ||
      published.token !== credentials.token ||
      published.recoveryKey !== credentials.recoveryKey
    )
      fail("CREDENTIALS_PROOF_FAILED");
    authority.recoveryStatus(published.token, org);
    authority.verify();
  } catch (error) {
    try {
      authority.close();
    } catch {}
    if (
      created ||
      committed ||
      (error instanceof Error && /UNKNOWN/.test(error.message))
    )
      return fail("RECOVERY_UNKNOWN");
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return fail("CREDENTIALS_EXIST");
    if (error instanceof CollaborationError) throw error;
    return fail("RECOVERY_FAILED");
  }
  let closed = false;
  return {
    state: "recovered",
    async close() {
      if (closed) return;
      closed = true;
      authority.close();
    },
  };
}
