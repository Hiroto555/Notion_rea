// Windows GUI fixture isolation: proves an existing folio-owned-shutdown-*
// runRoot is a private, native-owned directory through the independently
// pinned compiled probe before any FOLIO_DATA_DIR is routed beneath it.
// Synchronous and additive: importing this module never launches a helper,
// touches UI, or reads test state.
//
// NOT OS PROOF: the untrustedTest exec seam injects synthetic probe results.
// The native source now requires local NTFS, but only an independently pinned
// rebuilt installed EXE can supply that proof on Windows.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep, win32 } from "node:path";
import { types } from "node:util";

export const WINDOWS_GUI_TRUST_BOUNDARY =
  "Injected untrustedTest exec results are an untrusted contract check, not proof of Windows filesystem safety or local NTFS.";

const RUN_ROOT_PREFIX = "folio-owned-shutdown-";
const STATE_ROOT_PREFIX = "folio-windows-gui-state-";
const STATE_DIR_NAME = "state";
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BUFFER = 65_536;
const SHA256 = /^[a-f0-9]{64}$/;
const FILE_ID = /^[0-9A-Fa-f]{32}$/;
const VOLUME_ID = /^[0-9A-Fa-f]{16}$/;
const PROBE_KEYS = [
  "canonicalPath",
  "canonicalRoot",
  "daclPrivate",
  "fileId",
  "linkCount",
  "localFilesystem",
  "ownerSid",
  "platform",
  "reparsePoint",
  "rootFileId",
  "rootVolumeId",
  "sid",
  "volumeId",
];
const GENERATED_KEYS = [
  "FOLIO_WINDOWS_GUI_BATCH",
  "FOLIO_WINDOWS_GUI_DATA_ROOT",
  "FOLIO_WINDOWS_NATIVE_ROOT",
  "FOLIO_WINDOWS_PUBLICATION_STATE_ROOT",
  "FOLIO_WINDOWS_PUBLICATION_STATE_DIR",
  "FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES",
  "FOLIO_WINDOWS_GUI_ROOT_IDENTITY",
  "FOLIO_WINDOWS_GUI_STATE_IDENTITY",
];
// The inert check: a batch is claimed by the batch/data flags or either
// identity binding. Anything partially present is refused, never ignored.
const BATCH_CLAIM_KEYS = [
  "FOLIO_WINDOWS_GUI_BATCH",
  "FOLIO_WINDOWS_GUI_DATA_ROOT",
  "FOLIO_WINDOWS_GUI_ROOT_IDENTITY",
  "FOLIO_WINDOWS_GUI_STATE_IDENTITY",
];
const BLOCKED_ENV = [
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_ENVIRONMENT",
  "RUNNER_TEMP",
  "TF_BUILD",
  "BUILD_BUILDID",
  "AGENT_ID",
  "PWDEBUG",
  "PWTEST_WATCH",
  "FOLIO_DEV_URL",
  "FOLIO_LOCAL_GUI_BATCH",
  "FOLIO_LOCAL_GUI_DATA_ROOT",
  "FOLIO_LINUX_GUI_CI",
  "FOLIO_GUI_CI_DATA_ROOT",
];
const STRIPPED_KEYS = [
  "FOLIO_DATA_DIR",
  "FOLIO_CREDENTIAL_DIR",
  "FOLIO_DEV_URL",
  "FOLIO_EMPTY_WORKSPACE",
  "FOLIO_TEST_FORCE_READY_FAILURE",
  "PWDEBUG",
  "PWTEST_WATCH",
];
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  "CONIN$",
  "CONOUT$",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function refuse(message) {
  throw new Error(`Windows GUI batch refused: ${message}`);
}

function executablePin(path, expectedHash) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1
  )
    refuse("pinned helper is not a regular single-link file");
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (hash !== expectedHash) refuse("pinned probe hash mismatch");
  // Executable replacement detection only; these are NOT Windows root proof.
  return { dev: stat.dev, ino: stat.ino, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash };
}

function assertExecutablePin(pins) {
  const current = executablePin(pins.path, pins.sha256);
  if (Object.keys(current).some((key) => current[key] !== pins.identity[key]))
    refuse("pinned probe changed");
}

function validSid(value) {
  if (typeof value !== "string" || value.length > 184) return false;
  const parts = value.split("-");
  if (parts[0] !== "S" || parts[1] !== "1" || parts.length < 4 || parts.length > 18)
    return false;
  if (parts.slice(2).some((part) => !/^(0|[1-9][0-9]*)$/.test(part))) return false;
  if (BigInt(parts[2]) > 281474976710655n) return false;
  return parts.slice(3).every((part) => BigInt(part) <= 4294967295n);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function wellFormed(value) {
  try {
    encodeURIComponent(value);
  } catch {
    refuse("malformed unicode in path");
  }
}

function asciiFold(value) {
  let folded = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    folded +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : value[index];
  }
  return folded;
}

function windowsSegment(segment) {
  if (segment.length === 0) refuse("empty or repeated separator");
  if (segment === "." || segment === "..") refuse("dot segment");
  for (let index = 0; index < segment.length; index++) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) refuse("non-ASCII path segment");
  }
  if (segment.includes(":")) refuse("alternate data stream");
  if (/[<>:"|?*]/.test(segment)) refuse("illegal path character");
  if (/[ .]$/.test(segment)) refuse("trailing dot or space");
  if (/~\d/.test(segment)) refuse("short-name alias");
  const stem = segment.split(".")[0].toUpperCase();
  if (RESERVED_NAMES.has(stem)) refuse("reserved device name");
}

// Production canonical Windows path: drive letter, single backslash
// separators, no UNC/device prefix, no alias or reserved segment.
function canonicalWindowsPath(value) {
  if (typeof value !== "string" || value.length === 0)
    refuse("absolute path required");
  wellFormed(value);
  if (/^[\\/]{2}[?.][\\/]/.test(value) || /^[\\/]{2}/.test(value))
    refuse("UNC or device path");
  if (!/^[A-Za-z]:/.test(value)) refuse("drive-letter path required");
  if (value.length < 3 || (value[2] !== "\\" && value[2] !== "/"))
    refuse("rooted drive path required");
  const rest = value.slice(3);
  const segments = rest.length === 0 ? [] : rest.split(/[\\/]/);
  for (const segment of segments) windowsSegment(segment);
  return value[0].toUpperCase() + ":\\" + segments.join("\\");
}

// Host POSIX canonical absolute path. Allowed only inside an explicit
// untrustedTest seam on a non-Windows host - never a production proof.
function canonicalHostPosixPath(value) {
  if (typeof value !== "string" || value.length === 0)
    refuse("absolute path required");
  wellFormed(value);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) refuse("non-ASCII path");
  }
  if (value[0] !== "/") refuse("absolute path required");
  if (value.length > 1 && value.endsWith("/")) refuse("trailing separator");
  if (value.includes("\\") || value.includes("//"))
    refuse("repeated or wrong separator");
  for (const segment of value.split("/").slice(1))
    if (segment === "" || segment === "." || segment === "..")
      refuse("dot segment");
  return value;
}

function canonicalPath(value, posix) {
  return posix ? canonicalHostPosixPath(value) : canonicalWindowsPath(value);
}

function fold(value, posix) {
  return posix ? value : asciiFold(value);
}

function pathsEqual(left, right, posix) {
  return fold(left, posix) === fold(right, posix);
}

function strictDescendant(parent, child, posix) {
  const separator = posix ? "/" : "\\";
  const foldedParent = fold(parent, posix);
  const foldedChild = fold(child, posix);
  return (
    foldedChild.length > foldedParent.length &&
    foldedChild.startsWith(foldedParent + separator)
  );
}

// An explicitly claimed platform override needs an explicit exec seam. Real
// production never runs a helper anywhere but win32, even when the claimed
// platform says win32.
function seamContext(untrustedTest, platform) {
  if (untrustedTest !== undefined && untrustedTest !== null) {
    if (
      typeof untrustedTest !== "object" ||
      untrustedTest.platform !== "win32" ||
      typeof untrustedTest.exec !== "function"
    )
      refuse("untrustedTest must be {platform:'win32', exec(request)}");
    if (types.isAsyncFunction(untrustedTest.exec) || types.isGeneratorFunction(untrustedTest.exec))
      refuse("exec must be synchronous");
    let mapping = null;
    if (untrustedTest.windowsTempRoot !== undefined) {
      if (process.platform === "win32") refuse("Windows path mapping is POSIX-test-only");
      const windowsTempRoot = canonicalWindowsPath(untrustedTest.windowsTempRoot);
      if (windowsTempRoot !== untrustedTest.windowsTempRoot || windowsTempRoot.length <= 3)
        refuse("test mapping requires a canonical non-drive-root Windows path");
      mapping = { windowsTempRoot, hostTempRoot: realpathSync(tmpdir()) };
    }
    return { exec: untrustedTest.exec, posix: process.platform !== "win32" && !mapping, mapping };
  }
  if (platform !== "win32" || process.platform !== "win32")
    refuse("Windows GUI batches require a real win32 host");
  return { exec: null, posix: false, mapping: null };
}

// Maps only a fixed synthetic Windows temp prefix to actual disposable host
// directories. No injected fs implementation and no mapping in production.
function hostPath(path, ctx) {
  if (!ctx.mapping) return path;
  const canonical = canonicalWindowsPath(path);
  const base = ctx.mapping.windowsTempRoot;
  if (canonical !== path || (path !== base && !strictDescendant(base, path, false)))
    refuse("path outside the untrusted Windows temp mapping");
  return join(ctx.mapping.hostTempRoot, ...path.slice(base.length).split("\\").filter(Boolean));
}

function nativePath(path, ctx) {
  if (!ctx.mapping) return path;
  const rel = relative(ctx.mapping.hostTempRoot, path);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith(sep))
    refuse("host path outside the untrusted Windows temp mapping");
  return win32.join(ctx.mapping.windowsTempRoot, ...rel.split(sep).filter(Boolean));
}

function pathJoin(ctx, ...parts) {
  return ctx.posix ? join(...parts) : win32.join(...parts);
}

function pathDirname(ctx, path) {
  return ctx.posix ? dirname(path) : win32.dirname(path);
}

function existingDirectory(path, ctx) {
  if (canonicalPath(path, ctx.posix) !== path) refuse("directory path is not canonical");
  const physical = hostPath(path, ctx);
  const stat = lstatSync(physical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse("directory is not a real directory");
  const actual = nativePath(realpathSync(physical), ctx);
  if (actual !== path) refuse("directory alias or noncanonical path");
  return actual;
}

function blockedEnv(env) {
  const seen = new Set();
  for (const key of Object.keys(env)) {
    const folded = asciiFold(key);
    if (seen.has(folded)) refuse("ambiguous case-insensitive environment keys");
    seen.add(folded);
    if (folded.startsWith("folio_") && key !== key.toUpperCase())
      refuse("FOLIO environment keys must use canonical uppercase spelling");
    if (BLOCKED_ENV.some(blocked => asciiFold(blocked) === folded) &&
        ((folded.startsWith("folio_") && env[key] !== undefined) ||
          (typeof env[key] === "string" && env[key].length !== 0)))
      refuse(`conflicting environment ${key}`);
  }
}

// Independently supplied installation pins: absolute canonical .exe plus a
// lowercase sha256 of the exact bytes. This is an executable-replacement
// defense only; it never proves a data root.
function pinnedProbe(env, ctx) {
  const exe = env.FOLIO_WINDOWS_NATIVE_PROBE;
  const hash = env.FOLIO_WINDOWS_NATIVE_SHA256;
  if (typeof exe !== "string" || exe.length === 0)
    refuse("FOLIO_WINDOWS_NATIVE_PROBE is required");
  if (typeof hash !== "string" || !SHA256.test(hash))
    refuse("FOLIO_WINDOWS_NATIVE_SHA256 must be a lowercase sha256 hex");
  const canonical = canonicalPath(exe, ctx.posix);
  if (canonical !== exe) refuse("pinned probe path is not canonical");
  if (!/\.exe$/i.test(canonical)) refuse("pinned probe must be a .exe");
  const path = hostPath(exe, ctx);
  if (nativePath(realpathSync(path), ctx) !== exe) refuse("pinned probe alias");
  const identity = executablePin(path, hash);
  return Object.freeze({ exe: canonical, path, sha256: hash, identity });
}

function trustedSystemRoot(env) {
  const value = env.SystemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  if (canonicalWindowsPath(value) !== value)
    refuse("SystemRoot must be a canonical Windows path");
  return value;
}

// Current structural truth of a candidate fresh root: a real directory that
// is an immediate, correctly prefixed child of the REAL system temporary
// directory - never a uid/mode/ino check and never a privacy claim.
function freshTempChild(candidate, prefix, ctx) {
  if (typeof candidate !== "string" || candidate.length === 0)
    refuse("absolute fresh root required");
  if (canonicalPath(candidate, ctx.posix) !== candidate)
    refuse("fresh root must be canonical");
  const physical = hostPath(candidate, ctx);
  let stat;
  try {
    stat = lstatSync(physical);
  } catch {
    refuse("fresh root must already exist");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    refuse("fresh root must be a real directory, not a link");
  let actual;
  try {
    actual = realpathSync(physical);
  } catch {
    refuse("fresh root must resolve");
  }
  const base = realpathSync(tmpdir());
  const posixHost = process.platform !== "win32";
  if (
    fold(dirname(actual), posixHost) !== fold(base, posixHost) ||
    !basename(actual).startsWith(prefix) ||
    !/^[A-Za-z0-9]{6}$/.test(basename(actual).slice(prefix.length))
  )
    refuse(`fresh root must be an immediate ${prefix}* child of system temp`);
  const cwd = realpathSync(process.cwd());
  const foldedCwd = fold(cwd, posixHost);
  const foldedActual = fold(actual, posixHost);
  if (
    foldedActual === foldedCwd ||
    foldedActual.startsWith(foldedCwd + sep) ||
    foldedCwd.startsWith(foldedActual + sep)
  )
    refuse("fresh root must not overlap the repository working directory");
  if (nativePath(actual, ctx) !== candidate) refuse("fresh root alias");
  return nativePath(actual, ctx);
}

function saveImmutable(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function probeRequest(pins, systemRoot, target, root) {
  return Object.freeze({
    command: pins.exe,
    args: Object.freeze([target, root]),
    cwd: systemRoot,
    env: Object.freeze({
      SystemRoot: systemRoot,
      windir: systemRoot,
      TEMP: `${systemRoot}\\Temp`,
      TMP: `${systemRoot}\\Temp`,
    }),
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
    windowsHide: true,
    shell: false,
    stdio: Object.freeze(["ignore", "pipe", "pipe"]),
  });
}

function runExec(ctx, request) {
  if (ctx.exec) return ctx.exec(request);
  return spawnSync(request.command, [...request.args], {
    cwd: request.cwd,
    env: { ...request.env },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: request.timeout,
    maxBuffer: request.maxBuffer,
  });
}

// Exact raw bytes are preserved immutably BEFORE any error, exit, or JSON
// parsing - on success and on failure, with no retries and no deletes.
function captureProbeOutput(ctx, dir, request, result, execError) {
  const id = randomUUID();
  const stdoutPath = pathJoin(ctx, dir, `probe-${id}.stdout.bin`);
  const stderrPath = pathJoin(ctx, dir, `probe-${id}.stderr.bin`);
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  saveImmutable(hostPath(stdoutPath, ctx), stdout);
  saveImmutable(hostPath(stderrPath, ctx), stderr);
  const metadata = {
    request: {
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      env: { ...request.env },
      timeout: request.timeout,
      maxBuffer: request.maxBuffer,
      windowsHide: request.windowsHide,
      shell: request.shell,
      stdio: [...request.stdio],
    },
    result: {
      status: Number.isSafeInteger(result.status) ? result.status : null,
      signal: typeof result.signal === "string" ? result.signal : null,
      error: execError ? "EXEC_THROW" : result.invalid ?? (result.error ? "EXEC_ERROR" : null),
      errorCode: ownString(result.error, "code"),
      errorMessage: ownString(result.error, "message"),
      stdoutPath,
      stderrPath,
      stdoutSha256: sha256Bytes(stdout),
      stderrSha256: sha256Bytes(stderr),
    },
  };
  saveImmutable(hostPath(pathJoin(ctx, dir, `probe-${id}.json`), ctx),
    JSON.stringify(metadata, null, 2) + "\n");
}

function ownString(value, key) {
  if (!value || typeof value !== "object") return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value.slice(0, 4096) : null;
  } catch { return null; }
}

function snapshotResult(raw) {
  const snapshot = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    snapshot.invalid = "malformed exec result";
    return snapshot;
  }
  if (types.isPromise(raw)) {
    Promise.prototype.then.call(raw, undefined, () => undefined);
    snapshot.invalid = "async exec result";
    return snapshot;
  }
  try {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null)
      snapshot.invalid = "exotic exec result";
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    for (const key of ["status", "signal", "stdout", "stderr", "error", "then"]) {
      const descriptor = descriptors[key];
      if (descriptor && !("value" in descriptor)) {
        snapshot.invalid = "exec result accessor";
        continue;
      }
      if (descriptor) snapshot[key] = descriptor.value;
    }
    if (snapshot.then !== undefined) snapshot.invalid = "async or malformed exec result";
  } catch {
    snapshot.invalid = "unreadable exec result";
  }
  return snapshot;
}

// One spawn of the pinned compiled probe: argv exactly [path, root], minimal
// helper env, cwd SystemRoot, no inherited NODE_OPTIONS/PATH/FOLIO values.
function nativeProbe(ctx, pins, systemRoot, target, root, captureDir) {
  assertExecutablePin(pins);
  const request = probeRequest(pins, systemRoot, target, root);
  let result;
  let execError = null;
  try {
    result = runExec(ctx, request);
  } catch (error) {
    execError = error;
    result = undefined;
  }
  const captured = snapshotResult(result);
  captureProbeOutput(ctx, captureDir, request, captured, execError);
  assertExecutablePin(pins);
  if (execError !== null) refuse("probe exec threw");
  if (captured.invalid) refuse(captured.invalid);
  const { status, signal, stdout, stderr, error } = captured;
  if (error !== undefined && error !== null) refuse("probe exec error");
  if (signal !== null) refuse("probe missing signal or killed by signal");
  if (status !== 0) refuse("probe nonzero exit");
  if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr))
    refuse("probe output must be captured as Buffer");
  if (stdout.length > PROBE_MAX_BUFFER || stderr.length > PROBE_MAX_BUFFER)
    refuse("probe output overflow");
  if (stderr.length !== 0) refuse("probe wrote stderr");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    refuse("probe stdout is not valid UTF-8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("probe stdout is not JSON");
  }
  return assertProbeEvidence(parsed, target, root, ctx.posix);
}

// The exact 13-key default Probe contract emitted by Probe() in
// PrivateRootProbeProgram.cs (lines ~42-46): it must name the exact requested
// canonical paths, prove owner = current SID with strict SID syntax, private
// DACL, no reparse, single link, local filesystem, and matching 32-hex file
// ids / 16-hex volume ids on one volume.
function assertProbeEvidence(parsed, expectedPath, expectedRoot, posix) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    refuse("probe evidence is not an object");
  const proto = Object.getPrototypeOf(parsed);
  if (proto !== Object.prototype && proto !== null)
    refuse("probe evidence has an exotic prototype");
  if (Object.getOwnPropertySymbols(parsed).length !== 0)
    refuse("probe evidence has symbol keys");
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== PROBE_KEYS.length ||
    !PROBE_KEYS.every((key, index) => keys[index] === key)
  )
    refuse("probe evidence schema mismatch");
  for (const key of PROBE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(parsed, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      refuse("probe evidence accessor or hidden field");
  }
  if (parsed.platform !== "win32") refuse("probe platform mismatch");
  if (
    !validSid(parsed.sid) ||
    !validSid(parsed.ownerSid) ||
    parsed.sid !== parsed.ownerSid
  )
    refuse("probe SID/owner mismatch or malformed SID");
  if (
    parsed.daclPrivate !== true ||
    parsed.reparsePoint !== false ||
    parsed.linkCount !== 1 ||
    parsed.localFilesystem !== true
  )
    refuse("probe privacy evidence failed");
  if (
    typeof parsed.fileId !== "string" || !FILE_ID.test(parsed.fileId) ||
    typeof parsed.rootFileId !== "string" || !FILE_ID.test(parsed.rootFileId) ||
    typeof parsed.volumeId !== "string" || !VOLUME_ID.test(parsed.volumeId) ||
    typeof parsed.rootVolumeId !== "string" || !VOLUME_ID.test(parsed.rootVolumeId) ||
    parsed.volumeId !== parsed.rootVolumeId
  )
    refuse("probe identity or volume mismatch");
  const canonicalTarget = canonicalPath(parsed.canonicalPath, posix);
  const canonicalRoot = canonicalPath(parsed.canonicalRoot, posix);
  if (
    canonicalTarget !== parsed.canonicalPath ||
    canonicalRoot !== parsed.canonicalRoot
  )
    refuse("probe canonical paths are not canonical");
  if (
    canonicalTarget !== expectedPath ||
    canonicalRoot !== expectedRoot
  )
    refuse("probe evidence does not name the requested paths");
  if (
    !pathsEqual(canonicalTarget, canonicalRoot, posix) &&
    !strictDescendant(canonicalRoot, canonicalTarget, posix)
  )
    refuse("probe target escapes its root");
  if ((canonicalTarget === canonicalRoot) !== (parsed.fileId === parsed.rootFileId))
    refuse("probe target/root File IDs contradict the requested paths");
  return Object.freeze({
    canonicalPath: canonicalTarget,
    canonicalRoot,
    fileId: parsed.fileId,
    rootFileId: parsed.rootFileId,
    volumeId: parsed.volumeId,
    rootVolumeId: parsed.rootVolumeId,
    sid: parsed.sid,
  });
}

function probeSelf(ctx, pins, systemRoot, directory, captureDir) {
  const evidence = nativeProbe(
    ctx,
    pins,
    systemRoot,
    directory,
    directory,
    captureDir,
  );
  if (evidence.fileId !== evidence.rootFileId)
    refuse("root self proof must report fileId === rootFileId");
  return evidence;
}

// A fresh separate publication state root: another immediate prefixed child
// of the real temp dir with exactly one generated "state" child, never
// overlapping the batch root.
function verifiedState(env, ctx, pins, systemRoot, captureDir) {
  const stateRoot = canonicalPath(
    freshTempChild(env.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT, STATE_ROOT_PREFIX, ctx),
    ctx.posix,
  );
  const expectedDir = pathJoin(ctx, stateRoot, STATE_DIR_NAME);
  const stateDir = existingDirectory(env.FOLIO_WINDOWS_PUBLICATION_STATE_DIR, ctx);
  if (stateDir !== expectedDir)
    refuse("FOLIO_WINDOWS_PUBLICATION_STATE_DIR is not the generated state child");
  let binding;
  try {
    if (env.FOLIO_WINDOWS_GUI_STATE_IDENTITY.length > 8192) refuse("state binding too large");
    binding = JSON.parse(env.FOLIO_WINDOWS_GUI_STATE_IDENTITY);
  } catch {
    refuse("malformed state identity binding");
  }
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    Object.keys(binding).sort().join(",") !== "directory,root"
  )
    refuse("state identity binding schema mismatch");
  const rootBinding = parseIdentityBinding(binding.root, ctx.posix);
  const dirBinding = parseIdentityBinding(binding.directory, ctx.posix);
  if (rootBinding.canonicalPath !== stateRoot)
    refuse("state root binding path mismatch");
  if (dirBinding.canonicalPath !== stateDir)
    refuse("state directory binding path mismatch");
  const rootEvidence = probeSelf(ctx, pins, systemRoot, stateRoot, captureDir);
  if (
    rootEvidence.fileId !== rootBinding.fileId ||
    rootEvidence.volumeId !== rootBinding.volumeId ||
    rootEvidence.sid !== rootBinding.sid
  )
    refuse("state root identity changed");
  const dirEvidence = nativeProbe(
    ctx,
    pins,
    systemRoot,
    stateDir,
    stateRoot,
    captureDir,
  );
  if (
    dirEvidence.rootFileId !== rootEvidence.fileId ||
    dirEvidence.rootVolumeId !== rootEvidence.volumeId ||
    dirEvidence.sid !== rootEvidence.sid
  )
    refuse("state directory does not share the state root identity");
  if (
    dirEvidence.fileId !== dirBinding.fileId ||
    dirEvidence.volumeId !== dirBinding.volumeId ||
    dirEvidence.sid !== dirBinding.sid
  )
    refuse("state directory identity changed");
  const recheck = probeSelf(ctx, pins, systemRoot, stateRoot, captureDir);
  if (recheck.fileId !== rootEvidence.fileId || recheck.volumeId !== rootEvidence.volumeId ||
      recheck.sid !== rootEvidence.sid)
    refuse("state root identity changed during verification");
  return Object.freeze({ stateRoot, stateDir, rootEvidence, dirEvidence });
}

function parseIdentityBinding(value, posix) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    refuse("identity binding is not an object");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "canonicalPath,fileId,sid,volumeId")
    refuse("identity binding schema mismatch");
  const canonical = canonicalPath(value.canonicalPath, posix);
  if (
    canonical !== value.canonicalPath ||
    typeof value.fileId !== "string" ||
    !FILE_ID.test(value.fileId) ||
    typeof value.volumeId !== "string" ||
    !VOLUME_ID.test(value.volumeId) ||
    !validSid(value.sid)
  )
    refuse("identity binding values malformed");
  return Object.freeze({
    canonicalPath: canonical,
    fileId: value.fileId,
    volumeId: value.volumeId,
    sid: value.sid,
  });
}

function identityOf(evidence) {
  return {
    canonicalPath: evidence.canonicalPath,
    fileId: evidence.fileId,
    volumeId: evidence.volumeId,
    sid: evidence.sid,
  };
}

// Full batch verification shared by windowsGuiDataRoot and
// assertWindowsGuiChild. Returns the verified canonical root and the freshly
// captured native root identity.
function verifiedBatch(env, platform, untrustedTest) {
  if (!env || typeof env !== "object") refuse("environment object required");
  for (const key of GENERATED_KEYS)
    if (typeof env[key] !== "string" || env[key].length === 0)
      refuse(`${key} is missing or empty in a Windows GUI batch`);
  if (env.FOLIO_WINDOWS_GUI_BATCH !== "1" || env.FOLIO_GUI_TEST_OPT_IN !== "1")
    refuse("exact batch flag and GUI opt-in required");
  const ctx = seamContext(untrustedTest, platform);
  blockedEnv(env);
  if (env.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES !== "1")
    refuse("generated enrollment opt-in changed");
  const pins = pinnedProbe(env, ctx);
  const systemRoot = trustedSystemRoot(env);
  const runRoot = canonicalPath(
    freshTempChild(env.FOLIO_WINDOWS_GUI_DATA_ROOT, RUN_ROOT_PREFIX, ctx),
    ctx.posix,
  );
  // A changed product native scope can never point outside the fixture root.
  if (existingDirectory(env.FOLIO_WINDOWS_NATIVE_ROOT, ctx) !== runRoot)
    refuse("FOLIO_WINDOWS_NATIVE_ROOT is not the verified batch root");
  let rawBinding;
  try {
    if (env.FOLIO_WINDOWS_GUI_ROOT_IDENTITY.length > 4096) refuse("root binding too large");
    rawBinding = JSON.parse(env.FOLIO_WINDOWS_GUI_ROOT_IDENTITY);
  } catch {
    refuse("malformed root identity binding");
  }
  const rootBinding = parseIdentityBinding(rawBinding, ctx.posix);
  if (rootBinding.canonicalPath !== runRoot)
    refuse("root identity binding path mismatch");
  const captureDir = runRoot;
  const rootEvidence = probeSelf(ctx, pins, systemRoot, runRoot, captureDir);
  if (
    rootEvidence.fileId !== rootBinding.fileId ||
    rootEvidence.volumeId !== rootBinding.volumeId ||
    rootEvidence.sid !== rootBinding.sid ||
    !pathsEqual(rootEvidence.canonicalPath, rootBinding.canonicalPath, ctx.posix)
  )
    refuse("current root does not match the captured identity binding");
  const state = verifiedState(env, ctx, pins, systemRoot, captureDir);
  if (state.rootEvidence.sid !== rootEvidence.sid ||
      state.rootEvidence.volumeId !== rootEvidence.volumeId)
    refuse("state and batch have different native owners or volumes");
  if (
    pathsEqual(state.stateRoot, runRoot, ctx.posix) ||
    strictDescendant(runRoot, state.stateRoot, ctx.posix) ||
    strictDescendant(state.stateRoot, runRoot, ctx.posix)
  )
    refuse("publication state root overlaps the batch root");
  // Recheck the runRoot before returning: a replaced root changes the native
  // self identity and must be refused, never silently re-bound.
  const recheck = probeSelf(ctx, pins, systemRoot, runRoot, captureDir);
  if (
    recheck.fileId !== rootEvidence.fileId ||
    recheck.volumeId !== rootEvidence.volumeId ||
    recheck.sid !== rootEvidence.sid
  )
    refuse("batch root identity changed during verification");
  return Object.freeze({ runRoot, rootEvidence });
}

export function windowsGuiDataRoot(
  env = process.env,
  platform = process.platform,
  untrustedTest,
) {
  if (
    env &&
    typeof env === "object" &&
    !Object.keys(env).some(key => env[key] !== undefined &&
      BATCH_CLAIM_KEYS.some(claim => asciiFold(claim) === asciiFold(key)))
  )
    return undefined;
  if (platform !== "win32") refuse("Windows fixture platform must be win32");
  return verifiedBatch(env, platform, untrustedTest).runRoot;
}

// Proves `directory` is a canonical, existing strict descendant of the
// verified batch root, then re-proves the root before returning the canonical
// child. The credential sibling's parent must stay inside the root; an
// already-existing sibling must be a real directory inside it - it is never
// created here.
export function assertWindowsGuiChild(
  directory,
  base,
  env = process.env,
  untrustedTest,
) {
  const batch = verifiedBatch(env, process.platform, untrustedTest);
  const ctx = seamContext(untrustedTest, process.platform);
  if (base !== batch.runRoot)
    refuse("base is not exactly the verified batch root");
  if (typeof directory !== "string" || directory.length === 0)
    refuse("child directory required");
  const child = existingDirectory(directory, ctx);
  if (!strictDescendant(batch.runRoot, child, ctx.posix))
    refuse("child is not a strict descendant of the batch root");
  const pins = pinnedProbe(env, ctx);
  const systemRoot = trustedSystemRoot(env);
  const childEvidence = nativeProbe(
    ctx,
    pins,
    systemRoot,
    child,
    batch.runRoot,
    batch.runRoot,
  );
  if (
    childEvidence.rootFileId !== batch.rootEvidence.fileId ||
    childEvidence.rootVolumeId !== batch.rootEvidence.volumeId ||
    childEvidence.sid !== batch.rootEvidence.sid ||
    !pathsEqual(
      childEvidence.canonicalRoot,
      batch.rootEvidence.canonicalPath,
      ctx.posix,
    )
  )
    refuse("child probe does not match the captured root identity");
  const credential = `${child}-credentials`;
  let credentialStat = null;
  try {
    credentialStat = lstatSync(hostPath(credential, ctx));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (credentialStat !== null) {
    if (!credentialStat.isDirectory() || credentialStat.isSymbolicLink())
      refuse("credential sibling is not a real directory");
    const credentialReal = existingDirectory(credential, ctx);
    if (!strictDescendant(batch.runRoot, credentialReal, ctx.posix))
      refuse("credential sibling escapes the batch root");
    const credentialEvidence = nativeProbe(
      ctx,
      pins,
      systemRoot,
      credentialReal,
      batch.runRoot,
      batch.runRoot,
    );
    if (
      credentialEvidence.rootFileId !== batch.rootEvidence.fileId ||
      credentialEvidence.rootVolumeId !== batch.rootEvidence.volumeId ||
      credentialEvidence.sid !== batch.rootEvidence.sid
    )
      refuse("credential sibling does not match the captured root identity");
  }
  const recheck = probeSelf(
    ctx,
    pins,
    systemRoot,
    batch.runRoot,
    batch.runRoot,
  );
  if (
    recheck.fileId !== batch.rootEvidence.fileId ||
    recheck.volumeId !== batch.rootEvidence.volumeId ||
    recheck.sid !== batch.rootEvidence.sid
  )
    refuse("batch root identity changed during child verification");
  return child;
}

export function createWindowsGuiFixtureRoot(prefix, base, env, untrustedTest) {
  if (typeof prefix !== "string" || !/^[a-z0-9-]+-$/.test(prefix))
    refuse("invalid fixture prefix");
  const batch = verifiedBatch(env, process.platform, untrustedTest);
  if (base !== batch.runRoot) refuse("fixture base changed");
  const ctx = seamContext(untrustedTest, process.platform);
  const created = mkdtempSync(join(hostPath(base, ctx), prefix));
  return assertWindowsGuiChild(nativePath(created, ctx), base, env, untrustedTest);
}

// Routes an existing fresh folio-owned-shutdown runRoot/workspace into a
// frozen, string-only child env. All native privacy proofs run before any
// FOLIO_WINDOWS_* flag is emitted; failures preserve the created state root
// and every captured probe output. Returns Object.freeze(env).
export function prepareWindowsGuiBatch(options = {}, untrustedTest) {
  if (!options || typeof options !== "object")
    refuse("options object required");
  const runRoot = options.runRoot;
  const workspace = options.workspace;
  const env = options.env;
  if (!env || typeof env !== "object") refuse("environment object required");
  if (env.FOLIO_GUI_TEST_OPT_IN !== "1")
    refuse("exact GUI opt-in must already be set by the parent");
  const ctx = seamContext(untrustedTest, process.platform);
  blockedEnv(env);
  for (const key of GENERATED_KEYS)
    if (env[key] !== undefined)
      refuse(`${key} is generated by this prepare and cannot be inherited`);
  const pins = pinnedProbe(env, ctx);
  const systemRoot = trustedSystemRoot(env);
  const canonicalRoot = canonicalPath(
    freshTempChild(runRoot, RUN_ROOT_PREFIX, ctx),
    ctx.posix,
  );
  if (typeof workspace !== "string" || workspace !== pathJoin(ctx, runRoot, "workspace"))
    refuse("workspace must be exactly join(runRoot, 'workspace')");
  const canonicalWorkspace = existingDirectory(workspace, ctx);
  if (
    !pathsEqual(
      canonicalWorkspace,
      pathJoin(ctx, canonicalRoot, "workspace"),
      ctx.posix,
    )
  )
    refuse("workspace does not resolve inside the runRoot");

  // Explicit fresh-batch native proof BEFORE any enrollment flag is emitted:
  // root self, then workspace against the captured root identity.
  const rootEvidence = probeSelf(ctx, pins, systemRoot, canonicalRoot, canonicalRoot);
  const workspaceEvidence = nativeProbe(
    ctx,
    pins,
    systemRoot,
    canonicalWorkspace,
    canonicalRoot,
    canonicalRoot,
  );
  if (
    workspaceEvidence.rootFileId !== rootEvidence.fileId ||
    workspaceEvidence.rootVolumeId !== rootEvidence.volumeId ||
    workspaceEvidence.sid !== rootEvidence.sid
  )
    refuse("workspace does not share the runRoot identity");

  // Separate fresh publication state root; preserved on every later failure.
  const stateHostRoot = mkdtempSync(
    join(realpathSync(tmpdir()), STATE_ROOT_PREFIX),
  );
  const canonicalStateRoot = canonicalPath(nativePath(realpathSync(stateHostRoot), ctx), ctx.posix);
  const stateDir = pathJoin(ctx, canonicalStateRoot, STATE_DIR_NAME);
  // Record the allocation before further operations; failures never orphan
  // an undocumented private state root or delete its evidence.
  try {
    saveImmutable(hostPath(pathJoin(ctx, canonicalRoot, `windows-gui-state-${randomUUID()}.json`), ctx),
      JSON.stringify({ root: canonicalStateRoot, directory: stateDir }) + "\n");
  } catch (cause) {
    throw new Error(`Windows GUI batch refused: allocation record failed; state root retained at ${canonicalStateRoot}`,
      {cause});
  }
  mkdirSync(hostPath(stateDir, ctx));
  const canonicalStateDir = existingDirectory(stateDir, ctx);
  if (
    pathsEqual(canonicalStateRoot, canonicalRoot, ctx.posix) ||
    strictDescendant(canonicalRoot, canonicalStateRoot, ctx.posix) ||
    strictDescendant(canonicalStateRoot, canonicalRoot, ctx.posix)
  )
    refuse("publication state root overlaps the batch root");
  const stateRootEvidence = probeSelf(
    ctx,
    pins,
    systemRoot,
    canonicalStateRoot,
    canonicalRoot,
  );
  if (stateRootEvidence.sid !== rootEvidence.sid ||
      stateRootEvidence.volumeId !== rootEvidence.volumeId)
    refuse("state and batch have different native owners or volumes");
  const stateDirEvidence = nativeProbe(
    ctx,
    pins,
    systemRoot,
    canonicalStateDir,
    canonicalStateRoot,
    canonicalRoot,
  );
  if (
    stateDirEvidence.rootFileId !== stateRootEvidence.fileId ||
    stateDirEvidence.rootVolumeId !== stateRootEvidence.volumeId ||
    stateDirEvidence.sid !== stateRootEvidence.sid
  )
    refuse("state directory does not share the state root identity");

  // Recheck both roots before returning the env.
  const recheck = probeSelf(ctx, pins, systemRoot, canonicalRoot, canonicalRoot);
  if (
    recheck.fileId !== rootEvidence.fileId ||
    recheck.volumeId !== rootEvidence.volumeId ||
    recheck.sid !== rootEvidence.sid
  )
    refuse("batch root identity changed during prepare");
  const stateRecheck = probeSelf(
    ctx,
    pins,
    systemRoot,
    canonicalStateRoot,
    canonicalRoot,
  );
  if (
    stateRecheck.fileId !== stateRootEvidence.fileId ||
    stateRecheck.volumeId !== stateRootEvidence.volumeId ||
    stateRecheck.sid !== stateRootEvidence.sid
  )
    refuse("state root identity changed during prepare");

  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const folded = key.toUpperCase();
    if (folded.startsWith("FOLIO_SYNC_")) continue;
    if (STRIPPED_KEYS.includes(folded) || GENERATED_KEYS.includes(folded)) continue;
    child[key] = value;
  }
  child.FOLIO_WINDOWS_GUI_BATCH = "1";
  child.SystemRoot = systemRoot;
  child.FOLIO_WINDOWS_GUI_DATA_ROOT = canonicalRoot;
  child.FOLIO_WINDOWS_NATIVE_ROOT = canonicalRoot;
  child.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT = canonicalStateRoot;
  child.FOLIO_WINDOWS_PUBLICATION_STATE_DIR = canonicalStateDir;
  child.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES = "1";
  child.FOLIO_WINDOWS_GUI_ROOT_IDENTITY = JSON.stringify(
    identityOf(rootEvidence),
  );
  child.FOLIO_WINDOWS_GUI_STATE_IDENTITY = JSON.stringify({
    root: identityOf(stateRootEvidence),
    directory: identityOf(stateDirEvidence),
  });
  child.FOLIO_DATA_DIR = canonicalWorkspace;
  child.FOLIO_CREDENTIAL_DIR = `${canonicalWorkspace}-credentials`;
  // The credential sibling is never created here; its prospective parent must
  // stay inside the verified batch root.
  const credentialParent = canonicalPath(
    pathDirname(ctx, child.FOLIO_CREDENTIAL_DIR),
    ctx.posix,
  );
  if (
    !pathsEqual(credentialParent, canonicalRoot, ctx.posix) &&
    !strictDescendant(canonicalRoot, credentialParent, ctx.posix)
  )
    refuse("prospective credential parent escapes the batch root");
  assertWindowsGuiChild(canonicalWorkspace, canonicalRoot, child, untrustedTest);
  return Object.freeze(child);
}
