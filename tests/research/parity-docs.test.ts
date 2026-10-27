import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const docs = "docs/parallel/research";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const readJson = <T>(path: string) => JSON.parse(read(path)) as T;

type FolioStatus = "PASS" | "PARTIAL" | "FAIL" | "NOT_RUN";
type ReferenceStatus = "NOT_RUN" | "OBSERVED";
type Comparison = "MATCH" | "DIFF" | "UNKNOWN";
type Basis = "DOCUMENTED_REFERENCE" | "INFERRED" | "UNKNOWN";

type Source = {
  id: string;
  title: string;
  url: string;
  retrievedAt: string;
};

type Scenario = {
  id: string;
  title: string;
  priority: string;
  procedure: string;
  folio: {
    status: FolioStatus;
    basis: string;
    latestResult: string;
    testFiles: string[];
    testTitles: string[];
    priorRecord: string;
    note: string;
  };
  reference: {
    status: ReferenceStatus;
    permitted: boolean;
    observedAt: string | null;
    environmentRef: string;
    reason: string;
  };
  official: {
    basis: Basis;
    sourceIds: string[];
    sources: Source[];
    limits: string[];
  };
  comparison: Comparison;
  matchJustification: string | null;
  differences: string[];
  hypotheses: string[];
  unresolved: string[];
  firstAction: string;
  note: string;
};

type Matrix = {
  schemaVersion: number;
  recordedAt: string;
  baseline: {
    path: string;
    sha256: string;
    baseCommit: string;
    preserved: boolean;
  };
  permissions: {
    notionTestSpace: boolean;
    notionTestSpaceDetail: string;
    physicalIme: boolean;
    privateData: boolean;
  };
  comparisonPolicy: {
    matchRequiresObservedReference: boolean;
    matchRequiresSameFixture: boolean;
    matchRequiresSameEnvironment: boolean;
    documentationAlone: string;
    unobserved: string;
    physicalIme: string;
  };
  latestRun: string;
  latestRunResult: string;
  latestRunReason: string;
  scenarios: Scenario[];
  unresolvedIds: string[];
  hypothesisIds: string[];
};

type Environment = {
  schemaVersion: number;
  recordedAt: string;
  git: { branch: string; headAtStart: string; baseCommit: string };
  host: {
    os: string;
    osVersion: string;
    osBuild: string;
    arch: string;
    node: string;
    npm: string;
  };
  folio: {
    measurementKind: string;
    packageVersion: string;
    electron: string;
    chromium: string;
    locale: string;
    language: string;
    theme: string;
    viewport: { width: number; height: number };
    zoom: number;
    input: string;
    physicalJapaneseIME: string;
    currentRun?: {
      runId: string;
      status: string;
      sourceCommit: string;
      buildArtifactSha256: string;
      startedAt: string;
      artifact: string;
      reason: string;
    };
  };
  fixture: {
    kind: string;
    createdInNotion: boolean;
    createdInFolioByTests: boolean;
    sharedComposition: {
      pageTitle: string;
      body: string;
      linkTarget: string;
      orderedBlocks: string[];
      databaseRow: {
        name: string;
        status: string;
        date: string;
        number: number;
      };
    };
  };
  notion: Record<string, unknown>;
  comparison: { status: string; matchCount: number };
};

type Verification = {
  schemaVersion: number;
  recordedAt: string;
  sourceCommit: string;
  baseCommit: string;
  retries: number;
  commands: Array<{
    label: string;
    command: string;
    exitCode: number;
    status: string;
    log: string;
    startedAt: string;
    endedAt: string;
    note?: string;
  }>;
  buildHashes: Array<{ path: string; sha256: string }>;
  parityE2E: {
    runId: string;
    exitCode: number;
    artifactDir: string;
    failureCategory?: string;
    results: Record<string, string>;
  };
  scopeAudit: {
    forbiddenChanges: string[];
    diffOutput: string;
  };
};

const expectedIds = [
  "N01",
  "N02",
  "N03",
  "N04",
  "N05",
  "N06",
  "N07",
  "N08",
  "N09",
];

const matrix = readJson<Matrix>(`${docs}/parity-matrix.json`);
const env = readJson<Environment>(`${docs}/environment.json`);
const verification = readJson<Verification>(`${docs}/verification.json`);
const references = read(`${docs}/references.md`);
const matrixMarkdown = read(`${docs}/parity-matrix.md`);
const procedures = read(`${docs}/procedures.md`);
const priorities = read(`${docs}/priorities.md`);
const unresolved = read(`${docs}/unresolved.md`);

describe("research parity matrix", () => {
  it("keeps the fixed N01-N09 scenario set with four separate columns", () => {
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.scenarios.map((scenario) => scenario.id)).toEqual(expectedIds);
    expect(new Set(matrix.scenarios.map((scenario) => scenario.id)).size).toBe(
      expectedIds.length,
    );

    for (const scenario of matrix.scenarios) {
      expect(scenario.title.trim().length).toBeGreaterThan(0);
      expect(scenario.priority).toMatch(/^P[1-3]$/);
      expect(["PASS", "PARTIAL", "FAIL", "NOT_RUN"]).toContain(
        scenario.folio.status,
      );
      expect(["DOCUMENTED_REFERENCE", "INFERRED", "UNKNOWN"]).toContain(
        scenario.official.basis,
      );
      expect(["MATCH", "DIFF", "UNKNOWN"]).toContain(scenario.comparison);
      expect(scenario.procedure).toMatch(/^procedures\.md#n\d{2}$/);
      expect(scenario.folio.testFiles.length).toBeGreaterThan(0);
      expect(scenario.folio.testTitles.length).toBeGreaterThan(0);
      expect(["PASS", "PARTIAL", "FAIL", "NOT_RUN"]).toContain(
        scenario.folio.latestResult,
      );
    }

    expect(matrix.latestRun).toMatch(/^[a-z0-9-]+$/);
    expect(matrix.latestRunResult).toBe("NOT_RUN");
    expect(matrix.latestRunReason).toContain("sandbox");
    expect(verification.parityE2E.results[matrix.latestRun]).toBe(
      matrix.latestRunResult,
    );
  });

  it("does not claim Notion measurement without explicit permission", () => {
    expect(matrix.permissions.notionTestSpace).toBe(false);
    expect(matrix.permissions.notionTestSpaceDetail.length).toBeGreaterThan(0);
    expect(matrix.comparisonPolicy.matchRequiresObservedReference).toBe(true);
    expect(matrix.comparisonPolicy.matchRequiresSameFixture).toBe(true);
    expect(matrix.comparisonPolicy.matchRequiresSameEnvironment).toBe(true);
    expect(matrix.comparisonPolicy.documentationAlone).toBe("UNKNOWN");
    expect(matrix.comparisonPolicy.unobserved).toBe("UNKNOWN");

    for (const scenario of matrix.scenarios) {
      expect(scenario.reference.status).toBe("NOT_RUN");
      expect(scenario.reference.permitted).toBe(false);
      expect(scenario.reference.observedAt).toBeNull();
      expect(scenario.reference.reason.length).toBeGreaterThan(0);
      expect(scenario.comparison).toBe("UNKNOWN");
      expect(scenario.matchJustification).toBeNull();
      expect(scenario.differences).toEqual([]);
    }

    expect(env.notion.measurementStatus).toBe("NOT_RUN");
    expect(env.notion.permission).toBe("NOT_GRANTED");
    expect(env.comparison.status).toBe("UNKNOWN");
    expect(env.comparison.matchCount).toBe(0);
  });

  it("keeps physical Japanese IME at NOT_RUN", () => {
    expect(matrix.permissions.physicalIme).toBe(false);
    expect(env.folio.physicalJapaneseIME).toBe("NOT_RUN");
    expect(env.notion.input).toBe("UNKNOWN");
    expect(matrix.comparisonPolicy.physicalIme).toBe("NOT_RUN");

    const scenario = matrix.scenarios.find((item) => item.id === "N08");
    expect(scenario).toBeDefined();
    expect(scenario!.folio.status).toBe("NOT_RUN");
    expect(scenario!.folio.testTitles.join("\n")).toContain("not physical IME");
    expect(scenario!.comparison).toBe("UNKNOWN");
  });

  it("rejects MATCH or DIFF without an observed, same-environment measurement", () => {
    const isAllowed = (scenario: Scenario) => {
      if (scenario.comparison !== "MATCH" && scenario.comparison !== "DIFF") {
        return false;
      }
      return (
        scenario.reference.status === "OBSERVED" &&
        scenario.reference.permitted &&
        scenario.reference.observedAt !== null &&
        scenario.reference.environmentRef.length > 0 &&
        scenario.matchJustification !== null &&
        scenario.matchJustification.trim().length > 0
      );
    };

    for (const scenario of matrix.scenarios) {
      expect(isAllowed(scenario)).toBe(false);
    }
    expect(matrixMarkdown).not.toMatch(/^\|\s*N\d{2}\s*\|.*\|\s*MATCH\s*\|\s*$/m);
  });

  it("records direct official links with retrieval dates", () => {
    const referenced = new Set(
      [...references.matchAll(/^\|\s*(REF-\d{2})\s*\|/gm)].map(
        (match) => match[1],
      ),
    );
    expect(referenced.size).toBeGreaterThanOrEqual(5);

    for (const scenario of matrix.scenarios) {
      expect(scenario.official.sourceIds).toEqual(
        scenario.official.sources.map((source) => source.id),
      );
      expect(scenario.official.limits.length).toBeGreaterThan(0);
      for (const source of scenario.official.sources) {
        expect(referenced.has(source.id)).toBe(true);
        expect(references).toContain(source.url);
        expect(source.url.startsWith("https://")).toBe(true);
        expect(source.title.trim().length).toBeGreaterThan(0);
        expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(source.retrievedAt).toBe("2026-10-27");
      }
    }
  });

  it("records the Folio and Notion environment fields explicitly", () => {
    expect(env.schemaVersion).toBe(1);
    expect(env.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.git.branch).toBe("sprint/research");
    expect(env.git.headAtStart).toMatch(/^[0-9a-f]{40}$/);
    expect(env.git.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(env.host.os).toBe("macOS");
    expect(env.host.osVersion.length).toBeGreaterThan(0);
    expect(env.host.arch).toBe("arm64");
    expect(env.host.node.length).toBeGreaterThan(0);
    expect(env.folio.packageVersion).toBe("0.1.0");
    expect(env.folio.electron.length).toBeGreaterThan(0);
    expect(env.folio.chromium.length).toBeGreaterThan(0);
    expect(env.folio.locale).toBe("ja");
    expect(env.folio.language).toBe("ja");
    expect(env.folio.theme.length).toBeGreaterThan(0);
    expect(env.folio.viewport.width).toBeGreaterThan(0);
    expect(env.folio.viewport.height).toBeGreaterThan(0);
    expect(env.folio.zoom).toBe(1);
    expect(env.folio.input.length).toBeGreaterThan(0);
    expect(env.folio.currentRun).toBeDefined();
    expect(env.folio.currentRun!.runId).toBe(matrix.latestRun);
    expect(env.folio.currentRun!.status).toBe("NOT_RUN");
    expect(env.folio.currentRun!.reason.length).toBeGreaterThan(0);
    expect(env.folio.currentRun!.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(env.folio.currentRun!.buildArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(resolve(root, env.folio.currentRun!.artifact))).toBe(true);

    const requiredNotionFields = [
      "version",
      "os",
      "language",
      "theme",
      "viewport",
      "zoom",
      "input",
      "surface",
      "testSpace",
      "measuredAt",
      "observer",
    ];
    for (const field of requiredNotionFields) {
      expect(env.notion[field]).toBe("UNKNOWN");
    }

    expect(env.fixture.kind).toBe("SYNTHETIC_ONLY");
    expect(env.fixture.createdInNotion).toBe(false);
    expect(env.fixture.createdInFolioByTests).toBe(true);
    expect(env.fixture.sharedComposition.pageTitle.length).toBeGreaterThan(0);
    expect(env.fixture.sharedComposition.orderedBlocks).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(env.fixture.sharedComposition.databaseRow.number).toBe(123);
  });

  it("keeps the human-readable matrix in sync and free of unproven MATCH rows", () => {
    const rows = [...matrixMarkdown.matchAll(/^\|\s*(N\d{2})\s*\|.*$/gm)].map(
      (match) => match[0],
    );
    expect(rows).toHaveLength(expectedIds.length);

    const table = new Map<string, string[]>();
    for (const row of rows) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      expect(cells).toHaveLength(6);
      table.set(cells[0], cells);
      expect(cells[5]).toBe("UNKNOWN");
    }
    expect([...table.keys()]).toEqual(expectedIds);

    for (const scenario of matrix.scenarios) {
      const cells = table.get(scenario.id);
      expect(cells?.[0]).toBe(scenario.id);
      expect(cells?.[1].length).toBeGreaterThan(0);
      expect(cells?.[5]).toBe(scenario.comparison);
    }
  });

  it("preserves the baseline document and referenced local evidence", () => {
    const baselineBytes = readFileSync(resolve(root, matrix.baseline.path));
    expect(createHash("sha256").update(baselineBytes).digest("hex")).toBe(
      matrix.baseline.sha256,
    );
    expect(matrix.baseline.preserved).toBe(true);
    expect(matrix.baseline.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    for (const scenario of matrix.scenarios) {
      for (const file of scenario.folio.testFiles) {
        expect(existsSync(resolve(root, file)), file).toBe(true);
      }
      expect(existsSync(resolve(root, scenario.folio.priorRecord))).toBe(true);
      expect(procedures).toContain(`### ${scenario.id} `);
    }
  });

  it("keeps unresolved and hypothesis identifiers complete", () => {
    expect(new Set(matrix.unresolvedIds).size).toBe(matrix.unresolvedIds.length);
    expect(new Set(matrix.hypothesisIds).size).toBe(
      matrix.hypothesisIds.length,
    );
    for (const id of matrix.unresolvedIds) {
      expect(id).toMatch(/^U\d{2}$/);
      expect(unresolved).toContain(`| ${id} |`);
    }
    for (const id of matrix.hypothesisIds) {
      expect(id).toMatch(/^H\d$/);
      expect(priorities).toContain(`| ${id} |`);
    }
    for (const scenario of matrix.scenarios) {
      for (const id of scenario.unresolved) {
        expect(matrix.unresolvedIds).toContain(id);
      }
      for (const id of scenario.hypotheses) {
        expect(matrix.hypothesisIds).toContain(id);
      }
    }
  });

  it("records every verification command and keeps the scope audit clean", () => {
    expect(verification.schemaVersion).toBe(1);
    expect(verification.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(verification.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(verification.baseCommit).toBe(env.git.baseCommit);
    expect(verification.retries).toBe(0);
    expect(verification.commands.length).toBeGreaterThanOrEqual(4);

    const labels = new Set<string>();
    for (const command of verification.commands) {
      expect(labels.has(command.label)).toBe(false);
      labels.add(command.label);
      expect(command.command).toMatch(
        /^(env -u ELECTRON_RUN_AS_NODE )?node scripts\/folio-agent\.mjs /,
      );
      expect(command.log).toContain("output/agent-workspace/logs/");
      expect(command.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(command.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(command.status).toBe(command.exitCode === 0 ? "PASS" : "FAIL");
      if (command.exitCode !== 0) expect(command.note?.length ?? 0).toBeGreaterThan(0);
    }

    expect(verification.buildHashes.length).toBeGreaterThan(0);
    for (const artifact of verification.buildHashes) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(verification.parityE2E.artifactDir.startsWith("output/")).toBe(true);
    expect(verification.parityE2E.exitCode).toBe(
      verification.parityE2E.results[verification.parityE2E.runId] === "PASS"
        ? 0
        : 1,
    );
    expect(verification.parityE2E.failureCategory).toBe("ENVIRONMENT");
    expect(verification.scopeAudit.forbiddenChanges).toEqual([]);
    expect(verification.scopeAudit.diffOutput).toBe("");
  });
});
