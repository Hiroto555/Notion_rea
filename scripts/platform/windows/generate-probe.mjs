import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
if (args.length !== 1)
  throw Error("Usage: node generate-probe.mjs <owned-output.cs>");
const source = readFileSync(
  new URL("./probe-private-root.ps1", import.meta.url),
  "utf8",
);
const match =
  /Add-Type -Language CSharp -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(
    source,
  );
if (!match) throw Error("PROBE_SOURCE_MISSING");
const output = resolve(args[0]);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, match[1] + "\n");
process.stdout.write(
  JSON.stringify({
    source: "probe-private-root.ps1",
    sha256: createHash("sha256")
      .update(match[1] + "\n")
      .digest("hex"),
  }) + "\n",
);
