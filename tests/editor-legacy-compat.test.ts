import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { validDocument } from "../src/shared/validation";

it("the baseline validator accepts legacy content and rejects new ID attributes instead of silently reading them", async () => {
  const dir = mkdtempSync(
    resolve("output/agent-workspace/evidence/legacy-validator-"),
  );
  const base = "b7c150d15739c59edf6ba9a62ebda4794748d46b";
  for (const name of ["editor-schema.ts", "validation.ts"]) {
    const content = execFileSync(
      "git",
      ["show", `${base}:src/shared/${name}`],
      { encoding: "utf8" },
    );
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
