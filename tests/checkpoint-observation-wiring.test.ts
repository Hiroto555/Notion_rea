// Wiring regression checks on the meaningful subtrees of the touched product
// files plus the launch-free surface of the host harness, and a real
// canonical-binding round trip through the shared parser. Not copy tests:
// each assertion binds the observation hook to the existing save/ACK code.
import {beforeEach, expect, it, vi} from "vitest";
import * as ts from "typescript";
import {createHash} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import type {Page} from "@playwright/test";
import {fileURLToPath} from "node:url";
// @ts-ignore: untyped .mjs sibling, vi.mock'd for Node-only contract checks
import {readEvidenceIntent} from "../scripts/write-evidence-manifest.mjs";
import type {ObservationCaptureContext} from "./e2e/checkpoint-observation-harness";
import {canonicalJson, parseCheckpointObservationBindingJson} from "../src/shared/checkpoint-observation";

vi.mock("../scripts/write-evidence-manifest.mjs", () => ({readEvidenceIntent: vi.fn()}));
const readIntentMock = vi.mocked(readEvidenceIntent as unknown as (...args: unknown[]) => unknown);

beforeEach(() => {
  readIntentMock.mockReset();
});

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

function extractBlock(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start < 0) throw new Error(`missing: ${signature}`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error(`unbalanced block: ${signature}`);
}

it("wires the observation option into the existing enableRecovery without changing its lifecycle", () => {
  const app = source("src/renderer/App.tsx");
  const enable = extractBlock(app, "function enableRecovery(generation: number)");
  expect(enable).toContain("new RecoveryCheckpoint(api, generation, setRecoveryStatus");
  expect(enable).toContain('diagnostics: "v1"');
  expect(enable).toContain("beginCheckpointObservation(() => recoveryQueue.current)");
  expect(enable).toContain("recoveryEnabled.current = true");
  expect(enable).toContain("setRecoveryStatus(recoveryQueue.current.getStatus())");
  const construction = enable.slice(enable.indexOf("new RecoveryCheckpoint"));
  expect(construction).not.toContain("flush(");
  expect(construction).not.toContain("retry(");
  expect(app).toContain('from "./checkpoint-observation"');
});

it("exposes the observation config separately from the untouched folio bridge", () => {
  const preload = source("src/preload/index.ts");
  const folio = extractBlock(preload, 'contextBridge.exposeInMainWorld("folio", {');
  expect(folio).toContain("shared:createSharedRuntimeBridge");
  expect(folio).toContain("createPrivateRequestPreload");
  expect(folio).not.toContain("Observation");
  expect(preload).toContain('exposeInMainWorld("folioCheckpointObservationConfig"');
  expect(preload).toContain("checkpointObservationConfigFromEnv(process.env)");
  const expose = preload.indexOf('exposeInMainWorld("folioCheckpointObservationConfig"');
  const guard = preload.lastIndexOf("try", expose);
  expect(guard).toBeGreaterThan(-1);
  expect(preload.indexOf("catch", expose)).toBeGreaterThan(expose);
});

it("records observation only at the offer assignment and the accepted-ACK branch", () => {
  const checkpoint = source("src/renderer/recovery-checkpoint.ts");
  const offer = extractBlock(checkpoint, "offer(snapshot: CrashRecoverySnapshot): number");
  const offerAssign = offer.indexOf("this.pending = {seq, snapshot: captured};");
  const offerRecord = offer.indexOf('recordObservation("OFFERED"');
  expect(offerAssign).toBeGreaterThan(-1);
  expect(offerRecord).toBeGreaterThan(offerAssign);
  expect(offerRecord).toBeLessThan(offer.indexOf("this.notify(); this.schedule();"));
  expect(checkpoint.match(/recordObservation\("OFFERED"/g)).toHaveLength(1);
  expect(checkpoint.match(/recordObservation\("ACK_APPLIED"/g)).toHaveLength(1);
  expect(checkpoint.match(/recordObservation\("INIT"/g)).toHaveLength(1);
  const run = extractBlock(checkpoint, "const run = async () => {");
  const ackAssign = run.indexOf("this.failed = undefined;");
  const ackRecord = run.indexOf('recordObservation("ACK_APPLIED"');
  expect(ackRecord).toBeGreaterThan(ackAssign);
  expect(ackRecord).toBeLessThan(run.indexOf("this.notify(); this.settle();"));
  const observation = extractBlock(checkpoint, "getTestObservation(): CheckpointObservationReport | null");
  for (const forbidden of ["offer(", "flush(", "retry(", ".write(", "schedule(", "settle(", "notify("])
    expect(observation).not.toContain(forbidden);
  expect(checkpoint).toContain('testObservation?: "v1"');
  expect(checkpoint).toContain('options.testObservation === "v1" ? "v1" : undefined');
});

it("keeps the read port frozen and read-only, with no Node builtins in bundled code", () => {
  const renderer = source("src/renderer/checkpoint-observation.ts");
  const shared = source("src/shared/checkpoint-observation.ts");
  expect(renderer).toContain("Object.freeze({read})");
  expect(renderer).toContain('Object.defineProperty(globalThis, "folioCheckpointObservation"');
  expect(renderer).toContain("writable: false");
  expect(renderer).toContain("configurable: false");
  for (const forbidden of ["flush(", ".retry(", ".offer(", "ipcRenderer", "setRecoveryStatus"])
    expect(renderer).not.toContain(forbidden);
  for (const bundled of [renderer, shared]) {
    expect(bundled).not.toMatch(/from\s+["']node:/);
    expect(bundled).not.toContain("require(");
    expect(bundled).not.toMatch(/from\s+["']electron["']/);
  }
});

it("keeps the host harness launch-free (AST) and the spec on the fixed packaged launch shape (AST)", () => {
  const harnessPath = fileURLToPath(new URL("../tests/e2e/checkpoint-observation-harness.ts", import.meta.url));
  const harnessSource = readFileSync(harnessPath, "utf8");
  const harnessAst = ts.createSourceFile(harnessPath, harnessSource, ts.ScriptTarget.Latest, true);
  for (const statement of harnessAst.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = (statement.moduleSpecifier as ts.StringLiteral).text;
    expect(moduleName).not.toBe("electron");
    expect(moduleName).not.toBe("node:child_process");
    if (moduleName === "@playwright/test")
      expect(statement.importClause?.isTypeOnly).toBe(true);
  }
  const forbiddenCalls = new Set([
    "launch", "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "kill",
  ]);
  const visitHarness = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(harnessAst);
      expect(forbiddenCalls.has(name)).toBe(false);
    }
    ts.forEachChild(node, visitHarness);
  };
  visitHarness(harnessAst);
  expect(harnessSource).toContain("assertPrivateTempDirectory");
  expect(harnessSource).toContain("seedMacTrial");
  expect(harnessSource).toContain('"wx"');
  expect(harnessSource).toContain("readEvidenceIntent");
  const specPath = fileURLToPath(new URL("../tests/e2e/checkpoint-observation.spec.ts", import.meta.url));
  const specSource = readFileSync(specPath, "utf8");
  const specAst = ts.createSourceFile(specPath, specSource, ts.ScriptTarget.Latest, true);
  const launches: ts.CallExpression[] = [];
  const visitSpec = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "launch")
      launches.push(node);
    ts.forEachChild(node, visitSpec);
  };
  visitSpec(specAst);
  expect(launches).toHaveLength(1);
  const arg = launches[0].arguments[0];
  expect(ts.isObjectLiteralExpression(arg)).toBe(true);
  const props = new Map((arg as ts.ObjectLiteralExpression).properties
    .filter(ts.isPropertyAssignment)
    .map((p) => [p.name.getText(specAst), p.initializer.getText(specAst)]));
  expect(props.get("executablePath")).toBe("prepared.executablePath");
  expect(props.get("args")).toBe("[]");
  expect(props.get("env")).toBe("prepared.env");
  expect(specSource).toContain("_electron as electron");
  expect(specSource).not.toContain("dist/main.cjs");
  expect(specSource).not.toContain("SIGKILL");
});

it("round-trips the canonical binding fixture through the real parser", () => {
  const binding = {
    schema: "folio.checkpoint-observation-binding.v1",
    runId: "wiring-run",
    nonce: "123e4567-e89b-42d3-a456-426614174000",
    sourceCandidate: "d".repeat(64),
    artifactSha256: "e".repeat(64),
    fixtureSha256: "f".repeat(64),
    dataDir: "/private/tmp/folio-wiring-data",
    vaultDir: "/private/tmp/folio-wiring-vault",
  };
  const canonical = canonicalJson(binding);
  expect(parseCheckpointObservationBindingJson(canonical)).toEqual(binding);
  expect(parseCheckpointObservationBindingJson(canonical.slice(0, -1))).toBeNull();
  expect(parseCheckpointObservationBindingJson(canonical.replace(".v1", ".v9"))).toBeNull();
});

// --- Host harness contract checks. All fixtures are tiny owned metadata
// fakes (NODE_MOCK): they exercise the real helper logic but are never proof
// that a real app, OS or physical run produced or accepted anything. ---

const sha256Text = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const privateTemp = (prefix: string) => mkdtempSync(join(realpathSync(tmpdir()), prefix));

const HARNESS_CONFIG_FILES = [
  "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts",
  "vite.config.ts", "playwright.config.ts", "playwright.linux-ci.config.ts",
  "playwright.remote-mac.config.ts", "AGENTS.md", ".gitignore",
];
const HARNESS_EXTRA_FILES = ["index.html", "playwright.dev-round3.config.ts", "playwright.local-native.config.ts"];
const HARNESS_SOURCE_DIRS = ["src", "tests", "scripts"];
const HARNESS_INPUT_DIRS = ["assets", "public", "resources"];

function walkFixture(root: string, dir: string, into: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), {withFileTypes: true});
  } catch {
    return into;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkFixture(root, rel, into);
    else into.push(rel);
  }
  return into;
}

function seedSourceRoot() {
  const root = privateTemp("obs-src-");
  for (const name of [...HARNESS_CONFIG_FILES, ...HARNESS_EXTRA_FILES])
    writeFileSync(join(root, name), `// ${name}\n`);
  for (const [dir, file] of [["src", "a.ts"], ["tests", "b.test.ts"], ["scripts", "c.mjs"], ["dist", "main.cjs"], ["assets", "icon.icns"]]) {
    mkdirSync(join(root, dir), {recursive: true});
    writeFileSync(join(root, dir, file), `// ${dir}/${file}\n`);
  }
  return root;
}

function universeEntries(root: string) {
  const paths = [...HARNESS_CONFIG_FILES,
    ...HARNESS_SOURCE_DIRS.flatMap((dir) => walkFixture(root, dir))]
    .filter((rel) => existsSync(join(root, rel))).sort();
  return paths.map((rel) => {
    const bytes = readFileSync(join(root, rel));
    return {path: rel, bytes: bytes.length, sha256: sha256Text(bytes)};
  });
}

function additionalEntries(root: string) {
  return [...HARNESS_EXTRA_FILES.filter((rel) => existsSync(join(root, rel))),
    ...HARNESS_INPUT_DIRS.flatMap((dir) => walkFixture(root, dir))].sort().map((rel) => {
    const bytes = readFileSync(join(root, rel));
    return {path: rel, bytes: bytes.length, sha256: sha256Text(bytes)};
  });
}

function writeCandidate(dir: string, entries: unknown, additional: unknown, aggregate?: string) {
  const candidate = {
    candidateSha256: aggregate ?? sha256Text(canonicalJson(entries)),
    unitId: "NODE-MOCK", state: "NEEDS_REVIEW", cwd: "fixture", stage: null,
    snapshotSha256: "0".repeat(64), entries, additionalBuildInputs: additional,
  };
  const path = join(dir, `candidate-${process.hrtime.bigint()}.json`);
  writeFileSync(path, JSON.stringify(candidate));
  return path;
}

function fakeEvidence(sourceRoot: string, tmp: string) {
  const outputDir = join(tmp, "release", "Folio-darwin-arm64");
  const exePath = join(outputDir, "Folio.app/Contents/MacOS/Folio");
  mkdirSync(dirname(exePath), {recursive: true});
  writeFileSync(exePath, "exe-bytes");
  const asarPath = join(outputDir, "Folio.app/Contents/Resources/app.asar");
  mkdirSync(dirname(asarPath), {recursive: true});
  writeFileSync(asarPath, "asar-bytes");
  const artifactPath = join(tmp, "release", "folio.zip");
  writeFileSync(artifactPath, "zip-bytes");
  const manifest = {
    schema: "folio.package-artifact.v1",
    plan: {platform: "darwin", arch: process.arch, appVersion: "0.1.0",
      outputDir, artifactPath, manifestPath: join(tmp, "release", "m.json")},
    files: [
      {path: "Folio.app/Contents/MacOS/Folio", sha256: sha256Text("exe-bytes")},
      {path: "Folio.app/Contents/Resources/app.asar", sha256: sha256Text("asar-bytes")},
    ],
    artifact: {path: artifactPath, sha256: sha256Text("zip-bytes")},
    source: [
      {path: "src/a.ts", sha256: sha256Text(readFileSync(join(sourceRoot, "src/a.ts")))},
      {path: "dist/main.cjs", sha256: sha256Text(readFileSync(join(sourceRoot, "dist/main.cjs")))},
    ],
  };
  const intent = {runId: "obs-node",
    binding: {artifactSha256: manifest.artifact.sha256, manifestSha256: "0".repeat(64)},
    selection: {root: sourceRoot}};
  return {runRoot: tmp, intentPath: join(tmp, "intent.json"), intent, manifest};
}

function fakeContext(sourceRoot: string, tmp: string) {
  const root = privateTemp("obs-ctx-");
  const data = join(root, "workspace");
  mkdirSync(data, {mode: 0o700});
  const vault = `${data}-credentials`;
  mkdirSync(vault, {mode: 0o700});
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, {mode: 0o700});
  const fixtureManifestPath = join(evidenceDir, "fixture-manifest.json");
  writeFileSync(fixtureManifestPath, "{\"fixture\":1}\n");
  const entries = universeEntries(sourceRoot);
  const candidatePath = writeCandidate(tmp, entries, additionalEntries(sourceRoot));
  return {
    intentPath: join(tmp, "intent.json"),
    candidatePath,
    candidateFileSha256: sha256Text(readFileSync(candidatePath)),
    fixture: {
      root: realpathSync(root), data: realpathSync(data), vault: realpathSync(vault),
      evidenceDir: realpathSync(evidenceDir), fixtureManifestPath,
      fixtureSha256: sha256Text(readFileSync(fixtureManifestPath)), manifest: {} as never,
    },
    binding: {
      schema: "folio.checkpoint-observation-binding.v1", runId: "obs-node",
      nonce: "123e4567-e89b-42d3-a456-426614174000",
      sourceCandidate: sha256Text(canonicalJson(entries)),
      artifactSha256: sha256Text("zip-bytes"),
      fixtureSha256: sha256Text(readFileSync(fixtureManifestPath)),
      dataDir: realpathSync(data), vaultDir: realpathSync(vault),
    },
  };
}

it("NODE_MOCK harness: correlates a canonical candidate with the verified package", async () => {
  const harness = await import("./e2e/checkpoint-observation-harness");
  const tmp = privateTemp("obs-harness-");
  const sourceRoot = seedSourceRoot();
  const evidence = fakeEvidence(sourceRoot, tmp);
  const entries = universeEntries(sourceRoot);
  const candidatePath = writeCandidate(tmp, entries, additionalEntries(sourceRoot));
  const verified = harness.verifyObservationCandidate(candidatePath, evidence);
  expect(verified.candidateSha256).toBe(sha256Text(canonicalJson(entries)));
  expect(verified.candidateFileSha256).toBe(sha256Text(readFileSync(candidatePath)));
  expect(verified.executablePath).toBe(
    realpathSync(join(evidence.manifest.plan.outputDir, "Folio.app/Contents/MacOS/Folio")));
});

it("NODE_MOCK harness: rejects candidate aggregate, membership, hash and unsafe path drift", async () => {
  const harness = await import("./e2e/checkpoint-observation-harness");
  const tmp = privateTemp("obs-harness-");
  const sourceRoot = seedSourceRoot();
  const evidence = fakeEvidence(sourceRoot, tmp);
  const entries = universeEntries(sourceRoot);
  const additional = additionalEntries(sourceRoot);
  const rebuilt = (list: unknown) => sha256Text(canonicalJson(list));
  const cases: Array<() => string> = [
    () => writeCandidate(tmp, entries, additional, "0".repeat(64)),
    () => {const e = entries.slice(1); return writeCandidate(tmp, e, additional, rebuilt(e));},
    () => {const e = entries.map((x, i) => i === 0 ? {...x, sha256: "0".repeat(64)} : x);
           return writeCandidate(tmp, e, additional, rebuilt(e));},
    () => {const e = [...entries, {path: "../escape.txt", bytes: 1, sha256: "0".repeat(64)}];
           return writeCandidate(tmp, e, additional, rebuilt(e));},
    () => {const e = [...entries, {...entries[0]}]; return writeCandidate(tmp, e, additional, rebuilt(e));},
    () => {const a = additional.map((x) => ({...x, sha256: "0".repeat(64)}));
           return writeCandidate(tmp, entries, a);},
  ];
  for (const build of cases)
    expect(() => harness.verifyObservationCandidate(build(), evidence)).toThrow(/OBS_/);
});

it("NODE_MOCK harness: enforces the existing owned gate, root binding and node pin", async () => {
  const harness = await import("./e2e/checkpoint-observation-harness");
  const root = privateTemp("obs-owned-");
  chmodSync(root, 0o700);
  const ownedRequest = (overrides: Record<string, unknown> = {}, runRoot = realpathSync(root)) => ({
    v: 1, runId: "owned-run", runRoot, nodeExe: process.execPath,
    nodeSha256: sha256Text(readFileSync(process.execPath)), timeoutMs: 240000,
    expiresAt: new Date(Date.now() + 600000).toISOString(), ...overrides,
  });
  const ownedEnv = (request: unknown, overrides: Record<string, string> = {}) => ({
    FOLIO_GUI_TEST_OPT_IN: "1", FOLIO_LOCAL_GUI_BATCH: "1",
    FOLIO_LOCAL_GUI_DATA_ROOT: root,
    FOLIO_OWNED_SHUTDOWN_REQUEST: JSON.stringify(request), ...overrides,
  });
  expect(harness.requireOwnedShutdownGate(ownedEnv(ownedRequest())).runRoot).toBe(realpathSync(root));
  const other = privateTemp("obs-other-");
  chmodSync(other, 0o700);
  expect(() => harness.requireOwnedShutdownGate(ownedEnv(ownedRequest(), {FOLIO_LOCAL_GUI_BATCH: "0"})))
    .toThrow(/OBS_LOCAL_BATCH/);
  expect(() => harness.requireOwnedShutdownGate(ownedEnv(ownedRequest({}, realpathSync(other)))))
    .toThrow(/OBS_OWNED_REQUEST/);
  expect(() => harness.requireOwnedShutdownGate(ownedEnv(ownedRequest({nodeSha256: "0".repeat(64)}))))
    .toThrow(/OBS_OWNED_REQUEST/);
  expect(() => harness.requireOwnedShutdownGate(ownedEnv(ownedRequest({expiresAt: new Date(0).toISOString()}))))
    .toThrow(/OBS_OWNED_REQUEST/);
  expect(() => harness.requireOwnedShutdownGate(ownedEnv(ownedRequest({timeoutMs: 300001}))))
    .toThrow(/OBS_OWNED_REQUEST/);
  expect(() => harness.requireOwnedShutdownGate(ownedEnv(ownedRequest({unexpected: "key"}))))
    .toThrow(/OBS_OWNED_REQUEST/);
});

it("NODE_MOCK harness: read-only capture pins a fake-page sample into owned evidence (not app proof)", async () => {
  const harness = await import("./e2e/checkpoint-observation-harness");
  const tmp = privateTemp("obs-cap-");
  const sourceRoot = seedSourceRoot();
  const evidence = fakeEvidence(sourceRoot, tmp);
  const context = fakeContext(sourceRoot, tmp);
  readIntentMock.mockReturnValue(evidence);
  const canon = canonicalJson({sample: "payload"});
  const sample = {
    schema: "folio.checkpoint-observation-read.v1",
    rendererInstanceId: "123e4567-e89b-42d3-a456-426614174000",
    queueEpoch: 1,
    binding: context.binding,
    observation: {
      schema: "folio.checkpoint-observation.v1",
      events: [
        {index: 0, type: "INIT", generation: 0, snapshotJson: null},
        {index: 1, type: "OFFERED", seq: 1, snapshotJson: canon},
        {index: 2, type: "ACK_APPLIED", seq: 1, generation: 1, snapshotJson: canon},
      ],
      incomplete: false, captureStopped: false,
      status: {state: "saved", generation: 1, offeredSeq: 1, savedSeq: 1},
    },
  };
  (globalThis as Record<string, unknown>).folioCheckpointObservation = {read: () => sample};
  const page = {evaluate: async (fn: () => unknown) => fn()} as unknown as Page;
  const capture = await harness.captureCheckpointObservationSample(
    {page, context: context as unknown as ObservationCaptureContext});
  expect(capture.validation.verdict).toBe("VALID");
  expect(capture.samplePath.startsWith(context.fixture.evidenceDir)).toBe(true);
  expect(existsSync(capture.samplePath)).toBe(true);
  await expect(harness.captureCheckpointObservationSample(
    {page, context: context as unknown as ObservationCaptureContext}))
    .rejects.toThrow(/EEXIST|OBS_/);
  delete (globalThis as Record<string, unknown>).folioCheckpointObservation;
});

it("NODE_MOCK harness: refuses fixture-manifest drift, stale intent, binding mismatch and output escape", async () => {
  const harness = await import("./e2e/checkpoint-observation-harness");
  const tmp = privateTemp("obs-cap-");
  const sourceRoot = seedSourceRoot();
  const evidence = fakeEvidence(sourceRoot, tmp);
  const context = fakeContext(sourceRoot, tmp);
  readIntentMock.mockReturnValue(evidence);
  const page = {evaluate: async (fn: () => unknown) => fn()} as unknown as Page;
  (globalThis as Record<string, unknown>).folioCheckpointObservation = {read: () => null};
  await expect(harness.captureCheckpointObservationSample(
    {page, context: context as unknown as ObservationCaptureContext, basename: "../escape"}))
    .rejects.toThrow(/OBS_OUTPUT/);
  writeFileSync(context.fixture.fixtureManifestPath, "{\"fixture\":2}\n");
  await expect(harness.captureCheckpointObservationSample(
    {page, context: context as unknown as ObservationCaptureContext}))
    .rejects.toThrow(/OBS_FIXTURE/);
  readIntentMock.mockReturnValue({...evidence, intent: {...evidence.intent, runId: "other"}});
  await expect(harness.captureCheckpointObservationSample(
    {page, context: context as unknown as ObservationCaptureContext}))
    .rejects.toThrow(/OBS_CONTEXT/);
  readIntentMock.mockReturnValue(evidence);
  const mismatchedSha = {...context, binding: {...context.binding, fixtureSha256: "0".repeat(64)}};
  await expect(harness.captureCheckpointObservationSample(
    {page, context: mismatchedSha as unknown as ObservationCaptureContext}))
    .rejects.toThrow(/OBS_CONTEXT/);
  const mismatchedDir = {...context, binding: {...context.binding, dataDir: context.fixture.vault}};
  await expect(harness.captureCheckpointObservationSample(
    {page, context: mismatchedDir as unknown as ObservationCaptureContext}))
    .rejects.toThrow(/OBS_CONTEXT/);
  readIntentMock.mockImplementation(() => {throw new Error("EVIDENCE_INTENT_EXPIRED");});
  await expect(harness.captureCheckpointObservationSample(
    {page, context: context as unknown as ObservationCaptureContext}))
    .rejects.toThrow(/EVIDENCE_INTENT/);
  delete (globalThis as Record<string, unknown>).folioCheckpointObservation;
});
