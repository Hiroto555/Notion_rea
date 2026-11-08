import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  chmodSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { assertPrivateTempDirectory } from "../policy/guard.mjs";
import { bindingSchema } from "../policy/schema.mjs";

const phases = new Set(["ready", "blocking", "descendant-ready"]);
const limits = {
  timeoutMs: [100, 900000],
  graceMs: [10, 10000],
  maxOutputBytes: [1024, 1024 * 1024],
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function save(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertPath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error(`${label} must be an absolute path`);
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL`);
  return value;
}

// Low-level supervisor for a process this call spawns itself. There is no CLI,
// no arbitrary PID attach and no command string: only the supplied absolute
// executable/argv are launched in a new owned process group. This module is not
// an authorization boundary; remote callers must run the host guard first.
export async function superviseOwnedProcess({
  executable,
  args,
  cwd,
  env,
  outputParent,
  temporaryParent,
  timeoutMs = 1000,
  graceMs = 100,
  maxOutputBytes = 1048576,
  signal,
  observationKind = "NODE_SYNTHETIC",
  binding,
} = {}) {
  if (
    process.release.name !== "node" ||
    process.versions.electron ||
    process.platform === "win32"
  )
    throw new Error("Node on a POSIX host required; Electron is forbidden");
  assertPath(executable, "executable");
  if (!Array.isArray(args))
    throw new Error("args must be an explicit array of strings");
  for (const arg of args) {
    if (typeof arg !== "string")
      throw new Error("args must be an explicit array of strings");
    if (arg.includes("\0")) throw new Error("args must not contain NUL");
  }
  assertPath(cwd, "cwd");
  if (env === null || typeof env !== "object" || Array.isArray(env))
    throw new Error("env must be an explicit object of string values");
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.includes("=") ||
      key.includes("\0")
    )
      throw new Error("env must be an explicit object of string values");
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error("env must be an explicit object of string values");
    childEnv[key] = value;
  }
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new Error("An AbortSignal is required");
  for (const [name, value] of Object.entries({
    timeoutMs,
    graceMs,
    maxOutputBytes,
  })) {
    const [min, max] = limits[name];
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`Invalid bounded ${name}`);
  }
  if (!["NODE_SYNTHETIC", "MAC_REMOTE"].includes(observationKind))
    throw new Error("Invalid observationKind");
  let ownedBinding = null;
  if (binding !== undefined && binding !== null) {
    const parsed = bindingSchema.safeParse(binding);
    if (!parsed.success) throw new Error("Invalid watchdog binding");
    ownedBinding = Object.freeze(parsed.data);
  }
  if (observationKind === "MAC_REMOTE" && !ownedBinding)
    throw new Error("Remote watchdog requires a plan binding");
  assertPath(outputParent, "outputParent");
  if (temporaryParent !== undefined)
    assertPath(temporaryParent, "temporaryParent");
  if (signal?.aborted)
    throw new Error("Probe already aborted; no process started");
  // The guarded remote caller supplies the registered runner's temporary
  // parent, which need not be os.tmpdir(). Ordinary Node probes keep the default.
  const parent = assertPrivateTempDirectory(outputParent, temporaryParent);
  const root = mkdtempSync(join(parent, "owned-watchdog-"));
  chmodSync(root, 0o700);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  save(join(root, "started.json"), {
    schemaVersion: 1,
    observationKind,
    runId,
    startedAt,
    binding: ownedBinding,
  });
  const stdoutHash = createHash("sha256"),
    stderrHash = createHash("sha256");
  let stdoutBytes = 0,
    stderrBytes = 0;
  let outcome = null,
    expired = false,
    lastPhase = null,
    descendantPid = null;
  let childExit = null,
    exitSignal = null,
    exited = false,
    spawnError = false;
  const signals = [];
  const child = spawn(executable, args.slice(), {
    cwd,
    env: childEnv,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const pid = child.pid ?? null;
  const owned = Number.isInteger(pid) && pid > 1 && pid !== process.pid;
  const alive = () => {
    if (!owned) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return error.code !== "ESRCH";
    }
  };
  const stop = (sig) => {
    if (!owned || !alive()) return;
    try {
      process.kill(-pid, sig);
      signals.push(sig);
    } catch (error) {
      if (error.code !== "ESRCH") outcome = "CLEANUP_FAILED";
    }
  };
  let wake;
  const changed = new Promise((resolve) => {
    wake = resolve;
  });
  const terminate = (why) => {
    if (!outcome) {
      outcome = why;
      wake();
    }
  };
  const abort = () => terminate("ABORTED");
  signal?.addEventListener("abort", abort, { once: true });
  // Handle an abort between the preflight check and listener registration.
  if (signal?.aborted) abort();
  child.once("error", () => {
    spawnError = true;
    terminate("SPAWN_FAILED");
  });
  child.once("exit", (code, sig) => {
    exited = true;
    childExit = code;
    exitSignal = sig;
    terminate(code === 0 && !sig ? "COMPLETED" : "PROCESS_FAILED");
  });
  child.on("message", (msg) => {
    if (msg && phases.has(msg.phase)) lastPhase = msg.phase;
    if (
      msg?.phase === "descendant-ready" &&
      Number.isInteger(msg.descendantPid) &&
      msg.descendantPid > 1 &&
      msg.descendantPid !== process.pid
    )
      descendantPid = msg.descendantPid; // Observation only; never a kill target.
  });
  let stdoutClosed = false,
    stderrClosed = false,
    pipeFailed = false;
  child.stdout.on("data", (bytes) => {
    stdoutBytes += bytes.length;
    stdoutHash.update(bytes);
    if (stdoutBytes + stderrBytes > maxOutputBytes) terminate("OUTPUT_LIMIT");
  });
  child.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
    stderrHash.update(bytes);
    if (stdoutBytes + stderrBytes > maxOutputBytes) terminate("OUTPUT_LIMIT");
  });
  child.stdout.once("end", () => {
    stdoutClosed = true;
  });
  child.stdout.once("close", () => {
    stdoutClosed = true;
  });
  child.stderr.once("end", () => {
    stderrClosed = true;
  });
  child.stderr.once("close", () => {
    stderrClosed = true;
  });
  child.stdout.on("error", () => {
    pipeFailed = true;
    stdoutClosed = true;
    terminate("PROCESS_FAILED");
  });
  child.stderr.on("error", () => {
    pipeFailed = true;
    stderrClosed = true;
    terminate("PROCESS_FAILED");
  });
  const deadline = setTimeout(() => {
    expired = true;
    terminate("TIMED_OUT");
  }, timeoutMs);
  let cleanupConfirmed = false;
  try {
    await changed;
    clearTimeout(deadline);
    // Helpers can naturally exit just after the parent. Bound this drain
    // interval before classifying a still-live group as a leftover.
    if (outcome === "COMPLETED" && alive()) {
      const settleEnd = performance.now() + graceMs;
      while (alive() && performance.now() < settleEnd) await pause(10);
    }
    if (outcome === "COMPLETED" && alive()) outcome = "DESCENDANTS_LEFT";
    if (outcome !== "COMPLETED" || alive()) {
      // Persist last known state before attempting termination. Neither stream
      // contents, argv, environment nor arbitrary IPC payloads are stored.
      save(join(root, "interrupted.json"), {
        runId,
        outcome,
        expired,
        pid,
        descendantPid,
        lastPhase,
        binding: ownedBinding,
      });
      stop("SIGTERM");
      const graceEnd = performance.now() + graceMs;
      while (alive() && performance.now() < graceEnd) await pause(10);
      stop("SIGKILL");
    }
    const cleanupEnd = performance.now() + 2000;
    while (
      (alive() || (!exited && !spawnError)) &&
      performance.now() < cleanupEnd
    )
      await pause(10);
    cleanupConfirmed = !alive() && (exited || spawnError);
    if (!cleanupConfirmed) outcome = "CLEANUP_FAILED";
    // Exit can precede pipe closure; wait a bounded interval for hashes to
    // include the remaining bytes. A retained pipe is not a clean completion.
    const pipeEnd = performance.now() + 200;
    while (
      !spawnError &&
      (!stdoutClosed || !stderrClosed) &&
      performance.now() < pipeEnd
    )
      await pause(5);
    if (!spawnError && (!stdoutClosed || !stderrClosed)) {
      outcome = "CLEANUP_FAILED";
      cleanupConfirmed = false;
    }
    if (pipeFailed && outcome === "COMPLETED") outcome = "PROCESS_FAILED";
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    // A metadata write failure must not leave our group running. Confirm the
    // forced stop with a bounded wait so a thrown metadata error cannot race a
    // still-live owned process group.
    if (alive()) {
      stop("SIGKILL");
      const forcedEnd = performance.now() + 2000;
      while (alive() && performance.now() < forcedEnd) await pause(10);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.connected) child.disconnect();
  }
  const result = {
    schemaVersion: 1,
    observationKind,
    productResult: "NOT_RUN",
    runId,
    binding: ownedBinding,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    timeoutMs,
    graceMs,
    maxOutputBytes,
    pid,
    descendantPid,
    lastPhase,
    outcome,
    expired,
    cleanupConfirmed,
    exitCode: childExit,
    exitSignal,
    signals,
    disposition: outcome === "COMPLETED" ? "NOT_RUN" : "UNRESOLVED",
    stdout: { bytes: stdoutBytes, sha256: stdoutHash.digest("hex") },
    stderr: { bytes: stderrBytes, sha256: stderrHash.digest("hex") },
    stack: "NOT_COLLECTED",
  };
  save(join(root, "watchdog.json"), result);
  return { root, result };
}
