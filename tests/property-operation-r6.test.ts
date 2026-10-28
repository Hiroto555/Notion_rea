import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import { commitDatabaseOperation } from "../src/persistence/database-operations";
import { commitPropertyOperation, previewPropertyOperation, resolvePropertyOperation } from "../src/persistence/property-operations";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { convertPropertyValue, isStrictDate, preparePropertyOperation, type PropertyChange, type PropertyOperation } from "../src/shared/property-operation";
import { emptyDatabase, type FilterValue, type Property } from "../src/shared/types";
import { newPropertyDraft, propertyChangeFromDraft } from "../src/renderer/property-schema-draft";

function fixture(values: (FilterValue | undefined)[] = ["12", "0", undefined]) {
  mkdirSync(resolve("output"), {recursive: true});
  const root = mkdtempSync(resolve("output/r6-property-")), path = join(root, "workspace.sqlite");
  const store = new Store(path), repository = new RecordRepository(store);
  const {rows: _rows, ...settings} = emptyDatabase();
  settings.properties = [{id: "subject", name: "対象", type: "text"}, {id: "untouched", name: "残す列", type: "text"}];
  const owner = commitDatabaseOperation(store, prepareDatabaseCreation("Schema fixture", null, settings)).page!;
  const records = values.map((value, i) => repository.create(owner.id, `Row ${i}`, {...(value === undefined ? {} : {subject: value}), untouched: "keep"}));
  const preview = (change: PropertyChange, revision = store.get(owner.id).revision) => previewPropertyOperation(store,
    {type: "property:preview", databasePageId: owner.id, revision, change});
  const operation = (change: PropertyChange) => {
    const result = preview(change);
    if (!result.ok || !result.command) throw new Error(JSON.stringify(result.issues));
    return preparePropertyOperation(result.command);
  };
  const domain = () => ({pages: store.db.prepare("SELECT id,data FROM pages ORDER BY id").all(),
    members: store.db.prepare("SELECT * FROM record_memberships ORDER BY page_id").all(),
    versions: store.db.prepare("SELECT * FROM versions ORDER BY id").all(),
    valueVersions: store.db.prepare("SELECT * FROM record_value_versions ORDER BY version_id").all()});
  return {root, path, store, owner, repository, records, preview, operation, domain,
    close() {store.close(); rmSync(root, {recursive: true, force: true});}};
}

describe("property conversions", () => {
  const property = (type: Property["type"], options?: string[]): Property => ({id: "p", name: "P", type, ...(options ? {options} : {})});
  it.each([
    ["12", "text", "number", 12], ["0.5", "text", "number", 0.5],
    [true, "checkbox", "number", 1], [0, "number", "checkbox", false],
    ["false", "text", "checkbox", false], [false, "checkbox", "text", "false"],
    [12, "number", "text", "12"], ["2024-02-29", "text", "date", "2024-02-29"],
  ] as const)("preserves a lossless %s %s→%s conversion", (value, source, target, expected) => {
    expect(convertPropertyValue(value, property(source), property(target))).toEqual({ok: true, value: expected});
  });
  it.each([" 12", "12 ", "012", "1.0", "1e3", "", "Infinity", "9007199254740993"])("rejects lossy number spelling %s", (value) => {
    expect(convertPropertyValue(value, property("text"), property("number")).ok).toBe(false);
  });
  it("validates dates and explicit select options, including original source validity", () => {
    for (const value of ["2023-02-29", "1900-02-29", "2024-04-31", "0000-01-01", "2024-1-01", "tomorrow"])
      expect(isStrictDate(value)).toBe(false);
    expect(isStrictDate("2000-02-29")).toBe(true);
    expect(convertPropertyValue("keep", property("text"), property("select", ["keep"]))).toEqual({ok: true, value: "keep"});
    expect(convertPropertyValue("other", property("text"), property("select", ["keep"])).ok).toBe(false);
    expect(convertPropertyValue(1, property("number"), property("select", ["1"])).ok).toBe(false);
    expect(convertPropertyValue("bad", property("date"), property("text")).ok).toBe(false);
    expect(convertPropertyValue("orphan", property("select", ["keep"]), property("text")).ok).toBe(false);
  });
  it("retains stable added IDs and exact option spelling in the controlled form", () => {
    const draft = {...newPropertyDraft(), name: "状態", type: "select" as const, optionsText: "Open\nDone"};
    expect(propertyChangeFromDraft(draft)).toEqual(propertyChangeFromDraft(structuredClone(draft)));
    expect(propertyChangeFromDraft(draft)).toMatchObject({property: {id: draft.propertyId, options: ["Open", "Done"]}});
    expect(() => propertyChangeFromDraft({...draft, optionsText: "Open\n"})).toThrow();
    expect(() => propertyChangeFromDraft({...draft, optionsText: "Open\nOpen"})).toThrow();
  });
});

it("adds and renames columns without touching values, view IDs or record revisions", () => {
  const f = fixture();
  try {
    const original = f.repository.databaseProjection(f.owner.id), id = randomUUID();
    const added = commitPropertyOperation(f.store, f.operation({kind: "add", property: {id, name: "新列", type: "checkbox"}}));
    expect(added.status).toBe("applied");
    expect(added.database!.settings.properties.at(-1)).toEqual({id, name: "新列", type: "checkbox"});
    expect(added.database!.records).toEqual(original.records);
    const renamed = commitPropertyOperation(f.store, f.operation({kind: "rename", propertyId: id, name: "確認済み"}));
    expect(renamed.status).toBe("applied");
    expect(renamed.page!.revision).toBe(2);
    expect(renamed.database!.settings.properties.at(-1)).toEqual({id, name: "確認済み", type: "checkbox"});
    expect(renamed.database!.settings.views).toEqual(original.settings.views);
    expect(renamed.database!.records).toEqual(original.records);
    expect(readdirSync(f.root).filter((name) => name.includes(".pre-r6-property-"))).toEqual([]);
  } finally {f.close();}
});

it("previews all values and atomically converts active, missing and trashed rows with verified backup", () => {
  const f = fixture();
  try {
    new RecordLifecycle(f.store).trashRecord(f.records[1].pageId, 0);
    const before = f.domain(), beforeProjection = f.repository.databaseProjection(f.owner.id);
    const preview = f.preview({kind: "changeType", propertyId: "subject", type: "number"});
    expect(preview).toMatchObject({ok: true, recordCount: 3, changedCount: 2, requiresBackup: true});
    expect(f.domain()).toEqual(before);
    const operation = preparePropertyOperation(preview.command!);
    const result = commitPropertyOperation(f.store, operation);
    expect(result.status).toBe("applied");
    expect(result.page!.revision).toBe(1);
    expect(result.database!.settings.properties[0]).toEqual({id: "subject", name: "対象", type: "number"});
    for (const old of beforeProjection.records) {
      const row = result.database!.records.find((record) => record.pageId === old.pageId)!;
      expect(row.revision).toBe(old.revision + 1);
      expect(row.deletedAt).toBe(old.deletedAt);
      expect(row.values.untouched).toBe("keep");
    }
    expect(result.database!.records.find((record) => record.pageId === f.records[0].pageId)!.values.subject).toBe(12);
    expect(result.database!.records.find((record) => record.pageId === f.records[2].pageId)!.values).not.toHaveProperty("subject");
    expect(result.backup?.verified).toBe(true);
    expect(createHash("sha256").update(readFileSync(result.backup!.path)).digest("hex")).toBe(result.backup!.sha256);
    const backup = new DatabaseSync(result.backup!.path, {readOnly: true});
    try {
      expect(backup.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
      expect(backup.prepare("SELECT id,data FROM pages ORDER BY id").all()).toEqual(before.pages);
      expect(backup.prepare("SELECT * FROM record_memberships ORDER BY page_id").all()).toEqual(before.members);
    } finally {backup.close();}
    expect(f.store.db.prepare("SELECT count(*) AS n FROM record_value_versions").get()!.n).toBe(3);
    const oldWrite = f.store.commitSave({operationId: randomUUID(), sessionId: randomUUID(), seq: 1,
      pageId: f.records[2].pageId, databasePageId: f.owner.id, revision: 0, patch: {}, values: {subject: "stale"}});
    expect(oldWrite.status).toBe("rejected");
  } finally {f.close();}
});

it("rejects a nonconvertible row without any mutation or silently clearing it", () => {
  const f = fixture(["12", "012", "not numeric"]);
  try {
    const before = f.domain(), result = f.preview({kind: "changeType", propertyId: "subject", type: "number"});
    expect(result.ok).toBe(false);
    expect(result.command).toBeUndefined();
    expect(result.issues.map((issue) => issue.pageId).sort()).toEqual([f.records[1].pageId, f.records[2].pageId].sort());
    expect(f.domain()).toEqual(before);
  } finally {f.close();}
});

it.each([
  {values: ["true", "false"], type: "checkbox" as const, expected: [true, false]},
  {values: ["2024-02-29", "2025-01-01"], type: "date" as const, expected: ["2024-02-29", "2025-01-01"]},
  {values: ["Open", "Done"], type: "select" as const, expected: ["Open", "Done"]},
])("persists the $type conversion and can return to text without losing values", ({values, type, expected}) => {
  const f = fixture(values);
  try {
    const result = commitPropertyOperation(f.store, f.operation({kind: "changeType", propertyId: "subject", type,
      ...(type === "select" ? {options: ["Open", "Done"]} : {})}));
    expect(result.status).toBe("applied");
    expect(f.records.map((record) => f.repository.projection(record.pageId).values.subject)).toEqual(expected);
    if (type === "select") {
      const before = f.domain(), shrink = f.preview({kind: "changeType", propertyId: "subject", type, options: ["Open"]});
      expect(shrink.ok).toBe(false);
      expect(shrink.issues.some((issue) => issue.pageId === f.records[1].pageId)).toBe(true);
      expect(f.domain()).toEqual(before);
    }
    expect(commitPropertyOperation(f.store, f.operation({kind: "changeType", propertyId: "subject", type: "text"})).status).toBe("applied");
    expect(f.records.map((record) => f.repository.projection(record.pageId).values.subject)).toEqual(values);
  } finally {f.close();}
});

it("leaves originals untouched when the required backup cannot be created", () => {
  const f = fixture();
  try {
    const operation = f.operation({kind: "changeType", propertyId: "subject", type: "number"}), before = f.domain();
    Object.defineProperty(f.store, "path", {value: join(f.root, "missing-folder", "workspace.sqlite")});
    expect(commitPropertyOperation(f.store, operation).status).toBe("rejected");
    expect(f.domain()).toEqual(before);
    expect(resolvePropertyOperation(f.store, operation).status).toBe("rejected");
  } finally {f.close();}
});

it.each(["owner", "record", "membership"])("rejects %s changes after preview", (source) => {
  const f = fixture();
  try {
    const operation = f.operation({kind: "changeType", propertyId: "subject", type: "number"});
    if (source === "owner") {
      const projection = f.repository.databaseProjection(f.owner.id);
      commitDatabaseOperation(f.store, {operationId: randomUUID(), sessionId: randomUUID(), seq: 1,
        command: {kind: "updateDatabase", databasePageId: f.owner.id, revision: 0, patch: {title: "External"}, settings: projection.settings}});
    } else if (source === "record") f.repository.patch(f.records[0].pageId, f.owner.id, 0, {values: {subject: "99"}});
    else f.repository.create(f.owner.id, "New after preview", {subject: "5"});
    const before = f.domain();
    expect(commitPropertyOperation(f.store, operation).status).toBe("rejected");
    expect(f.domain()).toEqual(before);
    expect(readdirSync(f.root).filter((name) => name.includes(".pre-r6-property-"))).toEqual([]);
  } finally {f.close();}
});

it("keeps dependent view conditions intact and explains rejected type changes", () => {
  const f = fixture();
  try {
    const settings = structuredClone(f.repository.databaseProjection(f.owner.id).settings);
    settings.views[0].filter.conditions = [{id: "filter", kind: "condition", propertyId: "subject", operator: "contains", value: "1"}];
    settings.views[0].sorts = [{id: "sort", propertyId: "subject", direction: "asc"}];
    settings.views[0].groupBy = {propertyId: "subject", direction: "asc"};
    settings.sort = "subject";
    expect(commitDatabaseOperation(f.store, {operationId: randomUUID(), sessionId: randomUUID(), seq: 1,
      command: {kind: "updateDatabase", databasePageId: f.owner.id, revision: 0, patch: {}, settings}}).status).toBe("applied");
    const before = f.domain(), preview = f.preview({kind: "changeType", propertyId: "subject", type: "number"});
    expect(preview.ok).toBe(false);
    expect(preview.issues[0].viewId).toBe(settings.activeViewId);
    expect(preview.warnings[0].viewId).toBe(settings.activeViewId);
    expect(f.domain()).toEqual(before);
  } finally {f.close();}
});

it("rolls back values, revisions and histories when the owner write fails", () => {
  const f = fixture();
  try {
    const operation = f.operation({kind: "changeType", propertyId: "subject", type: "number"}), before = f.domain();
    f.store.db.exec(`CREATE TRIGGER block_owner BEFORE UPDATE ON pages WHEN NEW.id='${f.owner.id}' BEGIN SELECT RAISE(ABORT, 'owner blocked'); END`);
    expect(commitPropertyOperation(f.store, operation)).toMatchObject({status: "rejected", message: "owner blocked"});
    expect(f.domain()).toEqual(before);
    expect(resolvePropertyOperation(f.store, operation).status).toBe("rejected");
  } finally {f.close();}
});

it("rolls back the whole conversion when receipt insertion fails", () => {
  const f = fixture();
  try {
    const operation = f.operation({kind: "changeType", propertyId: "subject", type: "number"}), before = f.domain();
    f.store.db.exec("CREATE TRIGGER block_property_receipt BEFORE INSERT ON save_receipts BEGIN SELECT RAISE(ABORT, 'receipt blocked'); END");
    expect(() => commitPropertyOperation(f.store, operation)).toThrow(/receipt blocked/);
    expect(f.domain()).toEqual(before);
    expect(resolvePropertyOperation(f.store, operation).status).toBe("unknown");
  } finally {f.close();}
});

it("resolves a lost ACK after reopen, replays once, and protects operation IDs across command families", () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const operation = f.operation({kind: "changeType", propertyId: "subject", type: "number"});
    const applied = commitPropertyOperation(f.store, operation);
    expect(applied.status).toBe("applied");
    f.store.close(); reopened = new Store(f.path);
    expect(resolvePropertyOperation(reopened, operation)).toEqual(applied);
    expect(commitPropertyOperation(reopened, operation)).toEqual(applied);
    const changed = structuredClone(operation); changed.command.change = {kind: "rename", propertyId: "subject", name: "collision"};
    expect(commitPropertyOperation(reopened, changed).status).toBe("rejected");
    expect(commitDatabaseOperation(reopened, {...prepareDatabaseCreation("collision"), operationId: operation.operationId}).status).toBe("rejected");
    const page = reopened.create(null, "page", "Ordinary"), id = randomUUID();
    reopened.commitSave({operationId: id, sessionId: randomUUID(), seq: 1, pageId: page.id, databasePageId: null, revision: 0, patch: {title: "Saved"}});
    expect(commitPropertyOperation(reopened, {...operation, operationId: id}).status).toBe("rejected");
    expect(reopened.get(f.owner.id).revision).toBe(1);
  } finally {reopened?.close(); f.close();}
});

it("refuses forged preview hashes and unsettled read/resolve transactions", () => {
  const f = fixture();
  try {
    const operation: PropertyOperation = f.operation({kind: "rename", propertyId: "subject", name: "Updated"});
    expect(commitPropertyOperation(f.store, {...operation, command: {...operation.command, previewHash: "0".repeat(64)}}).status).toBe("rejected");
    f.store.db.exec("BEGIN");
    expect(() => resolvePropertyOperation(f.store, operation)).toThrow(/未確定/);
    expect(() => f.preview({kind: "rename", propertyId: "subject", name: "Updated"})).toThrow(/未確定/);
    f.store.db.exec("ROLLBACK");
  } finally {f.close();}
});
