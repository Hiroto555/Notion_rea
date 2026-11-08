import {
  canonicalJson,
  applyTextSteps,
  document as inspectDocument,
} from "../text-protocol.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import r from "../runtime/bundle.cjs";
import { TextAuthority } from "../text-authority.mjs";
import { TextClient } from "../text-client.mjs";
import { simpleDocument } from "../fixtures/rich.mjs";
const scope = { workspaceId: "w", documentId: "d", incarnationId: "i" };
const session = (i) => ({
  scope,
  epoch: "e1",
  actorId: "u" + i,
  deviceId: "v" + i,
  sessionId: "s" + i,
  generation: 1,
});
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "folio-text-connection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const authority = new TextAuthority(join(root, "server.sqlite"), {
    scope,
    epoch: "e1",
    actors: ["u1", "u2"],
    document: simpleDocument(),
  });
  t.after(() => authority.close());
  const drafts = new r.SharedDraftStore(join(root, "drafts")),
    service = new r.SharedPreparationService(drafts);
  t.after(() => {
    service.close();
    drafts.close();
  });
  const clients = [1, 2].map((i) => {
    const s = session(i),
      binding = service.bindTrusted(s, true);
    return new TextClient({
      session: s,
      snapshot: authority.snapshot(s.actorId),
      stage: (raw) => {
        const operationId = JSON.parse(raw).operationId;
        const result = service.request(binding, {
          type: "shared-draft:stage",
          operationId,
          raw,
        });
        assert.equal(result.kind, "LOCAL_DRAFT");
        assert.equal(result.draft.envelope.raw, raw);
      },
    });
  });
  t.after(() => clients.forEach((c) => c.close()));
  return { root, authority, drafts, service, clients };
}
const text = (c) => c.state().doc.textContent;
test("main draft service + two real PM clients + SQLite commit/rebase/own undo", (t) => {
  const {
    authority,
    drafts,
    clients: [a, b],
  } = setup(t);
  a.insert("A😀", 1);
  b.insert("B日本語", 1);
  assert.equal(a.pending().status, "UNSENT");
  assert.ok(drafts.listFor(session(1)).length);
  a.flush(authority);
  b.flush(authority);
  a.receive(authority.snapshot("u1"));
  assert.deepEqual(a.document(), b.document());
  for (const value of ["A😀", "B日本語", "abc", "xyz"])
    assert.ok(text(a).includes(value));
  assert.equal(a.undo(), true);
  a.flush(authority);
  b.receive(authority.snapshot("u2"));
  assert.ok(!text(a).includes("A😀"));
  assert.ok(text(a).includes("B日本語"));
  assert.equal(a.redo(), true);
  a.flush(authority);
  b.receive(authority.snapshot("u2"));
  assert.ok(text(a).includes("A😀"));
  assert.deepEqual(a.document(), b.document());
});
test("lost ACK is resolved by the identical receipt, never a duplicate submit", (t) => {
  const {
    authority,
    clients: [a],
  } = setup(t);
  a.insert("KEEP", 1);
  assert.throws(
    () =>
      a.flush(authority, {
        afterCommit() {
          throw Error("lost ack");
        },
      }),
    /UNKNOWN/,
  );
  const pending = a.pending();
  assert.equal(pending.status, "UNKNOWN");
  const version = authority.snapshot("u1").version;
  const submit = authority.submit.bind(authority);
  let calls = 0;
  authority.submit = (...args) => {
    calls++;
    return submit(...args);
  };
  a.flush(authority);
  assert.equal(calls, 0);
  assert.equal(authority.snapshot("u1").version, version);
  assert.equal(a.pending().status, "SYNCED");
  assert.ok(text(a).includes("KEEP"));
});
test("missing receipt after uncertain failure preserves raw and blocks resend/new edits", (t) => {
  const {
    authority,
    drafts,
    clients: [a],
  } = setup(t);
  a.insert("KEEP", 1);
  assert.throws(
    () =>
      a.flush(authority, {
        beforeCommit() {
          throw Error("before");
        },
      }),
    /before/,
  );
  const pending = a.pending();
  assert.equal(pending.status, "UNKNOWN");
  assert.ok(pending.unknownOperation.raw.includes("KEEP"));
  assert.throws(() => a.flush(authority), /UNKNOWN_OPERATION/);
  assert.throws(() => a.insert("later", 1), /UNKNOWN_OPERATION/);
  assert.equal(authority.snapshot("u1").version, 0);
  assert.ok(
    drafts
      .listFor(session(1))
      .some((d) => d.envelope.raw === pending.unknownOperation.raw),
  );
});
test("snapshot rewrite and cross-epoch projection are refused without losing pending input", (t) => {
  const {
    authority,
    clients: [a],
  } = setup(t);
  a.insert("KEEP", 1);
  const before = a.document();
  const s = authority.snapshot("u1");
  assert.throws(() => a.receive({ ...s, epoch: "other" }), /SCOPE/);
  assert.deepEqual(a.document(), before);
  assert.throws(
    () =>
      a.receive({
        ...s,
        document: simpleDocument(),
        version: 1,
        steps: [],
        clientIDs: [],
      }),
    /SNAPSHOT/,
  );
  assert.deepEqual(a.document(), before);
  assert.equal(a.pending().status, "UNSENT");
  a.close();
  assert.throws(() => a.flush(authority), /CLOSED/);
});
test("server refuses structural moves and UTF16 splits while ordinary text is accepted", (t) => {
  const {
    authority,
    clients: [a],
  } = setup(t);
  a.insert("😀", 1);
  a.flush(authority);
  assert.throws(() => a.insert("bad", 2));
  const current = authority.snapshot("u1"),
    pm = r.EditorState.create({
      doc: r.documentSchema.nodeFromJSON(current.document),
    });
  const first = pm.doc.firstChild,
    tr = pm.tr.delete(0, first.nodeSize);
  tr.insert(tr.doc.content.size, first);
  const env = {
    operationId: "move",
    deviceId: "v1",
    scope,
    epoch: "e1",
    baseVersion: current.version,
    steps: tr.steps.map((s) => s.toJSON()),
  };
  assert.throws(() => authority.submit("u1", env), /UNSUPPORTED/);
  assert.equal(authority.snapshot("u1").version, current.version);
});
test("deleted receipt is corruption and cannot become a missing receipt success", (t) => {
  const {
    root,
    authority,
    clients: [a],
  } = setup(t);
  a.insert("KEEP", 1);
  a.flush(authority);
  const db = new DatabaseSync(join(root, "server.sqlite"));
  db.exec("DELETE FROM operations");
  db.close();
  assert.throws(() => authority.snapshot("u1"), /CORRUPT/);
});

test("mismatched ACK identity stays UNKNOWN until the exact receipt is queried", (t) => {
  const {
    authority,
    clients: [a],
  } = setup(t);
  a.insert("KEEP", 1);
  const submit = authority.submit.bind(authority);
  authority.submit = (...args) => ({
    ...submit(...args),
    clientID: "wrong-device",
  });
  assert.throws(() => a.flush(authority), /RECEIPT_MISMATCH/);
  assert.equal(a.pending().status, "UNKNOWN");
  assert.equal(authority.snapshot("u1").version, 1);
  a.flush(authority);
  assert.equal(a.pending().status, "SYNCED");
  assert.equal(authority.snapshot("u1").version, 1);
  assert.ok(text(a).includes("KEEP"));
});

test("unexpected stored receipt fields fail closed even in canonical JSON", (t) => {
  const {
    root,
    authority,
    clients: [a],
  } = setup(t);
  a.insert("KEEP", 1);
  a.flush(authority);
  const db = new DatabaseSync(join(root, "server.sqlite"));
  const row = db.prepare("SELECT operation_id,receipt FROM operations").get();
  const receipt = { ...JSON.parse(row.receipt), extra: "x" };
  db.prepare("UPDATE operations SET receipt=? WHERE operation_id=?").run(
    canonicalJson(receipt),
    row.operation_id,
  );
  db.close();
  assert.throws(() => authority.snapshot("u1"), /CORRUPT_RECEIPT/);
});
test("empty slice deletion works and documents over the shared raw byte cap are refused", () => {
  for (const slice of [{}, { openStart: 0, openEnd: 0 }, { content: [] }]) {
    const result = applyTextSteps(simpleDocument(), [
      { stepType: "replace", from: 1, to: 2, slice },
    ]);
    assert.equal(result.content[0].content[0].text, "bc");
  }
  const large = simpleDocument();
  large.content[0].content[0].text = "x".repeat(2100000);
  assert.throws(() => inspectDocument(large), /INVALID_DOCUMENT/);
});
