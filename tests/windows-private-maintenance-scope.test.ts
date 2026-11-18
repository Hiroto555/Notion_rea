import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  assertWindowsMaintenanceScope, decodeWindowsMaintenanceOrigin, encodeWindowsMaintenanceOrigin,
  WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES,
  type WindowsMaintenanceOriginRequest, type WindowsMaintenanceOriginScope,
} from "../src/platform/windows/private-maintenance-scope";
import type { NativePrivateIdentity } from "../src/platform/private-persistence";

// NOT_RUN — pure validator coverage for the retained UNKNOWN origin scope.
// Contract-only; no Windows OS/filesystem acceptance.

const ROOT = "C:\\Folio", STATE_ROOT = "C:\\FolioState", WS = "C:\\Folio\\workspace-1";
const EXT = "C:\\Folio\\External", DEST = "C:\\Folio\\External\\out.bin", SRC = "C:\\Folio\\workspace-1\\src.bin";
const ID = (n: string) => n.repeat(32), VOL = "4".repeat(16);
const SID = "S-1-5-21-1000", ATTEMPT = "a".repeat(32);
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const id = (path: string, n: string): NativePrivateIdentity =>
  Object.freeze({path, fileId: ID(n), volumeId: VOL});

function scope(overrides: Record<string, unknown> = {}): WindowsMaintenanceOriginScope {
  return Object.freeze({version: 1, family: "filesystem" as const, attemptId: ATTEMPT,
    requestSha256: sha("wire"), root: id(ROOT, "1"), stateRoot: STATE_ROOT,
    workspace: Object.freeze({path: WS, fileId: ID("2"), volumeId: VOL, workspaceId: "ws-1"}),
    osSid: SID, writerId: null, sessionId: null,
    endpoints: Object.freeze([
      Object.freeze({path: SRC, parent: id(WS, "2")}),
      Object.freeze({path: DEST, parent: id(EXT, "3")}),
    ]), ...overrides});
}
const REQUEST: WindowsMaintenanceOriginRequest = Object.freeze({
  family: "filesystem", attemptId: ATTEMPT, requestSha256: sha("wire"), root: ROOT,
  paths: Object.freeze([SRC, DEST])});
const CONTEXT = Object.freeze({workspace: WS, workspaceId: "ws-1", osSid: SID});
const CONFIGURED = Object.freeze({root: ROOT, stateRoot: STATE_ROOT});
const proofOk = {directory: (p: string) => id(p, p === ROOT ? "1" : p === WS ? "2" : "3")};

describe("windows maintenance origin scope", () => {
  it("roundtrips a complete valid scope byte-exactly", () => {
    const bytes = encodeWindowsMaintenanceOrigin(scope());
    expect(bytes.byteLength).toBeLessThanOrEqual(WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES);
    expect(decodeWindowsMaintenanceOrigin(bytes)).toEqual(scope());
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST, CONTEXT, proofOk, CONFIGURED)).not.toThrow();
  });
  it("rejects unknown/extra keys, non-canonical JSON, and oversized payloads", () => {
    expect(() => encodeWindowsMaintenanceOrigin(scope({extra: 1}))).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    const parsed = JSON.parse(new TextDecoder().decode(encodeWindowsMaintenanceOrigin(scope())));
    parsed.root.bogus = 1;
    expect(() => decodeWindowsMaintenanceOrigin(Buffer.from(JSON.stringify(parsed), "utf8")))
      .toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => decodeWindowsMaintenanceOrigin(Buffer.from(`{"version":1,"version":1}`)))
      .toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => decodeWindowsMaintenanceOrigin(Buffer.alloc(WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES + 1)))
      .toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => decodeWindowsMaintenanceOrigin(Buffer.from([0xff, 0xfe, 0x7b])))
      .toThrow("WINDOWS_MAINTENANCE_SCOPE_");
  });
  it("rejects drive roots, state overlap, and root/state mismatches", () => {
    expect(() => encodeWindowsMaintenanceOrigin(scope({root: id("C:\\", "1")})))
      .toThrow("WINDOWS_MAINTENANCE_SCOPE_DRIVE_ROOT");
    expect(() => encodeWindowsMaintenanceOrigin(scope({stateRoot: `${ROOT}\\state`})))
      .toThrow("WINDOWS_MAINTENANCE_SCOPE_STATE_OVERLAP");
    const bytes = encodeWindowsMaintenanceOrigin(scope());
    expect(() => assertWindowsMaintenanceScope(bytes,
      {...REQUEST, root: "C:\\Other"}, CONTEXT, proofOk, CONFIGURED)).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST, CONTEXT, proofOk,
      {root: ROOT, stateRoot: "C:\\Elsewhere"})).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
  });
  it("rejects wrong workspace, changed parent IDs, and request drift", () => {
    const bytes = encodeWindowsMaintenanceOrigin(scope());
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST,
      {...CONTEXT, workspace: "C:\\Folio\\workspace-2"}, proofOk, CONFIGURED)).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST,
      {...CONTEXT, workspaceId: "ws-2"}, proofOk, CONFIGURED)).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST, CONTEXT,
      {directory: p => id(p, "9")}, CONFIGURED)).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => assertWindowsMaintenanceScope(bytes,
      {...REQUEST, requestSha256: sha("other")}, CONTEXT, proofOk, CONFIGURED)).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => assertWindowsMaintenanceScope(bytes,
      {...REQUEST, paths: [SRC, "C:\\Folio\\External\\other.bin"]}, CONTEXT, proofOk, CONFIGURED))
      .toThrow("WINDOWS_MAINTENANCE_SCOPE_");
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST, {...CONTEXT, osSid: "S-1-5-21-2000"},
      proofOk, CONFIGURED)).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
  });
  it("permits legacy inside-workspace records and denies legacy external records", () => {
    const internal: WindowsMaintenanceOriginRequest = {...REQUEST, paths: [SRC]};
    expect(() => assertWindowsMaintenanceScope(undefined, internal, CONTEXT, proofOk, CONFIGURED)).not.toThrow();
    expect(() => assertWindowsMaintenanceScope(undefined, REQUEST, CONTEXT, proofOk, CONFIGURED))
      .toThrow("UNKNOWN_UNRESOLVABLE");
    expect(() => assertWindowsMaintenanceScope(undefined, {...REQUEST, paths: [WS]}, CONTEXT, proofOk))
      .not.toThrow();
  });
  it("keeps null workspace semantics pinned to the exact native directory", () => {
    const rescue = scope({workspace: {path: WS, fileId: ID("2"), volumeId: VOL, workspaceId: null}});
    const bytes = encodeWindowsMaintenanceOrigin(rescue);
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST, CONTEXT, proofOk, CONFIGURED)).not.toThrow();
    // A fabricated semantic ID is never backfilled; a changed native directory
    // still fails even though the semantic check is absent.
    expect(() => assertWindowsMaintenanceScope(bytes, REQUEST, CONTEXT,
      {directory: p => id(p, p === ROOT ? "1" : "7")}, CONFIGURED)).toThrow("WINDOWS_MAINTENANCE_SCOPE_");
  });
  it("freezes scope values so providers cannot mutate retained authority", () => {
    const decoded = decodeWindowsMaintenanceOrigin(encodeWindowsMaintenanceOrigin(scope()));
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.endpoints)).toBe(true);
    expect(() => { (decoded as any).osSid = "S-1-5-21-9"; }).toThrow();
  });
});
