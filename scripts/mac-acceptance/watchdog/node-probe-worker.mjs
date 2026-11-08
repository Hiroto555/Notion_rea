// Fixed, non-GUI fixtures. No arbitrary command, script or PID is accepted.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2];
const send = (message) => {
  if (process.connected) process.send(message);
};
if (scenario === "descendant") {
  process.on("SIGTERM", () => {});
  send({ phase: "ready" });
  setInterval(() => {}, 1000);
} else if (scenario === "descendant-hang" || scenario === "orphan") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "descendant"],
    {
      env: { TMPDIR: process.cwd() },
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  child.once("message", () => {
    send({ phase: "descendant-ready", descendantPid: child.pid });
    if (scenario === "orphan") process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));
} else if (scenario === "block") {
  send({ phase: "blocking" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (scenario === "hang" || scenario === "ignore-term") {
  if (scenario === "ignore-term") process.on("SIGTERM", () => {});
  send({ phase: "ready" });
  setInterval(() => {}, 1000);
} else if (scenario === "normal" || scenario === "nonzero") {
  send({ phase: "ready" });
  process.stdout.write("synthetic Node probe\n");
  process.exitCode = scenario === "normal" ? 0 : 7;
  if (process.connected) process.disconnect();
} else if (scenario === "output-limit") {
  send({ phase: "ready" });
  process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));
  setInterval(() => {}, 1000);
} else process.exitCode = 64;
