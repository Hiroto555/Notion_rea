/**
 * Lane D transport-only fault injection, runnable on the base commit.
 *
 * This does not claim product sync.  It proves the independent-child harness
 * and the loopback fault proxy that the post-integration tests also use:
 * durable envelopes survive SIGKILL, an ACK can be lost only after the server
 * committed, stale/reordered change pages are rejected, and an offline client
 * resumes after the persistent server is restarted.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import type { Checkpoint } from "../src/sync/protocol";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  FaultProxy,
  disposeBundles,
  rawHead,
  runTransportClient,
  spawnTransportClient,
  waitForFile,
} from "./fixtures/sync-level4-support";

const TIMEOUT = 30_000;
const roots: string[] = [];
const servers = new Set<Awaited<ReturnType<typeof startCheckpointServer>>>();
const proxies = new Set<FaultProxy>();
let token = "";

const validateCheckpoint = (value: Checkpoint) => {
  if (
    value.name !== "test-fixture" ||
    value.version !== 1 ||
    typeof value.payload.text !== "string"
  )
    throw new Error("fixture schema");
  return true;
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-sync-l4-transport-"));
  roots.push(root);
  token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [{ workspaceId: "workspace", ownerId: "owner", token }],
    validateCheckpoint,
  });
  servers.add(server);
  return {
    root,
    server,
    journal: (name: string) => join(root, `${name}.sqlite`),
    base(overrides: Record<string, unknown> = {}) {
      return {
        journalPath: join(root, `journal-${randomUUID()}.sqlite`),
        workspaceId: "workspace",
        clientId: `client-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        bindingId: `binding-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
        baseUrl: server.url,
        token,
        ...overrides,
      };
    },
  };
}

afterEach(async () => {
  for (const proxy of proxies) await proxy.close();
  proxies.clear();
  for (const server of servers) await server.close();
  servers.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  disposeBundles();
});

describe("independent transport child and fault proxy", () => {
  it(
    "recovers a committed operation after the ACK is dropped post-COMMIT",
    async () => {
      const f = await fixture();
      const config = f.base();
      const proxy = await FaultProxy.start(
        f.server.url,
        "drop-ack-after-commit",
      );
      proxies.add(proxy);
      const first = await runTransportClient(f.root, {
        ...config,
        action: "push",
        text: "ACK lost after commit",
        baseUrl: proxy.url,
      });
      expect(first.ok).toBe(true);
      expect(first.value.expectedError).toBeTruthy();
      expect(first.value.pending).toHaveLength(1);
      expect(proxy.counts.ackDropped).toBe(1);
      // The server, not the child, proved the commit happened before the drop.
      expect(
        (await rawHead(f.server.url, "workspace", token)).head.revision,
      ).toBe(1);
      const retry = await runTransportClient(f.root, {
        ...config,
        action: "push-pending",
      });
      expect(retry.ok).toBe(true);
      expect(retry.value.pushed.status).toBe("applied");
      expect(retry.value.status.pending).toBe(0);
      expect(retry.value.status.receivedCursor).toBe(0);
      expect(
        (await rawHead(f.server.url, "workspace", token)).head.revision,
      ).toBe(1);
      const receiver = f.base();
      const pulled = await runTransportClient(f.root, {
        ...receiver,
        action: "pull",
      });
      expect(pulled.value.inbox).toEqual(["ACK lost after commit"]);
      expect(pulled.value.status.receivedCursor).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "keeps the prepared envelope across SIGKILL and pushes it exactly once",
    async () => {
      const f = await fixture();
      const config = f.base();
      const readyPath = join(f.root, "held.ready");
      const holder = spawnTransportClient(f.root, {
        ...config,
        action: "hold",
        text: "durable after SIGKILL",
        readyPath,
      });
      await waitForFile(readyPath);
      const killed = await holder.kill();
      expect(killed.signal).toBe("SIGKILL");
      await holder.result;
      const retry = await runTransportClient(f.root, {
        ...config,
        action: "push-pending",
      });
      expect(retry.ok).toBe(true);
      expect(retry.value.pushed.status).toBe("applied");
      expect(
        (await rawHead(f.server.url, "workspace", token)).head.revision,
      ).toBe(1);
      const pulled = await runTransportClient(f.root, {
        ...f.base(),
        action: "pull",
      });
      expect(pulled.value.inbox).toEqual(["durable after SIGKILL"]);
    },
    TIMEOUT,
  );

  it(
    "rejects a replayed stale changes page without double-applying it",
    async () => {
      const f = await fixture();
      const publisher = f.base();
      for (const [text, revision] of [
        ["one", 0],
        ["two", 1],
      ] as const) {
        const pushed = await runTransportClient(f.root, {
          ...publisher,
          action: "push",
          text,
          baseRevision: revision,
        });
        expect(pushed.value.pushed.status).toBe("applied");
      }
      const receiver = f.base();
      const proxy = await FaultProxy.start(
        f.server.url,
        "stale-changes-replay",
      );
      proxies.add(proxy);
      const first = await runTransportClient(f.root, {
        ...receiver,
        action: "pull-twice",
        baseUrl: proxy.url,
      });
      expect(first.ok).toBe(true);
      expect(first.value.first.texts).toEqual(["one"]);
      expect(first.value.secondError).toBeTruthy();
      expect(first.value.inbox).toEqual(["one"]);
      expect(first.value.status.receivedCursor).toBe(1);
      expect(proxy.counts.changesReplayed).toBe(1);
      const resumed = await runTransportClient(f.root, {
        ...receiver,
        action: "pull",
      });
      expect(resumed.value.first.texts).toEqual(["two"]);
      expect(resumed.value.inbox).toEqual(["one", "two"]);
      expect(resumed.value.status.receivedCursor).toBe(2);
      expect(
        (await rawHead(f.server.url, "workspace", token)).head.revision,
      ).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "rejects an out-of-order change page and resumes from the durable cursor",
    async () => {
      const f = await fixture();
      const publisher = f.base();
      for (const [text, revision] of [
        ["one", 0],
        ["two", 1],
      ] as const) {
        await runTransportClient(f.root, {
          ...publisher,
          action: "push",
          text,
          baseRevision: revision,
        });
      }
      const receiver = f.base();
      const proxy = await FaultProxy.start(
        f.server.url,
        "reorder-changes-once",
      );
      proxies.add(proxy);
      const rejected = await runTransportClient(f.root, {
        ...receiver,
        action: "pull",
        baseUrl: proxy.url,
      });
      expect(rejected.ok).toBe(false);
      expect(String(rejected.error)).toMatch(/cursor-gap|invalid/i);
      expect(proxy.counts.changesReordered).toBe(1);
      const first = await runTransportClient(f.root, {
        ...receiver,
        action: "pull",
      });
      expect(first.value.first.texts).toEqual(["one"]);
      expect(first.value.status.receivedCursor).toBe(1);
      const second = await runTransportClient(f.root, {
        ...receiver,
        action: "pull",
      });
      expect(second.value.first.texts).toEqual(["two"]);
      expect(second.value.status.receivedCursor).toBe(2);
      expect(second.value.inbox).toEqual(["one", "two"]);
    },
    TIMEOUT,
  );

  it(
    "keeps offline work and resumes after the persistent server restarts",
    async () => {
      const f = await fixture();
      const config = f.base();
      await runTransportClient(f.root, {
        ...config,
        action: "push",
        text: "before restart",
      });
      const databasePath = join(f.root, "server.sqlite");
      await f.server.close();
      servers.delete(f.server);
      const offline = await runTransportClient(f.root, {
        ...config,
        action: "push",
        text: "offline work",
        baseRevision: 1,
      });
      expect(offline.ok).toBe(true);
      expect(offline.value.expectedError).toBeTruthy();
      expect(offline.value.pending).toHaveLength(1);
      const restarted = await startCheckpointServer({
        databasePath,
        capabilities: [{ workspaceId: "workspace", ownerId: "owner", token }],
        validateCheckpoint,
      });
      servers.add(restarted);
      const resumed = await runTransportClient(f.root, {
        ...config,
        action: "push-pending",
        baseUrl: restarted.url,
      });
      expect(resumed.value.pushed.status).toBe("applied");
      expect(
        (await rawHead(restarted.url, "workspace", token)).head.revision,
      ).toBe(2);
      const receiver = f.base();
      const pulled = await runTransportClient(f.root, {
        ...receiver,
        action: "pull-twice",
        baseUrl: restarted.url,
      });
      expect(pulled.value.inbox).toEqual(["before restart", "offline work"]);
    },
    TIMEOUT,
  );
});
