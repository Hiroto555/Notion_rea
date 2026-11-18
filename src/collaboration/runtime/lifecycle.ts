import type { Doc } from "../../shared/types";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  sameScope,
  safeCounter,
  scopeKey,
  type Cut,
  type DocumentState,
  type Scope,
  type TableMetadata,
} from "./contract";
import { canonical } from "./canonical";
import { checkedState } from "./document";
import { seedTables } from "./table-commands";
import type { StoragePort } from "./storage-port";

export const DOCUMENTS_NAMESPACE = "documents";
export const META_NAMESPACE = "meta";
export const HEAD_KEY = "head";
export const LIFECYCLES_NAMESPACE = "doclifecycles";
export const HISTORY_NAMESPACE = "history";
export const RESTORE_SEEDS_NAMESPACE = "restoreSeeds";

export type LifecycleRecord = {
  activeIncarnation: string;
  deleted: boolean;
  cut: Cut;
};

export type LifecycleHistoryEntry = {
  scope: Scope;
  cut: Cut;
  state: DocumentState;
};

type RestoreSeed = { from: string; to: string };

function fail(code: string): never {
  throw new CollaborationError(code);
}

function parseScope(value: unknown, code: string): Scope {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  try {
    return {
      orgId: identifier(record.orgId),
      workspaceId: identifier(record.workspaceId),
      documentId: identifier(record.documentId),
      incarnationId: identifier(record.incarnationId),
    };
  } catch {
    return fail(code);
  }
}

function parseCut(value: unknown, code: string): Cut {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  let epoch: string;
  try {
    epoch = identifier(record.epoch);
  } catch {
    return fail(code);
  }
  const seq = record.seq;
  const hash = record.hash;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)
    fail(code);
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) fail(code);
  return { epoch, seq: safeCounter(seq), hash };
}

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function parseState(value: unknown, code: string): DocumentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  const rawTables = record.tables;
  const rawTombstones = record.tombstones;
  if (!Array.isArray(rawTables)) fail(code);
  if (!Array.isArray(rawTombstones)) fail(code);
  const tables: TableMetadata[] = [];
  for (const raw of rawTables) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(code);
    const table = raw as Record<string, unknown>;
    const rowIds = table.rowIds;
    const columnIds = table.columnIds;
    if (!Array.isArray(rowIds)) fail(code);
    if (!Array.isArray(columnIds)) fail(code);
    try {
      tables.push({
        tableId: identifier(table.tableId),
        rowIds: rowIds.map((item) => identifier(item)),
        columnIds: columnIds.map((item) => identifier(item)),
      });
    } catch {
      return fail(code);
    }
  }
  let tombstones: string[];
  try {
    tombstones = rawTombstones.map((item) => identifier(item));
  } catch {
    return fail(code);
  }
  try {
    return checkedState({
      document: record.document as Doc,
      tables,
      tombstones,
    });
  } catch {
    return fail(code);
  }
}

function parseLifecycle(value: unknown, code: string): LifecycleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const record = value as Record<string, unknown>;
  let activeIncarnation: string;
  try {
    activeIncarnation = identifier(record.activeIncarnation);
  } catch {
    return fail(code);
  }
  const deleted = record.deleted;
  if (typeof deleted !== "boolean") fail(code);
  return {
    activeIncarnation,
    deleted,
    cut: parseCut(record.cut, code),
  };
}

function lifecycleKey(scope: Scope): string {
  return [scope.orgId, scope.workspaceId, scope.documentId].join(":");
}

function readLifecycle(
  store: StoragePort,
  scope: Scope,
): LifecycleRecord | null {
  const raw = store.get(LIFECYCLES_NAMESPACE, lifecycleKey(scope));
  return raw === null ? null : parseLifecycle(raw, "CORRUPT_LIFECYCLE");
}

function readHead(store: StoragePort): Cut {
  const raw = store.get(META_NAMESPACE, HEAD_KEY);
  if (raw === null) fail("HEAD_MISSING");
  return parseCut(raw, "CORRUPT_HEAD");
}

function readState(store: StoragePort, scope: Scope): DocumentState {
  const raw = store.get(DOCUMENTS_NAMESPACE, scopeKey(scope));
  if (raw === null) fail("DOCUMENT_MISSING");
  return parseState(raw, "CORRUPT_DOCUMENT");
}

function readHistoryEntry(
  value: unknown,
  scope: Scope,
  seq: number,
): LifecycleHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("CORRUPT_HISTORY");
  const record = value as Record<string, unknown>;
  const storedScope = parseScope(record.scope, "CORRUPT_HISTORY");
  if (!sameScope(storedScope, scope)) fail("CORRUPT_HISTORY");
  const cut = parseCut(record.cut, "CORRUPT_HISTORY");
  demand(cut.seq === seq, "CORRUPT_HISTORY");
  return {
    scope: storedScope,
    cut,
    state: parseState(record.state, "CORRUPT_HISTORY"),
  };
}

function readRestoreSeed(store: StoragePort, scope: Scope): RestoreSeed | null {
  const raw = store.get(RESTORE_SEEDS_NAMESPACE, lifecycleKey(scope));
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    fail("CORRUPT_RESTORE_SEED");
  const record = raw as Record<string, unknown>;
  try {
    return {
      from: identifier(record.from),
      to: identifier(record.to),
    };
  } catch {
    return fail("CORRUPT_RESTORE_SEED");
  }
}

function captureChecked(
  store: StoragePort,
  scope: Scope,
  cut: Cut,
  state: DocumentState,
): void {
  const key = `${scopeKey(scope)}:${cut.seq}`;
  const existing = store.get(HISTORY_NAMESPACE, key);
  if (existing !== null) {
    const entry = readHistoryEntry(existing, scope, cut.seq);
    demand(sameCut(entry.cut, cut), "HISTORY_CUT_CONFLICT");
    demand(canonical(entry.state) === canonical(state), "HISTORY_IMMUTABLE");
    return;
  }
  store.set(HISTORY_NAMESPACE, key, { scope, cut, state });
}

function requireTransaction(store: StoragePort): void {
  demand(store.db.isTransaction, "TRANSACTION_REQUIRED");
}

function priorIncarnations(store: StoragePort, scope: Scope): Set<string> {
  const seen = new Set<string>([scope.incarnationId]);
  const prefix = [scope.orgId, scope.workspaceId, scope.documentId];
  const collect = (namespace: string, parts: number) => {
    for (const { key } of store.all(namespace)) {
      const values = key.split(":");
      if (
        values.length === parts &&
        values[0] === prefix[0] &&
        values[1] === prefix[1] &&
        values[2] === prefix[2]
      )
        seen.add(values[3]);
    }
  };
  collect(DOCUMENTS_NAMESPACE, 4);
  collect(HISTORY_NAMESPACE, 5);
  return seen;
}

export class DocumentLifecycle {
  constructor(private readonly store: StoragePort) {}

  assertActive(scope: Scope): void {
    const checkedScope = parseScope(scope, "INVALID_SCOPE");
    const lifecycle = readLifecycle(this.store, checkedScope);
    if (!lifecycle) fail("LIFECYCLE_MISSING");
    demand(!lifecycle.deleted, "DOCUMENT_DELETED");
    demand(
      lifecycle.activeIncarnation === checkedScope.incarnationId,
      "SCOPE_NOT_ACTIVE",
    );
  }

  capture(scope: Scope): void {
    const checkedScope = parseScope(scope, "INVALID_SCOPE");
    requireTransaction(this.store);
    this.assertActive(checkedScope);
    const cut = readHead(this.store);
    const state = readState(this.store, checkedScope);
    captureChecked(this.store, checkedScope, cut, state);
  }

  trash(scope: Scope): { scope: Scope; cut: Cut } {
    const checkedScope = parseScope(scope, "INVALID_SCOPE");
    requireTransaction(this.store);
    const lifecycle = readLifecycle(this.store, checkedScope);
    if (lifecycle) {
      demand(
        lifecycle.activeIncarnation === checkedScope.incarnationId,
        "SCOPE_NOT_ACTIVE",
      );
      if (lifecycle.deleted) {
        readState(this.store, checkedScope);
        return { scope: checkedScope, cut: clone(lifecycle.cut) };
      }
    }
    const state = readState(this.store, checkedScope);
    const cut = readHead(this.store);
    captureChecked(this.store, checkedScope, cut, state);
    this.store.set(LIFECYCLES_NAMESPACE, lifecycleKey(checkedScope), {
      activeIncarnation: checkedScope.incarnationId,
      deleted: true,
      cut,
    });
    return { scope: checkedScope, cut: clone(cut) };
  }

  restore(scope: Scope, newIncarnationId: string): Scope {
    const checkedScope = parseScope(scope, "INVALID_SCOPE");
    let incarnation: string;
    try {
      incarnation = identifier(newIncarnationId);
    } catch {
      return fail("INVALID_ID");
    }
    requireTransaction(this.store);

    const key = lifecycleKey(checkedScope);
    const targetScope: Scope = {
      ...checkedScope,
      incarnationId: incarnation,
    };
    const seed = readRestoreSeed(this.store, checkedScope);
    if (seed) {
      demand(
        seed.from === checkedScope.incarnationId && seed.to === incarnation,
        "RESTORE_CONFLICT",
      );
      const lifecycle = readLifecycle(this.store, checkedScope);
      if (
        !lifecycle ||
        lifecycle.deleted ||
        lifecycle.activeIncarnation !== incarnation
      )
        fail("CORRUPT_RESTORE_SEED");
      readState(this.store, targetScope);
      return targetScope;
    }

    demand(incarnation !== checkedScope.incarnationId, "INCARNATION_REUSE");
    const lifecycle = readLifecycle(this.store, checkedScope);
    if (!lifecycle) fail("LIFECYCLE_MISSING");
    demand(
      lifecycle.activeIncarnation === checkedScope.incarnationId,
      "SCOPE_NOT_ACTIVE",
    );
    demand(lifecycle.deleted, "NOT_DELETED");
    demand(
      !priorIncarnations(this.store, checkedScope).has(incarnation),
      "INCARNATION_REUSE",
    );

    const historyKey = `${scopeKey(checkedScope)}:${lifecycle.cut.seq}`;
    const rawCheckpoint = this.store.get(HISTORY_NAMESPACE, historyKey);
    if (rawCheckpoint === null) fail("CHECKPOINT_MISSING");
    const checkpoint = readHistoryEntry(
      rawCheckpoint,
      checkedScope,
      lifecycle.cut.seq,
    );
    demand(sameCut(checkpoint.cut, lifecycle.cut), "CHECKPOINT_CUT_MISMATCH");

    const targetKey = scopeKey(targetScope);
    demand(
      this.store.get(DOCUMENTS_NAMESPACE, targetKey) === null,
      "DOCUMENT_EXISTS",
    );

    const restored = seedTables(checkpoint.state, incarnation);
    this.store.set(DOCUMENTS_NAMESPACE, targetKey, restored);
    this.store.set(LIFECYCLES_NAMESPACE, key, {
      activeIncarnation: incarnation,
      deleted: false,
      cut: clone(lifecycle.cut),
    });
    this.store.set(RESTORE_SEEDS_NAMESPACE, key, {
      from: checkedScope.incarnationId,
      to: incarnation,
    });
    return targetScope;
  }

  history(scope: Scope): LifecycleHistoryEntry[] {
    const checkedScope = parseScope(scope, "INVALID_SCOPE");
    const prefix = `${scopeKey(checkedScope)}:`;
    const entries: LifecycleHistoryEntry[] = [];
    for (const { key, value } of this.store.all(HISTORY_NAMESPACE)) {
      if (!key.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      if (!/^(0|[1-9][0-9]*)$/.test(suffix)) fail("CORRUPT_HISTORY");
      const seq = Number(suffix);
      demand(Number.isSafeInteger(seq), "CORRUPT_HISTORY");
      entries.push(readHistoryEntry(value, checkedScope, seq));
    }
    entries.sort((left, right) => left.cut.seq - right.cut.seq);
    return entries;
  }
}
