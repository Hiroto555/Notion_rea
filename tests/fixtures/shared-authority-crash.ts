import { writeSync } from "node:fs";
import { SharedAuthority } from "../../src/collaboration/runtime/authority";
import type { Attempt } from "../../src/collaboration/runtime/contract";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  raw += chunk;
  if (Buffer.byteLength(raw) > 1_100_000) process.exit(2);
});
process.stdin.on("end", () => {
  const input = JSON.parse(raw) as {
    root: string;
    token: string;
    attempt: Attempt;
    barrier: "before" | "after";
  };
  const authority = new SharedAuthority(input.root);
  const stop = () => {
    writeSync(1, "OWNED_COMMIT_BARRIER\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  authority.submit(
    input.token,
    input.attempt,
    input.barrier === "before" ? { beforeCommit: stop } : { afterCommit: stop },
  );
  process.exit(3);
});
