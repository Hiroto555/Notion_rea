// Shared owned-shutdown session core and GUI batch wrapper.
//
// startOwnedShutdownSession(request, options?) validates a frozen parent-issued
// request, allocates a fresh private session root inside the approved runRoot,
// writes the fixed monitor source + immutable intent/attempt BEFORE spawn, and
// launches exactly one fixed no-argument child:
//
//   POSIX   : nodeExe [fixedTempScript]                 (stdio piped, no args)
//   Windows : helperExe [nodeExe, script, root, nonce, timeoutMs,
//                        --shutdown-monitor-stdin-v1]   (job-owned helper route)
//
// The parent only ever writes to the child's stdin; accepted-quit is a second
// newline JSON message and stdin is never ended by the parent — EOF must
// follow the owner process exit. The child and its stdio are unref'd so the
// monitor cannot keep Electron alive. Termination authority is limited to the
// just-spawned ChildProcess handle after the bounded deadline; there is no PID
// adoption, arbitrary argv, auto retry, or deletion of evidence.
//
// prepareGuiOwnedShutdown({env,...}) builds the disposable GUI batch
// environment (private runRoot + FOLIO_DATA_DIR + FOLIO_OWNED_SHUTDOWN_REQUEST
// JSON) and returns finish(), which waits for all session receipts under the
// runRoot with a bounded deadline. Missing/malformed receipts are UNKNOWN,
// never success, and are never conflated with Electron acceptance.
//
// Windows note: this module cannot import the TypeScript owned-executor, so
// the specialized fixed helper spawn (same five-field argv plus the exact
// --shutdown-monitor-stdin-v1 marker) is implemented here. The TS
// WindowsOwnedExecutor.startShutdownMonitor is the thin typed equivalent kept
// consistent with this route. Windows simulation is never OS proof.
//
// JS test seams are explicitly named untrustedTest. Importing this module has
// no side effects and no GUI entry point.
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { OWNED_SHUTDOWN_MONITOR_SOURCE } from "./owned-shutdown-monitor.mjs";
import { prepareWindowsGuiBatch } from "./windows-gui-batch-policy.mjs";

export const OWNED_SHUTDOWN_REQUEST_ENV = "FOLIO_OWNED_SHUTDOWN_REQUEST";
export const OWNED_SHUTDOWN_OPT_IN_ENV = "FOLIO_GUI_TEST_OPT_IN";
export const WINDOWS_OWNED_HELPER_ENV = "FOLIO_WINDOWS_OWNED_HELPER";
export const WINDOWS_OWNED_HELPER_SHA256_ENV =
  "FOLIO_WINDOWS_OWNED_HELPER_SHA256";
export const WINDOWS_MONITOR_MARKER = "--shutdown-monitor-stdin-v1";
export const RECEIPT_SCOPE = "PIPE_CLOSED_AFTER_ACCEPTED_QUIT";

export const MONITOR_TIMEOUT_MIN_MS = 1;
export const MONITOR_TIMEOUT_MAX_MS = 300_000;
const MAX_STREAM_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const OBSERVATION_GRACE_MS = 5_000;
const RECEIPT_POLL_MS = 2_000;
const RECEIPT_POLL_STEP_MS = 25;
const DEFAULT_MONITOR_TIMEOUT_MS = 240_000;
const DEFAULT_REQUEST_TTL_MS = 600_000;
const MAX_REQUEST_TTL_MS = 3_600_000;
const DEFAULT_FINISH_WAIT_MS = 30_000;

const SCRIPT_NAME = "monitor.mjs";
const INTENT_NAME = "intent.json";
const ATTEMPT_NAME = "attempt.json";
const RECEIPT_NAME = "receipt.json";
const RAW_NAME = "stdin-raw.bin";
const HELPER_RESULT_NAME = "helper-result.json";
const MAX_EVIDENCE_BYTES = 256 * 1024;
// Local GUI fixtures must use the explicitly authorized private batch root.
const LOCAL_BATCH_ENV = "FOLIO_LOCAL_GUI_BATCH";
const LOCAL_DATA_ROOT_ENV = "FOLIO_LOCAL_GUI_DATA_ROOT";
const LOCAL_BATCH_FORBIDDEN = [
  "FOLIO_LINUX_GUI_CI",
  "FOLIO_GUI_CI_DATA_ROOT",
  "PWDEBUG",
  "PWTEST_WATCH",
  "FOLIO_DEV_URL",
];
const LABEL = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const SESSION_PREFIX = "session-";
const MONITOR_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "windir",
  "PATHEXT",
  "ComSpec",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
];
const FORBIDDEN_ENV_KEY =
  /FOLIO|NODE_OPTIONS|ELECTRON|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY/i;
const RECEIPT_STATUSES = new Set(["COMPLETED", "UNKNOWN", "TIMED_OUT"]);
const MONITOR_SOURCE_SHA256 = sha256(OWNED_SHUTDOWN_MONITOR_SOURCE);
const INTENT_KEYS = [
  "approvedTempParent",
  "nonce",
  "runId",
  "runRoot",
  "scriptHash",
  "sessionId",
  "tempRoot",
  "timeoutMs",
  "type",
  "v",
];

function reject(code, reason) {
  const error = new Error(reason ? `${code}: ${reason}` : code);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function strictChild(parent, child) {
  const rel = relative(parent, child);
  return (
    !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)
  );
}

function isLabel(value) {
  return typeof value === "string" && LABEL.test(value);
}

function exactKeys(value, keys, code) {
  if (!value || Array.isArray(value) || typeof value !== "object")
    reject(code, "expected a plain object");
  const found = Object.keys(value).sort();
  const expected = keys.slice().sort();
  if (
    found.length !== expected.length ||
    !expected.every((key, index) => found[index] === key)
  )
    reject(code, `unexpected keys: ${found.join(",")}`);
}

function saveImmutable(path, data, mode = 0o600) {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Reads an existing pinned file only through real fs metadata plus the
// injected byte source. Existing files must be regular and single-linked;
// symlinks and hardlinks are refused.
function pinnedFile(path, expectedSha256, label, readFile) {
  if (typeof path !== "string" || !isAbsolute(path))
    reject(`${label}_PATH`, "absolute pinned path required");
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    reject(`${label}_MISSING`, path);
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    reject(`${label}_NOT_REGULAR`, path);
  if (typeof stat.nlink === "number" && stat.nlink !== 1)
    reject(`${label}_LINKED`, path);
  if (sha256(readFile(path)) !== expectedSha256)
    reject(`${label}_HASH_MISMATCH`, path);
  return path;
}

function assertPrivateRunRoot(runRoot, tmpBase) {
  if (typeof runRoot !== "string" || !isAbsolute(runRoot))
    reject("RUN_ROOT", "absolute runRoot required");
  const base = realpathSync(tmpBase);
  let actual;
  try {
    actual = realpathSync(runRoot);
  } catch {
    reject("RUN_ROOT", "runRoot must already exist");
  }
  if (!strictChild(base, actual)) reject("RUN_ROOT", "runRoot escapes tmpdir");
  const stat = lstatSync(actual);
  if (!stat.isDirectory()) reject("RUN_ROOT", "runRoot is not a directory");
  if (
    process.platform !== "win32" &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  )
    reject("RUN_ROOT", "runRoot is not private");
  return actual;
}

// request: {v:1, runId, runRoot, nodeExe, nodeSha256, timeoutMs, expiresAt,
//           windows?:{helperPath, helperSha256}} — strict, frozen on return.
function parseRequest(request, ports) {
  exactKeys(
    request,
    [
      "v",
      "runId",
      "runRoot",
      "nodeExe",
      "nodeSha256",
      "timeoutMs",
      "expiresAt",
      ...(request &&
      typeof request === "object" &&
      "windows" in request
        ? ["windows"]
        : []),
    ],
    "REQUEST_SCHEMA",
  );
  if (request.v !== 1) reject("REQUEST_SCHEMA", "v must be 1");
  if (!isLabel(request.runId)) reject("REQUEST_RUN_ID");
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < MONITOR_TIMEOUT_MIN_MS ||
    request.timeoutMs > MONITOR_TIMEOUT_MAX_MS
  )
    reject("REQUEST_TIMEOUT", "timeoutMs must be within 1..300000");
  const expiresAt = Date.parse(request.expiresAt);
  if (typeof request.expiresAt !== "string" || !Number.isFinite(expiresAt))
    reject("REQUEST_EXPIRY", "expiresAt must be an ISO-8601 timestamp");
  if (expiresAt <= ports.now())
    reject("REQUEST_EXPIRED", "request authorization window has passed");
  const runRoot = assertPrivateRunRoot(request.runRoot, ports.tmpBase);
  if (typeof request.nodeSha256 !== "string" || !HASH.test(request.nodeSha256))
    reject("REQUEST_HASH", "nodeSha256 must be a lowercase sha256 hex");
  if (ports.platform === "win32" && !/\.exe$/i.test(request.nodeExe))
    reject("NODE_EXE", "Windows route requires a .exe Node binary");
  const nodeExe = pinnedFile(
    request.nodeExe,
    request.nodeSha256,
    "NODE",
    ports.readFile,
  );
  let windows = null;
  if (request.windows !== undefined) {
    exactKeys(request.windows, ["helperPath", "helperSha256"], "REQUEST_WINDOWS");
    if (
      typeof request.windows.helperSha256 !== "string" ||
      !HASH.test(request.windows.helperSha256)
    )
      reject("REQUEST_HASH", "helperSha256 must be a lowercase sha256 hex");
    if (
      ports.platform === "win32" &&
      !/\.exe$/i.test(request.windows.helperPath)
    )
      reject("HELPER_EXE", "Windows route requires a .exe helper binary");
    const helperPath = pinnedFile(
      request.windows.helperPath,
      request.windows.helperSha256,
      "HELPER",
      ports.readFile,
    );
    windows = Object.freeze({
      helperPath,
      helperSha256: request.windows.helperSha256,
    });
  }
  if (ports.platform === "win32" && windows === null)
    reject(
      "WINDOWS_HELPER_CONFIG",
      "Windows owned shutdown requires the pinned helper configuration",
    );
  return Object.freeze({
    v: 1,
    runId: request.runId,
    runRoot,
    nodeExe,
    nodeSha256: request.nodeSha256,
    timeoutMs: request.timeoutMs,
    expiresAt: request.expiresAt,
    ...(windows ? { windows } : {}),
  });
}

// Minimal environment for the monitor child: an allowlist of ambient values
// with every secret/debug/Folio key stripped, TEMP/TMP/TMPDIR pinned to the
// private session root. NODE_OPTIONS and Electron-as-Node are never forwarded.
function monitorEnv(sessionRoot, sourceEnv) {
  const env = {};
  for (const key of MONITOR_ENV_KEYS) {
    if (FORBIDDEN_ENV_KEY.test(key)) continue;
    const value = sourceEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.TEMP = sessionRoot;
  env.TMP = sessionRoot;
  env.TMPDIR = sessionRoot;
  return env;
}

// Bounded evidence read: lstat first (regular file, no symlink, size cap
// before the read allocation), then a size re-check on the bytes returned.
// Returns {ok:true,data} or {ok:false,code} — callers map both missing and
// malformed evidence to UNKNOWN except the explicitly polled "MISSING".
function readBounded(path, ports, { max = MAX_EVIDENCE_BYTES } = {}) {
  let stat;
  try {
    stat = ports.lstat(path);
  } catch {
    return { ok: false, code: "MISSING", data: null };
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    return { ok: false, code: "NOT_REGULAR", data: null };
  if (typeof stat.size === "number" && stat.size > max)
    return { ok: false, code: "OVERSIZED", data: null };
  let data;
  try {
    data = ports.readFile(path);
  } catch {
    return { ok: false, code: "MISSING", data: null };
  }
  if (data.length > max) return { ok: false, code: "OVERSIZED", data: null };
  return { ok: true, code: null, data };
}

function parseJson(data) {
  try {
    const value = JSON.parse(data.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function sameKeys(value, keys) {
  const found = Object.keys(value).sort();
  const want = keys.slice().sort();
  return (
    found.length === want.length &&
    want.every((key, index) => found[index] === key)
  );
}

// The single strict evidence reader shared by session observation() and the
// GUI batch finish(). It binds on-disk intent/attempt/source/receipt/raw (and
// the Windows helper-result) to the current runRoot + request runId and, when
// supplied, to the exact session binding. Tampered or foreign evidence is
// UNKNOWN — never deleted, never rewritten, never success.
// ctx: {runRoot, runId, platform, ports, expected?{sessionId,nonce,timeoutMs}}
function readSessionEvidence(sessionRoot, ctx) {
  const { ports } = ctx;
  const unknown = (code) => ({ status: "UNKNOWN", code, receipt: null });
  let canonical;
  try {
    canonical = realpathSync(sessionRoot);
  } catch {
    return unknown("SESSION_ROOT");
  }
  let runRootCanonical;
  try {
    runRootCanonical = realpathSync(ctx.runRoot);
  } catch {
    return unknown("RUN_ROOT");
  }
  if (!strictChild(runRootCanonical, canonical)) return unknown("SESSION_ROOT");

  const intentFile = readBounded(join(canonical, INTENT_NAME), ports);
  if (!intentFile.ok) return unknown(`INTENT_${intentFile.code}`);
  const intent = parseJson(intentFile.data);
  let intentTempReal = null;
  let intentRunReal = null;
  let intentParentReal = null;
  try {
    if (intent && isAbsolute(intent.tempRoot))
      intentTempReal = realpathSync(intent.tempRoot);
    if (intent && isAbsolute(intent.runRoot))
      intentRunReal = realpathSync(intent.runRoot);
    if (intent && isAbsolute(intent.approvedTempParent))
      intentParentReal = realpathSync(intent.approvedTempParent);
  } catch {
    return unknown("INTENT_MISMATCH");
  }
  if (
    !intent ||
    !sameKeys(intent, INTENT_KEYS) ||
    intent.v !== 1 ||
    intent.type !== "init" ||
    intent.runId !== ctx.runId ||
    !isLabel(intent.sessionId) ||
    !isLabel(intent.nonce) ||
    typeof intent.tempRoot !== "string" ||
    typeof intent.runRoot !== "string" ||
    typeof intent.approvedTempParent !== "string" ||
    intentTempReal !== canonical ||
    intentRunReal !== runRootCanonical ||
    !strictChild(intentParentReal ?? "", intentRunReal ?? "") ||
    !HASH.test(intent.scriptHash) ||
    intent.scriptHash !== MONITOR_SOURCE_SHA256 ||
    !Number.isSafeInteger(intent.timeoutMs) ||
    intent.timeoutMs < MONITOR_TIMEOUT_MIN_MS ||
    intent.timeoutMs > MONITOR_TIMEOUT_MAX_MS
  )
    return unknown("INTENT_MISMATCH");
  if (
    ctx.expected &&
    (intent.sessionId !== ctx.expected.sessionId ||
      intent.nonce !== ctx.expected.nonce ||
      intent.timeoutMs !== ctx.expected.timeoutMs)
  )
    return unknown("INTENT_MISMATCH");
  const binding = {
    runId: intent.runId,
    sessionId: intent.sessionId,
    nonce: intent.nonce,
    timeoutMs: intent.timeoutMs,
  };

  // The fixed monitor source on disk must hash to the bundled constant.
  const scriptFile = readBounded(join(canonical, SCRIPT_NAME), ports);
  if (!scriptFile.ok || sha256(scriptFile.data) !== intent.scriptHash)
    return unknown("SCRIPT_MISMATCH");

  const attemptFile = readBounded(join(canonical, ATTEMPT_NAME), ports);
  if (!attemptFile.ok) return unknown(`ATTEMPT_${attemptFile.code}`);
  const attempt = parseJson(attemptFile.data);
  const expectedArgv =
    ctx.platform === "win32"
      ? 6
      : 1;
  if (
    !attempt ||
    !sameKeys(attempt, [
      "argv",
      "command",
      "nonce",
      "route",
      "runId",
      "sessionId",
      "startedAt",
      "v",
    ]) ||
    attempt.v !== 1 ||
    attempt.runId !== binding.runId ||
    attempt.sessionId !== binding.sessionId ||
    attempt.nonce !== binding.nonce ||
    !Array.isArray(attempt.argv) ||
    attempt.argv.length !== expectedArgv
  )
    return unknown("ATTEMPT_MISMATCH");
  if (
    ctx.platform === "win32"
      ? attempt.argv[1] !== join(canonical, SCRIPT_NAME) ||
        attempt.argv[2] !== canonical ||
        attempt.argv[3] !== binding.nonce ||
        attempt.argv[4] !== String(binding.timeoutMs) ||
        attempt.argv[5] !== WINDOWS_MONITOR_MARKER
      : attempt.argv[0] !== join(canonical, SCRIPT_NAME)
  )
    return unknown("ATTEMPT_MISMATCH");

  const receiptFile = readBounded(join(canonical, RECEIPT_NAME), ports);
  if (!receiptFile.ok)
    return {
      status: receiptFile.code === "MISSING" ? "PENDING" : "UNKNOWN",
      code:
        receiptFile.code === "MISSING"
          ? "RECEIPT_MISSING"
          : `RECEIPT_${receiptFile.code}`,
      receipt: null,
    };
  const receipt = parseJson(receiptFile.data);
  if (
    !receipt ||
    !sameKeys(receipt, [
      "acceptedQuitSeen",
      "code",
      "malformed",
      "nonce",
      "physical",
      "productResult",
      "rawBytes",
      "rawSaved",
      "rawSha256",
      "rawTruncated",
      "runId",
      "scope",
      "sessionId",
      "status",
      "timeoutMs",
      "v",
    ]) ||
    receipt.v !== 1 ||
    receipt.scope !== RECEIPT_SCOPE ||
    !RECEIPT_STATUSES.has(receipt.status) ||
    receipt.runId !== binding.runId ||
    receipt.sessionId !== binding.sessionId ||
    receipt.nonce !== binding.nonce ||
    receipt.timeoutMs !== binding.timeoutMs ||
    receipt.productResult !== "NOT_RUN" ||
    receipt.physical !== "NOT_RUN" ||
    typeof receipt.code !== "string" ||
    typeof receipt.acceptedQuitSeen !== "boolean" ||
    typeof receipt.malformed !== "boolean" ||
    typeof receipt.rawSaved !== "boolean" ||
    typeof receipt.rawTruncated !== "boolean" ||
    !Number.isSafeInteger(receipt.rawBytes) ||
    receipt.rawBytes < 0 ||
    receipt.rawBytes > MAX_STDIN_BYTES ||
    (receipt.rawSha256 !== null && !HASH.test(receipt.rawSha256))
  )
    return unknown("RECEIPT_MISMATCH");
  if (receipt.status !== "COMPLETED")
    return { status: receipt.status, code: receipt.code, receipt };

  // A COMPLETED receipt additionally requires the exact retained raw stream:
  // saved, untruncated, hash+length bound, and parseable as init + the
  // nonce-bound accepted-quit line with nothing else.
  if (
    !receipt.rawSaved ||
    receipt.rawTruncated ||
    !receipt.acceptedQuitSeen ||
    receipt.malformed
  )
    return unknown("RECEIPT_INCOMPLETE");
  const rawFile = readBounded(join(canonical, RAW_NAME), ports, {
    max: MAX_STDIN_BYTES,
  });
  if (!rawFile.ok) return unknown(`RAW_${rawFile.code}`);
  if (
    rawFile.data.length !== receipt.rawBytes ||
    sha256(rawFile.data) !== receipt.rawSha256
  )
    return unknown("RAW_MISMATCH");
  const lines = rawFile.data.toString("utf8").split("\n").filter((l) => l);
  if (lines.length !== 2) return unknown("RAW_MISMATCH");
  const rawInit = parseJson(Buffer.from(lines[0], "utf8"));
  const rawAccepted = parseJson(Buffer.from(lines[1], "utf8"));
  if (
    !rawInit ||
    !sameKeys(rawInit, INTENT_KEYS) ||
    rawInit.v !== 1 ||
    rawInit.type !== "init" ||
    rawInit.runId !== binding.runId ||
    rawInit.sessionId !== binding.sessionId ||
    rawInit.nonce !== binding.nonce ||
    rawInit.runRoot !== intent.runRoot ||
    rawInit.approvedTempParent !== intent.approvedTempParent ||
    rawInit.tempRoot !== intent.tempRoot ||
    rawInit.scriptHash !== intent.scriptHash ||
    rawInit.timeoutMs !== binding.timeoutMs ||
    !rawAccepted ||
    !sameKeys(rawAccepted, ["nonce", "runId", "sessionId", "type", "v"]) ||
    rawAccepted.v !== 1 ||
    rawAccepted.type !== "accepted-quit" ||
    rawAccepted.runId !== binding.runId ||
    rawAccepted.sessionId !== binding.sessionId ||
    rawAccepted.nonce !== binding.nonce
  )
    return unknown("RAW_MISMATCH");

  // Windows additionally requires the helper's own immutable native result
  // (written in monitor mode before the helper's stdout): job-owned exit of
  // the owned child with the same nonce and no surviving job processes.
  if (ctx.platform === "win32") {
    const helperFile = readBounded(join(canonical, HELPER_RESULT_NAME), ports);
    if (!helperFile.ok) return unknown(`HELPER_${helperFile.code}`);
    const helper = parseJson(helperFile.data);
    if (
      !helper ||
      helper.v !== 1 ||
      helper.owned !== true ||
      helper.nonce !== binding.nonce ||
      helper.ownRootNonce !== binding.nonce ||
      helper.exited !== true ||
      helper.processCount !== 0 ||
      helper.exitCode !== 0 ||
      helper.timedOut !== false
    )
      return unknown("HELPER_MISMATCH");
  }
  return { status: "COMPLETED", code: receipt.code, receipt };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function awaitSessionEvidence(sessionRoot, ctx, waitMs, now) {
  const end = now() + waitMs;
  let outcome = readSessionEvidence(sessionRoot, ctx);
  while (outcome.status === "PENDING" && now() < end) {
    await pause(RECEIPT_POLL_STEP_MS);
    outcome = readSessionEvidence(sessionRoot, ctx);
  }
  if (outcome.status === "PENDING")
    return { status: "UNKNOWN", code: "RECEIPT_MISSING", receipt: null };
  return outcome;
}

/**
 * Start one owned monitor session for a validated request. Consumes a single
 * attempt: validation failures throw before spawn; post-dispatch failures are
 * retained as UNKNOWN observations with the immutable attempt on disk.
 * options.untrustedTest: {spawn, readFile, lstat, platform, tmpdir, now} —
 * named test seams only, never OS proof.
 */
export function startOwnedShutdownSession(request, options = {}) {
  const test = options?.untrustedTest ?? null;
  const ports = {
    spawn: test?.spawn ?? nodeSpawn,
    readFile: test?.readFile ?? ((path) => readFileSync(path)),
    lstat: test?.lstat ?? ((path) => lstatSync(path)),
    platform: test?.platform ?? process.platform,
    tmpBase: test?.tmpdir ? realpathSync(test.tmpdir()) : realpathSync(tmpdir()),
    now: test?.now ?? (() => Date.now()),
  };
  const receiptPollMs = options?.receiptPollMs ?? RECEIPT_POLL_MS;
  if (
    !Number.isSafeInteger(receiptPollMs) ||
    receiptPollMs < 0 ||
    receiptPollMs > 30_000
  )
    reject("RECEIPT_POLL", "receiptPollMs must be within 0..30000");
  const observationGraceMs =
    options?.observationGraceMs ?? OBSERVATION_GRACE_MS;
  if (
    !Number.isSafeInteger(observationGraceMs) ||
    observationGraceMs < 0 ||
    observationGraceMs > 30_000
  )
    reject("OBSERVATION_GRACE", "observationGraceMs must be within 0..30000");
  const req = parseRequest(request, ports);
  const route = ports.platform === "win32" ? "windows-helper" : "node";

  const sessionId = `s${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const nonce = randomUUID().replace(/-/g, "");
  const sessionRoot = mkdtempSync(join(req.runRoot, SESSION_PREFIX));
  if (ports.platform !== "win32") {
    try {
      chmodSync(sessionRoot, 0o700);
    } catch {
      // Private allocation is best-effort outside POSIX mode bits.
    }
  }
  const scriptPath = join(sessionRoot, SCRIPT_NAME);
  saveImmutable(scriptPath, OWNED_SHUTDOWN_MONITOR_SOURCE, 0o500);
  const scriptHash = sha256(ports.readFile(scriptPath));
  // approvedTempParent is computed BEFORE the child env pins TMP* to the
  // session root: the worker validates against this, never its own tmpdir().
  const approvedTempParent = ports.tmpBase;
  const intent = Object.freeze({
    v: 1,
    type: "init",
    runId: req.runId,
    sessionId,
    nonce,
    runRoot: req.runRoot,
    approvedTempParent,
    tempRoot: sessionRoot,
    scriptHash,
    timeoutMs: req.timeoutMs,
  });
  saveImmutable(
    join(sessionRoot, INTENT_NAME),
    JSON.stringify(intent, null, 2) + "\n",
  );
  const argv =
    route === "windows-helper"
      ? [
          req.nodeExe,
          scriptPath,
          sessionRoot,
          nonce,
          String(req.timeoutMs),
          WINDOWS_MONITOR_MARKER,
        ]
      : [scriptPath];
  const command =
    route === "windows-helper" ? req.windows.helperPath : req.nodeExe;
  const attempt = Object.freeze({
    v: 1,
    runId: req.runId,
    sessionId,
    nonce,
    route,
    command,
    argv: Object.freeze(argv.slice()),
    startedAt: new Date(ports.now()).toISOString(),
  });
  saveImmutable(
    join(sessionRoot, ATTEMPT_NAME),
    JSON.stringify(attempt, null, 2) + "\n",
  );

  const binding = Object.freeze({
    runId: req.runId,
    sessionId,
    nonce,
    timeoutMs: req.timeoutMs,
  });

  // Immediate pre-spawn revalidation at the synchronous boundary after the
  // evidence writes: pinned binaries and the fixed source are re-hashed and
  // the run root re-asserted (best-effort against TOCTOU; the native helper
  // performs its own kernel-side checks on Windows).
  pinnedFile(req.nodeExe, req.nodeSha256, "NODE", ports.readFile);
  pinnedFile(scriptPath, scriptHash, "SCRIPT", ports.readFile);
  if (req.windows)
    pinnedFile(
      req.windows.helperPath,
      req.windows.helperSha256,
      "HELPER",
      ports.readFile,
    );
  assertPrivateRunRoot(req.runRoot, ports.tmpBase);
  if (Date.parse(req.expiresAt) <= ports.now())
    reject("REQUEST_EXPIRED", "request expired before monitor dispatch; retain attempt");

  let child = null;
  let spawnError = null;
  try {
    child = ports.spawn(command, argv.slice(), {
      shell: false,
      windowsHide: true,
      cwd: sessionRoot,
      env: monitorEnv(sessionRoot, options?.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    spawnError = error;
  }
  // Unref so the monitor can never keep the owner (Electron) process alive.
  child?.unref?.();
  child?.stdin?.unref?.();
  child?.stdout?.unref?.();
  child?.stderr?.unref?.();

  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutRaw = [];
  const stderrRaw = [];
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let exitCode = null;
  let exitSignal = null;
  let closed = false;
  let dispatchError = null;
  // Backstop termination authority: the worker and native helper have their
  // own real bounded exits; this only kills OUR owned handle if it somehow
  // outlives the bound, and never fires after close.
  let backstop = null;
  const killOwnChild = () => {
    if (closed || !child || child.killed) return;
    try {
      child.kill?.("SIGKILL");
    } catch {
      // Cleanup uncertainty keeps the UNKNOWN/TIMED_OUT disposition.
    }
  };
  if (child) {
    backstop = setTimeout(
      killOwnChild,
      req.timeoutMs + observationGraceMs + 30_000,
    );
    backstop.unref?.();
    const capStream = (chunk, buckets) => {
      buckets.bytes += chunk.length;
      if (buckets.bytes > MAX_STREAM_BYTES) {
        buckets.truncated = true;
        return;
      }
      buckets.raw.push(chunk);
      buckets.hash.update(chunk);
    };
    const stdoutBucket = { bytes: 0, raw: stdoutRaw, hash: stdoutHash };
    const stderrBucket = { bytes: 0, raw: stderrRaw, hash: stderrHash };
    child.stdout?.on?.("data", (chunk) => {
      capStream(chunk, stdoutBucket);
      stdoutBytes = stdoutBucket.bytes;
      stdoutTruncated = stdoutBucket.truncated;
    });
    child.stderr?.on?.("data", (chunk) => {
      capStream(chunk, stderrBucket);
      stderrBytes = stderrBucket.bytes;
      stderrTruncated = stderrBucket.truncated;
    });
    child.once?.("error", (error) => {
      dispatchError = dispatchError ?? error;
    });
    child.once?.("close", (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      if (backstop) clearTimeout(backstop);
    });
    // The stdin write side must never crash the owner on EPIPE: attach an
    // error listener before the init write and record failures instead.
    child.stdin?.once?.("error", (error) => {
      dispatchError = dispatchError ?? error;
    });
  }

  let notified = false;
  let initWriteFailed = false;
  let acceptedWriteFailed = false;
  let acceptedWriteError = null;
  const writeMessage = (value, onFail) => {
    try {
      if (
        child?.stdin &&
        !child.stdin.destroyed &&
        !child.stdin.writableEnded
      ) {
        child.stdin.write(JSON.stringify(value) + "\n", (error) => {
          if (error) onFail(error);
        });
        return true;
      }
    } catch (error) {
      onFail(error);
      return error;
    }
    onFail(new Error("STDIN_CLOSED"));
    return false;
  };
  if (child) {
    const written = writeMessage(intent, () => {
      initWriteFailed = true;
    });
    if (written !== true) initWriteFailed = true;
  }

  const evidenceCtx = {
    runRoot: req.runRoot,
    runId: req.runId,
    platform: ports.platform,
    ports,
    expected: binding,
  };
  const observationState = { promise: null };
  const observation = () =>
    (observationState.promise ??= new Promise((resolve) => {
      const finish = (status, code, receipt) => {
        // A valid-looking receipt can never promote a failed dispatch or a
        // nonzero/killed own child into COMPLETED.
        let finalStatus = status;
        let finalCode = code;
        if (
          status === "COMPLETED" &&
          (!closed ||
            exitCode !== 0 ||
            dispatchError ||
            initWriteFailed ||
            acceptedWriteFailed)
        ) {
          finalStatus = "UNKNOWN";
          finalCode = "DISPATCH_INCOMPLETE";
        }
        resolve(
          Object.freeze({
            v: 1,
            status: finalStatus,
            code: finalCode,
            scope: RECEIPT_SCOPE,
            ...binding,
            route,
            sessionRoot,
            exitCode,
            exitSignal,
            closed,
            cleanupConfirmed: closed === true && finalStatus === "COMPLETED",
            receipt: receipt ?? null,
            stdoutBytes,
            stderrBytes,
            stdoutTruncated,
            stderrTruncated,
            stdoutRaw: Buffer.concat(stdoutRaw).toString("hex"),
            stderrRaw: Buffer.concat(stderrRaw).toString("hex"),
            stdoutSha256: stdoutHash.copy().digest("hex"),
            stderrSha256: stderrHash.copy().digest("hex"),
            spawnError: spawnError ? String(spawnError.message ?? spawnError) : null,
            dispatchError: dispatchError
              ? String(dispatchError.message ?? dispatchError)
              : null,
            acceptedWriteError: acceptedWriteError
              ? String(acceptedWriteError)
              : null,
            productResult: "NOT_RUN",
            physical: "NOT_RUN",
          }),
        );
      };

      if (!child || spawnError) {
        finish("UNKNOWN", "SPAWN_FAILED", null);
        return;
      }
      if (initWriteFailed && !closed) {
        finish("UNKNOWN", "INIT_WRITE_FAILED", null);
        return;
      }
      let settled = false;
      const settle = (status, code, receipt) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        finish(status, code, receipt);
      };
      const deadline = setTimeout(() => {
        killOwnChild();
        settle("TIMED_OUT", "OBSERVATION_DEADLINE", null);
      }, req.timeoutMs + observationGraceMs);
      deadline.unref?.();
      const onTerminal = () => {
        void awaitSessionEvidence(
          sessionRoot,
          evidenceCtx,
          receiptPollMs,
          ports.now,
        ).then((outcome) =>
          settle(
            outcome.status === "PENDING" ? "UNKNOWN" : outcome.status,
            outcome.code,
            outcome.receipt,
          ),
        );
      };
      // An early terminal event must still resolve for a late observation()
      // call: the retained receipt is the evidence, not the live child.
      if (closed || dispatchError) {
        onTerminal();
        return;
      }
      child.once?.("error", onTerminal);
      child.once?.("close", onTerminal);
    }));

  return Object.freeze({
    status: child && !spawnError && !initWriteFailed ? "STARTED" : "UNKNOWN",
    runId: req.runId,
    sessionId,
    sessionRoot,
    nonce,
    route,
    scriptPath,
    acceptedQuit() {
      if (notified) return;
      notified = true;
      const written = writeMessage(
        {
          v: 1,
          type: "accepted-quit",
          runId: req.runId,
          sessionId,
          nonce,
        },
        (error) => {
          acceptedWriteFailed = true;
          acceptedWriteError = String(error?.message ?? error);
        },
      );
      if (written !== true && acceptedWriteError === null)
        acceptedWriteError = "WRITE_FAILED";
    },
    observation,
  });
}

/**
 * Prepare the disposable environment for the explicit GUI batch route.
 * Requires the pinned Windows helper configuration on win32 BEFORE any GUI
 * launch; on other platforms the pinned Node runner is process.execPath.
 * finish() waits for every session receipt under runRoot with a bounded
 * deadline; no receipts is UNKNOWN, never success.
 */
export function prepareGuiOwnedShutdown(options = {}) {
  const test = options?.untrustedTest ?? null;
  const env = options?.env ?? {};
  const platform = test?.platform ?? process.platform;
  const readFile = test?.readFile ?? ((path) => readFileSync(path));
  const lstat = test?.lstat ?? ((path) => lstatSync(path));
  const tmpBase = realpathSync(test?.tmpdir ?? tmpdir());
  const now = test?.now ?? (() => Date.now());

  let windows = null;
  if (platform === "win32") {
    const helperPath = env[WINDOWS_OWNED_HELPER_ENV];
    const helperSha256 = env[WINDOWS_OWNED_HELPER_SHA256_ENV];
    if (typeof helperPath !== "string" || helperPath.length === 0)
      reject(
        "WINDOWS_HELPER_CONFIG",
        `${WINDOWS_OWNED_HELPER_ENV} is required before the GUI batch`,
      );
    if (typeof helperSha256 !== "string" || !HASH.test(helperSha256))
      reject(
        "WINDOWS_HELPER_CONFIG",
        `${WINDOWS_OWNED_HELPER_SHA256_ENV} must be a lowercase sha256 hex`,
      );
    pinnedFile(helperPath, helperSha256, "HELPER", readFile);
    // Product arming proves the actual FOLIO_DATA_DIR with this separately
    // pinned native probe. Refuse before any GUI launch when it is absent;
    // the Job helper proves ownership of its monitor, not the data directory.
    const probePath = env.FOLIO_WINDOWS_NATIVE_PROBE;
    const probeHash = env.FOLIO_WINDOWS_NATIVE_SHA256;
    if (typeof probePath !== "string" || !/\.exe$/i.test(probePath) ||
        typeof probeHash !== "string" || !HASH.test(probeHash))
      reject("WINDOWS_ROOT_PROBE_CONFIG", "Pinned native directory probe is required before the GUI batch");
    pinnedFile(probePath, probeHash, "ROOT_PROBE", readFile);
    windows = Object.freeze({ helperPath, helperSha256 });
  }

  if (!test && process.versions.electron)
    reject("NODE_RUNNER", "the owned shutdown runner must be real Node");

  const timeoutMs =
    options?.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MONITOR_TIMEOUT_MIN_MS ||
    timeoutMs > MONITOR_TIMEOUT_MAX_MS
  )
    reject("REQUEST_TIMEOUT", "timeoutMs must be within 1..300000");
  const requestTtlMs = options?.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
  if (
    !Number.isSafeInteger(requestTtlMs) ||
    requestTtlMs < 1 ||
    requestTtlMs > MAX_REQUEST_TTL_MS
  )
    reject("REQUEST_TTL", "requestTtlMs must be within 1..3600000");
  const waitMs = options?.waitMs ?? DEFAULT_FINISH_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > MONITOR_TIMEOUT_MAX_MS)
    reject("FINISH_WAIT", "waitMs must be within 1..300000");

  const runRoot = mkdtempSync(join(tmpBase, "folio-owned-shutdown-"));
  if (platform !== "win32") chmodSync(runRoot, 0o700);
  const workspace = join(runRoot, "workspace");
  mkdirSync(workspace, { mode: 0o700 });

  // Darwin: route the EXISTING authorized local-batch fixture contract through
  // this private runRoot so fixtures' FOLIO_DATA_DIR lands inside it. A
  // preexisting incompatible CI/debug/watch state is refused, never weakened;
  // GITHUB_ACTIONS must never be bypassed.
  const childExtra = {};
  if (platform === "darwin") {
    if (
      env.GITHUB_ACTIONS === "true" ||
      LOCAL_BATCH_FORBIDDEN.some((key) => env[key])
    )
      reject(
        "LOCAL_BATCH_POLICY",
        "incompatible CI/debug/watch state for the local GUI batch",
      );
    if (env[LOCAL_BATCH_ENV] !== undefined && env[LOCAL_BATCH_ENV] !== "1")
      reject("LOCAL_BATCH_POLICY", `${LOCAL_BATCH_ENV} must be exactly 1`);
    if (
      env[LOCAL_DATA_ROOT_ENV] !== undefined &&
      env[LOCAL_DATA_ROOT_ENV] !== runRoot
    )
      reject(
        "LOCAL_BATCH_POLICY",
        `${LOCAL_DATA_ROOT_ENV} cannot be repointed away from this runRoot`,
      );
    childExtra[LOCAL_BATCH_ENV] = "1";
    childExtra[LOCAL_DATA_ROOT_ENV] = runRoot;
  }
  if (platform === "win32") Object.assign(childExtra, prepareWindowsGuiBatch({
    runRoot, workspace, env: {...env, [OWNED_SHUTDOWN_OPT_IN_ENV]: "1"},
  }, test?.windowsBatch));

  const nodeExe = process.execPath;
  const request = Object.freeze({
    v: 1,
    runId: randomUUID(),
    runRoot,
    nodeExe,
    nodeSha256: sha256(readFile(nodeExe)),
    timeoutMs,
    expiresAt: new Date(now() + requestTtlMs).toISOString(),
    ...(windows ? { windows } : {}),
  });

  const childEnv = {
    ...(platform === "win32" ? childExtra : {...env, ...childExtra}),
    [OWNED_SHUTDOWN_OPT_IN_ENV]: "1",
    FOLIO_DATA_DIR: workspace,
    [OWNED_SHUTDOWN_REQUEST_ENV]: JSON.stringify(request),
  };

  // finish() is one cached observation: it uses the same strict evidence
  // reader as session observation(), bound to this request's runId, and one
  // consistent clock (the injected `now` port — never mixed with Date.now).
  const evidencePorts = { lstat, readFile };
  let finishPromise = null;
  const finish = () => (finishPromise ??= doFinish());
  async function doFinish() {
    const startedAt = now();
    const deadline = startedAt + waitMs;
    const ctx = { runRoot, runId: request.runId, platform, ports: evidencePorts };
    const sessions = () => {
      let entries;
      try {
        entries = readdirSync(runRoot, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(SESSION_PREFIX),
        )
        .map((entry) => join(runRoot, entry.name));
    };
    const receiptOf = (dir) => {
      const outcome = readSessionEvidence(dir, ctx);
      return { sessionRoot: dir, ...outcome };
    };

    let pending = [];
    let results = [];
    while (true) {
      results = sessions().map(receiptOf);
      pending = results.filter((entry) => entry.status === "PENDING");
      if (results.length === 0 || pending.length === 0) break;
      if (now() >= deadline) break;
      await pause(RECEIPT_POLL_STEP_MS);
    }

    let status;
    let code;
    if (pending.length > 0) {
      status = "TIMED_OUT";
      code = "RECEIPT_DEADLINE";
    } else if (results.length === 0) {
      status = "UNKNOWN";
      code = "RECEIPTS_MISSING";
    } else if (results.every((entry) => entry.status === "COMPLETED")) {
      status = "COMPLETED";
      code = "PIPE_CLOSED_AFTER_ACCEPTED_QUIT";
    } else if (results.some((entry) => entry.status === "TIMED_OUT")) {
      status = "TIMED_OUT";
      code = "MONITOR_DEADLINE";
    } else {
      status = "UNKNOWN";
      code = "RECEIPT_INCOMPLETE";
    }
    return Object.freeze({
      v: 1,
      status,
      code,
      scope: RECEIPT_SCOPE,
      runId: request.runId,
      runRoot,
      sessions: Object.freeze(results),
      waitedMs: Math.min(Math.max(now() - startedAt, 0), waitMs),
      waitMs,
      productResult: "NOT_RUN",
      physical: "NOT_RUN",
    });
  }

  return Object.freeze({
    env: Object.freeze(childEnv),
    runRoot,
    workspace,
    request,
    finish,
  });
}
