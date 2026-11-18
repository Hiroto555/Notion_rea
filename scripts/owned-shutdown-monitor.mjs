// Owned shutdown monitor: the fixed, no-argument Node worker source.
// This module exports the source text only; importing it has no side effects
// and there is no CLI entry point. The parent writes the source with `wx`
// into a private session root and executes `node <fixedScript>` (zero script
// arguments). The worker validates its own identity, the nonce-bound init
// intent and the on-disk immutable intent, then waits for an accepted-quit
// notification followed by owner stdin EOF. It never launches processes,
// attaches to PIDs or kills anything; it only persists bounded receipts.
export const OWNED_SHUTDOWN_MONITOR_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_STDIN_LINE = 4096;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300000;
const RECEIPT_SCOPE = "PIPE_CLOSED_AFTER_ACCEPTED_QUIT";
const LABEL = /^[a-zA-Z0-9._-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;

if (process.argv.length !== 2) {
  process.stderr.write("owned-shutdown monitor takes no arguments\n");
  process.exit(2);
}

// Own location is derived from the real script file, never from TMPDIR: the
// parent pins child TMP/TEMP/TMPDIR to this directory, so tmpdir() cannot be
// trusted for containment. Containment is checked against the immutable
// on-disk intent and the approved temporary parent from the init wire intent.
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const scriptDir = dirname(scriptPath);

const strictChild = (parent, child) => {
  const rel = relative(parent, child);
  return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
};

const saveImmutable = (name, payload) => {
  const target = join(scriptDir, name);
  const fd = openSync(target, "wx", 0o600);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const pending = [];
let pendingBytes = 0;
let totalBytes = 0;
let rawTruncated = false;
let malformed = false;
let accepted = null;
let init = null;
let done = false;

const recordChunk = (chunk) => {
  totalBytes += chunk.length;
  if (pendingBytes + chunk.length > MAX_STDIN_BYTES) {
    const room = MAX_STDIN_BYTES - pendingBytes;
    if (room > 0) pending.push(chunk.subarray(0, room));
    pendingBytes = MAX_STDIN_BYTES;
    rawTruncated = true;
    malformed = true;
    return;
  }
  pending.push(chunk);
  pendingBytes += chunk.length;
};

const exactKeys = (value, keys) => {
  const found = Object.keys(value).sort();
  return (
    found.length === keys.length &&
    found.every((key, index) => key === keys[index])
  );
};

const readOnDiskIntent = () => {
  try {
    const value = JSON.parse(readFileSync(join(scriptDir, "intent.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
};

const intentMatches = (wire, disk) =>
  disk !== null &&
  exactKeys(disk, [
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
  ]) &&
  disk.v === 1 &&
  disk.type === "init" &&
  disk.runId === wire.runId &&
  disk.sessionId === wire.sessionId &&
  disk.nonce === wire.nonce &&
  disk.runRoot === wire.runRoot &&
  disk.approvedTempParent === wire.approvedTempParent &&
  disk.tempRoot === wire.tempRoot &&
  disk.scriptHash === wire.scriptHash &&
  disk.timeoutMs === wire.timeoutMs;

const validateInit = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    !exactKeys(value, [
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
    ]) ||
    value.v !== 1 ||
    value.type !== "init" ||
    !LABEL.test(value.runId) ||
    !LABEL.test(value.sessionId) ||
    !LABEL.test(value.nonce) ||
    !HASH.test(value.scriptHash) ||
    typeof value.tempRoot !== "string" ||
    !isAbsolute(value.tempRoot) ||
    typeof value.runRoot !== "string" ||
    !isAbsolute(value.runRoot) ||
    typeof value.approvedTempParent !== "string" ||
    !isAbsolute(value.approvedTempParent) ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < MIN_TIMEOUT_MS ||
    value.timeoutMs > MAX_TIMEOUT_MS
  )
    return "INIT_SCHEMA";
  // Own script must live directly inside the declared session root, which must
  // sit strictly inside the declared run root, itself strictly inside the
  // approved temporary parent. None of these come from child-overridable env.
  let runRoot;
  let approved;
  try {
    if (scriptDir !== realpathSync(value.tempRoot)) return "INIT_ROOT";
    runRoot = realpathSync(value.runRoot);
    approved = realpathSync(value.approvedTempParent);
  } catch {
    return "INIT_ROOT";
  }
  if (!strictChild(runRoot, scriptDir)) return "INIT_ROOT";
  if (!strictChild(approved, runRoot)) return "INIT_ROOT";
  if (!intentMatches(value, readOnDiskIntent())) return "INIT_INTENT";
  const actualHash = createHash("sha256")
    .update(readFileSync(scriptPath))
    .digest("hex");
  if (actualHash !== value.scriptHash) return "INIT_SCRIPT_HASH";
  return null;
};

const validateAccepted = (value) =>
  value &&
  typeof value === "object" &&
  exactKeys(value, ["nonce", "runId", "sessionId", "type", "v"]) &&
  value.v === 1 &&
  value.type === "accepted-quit" &&
  value.runId === init.runId &&
  value.sessionId === init.sessionId &&
  value.nonce === init.nonce;

const decoder = new TextDecoder("utf-8", { fatal: true });
let textPending = "";

const handleLine = (line) => {
  if (malformed) return;
  // Any further message after the accepted-quit notification is a protocol
  // violation (including a helper relay-error marker): never COMPLETED.
  if (accepted) {
    malformed = true;
    return;
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    malformed = true;
    return;
  }
  if (!init) {
    const code = validateInit(value);
    if (code !== null) fail(code, 1);
    init = value;
    timer = setTimeout(() => {
      if (!done) finish("TIMED_OUT", "DEADLINE");
    }, init.timeoutMs);
    timer.unref();
    return;
  }
  if (validateAccepted(value)) {
    accepted = value;
    return;
  }
  malformed = true;
};

const processChunk = (chunk) => {
  recordChunk(chunk);
  let decoded;
  try {
    decoded = decoder.decode(chunk, { stream: true });
  } catch {
    malformed = true;
    return;
  }
  textPending += decoded;
  if (malformed) return;
  let index;
  while ((index = textPending.indexOf("\n")) >= 0) {
    const line = textPending.slice(0, index);
    textPending = textPending.slice(index + 1);
    if (line.length === 0) continue;
    if (line.length > MAX_STDIN_LINE) {
      malformed = true;
      return;
    }
    handleLine(line);
    if (malformed || accepted) break;
  }
  if (!malformed && !accepted && textPending.length > MAX_STDIN_LINE)
    malformed = true;
};

let timer = null;

function fail(code, exitCode) {
  // init may be absent; persist the raw evidence we saw, then reject.
  finishRaw();
  process.stderr.write("owned-shutdown monitor rejected: " + code + "\n");
  process.exit(exitCode);
}

let rawSaved = false;
let rawSha256 = null;
function finishRaw() {
  const raw = Buffer.concat(pending, pendingBytes);
  try {
    saveImmutable("stdin-raw.bin", raw);
    rawSaved = true;
    rawSha256 = createHash("sha256").update(raw).digest("hex");
  } catch {
    rawSaved = false;
    rawSha256 = null;
  }
}

function finish(status, code) {
  if (done) return;
  done = true;
  if (timer) clearTimeout(timer);
  finishRaw();
  // Raw evidence is part of the receipt contract: a raw save failure can
  // never become a completed observation.
  if (!rawSaved && status === "COMPLETED") {
    status = "UNKNOWN";
    code = "RAW_SAVE_FAILED";
  }
  const receipt = {
    v: 1,
    status,
    code,
    scope: RECEIPT_SCOPE,
    runId: init?.runId ?? null,
    sessionId: init?.sessionId ?? null,
    nonce: init?.nonce ?? null,
    timeoutMs: init?.timeoutMs ?? null,
    acceptedQuitSeen: accepted !== null,
    malformed,
    rawSaved,
    rawTruncated,
    rawSha256,
    rawBytes: totalBytes,
    productResult: "NOT_RUN",
    physical: "NOT_RUN",
  };
  try {
    saveImmutable("receipt.json", JSON.stringify(receipt));
  } catch {
    // Retained raw remains; the collector treats a missing receipt as
    // missing evidence, never success.
  }
  process.exit(
    receipt.status === "COMPLETED" ? 0 : receipt.status === "TIMED_OUT" ? 3 : 1,
  );
}

process.stdin.on("data", processChunk);
process.stdin.on("error", () => {
  malformed = true;
});
process.stdin.on("end", () => {
  if (done) return;
  try {
    // A truncated UTF-8 sequence at EOF is malformed input.
    const tail = decoder.decode();
    if (tail.length > 0) malformed = true;
  } catch {
    malformed = true;
  }
  if (textPending.length > 0) malformed = true;
  if (!init) finish("UNKNOWN", "NO_INTENT");
  else if (malformed) finish("UNKNOWN", "MALFORMED");
  else if (accepted !== null)
    finish("COMPLETED", "PIPE_CLOSED_AFTER_ACCEPTED_QUIT");
  else finish("UNKNOWN", "NO_ACCEPTED_QUIT");
});
`;
