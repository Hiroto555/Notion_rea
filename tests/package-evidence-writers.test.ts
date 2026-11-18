// Tests for the CURRENT package-evidence writers (intent capture, result
// records, current-evidence + gate-a manifests). Real temp files and real
// JSON/SHA-256 throughout; only verifyPackageArtifacts is injected, matching
// the production seam. No tests/build/package/GUI are executed.
import { createHash } from "node:crypto";
// @ts-ignore - untyped ESM module, matching the existing test import convention.
import * as evidence from "../scripts/write-evidence-manifest.mjs";
// @ts-ignore - import-safe untyped ESM writer.
import * as gate from "../scripts/write-gate-a-evidence.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const {
  ATTEMPT_NAME,
  GUI_RAW_NAME,
  captureEvidenceIntent,
  createEvidenceManifest,
  main: evidenceMain,
  parseEvidenceArgs,
  readEvidenceIntent,
  recordEvidenceResult,
  writeEvidenceManifest,
} = evidence;
const {
  GATE_A_SCHEMA,
  writeGateAEvidence,
} = gate;

const T0 = 1_800_000_000_000;
const HASH_RE = /^[a-f0-9]{64}$/;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "folio-evidence-writers-"));
  dirs.push(dir);
  return dir;
}
function sha(value: unknown) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value)
    ? value : JSON.stringify(value);
  if (bytes === undefined) throw new Error("Missing hash input");
  return createHash("sha256")
    .update(bytes)
    .digest("hex");
}
function put(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function makeSource(root: string) {
  put(join(root, "package.json"), JSON.stringify({ name: "folio", version: "0.1.0" }));
  put(join(root, "package-lock.json"), "{}");
  for (const config of ["tsconfig.json", "vite.config.ts", "vitest.config.ts"])
    put(join(root, config), "// fixture\n");
  put(join(root, "src", "main.ts"), "export {};\n");
  put(join(root, "tests", "a.test.ts"), "// test\n");
  put(join(root, "scripts", "build.mjs"), "// build\n");
  put(join(root, "dist", "index.js"), "console.log(1);\n");
}

// A folio.package-artifact.v1-shaped manifest sufficient for the binding:
// manifest file + artifact bytes exist on disk and source entries are live.
function makeManifest(root: string, platform = "darwin", arch = "arm64") {
  const release = join(root, "release");
  const outputDir = join(release, `Folio-${platform}-${arch}`);
  const artifactPath = join(release, `Folio-0.1.0-${platform}-${arch}.zip`);
  const manifestPath = join(release, `Folio-0.1.0-${platform}-${arch}.manifest.json`);
  mkdirSync(release, { recursive: true });
  writeFileSync(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
  const distFile = join(root, "dist", "index.js");
  const manifest = {
    schema: "folio.package-artifact.v1",
    plan: { platform, arch, appVersion: "0.1.0", outputDir, artifactPath, manifestPath },
    invocation: { deterministicBase: sha(`base-${platform}-${arch}`) },
    source: [{ path: distFile, sha256: sha(readFileSync(distFile)) }],
    files: [],
    nativeHelpers: [],
    artifact: { path: artifactPath, sha256: sha(readFileSync(artifactPath)) },
    prerequisites:
      platform === "win32"
        ? [{ name: "Microsoft.NETCore.App", major: 10, arch, bundled: false }]
        : [],
    evidence: {},
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return Object.freeze(manifest);
}
function selectionOf(root: string, platform = "darwin", arch = "arm64") {
  return Object.freeze({ root, platform, arch });
}
function fixture(platform = "darwin", arch = "arm64") {
  const root = tmp();
  makeSource(root);
  const manifest = makeManifest(root, platform, arch);
  const selection = selectionOf(root, platform, arch);
  const verify = () => manifest;
  return { root, manifest, selection, verify };
}
function capture(fx: ReturnType<typeof fixture>, runId = "run1") {
  return captureEvidenceIntent(
    { selection: fx.selection, runId, now: T0, ttlMs: 60_000 },
    { verify: fx.verify },
  );
}
function record(
  fx: ReturnType<typeof fixture>,
  intentPath: string,
  runRoot: string,
  kind: string,
  rawName: string,
  rawContent: string,
  outcome: { exitCode?: number | null; signal?: string | null } = {},
) {
  const rawPath = join(runRoot, rawName);
  writeFileSync(rawPath, rawContent);
  return recordEvidenceResult(
    {
      intentPath,
      kind,
      startTime: T0 + 1,
      endTime: T0 + 2,
      exitCode: outcome.exitCode === undefined ? 0 : outcome.exitCode,
      signal: outcome.signal === undefined ? null : outcome.signal,
      rawPath,
    },
    { verify: fx.verify, now: T0 + 3 },
  );
}
function unitRaw(root: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    success: true,
    startTime: T0 + 1,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 1,
    numTotalTests: 4,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      {
        name: join(root, "tests", "a.test.ts"),
        status: "passed",
        startTime: T0 + 1,
        endTime: T0 + 2,
        assertionResults: [
          { fullName: "a > one", status: "passed" },
          { fullName: "a > two", status: "passed" },
          { fullName: "a > three", status: "pending" },
          { fullName: "a > four", status: "todo" },
        ],
      },
    ],
    ...overrides,
  });
}
function guiRaw(fx: ReturnType<typeof fixture>, ctx: ReturnType<typeof readEvidenceIntent>, overrides: Record<string, unknown> = {}) {
  const binding = ctx.intent.binding;
  const attemptPath = join(ctx.runRoot, ATTEMPT_NAME);
  if (!existsSync(attemptPath)) writeFileSync(attemptPath, JSON.stringify({
    schema: "folio.package-gui-attempt.v1", runId: ctx.intent.runId,
    binding, nonce: "fixture-nonce", createdAt: T0 + 1,
    intentSha256: sha(readFileSync(ctx.intentPath)),
  }), { flag: "wx" });
  const stages = [
    ["tsc", [join(fx.root, "node_modules/typescript/bin/tsc"), "--noEmit"]],
    ["vite", [join(fx.root, "node_modules/vite/bin/vite.js"), "build"]],
    ["main", [join(fx.root, "scripts/build.mjs")]],
  ] as const;
  const build = stages.map(([name, args]) => {
    const stdout = join(ctx.runRoot, `build-${name}.stdout`);
    const stderr = join(ctx.runRoot, `build-${name}.stderr`);
    if (!existsSync(stdout)) writeFileSync(stdout, "fixture build output\n", { flag: "wx" });
    if (!existsSync(stderr)) writeFileSync(stderr, "", { flag: "wx" });
    return {
      name, command: process.execPath, args, exitCode: 0, signal: null, error: null,
      stdout: { path: stdout, sha256: sha(readFileSync(stdout)) },
      stderr: { path: stderr, sha256: sha(readFileSync(stderr)) },
    };
  });
  return JSON.stringify({
    schema: "folio.package-gui-result.v1",
    runId: ctx.intent.runId,
    binding,
    intentSha256: sha(readFileSync(ctx.intentPath)),
    attemptSha256: sha(readFileSync(attemptPath)),
    status: "COMPLETED",
    monitorRunId: "monitor-1",
    workspace: join(ctx.runRoot, "workspace"),
    smoke: {
      ok: true,
      persistence: true,
      artifactHash: binding.artifactSha256,
      platform: binding.platform,
      arch: binding.arch,
      executablePath: join(
        fx.manifest.plan.outputDir,
        binding.platform === "darwin" ? "Folio.app/Contents/MacOS/Folio" : "Folio.exe",
      ),
    },
    shutdown: {
      status: "COMPLETED", runId: "monitor-1", monitorRunId: "monitor-1",
      scope: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT", code: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
      sessions: [{ status: "COMPLETED", id: "s1" }],
    },
    build,
    privateRoots: {},
    ...overrides,
  });
}
function passAll(fx: ReturnType<typeof fixture>, runId = "run1") {
  const { intentPath, runRoot } = capture(fx, runId);
  const unitRecord = record(fx, intentPath, runRoot, "unit", "unit.json", unitRaw(fx.root));
  const buildRecord = record(fx, intentPath, runRoot, "build", "build.log", "build ok\n");
  const checkRecord = record(fx, intentPath, runRoot, "check", "check.log", "check ok\n");
  return { intentPath, runRoot, unitRecord, buildRecord, checkRecord };
}
const depsOf = (fx: ReturnType<typeof fixture>) => ({
  verify: fx.verify,
  now: T0 + 4,
});

describe("captureEvidenceIntent / readEvidenceIntent", () => {
  it("creates an immutable bound intent under output/validation-runs", () => {
    const fx = fixture("win32", "x64");
    const { intentPath, runRoot, intent } = capture(fx, "run-a");
    expect(intentPath).toBe(join(fx.root, "output", "validation-runs", "run-a", "intent.json"));
    expect(intent.schema).toBe("folio.package-evidence-intent.v1");
    expect(intent.binding.artifactSha256).toMatch(HASH_RE);
    expect(intent.binding.manifestSha256).toMatch(HASH_RE);
    expect(intent.binding.sourceSha256).toMatch(HASH_RE);
    const ctx = readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 1 });
    expect(ctx.runRoot).toBe(runRoot);
    // runRoot reuse never happens automatically
    expect(() => capture(fx, "run-a")).toThrow(/EVIDENCE_RUN_EXISTS/);
    expect(() =>
      captureEvidenceIntent(
        { selection: fx.selection, runId: "../escape", now: T0 },
        { verify: fx.verify },
      ),
    ).toThrow(/EVIDENCE_RUN_ID/);
  });
  it("refuses expired intents and stale bindings", () => {
    const fx = fixture();
    const { intentPath } = capture(fx);
    expect(() =>
      readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 61_000 }),
    ).toThrow(/EVIDENCE_INTENT_EXPIRED/);
    put(join(fx.root, "src", "main.ts"), "export {};// changed\n");
    expect(() =>
      readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 1 }),
    ).toThrow(/EVIDENCE_BINDING_STALE/);
  });
  it("detects manifest file mutation through manifestSha256", () => {
    const fx = fixture();
    const { intentPath } = capture(fx);
    writeFileSync(fx.manifest.plan.manifestPath, "{\"forged\":true}\n");
    expect(() =>
      readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 1 }),
    ).toThrow(/EVIDENCE_BINDING_STALE/);
  });
  it("rejects future intent use, current test drift and artifact mutation", () => {
    for (const changed of ["future", "test", "artifact"]) {
      const fx = fixture();
      const { intentPath } = capture(fx);
      if (changed === "test") put(join(fx.root, "tests/a.test.ts"), "// changed\n");
      if (changed === "artifact") writeFileSync(fx.manifest.plan.artifactPath, "changed zip");
      expect(() => readEvidenceIntent(intentPath, {
        verify: fx.verify, now: changed === "future" ? T0 - 1 : T0 + 1,
      })).toThrow(/EVIDENCE_(INTENT_TIME|BINDING_STALE|ARTIFACT_CHANGED)/);
    }
  });
});

describe("recordEvidenceResult", () => {
  it("writes immutable kind-bound records with rehashed raw", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    const { recordPath, record: rec } = record(
      fx, intentPath, runRoot, "build", "b.log", "ok\n",
    );
    expect(recordPath).toBe(join(runRoot, "build-result.json"));
    expect(rec.schema).toBe("folio.package-evidence-result.v1");
    expect(rec.binding).toEqual(
      readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 3 }).intent.binding,
    );
    expect(() =>
      record(fx, intentPath, runRoot, "build", "b2.log", "ok\n"),
    ).toThrow(/EEXIST|EVIDENCE/);
  });
  it("refuses raw outside runRoot, empty raw and out-of-window times", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    writeFileSync(join(runRoot, "empty.log"), "");
    expect(() =>
      record(fx, intentPath, runRoot, "build", "empty.log", ""),
    ).toThrow();
    const outside = join(tmp(), "outside.log");
    writeFileSync(outside, "x");
    expect(() =>
      recordEvidenceResult(
        { intentPath, kind: "build", startTime: T0 + 1, endTime: T0 + 2, exitCode: 0, signal: null, rawPath: outside },
        { verify: fx.verify, now: T0 + 3 },
      ),
    ).toThrow(/EVIDENCE_(RAW_PATH|PATH_OUTSIDE)/);
    expect(() =>
      recordEvidenceResult(
        { intentPath, kind: "build", startTime: T0 - 5, endTime: T0 + 2, exitCode: 0, signal: null, rawPath: join(runRoot, "n.log") },
        { verify: fx.verify, now: T0 + 3 },
      ),
    ).toThrow(/EVIDENCE_RESULT_TIME/);
  });
  it("rejects mutated raw bytes when the record is read back", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    const { unitRecord, buildRecord, checkRecord } = passAllRecords(fx, intentPath, runRoot);
    writeFileSync(join(runRoot, "unit.json"), unitRaw(fx.root, { numPassedTests: 9, numTotalTests: 9 }));
    expect(() =>
      createEvidenceManifest(
        { intentPath, unitRecord, buildRecord, checkRecord },
        depsOf(fx),
      ),
    ).toThrow(/EVIDENCE_RAW_MISMATCH/);
  });
  function passAllRecords(fx: ReturnType<typeof fixture>, intentPath: string, runRoot: string) {
    return {
      unitRecord: record(fx, intentPath, runRoot, "unit", "unit.json", unitRaw(fx.root)).recordPath,
      buildRecord: record(fx, intentPath, runRoot, "build", "build.log", "ok\n").recordPath,
      checkRecord: record(fx, intentPath, runRoot, "check", "check.log", "ok\n").recordPath,
    };
  }
});

describe("createEvidenceManifest", () => {
  it("PASSes with consistent Vitest assertions; gui NOT_RUN, Lv3, darwin", () => {
    const fx = fixture();
    const records = passAll(fx);
    const manifest = createEvidenceManifest(
      {
        intentPath: records.intentPath,
        unitRecord: records.unitRecord.recordPath,
        buildRecord: records.buildRecord.recordPath,
        checkRecord: records.checkRecord.recordPath,
      },
      depsOf(fx),
    );
    expect(manifest.schema).toBe("folio.package-current-evidence.v2");
    expect(manifest.nonGui.status).toBe("PASS");
    expect(manifest.nonGui.unit).toMatchObject({
      status: "PASS", passed: 2, failed: 0, pending: 1, todo: 1, skipped: 2, total: 4,
    });
    expect(manifest.gui).toEqual({ status: "NOT_RUN" });
    expect(manifest.certification).toBe("Lv3");
    expect(manifest.osExecuted).toBe(false);
    expect(manifest.signed).toBe(false);
    expect(manifest.protectedData).toBe("NOT_RUN");
    expect(manifest.historicalReferences.length).toBeGreaterThan(0);
    expect(manifest.historicalReferences[0].status).toBe("historical");
  });
  it("PASSes for a selected win32/arm64 target with prerequisites", () => {
    const fx = fixture("win32", "arm64");
    const records = passAll(fx);
    const manifest = createEvidenceManifest(
      {
        intentPath: records.intentPath,
        unitRecord: records.unitRecord.recordPath,
        buildRecord: records.buildRecord.recordPath,
        checkRecord: records.checkRecord.recordPath,
      },
      depsOf(fx),
    );
    expect(manifest.artifact.platform).toBe("win32");
    expect(manifest.artifact.arch).toBe("arm64");
    expect(manifest.artifact.prerequisites).toEqual([
      { name: "Microsoft.NETCore.App", major: 10, arch: "arm64", bundled: false },
    ]);
  });
  it("FAILs (not refuses) on honest failing evidence", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    const raw = unitRaw(fx.root, {
      success: false,
      numPassedTests: 0,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      numTotalTests: 1,
      numFailedTestSuites: 1,
      testResults: [
        {
          name: join(fx.root, "tests", "a.test.ts"),
          status: "failed",
          startTime: T0 + 1,
          endTime: T0 + 2,
          assertionResults: [{ fullName: "a > boom", status: "failed" }],
        },
      ],
    });
    const unitRecord = record(fx, intentPath, runRoot, "unit", "u.json", raw, { exitCode: 1 });
    const buildRecord = record(fx, intentPath, runRoot, "build", "b.log", "x");
    const checkRecord = record(fx, intentPath, runRoot, "check", "c.log", "x");
    const manifest = createEvidenceManifest(
      {
        intentPath,
        unitRecord: unitRecord.recordPath,
        buildRecord: buildRecord.recordPath,
        checkRecord: checkRecord.recordPath,
      },
      depsOf(fx),
    );
    expect(manifest.nonGui.unit.status).toBe("FAIL");
    expect(manifest.nonGui.unit.failed).toBe(1);
    expect(manifest.nonGui.status).toBe("FAIL");
  });
  it("marks build/check receipts by exit code only", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    const unitRecord = record(fx, intentPath, runRoot, "unit", "u.json", unitRaw(fx.root));
    const buildRecord = record(fx, intentPath, runRoot, "build", "b.log", "failed log", { exitCode: 2 });
    const checkRecord = record(fx, intentPath, runRoot, "check", "c.log", "ok");
    const manifest = createEvidenceManifest(
      { intentPath, unitRecord: unitRecord.recordPath, buildRecord: buildRecord.recordPath, checkRecord: checkRecord.recordPath },
      depsOf(fx),
    );
    expect(manifest.nonGui.build.status).toBe("FAIL");
    expect(manifest.nonGui.check.status).toBe("PASS");
    expect(manifest.nonGui.status).toBe("FAIL");
  });
  it("rejects legacy literal counts with no assertions", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    const legacy = JSON.stringify({
      success: true, startTime: T0 + 1,
      numPassedTests: 13, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      numTotalTests: 13, numFailedTestSuites: 0, numPendingTestSuites: 0,
      testResults: [
        {
          name: join(fx.root, "tests", "a.test.ts"),
          status: "passed", startTime: T0 + 1, endTime: T0 + 2,
          assertionResults: [],
        },
      ],
    });
    const unitRecord = record(fx, intentPath, runRoot, "unit", "u.json", legacy);
    const buildRecord = record(fx, intentPath, runRoot, "build", "b.log", "x");
    const checkRecord = record(fx, intentPath, runRoot, "check", "c.log", "x");
    expect(() =>
      createEvidenceManifest(
        { intentPath, unitRecord: unitRecord.recordPath, buildRecord: buildRecord.recordPath, checkRecord: checkRecord.recordPath },
        depsOf(fx),
      ),
    ).toThrow(/EVIDENCE_UNIT/);
  });
  it("rejects duplicate assertion names, bad statuses and count drift", () => {
    const fx = fixture();
    for (const overrides of [
      { testResults: [
        { name: join(fx.root, "tests", "a.test.ts"), status: "passed", startTime: T0 + 1, endTime: T0 + 2,
          assertionResults: [
            { fullName: "x", status: "passed" }, { fullName: "x", status: "passed" },
          ] },
      ], numPassedTests: 2, numPendingTests: 0, numTodoTests: 0, numTotalTests: 2 },
      { testResults: [
        { name: join(fx.root, "tests", "a.test.ts"), status: "passed", startTime: T0 + 1, endTime: T0 + 2,
          assertionResults: [{ fullName: "x", status: "bogus" }] },
      ], numPassedTests: 1, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1 },
      { numPassedTests: 3 },
    ]) {
      const { intentPath, runRoot } = capture(fx, `run-${Math.random().toString(36).slice(2, 8)}`);
      const unitRecord = record(fx, intentPath, runRoot, "unit", "u.json", unitRaw(fx.root, overrides));
      const buildRecord = record(fx, intentPath, runRoot, "build", "b.log", "x");
      const checkRecord = record(fx, intentPath, runRoot, "check", "c.log", "x");
      expect(() =>
        createEvidenceManifest(
          { intentPath, unitRecord: unitRecord.recordPath, buildRecord: buildRecord.recordPath, checkRecord: checkRecord.recordPath },
          depsOf(fx),
        ),
      ).toThrow(/EVIDENCE_UNIT/);
    }
  });
  it("keeps GUI UNKNOWN as UNKNOWN and rejects forged GUI evidence", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    const ctx = readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 3 });
    const unknownRecord = record(
      fx, intentPath, runRoot, "package-gui", "gui-raw.json",
      guiRaw(fx, ctx, { status: "UNKNOWN", smoke: null, shutdown: null }),
      { exitCode: null },
    );
    const unitRecord = record(fx, intentPath, runRoot, "unit", "u.json", unitRaw(fx.root));
    const buildRecord = record(fx, intentPath, runRoot, "build", "b.log", "x");
    const checkRecord = record(fx, intentPath, runRoot, "check", "c.log", "x");
    const manifest = createEvidenceManifest(
      {
        intentPath,
        unitRecord: unitRecord.recordPath,
        buildRecord: buildRecord.recordPath,
        checkRecord: checkRecord.recordPath,
        guiRecord: unknownRecord.recordPath,
      },
      depsOf(fx),
    );
    expect(manifest.gui).toEqual({ status: "UNKNOWN" });
    expect(manifest.nonGui.status).toBe("PASS");
  });
  it("accepts a fully bound COMPLETED gui record as PASS", () => {
    const fx = fixture();
    const { intentPath, runRoot } = capture(fx);
    const ctx = readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 3 });
    const gui = record(fx, intentPath, runRoot, "package-gui", GUI_RAW_NAME, guiRaw(fx, ctx));
    const records = {
      unitRecord: record(fx, intentPath, runRoot, "unit", "u.json", unitRaw(fx.root)),
      buildRecord: record(fx, intentPath, runRoot, "build", "b.log", "x"),
      checkRecord: record(fx, intentPath, runRoot, "check", "c.log", "x"),
    };
    const manifest = createEvidenceManifest(
      {
        intentPath,
        unitRecord: records.unitRecord.recordPath,
        buildRecord: records.buildRecord.recordPath,
        checkRecord: records.checkRecord.recordPath,
        guiRecord: gui.recordPath,
      },
      depsOf(fx),
    );
    expect(manifest.gui).toEqual({ status: "PASS", monitorRunId: "monitor-1" });
  });
  it("rejects forged gui fields (artifact/host/run/shutdown)", () => {
    for (const patch of [
      { runId: "other-run" },
      { smoke: { ok: true, persistence: true, artifactHash: sha("wrong"), platform: "darwin", arch: "arm64", executablePath: "/x" } },
      { monitorRunId: "other-monitor" },
      { build: [] },
      { shutdown: {
        status: "COMPLETED", runId: "wrong", monitorRunId: "monitor-1",
        scope: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT", code: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
        sessions: [{ status: "COMPLETED" }],
      } },
      { shutdown: {
        status: "COMPLETED", runId: "monitor-1", monitorRunId: "monitor-1",
        scope: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT", code: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
        sessions: [{ status: "UNKNOWN" }],
      } },
      { shutdown: { status: "COMPLETED", monitorRunId: "monitor-1", sessions: [] } },
    ]) {
      const fx = fixture();
      const { intentPath, runRoot } = capture(fx, `r-${Math.random().toString(36).slice(2, 8)}`);
      const ctx = readEvidenceIntent(intentPath, { verify: fx.verify, now: T0 + 3 });
      const gui = record(
        fx, intentPath, runRoot, "package-gui", "gui-raw.json", guiRaw(fx, ctx, patch),
      );
      const records = {
        unitRecord: record(fx, intentPath, runRoot, "unit", "u.json", unitRaw(fx.root)),
        buildRecord: record(fx, intentPath, runRoot, "build", "b.log", "x"),
        checkRecord: record(fx, intentPath, runRoot, "check", "c.log", "x"),
      };
      expect(() =>
        createEvidenceManifest(
          {
            intentPath,
            unitRecord: records.unitRecord.recordPath,
            buildRecord: records.buildRecord.recordPath,
            checkRecord: records.checkRecord.recordPath,
            guiRecord: gui.recordPath,
          },
          depsOf(fx),
        ),
      ).toThrow(/EVIDENCE_GUI/);
    }
  });
});

describe("writeEvidenceManifest / writeGateAEvidence", () => {
  it.skipIf(process.platform === "win32")("refuses symlinked output ancestors", () => {
    const fx = fixture();
    const records = passAll(fx);
    const elsewhere = tmp();
    symlinkSync(elsewhere, join(records.runRoot, "redirect"));
    expect(() => writeEvidenceManifest({
      intentPath: records.intentPath,
      unitRecord: records.unitRecord.recordPath,
      buildRecord: records.buildRecord.recordPath,
      checkRecord: records.checkRecord.recordPath,
      outputPath: join(records.runRoot, "redirect/forged.json"),
    }, depsOf(fx))).toThrow(/EVIDENCE_PATH_SYMLINK/);
    expect(existsSync(join(elsewhere, "forged.json"))).toBe(false);
  });
  it("rejects changed captured GUI build bytes and preserves historical outputs", () => {
    const fx = fixture();
    const historical = join(fx.root, "research/evidence/final-validation.json");
    put(historical, '{"historical":true}\n');
    const records = passAll(fx);
    const ctx = readEvidenceIntent(records.intentPath, depsOf(fx));
    const gui = record(fx, records.intentPath, records.runRoot,
      "package-gui", GUI_RAW_NAME, guiRaw(fx, ctx));
    writeFileSync(join(records.runRoot, "build-main.stdout"), "changed capture");
    expect(() => createEvidenceManifest({
      intentPath: records.intentPath,
      unitRecord: records.unitRecord.recordPath,
      buildRecord: records.buildRecord.recordPath,
      checkRecord: records.checkRecord.recordPath,
      guiRecord: gui.recordPath,
    }, depsOf(fx))).toThrow(/EVIDENCE_GUI_BUILD/);
    expect(readFileSync(historical, "utf8")).toBe('{"historical":true}\n');
  });
  it("writes exclusively inside runRoot and refuses reserved/historical targets", () => {
    const fx = fixture();
    const records = passAll(fx);
    const out = join(records.runRoot, "current-evidence.json");
    const written = writeEvidenceManifest(
      {
        intentPath: records.intentPath,
        unitRecord: records.unitRecord.recordPath,
        buildRecord: records.buildRecord.recordPath,
        checkRecord: records.checkRecord.recordPath,
        outputPath: out,
      },
      depsOf(fx),
    );
    expect(written.outputPath).toBe(resolve(out));
    expect(JSON.parse(readFileSync(out, "utf8")).schema).toBe("folio.package-current-evidence.v2");
    expect(() => writeEvidenceManifest(
      {
        intentPath: records.intentPath,
        unitRecord: records.unitRecord.recordPath,
        buildRecord: records.buildRecord.recordPath,
        checkRecord: records.checkRecord.recordPath,
        outputPath: out,
      },
      depsOf(fx),
    )).toThrow(/EVIDENCE_OUTPUT_EXISTS/);
    for (const bad of [
      join(records.runRoot, "unit-result.json"),
      join(records.runRoot, ATTEMPT_NAME),
      join(tmp(), "outside.json"),
      join(fx.root, "research", "evidence", "final-validation.json"),
    ]) {
      expect(() =>
        writeEvidenceManifest(
          {
            intentPath: records.intentPath,
            unitRecord: records.unitRecord.recordPath,
            buildRecord: records.buildRecord.recordPath,
            checkRecord: records.checkRecord.recordPath,
            outputPath: bad,
          },
          depsOf(fx),
        ),
      ).toThrow(/EVIDENCE_OUTPUT|EVIDENCE_PATH/);
    }
  });
  it("gate-a writer wraps the same current manifest under its schema", () => {
    const fx = fixture("win32", "x64");
    const records = passAll(fx);
    const out = writeGateAEvidence(
      {
        intentPath: records.intentPath,
        unitRecord: records.unitRecord.recordPath,
        buildRecord: records.buildRecord.recordPath,
        checkRecord: records.checkRecord.recordPath,
      },
      depsOf(fx),
    );
    const parsed = JSON.parse(readFileSync(out.outputPath, "utf8"));
    expect(parsed.schema).toBe(GATE_A_SCHEMA);
    expect(parsed.manifest.schema).toBe("folio.package-current-evidence.v2");
    expect(parsed.manifest.artifact.platform).toBe("win32");
  });
});

describe("parseEvidenceArgs / import safety", () => {
  it("requires explicit flags; rejects duplicates and mixed modes", () => {
    expect(() => parseEvidenceArgs([])).toThrow(/EVIDENCE_ARGUMENTS/);
    expect(() =>
      parseEvidenceArgs(["--selection", "/a", "--selection", "/b"]),
    ).toThrow(/EVIDENCE_ARGUMENTS/);
    expect(() =>
      parseEvidenceArgs(["--create-intent", "--selection", "/a", "--run-id", "r1", "--out", "/o"]),
    ).toThrow(/EVIDENCE_ARGUMENTS/);
    expect(() =>
      parseEvidenceArgs(["--run-id", "not a run id!!", "--create-intent", "--selection", "/a"]),
    ).toThrow(/EVIDENCE_ARGUMENTS/);
    const parsed = parseEvidenceArgs([
      "--selection", "/s", "--intent", "/i", "--unit-record", "/u",
      "--build-record", "/b", "--check-record", "/c", "--out", "/o",
    ]);
    expect(parsed.mode).toBe("write");
  });
  it("module import wrote nothing (no output/validation-runs anywhere)", () => {
    const fx = fixture();
    expect(existsSync(join(fx.root, "output"))).toBe(false);
    expect(typeof evidenceMain).toBe("function");
  });
});
