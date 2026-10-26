import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (root, args) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
export function reviewFiles(root) {
  return [
    ...new Set(
      git(root, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ])
        .toString()
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
}
export function inspectContent(path, bytes, approvedEmails = []) {
  const text = bytes.toString("utf8");
  const found = [];
  const rules = [
    [
      "github-token",
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    ],
    [
      "service-key",
      /\b(?:sk|rk)-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{20,}\b/g,
    ],
    ["aws-access-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ["google-api-key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
    ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
    ["private-key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
    ["credential-url", /https?:\/\/[^\s/@:]+:[^\s/@]+@/g],
    [
      "assigned-credential",
      /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|authorization)["']?\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/gi,
    ],
    [
      "personal-path",
      /(?:\/(?:Users|home)\/[^/\s"'<>]+|[A-Z]:\\Users\\[^\\\s"'<>]+)/g,
    ],
    ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ];
  for (const [category, pattern] of rules) {
    for (const match of text.matchAll(pattern)) {
      if (category === "email" && approvedEmails.includes(sha256(match[0])))
        continue;
      found.push({
        path,
        category,
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
  // Never emit matched credentials or personal data in the report.
  return [...new Map(found.map((x) => [JSON.stringify(x), x])).values()];
}
export function inspectTree(root, policy) {
  const files = reviewFiles(root),
    findings = [],
    binaries = [];
  for (const path of files) {
    const rel = relative(root, resolve(root, path));
    if (isAbsolute(rel) || rel.startsWith("..") || /[\r\n]/.test(path)) {
      findings.push({ path: "<invalid-path>", category: "unsafe-path" });
      continue;
    }
    const stat = lstatSync(resolve(root, path));
    if (!stat.isFile()) {
      findings.push({ path, category: "non-regular-file" });
      continue;
    }
    if (
      (path.startsWith("research/evidence/") &&
        path !== "research/evidence/README.md") ||
      (/(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|\.netrc|credentials[^/]*\.json|service-account[^/]*\.json)$/.test(
        path,
      ) &&
        !path.endsWith("/.env.example") &&
        path !== ".env.example") ||
      /\.(?:pem|key|p12|pfx|keystore|sqlite(?:3)?(?:-(?:wal|shm))?|db(?:-(?:wal|shm))?|asar|har|trace)$/.test(
        path,
      ) ||
      /(?:^|\/)(?:node_modules|\.git|\.folio-data|backups|release|dist)(?:\/|$)/.test(
        path,
      ) ||
      (path.startsWith("output/") && path !== "output/.gitkeep")
    ) {
      findings.push({ path, category: "excluded-material-tracked" });
    }
    const bytes = readFileSync(resolve(root, path));
    findings.push(
      ...inspectContent(path, bytes, policy.approvedEmailHashes?.[path] ?? []),
    );
    if (bytes.includes(0)) {
      binaries.push({ path, sha256: sha256(bytes), bytes: bytes.length });
      if (policy.reviewedBinaries?.[path]?.sha256 !== sha256(bytes))
        findings.push({ path, category: "unreviewed-binary" });
    }
  }
  return { files, findings, binaries };
}
export function inspectHistory(root, policy) {
  const objects = git(root, ["rev-list", "--objects", "--all"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  const findings = [];
  let blobsScanned = 0;
  for (const item of objects) {
    const [oid, ...rest] = item.split(" "),
      path = rest.join(" ");
    if (git(root, ["cat-file", "-t", oid]).toString().trim() !== "blob")
      continue;
    blobsScanned++;
    const bytes = git(root, ["cat-file", "blob", oid]);
    findings.push(
      ...inspectContent(
        path,
        bytes,
        policy.approvedEmailHashes?.[path] ?? [],
      ).map((x) => ({ ...x, blob: oid })),
    );
    if (path === "research/evidence/rea-capture_browser_scenario.json")
      findings.push({ path, blob: oid, category: "raw-public-page-capture" });
  }
  const authors = git(root, ["log", "--all", "--format=%ae%n%ce"])
    .toString()
    .split("\n")
    .filter(Boolean);
  return {
    scope:
      "All locally reachable refs; not unreachable objects or un-fetched remote refs.",
    blobsScanned,
    authorEmailIdentities: new Set(authors).size,
    findings,
  };
}
export function runAudit(root, history = true) {
  const policy = JSON.parse(
    readFileSync(resolve(root, "docs/review-policy.json"), "utf8"),
  );
  const current = inspectTree(root, policy);
  return {
    generatedAt: new Date().toISOString(),
    baselineCommit: git(root, ["rev-parse", "HEAD"]).toString().trim(),
    scope:
      "Current index paths plus nonignored untracked files, read from working tree. No upload.",
    current: {
      fileCount: current.files.length,
      findings: current.findings,
      binaries: current.binaries,
    },
    history: history ? inspectHistory(root, policy) : null,
    limits:
      "Pattern scan plus a reviewed binary allowlist. Does not prove absence of all secrets, PII, copyrighted material, or application vulnerabilities.",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(import.meta.dirname, "..");
  const result = runAudit(root);
  mkdirSync(resolve(root, "output/review-prep"), { recursive: true });
  writeFileSync(
    resolve(root, "output/review-prep/sharing-scan.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        files: result.current.fileCount,
        currentFindings: result.current.findings,
        historyFindings: result.history.findings,
        authorEmailIdentities: result.history.authorEmailIdentities,
      },
      null,
      2,
    ),
  );
  if (result.current.findings.length) process.exitCode = 1;
}
