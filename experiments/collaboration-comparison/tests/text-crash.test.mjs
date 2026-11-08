import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextAuthority } from "../text-authority.mjs";
import { simpleDocument } from "../fixtures/rich.mjs";
for (const point of ["beforeCommit", "afterCommit"])
  test(`own Node server SIGKILL at ${point} yields atomic log/head/receipt`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "folio-text-server-crash-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "server.sqlite"),
      worker = join(directory, "worker.mjs");
    const scope = { workspaceId: "w", documentId: "d", incarnationId: "i" },
      options = {
        scope,
        epoch: "e1",
        document: simpleDocument(),
        actors: ["u1"],
      };
    const envelope = {
      operationId: "op",
      deviceId: "v1",
      scope,
      epoch: "e1",
      baseVersion: 0,
      steps: [
        {
          stepType: "replace",
          from: 1,
          to: 1,
          slice: { content: [{ type: "text", text: "KEEP😀" }] },
        },
      ],
    };
    const code = `import {TextAuthority} from ${JSON.stringify(new URL("../text-authority.mjs", import.meta.url).href)};import{writeSync}from'node:fs';const authority=new TextAuthority(${JSON.stringify(file)},${JSON.stringify(options)});authority.submit('u1',${JSON.stringify(envelope)},{${point}(){writeSync(1,'POINT\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}});`;
    writeFileSync(worker, code);
    const child = spawn(process.execPath, [worker], {
      env: { PATH: process.env.PATH, TMPDIR: directory, LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (x) => (stderr += x));
    try {
      await new Promise((yes, no) => {
        let output = "";
        const timer = setTimeout(
          () => no(Error("barrier timeout " + stderr)),
          10000,
        );
        child.stdout.on("data", (x) => {
          output += x;
          if (output.includes("POINT")) {
            clearTimeout(timer);
            yes();
          }
        });
        child.once("error", (e) => {
          clearTimeout(timer);
          no(e);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          no(Error("early child exit " + stderr));
        });
      });
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      const [, signal] = await exit;
      assert.equal(signal, "SIGKILL");
      const reopened = new TextAuthority(file, options);
      try {
        const s = reopened.snapshot("u1"),
          receipt = reopened.receipt("u1", "op");
        assert.equal(s.version, point === "afterCommit" ? 1 : 0);
        assert.equal(s.steps.length, s.version);
        assert.equal(!!receipt, point === "afterCommit");
        if (receipt) assert.ok(JSON.stringify(s.document).includes("KEEP😀"));
      } finally {
        reopened.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  });
