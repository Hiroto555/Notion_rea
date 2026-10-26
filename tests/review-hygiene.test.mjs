import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  inspectContent,
  inspectTree,
  sha256,
} from "../scripts/review-hygiene.mjs";
test("detects credentials and paths without copying values to findings", () => {
  const credential = "ghp_" + "A".repeat(36);
  const localPath = ["", "Users", "fixture-user", "project"].join("/");
  const report = inspectContent(
    "fixture.txt",
    Buffer.from(credential + "\n" + localPath),
  );
  assert.deepEqual(report.map((x) => x.category).sort(), [
    "github-token",
    "personal-path",
  ]);
  assert.equal(JSON.stringify(report).includes(credential), false);
  assert.equal(JSON.stringify(report).includes(localPath), false);
});
test("email attribution exception matches only the exact approved email hash", () => {
  const approved = ["author", "example.org"].join("@");
  const other = ["person", "example.org"].join("@");
  const result = inspectContent(
    "NOTICE",
    Buffer.from(approved + "\n" + other),
    [sha256(approved)],
  );
  assert.deepEqual(result, [{ path: "NOTICE", category: "email", line: 2 }]);
});
test("rejects a new binary and accepts only the reviewed bytes", () => {
  const root = mkdtempSync(resolve("output/review-fixture-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const bytes = Buffer.from([0, 1, 2, 3]);
    writeFileSync(resolve(root, "fixture.bin"), bytes);
    assert.ok(
      inspectTree(root, {}).findings.some(
        (x) => x.category === "unreviewed-binary",
      ),
    );
    assert.equal(
      inspectTree(root, {
        reviewedBinaries: { "fixture.bin": { sha256: sha256(bytes) } },
      }).findings.length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("ignored files are excluded, but already tracked raw evidence still fails", () => {
  const root = mkdtempSync(resolve("output/review-fixture-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(resolve(root, ".gitignore"), ".env\nresearch/evidence/*\n");
    writeFileSync(resolve(root, ".env"), "private content");
    mkdirSync(resolve(root, "research/evidence"), { recursive: true });
    writeFileSync(resolve(root, "research/evidence/raw.json"), "{}");
    assert.equal(inspectTree(root, {}).files.includes(".env"), false);
    execFileSync("git", [
      "-C",
      root,
      "add",
      "-f",
      "research/evidence/raw.json",
    ]);
    assert.ok(
      inspectTree(root, {}).findings.some(
        (x) => x.category === "excluded-material-tracked",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("rejects symlinks without reading a target outside the review tree", () => {
  const root = mkdtempSync(resolve("output/review-fixture-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    symlinkSync("/nonexistent-review-test-target", resolve(root, "external"));
    assert.deepEqual(inspectTree(root, {}).findings, [
      { path: "external", category: "non-regular-file" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
