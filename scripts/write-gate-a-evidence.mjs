// Import-safe Gate A evidence writer bound to the CURRENT verified package.
//
// This is the modernization of the historical one-shot exporter: it no longer
// runs Git, reads real user data, or rewrites the fixed 2026-10-26 review/docs
// files. It wraps createEvidenceManifest output in the gate-a schema and
// writes it exclusively inside the bound validation runRoot. Historical
// outputs remain in place and are only referenced, never claimed as current.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonical,
  createEvidenceManifest,
  parseEvidenceArgs,
  readEvidenceIntent,
  readSelectionFile,
  writeRunJson,
} from "./write-evidence-manifest.mjs";

export const GATE_A_SCHEMA = "folio.package-gate-a-evidence.v2";
export const GATE_A_NAME = "gate-a-evidence.json";

// Writes {schema: folio.package-gate-a-evidence.v2, manifest: <v2 evidence>}
// to a fresh file under the run's runRoot. outputPath defaults to
// <runRoot>/gate-a-evidence.json. No Git, real-data or historical writes.
export function writeGateAEvidence(
  { outputPath, ...createOptions } = {},
  dependencies = {},
) {
  const manifest = createEvidenceManifest(createOptions, dependencies);
  const ctx = readEvidenceIntent(createOptions.intentPath, dependencies);
  const resolved = writeRunJson(
    ctx.runRoot,
    outputPath ?? join(ctx.runRoot, GATE_A_NAME),
    { schema: GATE_A_SCHEMA, manifest },
  );
  return Object.freeze({ outputPath: resolved, manifest });
}

export function main(args = process.argv.slice(2), dependencies = {}) {
  const parsed = parseEvidenceArgs(args);
  if (parsed.mode === "create-intent") {
    throw new Error(
      "EVIDENCE_ARGUMENTS: create intents via scripts/write-evidence-manifest.mjs",
    );
  }
  const selection = readSelectionFile(parsed.selectionPath);
  const ctx = readEvidenceIntent(parsed.intentPath, dependencies);
  if (canonical(selection) !== canonical(ctx.intent.selection))
    throw new Error("EVIDENCE_SELECTION_MISMATCH");
  const outcome = writeGateAEvidence(
    {
      intentPath: parsed.intentPath,
      unitRecord: parsed.unitRecord,
      buildRecord: parsed.buildRecord,
      checkRecord: parsed.checkRecord,
      ...(parsed.guiRecord ? { guiRecord: parsed.guiRecord } : {}),
      outputPath: parsed.outputPath,
    },
    dependencies,
  );
  console.log(outcome.outputPath);
  return outcome;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
