import { build } from "../../../node_modules/esbuild/lib/main.js";
import { copyFileSync } from "node:fs";
await build({
  entryPoints: [
    new URL("./runtime-semantic-entry.ts", import.meta.url).pathname,
  ],
  outfile: new URL("./runtime-semantic.cjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "cjs",
});
copyFileSync(
  new URL("./runtime-semantic.cjs", import.meta.url),
  new URL("../runtime-semantic.cjs", import.meta.url),
);
