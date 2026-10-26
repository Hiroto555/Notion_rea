// Snapshot only the current reviewed files; never includes .git or raw evidence.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runAudit, reviewFiles, sha256 } from "./review-hygiene.mjs";
const root = resolve(import.meta.dirname, "..");
const audit = runAudit(root, false);
if (audit.current.findings.length)
  throw new Error("Review scan failed. Run npm run review:scan for locations.");
const files = reviewFiles(root);
const target = resolve(root, "output/review");
mkdirSync(target, { recursive: true });
const manifest = files.map((path) => ({
  path,
  sha256: sha256(readFileSync(resolve(root, path))),
}));
writeFileSync(resolve(target, "files.txt"), files.join("\n") + "\n");
const archive = resolve(target, "folio-review.tar.gz");
execFileSync("tar", ["-czf", archive, "--null", "-T", "-"], {
  cwd: root,
  input: Buffer.from(files.join("\0") + "\0"),
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
const listed = execFileSync("tar", ["-tzf", archive])
  .toString()
  .trim()
  .split("\n")
  .sort();
if (JSON.stringify(listed) !== JSON.stringify(files))
  throw new Error("Archive contains unexpected or missing files.");
// Re-read every archived file to detect an edit racing with packaging.
for (const file of manifest) {
  const bytes = execFileSync("tar", ["-xOf", archive, file.path], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (sha256(bytes) !== file.sha256)
    throw new Error("Archive byte mismatch: " + file.path);
}
writeFileSync(
  resolve(target, "manifest.json"),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      baselineCommit: audit.baselineCommit,
      includesUncommittedPreparation: true,
      includesGitHistory: false,
      archiveSha256: sha256(readFileSync(archive)),
      files: manifest,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Created output/review/folio-review.tar.gz (" +
    files.length +
    " verified files); no upload.",
);
