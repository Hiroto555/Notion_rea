import { expect, it } from "vitest";
import { emptyDatabase, requestSchema } from "../src/shared/types";

const legacy = () => ({
  schemaVersion: 1,
  properties: [{ id: "status", name: "Status", type: "text" }],
  rows: [{ id: "row-1", title: "Old", values: { status: "kept" } }],
  view: "board",
  filter: "kept",
  sort: "-status",
});
const multiView = () => ({
  ...emptyDatabase(),
  properties: [{ id: "status", name: "Status", type: "text" }],
  rows: [{ id: "row-1", title: "Current", values: { status: "kept" } }],
});
const input = (database: unknown) => ({
  type: "update", id: "page", revision: 0, patch: { database },
});

it.each(["database", "property", "row", "view", "filter", "sort", "group"])(
  "rejects unknown %s fields before IPC normalization",
  (field) => {
    const db = multiView() as any;
    db.views[0].sorts = [{ id: "sort", propertyId: "status", direction: "asc" }];
    db.views[0].groupBy = { propertyId: "status", direction: "asc" };
    expect(requestSchema.safeParse(input(db)).success).toBe(true);
    const target = field === "database" ? db
      : field === "property" ? db.properties[0]
      : field === "row" ? db.rows[0]
      : field === "view" ? db.views[0]
      : field === "filter" ? db.views[0].filter
      : field === "sort" ? db.views[0].sorts[0]
      : db.views[0].groupBy;
    target.futureField = { text: "do not discard" };
    const original = structuredClone(db);
    expect(requestSchema.safeParse(input(db)).success).toBe(false);
    expect(db).toEqual(original);
  },
);

it("rejects known fields whose values would be silently normalized away", () => {
  expect(requestSchema.safeParse(input({ ...legacy(), view: "future-view" })).success).toBe(false);
  expect(requestSchema.safeParse(input({ ...multiView(), activeViewId: "missing-view" })).success).toBe(false);
});

it("rejects unknown nested fields in a legacy database", () => {
  const db = legacy() as any;
  db.rows[0].futureField = "keep";
  expect(requestSchema.safeParse(input(db)).success).toBe(false);
});

it("accepts and normalizes a supported single-view legacy database without losing fields", () => {
  const source = legacy();
  const parsed = requestSchema.safeParse(input(source));
  expect(parsed.success).toBe(true);
  if (!parsed.success || parsed.data.type !== "update") return;
  const db = parsed.data.patch.database;
  expect(db).toMatchObject({ schemaVersion: 2, properties: source.properties, rows: source.rows, view: "board", filter: "kept", sort: "-status" });
  expect(db?.views[0]).toMatchObject({ type: "board", filterText: "kept", sorts: [{ propertyId: "status", direction: "desc" }] });
  expect(source).toEqual(legacy());
});

it("accepts a supported multiview database with values intact", () => {
  const source = multiView();
  const parsed = requestSchema.safeParse(input(source));
  expect(parsed.success).toBe(true);
  if (!parsed.success || parsed.data.type !== "update") return;
  expect(parsed.data.patch.database).toEqual(source);
});
