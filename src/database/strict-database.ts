import { normalizeDatabaseData } from "./model";
import { fileFits } from "../shared/limits";

/** Reject unknown or lossy data instead of normalizing it away. */
export function isLosslessDatabaseData(value: unknown): boolean {
  const result = normalizeDatabaseData(value);
  return (
    result.ok &&
    hasOnlyKnownFields(value) &&
    preservesKnownInput(value, result.data) &&
    !result.data.rows.some(
      (row) =>
        row.title.length > 500 ||
        Object.keys(row.values).length > 1000 ||
        !fileFits(JSON.stringify(row.values)),
    )
  );
}

/** Require each persisted field/value to survive the existing normalizer.
 * Only the top-level known schema version may legitimately be upgraded. */
function preservesKnownInput(
  source: unknown,
  normalized: unknown,
  root = true,
): boolean {
  if (
    root &&
    source &&
    normalized &&
    typeof source === "object" &&
    typeof normalized === "object" &&
    !Array.isArray(source) &&
    !Array.isArray(normalized)
  ) {
    const old = source as Record<string, unknown>;
    const next = normalized as Record<string, unknown>;
    return Object.entries(old).every(([key, value]) =>
      key === "schemaVersion"
        ? value === 1 || value === 2
        : Object.hasOwn(next, key) &&
          preservesKnownInput(value, next[key], false),
    );
  }
  if (Array.isArray(source))
    return (
      Array.isArray(normalized) &&
      source.length === normalized.length &&
      source.every((v, i) => preservesKnownInput(v, normalized[i], false))
    );
  if (source && typeof source === "object") {
    if (
      !normalized ||
      typeof normalized !== "object" ||
      Array.isArray(normalized)
    )
      return false;
    return Object.entries(source).every(
      ([key, value]) =>
        Object.hasOwn(normalized, key) &&
        preservesKnownInput(
          value,
          (normalized as Record<string, unknown>)[key],
          false,
        ),
    );
  }
  return Object.is(source, normalized);
}

function hasOnlyKnownFields(value: unknown): boolean {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const keys = (v: unknown, allowed: string[]) =>
    object(v) && Object.keys(v).every((key) => allowed.includes(key));
  if (
    !keys(value, [
      "schemaVersion",
      "properties",
      "rows",
      "views",
      "activeViewId",
      "view",
      "filter",
      "sort",
    ])
  )
    return false;
  const db = value as Record<string, unknown>;
  if (
    !Array.isArray(db.properties) ||
    !db.properties.every((p) => keys(p, ["id", "name", "type", "options"]))
  )
    return false;
  if (
    !Array.isArray(db.rows) ||
    !db.rows.every((r) => keys(r, ["id", "title", "values"]))
  )
    return false;
  if (db.views === undefined) return true;
  if (!Array.isArray(db.views)) return false;
  const filterKnown = (node: unknown): boolean => {
    if (!object(node)) return false;
    if (node.kind === "condition")
      return keys(node, ["kind", "id", "propertyId", "operator", "value"]);
    return (
      node.kind === "group" &&
      keys(node, ["kind", "id", "conjunction", "conditions"]) &&
      Array.isArray(node.conditions) &&
      node.conditions.every(filterKnown)
    );
  };
  return db.views.every(
    (v) =>
      object(v) &&
      keys(v, [
        "id",
        "name",
        "type",
        "filterText",
        "filter",
        "sorts",
        "groupBy",
      ]) &&
      filterKnown(v.filter) &&
      (v.sorts === undefined ||
        (Array.isArray(v.sorts) &&
          v.sorts.every((s) => keys(s, ["id", "propertyId", "direction"])))) &&
      (v.groupBy == null || keys(v.groupBy, ["propertyId", "direction"])),
  );
}
