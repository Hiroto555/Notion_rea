import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import type { SharedProvider } from "../src/collaboration/runtime/provider-port";
import type { Attempt } from "../src/collaboration/runtime/contract";

let bundleRoot = "";
let bundle = "";
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), "folio-owned-crash-code-"));
  bundle = join(bundleRoot, "authority.cjs");
  await build({
    entryPoints: [
      join(import.meta.dirname, "fixtures/shared-authority-crash.ts"),
    ],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["node:sqlite"],
  });
});
afterAll(() => {
  if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true });
});

async function interruptOwnedChild(input: unknown): Promise<void> {
  const child = spawn(process.execPath, [bundle], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
  });
  let out = "",
    err = "";
  let sawBarrier = false;
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("OWNED_BARRIER_TIMEOUT"));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (bytes) => {
      out += String(bytes);
      if (out.length > 1024) {
        child.kill("SIGKILL");
        return;
      }
      if (out.includes("OWNED_COMMIT_BARRIER\n")) {
        sawBarrier = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (bytes) => {
      err += String(bytes);
      if (err.length > 4096) child.kill("SIGKILL");
    });
    child.once("exit", (_code, signal) => {
      clearTimeout(timer);
      if (sawBarrier && signal === "SIGKILL") resolve();
      else reject(new Error("OWNED_CHILD_FAILED_BEFORE_BARRIER"));
    });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
  try {
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}

describe("actual owned Node authority crash", () => {
  for (const barrier of ["before", "after"] as const)
    it(
      "retains UNKNOWN and resolves a " +
        barrier +
        "-commit process death without resend",
      async () => {
        const root = mkdtempSync(join(tmpdir(), "folio-owned-crash-case-"));
        const authorityRoot = join(root, "authority");
        const server = new SharedAuthority(authorityRoot);
        const boot = server.bootstrap({
          orgId: "org",
          userId: "alice",
          deviceId: "device",
          workspaceId: "space",
          documentId: "page",
          document: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                attrs: { id: "p" },
                content: [{ type: "text", text: "abc" }],
              },
            ],
          },
        });
        const initial = server.head();
        server.close();
        const read = <T>(work: (authority: SharedAuthority) => T): T => {
          const authority = new SharedAuthority(authorityRoot);
          try {
            return work(authority);
          } finally {
            authority.close();
          }
        };
        let sent: Attempt | undefined;
        let sends = 0;
        const provider: SharedProvider = {
          snapshot: async (scope, after) =>
            read((a) => a.snapshot(boot.token, scope, after)),
          proof: async (scope, seq) =>
            read((a) => a.proof(boot.token, scope, seq)),
          receipt: async (attempt) =>
            read((a) => a.receipt(boot.token, attempt)),
          invalidate: async (attempt) =>
            read((a) => a.invalidate(boot.token, attempt)),
          workspaces: async (org) => read((a) => a.workspaces(boot.token, org)),
          close: () => {},
          submit: async (attempt) => {
            sends++;
            sent = attempt;
            await interruptOwnedChild({
              root: authorityRoot,
              token: boot.token,
              attempt,
              barrier,
            });
            throw new Error("UNKNOWN");
          },
        };
        const client = new SharedRuntimeClient(
          join(root, "client"),
          provider,
          boot.scope,
          boot.auth.writerId,
        );
        try {
          await client.open();
          await expect(
            client.submit({
              kind: "text",
              blockId: "p",
              from: 1,
              to: 1,
              text: "KEEP",
              before: "abc",
            }),
          ).rejects.toThrow("UNKNOWN");
          const original = client.entries()[0].raw;
          expect(client.entries()[0].state).toBe("UNKNOWN");
          expect(sends).toBe(1);
          await expect(
            client.submit({
              kind: "text",
              blockId: "p",
              from: 0,
              to: 0,
              text: "again",
              before: "abc",
            }),
          ).rejects.toThrow("PENDING_INTENT_BLOCKS_WRITE");
          await client.reconcile();
          expect(sends).toBe(1);
          if (barrier === "before") {
            expect(read((a) => a.head())).toEqual(initial);
            expect(client.entries()[0].state).toBe("UNKNOWN");
            expect(read((a) => a.receipt(boot.token, sent!))).toBeNull();
            expect(
              (await client.invalidate(sent!.intent.intentId)).status,
            ).toBe("INVALIDATED");
            client.archive(sent!.intent.intentId);
            expect(client.entries()[0].raw).toBe(original);
          } else {
            expect(client.entries()[0].state).toBe("CLIENT_RECEIPT_DURABLE");
            const cut = read((a) => a.head());
            expect(cut.seq).toBe(initial.seq + 1);
            expect(read((a) => a.submit(boot.token, sent!)).cut).toEqual(cut);
            expect(
              client.snapshot().state.document.content?.[0].content?.[0].text,
            ).toBe("aKEEPbc");
          }
          read((a) => a.verify());
          expect(sends).toBe(1);
        } finally {
          client.close();
          rmSync(root, { recursive: true, force: true });
        }
      },
      30_000,
    );
});
