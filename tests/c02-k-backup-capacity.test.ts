import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createC02Fixture } from "./fixtures/c02-k-backup-fixture";
import { WorkspaceBackupService } from "../src/main/workspace-backup-service";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import type { NativePrivateFilesystemPort } from "../src/platform/private-persistence";
import { getKCapacityRefusal, getKMutationFailure, getKReserveFailure } from "../src/platform/private-mutation-diagnostic";

type Any = Record<string, any>;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const TABLES = ["identity", "attempts", "blobs", "terminals", "reservation_releases", "resolutions"] as const;
const ORDER: Record<string, string> = { identity: "binding", attempts: "id", blobs: "id,kind", terminals: "id", reservation_releases: "id", resolutions: "id" };
const keyOf = (t: string, r: Any) => t === "blobs" ? `${r.id}|${r.kind}` : t === "identity" ? r.binding : r.id;
const ALLOWED = new Set(["marker", "snapshot:empty-destination", "snapshot:rootintent", "snapshot:prove-sync", "copy", "manifest", "marker-unlink", "filler"]);

function walk(root: string, dir = root, out: Any[] = []): Any[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name), rel = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) out.push({ path: rel, kind: "symlink" });
    else if (entry.isDirectory()) { out.push({ path: rel + "/", kind: "directory" }); walk(root, path, out); }
    else { const bytes = readFileSync(path); out.push({ path: rel, kind: "file", bytes: bytes.length, sha256: sha(bytes) }); }
  }
  return out;
}
function describeError(error: unknown, depth = 0): Any {
  if (depth > 8) return { truncated: true };
  if (!(error instanceof Error) && (typeof error !== "object" || error === null)) return { value: String(error) };
  const e = error as Any, out: Any = { name: e.name, message: e.message, state: e.state, code: e.code };
  if (Array.isArray(e.errors)) out.errors = e.errors.map((x: unknown) => describeError(x, depth + 1));
  if (e.cause !== undefined) out.cause = describeError(e.cause, depth + 1);
  return out;
}
function totals(path: string): Any {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const r = db.prepare("SELECT (SELECT count(*) FROM attempts) AS attempts,(SELECT count(*) FROM blobs) AS blobs,(SELECT coalesce(sum(length(bytes)),0) FROM blobs) AS blobBytes,(SELECT count(*) FROM terminals) AS terminals,(SELECT count(*) FROM reservation_releases) AS releases,(SELECT count(*) FROM resolutions) AS resolutions").get() as Any;
    return { attempts: Number(r.attempts), blobs: Number(r.blobs), blobBytes: Number(r.blobBytes), terminals: Number(r.terminals), releases: Number(r.releases), resolutions: Number(r.resolutions) };
  } finally { db.close(); }
}
function snapshot(path: string): Any {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables: Any = {};
    for (const table of TABLES) tables[table] = (db.prepare(`SELECT * FROM ${table} ORDER BY ${ORDER[table]}`).all() as Any[]).map(row => {
      const out: Any = {};
      for (const [k, v] of Object.entries(row)) if (v instanceof Uint8Array) { out[k] = v.length; out.base64 = Buffer.from(v).toString("base64"); out.sha256 = sha(v); } else out[k] = v;
      return out;
    });
    const counts = Object.fromEntries(TABLES.map(t => [t, tables[t].length]));
    return { counts, digest: sha(JSON.stringify({ counts, tables })), tables, accounting: accounting(tables) };
  } finally { db.close(); }
}
function accounting(tables: Any): Any {
  const blobs = new Map<string, Any[]>(), releases = new Map<string, Any>(), terminals = new Map<string, Any>();
  for (const b of tables.blobs) { const list = blobs.get(b.id) ?? []; list.push(b); blobs.set(b.id, list); }
  for (const r of tables.reservation_releases) releases.set(r.id, r);
  for (const t of tables.terminals) terminals.set(t.id, t);
  const per: Any[] = []; let retained = 0, charged = 0, unreleasedCount = 0, unreleasedBytes = 0, metadataBytes = 0, terminalBytes = 0, resolutionBytes = 0;
  for (const a of tables.attempts) {
    const bs = blobs.get(a.id) ?? [], wire = bs.find(b => b.kind === "wire"), original = bs.find(b => b.kind === "original"), origin = bs.find(b => b.kind === "origin:scope");
    const budget = Number(a.budget), A = bs.reduce((s, b) => s + b.bytes, 0), release = releases.get(a.id), unused = release ? Number(release.unused) : 0;
    const terminal = terminals.get(a.id), receipt = terminal?.receipt, maxCapture = Number(JSON.parse(String(a.metadata)).maxCaptureBytes);
    const expected = (wire?.bytes ?? -1) + (original?.bytes ?? -1) + 2 * maxCapture + 4096 + (origin?.bytes ?? 0);
    const releaseOK = terminal?.state === "APPLIED" ? !!release && Number(release.unused) === budget - A && release.receipt_sha === sha(String(receipt)) : true;
    retained += A; charged += budget - unused; if (!release) { unreleasedCount++; unreleasedBytes += budget; }
    metadataBytes += Buffer.byteLength(String(a.metadata)); if (receipt !== undefined) terminalBytes += Buffer.byteLength(String(receipt));
    per.push({ id: a.id, budget, retained: A, unused, charged: budget - unused, terminal: terminal?.state ?? null, release: release ? { unused: Number(release.unused), receipt_sha: release.receipt_sha } : null, budgetExpected: expected, budgetOK: expected === budget, releaseOK, blobBytes: Object.fromEntries(bs.map(b => [b.kind, b.bytes])) });
  }
  for (const r of tables.resolutions) resolutionBytes += Buffer.byteLength(String(r.receipt));
  const binding = tables.identity[0] ? Buffer.byteLength(String(tables.identity[0].binding)) : 0;
  const originBytes = tables.blobs.filter((b: Any) => b.kind === "origin:scope").reduce((s: number, b: Any) => s + b.bytes, 0);
  return { perAttempt: per, totals: { attempts: tables.attempts.length, blobs: tables.blobs.length, retainedBytes: retained, charged, unreleasedCount, unreleasedBytes }, texts: { metadataBytes, terminalBytes, resolutionBytes }, admission: { bindingBytes: binding, originBlobBytes: originBytes, perAttempt: 204800, cap: 8388608, candidate40: binding + 40 * 204800, candidate41: binding + 41 * 204800, envelopeBytes: binding + tables.attempts.length * 204800 + originBytes }, budgetOK: per.every(p => p.budgetOK), releaseOK: per.every(p => p.releaseOK) };
}
function headerOf(base64: string): Any {
  const bytes = Buffer.from(base64, "base64"), n = bytes.readUInt32LE(0);
  return JSON.parse(bytes.subarray(4, 4 + n).toString("ascii"));
}
function classify(h: Any): string {
  const p = String(h.path ?? "").replace(/\\/g, "/");
  if (h.operation === "copy-new") return "copy";
  if (h.operation === "prove-sync") return "snapshot:prove-sync";
  if (h.operation === "unlink-exact") return p.endsWith("/FOLIO-RECOVERY-INCOMPLETE") ? "marker-unlink" : "unlink-exact";
  if (h.operation === "write-new") {
    if (p.endsWith("/FOLIO-RECOVERY-INCOMPLETE")) return "marker";
    if (p.endsWith("/manifest.json")) return "manifest";
    if (p.includes("/.folio-sqlite-intent-")) return "snapshot:rootintent";
    if (p.endsWith("/workspace.sqlite")) return "snapshot:empty-destination";
    if (p.includes("/changes/")) return "filler";
  }
  return String(h.operation ?? "unknown");
}
function classifyCounts(snap: Any): Any {
  const counts: Any = {};
  for (const row of snap.tables.attempts) {
    const wire = snap.tables.blobs.find((b: Any) => b.id === row.id && b.kind === "wire");
    const c = wire ? classify(headerOf(wire.base64)) : "missing-wire";
    counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
}
function subset(before: Any, after: Any): Any {
  const tables: Any = {}; let ok = true;
  for (const table of TABLES) {
    const map = new Map(after[table].map((row: Any) => [keyOf(table, row), JSON.stringify(row)]));
    let changed = 0;
    for (const row of before[table]) if (map.get(keyOf(table, row)) !== JSON.stringify(row)) changed++;
    tables[table] = { before: before[table].length, unchanged: before[table].length - changed, changed };
    if (changed) ok = false;
  }
  return { ok, tables };
}
function sourceState(f: Any): Any {
  const main = (f.db.prepare("PRAGMA database_list").all() as Any[]).find(row => row.name === "main");
  if (!main || typeof main.file !== "string") throw new Error("main database path unavailable");
  const dbPath = String(main.file), dbBytes = readFileSync(dbPath);
  const assets = (f.db.prepare("SELECT id,metadata FROM assets ORDER BY id").all() as Any[]).map(row => {
    const metadata = JSON.parse(row.metadata), bytes = readFileSync(join(f.assets, row.id));
    return { id: row.id, registeredSize: metadata.size, registeredSha256: metadata.sha256, bytes: bytes.length, sha256: sha(bytes) };
  });
  return { dbPath, dbBytes: dbBytes.length, dbSha256: sha(dbBytes), journalMode: f.db.prepare("PRAGMA journal_mode").get().journal_mode, isTransaction: f.db.isTransaction, pageCount: Number(f.db.prepare("PRAGMA page_count").get().page_count), userVersion: Number(f.db.prepare("PRAGMA user_version").get().user_version), pages: f.db.prepare("SELECT * FROM pages ORDER BY id").all(), assets, assetTree: walk(f.assets) };
}
function phaseMap(spans: Any[], events: Any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const span of spans) for (let i = span.eventStart; i < span.eventEnd; i++) {
    const e = events[i];
    if (e?.phase === "reserve" && e.ok === true && typeof e.attemptId === "string") map.set(e.attemptId, span.name);
  }
  return map;
}
function writeEvidence(result: Any, trace: Any[]): void {
  const directory = process.env.FOLIO_C02_EVIDENCE_DIR;
  if (!directory) throw new Error("FOLIO_C02_EVIDENCE_DIR is required");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("FOLIO_C02_EVIDENCE_DIR must be a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("FOLIO_C02_EVIDENCE_DIR is not owned by the test user");
  const canonical = realpathSync(directory);
  writeFileSync(join(canonical, "result.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(canonical, "trace.jsonl"), trace.map(line => JSON.stringify(line)).join("\n") + "\n");
}

describe("C02 K backup metadata capacity (contract-only POSIX relabelled Windows; NOT_RUN on Windows)", () => {
  it("measures real VACUUM backup success then candidate-41 metadata-capacity failure before helper dispatch", () => {
    const f = createC02Fixture(), trace: Any[] = [], ops: Any[] = [], spans: Any[] = [], fillers: Any[] = [];
    const journalPath = join(f.state, "private-persistence-v1.sqlite");
    let currentPhase = "setup", primary: unknown, evidenceError: unknown, cleanupError: unknown;
    const evidence: Any = {
      probe: "c02-k-backup-capacity", contractOnly: true, platform: process.platform, profile: f.profile,
      fixture: { root: f.root, data: f.data, workspace: f.workspace, assets: f.assets, state: f.state, journalPath, binding: "c02-k-backup-fixture-v1", originProvider: "absent" },
      configuration: { caller: "WorkspaceBackupService.create -> createFullBackup (real)", service: "WorkspaceBackupService", firstPrefix: "c02-success", secondPrefix: "c02-failure", sourceDirectory: f.workspace, native: "actual K factory with injected contract executor; real WindowsPrivatePersistenceJournal; real SQLite VACUUM INTO", injection: "pass-through observer around f.native only" },
      phases: {}, fillers, comparisons: {}, outerOps: ops, events: f.events, phaseSpans: spans, temp: { kept: true, root: f.root },
      notes: {
        origin: "originProvider ABSENT; product-native origin/hooks/global-fence wiring is SOURCE_ONLY and no-origin bytes are not production parity.",
        profileLimit: "Measured N=2 only. General source profile is N+6 (marker, 3 snapshot attempts, N copies, manifest, marker unlink); N+3 omits the 3 snapshot attempts. 61/62 assets, 20MB assets and other profiles NOT_MEASURED.",
        notRun: "GUI, real Windows, physical media/durability NOT_RUN; certification Lv3.",
        coverage: "Setup allocation-failure coverage is not claimed. No fixture changes beyond the two reported corrections."
      }
    };
    const safeTotals = () => { try { return { ok: true, ...totals(journalPath) }; } catch (error) { return { ok: false, error: describeError(error) }; } };
    const observe = <T>(op: string, path: string, destination: string | undefined, call: () => T, summarize: (value: T) => unknown): T => {
      const eventStart = f.events.length, attemptBefore = safeTotals();
      try {
        const value = call();
        ops.push({ op, label: currentPhase, path, destination, eventStart, eventEnd: f.events.length, attemptBefore, attemptAfter: safeTotals(), result: summarize(value) });
        return value;
      } catch (error) {
        ops.push({ op, label: currentPhase, path, destination, eventStart, eventEnd: f.events.length, attemptBefore, attemptAfter: safeTotals(), error: describeError(error) });
        throw error;
      }
    };
    const identity = (v: Any) => v && { path: v.path, fileId: v.fileId, volumeId: v.volumeId };
    const receipt = (v: Any) => v && { profile: v.profile, scope: v.scope, identity: identity(v.identity), bytes: v.identity?.bytes, sha256: v.identity?.sha256 };
    const observed: NativePrivateFilesystemPort = {
      platform: "win32", version: 1, synchronous: true,
      inspectDirectory: path => observe("inspectDirectory", path, undefined, () => f.native.inspectDirectory(path), v => identity(v as Any)),
      inspectFile: (path, max) => observe("inspectFile", path, undefined, () => f.native.inspectFile(path, max), v => receipt(v as Any)),
      inspectFileIdentity: path => observe("inspectFileIdentity", path, undefined, () => f.native.inspectFileIdentity(path), v => identity(v as Any)),
      read: (path, expected, max) => observe("read", path, undefined, () => f.native.read(path, expected, max), v => ({ bytes: v.length, sha256: sha(v) })),
      writeNew: (path, bytes, max) => observe("writeNew", path, undefined, () => f.native.writeNew(path, bytes, max), v => receipt(v as Any)),
      copyNew: (source, destination, expected, max) => observe("copyNew", source, destination, () => f.native.copyNew(source, destination, expected, max), v => receipt(v as Any)),
      renameNew: (source, destination, expected, max) => observe("renameNew", source, destination, () => f.native.renameNew(source, destination, expected, max), v => receipt(v as Any)),
      unlinkExact: (path, expected, max) => observe("unlinkExact", path, undefined, () => f.native.unlinkExact(path, expected, max), () => null),
      proveSync: (path, expected) => observe("proveSync", path, undefined, () => f.native.proveSync(path, expected), v => receipt(v as Any)),
      createDirectory: path => observe("createDirectory", path, undefined, () => f.native.createDirectory(path), v => identity(v as Any)),
      snapshotSqlite: (db, destination) => observe("snapshotSqlite", "source", destination, () => f.native.snapshotSqlite(db, destination), v => receipt(v as Any)),
      acquireSqliteLease: (path, expected) => observe("acquireSqliteLease", path, undefined, () => f.native.acquireSqliteLease!(path, expected), () => ({ lease: true }))
    };
    const phase = <T>(name: string, call: () => T): T => {
      const eventStart = f.events.length, opStart = ops.length, attemptBefore = safeTotals();
      currentPhase = name;
      try { const value = call(); spans.push({ name, eventStart, eventEnd: f.events.length, opStart, opEnd: ops.length, attemptBefore, attemptAfter: safeTotals(), ok: true }); return value; }
      catch (error) { spans.push({ name, eventStart, eventEnd: f.events.length, opStart, opEnd: ops.length, attemptBefore, attemptAfter: safeTotals(), ok: false, error: describeError(error) }); throw error; }
      finally { currentPhase = "setup"; }
    };
    const phaseView = (s: Any) => ({ counts: s.counts, digest: s.digest, accounting: s.accounting });
    const sidecar = (suffix: string): Any => { try { return { bytes: lstatSync(journalPath + suffix).size }; } catch (error: any) { if (error?.code === "ENOENT") return { absent: true }; throw error; } };
    try {
      const service = new WorkspaceBackupService(f.db, f.workspace, {}, { nativePrivateFilesystem: observed });
      const sourceBefore = sourceState(f), before = snapshot(journalPath);
      evidence.sourceBefore = sourceBefore; evidence.phases.before = phaseView(before);
      expect(before.counts).toEqual({ identity: 1, attempts: 0, blobs: 0, terminals: 0, reservation_releases: 0, resolutions: 0 });
      const first = phase("backup-success", () => service.create("c02-success"));
      const firstVerified = verifyFullBackup(first.directory);
      expect(firstVerified.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      const firstOutput = { directory: first.directory, bytes: first.bytes, inventory: first.inventory, verifiedFingerprint: firstVerified.fingerprint, tree: walk(first.directory) };
      evidence.firstOutput = firstOutput;
      const success = snapshot(journalPath);
      evidence.phases.success = phaseView(success); evidence.successfulCounts = classifyCounts(success);
      expect(classifyCounts(success)).toEqual({ marker: 1, "snapshot:empty-destination": 1, "snapshot:rootintent": 1, "snapshot:prove-sync": 1, copy: 2, manifest: 1, "marker-unlink": 1 });
      expect(success.counts).toMatchObject({ attempts: 8, blobs: 40, terminals: 8, reservation_releases: 8, resolutions: 0 });
      expect(success.accounting.budgetOK).toBe(true); expect(success.accounting.releaseOK).toBe(true);
      phase("changes-directory", () => observed.createDirectory(join(f.data, "changes")));
      const changes = join(f.data, "changes");
      for (let i = 0; i < 31; i++) {
        const path = join(changes, `filler-${String(i).padStart(2, "0")}.bin`);
        const value = phase(`filler-${i}`, () => observed.writeNew(path, Buffer.from(`c02-filler-${i}`), 4096));
        const last = ops[ops.length - 1];
        const rowDelta = last.attemptBefore.ok && last.attemptAfter.ok ? last.attemptAfter.attempts - last.attemptBefore.attempts : null;
        const blobDelta = last.attemptBefore.ok && last.attemptAfter.ok ? last.attemptAfter.blobBytes - last.attemptBefore.blobBytes : null;
        fillers.push({ index: i, path, bytes: value.identity.bytes, sha256: value.identity.sha256, attemptBefore: last.attemptBefore, attemptAfter: last.attemptAfter, rowDelta, blobBytesDelta: blobDelta, eventStart: last.eventStart, eventEnd: last.eventEnd });
      }
      expect(totals(journalPath).attempts).toBe(39);
      const preFailure = snapshot(journalPath), sourceBeforeFailure = sourceState(f), firstOutputBeforeFailure = walk(first.directory);
      const intentsBefore = readdirSync(f.data).filter(n => n.startsWith(".folio-sqlite-intent-")).sort();
      const backupsBefore = readdirSync(join(f.workspace, "backups")).sort();
      evidence.phases.afterFillers = phaseView(preFailure);
      evidence.preFailure = { source: sourceBeforeFailure, firstOutputTree: firstOutputBeforeFailure, intentFiles: intentsBefore, backups: backupsBefore };
      expect(preFailure.counts.attempts).toBe(39); expect(classifyCounts(preFailure).filler).toBe(31);
      expect(sourceBeforeFailure.dbSha256).toBe(sourceBefore.dbSha256); expect(sourceBeforeFailure.assets).toEqual(sourceBefore.assets);
      expect(firstOutputBeforeFailure).toEqual(firstOutput.tree);
      let failure: unknown;
      try { phase("backup-failure", () => service.create("c02-failure")); } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      const afterFailure = snapshot(journalPath), afterFailureView = phaseView(afterFailure);
      evidence.phases.afterFailure = afterFailureView;
      expect(afterFailure.counts).toEqual({ identity: 1, attempts: 40, blobs: 200, terminals: 40, reservation_releases: 40, resolutions: 0 });
      expect(classifyCounts(afterFailure)).toEqual({ marker: 2, "snapshot:empty-destination": 1, "snapshot:rootintent": 1, "snapshot:prove-sync": 1, copy: 2, manifest: 1, "marker-unlink": 1, filler: 31 });
      expect(afterFailure.tables.terminals.every((t: Any) => t.state === "APPLIED")).toBe(true);
      expect(afterFailure.tables.terminals.some((t: Any) => t.state === "UNKNOWN")).toBe(false);
      const priorIds = new Set(preFailure.tables.attempts.map((r: Any) => r.id));
      const added = afterFailure.tables.attempts.filter((r: Any) => !priorIds.has(r.id));
      expect(added).toHaveLength(1);
      const addedWire = afterFailure.tables.blobs.find((b: Any) => b.id === added[0].id && b.kind === "wire");
      expect(classify(headerOf(addedWire.base64))).toBe("marker");
      const reserveEvents = f.events.filter(e => e.phase === "reserve"), failedReserves = reserveEvents.filter(e => e.ok === false);
      const attemptedIds = new Set(afterFailure.tables.attempts.map((r: Any) => r.id));
      expect(failedReserves).toHaveLength(1);
      const failedRequestId = String(failedReserves[0].attemptId);
      expect(attemptedIds.has(failedRequestId)).toBe(false);
      const capacityRefusal = getKCapacityRefusal((failure as Any).cause);
      const reserveFailure = getKReserveFailure(failure);
      expect(reserveFailure?.attemptId).toBe(failedRequestId);
      expect(reserveFailure?.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(reserveFailure?.capacityRefusal).toBe(capacityRefusal);
      expect(reserveFailure?.capacityRefusal?.attemptId).toBe(failedRequestId);
      expect(reserveFailure?.capacityRefusal?.sourceCauseCodes).toEqual(["PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY"]);
      expect(getKCapacityRefusal(failure)).toBeUndefined();
      expect(Object.isFrozen(reserveFailure)).toBe(true);
      expect(Object.isFrozen(reserveFailure?.sourceOutcome)).toBe(true);
      expect(Object.isFrozen(capacityRefusal)).toBe(true);
      const mutationFailure = getKMutationFailure(failure);
      expect(mutationFailure).toBeDefined();
      expect(mutationFailure?.attemptId).toBe(failedRequestId);
      expect(mutationFailure?.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(mutationFailure?.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(mutationFailure?.capacityRefusal).toBe(capacityRefusal);
      expect(mutationFailure?.uncertainty).toBeUndefined();
      expect(Object.isFrozen(mutationFailure)).toBe(true);
      expect(reserveEvents.filter(e => e.ok === true)).toHaveLength(40);
      expect(reserveEvents).toHaveLength(41);
      const mutating = new Set(["write-new", "copy-new", "unlink-exact", "prove-sync", "rename-new", "rename-directory-new"]);
      const execMutations = f.events.filter(e => e.phase === "exec" && mutating.has(String(e.operation))).length;
      const execReads = f.events.filter(e => e.phase === "exec" && !mutating.has(String(e.operation))).length;
      expect(execMutations).toBe(40); expect(execReads).toBeGreaterThan(0);
      const dirsAfter = readdirSync(join(f.workspace, "backups")).sort(), newDir = dirsAfter.find(name => !backupsBefore.includes(name));
      expect(newDir).toBeDefined();
      const failDir = join(f.workspace, "backups", newDir!), failTree = walk(failDir);
      const createOp = ops.find(o => o.op === "createDirectory" && o.label === "backup-failure");
      expect(createOp?.path).toBe(failDir);
      expect(failTree.some(e => e.path === "FOLIO-RECOVERY-INCOMPLETE")).toBe(true);
      expect(failTree.some(e => /workspace\.sqlite|manifest\.json|assets\//.test(e.path))).toBe(false);
      const chain = describeError(failure), flat: string[] = [];
      (function collect(e: Any) { if (!e) return; if (typeof e.message === "string") flat.push(e.message); for (const x of e.errors ?? []) collect(x); if (e.cause) collect(e.cause); })(chain);
      expect((failure as Any)?.name).toBe("NativePrivatePersistenceError");
      expect((failure as Any)?.state).toBe("UNKNOWN");
      expect(String((failure as Any)?.message)).toContain("UNKNOWN:RESERVE");
      expect(flat.some(m => m.includes("METADATA_CAPACITY"))).toBe(true);
      const sourceAfterFailure = sourceState(f), firstOutputAfterFailure = walk(first.directory);
      const intentsAfter = readdirSync(f.data).filter(n => n.startsWith(".folio-sqlite-intent-")).sort();
      expect(sourceAfterFailure.dbSha256).toBe(sourceBefore.dbSha256); expect(sourceAfterFailure.assets).toEqual(sourceBefore.assets);
      expect(firstOutputAfterFailure).toEqual(firstOutput.tree); expect(intentsAfter).toEqual(intentsBefore);
      expect(verifyFullBackup(first.directory).fingerprint).toBe(firstVerified.fingerprint);
      const a = afterFailure.accounting;
      expect(a.totals).toMatchObject({ attempts: 40, blobs: 200, unreleasedCount: 0, unreleasedBytes: 0 });
      expect(a.budgetOK).toBe(true); expect(a.releaseOK).toBe(true);
      expect(a.totals.charged).toBe(a.totals.retainedBytes);
      expect(a.admission.candidate40).toBeLessThanOrEqual(8388608);
      expect(a.admission.candidate41).toBeGreaterThan(8388608);
      const successSubset = subset(success.tables, afterFailure.tables), preSubset = subset(preFailure.tables, afterFailure.tables);
      expect(successSubset.ok).toBe(true); expect(preSubset.ok).toBe(true);
      evidence.failure = { errorChain: chain, direct: describeError(failure), failedReserve: failedReserves[0], reserveCalls: reserveEvents.length, successfulReserves: 40, mutatingExec: execMutations, readExec: execReads, directory: failDir, tree: failTree, candidateAttemptId: failedRequestId, candidatePersisted: attemptedIds.has(failedRequestId), candidateCharged: false };
      evidence.afterFailure = { source: sourceAfterFailure, sourceUnchanged: sourceAfterFailure.dbSha256 === sourceBefore.dbSha256, firstOutputUnchanged: JSON.stringify(firstOutputAfterFailure) === JSON.stringify(firstOutput.tree), newIntentFiles: intentsAfter.filter(n => !intentsBefore.includes(n)), addedAttempts: added.length, unknownTerminals: 0 };
      f.closeJournal(); f.reopenJournal();
      const afterReopen = snapshot(journalPath), reopenSubset = subset(afterFailure.tables, afterReopen.tables);
      expect(afterReopen.digest).toBe(afterFailure.digest); expect(reopenSubset.ok).toBe(true);
      evidence.phases.afterReopen = phaseView(afterReopen);
      evidence.comparisons = { successSubsetOfAfterFailure: successSubset, preFailureSubsetOfAfterFailure: preSubset, afterFailureSubsetOfReopen: reopenSubset };
      const phaseByName = phaseMap(spans, f.events);
      const finalAttempts: Any[] = afterReopen.tables.attempts.map((row: Any) => {
        const blobs = afterReopen.tables.blobs.filter((b: Any) => b.id === row.id), wire = blobs.find((b: Any) => b.kind === "wire");
        const header = wire ? headerOf(wire.base64) : {};
        return { id: row.id, phase: phaseByName.get(row.id) ?? null, classification: classify(header), header, target: row.target, budget: Number(row.budget), metadata: row.metadata, blobs: blobs.map((b: Any) => ({ kind: b.kind, bytes: b.bytes, sha256: b.sha256 })), ...afterReopen.accounting.perAttempt.find((p: Any) => p.id === row.id) };
      });
      expect(finalAttempts.every(x => ALLOWED.has(x.classification))).toBe(true);
      expect(finalAttempts.filter(x => x.phase === "backup-success")).toHaveLength(8);
      expect(finalAttempts.filter(x => x.phase === "backup-failure")).toHaveLength(1);
      expect(finalAttempts.filter(x => typeof x.phase === "string" && x.phase.startsWith("filler-"))).toHaveLength(31);
      const zeroOps = ["inspectDirectory", "inspectFile", "inspectFileIdentity", "read", "createDirectory", "acquireSqliteLease"];
      expect(ops.filter(o => zeroOps.includes(o.op) && o.attemptBefore.ok && o.attemptAfter.ok && o.attemptBefore.attempts !== o.attemptAfter.attempts)).toEqual([]);
      const snapshotOps = ops.filter(o => o.op === "snapshotSqlite" && o.attemptBefore.ok && o.attemptAfter.ok);
      const snapshotSuccess = snapshotOps.filter(o => !o.error && o.label !== "backup-failure");
      const snapshotFailure = snapshotOps.filter(o => !!o.error || o.label === "backup-failure");
      expect(snapshotSuccess).toHaveLength(1);
      expect(snapshotFailure).toHaveLength(1);
      expect(snapshotSuccess[0].attemptAfter.attempts - snapshotSuccess[0].attemptBefore.attempts).toBe(3);
      expect(snapshotFailure[0].attemptAfter.attempts - snapshotFailure[0].attemptBefore.attempts).toBe(0);
      const successPhaseSnapshots = finalAttempts.filter(x => x.phase === "backup-success" && x.classification.startsWith("snapshot:")).map(x => x.classification);
      expect(successPhaseSnapshots.sort()).toEqual(["snapshot:empty-destination", "snapshot:prove-sync", "snapshot:rootintent"]);
      evidence.limits = { maxAttempts: 64, perAttemptMetadata: 204800, metadataCap: 8388608, bindingBytes: a.admission.bindingBytes, candidate40: a.admission.candidate40, candidate41: a.admission.candidate41, note: "Metadata guard precedes the 64-attempt cap. N+3 omits snapshot attempts; source-general N+6 vs measured N=2 only. 61/62 assets, 20MB assets and other profiles NOT_MEASURED." };
      evidence.finalAttempts = finalAttempts; evidence.finalTables = afterReopen.tables;
      evidence.physical = { path: journalPath, mainBytes: lstatSync(journalPath).size, mainSha256: sha(readFileSync(journalPath)), journal: sidecar("-journal"), wal: sidecar("-wal"), shm: sidecar("-shm") };
      evidence.outcome = "completed"; evidence.completed = true;
    } catch (error) {
      primary = error; evidence.outcome = "threw"; evidence.fatal = describeError(error);
    } finally {
      try { f.closeJournal(); } catch (error) { cleanupError = error; evidence.journalCloseError = describeError(error); }
      try { f.closeStore(); } catch (error) { cleanupError ??= error; evidence.storeCloseError = describeError(error); }
      for (const op of ops) trace.push({ type: "outer", ...op });
      f.events.forEach((event, index) => trace.push({ type: "fixture", index, ...event }));
      evidence.completed = evidence.outcome === "completed" && cleanupError === undefined;
      try { writeEvidence(evidence, trace); } catch (error) { evidenceError = error; }
      const failures: unknown[] = [];
      if (evidence.outcome === "threw") failures.push(primary);
      if (cleanupError !== undefined) failures.push(cleanupError);
      if (evidenceError !== undefined) failures.push(evidenceError);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "C02 K backup capacity probe failed with multiple errors");
    }
  }, 60_000);
});
