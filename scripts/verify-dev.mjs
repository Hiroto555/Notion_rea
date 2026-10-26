import { createServer } from "vite";
import { _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const folder = mkdtempSync(resolve("output/dev-smoke-"));
const server = await createServer({ server: { port: 5173, strictPort: true } });
let app;
try {
  await server.listen();
  app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: {
      ...process.env,
      FOLIO_DATA_DIR: folder,
      FOLIO_DEV_URL: "http://127.0.0.1:5173",
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".page-title");
  const title = await page.locator(".page-title").inputValue();
  if (title !== "ようこそ、Folioへ")
    throw new Error("Unexpected title: " + title);
  writeFileSync(
    "output/dev-smoke.json",
    JSON.stringify({ ok: true, title, origin: page.url() }),
  );
  console.log("Vite + Electron + IPC dev startup passed");
} finally {
  await app?.close();
  await server.close();
  rmSync(folder, { recursive: true, force: true });
}
