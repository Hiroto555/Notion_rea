import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WindowsSourceBindings, type WindowsSourceIdentity } from "../src/platform/windows/source-bindings";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function root() { const p = realpathSync(mkdtempSync(join(tmpdir(), "folio-source-bindings-"))); chmodSync(p, 0o700); roots.push(p); return p; }
// Real SQLite and POSIX ownership checks, explicitly labelled contract-only.
function simulatedNative(): PrivatePlatform {
  const inner = new PosixPrivatePlatform();
  return {kind: "windows", bind: p => inner.bind(p), assertRoot: () => inner.assertRoot(), assertFile: p => inner.assertFile(p),
    assertSidecars: p => inner.assertSidecars(p), createExclusive: p => inner.createExclusive(p), assertEmptyFile: p => inner.assertEmptyFile(p), close: () => inner.close()};
}
const identity: WindowsSourceIdentity = {kind: "file", canonicalPath: "C:\\Folio\\authority\\shared-runtime.sqlite", fileId: "a".repeat(32), volumeId: "b".repeat(16)};
it("preserves native source binding across reconstructed objects and refuses replacement", () => {
  const directory = root(), first = new WindowsSourceBindings(directory, simulatedNative());
  first.enroll(identity); first.close();
  const second = new WindowsSourceBindings(directory, simulatedNative());
  second.assert(identity);
  expect(() => second.assert({...identity, fileId: "c".repeat(32)})).toThrow("IDENTITY_CHANGED");
  expect(() => second.enroll({...identity, fileId: "c".repeat(32)})).toThrow("IDENTITY_CHANGED");
  second.assert(identity); second.close();
});
it.each(["root", "directory", "file"] as const)("requires enrollment and preserves the %s native volume", kind => {
  const directory = root(), source = {...identity, kind}, bindings = new WindowsSourceBindings(directory, simulatedNative());
  expect(() => bindings.assert(source)).toThrow("NOT_ENROLLED");
  bindings.enroll(source); bindings.close();
  const reopened = new WindowsSourceBindings(directory, simulatedNative());
  expect(() => reopened.assert({...source, volumeId: "d".repeat(16)})).toThrow("IDENTITY_CHANGED");
  reopened.assert(source); reopened.close();
});
it("compares Windows casing consistently and rejects malformed identities", () => {
  const bindings = new WindowsSourceBindings(root(), simulatedNative()); bindings.enroll(identity);
  bindings.assert({...identity, canonicalPath: "C:\\FOLIO\\AUTHORITY\\SHARED-RUNTIME.SQLITE", fileId: "A".repeat(32)});
  expect(() => bindings.enroll({...identity, fileId: "bad"})).toThrow("IDENTITY");
  expect(() => bindings.enroll({...identity, canonicalPath: "C:\\Folio\\..\\elsewhere"})).toThrow();
  bindings.close();
});

it("replays a prefix move for all retained descendants without rewriting originals", () => {
  const directory = root(), bindings = new WindowsSourceBindings(directory, simulatedNative());
  const tree = {...identity, kind: "directory" as const, canonicalPath: "C:\\Folio\\old"};
  const child = {...identity, canonicalPath: tree.canonicalPath + "\\marker.json"};
  bindings.enroll(tree); bindings.enroll(child);
  const id = bindings.reserveMove(tree, "C:\\Folio\\retained", "a".repeat(64), 12);
  bindings.completeMove(id, {...tree, canonicalPath: "C:\\Folio\\retained"}, "native-receipt");
  bindings.close();
  const next = new WindowsSourceBindings(directory, simulatedNative());
  next.assert({...child, canonicalPath: "C:\\Folio\\retained\\marker.json"});
  expect(() => next.assert(child)).toThrow("NOT_ENROLLED");
  expect(() => next.enroll(child)).toThrow("RECEIPT_REQUIRED");
  next.close();
});

it("allows exactly receipt-authorized sidecar reuse after proving the retained identity and content", () => {
  const directory = root(), bindings = new WindowsSourceBindings(directory, simulatedNative());
  bindings.enroll(identity);
  const retained = {...identity, canonicalPath: identity.canonicalPath + ".retained"};
  const id = bindings.reserveMove(identity, retained.canonicalPath, "c".repeat(64), 7);
  bindings.completeMove(id, retained, "native-receipt");
  bindings.close();
  const next = new WindowsSourceBindings(directory, simulatedNative());
  const replacement = {...identity, fileId: "d".repeat(32)};
  expect(() => next.enroll(replacement)).toThrow("RECEIPT_REQUIRED");
  let proved = false;
  next.enrollCreated(replacement, (actual, hash, bytes) => {
    expect(actual.fileId).toBe(identity.fileId); expect(actual.canonicalPath).toBe(retained.canonicalPath.toLowerCase());
    expect(hash).toBe("c".repeat(64)); expect(bytes).toBe(7); proved = true;
  });
  expect(proved).toBe(true); next.close();
  const final = new WindowsSourceBindings(directory, simulatedNative());
  final.assert(replacement); final.assert(retained);
  expect(() => final.enroll({...replacement, fileId: "e".repeat(32)})).toThrow("IDENTITY_CHANGED");
  final.close();
});

it("retains incomplete relocation holds after restart and rejects selection replacement atomically", () => {
  const directory = root(), bindings = new WindowsSourceBindings(directory, simulatedNative());
  bindings.enroll(identity);
  bindings.reserveMove(identity, identity.canonicalPath + ".retained", "a".repeat(64), 0);
  bindings.close();
  const next = new WindowsSourceBindings(directory, simulatedNative());
  expect(() => next.reserveMove(identity, identity.canonicalPath + ".other", "a".repeat(64), 0)).toThrow("TRANSITION_PENDING");
  const unseen = {...identity, canonicalPath: "C:\\Folio\\new.json"};
  expect(() => next.enrollSelected([unseen, {...identity, fileId: "f".repeat(32)}], () => {})).toThrow("IDENTITY_CHANGED");
  expect(() => next.assert(unseen)).toThrow("NOT_ENROLLED");
  next.close();
});

it("pins the exact K attempt before dispatch and completes its binding with a retained observation link", () => {
  const directory = root(), bindings = new WindowsSourceBindings(directory, simulatedNative());
  const parent = {...identity, kind: "directory" as const, canonicalPath: "C:\\Folio\\authority"};
  bindings.enroll(parent);
  const reservation = bindings.reserveCreation(identity.canonicalPath);
  const attemptId = "c".repeat(32), wireSha256 = "d".repeat(64);
  bindings.associateTransition(reservation, attemptId, wireSha256); bindings.close();
  const next = new WindowsSourceBindings(directory, simulatedNative());
  expect(next.transitionAssociation(reservation)).toEqual({attemptId, wireSha256});
  expect(() => next.associateTransition(reservation, "e".repeat(32), wireSha256)).toThrow("ASSOCIATION");
  expect(() => next.enroll(identity)).toThrow("TRANSITION_PENDING");
  const link = {attemptId, fingerprint: "a".repeat(64), resolutionSha256: "b".repeat(64)};
  next.enrollCreated(identity, () => {}, reservation, {link, assertCurrent() { next.assert(parent); }});
  expect(next.hasInvestigation(link)).toBe(true);
  expect(next.pendingTransitions().creations).toEqual([]);
  next.close();
  const reopened = new WindowsSourceBindings(directory, simulatedNative());
  expect(reopened.hasInvestigation(link)).toBe(true);
  expect(reopened.retainedIdentity("file", identity.canonicalPath)).toEqual(identity);
  reopened.assert(identity); reopened.close();
});
