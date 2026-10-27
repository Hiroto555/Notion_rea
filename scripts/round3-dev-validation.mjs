import { createServer } from "vite";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const base = mkdtempSync(resolve("output/round-3-2761365/evidence/dev-run-"));
const cacheRoot = join(base, "cache"); mkdirSync(cacheRoot);
const results = [];
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
async function trial(label, cache, negative = false, link = false) {
  const output = join(base, label), events = [];
  mkdirSync(output);
  const plugin = { name: "round3-http-observation", configureServer(server) { server.middlewares.use((req, _res, next) => { events.push({ stage: "http-request", url: req.url, at: Date.now() }); next(); }); } };
  let server, code = null, port = null, pidAlive = null, diagnostic = null, portAvailable = null;
  try {
    server = await createServer({ cacheDir: cache, plugins: [plugin], server: { host: "127.0.0.1", port: 0, strictPort: true } });
    await server.listen(); port = server.httpServer.address().port;
    events.push({ stage: "http-listen", port, at: Date.now() });
    const url = `http://127.0.0.1:${port}/`;
    const args = link ? ["playwright", "test", "tests/e2e/dialogs.spec.ts", "--grep", "selected text link", "--retries=0", "--reporter=list", `--output=${output}/playwright`] : ["playwright", "test", "--config=playwright.dev-round3.config.ts", "--retries=0", `--output=${output}/playwright`];
    const proc = spawn("npx", args, { env: { ...process.env, FOLIO_DEV_URL: url, FOLIO_TEST_FORCE_READY_FAILURE: negative ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; proc.stdout.on("data", chunk => log += chunk); proc.stderr.on("data", chunk => log += chunk);
    code = await new Promise((resolve, reject) => { proc.once("error", reject); proc.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0))); });
    writeFileSync(join(output, "playwright.txt"), log + `\nexit_code=${code}\n`);
    const files = walk(output), diagPath = files.find(f => f.endsWith("startup-diagnostics.json"));
    if (diagPath) {
      diagnostic = JSON.parse(readFileSync(diagPath, "utf8"));
      const launch = diagnostic.find(e => e.stage === "launch-complete");
      if (launch?.detail?.pid) { try { process.kill(launch.detail.pid, 0); pidAlive = true; } catch (e) { if (e.code === "ESRCH") pidAlive = false; else throw e; } }
    }
  } catch (error) { events.push({ stage: "exception", error: String(error) }); }
  finally { if (server) { await server.close(); events.push({ stage: "server-closed", listening: server.httpServer?.listening ?? false, at: Date.now() }); } }
  if (port !== null) portAvailable = await new Promise(resolve => {
    const probe = createNetServer(); probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
  const trace = walk(output).some(f => f.endsWith("trace.zip"));
  const ok = negative ? code !== null && code !== 0 && pidAlive === false && portAvailable === true && trace && diagnostic?.some(e => e.stage === "failure") : code === 0 && pidAlive === false && portAvailable === true;
  const result = { label, cache, code, port, portAvailable, pidAlive, trace, ok, events, output };
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
  results.push(result); console.log(JSON.stringify({ label, code, pidAlive, portAvailable, trace, ok, port }));
}
await trial("negative", join(cacheRoot, "negative"), true);
for (let i = 1; i <= 5; i++) await trial(`cold-${i}`, join(cacheRoot, `cold-${i}`));
for (let i = 1; i <= 5; i++) await trial(`warm-${i}`, join(cacheRoot, "cold-1"));
await trial("r3-link", join(cacheRoot, "cold-1"), false, true);
writeFileSync(join(base, "results.json"), JSON.stringify(results, null, 2));
console.log(`results=${base}/results.json`);
if (results.some(r => !r.ok)) process.exitCode = 1;
