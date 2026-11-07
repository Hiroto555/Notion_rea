export type ConflictRecordChange = "added" | "deleted" | "changed";

export type ConflictRecordSide = {
  databasePageId: string;
  title: string;
  deletedAt: number | null;
  position: number;
  values: string;
  valuesTruncated: boolean;
};

export type ConflictRecordDifference = {
  pageId: string;
  change: ConflictRecordChange;
  moved: boolean;
  local: ConflictRecordSide | null;
  remote: ConflictRecordSide | null;
};

export type ConflictRecordGroup = {
  databasePageId: string;
  totalChanged: number;
};

export type ConflictRecordComparison = {
  totalChanged: number;
  groupsTruncated: boolean;
  groups: ConflictRecordGroup[];
  differences: ConflictRecordDifference[];
};

const MAX_DIFFERENCES = 50;
const MAX_GROUPS = 50;
const MAX_VALUES = 500;
const MAX_VALUES_JSON = 1_000_000;
const MAX_RECORD_PROPERTIES = 1_000;
const MAX_PROPERTY_ID = 500;
const MAX_PAGE_ID = 500;

type ParsedRecordMembership = {
  pageId: string;
  databasePageId: string;
  title: string;
  deletedAt: number | null;
  position: number;
  valuesJson: string;
  valuesSignature: string;
};

type CheckpointShape = {
  payload?: { tables?: { pages?: unknown; record_memberships?: unknown } };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function requirePageId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PAGE_ID
  )
    throw new Error("invalid-candidate-record-membership");
  return value;
}

function validateValuesJson(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid-candidate-record-values");
  }
  if (!isPlainObject(value)) throw new Error("invalid-candidate-record-values");
  const entries = Object.entries(value);
  if (entries.length > MAX_RECORD_PROPERTIES)
    throw new Error("invalid-candidate-record-values");
  for (const [key, item] of entries) {
    if (!key || key.length > MAX_PROPERTY_ID)
      throw new Error("invalid-candidate-record-values");
    if (
      typeof item !== "string" &&
      typeof item !== "boolean" &&
      !(typeof item === "number" && Number.isFinite(item))
    )
      throw new Error("invalid-candidate-record-values");
  }
  // JSON object insertion order is not a user-visible value change.
  return JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function memberships(
  checkpointJson: string,
): Map<string, ParsedRecordMembership> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpointJson);
  } catch {
    throw new Error("invalid-candidate-record-memberships");
  }
  const tables = (parsed as CheckpointShape | null)?.payload?.tables;
  const rows = tables?.record_memberships;
  if (!Array.isArray(rows) || !Array.isArray(tables?.pages))
    throw new Error("invalid-candidate-record-memberships");
  const pages = new Map<string, { title: string; deletedAt: number | null }>();
  for (const row of tables.pages) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" ||
        typeof row[1] !== "string" || pages.has(row[0])) throw new Error("invalid-candidate-record-page");
    let page: unknown;
    try { page = JSON.parse(row[1]); } catch { throw new Error("invalid-candidate-record-page"); }
    if (!isPlainObject(page) || page.id !== row[0] || typeof page.title !== "string" ||
        !(page.deletedAt === null || (typeof page.deletedAt === "number" &&
          Number.isFinite(page.deletedAt) && page.deletedAt >= 0)))
      throw new Error("invalid-candidate-record-page");
    pages.set(row[0], {title: page.title, deletedAt: page.deletedAt});
  }
  const result = new Map<string, ParsedRecordMembership>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 4)
      throw new Error("invalid-candidate-record-membership");
    const pageId = requirePageId(row[0]);
    const databasePageId = requirePageId(row[1]);
    const position = row[2];
    if (
      typeof position !== "number" ||
      !Number.isSafeInteger(position) ||
      position < 0
    )
      throw new Error("invalid-candidate-record-membership");
    const valuesJson = row[3];
    if (
      typeof valuesJson !== "string" ||
      valuesJson.length > MAX_VALUES_JSON
    )
      throw new Error("invalid-candidate-record-membership");
    const valuesSignature = validateValuesJson(valuesJson);
    if (result.has(pageId))
      throw new Error("invalid-candidate-record-membership");
    const page = pages.get(pageId);
    if (!page) throw new Error("invalid-candidate-record-page");
    result.set(pageId, { pageId, databasePageId, position, valuesJson, valuesSignature, ...page });
  }
  return result;
}

const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

function excerpt(valuesJson: string): { text: string; truncated: boolean } {
  const text = valuesJson.replace(CONTROL_CHARACTERS, " ");
  if (text.length <= MAX_VALUES) return { text, truncated: false };
  let end = MAX_VALUES;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function side(row: ParsedRecordMembership): ConflictRecordSide {
  const safe = excerpt(row.valuesJson);
  return {
    databasePageId: row.databasePageId,
    title: row.title,
    deletedAt: row.deletedAt,
    position: row.position,
    values: safe.text,
    valuesTruncated: safe.truncated,
  };
}

export function compareConflictRecords(
  localJson: string,
  remoteJson: string,
): ConflictRecordComparison {
  const local = memberships(localJson);
  const remote = memberships(remoteJson);
  const pageIds = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const changed: ConflictRecordDifference[] = [];
  for (const pageId of pageIds) {
    const left = local.get(pageId);
    const right = remote.get(pageId);
    if (
      left &&
      right &&
      left.databasePageId === right.databasePageId &&
      left.position === right.position &&
      left.title === right.title &&
      (left.deletedAt === null) === (right.deletedAt === null) &&
      left.valuesSignature === right.valuesSignature
    )
      continue;
    changed.push({
      pageId,
      change: !left ? "added" : !right ? "deleted" : "changed",
      moved:
        !!left && !!right && left.databasePageId !== right.databasePageId,
      local: left ? side(left) : null,
      remote: right ? side(right) : null,
    });
  }

  const affected = new Map<string, Set<string>>();
  const mark = (databasePageId: string, pageId: string): void => {
    const pageIdsForDatabase = affected.get(databasePageId);
    if (pageIdsForDatabase) pageIdsForDatabase.add(pageId);
    else affected.set(databasePageId, new Set([pageId]));
  };
  for (const difference of changed) {
    if (difference.local)
      mark(difference.local.databasePageId, difference.pageId);
    if (difference.remote)
      mark(difference.remote.databasePageId, difference.pageId);
  }
  const databasePageIds = [...affected.keys()].sort();

  return {
    totalChanged: changed.length,
    groupsTruncated: databasePageIds.length > MAX_GROUPS,
    groups: databasePageIds.slice(0, MAX_GROUPS).map((databasePageId) => ({
      databasePageId,
      totalChanged: affected.get(databasePageId)!.size,
    })),
    differences: changed.slice(0, MAX_DIFFERENCES),
  };
}
