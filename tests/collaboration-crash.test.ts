import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { SharedDraftStore } from "../src/collaboration/draft-store";
let bundle = "",
  bundleDir = "";
beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), "folio-shared-crash-bundle-"));
  bundle = join(bundleDir, "worker.cjs");
  buildSync({
    entryPoints: [resolve("tests/fixtures/shared-draft-crash-worker.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));
function barrier(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((yes, no) => {
    const timer = setTimeout(() => done(Error("child barrier timeout")), 10000);
    const onMessage = (value: unknown) => {
      if (value === expected) done();
    };
    const onExit = () => done(Error("child exited before barrier"));
    const onError = (e: Error) => done(e);
    function done(error?: Error) {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) no(error);
      else yes();
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
for (const committed of [false, true])
  it(`own child SIGKILL ${committed ? "after" : "before"} local stage retains exactly committed raw`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "folio-shared-crash-"));
    const envelope = {
      session: {
        scope: { workspaceId: "w", documentId: "d", incarnationId: "i" },
        sessionId: "s",
        actorId: "a",
        deviceId: "v",
        epoch: "e",
        generation: 0,
      },
      operationId: "op",
      raw: '{ "unknown":9007199254740993 }',
    };
    const child = spawn(
      process.execPath,
      [bundle, directory, JSON.stringify(envelope)],
      {
        env: { PATH: process.env.PATH, TMPDIR: directory, LANG: "C" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    try {
      await barrier(child, "OPEN");
      if (committed) {
        const staged = barrier(child, "STAGED");
        child.send("STAGE");
        await staged;
      }
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      const [, signal] = await exit;
      expect(signal).toBe("SIGKILL");
      const store = new SharedDraftStore(directory);
      try {
        expect(store.get("op")?.envelope.raw).toBe(
          committed ? envelope.raw : undefined,
        );
      } finally {
        store.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
