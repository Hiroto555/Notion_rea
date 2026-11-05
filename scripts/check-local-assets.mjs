import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

const root = realpathSync(resolve(process.argv[2] || "dist/renderer"));
const seen = new Set();
const queue = [resolve(root, "index.html")];
function localFile(reference, source) {
  if (!reference || reference.startsWith("#") || reference.startsWith("data:"))
    return;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference))
    throw new Error("External build asset in " + relative(root, source));
  const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  const path = realpathSync(resolve(dirname(source), clean));
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
    throw new Error("Build asset escapes renderer");
  if (!statSync(path).isFile())
    throw new Error("Build asset is not a regular file");
  if (!seen.has(path)) queue.push(path);
}
while (queue.length) {
  const path = queue.pop();
  if (seen.has(path)) continue;
  if (seen.size >= 1000)
    throw new Error("Build asset count exceeds inspection limit");
  seen.add(path);
  const kind = extname(path);
  if (kind !== ".html" && kind !== ".css") continue;
  if (statSync(path).size > 20 * 1024 * 1024)
    throw new Error("Build entry is too large to inspect");
  const content = readFileSync(path, "utf8");
  if (kind === ".html") {
    for (const tag of content.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      const ref =
        /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag[0]);
      if (ref) localFile(ref[1] ?? ref[2] ?? ref[3], path);
    }
  } else {
    for (const item of content.matchAll(
      /url\(\s*['"]?([^'")\s]+)['"]?\s*\)|@import\s+["']([^"']+)["']/gi,
    ))
      localFile(item[1] ?? item[2], path);
  }
}
console.log(
  JSON.stringify({
    status: "PASS",
    files: seen.size,
    scope:
      "HTML script/style references and CSS dependencies are local build files",
  }),
);
