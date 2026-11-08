import r from "./runtime/bundle.cjs";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  clone,
  fingerprint,
  id,
  scope,
  document,
  applyTextSteps,
} from "./text-protocol.mjs";
export class TextClient {
  constructor({ session, snapshot, stage }) {
    this.session = clone(session);
    scope(session.scope);
    for (const k of ["sessionId", "actorId", "deviceId", "epoch"])
      id(session[k]);
    if (!Number.isSafeInteger(session.generation) || session.generation < 0)
      throw Error("INVALID_SESSION");
    if (typeof stage !== "function") throw Error("INVALID_STAGE");
    this.stage = stage;
    this.closed = false;
    this.unknown = null;
    this.drafts = [];
    const verified = this.verifySnapshot(snapshot);
    this.seed = verified.seed;
    this.knownSteps = clone(verified.steps);
    this.knownClientIDs = clone(verified.clientIDs);
    this._state = r.EditorState.create({
      doc: r.documentSchema.nodeFromJSON(verified.document),
      plugins: [
        r.richStructureGuardPlugin(),
        r.history(),
        r.collab({ version: verified.version, clientID: session.deviceId }),
      ],
    });
  }
  open() {
    if (this.closed) throw Error("CLOSED");
  }
  verifySnapshot(s) {
    if (
      !s ||
      !Number.isSafeInteger(s.version) ||
      s.version < 0 ||
      s.version > 256 ||
      !Array.isArray(s.steps) ||
      !Array.isArray(s.clientIDs) ||
      s.steps.length !== s.version ||
      s.clientIDs.length !== s.version
    )
      throw Error("INVALID_SNAPSHOT");
    if (
      s.epoch !== this.session.epoch ||
      canonicalJson(scope(s.scope)) !== canonicalJson(this.session.scope)
    )
      throw Error("SNAPSHOT_SCOPE_MISMATCH");
    s.clientIDs.forEach(id);
    if (Buffer.byteLength(canonicalJson(s)) > 8_000_000) throw Error("LIMIT");
    const seed = document(s.seed),
      current = document(s.document),
      projected = s.steps.length ? applyTextSteps(seed, s.steps) : seed;
    if (canonicalJson(projected) !== canonicalJson(current))
      throw Error("SNAPSHOT_DOCUMENT_MISMATCH");
    if (this.seed && canonicalJson(this.seed) !== canonicalJson(seed))
      throw Error("SEED_CHANGED");
    return clone({ ...s, seed, document: current });
  }
  state() {
    this.open();
    return this._state;
  }
  document() {
    this.open();
    return clone(
      document({
        ...this._state.doc.toJSON(),
        schemaVersion: this.seed.schemaVersion,
      }),
    );
  }
  makeEnvelope(steps, baseVersion) {
    return {
      operationId: randomUUID(),
      deviceId: this.session.deviceId,
      scope: this.session.scope,
      epoch: this.session.epoch,
      baseVersion,
      steps,
    };
  }
  retain(env, purpose = "WIRE_ATTEMPT") {
    const raw = canonicalJson(
      purpose === "LOCAL_INTENT"
        ? {
            kind: purpose,
            operationId: env.operationId,
            session: this.session,
            baseVersion: env.baseVersion,
            steps: env.steps,
            beforeDocument: this.document(),
          }
        : env,
    );
    this.stage(raw);
    this.drafts.push(raw);
    return {
      envelope: clone(env),
      raw,
      fingerprint: fingerprint(this.session.actorId, env),
    };
  }
  local(tr) {
    this.open();
    if (this.unknown) throw Error("UNKNOWN_OPERATION");
    if (!tr.docChanged) return false;
    const steps = tr.steps.map((s) => s.toJSON());
    applyTextSteps(this.document(), steps);
    if ((r.sendableSteps(this._state)?.steps.length ?? 0) + steps.length > 32)
      throw Error("LIMIT");
    const env = this.makeEnvelope(steps, r.getVersion(this._state));
    this.retain(env, "LOCAL_INTENT");
    this._state = this._state.apply(tr);
    return true;
  }
  insert(text, pos) {
    this.open();
    if (typeof text !== "string" || !text || !text.isWellFormed())
      throw Error("INVALID_TEXT");
    if (!Number.isSafeInteger(pos)) throw Error("INVALID_POSITION");
    return this.local(
      this._state.tr.insert(pos, this._state.schema.text(text)),
    );
  }
  receive(s) {
    this.open();
    const incoming = this.verifySnapshot(s),
      version = r.getVersion(this._state);
    if (incoming.version < version) throw Error("STALE_SNAPSHOT");
    if (
      canonicalJson(incoming.steps.slice(0, version)) !==
        canonicalJson(this.knownSteps) ||
      canonicalJson(incoming.clientIDs.slice(0, version)) !==
        canonicalJson(this.knownClientIDs)
    )
      throw Error("LOG_REWRITE");
    const added = incoming.steps.slice(version),
      ids = incoming.clientIDs.slice(version);
    if (!added.length) return;
    const before = r.sendableSteps(this._state)?.steps ?? [];
    let own = 0;
    while (own < ids.length && ids[own] === this.session.deviceId) own++;
    if (
      own > before.length ||
      canonicalJson(added.slice(0, own)) !==
        canonicalJson(before.slice(0, own).map((s) => s.toJSON()))
    )
      throw Error("UNEXPECTED_SELF_ACK");
    const tr = r.receiveTransaction(
      this._state,
      added.map((x) => r.Step.fromJSON(r.documentSchema, x)),
      ids,
    );
    const next = this._state.apply(tr);
    const remaining = r.sendableSteps(next)?.steps.length ?? 0;
    if (remaining < before.length - own) throw Error("REBASE_LOST_INTENT");
    if (r.getVersion(next) !== incoming.version)
      throw Error("PROJECTION_REJECTED");
    this._state = next;
    this.knownSteps = clone(incoming.steps);
    this.knownClientIDs = clone(incoming.clientIDs);
  }
  verifyReceipt(receipt, record) {
    const e = record.envelope;
    if (
      !receipt ||
      receipt.status !== "SERVER_ACCEPTED" ||
      receipt.operationId !== e.operationId ||
      receipt.fingerprint !== record.fingerprint ||
      receipt.epoch !== e.epoch ||
      receipt.clientID !== e.deviceId ||
      canonicalJson(receipt.scope) !== canonicalJson(e.scope) ||
      canonicalJson(receipt.steps) !== canonicalJson(e.steps) ||
      receipt.version !== e.baseVersion + e.steps.length
    )
      throw Error("RECEIPT_MISMATCH");
  }
  flush(authority, hooks = {}) {
    this.open();
    if (this.unknown) {
      const receipt = authority.receipt(
        this.session.actorId,
        this.unknown.envelope.operationId,
      );
      if (!receipt) throw Error("UNKNOWN_OPERATION");
      this.verifyReceipt(receipt, this.unknown);
      this.receive(authority.snapshot(this.session.actorId));
      this.unknown = null;
    }
    this.receive(authority.snapshot(this.session.actorId));
    const pending = r.sendableSteps(this._state);
    if (!pending)
      return { status: "SYNCED", version: r.getVersion(this._state) };
    const record = this.retain(
      this.makeEnvelope(
        pending.steps.map((s) => s.toJSON()),
        pending.version,
      ),
    );
    let receipt;
    try {
      receipt = authority.submit(this.session.actorId, record.envelope, hooks);
      this.verifyReceipt(receipt, record);
      this.receive(authority.snapshot(this.session.actorId));
    } catch (e) {
      this.unknown = record;
      throw e;
    }
    return receipt;
  }
  undo() {
    this.open();
    let tr;
    const ok = r.undo(this._state, (t) => (tr = t));
    return !!(ok && tr && this.local(tr));
  }
  redo() {
    this.open();
    let tr;
    const ok = r.redo(this._state, (t) => (tr = t));
    return !!(ok && tr && this.local(tr));
  }
  pending() {
    this.open();
    return {
      status: this.unknown
        ? "UNKNOWN"
        : r.sendableSteps(this._state)
          ? "UNSENT"
          : "SYNCED",
      unsent: r.sendableSteps(this._state)?.steps.length ?? 0,
      unknown: this.unknown ? 1 : 0,
      unknownOperation: this.unknown
        ? {
            operationId: this.unknown.envelope.operationId,
            raw: this.unknown.raw,
          }
        : null,
      drafts: clone(this.drafts),
    };
  }
  close() {
    this.closed = true;
  }
}
