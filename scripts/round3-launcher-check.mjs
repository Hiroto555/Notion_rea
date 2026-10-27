import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
const root = mkdtempSync(resolve("output/round-3-2761365/evidence/launcher-"));
mkdirSync(join(root, "workspace")); mkdirSync(join(root, "cache"));
const blocker = createServer();
await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(0, "127.0.0.1", resolve); });
const port = blocker.address().port;
const env = { ...process.env, FOLIO_DATA_DIR: join(root, "workspace"), FOLIO_VITE_CACHE_DIR: join(root, "cache"), FOLIO_DEV_PORT: String(port) };
const start = () => spawn(process.execPath, ["scripts/dev.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
const occupied = start(); let blockedLog = "";
occupied.stdout.on("data", c => blockedLog += c); occupied.stderr.on("data", c => blockedLog += c);
const blockedCode = await new Promise((resolve, reject) => { occupied.once("error", reject); occupied.once("exit", code => resolve(code)); });
const blockerStillListening = blocker.listening;
await new Promise(resolve => blocker.close(resolve));
console.log(JSON.stringify({ test: "occupied-port", port, code: blockedCode, blockerStillListening, rejected: /in use/i.test(blockedLog) }));
const child = start(); let output = "", electronPid = null;
child.stdout.on("data", chunk => {
  output += chunk;
  const match = output.match(/Electron PID (\d+)/);
  if (match && !electronPid) { electronPid = Number(match[1]); child.kill("SIGTERM"); }
});
child.stderr.on("data", chunk => output += chunk);
const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
let pidAlive = null;
if (electronPid) { try { process.kill(electronPid, 0); pidAlive = true; } catch (e) { if (e.code === "ESRCH") pidAlive = false; else throw e; } }
const portAvailable = await new Promise(resolve => { const probe = createServer(); probe.once("error", () => resolve(false)); probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true))); });
console.log(JSON.stringify({ test: "signal-cleanup", port, exit, electronPid, pidAlive, portAvailable, output }));
if (!(blockedCode !== 0 && blockerStillListening && /in use/i.test(blockedLog) && electronPid && pidAlive === false && portAvailable)) process.exitCode = 1;
