import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { TransferMaintenanceEntry, TransferMaintenanceView } from "../shared/sync-management";
import { BlobTransferJournal } from "./blob-transfer-journal";
import { inspectWorkspaceTransferBudget } from "./blob-transfer-budget";
import { pinPrivateRoot } from "./m3-private-root";
import { requireCondition, SyncError } from "./protocol";

const HASH = /^[a-f0-9]{64}$/;
const JOURNAL = /^(download|upload)-[a-f0-9]{64}$/;
const CURSOR = /^[a-f0-9]{64}\/(download|upload)-[a-f0-9]{64}\/([a-f0-9]{64}|!|~)$/;
const META = new Set(["state.sqlite", "state.sqlite-journal", "state.sqlite-wal", "state.sqlite-shm"]);
const ROOT_META = /^(\.folio-upload-lock|cache-maintenance)\.sqlite(-journal|-shm|-wal)?$/;
function optional(path: string) {
  try {return lstatSync(path);} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e;}
}
function names(path: string, limit = 4096): string[] {
  const handle = opendirSync(path), result: string[] = [];
  try {for (let entry; (entry = handle.readSync());) {
    requireCondition(result.length < limit, "cache-inventory-limit", 409); result.push(entry.name);
  }} finally {handle.closeSync();}
  return result.sort();
}
/** Caller serializes this with product transfers using the global cache mutex.
 * Existing SQLite journals may recover their own interrupted transaction. */
export function inspectTransferCacheCatalog(workspaceDirectory: string, currentScopeHash: string | null, cursor?: string): TransferMaintenanceView {
  requireCondition(!cursor || CURSOR.test(cursor), "cache-inventory-cursor", 409);
  requireCondition(currentScopeHash === null || HASH.test(currentScopeHash), "cache-inventory-scope", 409);
  const workspace = realpathSync(workspaceDirectory), root = join(workspace, ".folio-sync-transfers");
  const view: TransferMaintenanceView = {entries: [], nextCursor: null, usedBytes: 0, overLimit: false, held: null};
  if (!optional(root)) return view;
  pinPrivateRoot(root);
  try {const budget = inspectWorkspaceTransferBudget(workspace); view.usedBytes = budget.bytes; view.overLimit = budget.overLimit;}
  catch {view.held = "unsafe-cache-entry";}
  let opened = 0;
  const push = (entry: TransferMaintenanceEntry) => {
    if (cursor && entry.entryId <= cursor) return;
    if (view.entries.length < 50) view.entries.push(entry);
  };
  for (const scopeHash of names(root)) {
    if (ROOT_META.test(scopeHash)) continue;
    if (!HASH.test(scopeHash)) {view.held ??= "unknown-root-entry"; continue;}
    const scope = join(root, scopeHash);
    try {pinPrivateRoot(scope);} catch {view.held ??= "unsafe-scope"; continue;}
    let journals: string[];
    try {journals = names(scope);} catch {view.held ??= "inventory-limit"; continue;}
    for (const journalName of journals) {
      if (!JOURNAL.test(journalName)) {view.held ??= "unknown-scope-entry"; continue;}
      const base = scopeHash + "/" + journalName + "/";
      if (cursor && base + "~" <= cursor) continue;
      if (++opened > 32) {view.nextCursor = view.entries.at(-1)?.entryId ?? view.nextCursor ?? base + "!"; return view;}
      const path = join(scope, journalName), currentScope = scopeHash === currentScopeHash;
      let journal: BlobTransferJournal | undefined;
      try {
        pinPrivateRoot(path);
        const listed = names(path, 2048);
        for (const name of META) {
          const stat = optional(join(path, name));
          requireCondition(!stat || (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
            stat.uid === process.getuid?.() && stat.size <= 32 * 1024 * 1024), "cache-inventory-unsafe", 409);
        }
        const database = optional(join(path, "state.sqlite"));
        requireCondition(database && database.size > 0 && database.size <= 16 * 1024 * 1024, "cache-inventory-unsafe", 409);
        journal = new BlobTransferJournal(path, {scopeHash});
        const records = journal.inventory().sort((a, b) => a.key.localeCompare(b.key));
        const known = new Set([...META, ...records.map(record => record.partialName)]);
        const unknown = listed.some(name => !known.has(name));
        if (records.length === 0) push({entryId: base + "!", scopeHash, assetId: null,
          bytes: database.size, offset: 0, state: "empty-scope", currentScope,
          canRelease: !currentScope && !unknown, reason: unknown ? "unknown-cache-files" : currentScope ? "current-scope" : null});
        for (const record of records) {
          const part = optional(join(path, record.partialName));
          const safe = !part || (part.isFile() && !part.isSymbolicLink() && part.nlink === 1 && part.size <= 20_000_000 && part.uid === process.getuid?.());
          push({entryId: base + record.key, scopeHash, assetId: record.assetId,
            bytes: part && safe ? part.size : 0, offset: record.offset, state: record.state, currentScope,
            canRelease: safe && record.state !== "releasing", reason: !safe ? "unsafe-partial" : record.reason,
            ...(record.state === "releasing" && record.reason ? {operationId: record.reason} : {})});
          if (view.entries.length >= 50) {view.nextCursor = view.entries.at(-1)!.entryId; return view;}
        }
        if (unknown) {view.held ??= "unknown-cache-files";
          push({entryId: base + "~", scopeHash, assetId: null, bytes: 0, offset: 0, state: "unknown", currentScope,
            canRelease: false, reason: "unknown-cache-files"});}
      } catch {
        view.held ??= "journal-unavailable";
        push({entryId: base + "~", scopeHash, assetId: null, bytes: 0, offset: 0, state: "unknown", currentScope,
          canRelease: false, reason: "journal-unavailable"});
      } finally {journal?.close();}
      if (view.entries.length >= 50) {view.nextCursor = view.entries.at(-1)!.entryId; return view;}
      // An empty page still advances past scanned journals.
      if (!view.entries.length) view.nextCursor = base + "~";
    }
  }
  view.nextCursor = null;
  return view;
}
