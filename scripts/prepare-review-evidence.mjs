// Run only in the research workspace with the original evidence present.
// Does not execute REA, access Notion, or alter any original evidence.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const provenance = (path) => ({
  path,
  sha256: hash(readFileSync(resolve(root, path))),
  availability: "local-only; excluded from review tree",
});
const portable = (value) =>
  JSON.parse(JSON.stringify(value).split(root).join("<PROJECT_ROOT>"));
const save = (path, value) =>
  writeFileSync(resolve(root, path), JSON.stringify(value, null, 2) + "\n");
for (const dir of ["docs/rea/evidence", "docs/validation", "docs/screenshots"])
  mkdirSync(resolve(root, dir), { recursive: true });
const base = "research/evidence/";
const environment = read(base + "environment.json");
save("docs/rea/evidence/environment.json", {
  kind: "redacted-derivative",
  source: provenance(base + "environment.json"),
  redactions: ["Absolute project path replaced by <PROJECT_ROOT>."],
  facts: portable(environment),
});
for (const [input, output] of [
  ["rea-inspect_desktop_application.json", "notion-desktop-summary.json"],
  ["rea-analyze_javascript_application.json", "folio-static-summary.json"],
]) {
  const s = read(base + input).structuredContent;
  const n = s.normalized_result;
  const summary = structuredClone(n.summary);
  const removed = [
    "MCP text duplicate, host identity, raw results, file locations, next-probe suggestions",
  ];
  if (summary.root) {
    delete summary.root.identity;
    delete summary.root.namespace_id;
  }
  delete summary.next_probe_groups;
  save(
    "docs/rea/evidence/" + output,
    portable({
      kind: "selected-redacted-derivative",
      source: provenance(base + input),
      redactions: [
        ...removed,
        "Absolute project path replaced by <PROJECT_ROOT>.",
      ],
      evidenceId: s.evidence_id,
      provider: s.provider,
      parentEvidenceId: n.parent_evidence_id,
      parentOperation: n.parent_operation,
      parentDigest: n.parent_digest,
      viewDigest: n.view_digest,
      artifact: n.artifact,
      viewCoverage: n.coverage,
      summary,
      limitations: n.limitations,
      unknowns: n.unknowns,
    }),
  );
}
const browser = read(
  base + "rea-capture_browser_scenario.json",
).structuredContent;
const n = browser.normalized_result;
save("docs/rea/evidence/public-help-summary.json", {
  kind: "metadata-only-derivative",
  source: provenance(base + "rea-capture_browser_scenario.json"),
  evidenceId: browser.evidence_id,
  provider: browser.provider,
  operation: browser.operation,
  startUrl: browser.parameters.start_url,
  scenarioSha256: browser.parameters.scenario_sha256,
  captureKinds: browser.parameters.capture.at_end,
  initialStorageCounts: {
    cookies: browser.parameters.storage.cookies.length,
    localStorage: browser.parameters.storage.local_storage.length,
    sessionStorage: browser.parameters.storage.session_storage.length,
  },
  declaredSecretCount: browser.parameters.secrets.length,
  browser: n.browser,
  completeness: n.completeness,
  limitations: n.limitations,
  omitted: [
    "All captured HTML, accessibility text, events, page assets and code; no private Notion page captured.",
  ],
  scope:
    "Completeness applies to selected public-page capture, not Notion behavior or internals.",
});
const tools = read(base + "rea-tools.json").tools;
const used = [
  "inspect_desktop_application",
  "capture_browser_scenario",
  "analyze_javascript_application",
];
if (used.some((name) => !tools.some((tool) => tool.name === name)))
  throw new Error("Recorded tool list is missing a used tool");
save("docs/rea/evidence/mcp-capabilities.json", {
  kind: "selected-metadata-derivative",
  source: provenance(base + "rea-tools.json"),
  advertisedToolCount: tools.length,
  usedTools: used,
  omitted:
    "Full tool descriptions and schemas; see installed REA server for fresh capabilities.",
  scope:
    "Enumeration does not establish that every advertised analysis engine is installed or runnable.",
});
const validation = read(base + "final-validation.json");
const checks = Object.entries(validation.hashes).map(([path, expected]) => ({
  path,
  expected,
  actual: hash(readFileSync(resolve(root, path))),
}));
const mismatch = checks.filter((x) => x.expected !== x.actual);
if (mismatch.length)
  throw new Error(
    "Validation evidence drift: " + mismatch.map((x) => x.path).join(", "),
  );
save("docs/validation/baseline.json", {
  kind: "redacted-derivative",
  source: provenance(base + "final-validation.json"),
  baselineCommit: "abb1e3131d1b4cab6aee4560c6d8aa819859bc29",
  redactions: ["Absolute project paths replaced by <PROJECT_ROOT>."],
  ...portable(validation),
  sourceHashesVerifiedDuringReviewPreparation: true,
});
save("docs/validation/benchmark.json", read("output/benchmark.json"));
for (const name of [
  "unit-tests.log",
  "e2e-tests.log",
  "typecheck.log",
  "build.log",
]) {
  const content = readFileSync(resolve(root, "output", name), "utf8")
    .split(root)
    .join("<PROJECT_ROOT>");
  writeFileSync(
    resolve(root, "docs/validation", name.replace(".log", ".txt")),
    content,
  );
}
save("docs/validation/smoke.json", {
  dev: portable(read("output/dev-smoke.json")),
  packaged: portable(read("output/package-smoke.json")),
  source: [
    provenance("output/dev-smoke.json"),
    provenance("output/package-smoke.json"),
  ],
});
const screenshots = ["folio-light.png", "folio-dark.png", "folio-board.png"];
for (const name of screenshots)
  copyFileSync(
    resolve(root, "output/playwright", name),
    resolve(root, "docs/screenshots", name),
  );
save("docs/screenshots/manifest.json", {
  capturedDate: "2026-10-26",
  application: "Folio",
  data: "Own seed content and synthetic E2E data; visually inspected.",
  images: screenshots.map((name) => ({
    path: name,
    source: "output/playwright/" + name,
    sha256: hash(readFileSync(resolve(root, "docs/screenshots", name))),
  })),
});
copyFileSync(
  resolve(root, base, "notion-ui-observation.md"),
  resolve(root, "docs/rea/notion-ui-observation.md"),
);
console.log(
  "Selected review evidence generated. Original files unchanged; baseline hashes match.",
);
