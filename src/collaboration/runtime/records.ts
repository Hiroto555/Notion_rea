import { canonical } from "./canonical";
import { isDocument, type Property } from "../../shared/types";
import {
  clone,
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  scopeKey,
  wellFormed,
  type DocumentState,
  type Json,
  type ResourceCommand,
  type Scope,
} from "./contract";
import { initialState } from "./document";
import type { StoragePort } from "./storage-port";

const DATABASES = "databases";
const RECORDS = "records";
const PAGES = "pages";
const DOCUMENTS = "documents";

type DatabaseRow = {
  id: string;
  revision: number;
  properties: Property[];
  deleted: boolean;
};
type RecordRow = {
  id: string;
  databaseId: string;
  revision: number;
  values: Record<string, string | number | boolean>;
  title: string;
  deleted: boolean;
};
type PageRow = { id: string; parentId: string | null; order: number };
type Value = string | number | boolean;
type MutableValues = Record<string, Value | null>;

type ProjectDatabase = Readonly<{
  id: string;
  revision: number;
  properties: Property[];
  deleted: boolean;
}>;
type ProjectRecord = Readonly<{
  id: string;
  databaseId: string;
  revision: number;
  title: string;
  values: Readonly<Record<string, Value>>;
  deleted: boolean;
}>;
type ProjectPage = Readonly<{
  id: string;
  parentId: string | null;
  order: number;
}>;
type RecordsView = Readonly<{
  databases: readonly ProjectDatabase[];
  records: readonly ProjectRecord[];
  pages: readonly ProjectPage[];
  document: DocumentState | null;
}>;

function refuse(code: string): never {
  throw new CollaborationError(code);
}

function prefix(scope: Scope): string {
  return `${identifier(scope.orgId)}:${identifier(scope.workspaceId)}:`;
}

function storageKey(scope: Scope, id: string): string {
  return prefix(scope) + identifier(id);
}

function plainObject(value: unknown, code: string): Record<string, unknown> {
  demand(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.getOwnPropertySymbols(value).length === 0,
    code,
  );
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  demand(names.length === keys.length, code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    demand(
      descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable &&
        wellFormed(key),
      code,
    );
  }
  return value as Record<string, unknown>;
}

function strictPayload(
  value: Json,
  allowed: readonly string[],
): Record<string, unknown> {
  const payload = plainObject(value, "INVALID_PAYLOAD");
  const known = new Set(allowed);
  for (const key of Object.keys(payload))
    demand(known.has(key), "UNKNOWN_PAYLOAD_FIELD");
  return payload;
}

function text(value: unknown, code: string, max = 500): string {
  demand(
    typeof value === "string" && value.length <= max && wellFormed(value),
    code,
  );
  return value;
}

function nullableId(value: unknown, code: string): string | null {
  return value === null ? null : identifier(value);
}

function nextCounter(value: number, code: string): number {
  demand(value < Number.MAX_SAFE_INTEGER, code);
  return value + 1;
}

function isStrictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

function validateProperties(value: unknown): Property[] {
  demand(Array.isArray(value), "INVALID_PROPERTIES");
  demand(value.length <= 1000, "INVALID_PROPERTIES");
  const seen = new Set<string>();
  const properties: Property[] = [];
  for (const raw of value) {
    const item = plainObject(raw, "INVALID_PROPERTY");
    const keys = Object.keys(item);
    demand(
      keys.every(
        (key) =>
          key === "id" || key === "name" || key === "type" || key === "options",
      ),
      "UNKNOWN_PROPERTY_FIELD",
    );
    const id = text(item.id, "INVALID_PROPERTY_ID", 500);
    demand(id.length > 0 && id !== "__proto__", "INVALID_PROPERTY_ID");
    demand(!seen.has(id), "DUPLICATE_PROPERTY_ID");
    seen.add(id);
    const name = text(item.name, "INVALID_PROPERTY_NAME", 200);
    demand(name.length > 0, "INVALID_PROPERTY_NAME");
    const type = item.type;
    if (
      type !== "text" &&
      type !== "number" &&
      type !== "select" &&
      type !== "date" &&
      type !== "checkbox"
    )
      refuse("INVALID_PROPERTY_TYPE");
    if (type === "select") {
      const optionValues = item.options;
      if (
        !Array.isArray(optionValues) ||
        optionValues.length === 0 ||
        optionValues.length > 1000
      )
        refuse("INVALID_OPTIONS");
      const options: string[] = [];
      for (const option of optionValues) {
        const value = text(option, "INVALID_OPTION", 200);
        demand(value.length > 0 && !options.includes(value), "INVALID_OPTIONS");
        options.push(value);
      }
      properties.push({ id, name, type, options });
    } else {
      demand(!Object.hasOwn(item, "options"), "INVALID_OPTIONS");
      properties.push({ id, name, type });
    }
  }
  return properties;
}

function validateValue(
  property: Property,
  value: unknown,
  allowNull: boolean,
  code = "INVALID_VALUE",
): Value | null {
  if (value === null) {
    if (!allowNull) refuse(code);
    return null;
  }
  switch (property.type) {
    case "text":
      if (typeof value !== "string" || !wellFormed(value)) refuse(code);
      return value;
    case "number":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        Object.is(value, -0) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      )
        refuse(code);
      return value;
    case "checkbox":
      if (typeof value !== "boolean") refuse(code);
      return value;
    case "date":
      if (typeof value !== "string" || (value !== "" && !isStrictDate(value)))
        refuse(code);
      return value;
    case "select":
      if (
        typeof value !== "string" ||
        (value !== "" && !property.options?.includes(value))
      )
        refuse(code);
      return value;
  }
}

function validateValues(
  value: unknown,
  properties: Property[],
  allowNull: boolean,
): MutableValues {
  const input = plainObject(value, "INVALID_VALUES");
  const entries = Object.entries(input);
  demand(entries.length <= 1000, "INVALID_VALUES");
  const byId = new Map(properties.map((property) => [property.id, property]));
  const values: MutableValues = {};
  for (const [key, cell] of entries) {
    demand(
      key.length > 0 && key.length <= 500 && key !== "__proto__",
      "INVALID_VALUES",
    );
    const property = byId.get(key);
    demand(property !== undefined, "UNKNOWN_PROPERTY");
    values[key] = validateValue(property, cell, allowNull);
  }
  return values;
}

function storedValue(value: unknown): Value {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return value;
  return refuse("CORRUPT_RECORD");
}

function storedDatabase(value: unknown, id: string): DatabaseRow {
  const row = plainObject(value, "CORRUPT_DATABASE");
  demand(row.id === id, "CORRUPT_DATABASE");
  const revision = safeCounter(row.revision);
  const properties = validateProperties(row.properties);
  const deleted = row.deleted;
  if (typeof deleted !== "boolean") refuse("CORRUPT_DATABASE");
  return { id, revision, properties, deleted };
}

function storedRecord(value: unknown, id: string): RecordRow {
  const row = plainObject(value, "CORRUPT_RECORD");
  demand(row.id === id, "CORRUPT_RECORD");
  const databaseId = identifier(row.databaseId);
  const revision = safeCounter(row.revision);
  const title = text(row.title, "CORRUPT_RECORD");
  const deleted = row.deleted;
  if (typeof deleted !== "boolean") refuse("CORRUPT_RECORD");
  const input = plainObject(row.values, "CORRUPT_RECORD");
  const values: Record<string, Value> = {};
  for (const [key, cell] of Object.entries(input)) {
    demand(
      key.length > 0 && key.length <= 500 && key !== "__proto__",
      "CORRUPT_RECORD",
    );
    values[key] = storedValue(cell);
  }
  return { id, databaseId, revision, values, title, deleted };
}

function storedPage(value: unknown, id: string): PageRow {
  const row = plainObject(value, "CORRUPT_PAGE");
  demand(row.id === id, "CORRUPT_PAGE");
  const parentId = nullableId(row.parentId, "CORRUPT_PAGE");
  const order = safeCounter(row.order);
  return { id, parentId, order };
}

function getDatabase(
  store: StoragePort,
  scope: Scope,
  id: string,
): DatabaseRow | null {
  const value = store.get(DATABASES, storageKey(scope, id));
  return value === null ? null : storedDatabase(value, id);
}

function getRecord(
  store: StoragePort,
  scope: Scope,
  id: string,
): RecordRow | null {
  const value = store.get(RECORDS, storageKey(scope, id));
  return value === null ? null : storedRecord(value, id);
}

function getPage(store: StoragePort, scope: Scope, id: string): PageRow | null {
  const value = store.get(PAGES, storageKey(scope, id));
  return value === null ? null : storedPage(value, id);
}

function workspaceRows(
  store: StoragePort,
  namespace: string,
  scope: Scope,
): { key: string; value: unknown }[] {
  const start = prefix(scope);
  return store
    .all(namespace)
    .filter((row) => row.key.startsWith(start) && row.key.length > start.length)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function allDatabases(store: StoragePort, scope: Scope): DatabaseRow[] {
  return workspaceRows(store, DATABASES, scope).map((row) =>
    storedDatabase(row.value, identifier(row.key.slice(prefix(scope).length))),
  );
}

function allRecords(store: StoragePort, scope: Scope): RecordRow[] {
  return workspaceRows(store, RECORDS, scope).map((row) =>
    storedRecord(row.value, identifier(row.key.slice(prefix(scope).length))),
  );
}

function allPages(store: StoragePort, scope: Scope): PageRow[] {
  return workspaceRows(store, PAGES, scope).map((row) =>
    storedPage(row.value, identifier(row.key.slice(prefix(scope).length))),
  );
}

function nextOrder(pages: readonly PageRow[], parentId: string | null): number {
  let maximum = -1;
  for (const page of pages) {
    if (page.parentId !== parentId) continue;
    demand(page.order < Number.MAX_SAFE_INTEGER, "ORDER_LIMIT");
    maximum = Math.max(maximum, page.order);
  }
  return maximum + 1;
}

function projectDatabase(row: DatabaseRow): ProjectDatabase {
  return {
    id: row.id,
    revision: row.revision,
    properties: clone(row.properties),
    deleted: row.deleted,
  };
}

function projectRecord(row: RecordRow): ProjectRecord {
  return {
    id: row.id,
    databaseId: row.databaseId,
    revision: row.revision,
    title: row.title,
    values: clone(row.values),
    deleted: row.deleted,
  };
}

function projectPage(row: PageRow): ProjectPage {
  return { id: row.id, parentId: row.parentId, order: row.order };
}

function writeDatabase(
  store: StoragePort,
  scope: Scope,
  row: DatabaseRow,
): void {
  store.set(DATABASES, storageKey(scope, row.id), clone(row));
}

function writeRecord(store: StoragePort, scope: Scope, row: RecordRow): void {
  store.set(RECORDS, storageKey(scope, row.id), clone(row));
}

function writePage(store: StoragePort, scope: Scope, row: PageRow): void {
  store.set(PAGES, storageKey(scope, row.id), clone(row));
}

function createDatabase(store: StoragePort, scope: Scope, payload: Json): Json {
  const input = strictPayload(payload, [
    "databaseId",
    "revision",
    "properties",
    "parentId",
  ]);
  const databaseId = identifier(input.databaseId);
  const revision =
    input.revision === undefined ? 0 : safeCounter(input.revision);
  const properties = validateProperties(input.properties);
  const parentId = Object.hasOwn(input, "parentId")
    ? nullableId(input.parentId, "INVALID_PARENT")
    : null;
  demand(getDatabase(store, scope, databaseId) === null, "ID_EXISTS");
  demand(getPage(store, scope, databaseId) === null, "ID_EXISTS");
  if (parentId !== null) {
    demand(parentId !== databaseId, "MOVE_CYCLE");
    demand(getPage(store, scope, parentId) !== null, "PARENT_MISSING");
  }
  const pages = allPages(store, scope);
  const page: PageRow = {
    id: databaseId,
    parentId,
    order: nextOrder(pages, parentId),
  };
  const database: DatabaseRow = {
    id: databaseId,
    revision,
    properties,
    deleted: false,
  };
  writeDatabase(store, scope, database);
  writePage(store, scope, page);
  return { database: projectDatabase(database), page: projectPage(page) };
}

function changeSchema(store: StoragePort, scope: Scope, payload: Json): Json {
  const input = strictPayload(payload, [
    "databaseId",
    "revision",
    "properties",
  ]);
  const databaseId = identifier(input.databaseId);
  const revision = safeCounter(input.revision);
  const properties = validateProperties(input.properties);
  const database = getDatabase(store, scope, databaseId);
  demand(database !== null, "DATABASE_MISSING");
  demand(!database.deleted, "DATABASE_DELETED");
  demand(database.revision === revision, "STALE_DATABASE");
  const nextRevision = nextCounter(database.revision, "REVISION_LIMIT");
  const byId = new Map(properties.map((property) => [property.id, property]));
  for (const record of allRecords(store, scope)) {
    if (record.databaseId !== databaseId) continue;
    for (const [key, value] of Object.entries(record.values)) {
      const property = byId.get(key);
      demand(property !== undefined, "SCHEMA_VALUE_LOSS");
      validateValue(property, value, false, "SCHEMA_VALUE_LOSS");
    }
  }
  const updated: DatabaseRow = {
    id: database.id,
    revision: nextRevision,
    properties,
    deleted: false,
  };
  writeDatabase(store, scope, updated);
  return { database: projectDatabase(updated) };
}

function createRecord(store: StoragePort, scope: Scope, payload: Json): Json {
  const input = strictPayload(payload, [
    "databaseId",
    "revision",
    "title",
    "values",
    "document",
  ]);
  const recordId = identifier(scope.documentId);
  const databaseId = identifier(input.databaseId);
  const revision = safeCounter(input.revision);
  const title = text(input.title, "INVALID_TITLE");
  const database = getDatabase(store, scope, databaseId);
  demand(database !== null, "DATABASE_MISSING");
  demand(!database.deleted, "DATABASE_DELETED");
  demand(database.revision === revision, "STALE_DATABASE");
  demand(getRecord(store, scope, recordId) === null, "ID_EXISTS");
  demand(getPage(store, scope, recordId) === null, "ID_EXISTS");
  const checkedValues = validateValues(
    input.values,
    database.properties,
    false,
  );
  const document = input.document;
  if (!isDocument(document)) return refuse("INVALID_DOCUMENT");
  const state = initialState(document);
  const pages = allPages(store, scope);
  const record: RecordRow = {
    id: recordId,
    databaseId,
    revision: 0,
    values: checkedValues as Record<string, Value>,
    title,
    deleted: false,
  };
  const page: PageRow = {
    id: recordId,
    parentId: null,
    order: nextOrder(pages, null),
  };
  writeRecord(store, scope, record);
  writePage(store, scope, page);
  store.set(DOCUMENTS, scopeKey(scope), clone(state));
  return { record: projectRecord(record), page: projectPage(page) };
}

function patchRecord(store: StoragePort, scope: Scope, payload: Json): Json {
  const input = strictPayload(payload, [
    "databaseId",
    "revision",
    "schemaRevision",
    "title",
    "values",
  ]);
  const recordId = identifier(scope.documentId);
  const databaseId = identifier(input.databaseId);
  const revision = safeCounter(input.revision);
  const schemaRevision = safeCounter(input.schemaRevision);
  const hasTitle = Object.hasOwn(input, "title");
  const hasValues = Object.hasOwn(input, "values");
  demand(hasTitle || hasValues, "EMPTY_PATCH");
  const record = getRecord(store, scope, recordId);
  demand(record !== null, "RECORD_MISSING");
  demand(!record.deleted, "RECORD_DELETED");
  demand(record.databaseId === databaseId, "OWNER_MISMATCH");
  demand(record.revision === revision, "STALE_RECORD");
  const database = getDatabase(store, scope, databaseId);
  demand(database !== null, "DATABASE_MISSING");
  demand(!database.deleted, "DATABASE_DELETED");
  demand(database.revision === schemaRevision, "STALE_SCHEMA");
  const nextRevision = nextCounter(record.revision, "REVISION_LIMIT");
  const title = hasTitle ? text(input.title, "INVALID_TITLE") : record.title;
  const values: MutableValues = { ...record.values };
  if (hasValues) {
    const changes = validateValues(input.values, database.properties, true);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete values[key];
      else values[key] = value;
    }
  }
  for (const key of Object.keys(values)) {
    demand(values[key] !== null && values[key] !== undefined, "INVALID_VALUE");
  }
  const updated: RecordRow = {
    id: record.id,
    databaseId: record.databaseId,
    revision: nextRevision,
    title,
    values: values as Record<string, Value>,
    deleted: false,
  };
  writeRecord(store, scope, updated);
  return { record: projectRecord(updated) };
}

function trashRecord(store: StoragePort, scope: Scope, payload: Json): Json {
  const input = strictPayload(payload, ["databaseId", "revision"]);
  const recordId = identifier(scope.documentId);
  const revision = safeCounter(input.revision);
  const record = getRecord(store, scope, recordId);
  demand(record !== null, "RECORD_MISSING");
  demand(!record.deleted, "RECORD_ALREADY_DELETED");
  demand(record.revision === revision, "STALE_RECORD");
  if (Object.hasOwn(input, "databaseId"))
    demand(
      record.databaseId === identifier(input.databaseId),
      "OWNER_MISMATCH",
    );
  const database = getDatabase(store, scope, record.databaseId);
  demand(database !== null, "DATABASE_MISSING");
  demand(!database.deleted, "DATABASE_DELETED");
  const updated: RecordRow = {
    ...record,
    revision: nextCounter(record.revision, "REVISION_LIMIT"),
    deleted: true,
  };
  writeRecord(store, scope, updated);
  return { record: projectRecord(updated) };
}

function restoreRecord(store: StoragePort, scope: Scope, payload: Json): Json {
  const input = strictPayload(payload, ["databaseId", "revision"]);
  const recordId = identifier(scope.documentId);
  const revision = safeCounter(input.revision);
  const record = getRecord(store, scope, recordId);
  demand(record !== null, "RECORD_MISSING");
  demand(record.deleted, "RECORD_NOT_DELETED");
  demand(record.revision === revision, "STALE_RECORD");
  if (Object.hasOwn(input, "databaseId"))
    demand(
      record.databaseId === identifier(input.databaseId),
      "OWNER_MISMATCH",
    );
  const database = getDatabase(store, scope, record.databaseId);
  demand(database !== null, "DATABASE_MISSING");
  demand(!database.deleted, "DATABASE_DELETED");
  const updated: RecordRow = {
    ...record,
    revision: nextCounter(record.revision, "REVISION_LIMIT"),
    deleted: false,
  };
  writeRecord(store, scope, updated);
  return { record: projectRecord(updated) };
}

function validateTree(pages: readonly PageRow[]): Map<string, PageRow> {
  const byId = new Map(pages.map((page) => [page.id, page]));
  for (const page of pages) {
    if (page.parentId !== null) demand(byId.has(page.parentId), "CORRUPT_TREE");
    const seen = new Set<string>();
    let cursor: PageRow | undefined = page;
    while (cursor !== undefined && cursor.parentId !== null) {
      demand(!seen.has(cursor.id), "CORRUPT_TREE");
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
      demand(cursor !== undefined, "CORRUPT_TREE");
    }
  }
  return byId;
}

function movePage(store: StoragePort, scope: Scope, payload: Json): Json {
  const input = strictPayload(payload, ["parentId", "beforeId"]);
  const pageId = identifier(scope.documentId);
  demand(Object.hasOwn(input, "parentId"), "INVALID_PARENT");
  demand(Object.hasOwn(input, "beforeId"), "INVALID_BEFORE");
  const parentId = nullableId(input.parentId, "INVALID_PARENT");
  const beforeId = nullableId(input.beforeId, "INVALID_BEFORE");
  demand(parentId !== pageId && beforeId !== pageId, "MOVE_CYCLE");
  const pages = allPages(store, scope);
  const byId = validateTree(pages);
  const page = byId.get(pageId);
  demand(page !== undefined, "PAGE_MISSING");
  if (parentId !== null) {
    demand(byId.has(parentId), "PARENT_MISSING");
    const seen = new Set<string>();
    let cursor: PageRow | undefined = byId.get(parentId);
    while (cursor !== undefined && cursor.parentId !== null) {
      demand(!seen.has(cursor.id), "CORRUPT_TREE");
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
      demand(cursor !== undefined, "CORRUPT_TREE");
    }
    let ancestor: PageRow | undefined = byId.get(parentId);
    while (ancestor !== undefined) {
      demand(ancestor.id !== pageId, "MOVE_CYCLE");
      ancestor =
        ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
    }
  }
  const oldParentId = page.parentId;
  const targetSiblings = pages
    .filter(
      (candidate) => candidate.parentId === parentId && candidate.id !== pageId,
    )
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  let index = targetSiblings.length;
  if (beforeId !== null) {
    const found = targetSiblings.findIndex(
      (candidate) => candidate.id === beforeId,
    );
    demand(found >= 0, "BEFORE_NOT_SIBLING");
    index = found;
  }
  targetSiblings.splice(index, 0, page);
  demand(targetSiblings.length < Number.MAX_SAFE_INTEGER, "ORDER_LIMIT");
  const writes = new Map<string, PageRow>();
  targetSiblings.forEach((candidate, order) => {
    writes.set(candidate.id, {
      id: candidate.id,
      parentId,
      order,
    });
  });
  if (oldParentId !== parentId) {
    const oldSiblings = pages
      .filter(
        (candidate) =>
          candidate.parentId === oldParentId && candidate.id !== pageId,
      )
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    oldSiblings.forEach((candidate, order) => {
      const existing = writes.get(candidate.id);
      if (existing === undefined)
        writes.set(candidate.id, {
          id: candidate.id,
          parentId: oldParentId,
          order,
        });
    });
  }
  for (const row of [...writes.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  ))
    writePage(store, scope, row);
  return { page: projectPage(writes.get(pageId)!) };
}

export function applyRecords(
  store: StoragePort,
  scope: Scope,
  command: ResourceCommand,
): Json {
  demand(store.db.isTransaction === true, "TRANSACTION_REQUIRED");
  demand(
    command !== null &&
      typeof command === "object" &&
      command.kind === "resource",
    "INVALID_COMMAND",
  );
  demand(typeof command.action === "string", "INVALID_ACTION");
  const payload = command.payload;
  switch (command.action) {
    case "db.create":
      return createDatabase(store, scope, payload);
    case "db.schema":
      return changeSchema(store, scope, payload);
    case "record.create":
      return createRecord(store, scope, payload);
    case "record.patch":
      return patchRecord(store, scope, payload);
    case "record.trash":
      return trashRecord(store, scope, payload);
    case "record.restore":
      return restoreRecord(store, scope, payload);
    case "page.move":
      return movePage(store, scope, payload);
    default:
      return refuse("UNSUPPORTED_ACTION");
  }
}

export function readRecords(store: StoragePort, scope: Scope): Json {
  const databases = allDatabases(store, scope).map(projectDatabase);
  const records = allRecords(store, scope).map(projectRecord);
  const pages = allPages(store, scope)
    .map(projectPage)
    .sort(
      (a, b) =>
        (a.parentId ?? "").localeCompare(b.parentId ?? "") ||
        a.order - b.order ||
        a.id.localeCompare(b.id),
    );
  const document = store.get(DOCUMENTS, scopeKey(scope));
  const view: RecordsView = {
    databases,
    records,
    pages,
    document: document === null ? null : (clone(document) as DocumentState),
  };
  return JSON.parse(canonical(view)) as Json;
}
