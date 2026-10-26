import { spawn } from "node:child_process";
import { createServer } from "vite";
await import("./build.mjs");
const server = await createServer();
await server.listen();
const proc = spawn("node_modules/.bin/electron", ["."], {
  stdio: "inherit",
  env: { ...process.env, FOLIO_DEV_URL: "http://127.0.0.1:5173" },
});
proc.on("exit", async () => {
  await server.close();
  process.exit();
});
