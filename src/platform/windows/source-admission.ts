import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { win32 } from "node:path";
import { types } from "node:util";
import { canonical } from "../../collaboration/runtime/canonical";
import { validateWindowsPath, asciiCaseFold } from "./path-policy";
import type { NativePrivateFile, NativePrivateTree } from "../private-persistence";
import type { WindowsSourceIdentity } from "./source-bindings";

/** Main-process picker/import boundary, never renderer supplied authority.
 * The caller pins the verified manifest's exact hash and its current request. */
export type WindowsSelectedSourceAdmission = Readonly<{
  kind: "backup" | "private-import";
  path: string;
  manifestPath: string;
  manifestSha256: string;
  assertCurrent(): void;
}>;
export type WindowsSelectedSourceAdmissionReceipt = Readonly<{
  fingerprint: string; manifestSha256: string; tree: NativePrivateTree;
  identities: readonly WindowsSourceIdentity[];
}>;
export type WindowsSourceAdmissionPort = Readonly<{
  root: string;
  directory(path: string): WindowsSourceIdentity;
  file(path: string): WindowsSourceIdentity;
  inspectTree(path: string): NativePrivateTree;
  inspectFile(path: string, maxBytes?: number): NativePrivateFile;
  readFile(path: string, expected: NativePrivateFile): Uint8Array;
  withDirectories<T>(identities: readonly WindowsSourceIdentity[], work: () => T): T;
  enroll(identities: readonly WindowsSourceIdentity[], current: () => void): void;
  current(): void;
  entries?(path: string): readonly Readonly<{name: string; directory: boolean}>[];
}>;
/** Exact single-file admission for an orphan native file the caller already
 * pinned by path + full native identity. No bytes are supplied by the caller;
 * the hash is re-proven through the native port. */
export type WindowsSelectedFileAdmission = Readonly<{
  kind: "orphan";
  path: string;
  expected: NativePrivateFile;
  assertCurrent(): void;
}>;
export type WindowsSelectedFileAdmissionReceipt = Readonly<{
  fingerprint: string;
  file: NativePrivateFile;
  identities: readonly WindowsSourceIdentity[];
}>;
export type WindowsSelectedFileInspection = Readonly<{
  kind: "orphan";
  path: string;
  assertCurrent(): void;
}>;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function check(ok: unknown): asserts ok { if (!ok) throw new Error("WINDOWS_SOURCE_ADMISSION_UNPROVEN"); }
function sync(fn: () => void): void {
  check(typeof fn === "function" && !types.isAsyncFunction(fn) && !types.isGeneratorFunction(fn));
  const result: unknown = fn();
  if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
  check(result === undefined);
}
/** Enumerated names only select what must be proved. Each identity and the
 * aggregate inventory/hash are independently obtained from the native port.
 * The single implementation admits the exact ancestor chain with it. */
export function admitWindowsSelectedSource(request: WindowsSelectedSourceAdmission,
  port: WindowsSourceAdmissionPort): WindowsSelectedSourceAdmissionReceipt {
  return admitWindowsSelectedSubtree(request, port);
}

const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const fold = asciiCaseFold;
/** Directory identities from the admission root itself through the selected
 * path's parent, shallowest first. Siblings are never enumerated: each
 * ancestor is proven individually through the native port. */
function ancestorIdentities(selectedPath: string, port: WindowsSourceAdmissionPort): WindowsSourceIdentity[] {
  check(fold(selectedPath) !== fold(port.root));
  const chain: string[] = [];
  for (let directory = win32.dirname(selectedPath); fold(directory) !== fold(port.root); directory = win32.dirname(directory)) {
    check(chain.length < 32 && directory.length > port.root.length &&
      fold(directory).startsWith(fold(port.root) + "\\"));
    chain.unshift(directory);
  }
  return [port.root, ...chain].map(directory => port.directory(directory));
}
function subtreeIdentities(path: string, ancestors: readonly WindowsSourceIdentity[],
  port: WindowsSourceAdmissionPort): WindowsSourceIdentity[] {
  const identities: WindowsSourceIdentity[] = [...ancestors];
  const walk = (directory: string, depth: number): void => {
    check(depth <= 32 && identities.length < 4096);
    identities.push(port.directory(directory));
    const entries = port.entries ? port.entries(directory) :
      readdirSync(directory, {withFileTypes: true}).map(e => ({name: e.name, directory: e.isDirectory()}));
    check(entries.length <= 4096);
    for (const entry of entries) {
      check(entry.name.length > 0 && entry.name !== "." && entry.name !== ".." && !/[\\/:]/.test(entry.name));
      const child = validateWindowsPath(win32.join(directory, entry.name), path).canonical;
      if (entry.directory) walk(child, depth + 1);
      else { check(identities.length < 4096); identities.push(port.file(child)); }
    }
  };
  walk(path, 0);
  return identities;
}
/** Explicit admission of a selected subtree plus the exact ancestor chain
 * between port.root and its parent. Ancestors are proven one directory at a
 * time without enumerating siblings, so an unenrolled parent no longer
 * disqualifies an explicitly authorized selection. */
export function admitWindowsSelectedSubtree(request: WindowsSelectedSourceAdmission,
  port: WindowsSourceAdmissionPort): WindowsSelectedSourceAdmissionReceipt {
  const selected = {...request};
  check(["backup", "private-import"].includes(selected.kind) && /^[a-f0-9]{64}$/.test(selected.manifestSha256));
  const path = validateWindowsPath(selected.path, port.root).canonical;
  const manifest = validateWindowsPath(selected.manifestPath, path).canonical;
  check(path === selected.path && manifest === selected.manifestPath &&
    fold(manifest).startsWith(fold(path) + "\\"));
  const current = () => { sync(port.current); sync(selected.assertCurrent); };
  current();
  const ancestors = ancestorIdentities(path, port);
  const identities = subtreeIdentities(path, ancestors, port);
  check(identities.length <= 4096);
  const directories = identities.filter(i => i.kind === "directory");
  return port.withDirectories(directories, () => {
    const tree = port.inspectTree(path);
    check(tree.entries === identities.length - ancestors.length);
    const manifestIdentity = identities.find(i => i.kind === "file" && fold(i.canonicalPath) === fold(manifest));
    check(manifestIdentity);
    const file = port.inspectFile(manifest);
    check(file.fileId === manifestIdentity.fileId && file.volumeId === manifestIdentity.volumeId &&
      file.sha256 === selected.manifestSha256 && file.bytes <= 32 * 1024 * 1024);
    const bytes = port.readFile(manifest, file);
    check(sha(bytes) === selected.manifestSha256);
    // Tree aggregate and manifest hash are re-proven inside the enrollment
    // transaction itself, never only before it.
    const reprove = () => {
      current();
      for (const identity of identities) {
        const now = identity.kind === "directory" ? port.directory(identity.canonicalPath) : port.file(identity.canonicalPath);
        check(canonical(now) === canonical(identity));
      }
      check(canonical(port.inspectTree(path)) === canonical(tree));
      const again = port.inspectFile(manifest);
      check(again.fileId === manifestIdentity.fileId && again.volumeId === manifestIdentity.volumeId &&
        again.sha256 === selected.manifestSha256);
      current();
    };
    check(canonical(port.inspectTree(path)) === canonical(tree));
    reprove();
    port.enroll(identities, reprove);
    return Object.freeze({fingerprint: sha(canonical({kind: selected.kind, path, manifest,
      manifestSha256: selected.manifestSha256, tree, identities}, 2 * 1024 * 1024)),
    manifestSha256: selected.manifestSha256, tree, identities: Object.freeze(identities)});
  });
}
/** Exact orphan file admission: the caller-pinned path + native identity is
 * re-proven twice through the native port (<=256 MiB inspect bound) and
 * enrolled atomically with the ancestor chain inside the caller's current
 * callback. Caller-supplied bytes are never read. */
export function admitWindowsSelectedFile(request: WindowsSelectedFileAdmission,
  port: WindowsSourceAdmissionPort): WindowsSelectedFileAdmissionReceipt {
  const selected = {...request};
  check(selected.kind === "orphan");
  // Snapshot the caller-pinned proof before any callback can mutate it.
  const expected = {...selected.expected};
  check(expected !== null && typeof expected === "object" &&
    FILE_ID.test(expected.fileId) && VOLUME_ID.test(expected.volumeId) &&
    /^[0-9a-f]{64}$/.test(expected.sha256) &&
    Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && expected.bytes <= 256 * 1024 * 1024);
  const path = validateWindowsPath(selected.path, port.root).canonical;
  check(path === selected.path && expected.path === path);
  const current = () => { sync(port.current); sync(selected.assertCurrent); };
  current();
  const ancestors = ancestorIdentities(path, port);
  const proven = (): NativePrivateFile => {
    const file = port.inspectFile(path, 256 * 1024 * 1024);
    check(file.path === path && file.fileId === expected.fileId && file.volumeId === expected.volumeId &&
      file.bytes === expected.bytes && file.sha256 === expected.sha256);
    return file;
  };
  return port.withDirectories(ancestors, () => {
    const file = proven();
    const fileIdentity: WindowsSourceIdentity = Object.freeze({
      kind: "file", canonicalPath: path, fileId: file.fileId, volumeId: file.volumeId});
    const identities: WindowsSourceIdentity[] = [...ancestors, fileIdentity];
    const reprove = () => {
      current();
      for (const identity of ancestors) check(canonical(port.directory(identity.canonicalPath)) === canonical(identity));
      check(canonical(proven()) === canonical(file));
      current();
    };
    reprove();
    port.enroll(identities, reprove);
    return Object.freeze({fingerprint: sha(canonical({kind: "orphan", path, file, identities}, 2 * 1024 * 1024)),
      file: Object.freeze({...file}), identities: Object.freeze(identities)});
  });
}
/** Authority-gated native read of an explicitly selected orphan file: the
 * exact ancestor chain is proven without sibling enumeration, the native
 * file/hash/length is proven twice, and the result grants NO enrollment —
 * inspection may observe a known replacement, but only
 * `admitWindowsSelectedFile` can make it admissible (and the ledger rejects
 * replacements at that point). */
export function inspectWindowsSelectedFile(request: WindowsSelectedFileInspection,
  port: WindowsSourceAdmissionPort): NativePrivateFile {
  const selected = {...request};
  check(selected.kind === "orphan");
  const path = validateWindowsPath(selected.path, port.root).canonical;
  check(path === selected.path && fold(path) !== fold(port.root));
  const current = () => { sync(port.current); sync(selected.assertCurrent); };
  current();
  const ancestors = ancestorIdentities(path, port);
  return port.withDirectories(ancestors, () => {
    const file = port.inspectFile(path, 256 * 1024 * 1024);
    check(file.path === path);
    current();
    for (const identity of ancestors)
      check(canonical(port.directory(identity.canonicalPath)) === canonical(identity));
    const again = port.inspectFile(path, 256 * 1024 * 1024);
    check(canonical(again) === canonical(file));
    current();
    return Object.freeze({...file});
  });
}
