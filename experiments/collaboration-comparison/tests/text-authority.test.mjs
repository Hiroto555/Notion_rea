import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import runtime from "../runtime/bundle.cjs";
import { TextAuthority } from "../text-authority.mjs";
import { richDocument, simpleDocument } from "../fixtures/rich.mjs";

const ACTOR_A = "u1";
const ACTOR_B = "u2";
const ACTOR_C = "u3";
const DEVICE_A = "device-a";
const SCOPE = {
  workspaceId: "ws-pilot-text",
  documentId: "doc-pilot-text",
  incarnationId: "inc-pilot-text",
};
const EPOCH = "e7";
const APPLICATION_ID = 0x464c5450;
const USER_VERSION = 1002;

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "folio-text-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function authorityPath(t) {
  return join(temporaryDirectory(t), "authority.sqlite");
}

function openAuthority(file, document = simpleDocument(), overrides = {}) {
  return new TextAuthority(file, {
    scope: SCOPE,
    epoch: EPOCH,
    document,
    actors: [ACTOR_A, ACTOR_B],
    ...overrides,
  });
}

function envelope(steps, overrides = {}) {
  return {
    operationId: randomUUID(),
    deviceId: DEVICE_A,
    scope: SCOPE,
    epoch: EPOCH,
    baseVersion: 0,
    steps,
    ...overrides,
  };
}

function pmDocument(document) {
  return runtime.documentSchema.nodeFromJSON(document);
}

function findBlock(document, id) {
  let found = null;
  pmDocument(document).descendants((node, pos) => {
    if (found) return false;
    if (node.attrs && node.attrs.id === id) {
      found = { node, pos };
      return false;
    }
    return undefined;
  });
  assert.ok(found, `missing fixture block ${id}`);
  return found;
}

function insertStep(document, id, offset, text) {
  const block = findBlock(document, id);
  const transform = runtime.EditorState.create({
    doc: pmDocument(document),
  }).tr;
  transform.insertText(text, block.pos + 1 + offset);
  return transform.steps.at(-1).toJSON();
}

function deleteStep(document, id, fromOffset, toOffset) {
  const block = findBlock(document, id);
  const transform = runtime.EditorState.create({
    doc: pmDocument(document),
  }).tr;
  transform.delete(block.pos + 1 + fromOffset, block.pos + 1 + toOffset);
  return transform.steps.at(-1).toJSON();
}

function applyStep(document, step) {
  const result = runtime.Step.fromJSON(runtime.documentSchema, step).apply(
    runtime.documentSchema.nodeFromJSON(document),
  );
  assert.equal(result.failed, null);
  return JSON.parse(
    JSON.stringify(runtime.versionDocument(result.doc.toJSON())),
  );
}

function identityList(document) {
  const identities = [];
  pmDocument(document).descendants((node) => {
    if (node.isText) return;
    identities.push({
      type: node.type.name,
      attrs: node.attrs,
      id: node.attrs && node.attrs.id !== undefined ? node.attrs.id : null,
    });
  });
  return identities;
}

function assertAcceptedReceipt(receipt, request) {
  assert.deepEqual(Object.keys(receipt).sort(), [
    "clientID",
    "epoch",
    "fingerprint",
    "operationId",
    "scope",
    "status",
    "steps",
    "version",
  ]);
  assert.equal(receipt.status, "SERVER_ACCEPTED");
  assert.equal(receipt.operationId, request.operationId);
  assert.equal(receipt.epoch, request.epoch);
  assert.deepEqual(receipt.scope, request.scope);
  assert.equal(receipt.version, request.baseVersion + request.steps.length);
  assert.deepEqual(receipt.steps, request.steps);
  assert.equal(receipt.clientID, request.deviceId);
  assert.equal(typeof receipt.fingerprint, "string");
  assert.ok(receipt.fingerprint.length > 0);
}

function assertUnknown(error) {
  const text = [
    error && error.code,
    error && error.name,
    error && error.message,
  ]
    .filter(Boolean)
    .join(" ");
  assert.match(text, /UNKNOWN/i);
  return true;
}

function assertStaleVersion(error) {
  const text = [error && error.code, error && error.message]
    .filter(Boolean)
    .join(" ");
  assert.match(text, /STALE_VERSION/);
  return true;
}

function createSqlite(file, { applicationId, userVersion, table }) {
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA application_id=${applicationId};`);
    database.exec(`PRAGMA user_version=${userVersion};`);
    if (table) {
      database.exec(
        `CREATE TABLE ${table}(id INTEGER PRIMARY KEY, value TEXT NOT NULL);`,
      );
    }
  } finally {
    database.close();
  }
}

function fileState(directory, file) {
  return {
    entries: readdirSync(directory).sort(),
    bytes: readFileSync(file).toString("base64"),
  };
}

test("insert and delete preserve rich schema identity and project exact steps", (t) => {
  const file = authorityPath(t);
  const original = richDocument();
  const originalSnapshot = structuredClone(original);
  const originalIdentities = identityList(original);
  const authority = openAuthority(file, original);
  t.after(() => authority.close());

  const insert = insertStep(original, "p-marks", 0, "NEW ");
  const insertEnvelope = envelope([insert]);
  const insertReceipt = authority.submit(ACTOR_A, insertEnvelope);
  assertAcceptedReceipt(insertReceipt, insertEnvelope);

  let snapshot = authority.snapshot(ACTOR_A);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.steps, [insert]);
  assert.deepEqual(snapshot.clientIDs, [DEVICE_A]);
  assert.deepEqual(snapshot.document, applyStep(original, insert));
  assert.deepEqual(identityList(snapshot.document), originalIdentities);
  assert.deepEqual(original, originalSnapshot);

  const deleteAt = deleteStep(snapshot.document, "p-marks", 10, 14);
  const deleteEnvelope = envelope([deleteAt], {
    operationId: randomUUID(),
    baseVersion: 1,
  });
  const deleteReceipt = authority.submit(ACTOR_B, deleteEnvelope);
  assertAcceptedReceipt(deleteReceipt, deleteEnvelope);

  snapshot = authority.snapshot(ACTOR_A);
  assert.equal(snapshot.version, 2);
  assert.deepEqual(snapshot.steps, [insert, deleteAt]);
  assert.deepEqual(snapshot.clientIDs, [DEVICE_A, DEVICE_A]);
  assert.deepEqual(
    snapshot.document,
    applyStep(applyStep(original, insert), deleteAt),
  );
  assert.deepEqual(identityList(snapshot.document), originalIdentities);
  assert.deepEqual(original, originalSnapshot);
});

test("duplicate operation id is idempotent and conflicting reuse is rejected", (t) => {
  const file = authorityPath(t);
  const document = simpleDocument();
  const authority = openAuthority(file, document);
  t.after(() => authority.close());

  const operation = envelope([insertStep(document, "p1", 0, "A")]);
  const first = authority.submit(ACTOR_A, operation);
  assertAcceptedReceipt(first, operation);

  const reordered = {
    steps: operation.steps,
    baseVersion: operation.baseVersion,
    epoch: operation.epoch,
    scope: operation.scope,
    deviceId: operation.deviceId,
    operationId: operation.operationId,
  };
  const duplicate = authority.submit(ACTOR_A, reordered);
  assert.deepEqual(duplicate, first);
  let snapshot = authority.snapshot(ACTOR_A);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.steps.length, 1);
  assert.deepEqual(authority.receipt(ACTOR_A, operation.operationId), first);

  const conflict = {
    ...operation,
    steps: [insertStep(document, "p1", 1, "B")],
  };
  assert.throws(() => authority.submit(ACTOR_A, conflict));
  assert.throws(() => authority.submit(ACTOR_B, operation));

  snapshot = authority.snapshot(ACTOR_A);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.steps.length, 1);
  assert.deepEqual(snapshot.steps, [operation.steps[0]]);
});

test("wrong actor, scope, and epoch are rejected before mutation", (t) => {
  const file = authorityPath(t);
  const document = simpleDocument();
  const authority = openAuthority(file, document);
  t.after(() => authority.close());

  const operation = envelope([insertStep(document, "p1", 0, "A")]);
  assert.throws(() => authority.submit(ACTOR_C, operation));
  assert.equal(authority.snapshot(ACTOR_A).version, 0);

  assert.throws(() =>
    authority.submit(ACTOR_A, {
      ...operation,
      scope: { ...SCOPE, documentId: "other-document" },
    }),
  );
  assert.equal(authority.snapshot(ACTOR_A).version, 0);

  assert.throws(() =>
    authority.submit(ACTOR_A, {
      ...operation,
      epoch: EPOCH + 1,
    }),
  );
  assert.equal(authority.snapshot(ACTOR_A).version, 0);

  const accepted = authority.submit(ACTOR_A, operation);
  assertAcceptedReceipt(accepted, operation);
  assert.equal(authority.snapshot(ACTOR_A).version, 1);
});

test("stale baseVersion is rejected as STALE_VERSION without rebasing", (t) => {
  const file = authorityPath(t);
  const document = simpleDocument();
  const authority = openAuthority(file, document);
  t.after(() => authority.close());

  const first = envelope([insertStep(document, "p1", 0, "A")]);
  authority.submit(ACTOR_A, first);
  const snapshotAfterFirst = authority.snapshot(ACTOR_A);

  const stale = envelope([insertStep(document, "p1", 0, "B")], {
    baseVersion: 0,
  });
  assert.throws(() => authority.submit(ACTOR_A, stale), assertStaleVersion);

  const future = envelope([insertStep(document, "p1", 0, "C")], {
    baseVersion: 2,
  });
  assert.throws(() => authority.submit(ACTOR_A, future), assertStaleVersion);

  const snapshotAfterRejections = authority.snapshot(ACTOR_A);
  assert.equal(snapshotAfterRejections.version, snapshotAfterFirst.version);
  assert.deepEqual(snapshotAfterRejections.steps, snapshotAfterFirst.steps);
  assert.deepEqual(
    snapshotAfterRejections.document,
    snapshotAfterFirst.document,
  );
});

test("structural replace and move are refused before mutation", (t) => {
  const file = authorityPath(t);
  const document = simpleDocument();
  const authority = openAuthority(file, document);
  t.after(() => authority.close());

  const p1 = findBlock(document, "p1");
  const replacement = runtime.documentSchema.nodeFromJSON({
    type: "paragraph",
    attrs: { id: "p1" },
    content: [{ type: "text", text: "replacement" }],
  });
  const replaceTransform = runtime.EditorState.create({
    doc: pmDocument(document),
  }).tr;
  replaceTransform.replaceWith(p1.pos, p1.pos + p1.node.nodeSize, replacement);
  const replaceStep = replaceTransform.steps[0].toJSON();

  assert.throws(() => authority.submit(ACTOR_A, envelope([replaceStep])));
  let snapshot = authority.snapshot(ACTOR_A);
  assert.equal(snapshot.version, 0);
  assert.deepEqual(
    snapshot.document,
    JSON.parse(
      JSON.stringify(runtime.versionDocument(pmDocument(document).toJSON())),
    ),
  );

  const moveTransform = runtime.EditorState.create({
    doc: pmDocument(document),
  }).tr;
  moveTransform.delete(p1.pos, p1.pos + p1.node.nodeSize);
  moveTransform.insert(0, p1.node);
  const moveSteps = moveTransform.steps.map((step) => step.toJSON());
  assert.throws(() => authority.submit(ACTOR_A, envelope(moveSteps)));
  snapshot = authority.snapshot(ACTOR_A);
  assert.equal(snapshot.version, 0);
  assert.deepEqual(
    snapshot.document,
    JSON.parse(
      JSON.stringify(runtime.versionDocument(pmDocument(document).toJSON())),
    ),
  );

  const textEnvelope = envelope([insertStep(document, "p1", 0, "ok")]);
  assertAcceptedReceipt(authority.submit(ACTOR_A, textEnvelope), textEnvelope);
  assert.equal(authority.snapshot(ACTOR_A).version, 1);
});

test("beforeCommit failure rolls back and the same operation can be retried", (t) => {
  const file = authorityPath(t);
  const document = simpleDocument();
  const authority = openAuthority(file, document);
  const operation = envelope([insertStep(document, "p1", 0, "A")]);

  assert.throws(() =>
    authority.submit(ACTOR_A, operation, {
      beforeCommit() {
        throw new Error("BEFORE_COMMIT_FAILURE");
      },
    }),
  );
  assert.equal(authority.snapshot(ACTOR_A).version, 0);
  authority.close();

  const reopened = openAuthority(file, document);
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot(ACTOR_A).version, 0);

  const accepted = reopened.submit(ACTOR_A, operation);
  assertAcceptedReceipt(accepted, operation);
  assert.equal(reopened.snapshot(ACTOR_A).version, 1);
});

test("afterCommit failure surfaces UNKNOWN and the receipt survives reopen", (t) => {
  const file = authorityPath(t);
  const document = simpleDocument();
  const authority = openAuthority(file, document);
  const operation = envelope([insertStep(document, "p1", 0, "A")]);

  assert.throws(
    () =>
      authority.submit(ACTOR_A, operation, {
        afterCommit() {
          throw new Error("AFTER_COMMIT_FAILURE");
        },
      }),
    assertUnknown,
  );
  authority.close();

  const reopened = openAuthority(file, document);
  t.after(() => reopened.close());

  const snapshot = reopened.snapshot(ACTOR_A);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.steps, operation.steps);
  assert.deepEqual(snapshot.clientIDs, [DEVICE_A]);

  const receipt = reopened.receipt(ACTOR_A, operation.operationId);
  assertAcceptedReceipt(receipt, operation);

  const duplicate = reopened.submit(ACTOR_A, operation);
  assert.deepEqual(duplicate, receipt);
  assert.equal(reopened.snapshot(ACTOR_A).version, 1);
  assert.equal(reopened.snapshot(ACTOR_A).steps.length, 1);
});

test("reopen verifies stored scope, epoch, and actors", (t) => {
  const file = authorityPath(t);
  const document = simpleDocument();
  const authority = openAuthority(file, document);
  const operation = envelope([insertStep(document, "p1", 0, "A")]);
  const accepted = authority.submit(ACTOR_A, operation);
  authority.close();

  assert.throws(() =>
    openAuthority(file, document, {
      scope: { ...SCOPE, incarnationId: "other-incarnation" },
    }),
  );
  assert.throws(() =>
    openAuthority(file, document, {
      epoch: EPOCH + 1,
    }),
  );
  assert.throws(() =>
    openAuthority(file, document, {
      actors: [ACTOR_A, ACTOR_C],
    }),
  );

  const reopened = openAuthority(file, document);
  t.after(() => reopened.close());
  assert.equal(reopened.snapshot(ACTOR_A).version, 1);
  assert.deepEqual(reopened.receipt(ACTOR_A, operation.operationId), accepted);
});

test("foreign and private database files are refused without changes", (t) => {
  const nonSqliteDirectory = temporaryDirectory(t);
  const nonSqlite = join(nonSqliteDirectory, "authority.sqlite");
  writeFileSync(nonSqlite, "this is not a sqlite database");
  const nonSqliteBefore = fileState(nonSqliteDirectory, nonSqlite);
  assert.throws(() => openAuthority(nonSqlite));
  assert.deepEqual(fileState(nonSqliteDirectory, nonSqlite), nonSqliteBefore);

  const foreignDirectory = temporaryDirectory(t);
  const foreign = join(foreignDirectory, "authority.sqlite");
  createSqlite(foreign, {
    applicationId: 0x12345678,
    userVersion: USER_VERSION,
    table: "foreign_records",
  });
  assert.ok(existsSync(foreign));
  const foreignBefore = fileState(foreignDirectory, foreign);
  assert.throws(() => openAuthority(foreign));
  assert.deepEqual(fileState(foreignDirectory, foreign), foreignBefore);

  const privateDirectory = temporaryDirectory(t);
  const privateFile = join(privateDirectory, "authority.sqlite");
  createSqlite(privateFile, {
    applicationId: APPLICATION_ID,
    userVersion: USER_VERSION - 1,
    table: null,
  });
  const privateBefore = fileState(privateDirectory, privateFile);
  assert.throws(() => openAuthority(privateFile));
  assert.deepEqual(fileState(privateDirectory, privateFile), privateBefore);
});
