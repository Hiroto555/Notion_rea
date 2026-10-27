import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, createWriteStream, unlinkSync, rmdirSync, realpathSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "folio-agent.json"), "utf8"));
const [command = "environment", ...args] = process.argv.slice(2);
const allowed = new Set(["environment", "check", "build", "test", "test:e2e", "dev", "start", "install"]);
if (!allowed.has(command)) throw new Error("Unknown command; use environment, check, build, test, test:e2e, dev, start, or install");
const branchResult = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" });
if (branchResult.status !== 0 || branchResult.stdout.trim() !== config.branch) throw new Error(`Expected branch ${config.branch}; refusing to run in a different checkout`);
const commonResult = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
if (commonResult.status !== 0) throw new Error("Unable to identify the Git common directory");
const commonDir = realpathSync(resolve(root, commonResult.stdout.trim()));
const storage = join(root, "output", "agent-workspace");
for (const dir of ["data", "inputs", "exports", "cache/npm", "cache/electron", "cache/vite", "cache/tmp", "logs", "evidence"]) mkdirSync(join(storage, dir), { recursive: true });
const env = { ...process.env, FOLIO_DATA_DIR: join(storage, "data"), FOLIO_VITE_CACHE_DIR: join(storage, "cache/vite"), FOLIO_DEV_PORT: String(config.port), npm_config_cache: join(storage, "cache/npm"), electron_config_cache: join(storage, "cache/electron"), TMPDIR: join(storage, "cache/tmp") };
delete env.FOLIO_DEV_URL;
if (command === "environment") {
  console.log(JSON.stringify({ role: config.role, branch: config.branch, baseCommit: config.baseCommit, root, data: env.FOLIO_DATA_DIR, cache: env.FOLIO_VITE_CACHE_DIR, logs: join(storage, "logs"), evidence: join(storage, "evidence"), port: config.port, gitCommonDir: commonDir, note: "Only commands through this launcher are isolated; it is not an OS sandbox." }, null, 2));
  process.exit(0);
}
const token = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
const lock = join(realpathSync("/tmp"), `folio-e2e-${token}.lock`);
let hasLock = false;
if (command === "test" || command === "test:e2e") {
  const acquired = await new Promise((done, reject) => {
    let waiting = false, settled = false;
    const watcher = watch(dirname(lock), (_event, filename) => {
      if (!filename || filename.toString() === basename(lock)) tryAcquire();
    });
    const stop = () => { if (!settled) { settled = true; watcher.close(); done(false); } };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const cleanupSignals = () => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); };
    function tryAcquire() {
      if (settled) return;
      try {
        mkdirSync(lock);
        try { writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, role: config.role, command, started: new Date().toISOString() }), { flag: "wx" }); }
        catch (error) { try { rmdirSync(lock); } catch {} throw error; }
        hasLock = true; settled = true; watcher.close(); cleanupSignals();
        console.log(`Test lock acquired: ${lock}`); done(true);
      } catch (error) {
        if (error.code === "EEXIST") { if (!waiting) { waiting = true; console.log(`Waiting for test lock: ${lock}. Tests have not started.`); } return; }
        settled = true; watcher.close(); cleanupSignals(); reject(error);
      }
    }
    tryAcquire();
  });
  if (!acquired) { console.error("Interrupted while waiting; no tests started."); process.exit(130); }
}

const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${command.replace(":", "-")}-${randomUUID().slice(0, 8)}.log`;
const logPath = join(storage, "logs", name);
const log = createWriteStream(logPath, { flags: "wx" });
const npmArgs = command === "install" ? ["ci", "--no-audit", "--no-fund"] : ["run", command, ...(args.length ? ["--", ...args] : [])];
log.write(JSON.stringify({ command: "npm", args: npmArgs, branch: config.branch, role: config.role, started: new Date().toISOString() }) + "\n");
console.log(`Isolated ${config.role}: npm ${npmArgs.join(" ")}\nLog: ${logPath}`);
const child = spawn("npm", npmArgs, { cwd: root, env, detached: process.platform !== "win32", stdio: ["inherit", "pipe", "pipe"] });
child.stdout.on("data", data => { process.stdout.write(data); log.write(data); });
child.stderr.on("data", data => { process.stderr.write(data); log.write(data); });
const forward = signal => { try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
process.on("SIGINT", () => forward("SIGINT")); process.on("SIGTERM", () => forward("SIGTERM"));
let ended = false;
function finish(code, signal, error) {
  if (ended) return; ended = true;
  if (hasLock) { try { unlinkSync(join(lock, "owner.json")); rmdirSync(lock); } catch (e) { console.error("Could not release E2E lock:", e.message); code = 1; } }
  log.end(`\nexit_code=${code ?? "null"} signal=${signal ?? "none"}${error ? " error=" + error.message : ""}\n`);
  process.exitCode = code ?? 1;
}
child.once("error", error => { console.error(error.message); finish(1, null, error); });
child.once("close", (code, signal) => finish(code, signal));
