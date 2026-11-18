import { build } from "../../node_modules/esbuild/lib/main.js";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../../package.json", import.meta.url));
const labRequire = createRequire(new URL("./package.json", import.meta.url));
const rootModules = new URL("../../node_modules/", import.meta.url).pathname;
const labModules = new URL("./node_modules/", import.meta.url).pathname;
const result = await build({
  entryPoints: [new URL("./runtime/entry.ts", import.meta.url).pathname],
  outfile: new URL("./runtime/bundle.cjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "cjs",
  metafile: true,
  plugins: [
    {
      name: "one-prosemirror",
      setup(b) {
        b.onResolve({ filter: /^prosemirror-[^/]+$/ }, (args) => {
          const lab = args.path === "prosemirror-collab",
            path = (lab ? labRequire : require).resolve(args.path);
          if (!path.startsWith(lab ? labModules : rootModules))
            throw Error(
              "ProseMirror resolved outside the owning package: " + args.path,
            );
          return { path };
        });
      },
    },
  ],
});
const families = {};
for (const path of Object.keys(result.metafile.inputs)) {
  const match = path.match(/node_modules\/(prosemirror-[^/]+)\//);
  if (match) (families[match[1]] ??= []).push(path);
}
for (const [name, paths] of Object.entries(families))
  if (paths.length !== 1)
    throw Error("Multiple ProseMirror implementations: " + name);
writeFileSync(
  new URL("./runtime/meta.json", import.meta.url),
  JSON.stringify(result.metafile, null, 2),
);
writeFileSync(
  new URL("./runtime-modules.json", import.meta.url),
  JSON.stringify({ prosemirrorInputs: families, nodeOnly: true }, null, 2) +
    "\n",
);
console.log(
  "Built actual Folio schema and both adapters with one ProseMirror family.",
);
