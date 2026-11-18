#!/usr/bin/env node
// Explicit opt-in gate for the Playwright suites.
//
// npm run test:e2e        -> refuse unless the invocation is a safe --list dry-run
// npm run test:e2e:batch  -> add the explicit opt-in to the child env and launch
//
// argv is forwarded as an array (never a shell string). Importing this module
// has no side effects; main() only runs when the file is executed directly.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareGuiOwnedShutdown } from "./gui-owned-shutdown.mjs";
import {
  ATTEMPT_NAME,
  GUI_RAW_NAME,
  assertEvidencePath,
  canonical,
  readEvidenceIntent,
  recordEvidenceResult,
} from "./write-evidence-manifest.mjs";
import { verifyPackageArtifacts } from "./platform/package-evidence.mjs";
import { runPackagedGuiSmoke } from "./verify-package.mjs";

export const GUI_TEST_OPT_IN_ENV = "FOLIO_GUI_TEST_OPT_IN";
export const GUI_TEST_OPT_IN_VALUE = "1";
export const OWNED_SHUTDOWN_FLAG = "--owned-shutdown";

export const GUI_TEST_REFUSAL_MESSAGE = [
  "GUI test execution is disabled by default. Electron/browser launch is not allowed.",
  "GUIテストは既定で拒否されました。Electron/ブラウザの起動は許可されていません。",
  "Only after the user explicitly approves GUI execution, run: npm run test:e2e:batch",
  "ユーザーがGUI実行を明示的に許可した場合だけ `npm run test:e2e:batch` を実行してください。",
  "Safe dry-run (no test execution): npm run test:e2e -- --list",
  "安全なdry-run（テスト実行なし）: `npm run test:e2e -- --list`",
  "Direct npx playwright test and direct playwright.dev-round3.config.ts use are rejected during config evaluation without the opt-in.",
].join("\n");

const VALUE_OPTIONS = new Set([
  "--browser",
  "--config",
  "--grep",
  "--grep-invert",
  "--global-timeout",
  "--max-failures",
  "--only-changed",
  "--output",
  "--project",
  "--repeat-each",
  "--reporter",
  "--retries",
  "--shard",
  "--test-list",
  "--timeout",
  "--tsconfig",
  "--update-snapshots",
  "--update-source-method",
  "--workers",
  "-c",
  "-g",
  "-j",
]);

const BOOLEAN_OPTIONS = new Set([
  "--debug",
  "--fail-on-flaky-tests",
  "--forbid-only",
  "--fully-parallel",
  "--headed",
  "--ignore-snapshots",
  "--last-failed",
  "--list",
  "--pass-with-no-tests",
  "--quiet",
  "--ui",
]);

export function isGuiTestOptedIn(env) {
  return env[GUI_TEST_OPT_IN_ENV] === GUI_TEST_OPT_IN_VALUE;
}

export function hasSafeListFlag(argv) {
  // Playwright dispatches UI mode before list mode. Scan the WHOLE argv first,
  // including tokens after --list, and fail closed for GUI/debug/custom reporter
  // modes. Conservative rejection inside a filter value is intentional.
  if (argv.some((arg) => /^(--ui(?:-host|-port)?|--debug|--headed|--reporter)(?:=|$)/.test(arg))) return false;
  let consumeNext = false;
  let foundList = false;
  for (const arg of argv) {
    if (consumeNext) {
      consumeNext = false;
      continue;
    }
    if (arg === "--") return false;
    if (arg === "--list") { foundList = true; continue; }
    if (!arg.startsWith("-") || arg === "-") continue;

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals >= 0 ? arg.slice(0, equals) : arg;
      if (equals < 0 && VALUE_OPTIONS.has(name)) {
        consumeNext = true;
      } else if (equals < 0 && !BOOLEAN_OPTIONS.has(name)) {
        consumeNext = true;
      }
      continue;
    }

    // Treat unknown short options as value-taking for safety too.
    consumeNext = true;
  }
  return foundList;
}

export function parseRunnerInvocation(argv) {
  const [head, ...rest] = argv;
  if (head === "--mode=batch") return { batch: true, args: rest };
  if (head === "--mode=refuse") return { batch: false, args: rest };
  return { batch: false, args: argv };
}

export function decideGuiRun({ batch, args, env = {} }) {
  if (batch) return { action: "spawn", optIn: true };
  if (!env.PWTEST_WATCH && !env.PWDEBUG && hasSafeListFlag(args)) return { action: "spawn", optIn: false };
  return { action: "refuse", message: GUI_TEST_REFUSAL_MESSAGE };
}

// --packaged artifact GUI smoke. This is a separate explicit batch route:
// exactly [--package-smoke REQUEST.json], bound to an immutable
// folio.package-evidence-intent.v1 run. It never forwards flags to Playwright
// and never runs in the default refuse/list mode.
export const PACKAGE_SMOKE_FLAG = "--package-smoke";
const PACKAGE_SMOKE_USAGE =
  "--package-smoke requires exactly [--package-smoke REQUEST.json] through the explicit batch entry (npm run test:e2e:batch -- --package-smoke REQUEST.json)";
const PACKAGE_REQUEST_SCHEMA = "folio.package-smoke-request.v1";
const PACKAGE_ATTEMPT_SCHEMA = "folio.package-gui-attempt.v1";
const PACKAGE_GUI_SCHEMA = "folio.package-gui-result.v1";
const BUILD_STAGE_TIMEOUT_MS = 180_000;
const BUILD_CAPTURE_MAX = 8 * 1024 * 1024;
const PROBE_STDOUT_MAX = 16_384;
const PROBE_TIMEOUT_MS = 15_000;
const SAFE_CHILD_ENV_KEYS = [
  "PATH", "SystemRoot", "windir", "PATHEXT", "ComSpec", "HOME", "USER",
  "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
];
const FILE_ID = /^[0-9A-Fa-f]{32}$/;
const VOLUME_ID = /^[0-9A-Fa-f]{16}$/;
const PROBE_KEYS = [
  "canonicalPath", "canonicalRoot", "daclPrivate", "fileId", "linkCount",
  "localFilesystem", "ownerSid", "platform", "reparsePoint", "rootFileId",
  "rootVolumeId", "sid", "volumeId",
];

function smokeRefusal(message) {
  return { code: 1, signal: null, refused: true, message };
}
function smokeSha256File(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 256 * 1024 * 1024)
    throw new Error("PACKAGE_SMOKE_FILE");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function readSmokeJson(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 64 * 1024)
    throw new Error("PACKAGE_SMOKE_REQUEST_FILE");
  const value = JSON.parse(readFileSync(path).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("PACKAGE_SMOKE_REQUEST_SCHEMA");
  return value;
}
function sanitizedChildEnv(source) {
  const env = {};
  for (const key of SAFE_CHILD_ENV_KEYS)
    if (typeof source[key] === "string" && source[key].length > 0)
      env[key] = source[key];
  return env;
}
function foldPath(value) {
  return value.replace(/\//g, "\\").toLowerCase();
}
function canonicalProbePath(value, simulationPaths) {
  if (typeof value !== "string" || value.length < 2) return false;
  if (simulationPaths && value.startsWith("/")) return value === resolve(value);
  if (!/^[A-Z]:\\/.test(value) || /[\/\x00-\x1f\x7f]/.test(value)) return false;
  const parts = value.slice(3).split("\\");
  return parts.every(part => part && part !== "." && part !== ".." &&
    !/[<>:"|?*]/.test(part) && !/[ .]$/.test(part) && !/~\d/.test(part) &&
    !/^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part));
}
function assertProbeEvidence(parsed, expectedPath, expectedRoot, pinned, simulationPaths) {
  const bad = (code) => {
    throw new Error(code);
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      canonical(Object.keys(parsed).sort()) !== canonical(PROBE_KEYS.slice().sort()))
    bad("PACKAGE_SMOKE_PROBE_SCHEMA");
  if (parsed.platform !== "win32" ||
      typeof parsed.sid !== "string" || parsed.sid.length === 0 ||
      parsed.sid !== parsed.ownerSid ||
      parsed.daclPrivate !== true || parsed.reparsePoint !== false ||
      parsed.linkCount !== 1 || parsed.localFilesystem !== true ||
      !FILE_ID.test(parsed.fileId) || !FILE_ID.test(parsed.rootFileId) ||
      !VOLUME_ID.test(parsed.volumeId) || parsed.volumeId !== parsed.rootVolumeId ||
      !canonicalProbePath(parsed.canonicalPath, simulationPaths) ||
      !canonicalProbePath(parsed.canonicalRoot, simulationPaths))
    bad("PACKAGE_SMOKE_PROBE_EVIDENCE");
  const path = foldPath(parsed.canonicalPath), root = foldPath(parsed.canonicalRoot);
  if (path !== root && !path.startsWith(`${root}\\`)) bad("PACKAGE_SMOKE_PROBE_CONTAINMENT");
  if (path !== foldPath(expectedPath) || root !== foldPath(expectedRoot))
    bad("PACKAGE_SMOKE_PROBE_PATH");
  const identity = Object.freeze({
    fileId: parsed.fileId, rootFileId: parsed.rootFileId,
    volumeId: parsed.volumeId, rootVolumeId: parsed.rootVolumeId,
    ownerSid: parsed.ownerSid, canonicalPath: parsed.canonicalPath,
    canonicalRoot: parsed.canonicalRoot,
  });
  if (pinned && canonical(identity) !== canonical(pinned))
    bad("PACKAGE_SMOKE_PROBE_IDENTITY");
  return identity;
}
function windowsHelperPins(manifest) {
  const entries = manifest?.nativeHelpers;
  if (!Array.isArray(entries)) return null;
  const probe = entries.find((entry) => entry?.role === "probe");
  const owned = entries.find((entry) => entry?.role === "owned");
  if (!probe || !owned) return null;
  const outputDir = manifest.plan.outputDir;
  return {
    probe,
    owned,
    probePath: join(outputDir, ...String(probe.resource).split("/")),
    ownedPath: join(outputDir, ...String(owned.resource).split("/")),
  };
}
function defaultBuildStage({ name, command, args, cwd, env, timeoutMs, runRoot }) {
  const result = spawnSync(command, args, {
    cwd, env, shell: false, timeout: timeoutMs, maxBuffer: BUILD_CAPTURE_MAX,
  });
  const stdoutPath = join(runRoot, `build-${name}.stdout`);
  const stderrPath = join(runRoot, `build-${name}.stderr`);
  assertEvidencePath(runRoot, stdoutPath, true);
  assertEvidencePath(runRoot, stderrPath, true);
  writeFileSync(stdoutPath, result.stdout ?? Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  writeFileSync(stderrPath, result.stderr ?? Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  return {
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdoutPath,
    stderrPath,
  };
}
function buildCapture(path, runRoot, name, stream) {
  if (path !== join(runRoot, `build-${name}.${stream}`))
    throw new Error("PACKAGE_SMOKE_BUILD_CAPTURE");
  assertEvidencePath(runRoot, path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > BUILD_CAPTURE_MAX)
    throw new Error("PACKAGE_SMOKE_BUILD_CAPTURE");
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
function defaultProbeRun({ executable, args, timeoutMs, env }) {
  const result = spawnSync(executable, args, {
    env, shell: false, windowsHide: true,
    timeout: timeoutMs, maxBuffer: 64 * 1024,
  });
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
async function runPrivacyProbe(probe, executable, target, root, pinned, capture) {
  const result = await probe({
    executable, args: [target, root], timeoutMs: PROBE_TIMEOUT_MS, env: capture.env,
  });
  const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  const stdout = bytes(result?.stdout), stderr = bytes(result?.stderr);
  const prefix = join(capture.runRoot, `probe-${capture.nextIndex()}`);
  writeFileSync(`${prefix}.stdout`, stdout, { flag: "wx", mode: 0o600 });
  writeFileSync(`${prefix}.stderr`, stderr, { flag: "wx", mode: 0o600 });
  writeFileSync(`${prefix}.json`, JSON.stringify({
    executable, args: [target, root], status: result?.status ?? null,
    signal: result?.signal ?? null, error: result?.error ?? null,
    stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
  }), { flag: "wx", mode: 0o600 });
  if (!result || result.error || result.signal || result.status !== 0 ||
      stdout.length > PROBE_STDOUT_MAX || stderr.length !== 0)
    throw new Error("PACKAGE_SMOKE_PROBE_FAILED");
  let parsed;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch {
    throw new Error("PACKAGE_SMOKE_PROBE_JSON");
  }
  return assertProbeEvidence(parsed, target, root, pinned, capture.simulationPaths);
}

export async function runPackageSmokeBatch({
  batch = false,
  requestPath,
  env = process.env,
  cwd = process.cwd(),
  prepare = prepareGuiOwnedShutdown,
  ports = {},
} = {}) {
  if (batch !== true) return smokeRefusal(PACKAGE_SMOKE_USAGE);
  const {
    verify = verifyPackageArtifacts,
    build = defaultBuildStage,
    probe = defaultProbeRun,
    smoke = runPackagedGuiSmoke,
    prepare: portPrepare,
    launch,
    electron,
    now = () => Date.now(),
    tmpBase = tmpdir(),
  } = ports;
  const host = ports.untrustedTest?.host ??
    { platform: process.platform, arch: process.arch };
  const simulationPaths = process.platform !== "win32" &&
    ports.untrustedTest?.allowPosixProbePaths === true;
  if (env.PWDEBUG || env.PWTEST_WATCH || env.FOLIO_DEV_URL ||
      env.CI === "true" || env.GITHUB_ACTIONS === "true")
    return smokeRefusal("incompatible debug/watch/CI environment for --package-smoke");

  let request;
  try {
    const resolvedRequest = isAbsolute(requestPath) ? requestPath : resolve(cwd, requestPath);
    request = readSmokeJson(resolvedRequest);
  } catch (error) {
    return smokeRefusal(`package smoke request unreadable: ${error?.message ?? error}`);
  }
  if (canonical(Object.keys(request).sort()) !==
        canonical(["schema", "selection", "intentPath", "runId"].sort()) ||
      request.schema !== PACKAGE_REQUEST_SCHEMA ||
      typeof request.intentPath !== "string" || !isAbsolute(request.intentPath) ||
      typeof request.runId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(request.runId))
    return smokeRefusal("invalid folio.package-smoke-request.v1");

  let ctx;
  try {
    ctx = readEvidenceIntent(request.intentPath, { verify, now: now() });
  } catch (error) {
    return smokeRefusal(`intent verification failed: ${error?.message ?? error}`);
  }
  if (ctx.intent.runId !== request.runId ||
      canonical(ctx.intent.selection) !== canonical(request.selection))
    return smokeRefusal("request does not match the bound intent");
  const plan = ctx.manifest.plan;
  const selection = ctx.intent.selection;
  if (host.platform !== plan.platform || host.arch !== plan.arch)
    return smokeRefusal("package smoke requires the selected host platform and arch");

  const attemptPath = join(ctx.runRoot, ATTEMPT_NAME);
  if (existsSync(attemptPath))
    return smokeRefusal("package-gui-attempt already exists; no automatic retry");
  const attempt = {
    schema: PACKAGE_ATTEMPT_SCHEMA,
    runId: ctx.intent.runId,
    nonce: randomUUID(),
    binding: ctx.intent.binding,
    intentSha256: smokeSha256File(ctx.intentPath),
    createdAt: now(),
  };
  assertEvidencePath(ctx.runRoot, attemptPath, true);
  writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  const startedAt = attempt.createdAt;
  const buildCaptures = [];
  const terminal = async ({ status, failure, prepared = null, observation = null,
    smokeObs = null, privateRoots = null }) => {
    const raw = {
      schema: PACKAGE_GUI_SCHEMA,
      runId: ctx.intent.runId,
      binding: ctx.intent.binding,
      intentSha256: attempt.intentSha256,
      attemptSha256: smokeSha256File(attemptPath),
      status,
      monitorRunId: prepared?.request?.runId ?? null,
      workspace: prepared?.workspace ?? null,
      smoke: smokeObs,
      shutdown: observation
        ? { ...observation, monitorRunId: prepared?.request?.runId ?? null }
        : null,
      build: buildCaptures,
      privateRoots,
      failure: failure ?? null,
    };
    const rawPath = join(ctx.runRoot, GUI_RAW_NAME);
    let recordPath = null;
    try {
      assertEvidencePath(ctx.runRoot, rawPath, true);
      writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`,
        { flag: "wx", mode: 0o600 });
      recordPath = recordEvidenceResult({
        intentPath: ctx.intentPath,
        kind: "package-gui",
        startTime: startedAt,
        endTime: now(),
        exitCode: status === "COMPLETED" ? 0 : null,
        signal: null,
        rawPath,
      }, { verify, now: now() }).recordPath;
    } catch {
      // The raw attempt evidence stays retained even when a bound record
      // cannot be written (for example a stale binding); nothing is deleted.
    }
    const completed = status === "COMPLETED" && recordPath !== null;
    return {
      code: completed ? 0 : 1,
      signal: null,
      refused: false,
      observation: status === "UNKNOWN" ? {
        status: "UNKNOWN", code: failure ?? "PACKAGE_SMOKE_FAILED",
        shutdown: observation,
      } : !recordPath ? {
        status: "UNKNOWN", code: "PACKAGE_SMOKE_EVIDENCE_RECORD_MISSING",
      } : observation ?? {
        status: "UNKNOWN",
        code: failure ?? "PACKAGE_SMOKE_FAILED",
      },
      packageEvidenceRecord: recordPath,
    };
  };

  const root = selection.root;
  const buildEnv = sanitizedChildEnv(env);
  const stages = [
    ["tsc", [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]],
    ["vite", [join(root, "node_modules", "vite", "bin", "vite.js"), "build"]],
    ["main", [join(root, "scripts", "build.mjs")]],
  ];
  for (const [name, args] of stages) {
    let stage;
    try {
      stage = await build({
        name, command: process.execPath, args, cwd: root,
        env: buildEnv, timeoutMs: BUILD_STAGE_TIMEOUT_MS, runRoot: ctx.runRoot,
      });
    } catch (error) {
      return terminal({ status: "UNKNOWN",
        failure: `PACKAGE_SMOKE_BUILD_FAILED: ${error?.message ?? error}` });
    }
    const captured = {
      name,
      command: process.execPath,
      args,
      exitCode: stage?.exitCode ?? null,
      signal: stage?.signal ?? null,
      error: stage?.error ?? null,
      stdoutPath: stage?.stdoutPath ?? null,
      stderrPath: stage?.stderrPath ?? null,
    };
    buildCaptures.push(captured);
    if (stage?.error || stage?.signal || stage?.exitCode !== 0)
      return terminal({ status: "UNKNOWN", failure: `PACKAGE_SMOKE_BUILD_FAILED:${name}` });
    try {
      captured.stdout = buildCapture(stage.stdoutPath, ctx.runRoot, name, "stdout");
      captured.stderr = buildCapture(stage.stderrPath, ctx.runRoot, name, "stderr");
    } catch (error) {
      return terminal({ status: "UNKNOWN", failure: error.message });
    }
  }

  try {
    ctx = readEvidenceIntent(ctx.intentPath, { verify, now: now() });
  } catch (error) {
    return terminal({ status: "UNKNOWN",
      failure: `PACKAGE_SMOKE_STALE: ${error?.message ?? error}` });
  }

  const childEnv = sanitizedChildEnv(env);
  const helpers = windowsHelperPins(ctx.manifest);
  if (plan.platform === "win32") {
    if (!helpers)
      return terminal({ status: "UNKNOWN", failure: "PACKAGE_SMOKE_HELPERS_MISSING" });
    Object.assign(childEnv, {
      FOLIO_WINDOWS_NATIVE_PROBE: helpers.probePath,
      FOLIO_WINDOWS_NATIVE_SHA256: helpers.probe.sha256,
      FOLIO_WINDOWS_OWNED_HELPER: helpers.ownedPath,
      FOLIO_WINDOWS_OWNED_HELPER_SHA256: helpers.owned.sha256,
    });
  }
  let prepared;
  try {
    prepared = await (portPrepare ?? prepare)({ env: childEnv, cwd: root });
  } catch (error) {
    return terminal({ status: "UNKNOWN",
      failure: `PACKAGE_SMOKE_PREPARE: ${error?.message ?? error}` });
  }
  const vault = join(prepared.runRoot, "vault");
  try {
    const base = realpathSync(tmpBase), run = realpathSync(prepared.runRoot);
    const within = (parent, child) => {
      const rel = relative(parent, child);
      return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    };
    if (!within(base, run) ||
        !within(run, realpathSync(prepared.workspace)) ||
        lstatSync(prepared.runRoot).isSymbolicLink() ||
        lstatSync(prepared.workspace).isSymbolicLink())
      throw new Error("PACKAGE_SMOKE_PRIVATE_CONTAINMENT");
    mkdirSync(vault, { mode: 0o700 });
  } catch (error) {
    return terminal({ status: "UNKNOWN",
      failure: `PACKAGE_SMOKE_PRIVATE: ${error?.message ?? error}`, prepared });
  }
  const privateEnv = {
    ...prepared.env,
    // This route is reached only through batch===true with the exact
    // --package-smoke form; the retained smoke's own gate still requires the
    // explicit opt-in inside the child env.
    [GUI_TEST_OPT_IN_ENV]: GUI_TEST_OPT_IN_VALUE,
    FOLIO_SYNC_ENABLED: "0",
    FOLIO_CREDENTIAL_DIR: vault,
  };
  let stateRoot = null;
  let ledger = null;
  if (plan.platform === "win32") {
    try {
      stateRoot = mkdtempSync(join(realpathSync(tmpBase), "folio-pub-state-"));
      ledger = join(stateRoot, "ledger");
      mkdirSync(ledger, { mode: 0o700 });
    } catch (error) {
      return terminal({ status: "UNKNOWN",
        failure: `PACKAGE_SMOKE_PRIVATE: ${error?.message ?? error}`, prepared });
    }
    privateEnv.FOLIO_WINDOWS_NATIVE_ROOT = prepared.runRoot;
    privateEnv.FOLIO_WINDOWS_PUBLICATION_STATE_ROOT = stateRoot;
    privateEnv.FOLIO_WINDOWS_PUBLICATION_STATE_DIR = ledger;
  }

  const privateRoots = {};
  const revalidateHelpers = () => {
    if (plan.platform !== "win32") return;
    for (const [path, sha] of [
      [helpers.probePath, helpers.probe.sha256],
      [helpers.ownedPath, helpers.owned.sha256],
    ]) {
      if (smokeSha256File(path) !== sha)
        throw new Error("PACKAGE_SMOKE_HELPER_CHANGED");
    }
  };
  let probeIndex = 0;
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const probeCapture = {
    runRoot: ctx.runRoot, simulationPaths, nextIndex: () => ++probeIndex,
    env: {
      SystemRoot: systemRoot, windir: systemRoot,
      TEMP: `${systemRoot}\\Temp`, TMP: `${systemRoot}\\Temp`,
    },
  };
  const privacyProbe = async (target, root, pinned) => {
    revalidateHelpers();
    return runPrivacyProbe(probe, helpers.probePath, target, root, pinned, probeCapture);
  };
  const posixTargets = [
    ["runRoot", prepared.runRoot],
    ["workspace", prepared.workspace],
    ["vault", vault],
  ];
  const probeTargets = plan.platform === "win32"
    ? [
        ["runRoot", prepared.runRoot, prepared.runRoot],
        ["workspace", prepared.workspace, prepared.runRoot],
        ["vault", vault, prepared.runRoot],
        ["stateRoot", stateRoot, stateRoot],
        ["ledger", ledger, stateRoot],
      ]
    : [];
  try {
    if (plan.platform === "win32") {
      for (const [label, target, probeRoot] of probeTargets)
        privateRoots[label] = await privacyProbe(target, probeRoot);
    } else {
      for (const [label, target] of posixTargets) {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isDirectory() ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
            (stat.mode & 0o077) !== 0)
          throw new Error(`PACKAGE_SMOKE_PRIVATE:${label}`);
        privateRoots[label] = { path: realpathSync(target), uid: stat.uid,
          dev: stat.dev, ino: stat.ino };
      }
    }
  } catch (error) {
    return terminal({ status: "UNKNOWN",
      failure: `${error?.message ?? error}`, prepared, privateRoots });
  }

  const revalidateRoots = async () => {
    if (plan.platform === "win32") {
      for (const [label, target, probeRoot] of probeTargets)
        await privacyProbe(target, probeRoot, privateRoots[label]);
      return;
    }
    for (const [label, target] of posixTargets) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory() ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
          (stat.mode & 0o077) !== 0 ||
          stat.dev !== privateRoots[label].dev || stat.ino !== privateRoots[label].ino ||
          realpathSync(target) !== privateRoots[label].path)
        throw new Error(`PACKAGE_SMOKE_PRIVATE:${label}`);
    }
  };

  try {
    revalidateHelpers();
    await revalidateRoots();
  } catch (error) {
    return terminal({ status: "UNKNOWN",
      failure: `${error?.message ?? error}`, prepared, privateRoots });
  }

  const guardedLaunch = async (options) => {
    readEvidenceIntent(ctx.intentPath, { verify, now: now() });
    revalidateHelpers();
    await revalidateRoots();
    const electronModule = electron ??
      (launch ? undefined : (await import("@playwright/test"))._electron);
    const launchImpl = launch ?? ((options) => electronModule.launch(options));
    return launchImpl({
      ...options,
      env: {
        ...privateEnv,
        FOLIO_DATA_DIR: prepared.workspace,
        FOLIO_CREDENTIAL_DIR: vault,
        ...(stateRoot
          ? {
              FOLIO_WINDOWS_NATIVE_ROOT: prepared.runRoot,
              FOLIO_WINDOWS_PUBLICATION_STATE_ROOT: stateRoot,
              FOLIO_WINDOWS_PUBLICATION_STATE_DIR: ledger,
            }
          : {}),
      },
    });
  };

  let smokeObs;
  try {
    smokeObs = await smoke(
      { selection, batch: true, env: privateEnv },
      { launch: guardedLaunch },
    );
  } catch (error) {
    let observation = null;
    try {
      observation = await prepared.finish();
    } catch {
      observation = null;
    }
    return terminal({ status: "UNKNOWN",
      failure: `PACKAGE_SMOKE_DISPATCH: ${error?.message ?? error}`,
      prepared, observation, privateRoots });
  }
  let observation;
  try {
    observation = await prepared.finish();
  } catch {
    observation = null;
  }

  let postFailure = null;
  try {
    ctx = readEvidenceIntent(ctx.intentPath, { verify, now: now() });
    revalidateHelpers();
    await revalidateRoots();
    const expectedExe = join(
      plan.outputDir,
      plan.platform === "darwin" ? "Folio.app/Contents/MacOS/Folio" : "Folio.exe",
    );
    if (!smokeObs || smokeObs.ok !== true || smokeObs.persistence !== true ||
        smokeObs.artifactHash !== ctx.intent.binding.artifactSha256 ||
        smokeObs.platform !== plan.platform || smokeObs.arch !== plan.arch ||
        smokeObs.executablePath !== expectedExe)
      throw new Error("PACKAGE_SMOKE_OBSERVATION");
    if (!observation || observation.status !== "COMPLETED" ||
        observation.runId !== prepared.request.runId ||
        observation.scope !== "PIPE_CLOSED_AFTER_ACCEPTED_QUIT" ||
        observation.code !== "PIPE_CLOSED_AFTER_ACCEPTED_QUIT" ||
        !Array.isArray(observation.sessions) || observation.sessions.length < 1 ||
        observation.sessions.some(session => session?.status !== "COMPLETED"))
      throw new Error("PACKAGE_SMOKE_RECEIPTS");
  } catch (error) {
    postFailure = error?.message ?? error;
  }
  return terminal({
    status: postFailure ? "UNKNOWN" : "COMPLETED",
    failure: postFailure,
    prepared,
    observation,
    smokeObs,
    privateRoots,
  });
}

function resolvePlaywrightCli() {
  const require = createRequire(import.meta.url);
  for (const specifier of ["@playwright/test/cli", "@playwright/test"]) {
    try {
      const resolved = require.resolve(specifier);
      if (resolved.endsWith("cli.js")) return resolved;
      return join(dirname(resolved), "cli.js");
    } catch {
      // Try the next resolution strategy.
    }
  }
  return join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
}

export function buildPlaywrightInvocation(
  args,
  { cliPath = resolvePlaywrightCli(), execPath = process.execPath } = {},
) {
  return { command: execPath, args: [cliPath, "test", ...args] };
}

export async function runGuiTests({
  batch = false,
  args = [],
  env = process.env,
  spawn = nodeSpawn,
  cliPath,
  cwd = process.cwd(),
  forwardSignals = true,
  prepare = prepareGuiOwnedShutdown,
  packagePorts = {},
} = {}) {
  // Packaged-artifact smoke is a separate batch-only route recognized only as
  // exactly [--package-smoke REQUEST.json]. Every other placement, form,
  // duplicate or combination (including --owned-shutdown and the remote plan)
  // refuses; it never reaches the Playwright/remote ordinary path below.
  if (args.some((arg) => arg.startsWith(PACKAGE_SMOKE_FLAG))) {
    if (!batch || args.length !== 2 || args[0] !== PACKAGE_SMOKE_FLAG)
      return { code: 1, signal: null, refused: true, message: PACKAGE_SMOKE_USAGE };
    return runPackageSmokeBatch({
      batch: true,
      requestPath: args[1],
      env,
      cwd,
      prepare,
      ports: packagePorts,
    });
  }
  // The owned-shutdown monitor is a batch-only wrapper: exactly one
  // --owned-shutdown token is stripped before Playwright sees the argv. It is
  // refused under the default refuse/list mode and can never activate via
  // --list or a direct CLI invocation.
  const flagIndex = args.indexOf(OWNED_SHUTDOWN_FLAG);
  const ownedRequested = flagIndex >= 0;
  // Duplicate flags are a malformed request, never silently stripped twice.
  if (ownedRequested && args.lastIndexOf(OWNED_SHUTDOWN_FLAG) !== flagIndex)
    return {
      refused: true,
      code: 1,
      message: "--owned-shutdown may be passed at most once",
    };
  if (ownedRequested && !batch) {
    return {
      code: 1,
      signal: null,
      refused: true,
      message:
        "--owned-shutdown is allowed only through the explicit batch entry (npm run test:e2e:batch -- --owned-shutdown)",
    };
  }
  const forwardedArgs = ownedRequested
    ? args.slice(0, flagIndex).concat(args.slice(flagIndex + 1))
    : args;

  const decision = decideGuiRun({ batch, args: forwardedArgs, env });
  if (decision.action === "refuse") {
    return { code: 1, signal: null, refused: true, message: decision.message };
  }

  const childEnv = { ...env };
  if (decision.optIn) childEnv[GUI_TEST_OPT_IN_ENV] = GUI_TEST_OPT_IN_VALUE;
  else delete childEnv[GUI_TEST_OPT_IN_ENV];
  // Remote supervision is reachable only through the existing explicit batch
  // entry. It has its own live host guard and accepts no extra Playwright args.
  if (forwardedArgs.some((arg) => /^--mac-acceptance-plan(?:=|$)/.test(arg))) {
    if (ownedRequested)
      return {
        code: 1,
        signal: null,
        refused: true,
        message:
          "--owned-shutdown cannot be combined with the remote Mac acceptance plan",
      };
    if (
      !batch ||
      forwardedArgs.length !== 2 ||
      forwardedArgs[0] !== "--mac-acceptance-plan" ||
      typeof forwardedArgs[1] !== "string" ||
      !forwardedArgs[1]
    )
      return {
        code: 1,
        signal: null,
        refused: true,
        message:
          "Remote Mac acceptance requires only --mac-acceptance-plan PATH through the batch entry",
      };
    const { runRemoteMacBatch } =
      await import("./mac-acceptance/remote-batch.mjs");
    return runRemoteMacBatch({
      planPath: forwardedArgs[1],
      cwd,
      env: childEnv,
      forwardSignals,
    });
  }
  const invocation = buildPlaywrightInvocation(forwardedArgs, { cliPath });

  // Prepare the owned-shutdown environment before any GUI launch: a fresh
  // private runRoot + disposable FOLIO_DATA_DIR + the frozen request JSON.
  // A failed preparation (e.g. missing pinned Windows helper config) refuses
  // before the Playwright child is spawned.
  let prepared = null;
  if (ownedRequested) {
    try {
      prepared = await prepare({ env: childEnv, cwd });
    } catch (error) {
      return {
        code: 1,
        signal: null,
        refused: true,
        message: `Owned shutdown preparation failed: ${error?.message ?? error}`,
      };
    }
  }
  const spawnEnv = prepared ? prepared.env : childEnv;

  return await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: spawnEnv,
        stdio: "inherit",
        shell: false,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let settled = false;
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!prepared) {
        resolvePromise({ code, signal, refused: false });
        return;
      }
      // Receipts are awaited only after the real Playwright child's "close"
      // (stdio fully drained), never at "exit". A missing or malformed
      // observation is retained as UNKNOWN and never treated as success.
      Promise.resolve()
        .then(() => prepared.finish())
        .then((observation) => {
          const unresolved =
            !observation || observation.status !== "COMPLETED";
          resolvePromise({
            code: code === 0 && !signal && unresolved ? 1 : code,
            signal,
            refused: false,
            observation,
          });
        })
        .catch((error) => {
          resolvePromise({
            code: code === 0 && !signal ? 1 : code,
            signal,
            refused: false,
            observation: {
              status: "UNKNOWN",
              code: "OBSERVATION_FAILED",
              reason: String(error?.message ?? error),
            },
          });
        });
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    });
    child.once(prepared ? "close" : "exit", finish);

    if (forwardSignals) {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const handler = () => child.kill(signal);
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
  });
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = nodeSpawn,
  cliPath,
  cwd = process.cwd(),
} = {}) {
  const { batch, args } = parseRunnerInvocation(argv);
  const result = await runGuiTests({ batch, args, env, spawn, cliPath, cwd });

  if (result.refused) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 1;
    return result;
  }
  if (result.observation && result.observation.status !== "COMPLETED") {
    process.stderr.write(
      `owned-shutdown observation: ${JSON.stringify(result.observation)}\n`,
    );
  }
  if (result.signal) {
    // Re-raise the child's signal so callers see the same termination cause.
    process.kill(process.pid, result.signal);
    return result;
  }
  process.exitCode = result.code ?? 1;
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
