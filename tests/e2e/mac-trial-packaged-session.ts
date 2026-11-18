// Shared host-side helpers for the packaged-Mac MT11 functional driver and
// the MT12 bounded manual drivers (tests/e2e/mac-trial-packaged-*.spec.ts).
// Import-safe and launch-free: type-only Playwright imports and no module-top
// Electron launch, child spawn/kill, fixture seed or evidence write. The spec
// files own _electron.launch (executablePath = prepared.executablePath,
// args = [], env = prepared.env) and the existing
// prepareCheckpointObservation/captureCheckpointObservationSample helpers
// remain the launch gate and the read-only sample capture. This module adds
// only:
//   * the bounded manual ready/step/command evidence protocol (wx-only,
//     strict schema, strict seq, no resets or overwrites, no arbitrary
//     JS/PID/path execution);
//   * post-COMMIT hold/recorder wrappers for BOTH the diagnostic-v1 and the
//     legacy request channels (the real registered handler always runs
//     first; only the first save:commit reply for the selected page is
//     held after the real result was produced — never a synthetic ACK);
//   * pure semantic checks reused by the Node protocol test.
// Commands are declarations recorded for the human operator and the outer
// batch; they never prove a physical action and must never be relabelled
// PHYSICAL_PASS.
//
// Required env (all inherited unchanged from the existing guarded batch):
//   FOLIO_GUI_TEST_OPT_IN=1
//   FOLIO_LOCAL_GUI_BATCH=1
//   FOLIO_LOCAL_GUI_DATA_ROOT=<approved private wrapper root>
//   FOLIO_OWNED_SHUTDOWN_REQUEST=<existing frozen owned-shutdown request JSON>
//   FOLIO_CHECKPOINT_OBSERVATION_INTENT=<fresh intent.json path>
//   FOLIO_CHECKPOINT_OBSERVATION_CANDIDATE=<candidate manifest path>
// Scenario selector required only by mac-trial-packaged-manual.spec.ts:
//   FOLIO_MANUAL_MODE=physical | quit-interrupt
// The selector only chooses which bounded manual scenario runs; it never
// authorizes a launch. No external config paths are read.
import {createHash} from "node:crypto";
import type {ChildProcess} from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {join, sep} from "node:path";
import {DatabaseSync} from "node:sqlite";
import type {ElectronApplication, Page} from "@playwright/test";
import {resolveAsset} from "../../src/persistence/assets";
import {
  CHECKPOINT_OBSERVATION_BINDING_ENV,
  CHECKPOINT_OBSERVATION_OPT_IN_ENV,
} from "../../src/shared/checkpoint-observation";
import type {
  DatabaseProjection,
  Doc,
  Page as FolioPage,
  RecordProjection,
  Snapshot,
} from "../../src/shared/types";
import type {MacTrialManifest} from "../../scripts/mac-trial-seed";
import type {ObservationFixture} from "./checkpoint-observation-harness";

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const sha256Bytes = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const sha256File = (path: string) => sha256Bytes(readFileSync(path));
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

const HASH = /^[a-f0-9]{64}$/;
const EVIDENCE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STEP_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;

export const MANUAL_MODE_ENV = "FOLIO_MANUAL_MODE";
export const MANUAL_MODES = ["physical", "quit-interrupt"] as const;
export type ManualMode = (typeof MANUAL_MODES)[number];
/** Hard bound for one manual test; the existing monitor 240s/default/300s max
 * and the owned-request TTL are never widened. */
export const MANUAL_TEST_TIMEOUT_MS = 210000;
export const MANUAL_SEGMENT_WAIT_MS = 180000;
export const MANUAL_COMMAND_TTL_MS = 120000;
export const MANUAL_COMMAND_MAX_BYTES = 16 * 1024;
export const MANUAL_READY_MAX_BYTES = 64 * 1024;
export const MANUAL_EVIDENCE_MAX_BYTES = 256 * 1024;
export const MANUAL_READY_SCHEMA = "folio.manual-ready.v1";
export const MANUAL_STEP_SCHEMA = "folio.manual-step.v1";
export const MANUAL_COMMAND_SCHEMA = "folio.manual-command.v1";
export const MANUAL_EXPECTATIONS_SCHEMA = "folio.manual-expectations.v1";
export const PLANNED_EDITS_SCHEMA = "folio.planned-edits.v1";
/** Owning key from src/persistence/workspace-limit-settings.ts. */
export const GROWTH_LIMITS_SETTINGS_KEY = "folio.workspace.growthLimits";
export const MANUAL_ACTIONS = ["sample", "interrupt", "cancel"] as const;
export type ManualAction = (typeof MANUAL_ACTIONS)[number];
export const DIAGNOSTIC_CHANNEL = "folio:request:diagnostic-v1";
export const LEGACY_CHANNEL = "folio:request";
export const REQUEST_CHANNELS = [DIAGNOSTIC_CHANNEL, LEGACY_CHANNEL] as const;

export const PLANNED_ACTIVE_PAGE_BODY = "配布物の本文確認。";
export const PLANNED_RECORD_BODY = "配布物の行本文確認。";
export const PLANNED_RECORD_NOTE = "配布物のメモ確認。";
export const PHYSICAL_BODY_LINE_1 = "日本語の入力確認。";
export const PHYSICAL_BODY_LINE_2 = "二行目。";
export const INTERRUPT_HELD_TITLE = "中断前の確定タイトル";
export const INTERRUPT_LATEST_TITLE = "中断後の最新タイトル";
export const INTERRUPT_LATEST_BODY = "中断後に入力した本文";

export function parseManualMode(value: unknown): ManualMode {
  if (value === "physical" || value === "quit-interrupt") return value;
  fail("MANUAL_MODE", `${MANUAL_MODE_ENV} must be physical or quit-interrupt`);
}

/** Scenario selection only — never a launch authorization. */
export function manualMode(env: NodeJS.ProcessEnv = process.env): ManualMode | null {
  const raw = env[MANUAL_MODE_ENV];
  return raw === undefined || raw === "" ? null : parseManualMode(raw);
}

// ---------------------------------------------------------------------------
// Bounded immutable evidence inside the fixture-owned private evidence dir.

export function writeImmutableEvidence(
  fixture: Pick<ObservationFixture, "evidenceDir" | "root">,
  basename: string,
  value: unknown,
): {path: string; sha256: string} {
  if (!EVIDENCE_BASENAME.test(basename))
    fail("MANUAL_OUTPUT", "invalid evidence basename");
  const root = realpathSync(fixture.root);
  const dir = realpathSync(fixture.evidenceDir);
  if (dir !== root && !dir.startsWith(root + sep))
    fail("MANUAL_OUTPUT", "evidence dir escapes the owned fixture root");
  const path = join(dir, basename);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MANUAL_EVIDENCE_MAX_BYTES)
    fail("MANUAL_OUTPUT", "evidence exceeds the bounded size");
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    fail("MANUAL_OUTPUT", "evidence is not a regular file");
  return {path, sha256: sha256File(path)};
}

// ---------------------------------------------------------------------------
// Manual command protocol: the parent may only create command-NNNN.json with
// wx inside the fixture evidence dir (the control directory). No resets, no
// overwrites, exact frozen keys, strict seq chosen by the caller, bounded
// size, private owner, no symlinks.

export type ManualCommand = Readonly<{
  v: 1;
  schema: typeof MANUAL_COMMAND_SCHEMA;
  runId: string;
  nonce: string;
  seq: number;
  action: ManualAction;
  at: string;
  expiresAt: string;
}>;

const COMMAND_KEYS = [
  "action",
  "at",
  "expiresAt",
  "nonce",
  "runId",
  "schema",
  "seq",
  "v",
];

export function commandBasename(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 9999)
    fail("MANUAL_COMMAND", "command seq must be an integer in [1,9999]");
  return `command-${String(seq).padStart(4, "0")}.json`;
}

export function isCommandBasename(name: unknown): name is string {
  return typeof name === "string" && /^command-[0-9]{4}\.json$/.test(name);
}

export function validateManualCommand(
  value: unknown,
  expected: {runId: string; nonce: string; seq: number},
): asserts value is ManualCommand {
  if (!isObject(value)) fail("MANUAL_COMMAND", "command must be an object");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== COMMAND_KEYS.length ||
    !COMMAND_KEYS.every((key, index) => keys[index] === key)
  )
    fail("MANUAL_COMMAND", "command keys differ from the frozen schema");
  if (
    value.v !== 1 ||
    value.schema !== MANUAL_COMMAND_SCHEMA ||
    value.runId !== expected.runId ||
    value.nonce !== expected.nonce ||
    value.seq !== expected.seq ||
    !(MANUAL_ACTIONS as readonly unknown[]).includes(value.action) ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at)) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.parse(value.at)
  )
    fail("MANUAL_COMMAND", "command fields do not match the frozen schema");
}

/** Declaration only: records one bounded command the human/root may act on.
 * Issuing a command is never evidence that a physical action happened. */
export function issueManualCommand(
  fixture: Pick<ObservationFixture, "evidenceDir" | "root">,
  binding: Readonly<{runId: string; nonce: string}>,
  options: {seq: number; action: ManualAction; ttlMs?: number; now?: number},
): {path: string; sha256: string; command: ManualCommand} {
  const ttl = options.ttlMs ?? MANUAL_COMMAND_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > MANUAL_COMMAND_TTL_MS)
    fail("MANUAL_COMMAND", "command ttl is out of bounds");
  const now = options.now ?? Date.now();
  const command: ManualCommand = Object.freeze({
    v: 1,
    schema: MANUAL_COMMAND_SCHEMA,
    runId: binding.runId,
    nonce: binding.nonce,
    seq: options.seq,
    action: options.action,
    at: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
  });
  if (Date.parse(command.expiresAt) <= now)
    fail("MANUAL_COMMAND", "command expiry is not in the future");
  validateManualCommand(command, {
    runId: binding.runId,
    nonce: binding.nonce,
    seq: options.seq,
  });
  const {path} = writeImmutableEvidence(
    fixture,
    commandBasename(options.seq),
    command,
  );
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size < 1 ||
    stat.size > MANUAL_COMMAND_MAX_BYTES ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    fail("MANUAL_COMMAND", "command file is not a private bounded regular file");
  return {path, sha256: sha256File(path), command};
}

/** Reads and validates the EXTERNAL command for expected.seq. The reader is
 * pinned to the fixed fixture evidence dir: the basename is derived from the
 * seq (no caller-supplied path), every ancestor from the owned root down must
 * be a real non-symlink directory, the control dir and file must be private
 * owner-uid entries (no group/other bits, regular file, size-bounded), and
 * the payload must carry the exact frozen schema, matching runId/nonce/seq,
 * an action from the accepted set, and a current clock window — issued not in
 * the future, not expired, ttl within MANUAL_COMMAND_TTL_MS, and expiry not
 * beyond the caller's deadline. `expected.now` is the actual clock in
 * production; the explicit clock exists only for the pure Node checks and
 * never bypasses authorization. */
export function readManualCommandFile(
  fixture: Pick<ObservationFixture, "root" | "evidenceDir">,
  expected: {
    runId: string;
    nonce: string;
    seq: number;
    actions?: readonly ManualAction[];
    now?: number;
    deadlineAt?: string;
  },
): ManualCommand {
  // Reject symlinks in the DECLARED root/control paths BEFORE realpath: a
  // symlinked evidence dir that happens to resolve inside the root (or a
  // symlinked intermediate ancestor) must fail, not be silently followed.
  const assertNoSymlinkPath = (declared: string, what: string) => {
    if (!declared.startsWith(sep))
      fail("MANUAL_COMMAND", `${what} must be an absolute path`);
    let cursor: string = sep;
    for (const segment of declared.split(sep).filter(Boolean)) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink())
        fail("MANUAL_COMMAND", `${what} traverses a symlink`);
    }
    if (!lstatSync(declared).isDirectory())
      fail("MANUAL_COMMAND", `${what} is not a directory`);
  };
  assertNoSymlinkPath(fixture.root, "fixture root");
  assertNoSymlinkPath(fixture.evidenceDir, "control directory");
  if (
    fixture.evidenceDir !== fixture.root &&
    !fixture.evidenceDir.startsWith(fixture.root + sep)
  )
    fail("MANUAL_COMMAND", "declared control directory is not inside the root");
  // Canonical containment + private ownership/mode proof.
  const root = realpathSync(fixture.root);
  const dir = realpathSync(fixture.evidenceDir);
  if (dir !== root && !dir.startsWith(root + sep))
    fail("MANUAL_COMMAND", "control directory escapes the owned fixture root");
  const dirStat = lstatSync(dir);
  if (
    !dirStat.isDirectory() ||
    dirStat.isSymbolicLink() ||
    (dirStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && dirStat.uid !== process.getuid())
  )
    fail("MANUAL_COMMAND", "control directory is not a private owned directory");
  const path = join(dir, commandBasename(expected.seq));
  if (path !== root && !path.startsWith(root + sep))
    fail("MANUAL_COMMAND", "command path escapes the owned fixture root");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    fail("MANUAL_COMMAND", "command file is a symlink");
  if (
    !stat.isFile() ||
    stat.size < 1 ||
    stat.size > MANUAL_COMMAND_MAX_BYTES ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    fail("MANUAL_COMMAND", "command must be a private bounded regular file");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path).toString("utf8"));
  } catch {
    fail("MANUAL_COMMAND", "command is not JSON");
  }
  validateManualCommand(value, expected);
  if (
    expected.actions &&
    !expected.actions.includes((value as ManualCommand).action)
  )
    fail("MANUAL_COMMAND", "command action is not accepted here");
  const now = expected.now ?? Date.now();
  const at = Date.parse((value as ManualCommand).at);
  const expiresAt = Date.parse((value as ManualCommand).expiresAt);
  if (at > now) fail("MANUAL_COMMAND", "command was issued in the future");
  if (now >= expiresAt) fail("MANUAL_COMMAND", "command is expired");
  if (expiresAt - at > MANUAL_COMMAND_TTL_MS)
    fail("MANUAL_COMMAND", "command ttl exceeds the bound");
  if (expected.deadlineAt && expiresAt > Date.parse(expected.deadlineAt))
    fail("MANUAL_COMMAND", "command expiry exceeds the run deadline");
  return value;
}

export type ManualCommandWait =
  | {kind: "received"; path: string; sha256: string; command: ManualCommand}
  | {kind: "invalid"; path: string; error: string}
  | {kind: "timeout"; at: string};

/** Bounded wait for the EXTERNAL root-written command-NNNN.json. The spec
 * never writes commands itself: the root writes them only after the real
 * human reply, and an absent/invalid/expired/cancel command is NOT_RUN —
 * never a synthesized or assumed human completion. */
export async function awaitManualCommand(
  fixture: Pick<ObservationFixture, "root" | "evidenceDir">,
  binding: Readonly<{runId: string; nonce: string}>,
  options: {
    seq: number;
    actions: readonly ManualAction[];
    timeoutMs: number;
    deadlineAt?: string;
    pollMs?: number;
  },
): Promise<ManualCommandWait> {
  const deadline = Math.min(
    Date.now() + options.timeoutMs,
    options.deadlineAt ? Date.parse(options.deadlineAt) : Number.POSITIVE_INFINITY,
  );
  const path = join(
    realpathSync(fixture.evidenceDir),
    commandBasename(options.seq),
  );
  const pollMs = options.pollMs ?? 250;
  while (Date.now() < deadline) {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await sleep(pollMs);
        continue;
      }
      return {kind: "invalid", path, error: String(error)};
    }
    try {
      const command = readManualCommandFile(fixture, {
        runId: binding.runId,
        nonce: binding.nonce,
        seq: options.seq,
        actions: options.actions,
        deadlineAt: options.deadlineAt,
      });
      return {kind: "received", path, sha256: sha256File(path), command};
    } catch (error) {
      return {kind: "invalid", path, error: String(error)};
    }
  }
  return {kind: "timeout", at: new Date().toISOString()};
}

// ---------------------------------------------------------------------------
// Ready evidence + step records.

export type ManualReady = Readonly<{
  v: 1;
  schema: typeof MANUAL_READY_SCHEMA;
  runId: string;
  nonce: string;
  pid: number;
  executablePath: string;
  dataDir: string;
  vaultDir: string;
  evidenceDir: string;
  controlDirectory: string;
  windowTitle: string;
  issuedAt: string;
  deadlineAt: string;
  remainingMs: number;
  expectations: Readonly<{
    schema: typeof MANUAL_EXPECTATIONS_SCHEMA;
    sourceCandidate: string;
    artifactSha256: string;
    fixtureSha256: string;
  }>;
}>;

const READY_KEYS = [
  "controlDirectory",
  "dataDir",
  "deadlineAt",
  "evidenceDir",
  "executablePath",
  "expectations",
  "issuedAt",
  "nonce",
  "pid",
  "remainingMs",
  "runId",
  "schema",
  "v",
  "vaultDir",
  "windowTitle",
];
const EXPECTATION_KEYS = [
  "artifactSha256",
  "fixtureSha256",
  "schema",
  "sourceCandidate",
];

export function validateManualReady(
  value: unknown,
  expected: {
    runId: string;
    nonce: string;
    executablePath: string;
    dataDir: string;
    vaultDir: string;
    evidenceDir: string;
    controlDirectory: string;
    sourceCandidate: string;
    artifactSha256: string;
    fixtureSha256: string;
  },
): asserts value is ManualReady {
  if (!isObject(value)) fail("MANUAL_READY", "ready evidence must be an object");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== READY_KEYS.length ||
    !READY_KEYS.every((key, index) => keys[index] === key)
  )
    fail("MANUAL_READY", "ready keys differ from the frozen schema");
  if (
    value.v !== 1 ||
    value.schema !== MANUAL_READY_SCHEMA ||
    value.runId !== expected.runId ||
    value.nonce !== expected.nonce ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    value.executablePath !== expected.executablePath ||
    value.dataDir !== expected.dataDir ||
    value.vaultDir !== expected.vaultDir ||
    value.evidenceDir !== expected.evidenceDir ||
    value.controlDirectory !== expected.controlDirectory ||
    typeof value.windowTitle !== "string" ||
    !value.windowTitle.includes(expected.nonce) ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    typeof value.deadlineAt !== "string" ||
    !Number.isFinite(Date.parse(value.deadlineAt))
  )
    fail("MANUAL_READY", "ready fields do not match the frozen schema");
  const remaining =
    Date.parse(value.deadlineAt as string) - Date.parse(value.issuedAt as string);
  if (
    value.remainingMs !== remaining ||
    remaining < 1 ||
    remaining > MANUAL_TEST_TIMEOUT_MS
  )
    fail("MANUAL_READY", "ready deadline bookkeeping is inconsistent");
  const expectations = value.expectations;
  if (!isObject(expectations)) fail("MANUAL_READY", "expectations must be an object");
  const ekeys = Object.keys(expectations).sort();
  if (
    ekeys.length !== EXPECTATION_KEYS.length ||
    !EXPECTATION_KEYS.every((key, index) => ekeys[index] === key) ||
    expectations.schema !== MANUAL_EXPECTATIONS_SCHEMA ||
    expectations.sourceCandidate !== expected.sourceCandidate ||
    expectations.artifactSha256 !== expected.artifactSha256 ||
    expectations.fixtureSha256 !== expected.fixtureSha256 ||
    !HASH.test(expectations.sourceCandidate as string) ||
    !HASH.test(expectations.artifactSha256 as string) ||
    !HASH.test(expectations.fixtureSha256 as string)
  )
    fail("MANUAL_READY", "versioned expectations differ from the binding");
}

/** Writes the ready evidence with wx and prints the single recognizable
 * `FOLIO_MANUAL_READY <absolute path>` stdout marker. */
export function publishManualReady(
  fixture: Pick<ObservationFixture, "root" | "data" | "vault" | "evidenceDir">,
  binding: Readonly<{
    runId: string;
    nonce: string;
    sourceCandidate: string;
    artifactSha256: string;
    fixtureSha256: string;
  }>,
  facts: {
    pid: number;
    executablePath: string;
    windowTitle: string;
    deadlineAt: string;
    issuedAt?: string;
  },
): {path: string; sha256: string; ready: ManualReady} {
  const issuedAt = facts.issuedAt ?? new Date().toISOString();
  const ready: ManualReady = Object.freeze({
    v: 1,
    schema: MANUAL_READY_SCHEMA,
    runId: binding.runId,
    nonce: binding.nonce,
    pid: facts.pid,
    executablePath: facts.executablePath,
    dataDir: fixture.data,
    vaultDir: fixture.vault,
    evidenceDir: fixture.evidenceDir,
    controlDirectory: fixture.evidenceDir,
    windowTitle: facts.windowTitle,
    issuedAt,
    deadlineAt: facts.deadlineAt,
    remainingMs: Date.parse(facts.deadlineAt) - Date.parse(issuedAt),
    expectations: Object.freeze({
      schema: MANUAL_EXPECTATIONS_SCHEMA,
      sourceCandidate: binding.sourceCandidate,
      artifactSha256: binding.artifactSha256,
      fixtureSha256: binding.fixtureSha256,
    }),
  });
  validateManualReady(ready, {
    runId: binding.runId,
    nonce: binding.nonce,
    executablePath: facts.executablePath,
    dataDir: fixture.data,
    vaultDir: fixture.vault,
    evidenceDir: fixture.evidenceDir,
    controlDirectory: fixture.evidenceDir,
    sourceCandidate: binding.sourceCandidate,
    artifactSha256: binding.artifactSha256,
    fixtureSha256: binding.fixtureSha256,
  });
  const {path, sha256} = writeImmutableEvidence(fixture, "manual-ready.json", ready);
  process.stdout.write(`FOLIO_MANUAL_READY ${path}\n`);
  return {path, sha256, ready};
}

/** Writes one immutable step record and prints `FOLIO_MANUAL_STEP <path>`. */
export function emitManualStep(
  fixture: Pick<ObservationFixture, "evidenceDir" | "root">,
  binding: Readonly<{runId: string; nonce: string}>,
  name: string,
  facts: Record<string, unknown>,
): {path: string; sha256: string; at: string} {
  if (!STEP_NAME.test(name)) fail("MANUAL_STEP", "invalid step name");
  const at = new Date().toISOString();
  const step = {
    v: 1,
    schema: MANUAL_STEP_SCHEMA,
    runId: binding.runId,
    nonce: binding.nonce,
    name,
    at,
    facts,
  };
  const {path, sha256} = writeImmutableEvidence(fixture, `step-${name}.json`, step);
  process.stdout.write(`FOLIO_MANUAL_STEP ${path}\n`);
  return {path, sha256, at};
}

export type ManualCommandGate =
  | {kind: "OK"; issuedAtMs: number; expiresAtMs: number; remainingMs: number}
  | {kind: "HOLD"; reason: "INVALID_TIME" | "STALE" | "FUTURE_ISSUE" | "EXPIRED"};

/** ISO-time ordering gate for an EXTERNAL manual command: the command must be
 * issued at-or-after the demonstrated step (nonnegative ordering), not in the
 * future and not yet expired. ManualCommand.at/expiresAt are ISO strings —
 * Date.parse only, never Number(). Any unparsable or out-of-order stamp fails
 * closed as HOLD. */
export function manualCommandGate(
  command: Readonly<{at: string; expiresAt: string}>,
  stepAt: string,
  now: number = Date.now(),
): ManualCommandGate {
  const issuedAtMs = Date.parse(command.at);
  const expiresAtMs = Date.parse(command.expiresAt);
  const stepAtMs = Date.parse(stepAt);
  if (
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(stepAtMs)
  ) {
    return {kind: "HOLD", reason: "INVALID_TIME"};
  }
  if (issuedAtMs < stepAtMs) return {kind: "HOLD", reason: "STALE"};
  if (issuedAtMs > now) return {kind: "HOLD", reason: "FUTURE_ISSUE"};
  const remainingMs = expiresAtMs - now;
  if (remainingMs <= 0) return {kind: "HOLD", reason: "EXPIRED"};
  return {kind: "OK", issuedAtMs, expiresAtMs, remainingMs};
}

/** Fixes the MT11 planned edits with wx BEFORE any launch or UI action so the
 * recorded intent — not the live app — is the authority for what is checked. */
export function writePlannedEdits(
  fixture: Pick<ObservationFixture, "evidenceDir" | "root">,
  binding: Readonly<{runId: string; nonce: string}>,
  plan: {
    activePageId: string;
    recordPageId: string;
    notePropertyId: string;
    notePropertyName: string;
  },
): {path: string; sha256: string} {
  return writeImmutableEvidence(fixture, "planned-edits.json", {
    v: 1,
    schema: PLANNED_EDITS_SCHEMA,
    runId: binding.runId,
    nonce: binding.nonce,
    edits: [
      {
        target: "activePage",
        pageId: plan.activePageId,
        kind: "plainParagraphBody",
        text: PLANNED_ACTIVE_PAGE_BODY,
      },
      {
        target: "record",
        pageId: plan.recordPageId,
        kind: "plainParagraphBody",
        text: PLANNED_RECORD_BODY,
      },
      {
        target: "record",
        pageId: plan.recordPageId,
        kind: "noteValue",
        propertyId: plan.notePropertyId,
        propertyName: plan.notePropertyName,
        text: PLANNED_RECORD_NOTE,
      },
    ],
    unchanged:
      "every other page/record doc, record values, database settings/views/" +
      "properties, attachment registry+bytes and limits compare against the " +
      "original seed manifest, not against a re-captured workspace",
  });
}

// ---------------------------------------------------------------------------
// In-app request wrappers. Both the diagnostic-v1 channel (bare Request in,
// tag/version/ok/valueSlot.value envelope out) and the legacy channel (bare
// Request in, direct result out) are wrapped — never only the legacy path.
// The real registered handler ALWAYS runs first; these wrappers only observe
// or delay an already-produced reply.

export function isDiagnosticEnvelope(result: unknown): result is {
  tag: string;
  version: number;
  ok: true;
  valueSlot: {value: unknown};
} {
  return (
    isObject(result) &&
    typeof result.tag === "string" &&
    Number.isSafeInteger(result.version) &&
    result.ok === true &&
    isObject(result.valueSlot) &&
    "value" in result.valueSlot
  );
}

/** Result status on either channel: envelope valueSlot.value.status for
 * diagnostic-v1, direct .status for the legacy channel. */
export function receiptStatus(result: unknown): unknown {
  if (isDiagnosticEnvelope(result))
    return (result.valueSlot.value as {status?: unknown} | null | undefined)?.status;
  return (result as {status?: unknown} | null | undefined)?.status;
}

export type HeldCommit = Readonly<{
  channel: string;
  request: unknown;
  operation: {operationId?: string; pageId?: string; seq?: number} & Record<
    string,
    unknown
  >;
  result: unknown;
  heldAt: string;
}>;

/** Holds ONLY the reply of the first save:commit for the selected page, after
 * the real registered handler produced its real applied result on whichever
 * channel delivered it. Authorization, args and result are untouched; no
 * synthetic applied ACK is ever fabricated. */
export async function installPostCommitHold(
  app: ElectronApplication,
  config: {pageId: string},
): Promise<void> {
  await app.evaluate(({ipcMain}, cfg) => {
    const ipc = ipcMain as any;
    const clone = (value: unknown) => {
      try {
        return structuredClone(value);
      } catch {
        return value;
      }
    };
    const state = ((globalThis as any).__folioManualHold = {
      config: cfg,
      held: null as HeldCommit | null,
      calls: [] as unknown[],
      channels: [] as unknown[],
    });
    for (const channel of ["folio:request:diagnostic-v1", "folio:request"]) {
      const original = ipc._invokeHandlers.get(channel);
      if (typeof original !== "function") {
        state.channels.push({channel, hooked: false});
        continue;
      }
      ipc.removeHandler(channel);
      ipc.handle(channel, async (event: unknown, request: any) => {
        const result = await original(event, request);
        if (
          !state.held &&
          request &&
          typeof request === "object" &&
          request.type === "save:commit" &&
          request.operation?.pageId === cfg.pageId
        ) {
          // The pageId equality above already narrowed the shape; narrow
          // the remaining fields explicitly while preserving the whole
          // immutable operation — no broad cast that skips validation.
          const cloned = clone(request.operation) as Record<string, unknown>;
          const operation: HeldCommit["operation"] = {
            ...cloned,
            pageId: cfg.pageId,
            ...(typeof cloned.operationId === "string"
              ? {operationId: cloned.operationId}
              : {}),
            ...(typeof cloned.seq === "number" ? {seq: cloned.seq} : {}),
          };
          state.held = {
            channel,
            request: clone(request),
            operation,
            result: clone(result),
            heldAt: new Date().toISOString(),
          };
          return new Promise<unknown>(() => {});
        }
        return result;
      });
      state.channels.push({channel, hooked: true});
    }
  }, config);
}

export async function readHoldState(
  app: ElectronApplication,
): Promise<{held: HeldCommit | null; calls: unknown[]; channels: unknown[]} | null> {
  return app.evaluate(() => (globalThis as any).__folioManualHold ?? null);
}

export async function waitForHeld(
  app: ElectronApplication,
  timeoutMs = 60000,
): Promise<HeldCommit> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readHoldState(app);
    if (state?.held) return state.held;
    await sleep(200);
  }
  fail("MANUAL_HOLD", "the first save:commit reply was not held in time");
}

export interface RequestCallRecord {
  channel: string;
  type: string | null;
  operationId: string | null;
  arrivedAt: string;
  outcome: "pending" | "fulfilled" | "rejected";
  status: unknown;
  settledAt: string | null;
  request: unknown;
}

export interface RequestCallsRead {
  available: boolean;
  installedAt: string | null;
  readAt: string;
  calls: RequestCallRecord[];
}

export interface RecorderCoverage {
  installedAt: string;
  channelsWrapped: string[];
  channelsMissing: string[];
  rendererAlreadyPresent: boolean | null;
}

export function hasCompleteRecorderInterval(
  coverage: RecorderCoverage | undefined,
  read: RequestCallsRead | null,
): boolean {
  if (coverage === undefined || read === null || !read.available) {
    return false;
  }
  if (
    coverage.channelsMissing.length > 0 ||
    !coverage.channelsWrapped.includes("folio:request") ||
    !coverage.channelsWrapped.includes("folio:request:diagnostic-v1")
  ) {
    return false;
  }
  if (read.installedAt !== coverage.installedAt) {
    return false;
  }
  const installedAtMs = Date.parse(coverage.installedAt);
  const readAtMs = Date.parse(read.readAt);
  return (
    Number.isFinite(installedAtMs) &&
    Number.isFinite(readAtMs) &&
    readAtMs >= installedAtMs
  );
}

/** Records (never alters) commit/resolve traffic on BOTH channels for the
 * post-recovery resolve-once/no-duplicate checks. Arrival is stamped BEFORE
 * the original handler runs so a hung or throwing handler still leaves a
 * pending entry; the same entry is then marked fulfilled/rejected with its
 * bounded status. Missing channels are reported, never silently skipped. The
 * returned coverage (install time + whether a renderer already existed)
 * bounds what "no arrivals" can ever claim — a late hook is never a
 * whole-launch zero. */
export async function installRequestRecorder(
  app: ElectronApplication,
): Promise<RecorderCoverage> {
  return app.evaluate(({ipcMain, BrowserWindow}) => {
    const ipc = ipcMain as any;
    const clone = (value: unknown) => {
      try {
        return structuredClone(value);
      } catch {
        return value;
      }
    };
    const statusOf = (result: any) =>
      result &&
      typeof result === "object" &&
      result.valueSlot &&
      typeof result.valueSlot === "object"
        ? result.valueSlot.value?.status
        : result?.status;
    const tracked = (type: unknown) =>
      type === "save:commit" ||
      type === "save:resolve" ||
      type === "database:commit" ||
      type === "database:resolve";
    const calls: unknown[] = [];
    const installedAt = new Date().toISOString();
    const channelsWrapped: string[] = [];
    const channelsMissing: string[] = [];
    const handlers = ipc._invokeHandlers;
    for (const channel of ["folio:request:diagnostic-v1", "folio:request"]) {
      const original = handlers?.get?.(channel);
      if (typeof original !== "function") {
        channelsMissing.push(channel);
        continue;
      }
      const wrapped = (event: unknown, request: any) => {
        const entry =
          request && typeof request === "object" && tracked(request.type)
            ? {
                channel,
                type: request.type as string,
                operationId:
                  typeof request.operation?.operationId === "string"
                    ? request.operation.operationId
                    : null,
                arrivedAt: new Date().toISOString(),
                outcome: "pending",
                status: null as unknown,
                settledAt: null as string | null,
                request: clone(request),
              }
            : null;
        if (entry) calls.push(entry);
        const settle = (outcome: string, result: unknown) => {
          if (entry) {
            entry.outcome = outcome;
            entry.status = statusOf(result);
            entry.settledAt = new Date().toISOString();
          }
          return result;
        };
        try {
          const result = original.call(ipc, event, request);
          if (result && typeof result.then === "function") {
            return result.then(
              (value: unknown) => settle("fulfilled", value),
              (error: unknown) => {
                settle("rejected", error);
                throw error;
              },
            );
          }
          return settle("fulfilled", result);
        } catch (error) {
          settle("rejected", error);
          throw error;
        }
      };
      handlers.set(channel, wrapped);
      channelsWrapped.push(channel);
    }
    let rendererAlreadyPresent: boolean | null = null;
    try {
      rendererAlreadyPresent = BrowserWindow.getAllWindows().length > 0;
    } catch {
      rendererAlreadyPresent = null;
    }
    (globalThis as any).__folioRequestCalls = calls;
    (globalThis as any).__folioRequestRecorderInstalledAt = installedAt;
    return {
      installedAt,
      channelsWrapped,
      channelsMissing,
      rendererAlreadyPresent,
    };
  });
}

export async function readRequestCalls(
  app: ElectronApplication,
): Promise<RequestCallsRead> {
  return app.evaluate(() => {
    const calls = (globalThis as any).__folioRequestCalls;
    const installedAt =
      (globalThis as any).__folioRequestRecorderInstalledAt ?? null;
    if (!Array.isArray(calls)) {
      return {
        available: false,
        installedAt: null,
        readAt: new Date().toISOString(),
        calls: [],
      };
    }
    return {
      available: true,
      installedAt,
      readAt: new Date().toISOString(),
      calls: (calls as RequestCallRecord[]).map((call) => ({...call})),
    };
  });
}

export type OldOperationCallAudit =
  | {kind: "FAIL"; reason: "OLD_RECOMMIT_ARRIVED"; calls: RequestCallRecord[]}
  | {kind: "OK"; appliedResolve: RequestCallRecord; calls: RequestCallRecord[]}
  | {
      kind: "HOLD";
      reason:
        | "RECORDER_UNAVAILABLE"
        | "OLD_RESOLVE_PENDING"
        | "OLD_RESOLVE_MISSING"
        | "OLD_RESOLVE_AMBIGUOUS";
      calls: RequestCallRecord[];
    };

/** Scoped post-recovery accounting for the HELD operation only: a
 * conclusively arrived old save/database commit (even one whose settle is
 * still pending) is FAIL; unseen, pending or ambiguous resolve evidence is
 * HOLD; a scoped pass is exactly one fulfilled old resolve whose status is
 * "applied" with zero old commit arrivals. Calls carrying any other
 * operationId never count as duplicates. */
export function auditOldOperationCalls(
  read: RequestCallsRead,
  oldOperationId: string,
): OldOperationCallAudit {
  const calls = read.calls;
  if (!read.available || oldOperationId.length === 0) {
    return {kind: "HOLD", reason: "RECORDER_UNAVAILABLE", calls};
  }
  const own = calls.filter((call) => call.operationId === oldOperationId);
  const recommits = own.filter(
    (call) => call.type === "save:commit" || call.type === "database:commit",
  );
  if (recommits.length > 0) {
    return {kind: "FAIL", reason: "OLD_RECOMMIT_ARRIVED", calls};
  }
  const resolves = own.filter(
    (call) => call.type === "save:resolve" || call.type === "database:resolve",
  );
  if (resolves.some((call) => call.outcome === "pending")) {
    return {kind: "HOLD", reason: "OLD_RESOLVE_PENDING", calls};
  }
  const applied = resolves.filter(
    (call) => call.outcome === "fulfilled" && call.status === "applied",
  );
  if (applied.length === 0) {
    return {kind: "HOLD", reason: "OLD_RESOLVE_MISSING", calls};
  }
  if (applied.length > 1 || resolves.length > applied.length) {
    return {kind: "HOLD", reason: "OLD_RESOLVE_AMBIGUOUS", calls};
  }
  return {kind: "OK", appliedResolve: applied[0]!, calls};
}

const SESSION_DIR_NAME = /^session-[A-Za-z0-9._-]{1,120}$/;
const SESSION_FILE_MAX_BYTES = 1 << 20;

export interface SessionAttemptBinding {
  status: "ok" | "missing" | "ambiguous" | "invalid";
  dir: string | null;
  sessionId: string | null;
  runId: string | null;
  nonce: string | null;
  startedAt: string | null;
  intentRunId: string | null;
  intentSessionId: string | null;
  intentNonce: string | null;
  intentRunRoot: string | null;
  intentTempRoot: string | null;
  problems: string[];
}

/** Bounded read-only identity probe of the synthetic request root: finds the
 * unique `session-` directory (never a symlink, never out-of-root), reads
 * attempt.json/intent.json under a byte cap and binds runId/sessionId/nonce/
 * startedAt. 'ok' requires BOTH files, attempt.runId === intent.runId ===
 * options.expectedRunId, a matching nonempty sessionId, a nonempty monitor
 * nonce (matching a declared intent.monitorNonce when present), a parseable
 * startedAt, intent.runRoot equal to the canonical request root and
 * intent.tempRoot resolving to the session dir itself inside the private
 * root. The intent (observer) and attempt (owned monitor) runId/nonce are
 * two independently generated namespaces — both recorded, never equated with
 * each other's nonce or with the manual binding nonce. Missing IDs are never
 * inferred; anything short of full agreement is missing/ambiguous/invalid. */
export function readSessionAttempt(
  requestRunRoot: string,
  options: {expectedRunId: string; excludeDir?: string | null},
): SessionAttemptBinding {
  const problems: string[] = [];
  const empty = (status: SessionAttemptBinding["status"]): SessionAttemptBinding => ({
    status,
    dir: null,
    sessionId: null,
    runId: null,
    nonce: null,
    startedAt: null,
    intentRunId: null,
    intentSessionId: null,
    intentNonce: null,
    intentRunRoot: null,
    intentTempRoot: null,
    problems,
  });
  let root: string;
  try {
    root = realpathSync(requestRunRoot);
  } catch (error) {
    problems.push("runRoot: " + String(error));
    return empty("invalid");
  }
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    problems.push("readdir: " + String(error));
    return empty("invalid");
  }
  const excluded = options.excludeDir ?? null;
  const candidates = entries.filter(
    (entry) =>
      SESSION_DIR_NAME.test(entry) &&
      (excluded === null || (entry !== excluded && join(root, entry) !== excluded)),
  );
  if (candidates.length === 0) return empty("missing");
  if (candidates.length > 1) {
    problems.push("multiple session- directories");
    return empty("ambiguous");
  }
  const dir = join(root, candidates[0]!);
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      problems.push("session dir is not a plain directory");
      return empty("invalid");
    }
  } catch (error) {
    problems.push("lstat: " + String(error));
    return empty("invalid");
  }
  const readJson = (name: string): Record<string, unknown> | null => {
    const file = join(dir, name);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > SESSION_FILE_MAX_BYTES) {
        problems.push(name + ": unreadable, symlink or too large");
        return null;
      }
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const attempt = readJson("attempt.json");
  const intent = readJson("intent.json");
  const str = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null;
  const bound: SessionAttemptBinding = {
    status: "ok",
    dir,
    sessionId: str(attempt?.sessionId),
    runId: str(attempt?.runId),
    nonce: str(attempt?.nonce),
    startedAt: str(attempt?.startedAt),
    intentRunId: str(intent?.runId),
    intentSessionId: str(intent?.sessionId),
    intentNonce: str(intent?.nonce),
    intentRunRoot: str(intent?.runRoot),
    intentTempRoot: str(intent?.tempRoot),
    problems,
  };
  const reject = (problem: string): SessionAttemptBinding => {
    problems.push(problem);
    return {...bound, status: "invalid"};
  };
  if (attempt === null) return reject("attempt.json missing or unreadable");
  if (intent === null) return reject("intent.json missing or unreadable");
  if (bound.runId === null || bound.runId !== options.expectedRunId) {
    return reject("attempt.runId missing or different from expectedRunId");
  }
  if (bound.intentRunId === null || bound.intentRunId !== bound.runId) {
    return reject("intent.runId missing or different from attempt.runId");
  }
  if (
    bound.sessionId === null ||
    bound.intentSessionId === null ||
    bound.sessionId !== bound.intentSessionId
  ) {
    return reject("sessionId missing or different between attempt and intent");
  }
  if (bound.nonce === null) {
    return reject("attempt nonce missing or empty");
  }
  if (bound.intentNonce === null || bound.intentNonce !== bound.nonce) {
    return reject("intent.nonce missing or different from attempt.nonce");
  }
  if (bound.startedAt === null || !Number.isFinite(Date.parse(bound.startedAt))) {
    return reject("attempt.startedAt missing or unparsable");
  }
  if (bound.intentRunRoot === null || bound.intentRunRoot !== root) {
    return reject("intent.runRoot missing or different from canonical runRoot");
  }
  if (bound.intentTempRoot === null) {
    return reject("intent.tempRoot missing or empty");
  }
  try {
    if (realpathSync(bound.intentTempRoot) !== realpathSync(dir)) {
      return reject("intent.tempRoot resolves to a different directory");
    }
  } catch (error) {
    return reject("intent.tempRoot: " + String(error));
  }
  return bound;
}

/** Test-side close-event counter on the already-owned windows: this observes
 * a real Cmd+Q (the product keeps running with retained pending input); it
 * never synthesizes or accepts a quit itself. */
export async function installQuitAttemptCounter(
  app: ElectronApplication,
): Promise<void> {
  await app.evaluate(({BrowserWindow}) => {
    const state = ((globalThis as any).__folioManualQuit = {
      attempts: 0,
      events: [] as string[],
    });
    for (const win of BrowserWindow.getAllWindows())
      win.on("close", () => {
        state.attempts += 1;
        state.events.push(new Date().toISOString());
      });
  });
}

export async function readQuitAttempts(
  app: ElectronApplication,
): Promise<{attempts: number; events: string[]}> {
  return app.evaluate(
    () => (globalThis as any).__folioManualQuit ?? {attempts: 0, events: []},
  );
}

// ---------------------------------------------------------------------------
// Renderer-facing reads (read-only request port, no writes).

export async function requestLoad(window: Page): Promise<Snapshot> {
  return window.evaluate(() =>
    (globalThis as any).window.folio.request({type: "load"}),
  ) as Promise<Snapshot>;
}

export async function readRecordPage(
  window: Page,
  pageId: string,
): Promise<{page: FolioPage; record: RecordProjection}> {
  return window.evaluate(
    (id) => (globalThis as any).window.folio.request({type: "record:read", pageId: id}),
    pageId,
  ) as Promise<{page: FolioPage; record: RecordProjection}>;
}

export async function readDatabaseProjection(
  window: Page,
  databasePageId: string,
): Promise<DatabaseProjection> {
  return window.evaluate(
    (id) =>
      (globalThis as any).window.folio.request({
        type: "database:load",
        databasePageId: id,
      }),
    databasePageId,
  ) as Promise<DatabaseProjection>;
}

/** Raw read-port read (no wx persistence); persist via
 * captureCheckpointObservationSample when an immutable sample is required. */
export async function readObservationPort(window: Page): Promise<unknown> {
  return window.evaluate(
    () =>
      (globalThis as any).folioCheckpointObservation?.read?.() ?? null,
  );
}

/** Reads the unique main-document save indicator — exactly one
 * `.save-state-menu-summary .save-state[data-state]` element — and reports
 * its real data-state (pending/error/saved) plus its text. Missing,
 * non-unique or unreadable stays null; the wait is deadline-bounded. */
export async function readUiStatus(
  window: Page,
  timeoutMs = 4000,
): Promise<{
  dataState: string | null;
  text: string | null;
  dialogs: number;
  capturedAt: string;
} | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const selector = ".save-state-menu-summary .save-state[data-state]";
  for (;;) {
    try {
      const matches = window.locator(selector);
      const count = await matches.count();
      if (count > 1) return null;
      if (count === 1) {
        const element = matches.first();
        const dataState = await element.getAttribute("data-state");
        const text = (await element.textContent())?.trim() ?? null;
        const dialogs = await window.getByRole("dialog").count();
        return {dataState, text, dialogs, capturedAt: new Date().toISOString()};
      }
    } catch {
      return null;
    }
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------
// Owned lifecycle helpers: only the already-owned app handle is ever touched.

function safeProcess(app: ElectronApplication): ChildProcess | null {
  try {
    return app.process() as ChildProcess | null;
  } catch {
    return null;
  }
}


export type QuitObservation =
  | {kind: "retained"; attempts: number; events: string[]; at: string}
  | {kind: "exited"; exitCode: number | null; signalCode: NodeJS.Signals | null; at: string}
  | {kind: "timeout"; at: string};

/** Bounded wait for a real human Cmd+Q on the owned window: "retained" means
 * a close event was observed AND the child is still alive (pending input
 * retained instead of exiting); "exited" means the quit was accepted. */
export async function waitForQuitAttempt(
  app: ElectronApplication,
  timeoutMs: number,
): Promise<QuitObservation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = safeProcess(app);
    if (child && (child.exitCode !== null || child.signalCode !== null))
      return {
        kind: "exited",
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        at: new Date().toISOString(),
      };
    const attempts = await readQuitAttempts(app).catch(() => ({
      attempts: 0,
      events: [] as string[],
    }));
    if (attempts.attempts > 0) {
      await sleep(500);
      const after = safeProcess(app);
      if (after && after.exitCode === null && after.signalCode === null)
        return {
          kind: "retained",
          attempts: attempts.attempts,
          events: attempts.events,
          at: new Date().toISOString(),
        };
    }
    await sleep(250);
  }
  return {kind: "timeout", at: new Date().toISOString()};
}

export type OwnedCleanup = Readonly<{
  method: "app.close" | "SIGKILL" | "already-exited" | "unknown" | "none";
  /** True ONLY when the owned child really exited code 0 / signal null — a
   * resolved app.close promise, a timeout, a crash or a forced kill are all
   * normal:false so planned normal closes can be asserted, not assumed. */
  normal: boolean;
  pid: number | null;
  exitCode: number | null;
  signalCode: string | null;
  at: string;
  error?: string;
}>;

/** Bounded cleanup of ONLY the already-owned child handle: try the existing
 * app.close first, wait (bounded) for the REAL exit state of the original
 * ChildProcess, then an owned SIGKILL with every fact recorded. Nothing is
 * deleted; data and evidence are always retained. */
export async function closeOwnedApp(
  app: ElectronApplication | undefined,
  graceMs = 15000,
): Promise<OwnedCleanup> {
  const at = () => new Date().toISOString();
  const done = (
    method: OwnedCleanup["method"],
    normal: boolean,
    pid: number | null,
    exitCode: number | null,
    signalCode: string | null,
    error?: string,
  ): OwnedCleanup => ({
    method,
    normal,
    pid,
    exitCode,
    signalCode,
    at: at(),
    ...(error ? {error} : {}),
  }) as OwnedCleanup;
  if (!app) return done("none", false, null, null, null);
  // Freeze the ORIGINAL ChildProcess BEFORE app.close(): once the app has
  // disconnected, Playwright's process() throws, so every exit/signal/pid/kill
  // fact below reads only this captured handle — never a re-queried process.
  const child = safeProcess(app);
  const pid = child?.pid ?? null;
  if (child && (child.exitCode !== null || child.signalCode !== null))
    return done("already-exited", false, pid, child.exitCode, child.signalCode);
  let closeError: string | undefined;
  try {
    await Promise.race([
      app.close().then(() => "closed" as const),
      sleep(graceMs).then(() => "timeout" as const),
    ]);
  } catch (error) {
    closeError = error instanceof Error ? error.message : String(error);
  }
  // Bounded wait for the actual exit state of the ORIGINAL ChildProcess
  // handle — never claim a normal close while the child is still running.
  const deadline = Date.now() + 10000;
  while (
    child &&
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  )
    await sleep(100);
  if (!child) return done("unknown", false, pid, null, null, closeError);
  if (child.exitCode !== null || child.signalCode !== null)
    return done(
      "app.close",
      child.exitCode === 0 && child.signalCode === null,
      pid,
      child.exitCode,
      child.signalCode,
      closeError,
    );
  // Still running: the close did not land — terminate only the owned child.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGKILL");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
  return done("SIGKILL", false, pid, child.exitCode, child.signalCode, closeError);
}

/** Launch env for the restored copy: the same already-derived private fixture
 * env, re-pinned to the restored data dir plus a fresh private vault, with the
 * checkpoint observation opt-in+binding REMOVED (observation off — the
 * original binding pins the source dataDir and cannot match the copy). The
 * restored dir must stay a strict descendant of the same owned fixture root. */
export function restoredCopyEnv(
  prepared: {
    env: Record<string, string>;
    fixture: Pick<ObservationFixture, "root">;
  },
  restoredDataDir: string,
): Record<string, string> {
  const root = realpathSync(prepared.fixture.root);
  const data = realpathSync(restoredDataDir);
  if (data === root || !data.startsWith(root + sep))
    fail("MANUAL_ENV", "restored data must stay inside the owned fixture root");
  const vault = `${data}-credentials`;
  mkdirSync(vault, {mode: 0o700});
  const vaultReal = realpathSync(vault);
  const stat = lstatSync(vaultReal);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    fail("MANUAL_ENV", "restored vault is not a fresh private directory");
  const env: Record<string, string> = {
    ...prepared.env,
    FOLIO_DATA_DIR: data,
    FOLIO_CREDENTIAL_DIR: vaultReal,
  };
  delete env[CHECKPOINT_OBSERVATION_OPT_IN_ENV];
  delete env[CHECKPOINT_OBSERVATION_BINDING_ENV];
  return env;
}

// ---------------------------------------------------------------------------
// Pure semantic checks (shared with the Node protocol test).

/** Exact intended plain-paragraph check: doc > one paragraph > one unmarked
 * text run. Runtime-generated block ids (attrs) are tolerated here; the
 * frozen post-edit oracle carries the exact doc for reopen/restore compares. */
export function docPlainParagraphText(doc: Doc | null | undefined): string | null {
  if (
    !doc ||
    doc.type !== "doc" ||
    !Array.isArray(doc.content) ||
    doc.content.length !== 1
  )
    return null;
  const block = doc.content[0];
  if (
    !block ||
    block.type !== "paragraph" ||
    !Array.isArray(block.content) ||
    block.content.length !== 1
  )
    return null;
  const run = block.content[0];
  if (!run || run.type !== "text" || typeof run.text !== "string") return null;
  if (Array.isArray(run.marks) && run.marks.length > 0) return null;
  return run.text;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

export const jsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** Read-only scan of the settings rows for the seeded growth limits. The
 * owning settings key is a product detail (NEED_SOURCE if a strict key check
 * is wanted); this check proves the configured limits persisted verbatim
 * without ever writing or migrating the database. */
export function limitsStorageProblems(
  settings: Record<string, string>,
  limits: MacTrialManifest["limits"],
): string[] {
  const raw = settings[GROWTH_LIMITS_SETTINGS_KEY];
  if (typeof raw !== "string")
    return [`missing settings row ${GROWTH_LIMITS_SETTINGS_KEY}`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [`settings row ${GROWTH_LIMITS_SETTINGS_KEY} is not JSON`];
  }
  if (
    !isObject(parsed) ||
    parsed.version !== 1 ||
    parsed.revision !== limits.revision ||
    !isObject(parsed.limits) ||
    !jsonEqual(parsed.limits, limits.configured)
  )
    return [
      `settings row ${GROWTH_LIMITS_SETTINGS_KEY} does not equal ` +
        "{version:1, revision:manifest.limits.revision, limits:manifest.limits.configured}",
    ];
  return [];
}

/** Per-asset oracle for the seeded attachments — not just directory hashes.
 * For every manifest asset: the assets.metadata row exists with the exact
 * size+sha256, the file at storagePath has the exact byte length and sha256,
 * and the product's own resolveAsset path/mime mapping matches. Unknown,
 * missing or extra registry rows fail. Read-only: the database is opened
 * with readOnly:true and no Store constructor runs. */
export function fixtureAssetProblems(
  databaseFile: string,
  workspaceDir: string,
  manifest: MacTrialManifest,
): string[] {
  const problems: string[] = [];
  const db = new DatabaseSync(databaseFile, {readOnly: true});
  try {
    const rows = db
      .prepare("SELECT id,metadata FROM assets")
      .all() as Array<{id: string; metadata: string}>;
    const byId = new Map(rows.map((row) => [row.id, row.metadata]));
    if (byId.size !== manifest.assets.length)
      problems.push(
        `asset registry count ${byId.size} != ${manifest.assets.length}`,
      );
    for (const asset of manifest.assets) {
      const raw = byId.get(asset.id);
      if (raw === undefined) {
        problems.push(`missing asset registry row ${asset.id}`);
      } else {
        let metadata: Record<string, unknown> | null = null;
        try {
          metadata = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          problems.push(`asset ${asset.id} metadata is not JSON`);
        }
        if (metadata) {
          if (metadata.size !== asset.bytes)
            problems.push(`asset ${asset.id} metadata size differs`);
          if (metadata.sha256 !== asset.sha256)
            problems.push(`asset ${asset.id} metadata sha256 differs`);
        }
      }
      const storedPath = join(workspaceDir, ...asset.storagePath.split("/"));
      try {
        const bytes = readFileSync(storedPath);
        if (bytes.length !== asset.bytes)
          problems.push(`asset ${asset.id} byte length differs`);
        if (sha256Bytes(bytes) !== asset.sha256)
          problems.push(`asset ${asset.id} sha256 differs`);
      } catch {
        problems.push(`asset ${asset.id} bytes missing at ${asset.storagePath}`);
      }
      try {
        const resolved = resolveAsset(
          db,
          join(workspaceDir, "assets"),
          asset.url,
        );
        if (resolved.path !== storedPath || resolved.mime !== asset.mime)
          problems.push(`asset ${asset.id} registry resolution differs`);
      } catch {
        problems.push(`asset ${asset.id} url does not resolve`);
      }
    }
    for (const id of byId.keys())
      if (!manifest.assets.some((asset) => asset.id === id))
        problems.push(`unexpected asset registry row ${id}`);
  } finally {
    db.close();
  }
  return problems;
}

/** Compares a live snapshot/database:load/record:read triple against the
 * ORIGINAL seed manifest. The overrides map carries only the post-edit
 * oracle docs/values for the deliberately edited page+record; everything
 * else is compared to the frozen manifest — the live workspace is never
 * promoted to a new oracle wholesale. */
export function fixtureComparisonProblems(options: {
  manifest: MacTrialManifest;
  snapshot: {
    pages: readonly FolioPage[];
    settings: Record<string, string>;
    records?: readonly RecordProjection[];
  };
  database: DatabaseProjection;
  recordReads: ReadonlyMap<
    string,
    {doc?: Doc; values?: Record<string, string | number | boolean>}
  >;
  overrides?: {
    docs?: ReadonlyMap<string, Doc>;
    values?: ReadonlyMap<string, Record<string, string | number | boolean>>;
  };
}): string[] {
  const problems: string[] = [];
  const {manifest, snapshot, database, recordReads, overrides} = options;
  const docFor = (id: string, fallback: Doc) =>
    overrides?.docs?.get(id) ?? fallback;
  const valuesFor = (
    id: string,
    fallback: Record<string, string | number | boolean>,
  ) => overrides?.values?.get(id) ?? fallback;

  const byId = new Map(snapshot.pages.map((page) => [page.id, page]));
  if (snapshot.pages.length !== manifest.expected.totalPages)
    problems.push(
      `page count ${snapshot.pages.length} != manifest.expected.totalPages ${manifest.expected.totalPages}`,
    );
  // Store.load returns ALL pages including record pages: the fixture
  // universe is 10 ordinary + 1 database owner + 20 record pages.
  const expectedIds = new Set<string>([
    manifest.database.id,
    ...manifest.pages.map((page) => page.id),
    ...manifest.records.map((record) => record.id),
  ]);
  for (const id of expectedIds)
    if (!byId.has(id)) problems.push(`missing page ${id}`);
  for (const page of snapshot.pages)
    if (!expectedIds.has(page.id)) problems.push(`unexpected page ${page.id}`);

  for (const expected of manifest.pages) {
    const actual = byId.get(expected.id);
    if (!actual) continue;
    if (actual.title !== expected.title)
      problems.push(`page ${expected.id} title differs`);
    if (actual.parentId !== expected.parentId)
      problems.push(`page ${expected.id} parent differs`);
    if (!jsonEqual(actual.doc, docFor(expected.id, expected.doc)))
      problems.push(`page ${expected.id} doc differs`);
  }

  const owner = byId.get(manifest.database.id);
  if (owner) {
    if (owner.title !== manifest.database.title)
      problems.push("database owner page title differs");
    if (owner.kind !== "database")
      problems.push("database owner page kind differs");
  }

  const expectedSettings = {...(manifest.database.settings as Record<string, unknown>)};
  delete expectedSettings.rows;
  const actualSettings = {...(database.settings as Record<string, unknown>)};
  delete actualSettings.rows;
  if (!jsonEqual(actualSettings, expectedSettings))
    problems.push("database settings differ from the manifest");
  if (!jsonEqual(database.settings.properties, manifest.database.properties))
    problems.push("database properties differ from the manifest");
  const pickView = (view: {id: string; name: string; type: string}) => ({
    id: view.id,
    name: view.name,
    type: view.type,
  });
  if (
    !jsonEqual(
      (database.settings.views ?? []).map(pickView),
      manifest.database.views.map(pickView),
    )
  )
    problems.push("database views differ from the manifest");

  const projections = new Map(
    (snapshot.records ?? []).map((record) => [record.pageId, record]),
  );
  if ((snapshot.records ?? []).length !== manifest.records.length)
    problems.push(
      `record projection count ${(snapshot.records ?? []).length} != ${manifest.records.length}`,
    );
  for (const expected of manifest.records) {
    const projection = projections.get(expected.id);
    if (!projection) {
      problems.push(`missing record projection ${expected.id}`);
    } else {
      if (projection.title !== expected.title)
        problems.push(`record ${expected.id} title differs`);
      if (projection.databasePageId !== manifest.database.id)
        problems.push(`record ${expected.id} database ownership differs`);
      if (projection.deletedAt !== null)
        problems.push(`record ${expected.id} unexpectedly deleted`);
      if (!jsonEqual({...projection.values}, valuesFor(expected.id, {...expected.values})))
        problems.push(`record ${expected.id} values differ`);
    }
    const recordPage = byId.get(expected.id);
    if (recordPage) {
      if (recordPage.title !== expected.title)
        problems.push(`record page ${expected.id} title differs`);
      if (!jsonEqual(recordPage.doc, docFor(expected.id, expected.doc)))
        problems.push(`record page ${expected.id} doc differs`);
    }
    const read = recordReads.get(expected.id);
    if (!read?.doc) {
      problems.push(`record ${expected.id} lacks a record:read body`);
      continue;
    }
    if (!jsonEqual(read.doc, docFor(expected.id, expected.doc)))
      problems.push(`record ${expected.id} body doc differs`);
    if (
      read.values &&
      !jsonEqual({...read.values}, valuesFor(expected.id, {...expected.values}))
    )
      problems.push(`record ${expected.id} record:read values differ`);
  }

  if (snapshot.settings.activePage !== manifest.activePage)
    problems.push("settings.activePage differs from the manifest");
  return problems;
}

/** All paragraph texts of a doc — the semantic text view used by goal
 * matching (structure-preserving, never a substring scan). */
export function docParagraphTexts(doc: unknown): string[] {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (!isObject(node)) return;
    if (node.type === "paragraph")
      texts.push(
        ((node.content as unknown[]) ?? [])
          .map((run) =>
            isObject(run) && run.type === "text" && typeof run.text === "string"
              ? run.text
              : "",
          )
          .join(""),
      );
    if (Array.isArray(node.content))
      for (const child of node.content as unknown[])
        if (!(isObject(child) && child.type === "text")) walk(child);
  };
  if (isObject(doc) && Array.isArray(doc.content))
    for (const child of doc.content as unknown[]) walk(child);
  return texts;
}

/** Exact ordered top-level plain-paragraph semantic: doc.content must be
 * exactly `expected.length` paragraph blocks in the same order; every child
 * of each paragraph must be an unmarked text node (adjacent runs are
 * concatenated); an empty paragraph may carry no `content` key or an empty
 * array. Runtime-generated block attrs are ignored; a wrong count or order,
 * a nested non-text child, any mark, or a non-paragraph top-level block all
 * fail — never a substring or unordered-containment check. */
export function docOrderedPlainParagraphs(
  doc: unknown,
  expected: readonly string[],
): boolean {
  if (!isObject(doc) || doc.type !== "doc" || !Array.isArray(doc.content))
    return false;
  if (doc.content.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const block = doc.content[index];
    if (!isObject(block) || block.type !== "paragraph") return false;
    if (block.content === undefined) {
      if (expected[index] !== "") return false;
      continue;
    }
    if (!Array.isArray(block.content)) return false;
    let text = "";
    for (const run of block.content) {
      if (!isObject(run) || run.type !== "text" || typeof run.text !== "string")
        return false;
      if (Array.isArray(run.marks) && run.marks.length > 0) return false;
      text += run.text;
    }
    if (text !== expected[index]) return false;
  }
  return true;
}

export type AckGoal = Readonly<{
  /** Exact entry base.id. */
  pageId: string;
  /** Exact retained inflight operationId. */
  operationId?: string;
  /** Whole frozen operation — deep-exact when provided. */
  operation?: Record<string, unknown>;
  /** Effective CURRENT title after the seq-ordered merge. */
  title?: string;
  /** Paragraph texts the effective doc must contain exactly. */
  bodyTexts?: readonly string[];
  /** Effective doc, deep-exact when provided. */
  doc?: Doc;
}>;

/** Typed ACK target check — NOT a substring scan. Selects the entry by exact
 * base.id, requires the exact retained operationId / whole frozen operation,
 * then merges base → inflight operation.patch → later intents in seq order
 * (intents already covered by the operation at seq <= operation.seq are
 * skipped, so an old patch is never re-applied over the new operation) into
 * the CURRENT effective title/doc and compares the goal exactly. A stale
 * matching value that a later intent overwrote, or an operationId string
 * that merely appears in an unrelated field, cannot pass. */
export function ackSnapshotMatchesGoal(
  snapshotJson: unknown,
  goal: AckGoal,
): boolean {
  if (typeof snapshotJson !== "string") return false;
  let parsed: {
    pages?: Array<Record<string, unknown>>;
    records?: Array<Record<string, unknown>>;
  };
  try {
    parsed = JSON.parse(snapshotJson) as typeof parsed;
  } catch {
    return false;
  }
  const entry = [...(parsed.pages ?? []), ...(parsed.records ?? [])].find(
    (candidate) =>
      (candidate?.base as {id?: unknown} | undefined)?.id === goal.pageId,
  );
  if (!entry) return false;
  const operation = entry.operation as Record<string, unknown> | undefined;
  if (goal.operationId !== undefined && operation?.operationId !== goal.operationId)
    return false;
  if (
    goal.operation !== undefined &&
    !jsonEqual(operation ?? null, goal.operation)
  )
    return false;
  const operationSeq = typeof operation?.seq === "number" ? operation.seq : 0;
  const intents = (
    (entry.intents as Array<Record<string, unknown>> | undefined) ?? []
  )
    .slice()
    .sort((a, b) => ((a.seq as number) ?? 0) - ((b.seq as number) ?? 0));
  let title = (entry.base as {title?: unknown})?.title;
  let doc = (entry.base as {doc?: unknown})?.doc;
  const applyPatch = (patch: unknown) => {
    if (!isObject(patch)) return;
    if (patch.title !== undefined) title = patch.title;
    if (patch.doc !== undefined) doc = patch.doc;
  };
  applyPatch(operation?.patch);
  for (const intent of intents) {
    const seq = typeof intent.seq === "number" ? intent.seq : 0;
    if (seq <= operationSeq) continue; // already inside the operation
    applyPatch(intent.patch);
  }
  if (goal.title !== undefined && title !== goal.title) return false;
  if (goal.doc !== undefined && !jsonEqual(doc, goal.doc)) return false;
  if (
    goal.bodyTexts !== undefined &&
    !docOrderedPlainParagraphs(doc, goal.bodyTexts)
  )
    return false;
  return true;
}

export function ackAppliedEvents(
  sample: unknown,
): Array<{index: number; seq: number; generation: number; snapshotJson: string}> {
  const events = (sample as {observation?: {events?: unknown}} | null)?.observation
    ?.events;
  if (!Array.isArray(events)) return [];
  return events.filter(
    (event): event is {index: number; seq: number; generation: number; snapshotJson: string} =>
      isObject(event) && event.type === "ACK_APPLIED",
  );
}

export function verifyExportFile(options: {
  format: "md" | "html" | "json";
  path: string;
  title: string;
  mustContain: readonly string[];
  /** Unique strings that must NOT appear (other pages/records' content) so a
   * whole-workspace or wrong-page export is rejected, not merely searched. */
  mustNotContain?: readonly string[];
  /** Exact single-page oracle for JSON exports: the product writes exactly
   * JSON.stringify(page) — id/title/doc must equal the validated oracle. */
  expectedPage?: {id: string; doc?: Doc};
  /** Exact expected body text for the fixed plain single-paragraph export
   * profile. When set, md/html are compared SEMANTICALLY — marker + display
   * title + exactly one paragraph node — never substring/blacklist. */
  expectedBody?: string;
}): {bytes: number; sha256: string; problems: string[]} {
  const problems: string[] = [];
  const stat = lstatSync(options.path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1) {
    return {
      bytes: 0,
      sha256: "",
      problems: ["export output is not a non-empty regular file"],
    };
  }
  const text = readFileSync(options.path).toString("utf8");
  for (const needle of [options.title, ...options.mustContain])
    if (!text.includes(needle))
      problems.push(`export is missing intended text: ${needle}`);
  for (const needle of options.mustNotContain ?? [])
    if (text.includes(needle))
      problems.push(`export contains out-of-scope content: ${needle}`);
  if (options.format === "md") {
    if (options.expectedBody !== undefined) {
      // Exact owning format (src export boundary): a versioned marker with
      // the percent-encoded title, then the display H1, then the body. The
      // whole file must equal the planned single-paragraph document — a
      // foreign body, an extra paragraph or a wrong heading all fail.
      const expected =
        `<!-- folio:markdown:v1 title=${encodeURIComponent(options.title)} -->\n` +
        `# ${options.title}\n\n${options.expectedBody}`;
      if (text !== expected && text !== `${expected}\n`)
        problems.push(
          "markdown export is not exactly the planned single-paragraph document",
        );
    } else if (!text.includes("<!-- folio:markdown:v1")) {
      problems.push("markdown export lacks the folio marker");
    }
    if (text.includes("base64"))
      problems.push("markdown export embeds a base64 payload");
  } else if (options.format === "html") {
    if (options.expectedBody !== undefined) {
      // Semantic exact: doctype/html, sanitized <title>, and a body that is
      // EXACTLY one paragraph element whose text equals the planned body
      // (opaque generated block attributes on <p> are tolerated).
      const sanitized = options.title.replace(/[<>&"]/g, "");
      const bodyInner = text.match(/<body>([\s\S]*)<\/body>/)?.[1]?.trim();
      const para = bodyInner?.match(/^<p\b[^>]*>([\s\S]*)<\/p>$/);
      if (
        !text.startsWith("<!doctype html") ||
        !text.includes(`<title>${sanitized}</title>`) ||
        !para ||
        para[1] !== options.expectedBody
      )
        problems.push(
          "html export is not exactly the planned single-paragraph document",
        );
    } else if (!/<[a-zA-Z][^>]*>/.test(text)) {
      problems.push("html export contains no markup");
    }
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        bytes: stat.size,
        sha256: sha256File(options.path),
        problems: [...problems, "json export does not parse"],
      };
    }
    // Whole-workspace or multi-page JSON is a scope violation, not a pass.
    if (!isObject(parsed) || Array.isArray(parsed.pages) || Array.isArray(parsed.records))
      problems.push("json export is not the single expected page");
    else {
      if (options.expectedPage && parsed.id !== options.expectedPage.id)
        problems.push("json export page id differs from the exported page");
      if (parsed.title !== options.title)
        problems.push("json export title differs");
      if (
        options.expectedPage?.doc &&
        !jsonEqual(parsed.doc, options.expectedPage.doc)
      )
        problems.push("json export doc differs from the validated oracle");
      if (!options.expectedPage && typeof parsed.id !== "string")
        problems.push("json export lacks a page id");
    }
  }
  return {bytes: stat.size, sha256: sha256File(options.path), problems};
}
