import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("checks built HTML/CSS dependencies without opening a browser and refuses external or missing assets", () => {
  const root = mkdtempSync(join(tmpdir(), "folio-local-assets-"));
  try {
    mkdirSync(join(root, "assets"));
    writeFileSync(
      join(root, "index.html"),
      '<script src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">',
    );
    writeFileSync(join(root, "assets/app.js"), 'console.log("local")');
    writeFileSync(
      join(root, "assets/app.css"),
      '@font-face{src:url("./font.woff2")}',
    );
    writeFileSync(join(root, "assets/font.woff2"), "synthetic");
    const run = () =>
      spawnSync(
        process.execPath,
        [resolve("scripts/check-local-assets.mjs"), root],
        { encoding: "utf8", timeout: 5000 },
      );
    expect(run().status).toBe(0);
    writeFileSync(
      join(root, "assets/app.css"),
      '@import "https://example.invalid/style.css";',
    );
    expect(run().status).toBe(1);
    writeFileSync(
      join(root, "assets/app.css"),
      'body{background:url("./missing.png")}',
    );
    expect(run().status).toBe(1);
    writeFileSync(
      join(root, "index.html"),
      '<script src="https://example.invalid/required.js"></script>',
    );
    expect(run().status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
