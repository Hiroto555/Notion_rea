import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../../collaboration/runtime/canonical";
import { CollaborationError } from "../../collaboration/runtime/contract";
import { PrivateLedger } from "../../sync/private-ledger";
import type { PrivatePlatform } from "../../sync/private-platform";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";

export const WINDOWS_SOURCE_BINDINGS_DATABASE = "source-bindings.sqlite";
export type WindowsSourceIdentity = Readonly<{
  kind: "root" | "directory" | "file";
  canonicalPath: string;
  fileId: string;
  volumeId: string;
}>;
const ID = /^[a-fA-F0-9]{32}$/;
const VOLUME = /^[a-fA-F0-9]{16}$/;
function fail(code: string): never { throw new CollaborationError(`WINDOWS_SOURCE_BINDING_${code}`); }

function snapshot(value: WindowsSourceIdentity): WindowsSourceIdentity {
  const data = JSON.parse(canonical(value, 4096)) as WindowsSourceIdentity;
  if (!data || Object.keys(data).sort().join() !== "canonicalPath,fileId,kind,volumeId" ||
      !["root", "directory", "file"].includes(data.kind) || !ID.test(data.fileId) || !VOLUME.test(data.volumeId) ||
      typeof data.canonicalPath !== "string" || !/^[A-Z]:\\[\x20-\x7e]*$/.test(data.canonicalPath) || data.canonicalPath.length > 240)
    fail("IDENTITY");
  if (validateWindowsPath(data.canonicalPath, `${data.canonicalPath[0]}:\\`).canonical !== data.canonicalPath) fail("PATH");
  return Object.freeze({...data, canonicalPath: asciiCaseFold(data.canonicalPath), fileId: asciiCaseFold(data.fileId), volumeId: asciiCaseFold(data.volumeId)});
}
function recordKey(identity: WindowsSourceIdentity): string {
  return `source:${identity.kind}:${createHash("sha256").update(identity.canonicalPath).digest("hex")}`;
}
type Move = Readonly<{kind: "file" | "directory"; from: WindowsSourceIdentity; to: string; sha256: string; bytes: number}>;
type Investigation = Readonly<{attemptId: string; fingerprint: string; resolutionSha256: string}>;
type Event = Readonly<{type: "enroll"; identity: WindowsSourceIdentity; creation?: string; investigation?: Investigation}> |
  Readonly<{type: "move"; reservation: string; move: Move; evidence: string}>;
const EVENT_BYTES = 16 * 1024;
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\");
const beneath = (path: string, parent: string) => path === parent || path.startsWith(parent + "\\");

/** Independent private metadata, outside authority rollback/restore. A fresh
 * factory/process must compare these retained native IDs before opening a known
 * source. This is continuity relative to retained state, not protection against
 * an attacker replacing both the source and this entire trusted private store.
 * No reset, implicit rebind, deletion or UNKNOWN resolution is exposed here. */
export class WindowsSourceBindings {
  private readonly ledger: PrivateLedger;
  private failed: unknown;
  private unavailable = false;
  private transactionActive = false;
  constructor(directory: string, platform: PrivatePlatform, forbiddenRoots: readonly string[] = []) {
    if (platform.kind !== "windows") fail("NATIVE_PLATFORM_REQUIRED");
    this.ledger = new PrivateLedger(directory, WINDOWS_SOURCE_BINDINGS_DATABASE, "windows-source-bindings", forbiddenRoots, platform);
  }
  /** Enroll a previously unseen source only at an explicitly authorized create
   * boundary. Existing records are always compared, including at enrollment. */
  enroll(value: WindowsSourceIdentity): void { this.check(value, true); }
  assert(value: WindowsSourceIdentity): void { this.check(value, false); }
  /** Capacity is reserved durably BEFORE a namespace mutation. An incomplete
   * reservation remains a hold across restart; it is never automatically freed. */
  reserveMove(from: WindowsSourceIdentity, destination: string, sha256: string, bytes: number): string {
    const identity = snapshot(from);
    if (identity.kind === "root" || !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(bytes) || bytes < 0) fail("TRANSITION");
    const to = snapshot({...from, canonicalPath: destination}).canonicalPath;
    if (overlaps(identity.canonicalPath, to)) fail("TRANSITION");
    const move: Move = {kind: identity.kind, from: identity, to, sha256, bytes};
    const id = randomUUID().replace(/-/g, "");
    this.write(() => {
      const state = this.state();
      const prior = state.active.get(recordKey(identity));
      if (!prior || canonical(prior) !== canonical(identity)) fail("NOT_ENROLLED");
      if ([...state.active.values()].some(v => beneath(v.canonicalPath, to))) fail("DESTINATION_BOUND");
      for (const v of state.active.values()) if (beneath(v.canonicalPath, identity.canonicalPath) &&
        to.length + v.canonicalPath.length - identity.canonicalPath.length > 240) fail("PATH");
      if (state.pendingCreations.some(c => overlaps(c.value, identity.canonicalPath) || overlaps(c.value, to))) fail("TRANSITION_PENDING");
      for (const pending of state.pending) if ([pending.from.canonicalPath, pending.to].some(p =>
        overlaps(p, identity.canonicalPath) || overlaps(p, to))) fail("TRANSITION_PENDING");
      this.admit(3, EVENT_BYTES + 1024 + Buffer.byteLength(canonical(move)));
      this.ledger.write(`reservation:${id}`, canonical(move));
    });
    return id;
  }
  completeMove(reservation: string, destination: WindowsSourceIdentity, evidence: string, assertCurrent?: () => void): void {
    if (!/^[a-f0-9]{32}$/.test(reservation) || typeof evidence !== "string") fail("TRANSITION");
    const dest = snapshot(destination);
    this.write(() => {
      if (assertCurrent && (assertCurrent() as unknown) !== undefined) fail("PROOF_ACK");
      const raw = this.ledger.read(`reservation:${reservation}`);
      if (!raw) fail("TRANSITION");
      const move = JSON.parse(raw) as Move;
      if (dest.canonicalPath !== move.to || dest.fileId !== move.from.fileId ||
          dest.volumeId !== move.from.volumeId || dest.kind !== move.kind) fail("IDENTITY_CHANGED");
      const events = this.ledger.entries("event:", 4096);
      const event = canonical({type: "move", reservation, move, evidence});
      if (Buffer.byteLength(event) > EVENT_BYTES) fail("CAPACITY");
      const old = events.find(e => (JSON.parse(e.value) as Event).type === "move" &&
        (JSON.parse(e.value) as {reservation?: string}).reservation === reservation);
      if (old) { if (old.value !== event) fail("TRANSITION"); return; }
      this.ledger.write(`event:${String(events.length).padStart(8, "0")}`, event);
      this.state();
      if (assertCurrent && (assertCurrent() as unknown) !== undefined) fail("PROOF_ACK");
    });
  }
  /** A departed file name can be reused only by the producer of a successful
   * CREATE_NEW receipt after independently proving the retained file again. */
  enrollCreated(value: WindowsSourceIdentity, retainedProof: (identity: WindowsSourceIdentity, sha256: string, bytes: number) => void,
    creation?: string, investigation?: Readonly<{link: Investigation; assertCurrent(): void}>): void {
    const identity = snapshot(value);
    this.write(() => {
      if (investigation && (investigation.assertCurrent() as unknown) !== undefined) fail("PROOF_ACK");
      const state = this.state();
      const departed = state.departed.get(recordKey(identity));
      if (departed && !state.active.has(recordKey(identity))) {
        if (departed.kind !== "file") fail("REUSE");
        const retained = state.active.get(recordKey({...departed.from, canonicalPath: departed.to}));
        if (!retained || retained.fileId !== departed.from.fileId || retained.volumeId !== departed.from.volumeId) fail("REUSE");
        const outcome: unknown = retainedProof(retained, departed.sha256, departed.bytes);
        if (outcome !== undefined) fail("PROOF_ACK");
      }
      this.enrollInTransaction(identity, state, true, creation, investigation?.link);
      if (investigation && (investigation.assertCurrent() as unknown) !== undefined) fail("PROOF_ACK");
    });
  }
  /** Retained identities are continuity evidence, not a fresh native proof. */
  retainedIdentity(kind: WindowsSourceIdentity["kind"], path: string): WindowsSourceIdentity {
    if (this.unavailable) throw this.failed;
    const wanted = snapshot({kind, canonicalPath: path, fileId: "0".repeat(32), volumeId: "0".repeat(16)});
    const identity = this.state().active.get(recordKey(wanted));
    if (!identity) fail("NOT_ENROLLED");
    return {...identity, canonicalPath: path};
  }
  /** Bound after K's durable reserve and before native dispatch. This is an
   * immutable cross-database intent association, not a completion receipt. */
  associateTransition(reservation: string, attemptId: string, wireSha256: string): void {
    if (!/^[a-f0-9]{32}$/.test(reservation) || !/^[a-f0-9]{32}$/.test(attemptId) ||
        !/^[a-f0-9]{64}$/.test(wireSha256)) fail("ASSOCIATION");
    const body = canonical({attemptId, wireSha256});
    this.write(() => {
      if (!this.ledger.read(`creation:${reservation}`) && !this.ledger.read(`reservation:${reservation}`)) fail("ASSOCIATION");
      const prior = this.ledger.read(`association:${reservation}`);
      if (prior !== null) { if (prior !== body) fail("ASSOCIATION"); return; }
      // This step precedes native dispatch. Re-admit its own row while
      // preserving every outstanding completion reservation, including S1's.
      this.admit(1, 1024);
      this.ledger.write(`association:${reservation}`, body);
    });
  }
  transitionAssociation(reservation: string): Readonly<{attemptId: string; wireSha256: string}> | undefined {
    if (this.unavailable) throw this.failed;
    if (!/^[a-f0-9]{32}$/.test(reservation)) fail("ASSOCIATION");
    const body = this.ledger.read(`association:${reservation}`);
    if (body === null) return undefined;
    const value = JSON.parse(body);
    if (Object.keys(value).sort().join() !== "attemptId,wireSha256" ||
        !/^[a-f0-9]{32}$/.test(value.attemptId) || !/^[a-f0-9]{64}$/.test(value.wireSha256) ||
        canonical(value) !== body) fail("STORED");
    return value;
  }
  pendingTransitions(): Readonly<{
    creations: readonly Readonly<{reservation: string; path: string}>[];
    moves: readonly Readonly<{reservation: string; move: Move; identities: readonly WindowsSourceIdentity[]}>[];
  }> {
    if (this.unavailable) throw this.failed;
    const state = this.state();
    const completed = new Set(this.ledger.entries("event:", 4096).flatMap(row => {
      const event = JSON.parse(row.value) as Event;
      return event.type === "move" ? [event.reservation] : [];
    }));
    return {
      creations: state.pendingCreations.map(c => ({reservation: c.key.slice(9), path: c.value})),
      moves: this.ledger.entries("reservation:", 4096).flatMap(row => {
        const move = JSON.parse(row.value) as Move;
        if (completed.has(row.key.slice(12))) return [];
        return [{reservation: row.key.slice(12), move, identities: [...state.active.values()]
          .filter(v => v.kind !== "root" && beneath(v.canonicalPath, move.from.canonicalPath))
          .map(v => ({...v, canonicalPath: move.to + v.canonicalPath.slice(move.from.canonicalPath.length)}))}];
      }),
    };
  }
  hasInvestigation(link: Investigation): boolean {
    if (this.unavailable) throw this.failed;
    this.state();
    return this.ledger.entries("event:", 4096).some(row => {
      const event = JSON.parse(row.value) as Event;
      if (event.type === "enroll") return event.investigation !== undefined && canonical(event.investigation) === canonical(link);
      try { return canonical(JSON.parse(event.evidence)) === canonical(link); } catch { return false; }
    });
  }
  /** Batch admission is all-or-nothing; ordinary replacements remain forbidden. */
  enrollSelected(values: readonly WindowsSourceIdentity[], assertCurrent: () => void): void {
    const identities = values.map(snapshot);
    this.write(() => {
      if ((assertCurrent() as unknown) !== undefined) fail("PROOF_ACK");
      for (const identity of identities) this.enrollInTransaction(identity, this.state(), false);
      if ((assertCurrent() as unknown) !== undefined) fail("PROOF_ACK");
    });
  }
  private state() {
    if (!this.transactionActive) {
      return this.ledger.transaction(() => {
        this.transactionActive = true;
        try { return this.stateInTransaction(); } finally { this.transactionActive = false; }
      });
    }
    return this.stateInTransaction();
  }
  private stateInTransaction() {
    const active = new Map<string, WindowsSourceIdentity>();
    const departed = new Map<string, Move>();
    for (const row of this.ledger.entries("source:", 4096)) {
      const identity = JSON.parse(row.value) as WindowsSourceIdentity;
      if (recordKey(identity) !== row.key) fail("STORED");
      active.set(row.key, identity);
    }
    const completed = new Set<string>();
    const created = new Set<string>();
    for (const [index, row] of this.ledger.entries("event:", 4096).entries()) {
      if (row.key !== `event:${String(index).padStart(8, "0")}`) fail("STORED");
      const event = JSON.parse(row.value) as Event;
      if (event.type === "enroll") {
        if (event.creation) {
          if (created.has(event.creation) || this.ledger.read(`creation:${event.creation}`) !== event.identity.canonicalPath) fail("STORED");
          created.add(event.creation);
        }
        const prior = active.get(recordKey(event.identity));
        if (prior && canonical(prior) !== canonical(event.identity)) fail("STORED");
        active.set(recordKey(event.identity), event.identity);
      } else if (event.type === "move") {
        if (completed.has(event.reservation) ||
            this.ledger.read(`reservation:${event.reservation}`) !== canonical(event.move)) fail("STORED");
        const move = event.move;
        const prior = active.get(recordKey(move.from));
        if (!prior || canonical(prior) !== canonical(move.from)) fail("STORED");
        const moved = [...active.values()].filter(v => v.kind !== "root" &&
          (move.kind === "directory" ? beneath(v.canonicalPath, move.from.canonicalPath) : recordKey(v) === recordKey(move.from)));
        for (const value of moved) {
          active.delete(recordKey(value));
          const next = {...value, canonicalPath: move.to + value.canonicalPath.slice(move.from.canonicalPath.length)};
          if (active.has(recordKey(next))) fail("STORED");
          active.set(recordKey(next), next);
          departed.set(recordKey(value), {...move, from: value, to: next.canonicalPath});
        }
        completed.add(event.reservation);
      } else fail("STORED");
    }
    const pendingReservations = this.ledger.entries("reservation:", 4096)
      .filter(r => !completed.has(r.key.slice("reservation:".length)));
    const pending = pendingReservations.map(r => JSON.parse(r.value) as Move);
    const pendingCreations = this.ledger.entries("creation:", 4096)
      .filter(r => !created.has(r.key.slice("creation:".length)));
    return {active, departed, pending, pendingCreations, pendingReservations};
  }
  private admit(rows: number, bytes: number, completingCreation?: string): void {
    const capacity = this.ledger.capacity();
    const state = this.state(), pending = state.pending.length;
    const creations = state.pendingCreations.length - (completingCreation ? 1 : 0);
    if (capacity.rows + pending + creations + rows > capacity.maxRows ||
        capacity.bytes + pending * EVENT_BYTES + creations * 4096 + bytes > capacity.maxBytes) fail("CAPACITY");
  }
  /** Pre-mutation room for the exact creation metadata. No acknowledgement
   * may be inferred from this check; the native receipt is still mandatory. */
  admitCreation(value: Omit<WindowsSourceIdentity, "fileId" | "volumeId">): void {
    if (this.unavailable) throw this.failed;
    snapshot({...value, fileId: "0".repeat(32), volumeId: "0".repeat(16)});
    this.write(() => this.admit(1, 4096));
  }
  reserveCreation(path: string): string {
    const identity = snapshot({kind: "file", canonicalPath: path, fileId: "0".repeat(32), volumeId: "0".repeat(16)});
    const id = randomUUID().replace(/-/g, "");
    this.write(() => {
      const state = this.state();
      if (state.active.has(recordKey(identity))) fail("DESTINATION_BOUND");
      if (state.pendingCreations.some(c => c.value === identity.canonicalPath) ||
          state.pending.some(m => overlaps(m.from.canonicalPath, identity.canonicalPath) || overlaps(m.to, identity.canonicalPath)))
        fail("TRANSITION_PENDING");
      this.admit(3, 4096 + 1024 + Buffer.byteLength(identity.canonicalPath));
      this.ledger.write(`creation:${id}`, identity.canonicalPath);
    });
    return id;
  }
  private enrollInTransaction(identity: WindowsSourceIdentity, state: ReturnType<WindowsSourceBindings["state"]>, created: boolean, creation?: string,
    investigation?: Investigation): void {
    const key = recordKey(identity), previous = state.active.get(key);
    if (previous) { if (canonical(previous) !== canonical(identity)) fail("IDENTITY_CHANGED"); return; }
    if (state.pending.some(m => overlaps(m.from.canonicalPath, identity.canonicalPath) || overlaps(m.to, identity.canonicalPath)))
      fail("TRANSITION_PENDING");
    if (state.pendingCreations.some(c => c.value === identity.canonicalPath && c.key !== `creation:${creation}`)) fail("TRANSITION_PENDING");
    if (creation && this.ledger.read(`creation:${creation}`) !== identity.canonicalPath) fail("TRANSITION");
    if (state.departed.has(key) && !created) fail("RECEIPT_REQUIRED");
    this.admit(1, 4096, creation);
    const events = this.ledger.entries("event:", 4096);
    // Legacy originals remain immutable. Once events exist every addition has
    // an explicit order, so a later reuse is never retroactively relocated.
    if (!creation && events.length === 0 && this.ledger.read(key) === null) this.ledger.write(key, canonical(identity));
    else this.ledger.write(`event:${String(events.length).padStart(8, "0")}`, canonical({type: "enroll", identity,
      ...(creation ? {creation} : {}), ...(investigation ? {investigation} : {})}));
  }
  private write(work: () => void): void {
    if (this.unavailable) throw this.failed;
    let completed = false;
    try { this.ledger.transaction(() => {
      this.transactionActive = true;
      try { work(); completed = true; } finally { this.transactionActive = false; }
    }); }
    catch (error) {
      if (completed) { this.unavailable = true; this.failed = error; }
      throw error;
    }
  }
  private check(value: WindowsSourceIdentity, enroll: boolean): void {
    if (this.unavailable) throw this.failed;
    const identity = snapshot(value), key = recordKey(identity), body = canonical(identity);
    // A comparison performs no write and may be needed by a current-authority
    // callback inside this ledger's own transaction. Never nest BEGIN.
    const retained = this.state().active.get(key);
    if (retained !== undefined) {
      if (canonical(retained) !== body) fail("IDENTITY_CHANGED");
      return;
    }
    if (!enroll) fail("NOT_ENROLLED");
    let wrote = false;
    try {
      this.write(() => {
        const state = this.state(), previous = state.active.get(key);
        if (previous === undefined) {
          if (!enroll) fail("NOT_ENROLLED");
          this.enrollInTransaction(identity, state, false); wrote = true;
        } else if (canonical(previous) !== body) fail("IDENTITY_CHANGED");
        if (canonical(this.state().active.get(key)) !== body) fail("READBACK");
      });
      if (canonical(this.state().active.get(key)) !== body) fail("READBACK");
    } catch (error) {
      // COMMIT may already have happened; never let this object enroll/rebind
      // again after an uncertain write acknowledgment.
      if (wrote) { this.unavailable = true; this.failed = error; }
      throw error;
    }
  }
  close(): void { this.ledger.close(); }
}
