// Host-side helpers for the packaged-Mac checkpoint observation capture.
// Import-safe and launch-free: no Electron import, no process spawn/kill. The
// spec owns _electron.launch; this module verifies the existing intent/
// candidate/owned-shutdown contracts, seeds a fresh private fixture, binds a
// per-run observation env, and captures read-only samples via Page.evaluate.
import {createHash, randomUUID} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {dirname, isAbsolute, join, sep} from "node:path";
import type {Page} from "@playwright/test";
import {seedMacTrial, type MacTrialManifest} from "../../scripts/mac-trial-seed";
import {fixtureElectronOptions, fixtureRoot} from "./fixture-isolation";
// @ts-ignore: untyped .mjs sibling, same pattern as fixture-isolation.ts
import {assertPrivateTempDirectory} from "../../scripts/mac-acceptance/policy/guard.mjs";
// @ts-ignore: untyped .mjs sibling, same pattern as fixture-isolation.ts
import {readEvidenceIntent} from "../../scripts/write-evidence-manifest.mjs";
import {
  CHECKPOINT_OBSERVATION_BINDING_ENV,
  CHECKPOINT_OBSERVATION_BINDING_SCHEMA,
  CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_TOTAL_BYTES,
  CHECKPOINT_OBSERVATION_OPT_IN_ENV,
  GUI_TEST_OPT_IN_ENV,
  canonicalJson,
  utf8Length,
  validateCheckpointObservationRead,
  type CheckpointObservationBinding,
  type CheckpointObservationRead,
  type CheckpointObservationValidation,
} from "../../src/shared/checkpoint-observation";

export const OBSERVATION_INTENT_ENV = "FOLIO_CHECKPOINT_OBSERVATION_INTENT";
export const OBSERVATION_CANDIDATE_ENV = "FOLIO_CHECKPOINT_OBSERVATION_CANDIDATE";
export const OWNED_REQUEST_ENV = "FOLIO_OWNED_SHUTDOWN_REQUEST";

const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SAMPLE_BYTES = 2 * CHECKPOINT_OBSERVATION_MAX_SNAPSHOT_TOTAL_BYTES + 1024 * 1024;
const EXECUTABLE_RELATIVE = "Folio.app/Contents/MacOS/Folio";

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const sha256Bytes = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path: string) => sha256Bytes(readFileSync(path));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeImmutable(path: string, text: string) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function boundedJsonFile(path: unknown, maxBytes: number, code: string) {
  if (typeof path !== "string" || !isAbsolute(path)) fail(code, "an absolute path is required");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(code, "a regular file is required");
  if (stat.size < 1 || stat.size > maxBytes) fail(code, "file size is out of bounds");
  const bytes = readFileSync(path);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code, "file is not JSON");
  }
  if (!isObject(value)) fail(code, "JSON object expected");
  return {value, bytes, sha256: sha256Bytes(bytes)};
}

export type OwnedShutdownRequest = Readonly<{
  v: 1;
  runId: string;
  runRoot: string;
  nodeExe: string;
  nodeSha256: string;
  timeoutMs: number;
  expiresAt: string;
}>;

/** Requires the existing exact GUI opt-in, the existing local-batch marker
 * (FOLIO_LOCAL_GUI_BATCH=1) and the frozen owned-shutdown request whose
 * runRoot is the actual approved private FOLIO_LOCAL_GUI_DATA_ROOT, whose
 * pinned node binary still hashes identically, and whose authorization window
 * is current. Presence/shape/pin gate only — the product's own install
 * performs the full request validation and remains the lifecycle authority;
 * nothing here starts a monitor and the request is kept unchanged in env. */
export function requireOwnedShutdownGate(env: NodeJS.ProcessEnv): OwnedShutdownRequest {
  if (env[GUI_TEST_OPT_IN_ENV] !== "1")
    fail("OBS_GUI_OPT_IN", "the exact GUI batch opt-in is required");
  if (env.FOLIO_LOCAL_GUI_BATCH !== "1")
    fail("OBS_LOCAL_BATCH", "the existing local batch marker is required");
  const dataRoot = env.FOLIO_LOCAL_GUI_DATA_ROOT;
  if (typeof dataRoot !== "string" || !isAbsolute(dataRoot))
    fail("OBS_LOCAL_BATCH", "the approved local data root is required");
  const approvedRoot = assertPrivateTempDirectory(dataRoot) as string;
  const raw = env[OWNED_REQUEST_ENV];
  if (typeof raw !== "string" || raw.length === 0)
    fail("OBS_OWNED_REQUEST", "the existing owned shutdown request is required");
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch {
    fail("OBS_OWNED_REQUEST", "request is not JSON");
  }
  const value = request as Record<string, unknown>;
  const expectedKeys = ["expiresAt", "nodeExe", "nodeSha256", "runId", "runRoot", "timeoutMs", "v"];
  const keys = isObject(value) ? Object.keys(value).sort() : [];
  if (keys.length !== expectedKeys.length || !expectedKeys.every((key, index) => keys[index] === key))
    fail("OBS_OWNED_REQUEST", "request keys differ from the existing frozen schema");
  if (!isObject(value) || value.v !== 1 ||
      typeof value.runId !== "string" || !RUN_ID.test(value.runId) ||
      typeof value.runRoot !== "string" || !isAbsolute(value.runRoot) ||
      typeof value.nodeExe !== "string" || !isAbsolute(value.nodeExe) ||
      typeof value.nodeSha256 !== "string" || !HASH.test(value.nodeSha256) ||
      !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > 300000 ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now())
    fail("OBS_OWNED_REQUEST", "request does not match the existing frozen shape");
  if (realpathSync(value.runRoot as string) !== approvedRoot)
    fail("OBS_OWNED_REQUEST", "request runRoot is not the approved batch root");
  const nodeExe = realpathSync(value.nodeExe as string);
  const nodeStat = lstatSync(nodeExe);
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink() ||
      (typeof nodeStat.nlink === "number" && nodeStat.nlink !== 1) ||
      sha256File(nodeExe) !== value.nodeSha256)
    fail("OBS_OWNED_REQUEST", "pinned node binary does not match the request");
  return Object.freeze({
    v: 1,
    runId: value.runId as string,
    runRoot: approvedRoot,
    nodeExe,
    nodeSha256: value.nodeSha256 as string,
    timeoutMs: value.timeoutMs as number,
    expiresAt: value.expiresAt as string,
  });
}

export type IntentEvidence = Readonly<{
  runRoot: string;
  intentPath: string;
  intent: Record<string, unknown>;
  manifest: Record<string, unknown>;
}>;

type IntentBody = {
  runId: string;
  binding: {artifactSha256: string; manifestSha256?: string};
  selection: {root: string};
};

/** Reads the immutable run intent through the existing evidence reader, which
 * re-verifies the CURRENT package artifacts and binding on every call. */
export function readIntentEvidence(intentPath: unknown): IntentEvidence {
  if (typeof intentPath !== "string" || !isAbsolute(intentPath))
    fail("OBS_INTENT", "an absolute intent path is required");
  return readEvidenceIntent(intentPath) as IntentEvidence;
}

const FREEZER_CONFIG_FILES = [
  "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts",
  "vite.config.ts", "playwright.config.ts", "playwright.linux-ci.config.ts",
  "playwright.remote-mac.config.ts", "AGENTS.md", ".gitignore",
];
const FREEZER_EXTRA_FILES = [
  "index.html", "playwright.dev-round3.config.ts", "playwright.local-native.config.ts",
];
const FREEZER_SOURCE_DIRS = ["src", "tests", "scripts"];
const FREEZER_INPUT_DIRS = ["assets", "public", "resources"];

const safeEntryPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096 &&
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
  value.split("/").every((segment) => segment !== "" && segment !== "..");

function walkRegularFiles(root: string, relativeDir: string, into: Set<string>) {
  let entries;
  try {
    entries = readdirSync(join(root, ...relativeDir.split("/")), {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) walkRegularFiles(root, rel, into);
    else {
      const stat = lstatSync(join(root, ...rel.split("/")));
      if (stat.isFile() && !stat.isSymbolicLink()) into.add(rel);
    }
  }
}

function freezerUniverse(root: string): {entries: Set<string>; inputs: Set<string>} {
  const entries = new Set<string>();
  for (const dir of FREEZER_SOURCE_DIRS) walkRegularFiles(root, dir, entries);
  // The owning freezer declares every fixed config unconditionally: a missing
  // or non-regular one means this tree was never a valid freezer input.
  for (const name of FREEZER_CONFIG_FILES) {
    try {
      const stat = lstatSync(join(root, name));
      if (stat.isSymbolicLink() || !stat.isFile())
        fail("OBS_CANDIDATE", `freezer config is not a regular file: ${name}`);
      entries.add(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        fail("OBS_CANDIDATE", `freezer config is missing: ${name}`);
      throw error;
    }
  }
  // Extra configs and assets/public/resources belong to additionalBuildInputs
  // only; they are never part of the canonical entries aggregate universe.
  const inputs = new Set<string>();
  for (const name of FREEZER_EXTRA_FILES) {
    try {
      const stat = lstatSync(join(root, name));
      if (stat.isFile() && !stat.isSymbolicLink()) inputs.add(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const dir of FREEZER_INPUT_DIRS) walkRegularFiles(root, dir, inputs);
  return {entries, inputs};
}

type CandidateEntry = {path: string; bytes: number; sha256: string};

function candidateEntries(value: unknown, label: string): CandidateEntry[] {
  if (!Array.isArray(value)) fail("OBS_CANDIDATE", `${label} must be an array`);
  const seen = new Set<string>();
  const entries: CandidateEntry[] = [];
  for (const entry of value as Array<Record<string, unknown>>) {
    if (!isObject(entry) || !safeEntryPath(entry.path) || seen.has(entry.path) ||
        !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 ||
        typeof entry.sha256 !== "string" || !HASH.test(entry.sha256))
      fail("OBS_CANDIDATE", `${label} entry has an invalid or unsafe shape`);
    seen.add(entry.path);
    entries.push({path: entry.path, bytes: entry.bytes as number, sha256: entry.sha256});
  }
  return entries;
}

function verifyEntries(root: string, entries: CandidateEntry[], expected: Set<string>, label: string) {
  const declared = new Set<string>();
  for (const entry of entries) {
    declared.add(entry.path);
    const actual = realpathSync(join(root, ...entry.path.split("/")));
    if (actual !== root && !actual.startsWith(root + sep))
      fail("OBS_CANDIDATE", `${label} path escapes the source root: ${entry.path}`);
    const stat = lstatSync(actual);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== entry.bytes || sha256File(actual) !== entry.sha256)
      fail("OBS_CANDIDATE", `${label} entry does not match the real file: ${entry.path}`);
  }
  if (declared.size !== expected.size || [...expected].some((path) => !declared.has(path)))
    fail("OBS_CANDIDATE", `${label} membership does not equal the actual freezer universe`);
}

export type VerifiedCandidate = Readonly<{
  candidatePath: string;
  executablePath: string;
  candidateSha256: string;
  candidateFileSha256: string;
  manifestSha256: string;
  artifactSha256: string;
  candidate: Record<string, unknown>;
}>;

/** Canonical candidate verification: the declared candidateSha256 must be the
 * sha256 of canonicalJson(entries) ONLY, every entry must be a safe path whose
 * real file matches its declared bytes/sha256, and declared membership must
 * equal the actual freezer universe (fixed configs, all regular files under
 * src/tests/scripts, declared extras; assets/public/resources live in
 * additionalBuildInputs). Package-manifest source entries are matched by
 * path/hash; dist and docs/THIRD_PARTY_NOTICES.txt stay separately
 * package-verified and aggregate manifest digests are never compared. The
 * .app executable derives solely from the verified package manifest. */
export function verifyObservationCandidate(
  candidatePath: unknown,
  evidence: IntentEvidence,
): VerifiedCandidate {
  if (process.platform !== "darwin")
    fail("OBS_TARGET", "checkpoint observation capture targets the packaged Mac build");
  const file = boundedJsonFile(candidatePath, MAX_MANIFEST_BYTES, "OBS_CANDIDATE");
  const candidate = file.value;
  const intent = evidence.intent as unknown as IntentBody;
  const manifest = evidence.manifest as {
    plan?: Record<string, unknown>;
    artifact?: Record<string, unknown>;
    files?: Array<{path?: unknown; sha256?: unknown}>;
    source?: Array<{path?: unknown; sha256?: unknown}>;
  };
  if (!manifest.plan || !manifest.artifact || !Array.isArray(manifest.files))
    fail("OBS_INTENT", "verified package manifest is incomplete");
  if (manifest.plan.platform !== "darwin" || manifest.plan.arch !== process.arch)
    fail("OBS_TARGET", "host OS/arch must match the declared Mac target");
  if (manifest.artifact.sha256 !== intent.binding.artifactSha256)
    fail("OBS_INTENT", "verified artifact differs from the intent binding");
  const entries = candidateEntries(candidate.entries, "entries");
  const candidateAggregate = candidate.candidateSha256;
  if (typeof candidateAggregate !== "string" || !HASH.test(candidateAggregate) ||
      sha256Bytes(canonicalJson(entries)) !== candidateAggregate)
    fail("OBS_CANDIDATE", "candidate aggregate does not recompute");
  const additional = candidateEntries(candidate.additionalBuildInputs ?? [], "additionalBuildInputs");
  const sourceRoot = realpathSync(intent.selection.root);
  const universe = freezerUniverse(sourceRoot);
  verifyEntries(sourceRoot, entries, universe.entries, "entries");
  verifyEntries(sourceRoot, additional, universe.inputs, "additionalBuildInputs");
  const declared = new Map(entries.map((entry) => [entry.path, entry.sha256]));
  for (const entry of manifest.source ?? []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0 ||
        typeof entry.sha256 !== "string" || !HASH.test(entry.sha256))
      fail("OBS_CANDIDATE", "package source entry has an invalid shape");
    const absolute = isAbsolute(entry.path) ? entry.path : join(sourceRoot, ...entry.path.split("/"));
    const actual = realpathSync(absolute);
    if (!actual.startsWith(sourceRoot + sep))
      fail("OBS_CANDIDATE", `package source escapes the selection root: ${entry.path}`);
    const stat = lstatSync(actual);
    if (stat.isSymbolicLink() || !stat.isFile() || sha256File(actual) !== entry.sha256)
      fail("OBS_CANDIDATE", `package source file changed: ${entry.path}`);
    const declaredHash = declared.get(entry.path);
    if (declaredHash !== undefined && declaredHash !== entry.sha256)
      fail("OBS_CANDIDATE", `package source hash differs from the candidate: ${entry.path}`);
  }
  const outputRoot = realpathSync(String(manifest.plan.outputDir));
  const packageFiles = new Map<string, string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !HASH.test(entry.sha256))
      fail("OBS_CANDIDATE", "package file entry has an invalid shape");
    packageFiles.set(entry.path, entry.sha256);
    const actual = realpathSync(join(outputRoot, entry.path));
    if (actual !== outputRoot && !actual.startsWith(outputRoot + sep))
      fail("OBS_CANDIDATE", `package file escapes the output root: ${entry.path}`);
    if (!lstatSync(actual).isFile() || sha256File(actual) !== entry.sha256)
      fail("OBS_CANDIDATE", `package file changed since the manifest: ${entry.path}`);
  }
  const executablePath = realpathSync(join(outputRoot, EXECUTABLE_RELATIVE));
  if (!lstatSync(executablePath).isFile() ||
      packageFiles.get(EXECUTABLE_RELATIVE) !== sha256File(executablePath))
    fail("OBS_CANDIDATE", "the .app executable differs from the verified manifest");
  return Object.freeze({
    candidatePath: realpathSync(candidatePath as string),
    executablePath,
    candidateSha256: candidateAggregate,
    candidateFileSha256: file.sha256,
    manifestSha256: String(intent.binding.manifestSha256 ?? ""),
    artifactSha256: intent.binding.artifactSha256,
    candidate: file.value,
  });
}export type ObservationFixture = Readonly<{
  root: string;
  data: string;
  vault: string;
  evidenceDir: string;
  fixtureManifestPath: string;
  fixtureSha256: string;
  manifest: MacTrialManifest;
}>;

/** Fresh seedMacTrial inside the wrapper-owned private root; the generated
 * input manifest is frozen with wx BEFORE launch and fixtureSha256 is the
 * hash of those exact new bytes. Data, vault and the evidence dir are strict
 * private descendants of the same approved root. No real data is copied. */
export function prepareObservationFixture(env: NodeJS.ProcessEnv = process.env): ObservationFixture {
  const root = fixtureRoot("checkpoint-observation-", env);
  const ownedRoot = assertPrivateTempDirectory(root, dirname(root)) as string;
  const data = join(ownedRoot, "workspace");
  const manifest = seedMacTrial(data);
  chmodSync(data, 0o700);
  const vault = `${data}-credentials`;
  mkdirSync(vault, {mode: 0o700});
  const evidenceDir = join(ownedRoot, "evidence");
  mkdirSync(evidenceDir, {mode: 0o700});
  const realData = assertPrivateTempDirectory(data, ownedRoot) as string;
  const realVault = assertPrivateTempDirectory(vault, ownedRoot) as string;
  const realEvidence = assertPrivateTempDirectory(evidenceDir, ownedRoot) as string;
  const fixtureManifestPath = join(realEvidence, "fixture-manifest.json");
  writeImmutable(fixtureManifestPath, `${canonicalJson(manifest)}\n`);
  return Object.freeze({
    root: ownedRoot,
    data: realData,
    vault: realVault,
    evidenceDir: realEvidence,
    fixtureManifestPath,
    fixtureSha256: sha256File(fixtureManifestPath),
    manifest,
  });
}

/** Bound env for the packaged launch: the existing fixture env derivation
 * (which strips sync/debug keys and pins FOLIO_DATA_DIR/FOLIO_CREDENTIAL_DIR)
 * plus the observation opt-in and the canonical bounded binding JSON. */
export function buildObservationEnv(
  fixture: Pick<ObservationFixture, "data">,
  binding: CheckpointObservationBinding,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base = fixtureElectronOptions(fixture.data, env).env;
  return {
    ...base,
    [CHECKPOINT_OBSERVATION_OPT_IN_ENV]: "1",
    [CHECKPOINT_OBSERVATION_BINDING_ENV]: canonicalJson(binding),
  };
}

export type PreparedObservation = Readonly<{
  request: OwnedShutdownRequest;
  evidence: IntentEvidence;
  candidate: VerifiedCandidate;
  fixture: ObservationFixture;
  binding: CheckpointObservationBinding;
  executablePath: string;
  env: Record<string, string>;
}>;

/** Full host preparation for one packaged observation run: existing gate →
 * verified intent → candidate correlation → fresh fixture → per-run binding →
 * launch env. All actual paths stay inside the wrapper-owned private root;
 * nothing is launched, monitored or terminated here. */
export function prepareCheckpointObservation(
  {env = process.env}: {env?: NodeJS.ProcessEnv} = {},
): PreparedObservation {
  const request = requireOwnedShutdownGate(env);
  const evidence = readIntentEvidence(env[OBSERVATION_INTENT_ENV]);
  const candidate = verifyObservationCandidate(env[OBSERVATION_CANDIDATE_ENV], evidence);
  const fixture = prepareObservationFixture(env);
  const launch = fixtureElectronOptions(fixture.data, env);
  const intent = evidence.intent as unknown as IntentBody;
  const binding: CheckpointObservationBinding = Object.freeze({
    schema: CHECKPOINT_OBSERVATION_BINDING_SCHEMA,
    runId: intent.runId,
    nonce: randomUUID(),
    sourceCandidate: candidate.candidateSha256,
    artifactSha256: intent.binding.artifactSha256,
    fixtureSha256: fixture.fixtureSha256,
    dataDir: launch.env.FOLIO_DATA_DIR,
    vaultDir: launch.env.FOLIO_CREDENTIAL_DIR,
  });
  const boundEnv = buildObservationEnv(fixture, binding, env);
  return Object.freeze({
    request,
    evidence,
    candidate,
    fixture,
    binding,
    executablePath: candidate.executablePath,
    env: boundEnv,
  });
}

export type ObservationCaptureContext = Readonly<{
  intentPath: string;
  candidatePath: string;
  candidateFileSha256: string;
  binding: CheckpointObservationBinding;
  fixture: ObservationFixture;
}>;

/** Extracts the immutable context capture-time revalidation needs. */
export function observationCaptureContext(prepared: PreparedObservation): ObservationCaptureContext {
  return Object.freeze({
    intentPath: prepared.evidence.intentPath,
    candidatePath: prepared.candidate.candidatePath,
    candidateFileSha256: prepared.candidate.candidateFileSha256,
    binding: prepared.binding,
    fixture: prepared.fixture,
  });
}

export type CapturedSample = Readonly<{
  samplePath: string;
  sampleSha256: string;
  capturedAt: string;
  sample: CheckpointObservationRead | null;
  validation: CheckpointObservationValidation;
}>;

function revalidateFixture(fixture: ObservationFixture) {
  for (const dir of [fixture.data, fixture.vault, fixture.evidenceDir])
    assertPrivateTempDirectory(dir, fixture.root);
  if (typeof process.getuid !== "function")
    fail("OBS_FIXTURE", "file owner uid check is unavailable on this host");
  const stat = lstatSync(fixture.fixtureManifestPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid())
    fail("OBS_FIXTURE", "fixture manifest is not a private regular file");
  if (sha256File(fixture.fixtureManifestPath) !== fixture.fixtureSha256)
    fail("OBS_FIXTURE", "frozen fixture input manifest drifted");
}

function evidenceOutputPath(fixture: ObservationFixture, basename: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(basename))
    fail("OBS_OUTPUT", "invalid evidence basename");
  const dir = assertPrivateTempDirectory(fixture.evidenceDir, fixture.root) as string;
  return join(dir, basename);
}

/** One read-only sample through page.evaluate of the frozen read port. The
 * immutable context is revalidated against the CURRENT filesystem before the
 * read and again before committing the sample into the owned evidence dir:
 * intent TTL and current artifact/binding via the existing reader, candidate
 * bytes and package files, the frozen fixture-manifest bytes and the private
 * data/vault/evidence dirs. Live database bytes are never compared. A fake
 * page can exercise this path in Node tests but is never proof a real app
 * produced anything. */
export async function captureCheckpointObservationSample(options: {
  page: Page;
  context: ObservationCaptureContext;
  basename?: string;
}): Promise<CapturedSample> {
  const context = options.context;
  const samplePath = evidenceOutputPath(context.fixture, options.basename ?? "checkpoint-observation-sample.json");
  const revalidate = () => {
    const evidence = readIntentEvidence(context.intentPath);
    const intent = evidence.intent as unknown as IntentBody;
    if (intent.runId !== context.binding.runId ||
        intent.binding.artifactSha256 !== context.binding.artifactSha256)
      fail("OBS_CONTEXT", "current intent no longer matches the declared binding");
    const candidate = verifyObservationCandidate(context.candidatePath, evidence);
    if (candidate.candidateFileSha256 !== context.candidateFileSha256 ||
        candidate.candidateSha256 !== context.binding.sourceCandidate)
      fail("OBS_CONTEXT", "candidate changed since preparation");
    if (context.binding.fixtureSha256 !== context.fixture.fixtureSha256 ||
        context.binding.dataDir !== context.fixture.data ||
        context.binding.vaultDir !== context.fixture.vault)
      fail("OBS_CONTEXT", "declared binding does not match the frozen fixture");
    revalidateFixture(context.fixture);
  };
  revalidate();
  const raw = await options.page.evaluate(() =>
    (globalThis as {folioCheckpointObservation?: {read?: () => unknown}})
      .folioCheckpointObservation?.read?.() ?? null);
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  if (utf8Length(text) > MAX_SAMPLE_BYTES)
    fail("OBS_SAMPLE", "sample exceeds the bounded capture size");
  revalidate();
  writeImmutable(samplePath, text);
  const validation = validateCheckpointObservationRead(raw, {binding: context.binding});
  return Object.freeze({
    samplePath,
    sampleSha256: sha256File(samplePath),
    capturedAt: new Date().toISOString(),
    sample: (raw ?? null) as CheckpointObservationRead | null,
    validation,
  });
}
