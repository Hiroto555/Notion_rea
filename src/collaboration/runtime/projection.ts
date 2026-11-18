import { parseAssetURL } from "../../shared/assets";
import { textOf, type Doc } from "../../shared/types";
import { validDocument } from "../../shared/validation";
import { canonical } from "./canonical";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  sameScope,
  scopeKey,
  wellFormed,
  type Cut,
  type DocumentState,
  type Scope,
  type TableMetadata,
} from "./contract";
import { DOCUMENTS_NAMESPACE, HEAD_KEY, META_NAMESPACE } from "./lifecycle";
import type { StoragePort } from "./storage-port";
import { parseCut } from "./wire";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const PAGE_LINK_PREFIX = "folio-page://";
const MAX_STATE_BYTES = 30_000_000;

export type ProjectionSearchResult = Readonly<{
  scope: Scope;
  title: string;
  text: string;
  cut: Cut;
}>;

export type ProjectionBacklink = Readonly<{
  scope: Scope;
  blockId: string | null;
  cut: Cut;
}>;

export type ProjectionExport = Readonly<{
  scope: Scope;
  state: DocumentState;
  cut: Cut;
  raw: string;
}>;

export type ProjectionRebuild = Readonly<{
  indexed: number;
  cut: Cut;
}>;

type StoredRecord = Readonly<{ scope: Scope; value: unknown; key: string }>;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function checkedScope(input: Scope): Scope {
  demand(input !== null && typeof input === "object", "INVALID_SCOPE");
  const keys = Object.keys(input);
  demand(
    keys.length === 4 &&
      keys.every((key) =>
        ["orgId", "workspaceId", "documentId", "incarnationId"].includes(key),
      ),
    "INVALID_SCOPE",
  );
  return {
    orgId: identifier(input.orgId),
    workspaceId: identifier(input.workspaceId),
    documentId: identifier(input.documentId),
    incarnationId: identifier(input.incarnationId),
  };
}

function parseScopeKey(key: string): Scope {
  if (typeof key !== "string") fail("INVALID_SCOPE_KEY");
  const parts = key.split(":");
  if (parts.length !== 4 || !parts.every((part) => IDENTIFIER.test(part)))
    fail("INVALID_SCOPE_KEY");
  return {
    orgId: parts[0],
    workspaceId: parts[1],
    documentId: parts[2],
    incarnationId: parts[3],
  };
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function checkedTable(value: unknown): TableMetadata {
  demand(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "CORRUPT_STATE",
  );
  demand(exactKeys(value, ["tableId", "rowIds", "columnIds"]), "CORRUPT_STATE");
  const table = value as TableMetadata;
  const tableId = identifier(table.tableId);
  demand(Array.isArray(table.rowIds), "CORRUPT_STATE");
  demand(Array.isArray(table.columnIds), "CORRUPT_STATE");
  const rowIds = table.rowIds.map(identifier);
  const columnIds = table.columnIds.map(identifier);
  demand(new Set(rowIds).size === rowIds.length, "CORRUPT_STATE");
  demand(new Set(columnIds).size === columnIds.length, "CORRUPT_STATE");
  return { tableId, rowIds, columnIds };
}

function checkedState(value: unknown): { state: DocumentState; raw: string } {
  demand(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "CORRUPT_STATE",
  );
  demand(
    exactKeys(value, ["document", "tables", "tombstones"]),
    "CORRUPT_STATE",
  );
  const candidate = value as DocumentState;
  demand(validDocument(candidate.document), "CORRUPT_DOCUMENT");
  demand(Array.isArray(candidate.tables), "CORRUPT_STATE");
  demand(Array.isArray(candidate.tombstones), "CORRUPT_STATE");
  const tables = candidate.tables.map(checkedTable);
  demand(
    new Set(tables.map((table) => table.tableId)).size === tables.length,
    "CORRUPT_STATE",
  );
  const tombstones = candidate.tombstones.map(identifier);
  demand(new Set(tombstones).size === tombstones.length, "CORRUPT_STATE");
  const state: DocumentState = {
    document: candidate.document,
    tables,
    tombstones,
  };
  const raw = canonical(state, MAX_STATE_BYTES);
  return { state, raw };
}

function pageTarget(href: string): string | null {
  if (!href.startsWith(PAGE_LINK_PREFIX)) return null;
  const suffix = href.slice(PAGE_LINK_PREFIX.length);
  const id = suffix.endsWith("/") ? suffix.slice(0, -1) : suffix;
  return IDENTIFIER.test(id) ? id : null;
}

function linkTarget(node: Doc): string | null {
  for (const mark of node.marks ?? []) {
    if (mark.type !== "link") continue;
    const href = mark.attrs?.href;
    if (typeof href !== "string") continue;
    const target = pageTarget(href);
    if (target !== null) return target;
  }
  return null;
}

function imageAsset(node: Doc): string | null {
  if (node.type !== "image") return null;
  const src = node.attrs?.src;
  if (typeof src !== "string" || !src.startsWith("folio-asset://")) return null;
  return parseAssetURL(src);
}

function pageLinkBlocks(
  node: Doc,
  inherited: string | null,
  target: string,
  found: Set<string | null>,
): void {
  const ownId = node.attrs?.id;
  const blockId =
    typeof ownId === "string" && ownId.length > 0 ? ownId : inherited;
  if (linkTarget(node) === target) found.add(blockId);
  imageAsset(node);
  for (const child of node.content ?? []) {
    pageLinkBlocks(child, blockId, target, found);
  }
}

function titleOf(document: Doc): string {
  const queue: Doc[] = [document];
  while (queue.length) {
    const node = queue.shift()!;
    if (node.type === "heading" || node.type === "paragraph") {
      const title = textOf(node).trim();
      if (title) return title;
    }
    queue.push(...(node.content ?? []));
  }
  return textOf(document).trim().slice(0, 200);
}

function matches(needle: string, title: string, text: string): boolean {
  if (!needle) return true;
  const haystack = (title + "\n" + text).toLowerCase();
  if (haystack.includes(needle)) return true;
  const terms = needle.split(/\s+/).filter(Boolean);
  return terms.length > 1 && terms.every((term) => haystack.includes(term));
}

function compareScopes(a: Scope, b: Scope): number {
  const left = scopeKey(a);
  const right = scopeKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * Read-only shared projection over the authoritative records namespace.
 * Callers supply the per-scope permission check; it runs before any stored
 * document content is validated, indexed or returned.
 */
export class SharedProjection {
  constructor(
    private readonly store: StoragePort,
    private readonly authorize: (scope: Scope) => void,
    private readonly visible: (scope: Scope) => boolean = () => true,
  ) {
    demand(
      store !== null &&
        typeof store === "object" &&
        typeof store.transaction === "function" &&
        typeof store.get === "function" &&
        typeof store.all === "function",
      "INVALID_STORE",
    );
    demand(typeof authorize === "function", "INVALID_AUTHORIZE");
  }

  private head(): Cut {
    let value: unknown;
    try {
      value = this.store.get(META_NAMESPACE, HEAD_KEY);
    } catch {
      throw new CollaborationError("CORRUPT_HEAD");
    }
    demand(value !== null && value !== undefined, "MISSING_HEAD");
    try {
      return parseCut(value);
    } catch (error) {
      if (error instanceof CollaborationError) throw error;
      throw new CollaborationError("CORRUPT_HEAD");
    }
  }

  private records(): StoredRecord[] {
    let rows: { key: string; value: unknown }[];
    try {
      rows = this.store.all(DOCUMENTS_NAMESPACE);
    } catch {
      throw new CollaborationError("CORRUPT_RECORDS");
    }
    demand(Array.isArray(rows), "CORRUPT_RECORDS");
    const seen = new Set<string>();
    return rows.map((row) => {
      demand(
        row !== null && typeof row === "object" && typeof row.key === "string",
        "CORRUPT_RECORDS",
      );
      demand(!seen.has(row.key), "DUPLICATE_SCOPE_KEY");
      seen.add(row.key);
      return {
        key: row.key,
        scope: parseScopeKey(row.key),
        value: row.value,
      };
    });
  }

  private inTransaction<T>(work: (cut: Cut) => T): T {
    return this.store.transaction(() => work(this.head()));
  }

  search(
    orgId: string,
    workspaceId: string,
    query: string,
    limit = 50,
  ): ProjectionSearchResult[] {
    const org = identifier(orgId);
    const workspace = identifier(workspaceId);
    demand(typeof query === "string" && wellFormed(query), "INVALID_QUERY");
    demand(Number.isSafeInteger(limit) && limit >= 0, "INVALID_LIMIT");
    const needle = query.toLowerCase();
    return this.inTransaction((cut) => {
      const results: ProjectionSearchResult[] = [];
      for (const record of this.records()) {
        if (
          record.scope.orgId !== org ||
          record.scope.workspaceId !== workspace
        )
          continue;
        this.authorize(record.scope);
        if (!this.visible(record.scope)) continue;
        const { state } = checkedState(record.value);
        const title = titleOf(state.document);
        const text = textOf(state.document);
        if (!matches(needle, title, text)) continue;
        results.push({
          scope: clone(record.scope),
          title,
          text,
          cut,
        });
      }
      results.sort(
        (a, b) =>
          compareScopes(a.scope, b.scope) ||
          (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
      );
      return results.slice(0, limit);
    });
  }

  backlinks(scope: Scope): ProjectionBacklink[] {
    const target = checkedScope(scope);
    return this.inTransaction((cut) => {
      this.authorize(target);
      demand(this.visible(target), "DOCUMENT_NOT_ACTIVE");
      const results: ProjectionBacklink[] = [];
      for (const record of this.records()) {
        if (
          record.scope.orgId !== target.orgId ||
          record.scope.workspaceId !== target.workspaceId
        )
          continue;
        if (sameScope(record.scope, target)) continue;
        this.authorize(record.scope);
        if (!this.visible(record.scope)) continue;
        const { state } = checkedState(record.value);
        const blocks = new Set<string | null>();
        pageLinkBlocks(state.document, null, target.documentId, blocks);
        for (const blockId of blocks) {
          results.push({
            scope: clone(record.scope),
            blockId,
            cut,
          });
        }
      }
      results.sort(
        (a, b) =>
          compareScopes(a.scope, b.scope) ||
          compareNullable(a.blockId, b.blockId),
      );
      return results;
    });
  }

  exportDocument(scope: Scope): ProjectionExport {
    const target = checkedScope(scope);
    return this.inTransaction((cut) => {
      this.authorize(target);
      demand(this.visible(target), "DOCUMENT_NOT_ACTIVE");
      let value: unknown;
      try {
        value = this.store.get(DOCUMENTS_NAMESPACE, scopeKey(target));
      } catch {
        throw new CollaborationError("CORRUPT_RECORDS");
      }
      demand(value !== null && value !== undefined, "DOCUMENT_MISSING");
      const { state, raw } = checkedState(value);
      return {
        scope: clone(target),
        state: clone(state),
        cut,
        raw,
      };
    });
  }

  rebuild(orgId: string, workspaceId: string): ProjectionRebuild {
    const org = identifier(orgId);
    const workspace = identifier(workspaceId);
    return this.inTransaction((cut) => {
      let indexed = 0;
      for (const record of this.records()) {
        if (
          record.scope.orgId !== org ||
          record.scope.workspaceId !== workspace
        )
          continue;
        this.authorize(record.scope);
        if (!this.visible(record.scope)) continue;
        checkedState(record.value);
        indexed++;
      }
      return { indexed, cut };
    });
  }
}
