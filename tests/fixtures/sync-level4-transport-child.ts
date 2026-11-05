/**
 * Transport-only child used by tests/sync-level4-transport.test.ts before the
 * Store integration exists.  It owns a separate journal SQLite file, and the
 * parent owns the loopback checkpoint server and the fault proxy.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CheckpointClient } from "../../src/sync/client";
import type { Checkpoint } from "../../src/sync/protocol";
import { SyncTransportJournal } from "../../src/sync/transport-journal";

type Config = {
  action: "push" | "push-pending" | "pull" | "pull-twice" | "hold" | "status";
  journalPath: string;
  workspaceId: string;
  clientId: string;
  bindingId: string;
  baseUrl: string;
  token: string;
  text?: string;
  baseRevision?: number;
  readyPath?: string;
  outputPath: string;
};

const checkpoint = (text: string): Checkpoint => ({
  format: "folio-checkpoint/v1",
  name: "test-fixture",
  version: 1,
  payload: { text },
  assets: [],
});

function blockForever(): never {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0);
  throw new Error("transport hold was released without SIGKILL");
}

function serialize(journal: SyncTransportJournal) {
  return {
    status: journal.status(),
    pending: journal.pending().map((operation) => ({
      operationId: operation.operationId,
      checkpointHash: operation.checkpointHash,
    })),
    inbox: journal
      .pendingInbox()
      .map((change) => change.checkpoint.payload.text),
  };
}

async function main(config: Config): Promise<any> {
  const journal = new SyncTransportJournal({
    path: config.journalPath,
    workspaceId: config.workspaceId,
    clientId: config.clientId,
    bindingId: config.bindingId,
  });
  const client = new CheckpointClient({
    baseUrl: config.baseUrl,
    token: config.token,
    journal,
    timeoutMs: 2_000,
  });
  try {
    if (config.action === "status") return serialize(journal);
    let headRevision = config.baseRevision;
    if (headRevision === undefined || journal.status().serverEpoch === null) {
      const head = await client.head();
      if (headRevision === undefined) headRevision = head.head.revision;
    }
    if (config.action === "pull" || config.action === "pull-twice") {
      const first = await client.pull();
      const output: any = {
        first: {
          after: first.after,
          headRevision: first.headRevision,
          changes: first.changes.map((change) => change.revision),
          texts: first.changes.map((change) => change.checkpoint.payload.text),
        },
        serverHead: headRevision,
      };
      if (config.action === "pull-twice") {
        try {
          const second = await client.pull();
          output.second = {
            after: second.after,
            changes: second.changes.map((change) => change.revision),
          };
        } catch (error) {
          output.secondError =
            error instanceof Error ? error.message : String(error);
        }
      }
      return { ...output, ...serialize(journal) };
    }
    if (config.action === "push-pending") {
      const pushed = await client.push();
      return { pushed, ...serialize(journal) };
    }
    const operation = client.prepare(
      checkpoint(config.text ?? ""),
      headRevision ?? 0,
    );
    if (config.action === "hold") {
      if (!config.readyPath) throw new Error("hold requires readyPath");
      writeFileSync(config.readyPath, "ready", { mode: 0o600 });
      blockForever();
    }
    try {
      const pushed = await client.push();
      return {
        operationId: operation.operationId,
        pushed,
        ...serialize(journal),
      };
    } catch (error) {
      // The transport fault is the expected subject: report it with the
      // durable pending envelope instead of pretending the push succeeded.
      return {
        expectedError: error instanceof Error ? error.message : String(error),
        operationId: operation.operationId,
        ...serialize(journal),
      };
    }
  } finally {
    journal.close();
  }
}

const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as Config;
if (!existsSync(config.outputPath)) {
  writeFileSync(
    config.outputPath,
    JSON.stringify({ ok: false, notFinished: true }),
    {
      mode: 0o600,
    },
  );
}
main(config)
  .then((value) => {
    writeFileSync(config.outputPath, JSON.stringify({ ok: true, value }), {
      mode: 0o600,
    });
  })
  .catch((error) => {
    writeFileSync(
      config.outputPath,
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
      { mode: 0o600 },
    );
    process.exitCode = 1;
  });
