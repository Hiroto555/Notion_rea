import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { resolve, relative, join } from "node:path";
const root = process.cwd(),
  raw = join(root, "output/gate-a"),
  shared = join(root, "docs/validation/gate-a");
mkdirSync(shared, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJSON = (p, value) =>
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
const scrub = (text) =>
  text
    .split(root)
    .join("<PROJECT_ROOT>")
    .split(process.env.HOME || "__NO_HOME__")
    .join("<HOME>")
    .replace(/\x1b\[[0-9;]*m/g, "");
const logs = [];
for (const name of readdirSync(raw)
  .filter((n) => n.endsWith(".log"))
  .sort()) {
  const bytes = readFileSync(join(raw, name));
  const target = name.replace(/\.log$/, ".txt");
  writeFileSync(join(shared, target), scrub(bytes.toString("utf8")));
  logs.push({
    path: "docs/validation/gate-a/" + target,
    rawSha256: sha(bytes),
    sha256: sha(readFileSync(join(shared, target))),
  });
}
const runs = readJSON(join(raw, "verified-results.json"));
if (!runs.some((r) => r.name === "package-smoke" && r.exitCode === 0))
  throw new Error("Latest package verification missing");
const protectedBefore = readJSON(join(raw, "protected-before.json"));
const changed = Object.entries(protectedBefore)
  .filter(([p, h]) => !existsSync(p) || sha(readFileSync(p)) !== h)
  .map(([p]) => p);
writeJSON(join(raw, "protected-after.json"), {
  checked: Object.keys(protectedBefore).length,
  changed,
});
const contentChanged = changed.filter((p) => !p.includes("/session/"));
const contentPaths = Object.keys(protectedBefore).filter(
  (p) => !p.includes("/session/"),
);
const addedContent = [".folio-data", "release/.folio-data"]
  .flatMap(files)
  .filter((p) => !p.includes("/session/") && !(p in protectedBefore));
if (contentChanged.length || addedContent.length)
  throw new Error(
    "Workspace content changed; inspect local protected-after.json",
  );
const baseline = "abb1e3131d1b4cab6aee4560c6d8aa819859bc29";
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const lockUnchanged =
  sha(readFileSync("package-lock.json")) ===
  sha(execFileSync("git", ["show", baseline + ":package-lock.json"]));
const results = {
  date: "2026-10-26",
  baseline,
  head,
  baselineRuns: readJSON(join(raw, "baseline-results.json")),
  finalRuns: runs,
  unit: { passed: 32, failed: 0 },
  gateAElectron: { passed: 15, failed: 0 },
  fullElectron: {
    passed: 21,
    failed: 1,
    note: "One existing block-drag test failed. The unchanged test passed 3/3 targeted reruns; intermittent cause remains unresolved.",
  },
  sharingRuns: readJSON(join(raw, "final-results.json")).filter((r) =>
    ["review-tests", "review-scan", "post-evidence-review-scan", "diff-check"].includes(r.name),
  ),
  redRuns: [
    {
      command: "npx vitest run tests/gate-a.test.ts",
      exitCode: 1,
      log: "red-unit.txt",
      note: "6 failures in production storage/validation code",
    },
    {
      command: "npx playwright test tests/e2e/gate-a.spec.ts --reporter=list",
      exitCode: 1,
      log: "red-e2e.txt",
      note: "Includes three locator setup errors and three actual attachment failures; use corrected run for F01/F06/F11",
    },
    {
      command:
        "npx playwright test tests/e2e/gate-a.spec.ts --grep 'F01|F06|F11' --reporter=list",
      exitCode: 1,
      log: "red-e2e-corrected.txt",
      note: "Three reproduced defects; old unsaved guard also delayed test teardown",
    },
  ],
  intermediateIssues: [
    {
      log: "check-intermediate.txt",
      exitCode: 2,
      reason: "Duplicate field and test window typing; corrected",
    },
    {
      log: "expanded-e2e.txt",
      exitCode: 1,
      reason: "Test assertion accessed undefined patch.doc; corrected",
    },
    {
      log: "recovery-build.txt",
      exitCode: 2,
      reason: "Test env typing; corrected",
    },
    {
      log: "recovery-e2e.txt",
      exitCode: 1,
      reason:
        "Executed previous build after build failure; unsupported null-doc render failed; not final validation",
    },
  ],
  protectedData: {
    checkedFiles: Object.keys(protectedBefore).length,
    changedFiles: changed.length,
    contentFiles: contentPaths.length,
    contentChangedFiles: contentChanged.length,
    addedContentFiles: addedContent.length,
    sessionChangedFiles: changed.filter((p) => p.includes("/session/")).length,
    note: "An already-running Folio process started at 20:42:28. Four GPU cache files changed; SQLite/WAL/SHM content matched. The user application was left running.",
  },
  lockUnchanged,
  notionComparison: "NOT_RUN",
  physicalIME: "NOT_RUN",
  sourceState: "uncommitted working tree; pre-existing index preserved",
};
writeJSON(join(shared, "results.json"), results);
writeJSON(
  join(shared, "red-storage-path.json"),
  readJSON(join(raw, "red-storage-path.json")),
);
const catalog = readJSON("review/2026-10-26/Folio_Acceptance_Catalog.json");
const passed = [
  "REG-01",
  "REG-02",
  "REG-03",
  "REG-04",
  "REG-05",
  "REG-06",
  "REG-07",
  "REG-08",
  "REG-09",
  "REG-10",
  "REG-12",
  "EDIT-13",
  "DUR-04",
  "DUR-05",
  "DUR-06",
  "DUR-07",
  "DUR-08",
];
const partial = {
  "REG-11":
    "Existing row IDs and values restored; row bodies are not implemented.",
  "EDIT-11":
    "Selected text gets a page link; generic URL editing/Notion comparison not tested.",
  "EDIT-15":
    "Plain-text and search newline contract tested; full Markdown/HTML roundtrip losses not covered.",
  "DB-08":
    "Row IDs and values restored through history; row bodies and every layout-specific restored view not tested.",
  "UX-07":
    "First match selection across marks tested; next/previous highlighting is not implemented.",
  "QA-01":
    "Unknown IPC, schema and runtime isolation tested; not an exhaustive sender/frame attack suite.",
  "QA-04":
    "Commands run in existing working tree using lockfile; not a fresh checkout/npm ci.",
  "QA-05": "Current-candidate scanner passed; historical findings remain.",
  "QA-06":
    "Source hashes and baseline artifact hashes fixed; no new Notion observation.",
};
writeJSON("review/2026-10-26/gate-a-results.json", {
  baseline,
  head,
  catalogSha256: sha(
    readFileSync("review/2026-10-26/Folio_Acceptance_Catalog.json"),
  ),
  notionComparison: "NOT_RUN",
  note: "Folio-only supplemental evidence. Original catalog unchanged. No Notion agreement ratio is calculated.",
  cases: catalog.cases.map((c) => ({
    id: c.id,
    status: passed.includes(c.id)
      ? "PASS"
      : partial[c.id]
        ? "PARTIAL"
        : "NOT_RUN",
    scope:
      partial[c.id] ||
      (passed.includes(c.id)
        ? "Folio local quality contract; see docs/AUDIT-RESPONSE.md"
        : "Outside verified Gate A scope or manual observation pending"),
  })),
});
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );
}
const sources = [
  ...files("src"),
  ...files("tests").filter((p) => /\.(ts|mjs)$/.test(p)),
  "scripts/migrate-workspace.mjs",
  "scripts/write-gate-a-evidence.mjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "playwright.config.ts",
  "vitest.config.ts",
  "docs/AUDIT-RESPONSE.md",
  "docs/PROGRESS.md",
  "docs/TEST-RESULTS.md",
];
const built = [
  "dist/main.cjs",
  "dist/preload.cjs",
  "release/Folio-darwin-arm64/Folio.app/Contents/Resources/app.asar",
];
const evidence = [
  ...sources,
  ...built,
  "docs/validation/gate-a/results.json",
  "review/2026-10-26/gate-a-results.json",
];
writeJSON(join(shared, "manifest.json"), {
  baseline,
  head,
  sourceState: results.sourceState,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    timezone: "Asia/Tokyo",
  },
  protectedData: results.protectedData,
  lockUnchanged,
  files: evidence.map((path) => ({ path, sha256: sha(readFileSync(path)) })),
  logs,
});
console.log(
  JSON.stringify(
    {
      unit: results.unit,
      gateAElectron: results.gateAElectron,
      fullElectron: results.fullElectron,
      protectedData: results.protectedData,
      lockUnchanged,
      manifest: "docs/validation/gate-a/manifest.json",
    },
    null,
    2,
  ),
);
