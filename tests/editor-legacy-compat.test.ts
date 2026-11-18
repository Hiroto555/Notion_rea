import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { validDocument } from "../src/shared/validation";

const BASELINE_COMMIT = "b7c150d15739c59edf6ba9a62ebda4794748d46b";
const FIXTURE_DIRECTORY = resolve("tests/fixtures/legacy-editor-b7c150d");

type ProvenanceFile = {
  file: string;
  original: string;
  sha256: string;
  bytes: number;
};
type Provenance = {
  baselineCommit: string;
  author: string;
  files: ProvenanceFile[];
};

const sha256 = (contents: Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

it("the baseline validator accepts legacy content and rejects new ID attributes instead of silently reading them", async () => {
  const provenance = JSON.parse(
    readFileSync(join(FIXTURE_DIRECTORY, "PROVENANCE.json"), "utf8"),
  ) as Provenance;
  expect(provenance.baselineCommit).toBe(BASELINE_COMMIT);
  const fixtures = new Map<string, ProvenanceFile>();
  for (const entry of provenance.files) fixtures.set(entry.file, entry);
  mkdirSync(resolve("output/agent-workspace/evidence"), { recursive: true });
  const dir = mkdtempSync(
    resolve("output/agent-workspace/evidence/legacy-validator-"),
  );
  for (const name of ["editor-schema.ts", "validation.ts"]) {
    const fixture = fixtures.get(`${name}.txt`);
    expect(fixture).toBeDefined();
    expect(fixture!.original).toBe(`src/shared/${name}`);
    const content = readFileSync(join(FIXTURE_DIRECTORY, `${name}.txt`));
    expect(sha256(content)).toBe(fixture!.sha256);
    expect(content.byteLength).toBe(fixture!.bytes);
    writeFileSync(join(dir, name), content);
  }
  const file = join(dir, "legacy.cjs");
  await build({
    entryPoints: [join(dir, "validation.ts")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const legacy = createRequire(file)(file) as {
    validDocument: (doc: unknown) => boolean;
  };
  const oldDoc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "original" }] },
    ],
  };
  const upgraded = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "synthetic-id" },
        content: [{ type: "text", text: "original" }],
      },
    ],
  };
  expect(legacy.validDocument(oldDoc)).toBe(true);
  expect(validDocument(oldDoc)).toBe(true);
  expect(validDocument(upgraded)).toBe(true);
  expect(legacy.validDocument(upgraded)).toBe(false);
});
