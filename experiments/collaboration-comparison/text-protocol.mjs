import r from "./runtime/bundle.cjs";
import {
  canonicalJson as baseCanonical,
  hashJson,
} from "../shared-workspace-lab/src/contracts.mjs";
export function canonicalJson(value) {
  const raw = baseCanonical(value);
  function walk(v) {
    if (typeof v === "string" && !v.isWellFormed())
      throw Error("INVALID_UNICODE");
    if (typeof v === "number" && Object.is(v, -0)) throw Error("UNSAFE_NUMBER");
    if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (!k.isWellFormed()) throw Error("INVALID_UNICODE");
        walk(x);
      }
  }
  walk(value);
  return raw;
}
export const clone = (x) => JSON.parse(canonicalJson(x));
export const fingerprint = (actorId, envelope) =>
  hashJson({ actorId, envelope });
export function keys(value, allowed, required = allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw Error("INVALID_ENVELOPE");
  canonicalJson(value);
}
export function id(x) {
  if (
    typeof x !== "string" ||
    !x.isWellFormed() ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(x)
  )
    throw Error("INVALID_ID");
  return x;
}
export function scope(x) {
  keys(x, ["workspaceId", "documentId", "incarnationId"]);
  Object.values(x).forEach(id);
  return clone(x);
}
export function document(x) {
  const inspected = r.inspectSharedDocument(canonicalJson(x));
  if (!inspected.ok) throw Error("INVALID_DOCUMENT");
  return inspected.document;
}
function signature(doc) {
  const out = [];
  doc.descendants((n) => {
    if (!n.isText) out.push([n.type.name, n.attrs]);
  });
  return canonicalJson(out);
}
function boundary(parent, offset) {
  let valid = true;
  parent.forEach((node, start) => {
    if (node.isText && offset > start && offset < start + node.nodeSize) {
      const k = offset - start,
        a = node.text.charCodeAt(k - 1),
        b = node.text.charCodeAt(k);
      if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff)
        valid = false;
    }
  });
  return valid;
}
export function applyTextSteps(initial, steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 256)
    throw Error("INVALID_STEPS");
  const base = document(initial);
  let doc = r.documentSchema.nodeFromJSON(base);
  const shape = signature(doc);
  for (const json of steps) {
    keys(json, ["stepType", "from", "to", "slice"], ["stepType", "from", "to"]);
    if (json.stepType !== "replace") throw Error("UNSUPPORTED_STEP");
    if (
      !Number.isSafeInteger(json.from) ||
      !Number.isSafeInteger(json.to) ||
      json.from < 0 ||
      json.to < json.from
    )
      throw Error("INVALID_POSITION");
    let from, to;
    try {
      from = doc.resolve(json.from);
      to = doc.resolve(json.to);
    } catch {
      throw Error("INVALID_POSITION");
    }
    if (
      !from.parent.isTextblock ||
      !from.sameParent(to) ||
      !boundary(from.parent, from.parentOffset) ||
      !boundary(to.parent, to.parentOffset)
    )
      throw Error("UNSUPPORTED_STEP");
    if (json.slice !== undefined) {
      keys(json.slice, ["content", "openStart", "openEnd"], []);
      if ((json.slice.openStart ?? 0) !== 0 || (json.slice.openEnd ?? 0) !== 0)
        throw Error("UNSUPPORTED_STEP");
      if (
        json.slice.content !== undefined &&
        !Array.isArray(json.slice.content)
      )
        throw Error("UNSUPPORTED_STEP");
      for (const node of json.slice.content ?? []) {
        keys(node, ["type", "text"], ["type", "text"]);
        if (
          node.type !== "text" ||
          typeof node.text !== "string" ||
          !node.text ||
          !node.text.isWellFormed()
        )
          throw Error("UNSUPPORTED_STEP");
      }
    }
    const result = r.Step.fromJSON(r.documentSchema, json).apply(doc);
    if (result.failed) throw Error("INVALID_STEP");
    doc = result.doc;
    if (signature(doc) !== shape) throw Error("UNSUPPORTED_STEP");
  }
  return clone(
    document({ ...doc.toJSON(), schemaVersion: base.schemaVersion }),
  );
}
export function envelope(value) {
  keys(value, [
    "operationId",
    "deviceId",
    "scope",
    "epoch",
    "baseVersion",
    "steps",
  ]);
  id(value.operationId);
  id(value.deviceId);
  id(value.epoch);
  scope(value.scope);
  if (
    !Number.isSafeInteger(value.baseVersion) ||
    value.baseVersion < 0 ||
    !Array.isArray(value.steps) ||
    !value.steps.length ||
    value.steps.length > 32
  )
    throw Error("INVALID_ENVELOPE");
  if (Buffer.byteLength(canonicalJson(value)) > 1_048_576) throw Error("LIMIT");
  return clone(value);
}
