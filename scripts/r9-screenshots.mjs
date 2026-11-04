import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import { _electron as electron, expect } from "@playwright/test";
const root = process.cwd(),
  output = resolve(process.argv[2] ?? "output/r9-screens");
const rel = relative(join(root, "output"), output);
if (!rel || rel.startsWith(".." + sep) || rel === ".." || existsSync(output))
  throw new Error("Use a new directory under this worktree output/");
mkdirSync(output, { recursive: true });
const require = createRequire(import.meta.url);
const bundle = join(output, "seed.cjs");
buildSync({
  entryPoints: [join(root, "scripts/r9-demo-seed.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
});
const data = join(output, "data");
mkdirSync(data);
const manifest = require(bundle).seedDemo(
  join(data, "workspace.sqlite"),
  join(output, "manifest.json"),
  join(root, "tests/fixtures/image.png"),
);
const env = { ...process.env, FOLIO_DATA_DIR: data };
delete env.FOLIO_DEV_URL;
const app = await electron.launch({
  args: [join(root, "dist/main.cjs")],
  cwd: root,
  env,
});
const screens = [];
try {
  const page = await app.firstWindow();
  await expect(page.locator(".page-title")).toHaveValue(manifest.w3.title);
  const shot = async (name) => {
    await page.waitForTimeout(150);
    const path = join(output, name + ".png");
    await page.screenshot({ path });
    screens.push({ name, path });
  };
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000),
  );
  await expect(
    page.locator(".folio-editor aside[data-folio-callout]"),
  ).toHaveCount(3);
  await expect(page.locator(".folio-editor table")).toBeVisible();
  await shot("W3-overview");
  await page
    .locator(".folio-editor aside[data-folio-callout] p")
    .first()
    .click();
  await expect(
    page.getByRole("toolbar", { name: "コールアウトの操作", exact: true }),
  ).toBeVisible();
  await shot("W3-callout-controls");
  await page.locator(".folio-editor table td").first().click();
  await expect(
    page.getByRole("toolbar", { name: "表の操作", exact: true }),
  ).toBeVisible();
  await shot("W3-table-controls");
  await page.keyboard.press("Meta+Shift+l");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(960, 900),
  );
  await shot("W3-dark-narrow");
  const bounds = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(".document-scroll,.rich-block-toolbar"),
    ).map((el) => ({
      class: el.className,
      width: el.clientWidth,
      scroll: el.scrollWidth,
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
      viewport: innerWidth,
    })),
  );
  if (bounds.some((b) => b.scroll > b.width + 2 || b.right > b.viewport + 1))
    throw new Error("Page or toolbar overflows: " + JSON.stringify(bounds));
  writeFileSync(join(output, "bounds.json"), JSON.stringify(bounds, null, 2));
} finally {
  await app.close();
}
writeFileSync(join(output, "screens.json"), JSON.stringify(screens, null, 2));
console.log(JSON.stringify(screens));
