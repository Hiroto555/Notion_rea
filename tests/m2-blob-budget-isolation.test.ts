import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalJson, SyncError } from "../src/sync/protocol";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { stageCheckpointAssets } from "../src/sync/workspace-blobs";

const probe = vi.hoisted(() => ({ calls: 0, trip: true }));
vi.mock("../src/sync/blob-transfer-budget", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/sync/blob-transfer-budget")>();
  return {
    ...actual,
    inspectWorkspaceTransferBudget: (
      ...args: Parameters<typeof actual.inspectWorkspaceTransferBudget>
    ) => {
      if (++probe.calls > 1 && probe.trip)
        throw new SyncError("blob-transfer-budget-unsafe", 409);
      return actual.inspectWorkspaceTransferBudget(...args);
    },
  };
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it("an unrelated unsafe budget observation holds transfer without poisoning its owned record", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-budget-isolation-")),
  );
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(206, {
      "Content-Length": 1,
      "Content-Range": "bytes 0-0/1",
    });
    response.end("x");
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address");
    const baseUrl = `http://127.0.0.1:${address.port}`,
      assetsDirectory = join(root, "staging");
    mkdirSync(assetsDirectory);
    const scope = {
      baseUrlHash: hash(baseUrl),
      workspaceId: "workspace",
      clientId: "client",
      bindingId: "binding",
      serverEpoch: "epoch",
    };
    const directory = join(
      root,
      ".folio-sync-transfers",
      hash(canonicalJson(scope)),
    );
    const options = {
      baseUrl,
      workspaceId: "workspace",
      token: randomBytes(32).toString("hex"),
      assetsDirectory,
      transfer: { scope, directory, workspaceDirectory: root },
    };
    const asset = { id: randomUUID() + ".bin", sha256: hash("x"), bytes: 1 };
    probe.calls = 0;
    probe.trip = true;
    await expect(stageCheckpointAssets(options, [asset])).rejects.toMatchObject(
      { code: "blob-transfer-budget-unsafe" },
    );
    expect(requests).toBe(0);
    const journal = new BlobTransferJournal(
      join(directory, "download-" + hash(assetsDirectory)),
      scope,
    );
    try {
      expect(journal.inventory()).toMatchObject([
        { state: "active", offset: 0, reason: null },
      ]);
    } finally {
      journal.close();
    }
    probe.trip = false;
    await stageCheckpointAssets(options, [asset]);
    expect(readFileSync(join(assetsDirectory, asset.id), "utf8")).toBe("x");
    expect(requests).toBe(1);
  } finally {
    probe.trip = false;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
