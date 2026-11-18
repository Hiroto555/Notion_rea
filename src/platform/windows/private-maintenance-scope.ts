import { win32 } from "node:path";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import type { NativePrivateIdentity } from "../private-persistence";

/** Bounded immutable operation origin proof. A K/raw UNKNOWN record keeps the
 * exact native root + workspace + endpoint parent scope it was dispatched
 * under so maintenance can re-prove the same authority after restart without
 * ever re-deriving it from a mutable current configuration. */
export const WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES = 4096;

export type WindowsMaintenanceOriginRequest = Readonly<{
  family: "filesystem" | "raw-export";
  attemptId: string;
  requestSha256: string;
  /** Mandatory for K requests (the exact wire ioRoot); raw providers may
   * omit it and fill the configured root themselves. */
  root?: string;
  paths: readonly string[];
}>;

export type WindowsMaintenanceOriginScope = Readonly<{
  version: 1;
  family: "filesystem" | "raw-export";
  attemptId: string;
  requestSha256: string;
  root: NativePrivateIdentity;
  stateRoot: string;
  workspace: NativePrivateIdentity & Readonly<{workspaceId: string | null}>;
  osSid: string;
  writerId: null;
  sessionId: null;
  endpoints: readonly Readonly<{path: string; parent: NativePrivateIdentity}>[];
}>;

export type WindowsMaintenanceOriginProvider =
  (request: WindowsMaintenanceOriginRequest) => WindowsMaintenanceOriginScope | undefined;

const FILE_ID = /^[0-9a-fA-F]{32}$/, VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const SID = /^S-1-\d+(?:-\d+)+$/, SHA256 = /^[0-9a-f]{64}$/;
const ATTEMPT = /^[0-9a-f]{32}$/, WORKSPACE_ID = /^[a-zA-Z0-9-]{1,100}$/;
const FAMILIES = ["filesystem", "raw-export"] as const;

function bad(code: string): never {
  throw new Error(`WINDOWS_MAINTENANCE_SCOPE_${code}`);
}

function ownKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every(k => keys.includes(k))) bad(code);
}

function canonicalPath(path: unknown, code: string): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 240 ||
      !/^[A-Z]:\\[\x20-\x7e]*$/.test(path)) bad(code);
  const c = validateWindowsPath(path, `${path[0]}:\\`).canonical;
  if (c !== path) bad(code);
  return c;
}

const fold = (p: string) => asciiCaseFold(p).replace(/\\$/, "");
const under = (p: string, root: string) => fold(p).startsWith(fold(root) + "\\");
const insideOrEqual = (p: string, root: string) => fold(p) === fold(root) || under(p, root);
const disjoint = (a: string, b: string) => !insideOrEqual(a, b) && !insideOrEqual(b, a);

function identity(value: unknown, expectedPath: string | undefined, code: string): NativePrivateIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad(code);
  const v = value as Record<string, unknown>;
  ownKeys(v, ["path", "fileId", "volumeId"], code);
  const path = canonicalPath(v.path, code);
  if (expectedPath !== undefined && fold(path) !== fold(expectedPath)) bad(code);
  if (typeof v.fileId !== "string" || !FILE_ID.test(v.fileId) ||
      typeof v.volumeId !== "string" || !VOLUME_ID.test(v.volumeId)) bad(code);
  return Object.freeze({path, fileId: v.fileId, volumeId: v.volumeId});
}

function checkScope(value: unknown): WindowsMaintenanceOriginScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) bad("TYPE");
  const v = value as Record<string, unknown>;
  ownKeys(v, ["version", "family", "attemptId", "requestSha256", "root", "stateRoot",
    "workspace", "osSid", "writerId", "sessionId", "endpoints"], "KEYS");
  if (v.version !== 1 || typeof v.family !== "string" || !FAMILIES.includes(v.family as never) ||
      typeof v.attemptId !== "string" || !ATTEMPT.test(v.attemptId) ||
      typeof v.requestSha256 !== "string" || !SHA256.test(v.requestSha256) ||
      typeof v.osSid !== "string" || !SID.test(v.osSid) ||
      v.writerId !== null || v.sessionId !== null) bad("FIELD");
  const root = identity(v.root, undefined, "ROOT");
  const drive = validateWindowsPath(root.path, `${root.path[0]}:\\`).canonical;
  if (drive.length <= 3) bad("DRIVE_ROOT");
  const stateRoot = canonicalPath(v.stateRoot, "STATE_ROOT");
  if (!disjoint(stateRoot, root.path)) bad("STATE_OVERLAP");
  if (v.workspace === null || typeof v.workspace !== "object" || Array.isArray(v.workspace)) bad("WORKSPACE");
  const ws = v.workspace as Record<string, unknown>;
  ownKeys(ws, ["path", "fileId", "volumeId", "workspaceId"], "WORKSPACE");
  const workspace = identity({path: ws.path, fileId: ws.fileId, volumeId: ws.volumeId}, undefined, "WORKSPACE");
  if (!insideOrEqual(workspace.path, root.path)) bad("WORKSPACE_OUTSIDE");
  if (asciiCaseFold(workspace.volumeId) !== asciiCaseFold(root.volumeId)) bad("WORKSPACE_VOLUME");
  if (!(ws.workspaceId === null || (typeof ws.workspaceId === "string" && WORKSPACE_ID.test(ws.workspaceId))))
    bad("WORKSPACE_ID");
  if (!Array.isArray(v.endpoints) || v.endpoints.length < 1 || v.endpoints.length > 2) bad("ENDPOINTS");
  const endpoints: Readonly<{path: string; parent: NativePrivateIdentity}>[] = [];
  const seen = new Set<string>();
  for (const entry of v.endpoints) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) bad("ENDPOINT");
    ownKeys(entry as Record<string, unknown>, ["path", "parent"], "ENDPOINT");
    const e = entry as Record<string, unknown>;
    const path = canonicalPath(e.path, "ENDPOINT");
    if (!under(path, root.path) || !disjoint(path, stateRoot)) bad("ENDPOINT_OUTSIDE");
    const parent = identity(e.parent, win32.dirname(path), "ENDPOINT_PARENT");
    if (asciiCaseFold(parent.volumeId) !== asciiCaseFold(root.volumeId)) bad("ENDPOINT_VOLUME");
    if (seen.has(fold(path))) bad("ENDPOINT_DUPLICATE");
    seen.add(fold(path));
    endpoints.push(Object.freeze({path, parent}));
  }
  return Object.freeze({version: 1, family: v.family as "filesystem" | "raw-export",
    attemptId: v.attemptId, requestSha256: v.requestSha256, root, stateRoot,
    workspace: Object.freeze({...workspace, workspaceId: ws.workspaceId as string | null}),
    osSid: v.osSid, writerId: null, sessionId: null, endpoints: Object.freeze(endpoints)});
}

/** Canonical serialized form: fixed key order, so decode can require a
 * byte-exact roundtrip (which also rejects duplicate keys, unknown keys and
 * non-canonical JSON without a special parser). */
function body(scope: WindowsMaintenanceOriginScope): string {
  const id = (i: NativePrivateIdentity) => ({path: i.path, fileId: i.fileId, volumeId: i.volumeId});
  return JSON.stringify({version: scope.version, family: scope.family, attemptId: scope.attemptId,
    requestSha256: scope.requestSha256, root: id(scope.root), stateRoot: scope.stateRoot,
    workspace: {...id(scope.workspace), workspaceId: scope.workspace.workspaceId},
    osSid: scope.osSid, writerId: scope.writerId, sessionId: scope.sessionId,
    endpoints: scope.endpoints.map(e => ({path: e.path, parent: id(e.parent)}))});
}

export function encodeWindowsMaintenanceOrigin(value: unknown): Uint8Array {
  const scope = checkScope(value);
  const bytes = Buffer.from(body(scope), "utf8");
  if (bytes.byteLength > WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES) bad("MAX_BYTES");
  return Uint8Array.from(bytes);
}

export function decodeWindowsMaintenanceOrigin(bytes: Uint8Array): WindowsMaintenanceOriginScope {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
      bytes.byteLength > WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES) bad("MAX_BYTES");
  let text: string;
  try { text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); } catch { bad("UTF8"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text!); } catch { bad("JSON"); }
  const scope = checkScope(parsed);
  if (body(scope) !== text!) bad("CANONICAL");
  return scope;
}

/** Order-preserving dedup of canonical request paths. */
function requestPaths(request: WindowsMaintenanceOriginRequest): readonly string[] {
  if (!Array.isArray(request.paths) || request.paths.length === 0 || request.paths.length > 2) bad("PATHS");
  const out: string[] = [], seen = new Set<string>();
  for (const p of request.paths) {
    const path = canonicalPath(p, "PATHS");
    if (!seen.has(fold(path))) { seen.add(fold(path)); out.push(path); }
  }
  return Object.freeze(out);
}

function checkRequest(request: WindowsMaintenanceOriginRequest): readonly string[] {
  if (request === null || typeof request !== "object" || Array.isArray(request)) bad("REQUEST");
  const r = request as Record<string, unknown>;
  const keys = r.root === undefined
    ? ["family", "attemptId", "requestSha256", "paths"]
    : ["family", "attemptId", "requestSha256", "root", "paths"];
  ownKeys(r, keys, "REQUEST");
  if (typeof r.family !== "string" || !FAMILIES.includes(r.family as never) ||
      typeof r.attemptId !== "string" || !ATTEMPT.test(r.attemptId) ||
      typeof r.requestSha256 !== "string" || !SHA256.test(r.requestSha256)) bad("REQUEST");
  // K requests must pin their exact wire ioRoot; raw requests may let the
  // provider fill the configured root.
  if (r.root === undefined) {
    if (r.family === "filesystem") bad("REQUEST");
  } else canonicalPath(r.root, "REQUEST");
  return requestPaths(request);
}

const sameIdentity = (a: NativePrivateIdentity, b: {path: string; fileId: string; volumeId: string}) =>
  fold(a.path) === fold(b.path) && asciiCaseFold(a.fileId) === asciiCaseFold(b.fileId) &&
  asciiCaseFold(a.volumeId) === asciiCaseFold(b.volumeId);

/**
 * Re-prove that a retained operation scope authorizes this exact maintenance
 * request/context. With `origin` absent only the legacy inside-workspace
 * predicate applies and external targets stay UNKNOWN_UNRESOLVABLE — there is
 * never a fallback from a mismatched scope back to the legacy predicate.
 */
export function assertWindowsMaintenanceScope(
  origin: Uint8Array | undefined,
  request: WindowsMaintenanceOriginRequest,
  context: Readonly<{workspace: string; workspaceId: string; osSid: string}>,
  proof: Readonly<{directory(path: string): NativePrivateIdentity}>,
  configured?: Readonly<{root: string; stateRoot: string}>,
): void {
  const paths = checkRequest(request);
  if (context === null || typeof context !== "object") bad("CONTEXT");
  const workspace = canonicalPath(context.workspace, "CONTEXT");
  if (origin === undefined) {
    const ws = fold(workspace);
    for (const p of paths)
      if (!(fold(p) === ws || fold(p).startsWith(ws + "\\"))) throw new Error("UNKNOWN_UNRESOLVABLE");
    return;
  }
  const scope = decodeWindowsMaintenanceOrigin(origin);
  if (scope.family !== request.family || scope.attemptId !== request.attemptId ||
      scope.requestSha256 !== request.requestSha256 ||
      (request.root !== undefined && fold(scope.root.path) !== fold(request.root))) bad("REQUEST");
  if (scope.endpoints.length !== paths.length ||
      !scope.endpoints.every((e, i) => fold(e.path) === fold(paths[i]))) bad("PATHS");
  if (configured !== undefined &&
      (fold(scope.root.path) !== fold(configured.root) || fold(scope.stateRoot) !== fold(configured.stateRoot)))
    bad("CONFIGURED");
  for (const p of paths)
    if (!under(p, scope.root.path) || !disjoint(p, scope.stateRoot)) bad("PATHS");
  if (scope.osSid !== context.osSid) bad("SID");
  if (fold(scope.workspace.path) !== fold(workspace)) bad("WORKSPACE");
  if (scope.workspace.workspaceId !== null && scope.workspace.workspaceId !== context.workspaceId)
    bad("WORKSPACE_ID");
  if (typeof proof.directory !== "function") bad("PROOF");
  const rootProof = proof.directory(scope.root.path);
  if (!sameIdentity(rootProof, scope.root)) bad("ROOT_CHANGED");
  const wsProof = proof.directory(scope.workspace.path);
  if (!sameIdentity(wsProof, scope.workspace)) bad("WORKSPACE_CHANGED");
  for (const endpoint of scope.endpoints) {
    const parent = proof.directory(endpoint.parent.path);
    if (!sameIdentity(parent, endpoint.parent)) bad("ENDPOINT_CHANGED");
  }
}
