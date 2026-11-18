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
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { assertPrivateTempDirectory } from "../policy/guard.mjs";

const scenarios = new Set([
  "normal",
  "nonzero",
  "hang",
  "ignore-term",
  "block",
  "descendant-hang",
  "orphan",
  "output-limit",
]);
const phases = new Set(["ready", "blocking", "descendant-ready"]);
const worker = fileURLToPath(new URL("node-probe-worker.mjs", import.meta.url));
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

// MAC-P04's quiet proof of external supervision. Only the fixed Node worker
// above can be spawned; there is intentionally no command/PID/GUI CLI. The
// remote Electron/batch connection belongs to the later MAC-P05 scope.
export async function runNodeProbe({
  scenario,
  outputParent,
  timeoutMs = 1000,
  graceMs = 100,
  maxOutputBytes = 1024 * 1024,
  signal,
}) {
  if (
    process.release.name !== "node" ||
    process.versions.electron ||
    process.platform === "win32"
  )
    throw new Error("Node on a POSIX host required; Electron is forbidden");
  if (!scenarios.has(scenario)) throw new Error("Unknown fixed Node scenario");
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new Error("An AbortSignal is required");
  for (const [value, min, max] of [
    [timeoutMs, 100, 900000],
    [graceMs, 10, 10000],
    [maxOutputBytes, 1024, 1024 * 1024],
  ])
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error("Invalid bounded watchdog limit");
  if (signal?.aborted)
    throw new Error("Probe already aborted; no process started");
  const parent = assertPrivateTempDirectory(outputParent);
  const root = mkdtempSync(join(parent, "node-watchdog-"));
  chmodSync(root, 0o700);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  save(join(root, "started.json"), {
    schemaVersion: 1,
    observationKind: "NODE_SYNTHETIC",
    runId,
    startedAt,
    scenario,
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
  const child = spawn(process.execPath, [worker, scenario], {
    cwd: root,
    env: { TMPDIR: root },
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
  child.stdout.on("error", () => terminate("PROCESS_FAILED"));
  child.stderr.on("error", () => terminate("PROCESS_FAILED"));
  const deadline = setTimeout(() => {
    expired = true;
    terminate("TIMED_OUT");
  }, timeoutMs);
  let cleanupConfirmed = false;
  try {
    await changed;
    clearTimeout(deadline);
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
      (!child.stdout.readableEnded || !child.stderr.readableEnded) &&
      performance.now() < pipeEnd
    )
      await pause(5);
    if (!child.stdout.readableEnded || !child.stderr.readableEnded) {
      outcome = "CLEANUP_FAILED";
      cleanupConfirmed = false;
    }
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    // A metadata write failure must not leave our group running.
    if (alive()) stop("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.connected) child.disconnect();
  }
  const result = {
    schemaVersion: 1,
    observationKind: "NODE_SYNTHETIC",
    productResult: "NOT_RUN",
    runId,
    scenario,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    timeoutMs,
    graceMs,
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
