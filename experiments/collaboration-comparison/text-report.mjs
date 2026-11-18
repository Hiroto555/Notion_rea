import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import r from "./runtime/bundle.cjs";
import { TextAuthority } from "./text-authority.mjs";
import { TextClient } from "./text-client.mjs";
import { simpleDocument } from "./fixtures/rich.mjs";
const root = mkdtempSync(join(tmpdir(), "folio-text-pilot-report-"));
const scope = { workspaceId: "w", documentId: "d", incarnationId: "i" },
  epoch = "e1";
let authority, drafts, service;
const clients = [];
try {
  authority = new TextAuthority(join(root, "server.sqlite"), {
    scope,
    epoch,
    actors: ["u1", "u2"],
    document: simpleDocument(),
  });
  drafts = new r.SharedDraftStore(join(root, "drafts"));
  service = new r.SharedPreparationService(drafts);
  const sessions = [1, 2].map((i) => ({
    scope,
    epoch,
    actorId: "u" + i,
    deviceId: "v" + i,
    sessionId: "s" + i,
    generation: 1,
  }));
  for (const session of sessions) {
    const binding = service.bindTrusted(session, true);
    clients.push(
      new TextClient({
        session,
        snapshot: authority.snapshot(session.actorId),
        stage: (raw) =>
          service.request(binding, {
            type: "shared-draft:stage",
            operationId: JSON.parse(raw).operationId,
            raw,
          }),
      }),
    );
  }
  const [a, b] = clients;
  a.insert("日本語😀", 1);
  b.insert("共同", 1);
  let unknown = false;
  try {
    a.flush(authority, {
      afterCommit() {
        throw Error("fixture lost ACK");
      },
    });
  } catch {
    unknown = a.pending().status === "UNKNOWN";
  }
  const afterLoss = authority.snapshot("u1").version;
  a.flush(authority);
  const afterQuery = authority.snapshot("u1").version;
  b.flush(authority);
  a.receive(authority.snapshot("u1"));
  const concurrent =
    JSON.stringify(a.document()) === JSON.stringify(b.document()) &&
    a.state().doc.textContent.includes("日本語😀") &&
    a.state().doc.textContent.includes("共同");
  a.undo();
  a.flush(authority);
  b.receive(authority.snapshot("u2"));
  const ownUndo =
    !a.state().doc.textContent.includes("日本語😀") &&
    a.state().doc.textContent.includes("共同");
  a.redo();
  a.flush(authority);
  b.receive(authority.snapshot("u2"));
  const ownRedo =
    JSON.stringify(a.document()) === JSON.stringify(b.document()) &&
    a.state().doc.textContent.includes("日本語😀");
  const raw = sessions.flatMap((s) => drafts.listFor(s));
  const result = {
    scope: "C_TEXT_ONLY_MAIN_PREPARATION_CONNECTION",
    authentication: "TRUSTED_HARNESS_ONLY",
    gui: "NOT_RUN",
    concurrent,
    ownUndo,
    ownRedo,
    ackLoss: {
      unknown,
      receiptFirstNoDuplicate: afterLoss === afterQuery,
      version: afterQuery,
    },
    serverVersion: authority.snapshot("u1").version,
    mainRawRecords: raw.length,
    localIntentRecords: raw.filter(
      (x) => JSON.parse(x.envelope.raw).kind === "LOCAL_INTENT",
    ).length,
    durability: {
      authority: "SQLITE_LOG_HEAD_RECEIPT_ATOMIC",
      mainRaw: "LOCAL_DURABLE",
      clientReceiptMapping: "NOT_IMPLEMENTED",
      automaticClientRestart: "NOT_IMPLEMENTED",
    },
    productionActivation: false,
  };
  if (
    !concurrent ||
    !ownUndo ||
    !ownRedo ||
    !unknown ||
    afterLoss !== afterQuery
  )
    throw Error("mandatory pilot observation failed");
  writeFileSync(
    new URL("./text-pilot-result.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  clients.forEach((c) => c.close());
  service?.close();
  drafts?.close();
  authority?.close();
  rmSync(root, { recursive: true, force: true });
}
