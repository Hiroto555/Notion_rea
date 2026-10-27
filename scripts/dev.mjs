import { spawn } from "node:child_process";
import { createServer } from "vite";
await import("./build.mjs");
const server = await createServer();
let proc;
const stopChild = () => { if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill(); };
process.once("SIGINT", stopChild);
process.once("SIGTERM", stopChild);
try {
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Vite did not provide a local URL");
  proc = spawn("node_modules/.bin/electron", ["."], { stdio: "inherit", env: { ...process.env, FOLIO_DEV_URL: url } });
  console.log(`Folio development server ${url}; Electron PID ${proc.pid}`);
  const result = await new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process.exitCode = result.code ?? (result.signal ? 1 : 0);
} finally {
  stopChild();
  await server.close();
  process.removeListener("SIGINT", stopChild);
  process.removeListener("SIGTERM", stopChild);
}
