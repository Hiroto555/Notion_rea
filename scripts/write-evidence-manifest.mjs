// Import-safe current package evidence capture and manifest writer.
//
// This module binds an immutable run intent to the CURRENT verified package
// manifest (verifyPackageArtifacts), records host-captured unit/build/check/
// package-gui results with their raw bytes, and writes a bounded
// folio.package-current-evidence.v2 manifest. It never executes tests,
// builds, packaging, Git or GUI code itself: capture APIs only persist what a
// trusted caller already ran. Missing or malformed evidence stays
// UNKNOWN/NOT_RUN; historical outputs are referenced, never claimed as fresh.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackageArtifacts } from "./platform/package-evidence.mjs";

export const INTENT_SCHEMA = "folio.package-evidence-intent.v1";
export const RESULT_SCHEMA = "folio.package-evidence-result.v1";
export const GUI_RAW_SCHEMA = "folio.package-gui-result.v1";
export const MANIFEST_SCHEMA = "folio.package-current-evidence.v2";
export const RUN_ROOT_PARENT = join("output", "validation-runs");
export const INTENT_NAME = "intent.json";
export const ATTEMPT_NAME = "package-gui-attempt.json";
export const GUI_RAW_NAME = "package-gui-raw.json";
export const RESULT_KINDS = Object.freeze([
  "unit",
  "build",
  "check",
  "package-gui",
]);
export const HISTORICAL_REFERENCES = Object.freeze([
  "research/evidence/final-validation.json",
  "docs/validation/gate-a/results.json",
  "docs/validation/gate-a/manifest.json",
  "review/2026-10-26/Folio_Acceptance_Catalog.json",
  "review/2026-10-26/gate-a-results.json",
  "output/dev-smoke.json",
  "output/package-smoke.json",
]);

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_TTL_MS = 1_800_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_RAW_BYTES = 32 * 1024 * 1024;
const MAX_TEST_FILES = 10_000;
const MAX_ASSERTIONS = 1_000_000;
const TEST_STATUSES = new Set([
  "passed",
  "failed",
  "pending",
  "skipped",
  "todo",
]);
const INVENTORY_DIRS = ["src", "tests", "scripts"];
const INVENTORY_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
];
const RESERVED_BASENAMES = new Set([
  INTENT_NAME,
  ATTEMPT_NAME,
  GUI_RAW_NAME,
  ...RESULT_KINDS.map((kind) => `${kind}-result.json`),
]);

function fail(code) {
  throw new Error(code);
}
function isObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
function equal(a, b, code) {
  if (canonical(a) !== canonical(b)) fail(code);
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function fileHash(path) {
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) fail("EVIDENCE_FILE_INVALID");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (size === 0) break;
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function boundedBytes(path, max = MAX_JSON_BYTES) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail("EVIDENCE_FILE_MISSING");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("EVIDENCE_FILE_INVALID");
  if (stat.size < 1 || stat.size > max) fail("EVIDENCE_FILE_BOUNDS");
  const bytes = readFileSync(path);
  if (bytes.length > max) fail("EVIDENCE_FILE_BOUNDS");
  return bytes;
}
function readJson(path, max = MAX_JSON_BYTES) {
  let value;
  try {
    value = JSON.parse(boundedBytes(path, max).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail("EVIDENCE_JSON_MALFORMED");
    throw error;
  }
  if (!isObject(value)) fail("EVIDENCE_JSON_MALFORMED");
  return value;
}
function writeImmutable(path, text) {
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
}
function strictInside(root, path) {
  const rel = relative(root, path);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    fail("EVIDENCE_PATH_OUTSIDE_ROOT");
  return rel.split(sep).join("/");
}
// Check existing ancestors as well as the leaf: lexical containment alone
// would let a run-local directory symlink redirect an immutable write.
export function assertEvidencePath(root, path, allowMissing = false) {
  const parts = strictInside(root, resolve(path)).split("/");
  const base = lstatSync(root);
  if (base.isSymbolicLink() || !base.isDirectory())
    fail("EVIDENCE_PATH_SYMLINK");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
      fail("EVIDENCE_PATH_SYMLINK");
  }
}
function nowValue(now) {
  const value = typeof now === "function" ? now() : (now ?? Date.now());
  if (!Number.isSafeInteger(value)) fail("EVIDENCE_TIME");
  return value;
}

function normalizeSelection(selection) {
  if (!isObject(selection)) fail("EVIDENCE_SELECTION");
  const normalized = { root: resolve(selection.root ?? process.cwd()) };
  for (const key of ["platform", "arch", "icon", "windowsHelpers"]) {
    if (selection[key] !== undefined) normalized[key] = selection[key];
  }
  return normalized;
}

// ALL regular files under src/tests/scripts plus the fixed config files, then
// every manifest.source entry (current dist included) rehashed byte-for-byte.
// Symlinks, missing referenced files and root escapes refuse.
export function sourceFingerprint(selection, manifest) {
  const files = [];
  const push = (absolutePath, rel) => {
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      fail("EVIDENCE_SOURCE_MISSING");
    }
    if (stat.isSymbolicLink()) fail("EVIDENCE_SOURCE_SYMLINK");
    if (!stat.isFile()) return;
    files.push({ path: rel, sha256: fileHash(absolutePath) });
  };
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = join(dir, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(absolutePath, `${rel}/`);
      else push(absolutePath, rel);
    }
  };
  for (const dir of INVENTORY_DIRS) {
    const base = join(selection.root, dir);
    assertEvidencePath(selection.root, base);
    if (!lstatSync(base).isDirectory()) fail("EVIDENCE_SOURCE_MISSING");
    walk(base, `${dir}/`);
  }
  for (const name of INVENTORY_FILES) {
    const absolutePath = join(selection.root, name);
    assertEvidencePath(selection.root, absolutePath);
    push(absolutePath, name);
  }
  const packageSource = (manifest.source ?? []).map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.path !== "string" ||
      !HASH.test(entry.sha256 ?? "")
    )
      fail("EVIDENCE_SOURCE_MISSING");
    const absolutePath = isAbsolute(entry.path)
      ? entry.path
      : join(selection.root, ...entry.path.split("/"));
    if (!isAbsolute(entry.path) && entry.path.split("/").includes(".."))
      fail("EVIDENCE_PATH_OUTSIDE_ROOT");
    push(absolutePath, entry.path);
    return { path: entry.path, sha256: fileHash(absolutePath) };
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(
    canonical({
      inventory: files,
      packageSource: packageSource.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    }),
  );
}

function currentBinding(selection, verify) {
  const manifest = verify(selection);
  if (!isObject(manifest) || !isObject(manifest.plan))
    fail("EVIDENCE_VERIFY_INVALID");
  const manifestSha256 = fileHash(manifest.plan.manifestPath);
  if (fileHash(manifest.plan.artifactPath) !== manifest.artifact.sha256)
    fail("EVIDENCE_ARTIFACT_CHANGED");
  return {
    manifest,
    binding: Object.freeze({
      artifactSha256: manifest.artifact.sha256,
      manifestSha256,
      invocationBase: manifest.invocation.deterministicBase,
      platform: manifest.plan.platform,
      arch: manifest.plan.arch,
      version: manifest.plan.appVersion,
      sourceSha256: sourceFingerprint(selection, manifest),
    }),
  };
}

export function captureEvidenceIntent(
  { selection, runId, now = Date.now(), ttlMs = MAX_TTL_MS } = {},
  { verify = verifyPackageArtifacts } = {},
) {
  if (typeof runId !== "string" || !RUN_ID.test(runId))
    fail("EVIDENCE_RUN_ID");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS)
    fail("EVIDENCE_TTL");
  if (!Number.isSafeInteger(now)) fail("EVIDENCE_TIME");
  const normalized = normalizeSelection(selection);
  const { binding } = currentBinding(normalized, verify);
  const parent = join(normalized.root, RUN_ROOT_PARENT);
  const runRoot = join(parent, runId);
  if (existsSync(runRoot)) fail("EVIDENCE_RUN_EXISTS");
  assertEvidencePath(normalized.root, runRoot, true);
  mkdirSync(parent, { recursive: true });
  mkdirSync(runRoot, { mode: 0o700 });
  const intent = {
    schema: INTENT_SCHEMA,
    runId,
    createdAt: now,
    expiresAt: now + ttlMs,
    selection: normalized,
    binding,
  };
  const intentPath = join(runRoot, INTENT_NAME);
  writeImmutable(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  return Object.freeze({ runRoot, intentPath, intent: Object.freeze(intent) });
}

export function readEvidenceIntent(
  intentPath,
  { verify = verifyPackageArtifacts, now } = {},
) {
  if (typeof intentPath !== "string" || !isAbsolute(intentPath))
    fail("EVIDENCE_INTENT_PATH");
  const intent = readJson(intentPath);
  equal(
    Object.keys(intent).sort(),
    ["schema", "runId", "createdAt", "expiresAt", "selection", "binding"].sort(),
    "EVIDENCE_INTENT_SCHEMA",
  );
  if (intent.schema !== INTENT_SCHEMA) fail("EVIDENCE_INTENT_SCHEMA");
  if (typeof intent.runId !== "string" || !RUN_ID.test(intent.runId))
    fail("EVIDENCE_RUN_ID");
  if (
    !Number.isSafeInteger(intent.createdAt) ||
    !Number.isSafeInteger(intent.expiresAt) ||
    intent.expiresAt <= intent.createdAt ||
    intent.expiresAt - intent.createdAt > MAX_TTL_MS
  )
    fail("EVIDENCE_INTENT_TIME");
  const at = nowValue(now);
  if (at > intent.expiresAt) fail("EVIDENCE_INTENT_EXPIRED");
  if (at < intent.createdAt) fail("EVIDENCE_INTENT_TIME");
  const selection = normalizeSelection(intent.selection);
  const runRoot = join(selection.root, RUN_ROOT_PARENT, intent.runId);
  if (resolve(intentPath) !== join(runRoot, INTENT_NAME))
    fail("EVIDENCE_INTENT_PATH");
  assertEvidencePath(selection.root, intentPath);
  // Reading the run binding re-verifies the CURRENT artifact every time.
  const { manifest, binding } = currentBinding(selection, verify);
  equal(intent.binding, binding, "EVIDENCE_BINDING_STALE");
  return Object.freeze({
    runRoot,
    intentPath: resolve(intentPath),
    intent,
    manifest,
  });
}

function resultPath(runRoot, kind) {
  return join(runRoot, `${kind}-result.json`);
}

function checkTimes(intent, startTime, endTime, now) {
  if (
    !Number.isSafeInteger(startTime) ||
    !Number.isSafeInteger(endTime) ||
    startTime < intent.createdAt ||
    startTime > endTime ||
    endTime > now
  )
    fail("EVIDENCE_RESULT_TIME");
}

function rawReference(runRoot, rawPath) {
  if (typeof rawPath !== "string" || !isAbsolute(rawPath))
    fail("EVIDENCE_RAW_PATH");
  const resolved = resolve(rawPath);
  const rel = strictInside(runRoot, resolved);
  assertEvidencePath(runRoot, resolved);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    fail("EVIDENCE_RAW_MISSING");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("EVIDENCE_RAW_INVALID");
  if (stat.size < 1 || stat.size > MAX_RAW_BYTES) fail("EVIDENCE_RAW_BOUNDS");
  return { rel, resolved, sha256: fileHash(resolved) };
}

function checkOutcome(exitCode, signal) {
  if (
    !(exitCode === null || (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255))
  )
    fail("EVIDENCE_RESULT_OUTCOME");
  if (!(signal === null || (typeof signal === "string" && signal.length > 0)))
    fail("EVIDENCE_RESULT_OUTCOME");
}

export function recordEvidenceResult(
  { intentPath, kind, startTime, endTime, exitCode, signal, rawPath } = {},
  { verify = verifyPackageArtifacts, now } = {},
) {
  const at = nowValue(now);
  const ctx = readEvidenceIntent(intentPath, { verify, now: at });
  if (!RESULT_KINDS.includes(kind)) fail("EVIDENCE_KIND");
  checkTimes(ctx.intent, startTime, endTime, at);
  checkOutcome(exitCode, signal);
  const raw = rawReference(ctx.runRoot, rawPath);
  const record = {
    schema: RESULT_SCHEMA,
    runId: ctx.intent.runId,
    binding: ctx.intent.binding,
    intentSha256: fileHash(ctx.intentPath),
    kind,
    startTime,
    endTime,
    exitCode,
    signal,
    raw: { path: raw.rel, sha256: raw.sha256 },
  };
  const recordPath = resultPath(ctx.runRoot, kind);
  writeImmutable(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return Object.freeze({ recordPath, record: Object.freeze(record) });
}

// Reads and fully revalidates a stored result record (path or object): fixed
// location inside runRoot, schema/kind/time/binding/intent hash and the raw
// bytes rehashed now. A bare exit code or missing raw is never accepted.
function readResultRecord(reference, ctx, kind, now) {
  const record = (() => {
        if (typeof reference !== "string" || !isAbsolute(reference))
          fail("EVIDENCE_RESULT_PATH");
        const resolved = resolve(reference);
        if (resolved !== resultPath(ctx.runRoot, kind))
          fail("EVIDENCE_RESULT_PATH");
        assertEvidencePath(ctx.runRoot, resolved);
        return readJson(resolved);
      })();
  equal(
    Object.keys(record).sort(),
    [
      "schema",
      "runId",
      "binding",
      "intentSha256",
      "kind",
      "startTime",
      "endTime",
      "exitCode",
      "signal",
      "raw",
    ].sort(),
    "EVIDENCE_RESULT_SCHEMA",
  );
  if (record.schema !== RESULT_SCHEMA || record.kind !== kind)
    fail("EVIDENCE_RESULT_SCHEMA");
  if (record.runId !== ctx.intent.runId) fail("EVIDENCE_RESULT_BINDING");
  equal(record.binding, ctx.intent.binding, "EVIDENCE_RESULT_BINDING");
  if (record.intentSha256 !== fileHash(ctx.intentPath))
    fail("EVIDENCE_INTENT_CHANGED");
  checkTimes(ctx.intent, record.startTime, record.endTime, now);
  checkOutcome(record.exitCode, record.signal);
  if (!isObject(record.raw)) fail("EVIDENCE_RAW_INVALID");
  const rawPath = join(ctx.runRoot, ...String(record.raw.path ?? "").split("/"));
  if (strictInside(ctx.runRoot, rawPath) !== record.raw.path)
    fail("EVIDENCE_RAW_PATH");
  assertEvidencePath(ctx.runRoot, rawPath);
  const bytes = boundedBytes(rawPath, MAX_RAW_BYTES);
  if (sha256(bytes) !== record.raw.sha256) fail("EVIDENCE_RAW_MISMATCH");
  return { record, rawPath, bytes };
}

function receiptStatus(record) {
  return record.exitCode === 0 && record.signal === null ? "PASS" : "FAIL";
}

// Lead-authored unit count rules: assertion statuses are counted, never the
// numeric summary alone; success with contradictory evidence refuses.
function evaluateUnit({ record, bytes }, ctx) {
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("EVIDENCE_UNIT_RAW");
  }
  if (!isObject(raw) || typeof raw.success !== "boolean")
    fail("EVIDENCE_UNIT_RAW");
  const counters = [
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
    "numTotalTests",
    "numFailedTestSuites",
    "numPendingTestSuites",
  ];
  for (const key of counters) {
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0)
      fail("EVIDENCE_UNIT_COUNTS");
  }
  if (
    !Number.isFinite(raw.startTime) ||
    raw.startTime < record.startTime ||
    raw.startTime > record.endTime
  )
    fail("EVIDENCE_UNIT_TIME");
  if (
    !Array.isArray(raw.testResults) ||
    raw.testResults.length < 1 ||
    raw.testResults.length > MAX_TEST_FILES
  )
    fail("EVIDENCE_UNIT_FILES");
  const counts = { passed: 0, failed: 0, pending: 0, todo: 0 };
  const names = new Set();
  let assertions = 0;
  let allFilesPassed = true;
  for (const file of raw.testResults) {
    if (!isObject(file) || !["passed", "failed"].includes(file.status))
      fail("EVIDENCE_UNIT_STATUS");
    if (typeof file.name !== "string" || names.has(file.name))
      fail("EVIDENCE_UNIT_FILES");
    names.add(file.name);
    const rel = relative(selectionRoot(ctx), file.name);
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.split(sep)[0] !== "tests"
    )
      fail("EVIDENCE_UNIT_FILE_ROOT");
    assertEvidencePath(selectionRoot(ctx), file.name);
    if (!lstatSync(file.name).isFile()) fail("EVIDENCE_UNIT_FILES");
    if (
      !Number.isFinite(file.startTime) ||
      !Number.isFinite(file.endTime) ||
      file.startTime < record.startTime ||
      file.endTime > record.endTime ||
      file.startTime > file.endTime
    )
      fail("EVIDENCE_UNIT_TIME");
    if (file.status !== "passed") allFilesPassed = false;
    if (!Array.isArray(file.assertionResults)) fail("EVIDENCE_UNIT_ASSERTIONS");
    assertions += file.assertionResults.length;
    if (assertions > MAX_ASSERTIONS) fail("EVIDENCE_UNIT_ASSERTIONS");
    const fullNames = new Set();
    for (const assertion of file.assertionResults) {
      if (
        !isObject(assertion) ||
        typeof assertion.fullName !== "string" ||
        assertion.fullName.length === 0 ||
        fullNames.has(assertion.fullName) ||
        !TEST_STATUSES.has(assertion.status)
      )
        fail("EVIDENCE_UNIT_ASSERTIONS");
      fullNames.add(assertion.fullName);
      counts[assertion.status === "skipped" ? "pending" : assertion.status] += 1;
    }
  }
  const total = counts.passed + counts.failed + counts.pending + counts.todo;
  if (
    raw.numPassedTests !== counts.passed ||
    raw.numFailedTests !== counts.failed ||
    raw.numPendingTests !== counts.pending ||
    raw.numTodoTests !== counts.todo ||
    raw.numTotalTests !== total
  )
    fail("EVIDENCE_UNIT_COUNTS");
  const cleanOutcome = record.exitCode === 0 && record.signal === null;
  if (
    raw.success === true &&
    (!cleanOutcome || counts.failed > 0 || !allFilesPassed ||
      raw.numFailedTestSuites !== 0)
  )
    fail("EVIDENCE_UNIT_CONTRADICTION");
  const passed =
    cleanOutcome &&
    raw.success === true &&
    counts.passed > 0 &&
    counts.failed === 0 &&
    allFilesPassed &&
    raw.numFailedTestSuites === 0 &&
    raw.numPendingTestSuites === 0;
  return {
    status: passed ? "PASS" : "FAIL",
    passed: counts.passed,
    failed: counts.failed,
    pending: counts.pending,
    todo: counts.todo,
    skipped: counts.pending + counts.todo,
    total,
    files: raw.testResults.length,
  };
}

function selectionRoot(ctx) {
  return ctx.intent.selection.root;
}

function expectedExecutable(manifest) {
  return join(
    manifest.plan.outputDir,
    manifest.plan.platform === "darwin"
      ? "Folio.app/Contents/MacOS/Folio"
      : "Folio.exe",
  );
}
function verifyGuiBuild(raw, ctx) {
  const root = ctx.intent.selection.root;
  const stages = [
    ["tsc", [join(root, "node_modules/typescript/bin/tsc"), "--noEmit"]],
    ["vite", [join(root, "node_modules/vite/bin/vite.js"), "build"]],
    ["main", [join(root, "scripts/build.mjs")]],
  ];
  if (!Array.isArray(raw.build) || raw.build.length !== stages.length)
    fail("EVIDENCE_GUI_BUILD");
  for (const [index, [name, args]] of stages.entries()) {
    const stage = raw.build[index];
    if (!isObject(stage) || stage.name !== name || stage.exitCode !== 0 ||
        stage.signal !== null || stage.error !== null ||
        typeof stage.command !== "string" || !isAbsolute(stage.command))
      fail("EVIDENCE_GUI_BUILD");
    equal(stage.args, args, "EVIDENCE_GUI_BUILD");
    for (const stream of ["stdout", "stderr"]) {
      const reference = stage[stream];
      const expectedPath = join(ctx.runRoot, `build-${name}.${stream}`);
      if (!isObject(reference) || reference.path !== expectedPath ||
          !HASH.test(reference.sha256 ?? ""))
        fail("EVIDENCE_GUI_BUILD");
      assertEvidencePath(ctx.runRoot, expectedPath);
      const stat = lstatSync(expectedPath);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 ||
          fileHash(expectedPath) !== reference.sha256)
        fail("EVIDENCE_GUI_BUILD");
    }
  }
}

// A COMPLETED GUI raw must match every bound gate or the record is forged;
// status UNKNOWN is retained as UNKNOWN, never promoted.
function evaluateGui({ record, bytes }, ctx) {
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("EVIDENCE_GUI_RAW");
  }
  if (!isObject(raw) || raw.schema !== GUI_RAW_SCHEMA) fail("EVIDENCE_GUI_RAW");
  if (raw.runId !== ctx.intent.runId) fail("EVIDENCE_GUI_BINDING");
  equal(raw.binding, ctx.intent.binding, "EVIDENCE_GUI_BINDING");
  if (raw.intentSha256 !== fileHash(ctx.intentPath))
    fail("EVIDENCE_GUI_BINDING");
  if (raw.status === "UNKNOWN") return { status: "UNKNOWN" };
  if (raw.status !== "COMPLETED") fail("EVIDENCE_GUI_RAW");
  verifyGuiBuild(raw, ctx);
  const attemptPath = join(ctx.runRoot, ATTEMPT_NAME);
  assertEvidencePath(ctx.runRoot, attemptPath);
  const attempt = readJson(attemptPath);
  if (
    attempt.schema !== "folio.package-gui-attempt.v1" ||
    attempt.runId !== ctx.intent.runId ||
    attempt.intentSha256 !== raw.intentSha256 ||
    !HASH.test(raw.attemptSha256 ?? "") ||
    raw.attemptSha256 !== fileHash(attemptPath) ||
    typeof attempt.nonce !== "string" || !attempt.nonce ||
    attempt.createdAt !== record.startTime
  ) fail("EVIDENCE_GUI_ATTEMPT");
  equal(attempt.binding, ctx.intent.binding, "EVIDENCE_GUI_ATTEMPT");
  if (record.exitCode !== 0 || record.signal !== null)
    fail("EVIDENCE_GUI_FORGED");
  const binding = ctx.intent.binding;
  const smoke = raw.smoke;
  const shutdown = raw.shutdown;
  const forged =
    !isObject(smoke) ||
    smoke.ok !== true ||
    smoke.persistence !== true ||
    smoke.artifactHash !== binding.artifactSha256 ||
    smoke.platform !== binding.platform ||
    smoke.arch !== binding.arch ||
    smoke.executablePath !== expectedExecutable(ctx.manifest) ||
    typeof raw.monitorRunId !== "string" ||
    raw.monitorRunId.length === 0 ||
    !isObject(shutdown) ||
    shutdown.status !== "COMPLETED" ||
    shutdown.runId !== raw.monitorRunId ||
    shutdown.monitorRunId !== raw.monitorRunId ||
    shutdown.scope !== "PIPE_CLOSED_AFTER_ACCEPTED_QUIT" ||
    shutdown.code !== "PIPE_CLOSED_AFTER_ACCEPTED_QUIT" ||
    !Array.isArray(shutdown.sessions) ||
    shutdown.sessions.length < 1 ||
    shutdown.sessions.some(session => session?.status !== "COMPLETED");
  if (forged) fail("EVIDENCE_GUI_FORGED");
  return { status: "PASS", monitorRunId: raw.monitorRunId };
}

export function createEvidenceManifest(
  { intentPath, unitRecord, buildRecord, checkRecord, guiRecord } = {},
  { verify = verifyPackageArtifacts, now } = {},
) {
  const at = nowValue(now);
  const ctx = readEvidenceIntent(intentPath, { verify, now: at });
  const records = [];
  const readBound = (reference, kind) => {
    const result = readResultRecord(reference, ctx, kind, at);
    records.push({
      kind, path: reference, sha256: fileHash(reference),
      raw: { ...result.record.raw },
    });
    return result;
  };
  const unit = evaluateUnit(
    readBound(unitRecord, "unit"),
    ctx,
  );
  const build = {
    status: receiptStatus(readBound(buildRecord, "build").record),
  };
  const check = {
    status: receiptStatus(readBound(checkRecord, "check").record),
  };
  const nonGuiStatus =
    unit.status === "PASS" && build.status === "PASS" && check.status === "PASS"
      ? "PASS"
      : "FAIL";
  const gui =
    guiRecord === undefined
      ? { status: "NOT_RUN" }
      : evaluateGui(readBound(guiRecord, "package-gui"), ctx);
  for (const record of records) {
    const again = readResultRecord(record.path, ctx, record.kind, at);
    if (fileHash(record.path) !== record.sha256)
      fail("EVIDENCE_RESULT_CHANGED");
    equal(again.record.raw, record.raw, "EVIDENCE_RESULT_CHANGED");
  }
  readEvidenceIntent(intentPath, { verify, now: at });
  return {
    schema: MANIFEST_SCHEMA,
    runId: ctx.intent.runId,
    binding: ctx.intent.binding,
    results: records,
    artifact: {
      outputDir: ctx.manifest.plan.outputDir,
      artifactPath: ctx.manifest.plan.artifactPath,
      artifactSha256: ctx.intent.binding.artifactSha256,
      manifestPath: ctx.manifest.plan.manifestPath,
      manifestSha256: ctx.intent.binding.manifestSha256,
      platform: ctx.intent.binding.platform,
      arch: ctx.intent.binding.arch,
      version: ctx.intent.binding.version,
      prerequisites: ctx.manifest.prerequisites,
    },
    nonGui: { status: nonGuiStatus, unit, build, check },
    gui,
    physical: "NOT_RUN",
    ime: "NOT_RUN",
    keychain: "NOT_RUN",
    dpapi: "NOT_RUN",
    protectedData: "NOT_RUN",
    osExecuted: false,
    signed: false,
    certification: "Lv3",
    historicalReferences: HISTORICAL_REFERENCES.map((path) => ({
      path,
      status: "historical",
    })),
  };
}

// Shared exclusive writer for new JSON files under a validated runRoot.
// Refuses fixed/reserved names, existing files and anything outside runRoot.
export function writeRunJson(runRoot, outputPath, data, allowReserved = false) {
  if (typeof outputPath !== "string" || !isAbsolute(outputPath))
    fail("EVIDENCE_OUTPUT_PATH");
  const resolved = resolve(outputPath);
  strictInside(runRoot, resolved);
  assertEvidencePath(runRoot, resolved, true);
  if (!allowReserved && RESERVED_BASENAMES.has(basename(resolved)))
    fail("EVIDENCE_OUTPUT_RESERVED");
  if (existsSync(resolved)) fail("EVIDENCE_OUTPUT_EXISTS");
  writeImmutable(resolved, `${JSON.stringify(data, null, 2)}\n`);
  return resolved;
}

export function writeEvidenceManifest(
  { outputPath, ...createOptions } = {},
  dependencies = {},
) {
  const manifest = createEvidenceManifest(createOptions, dependencies);
  // Revalidate the current binding after all input reads, before the write.
  const ctx = readEvidenceIntent(createOptions.intentPath, dependencies);
  const resolved = writeRunJson(ctx.runRoot, outputPath, manifest);
  return Object.freeze({ outputPath: resolved, manifest });
}

const VALUE_FLAGS = new Map([
  ["--selection", "selectionPath"],
  ["--intent", "intentPath"],
  ["--unit-record", "unitRecord"],
  ["--build-record", "buildRecord"],
  ["--check-record", "checkRecord"],
  ["--gui-record", "guiRecord"],
  ["--out", "outputPath"],
  ["--run-id", "runId"],
]);

export function parseEvidenceArgs(args) {
  if (!Array.isArray(args)) fail("EVIDENCE_ARGUMENTS");
  const values = {};
  let createIntent = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--create-intent") {
      if (createIntent) fail("EVIDENCE_ARGUMENTS");
      createIntent = true;
      continue;
    }
    const field = VALUE_FLAGS.get(arg);
    if (!field || seen.has(arg)) fail("EVIDENCE_ARGUMENTS");
    const value = args[index + 1];
    if (typeof value !== "string" || value.startsWith("--"))
      fail("EVIDENCE_ARGUMENTS");
    seen.add(arg);
    values[field] = value;
    index++;
  }
  if (createIntent) {
    if (
      seen.size !== 2 ||
      !values.selectionPath ||
      !values.runId ||
      !RUN_ID.test(values.runId)
    )
      fail("EVIDENCE_ARGUMENTS");
    return Object.freeze({
      mode: "create-intent",
      selectionPath: values.selectionPath,
      runId: values.runId,
    });
  }
  for (const key of [
    "selectionPath",
    "intentPath",
    "unitRecord",
    "buildRecord",
    "checkRecord",
    "outputPath",
  ]) {
    if (!values[key]) fail("EVIDENCE_ARGUMENTS");
  }
  if (values.runId) fail("EVIDENCE_ARGUMENTS");
  return Object.freeze({ mode: "write", ...values });
}

export function readSelectionFile(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail("EVIDENCE_SELECTION_PATH");
  return normalizeSelection(readJson(path));
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const parsed = parseEvidenceArgs(args);
  const selection = readSelectionFile(parsed.selectionPath);
  if (parsed.mode === "create-intent") {
    const result = captureEvidenceIntent(
      { selection, runId: parsed.runId },
      dependencies,
    );
    console.log(result.intentPath);
    return result;
  }
  const ctx = readEvidenceIntent(parsed.intentPath, dependencies);
  equal(selection, ctx.intent.selection, "EVIDENCE_SELECTION_MISMATCH");
  const outcome = writeEvidenceManifest(
    {
      intentPath: parsed.intentPath,
      unitRecord: parsed.unitRecord,
      buildRecord: parsed.buildRecord,
      checkRecord: parsed.checkRecord,
      ...(parsed.guiRecord ? { guiRecord: parsed.guiRecord } : {}),
      outputPath: parsed.outputPath,
    },
    dependencies,
  );
  console.log(outcome.outputPath);
  return outcome;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
