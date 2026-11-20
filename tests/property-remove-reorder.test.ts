import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import { commitDatabaseOperation } from "../src/persistence/database-operations";
import {
  commitPropertyOperation,
  previewPropertyOperation,
  resolvePropertyOperation,
} from "../src/persistence/property-operations";
import { privateRequestFailureReply, privateRequestSuccessReply } from "../src/main/private-request-envelope";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import { createDesktopRootBindings } from "../src/renderer/desktop-api";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import {
  preparePropertyOperation,
  propertyChangeRequiresBackup,
  propertyChangeSchema,
  type PropertyChange,
} from "../src/shared/property-operation";
import {
  emptyDatabase,
  type DatabaseView,
  type FilterValue,
  type Property,
  type Request,
} from "../src/shared/types";
import {
  movePropertyDraft,
  propertyChangeFromDraft,
  removePropertyDraft,
} from "../src/renderer/property-schema-draft";
import { PropertySchemaPanel } from "../src/renderer/PropertySchemaPanel";

const defaultProperties: Property[] = [
  { id: "subject", name: "対象", type: "text" },
  { id: "untouched", name: "残す列", type: "text" },
];

function fixture(options: { properties?: Property[]; views?: DatabaseView[]; values?: (FilterValue | undefined)[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "folio-p8-property-"));
  const state = { store: undefined as Store | undefined };
  onTestFinished(() => {
    state.store?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const path = join(root, "workspace.sqlite");
  const store = (state.store = new Store(path));
  const repository = new RecordRepository(store);
  const { rows: _rows, ...settings } = emptyDatabase();
  settings.properties = options.properties ?? defaultProperties;
  if (options.views) {
    settings.views = options.views;
    settings.activeViewId = options.views[0].id;
  }
  const owner = commitDatabaseOperation(store, prepareDatabaseCreation("P8 fixture", null, settings)).page!;
  const records = (options.values ?? ["12", "0", undefined]).map((value, i) =>
    repository.create(owner.id, `Row ${i}`, { ...(value === undefined ? {} : { subject: value }), untouched: "keep" }));
  const preview = (change: PropertyChange, revision = store.get(owner.id).revision) =>
    previewPropertyOperation(store, { type: "property:preview", databasePageId: owner.id, revision, change });
  const operation = (change: PropertyChange) => {
    const result = preview(change);
    if (!result.ok || !result.command) throw new Error(JSON.stringify(result.issues));
    return preparePropertyOperation(result.command);
  };
  const domain = () => ({
    pages: store.db.prepare("SELECT id,data FROM pages ORDER BY id").all(),
    members: store.db.prepare("SELECT * FROM record_memberships ORDER BY page_id").all(),
    versions: store.db.prepare("SELECT * FROM versions ORDER BY id").all(),
    valueVersions: store.db.prepare("SELECT * FROM record_value_versions ORDER BY version_id").all(),
  });
  return { root, path, store, owner, repository, records, preview, operation, domain };
}

describe("property remove", () => {
  it("previews then deletes the column from every member with a verified backup", () => {
    const f = fixture();
    new RecordLifecycle(f.store).trashRecord(f.records[1].pageId, 0);
    const before = f.domain(), beforeProjection = f.repository.databaseProjection(f.owner.id);
    const preview = f.preview({ kind: "remove", propertyId: "subject" });
    expect(preview).toMatchObject({ ok: true, recordCount: 3, changedCount: 2, requiresBackup: true });
    expect(preview.property).toEqual({ id: "subject", name: "対象", type: "text" });
    expect(preview.changes).toHaveLength(3);
    const missing = preview.changes.find((entry) => entry.pageId === f.records[2].pageId)!;
    expect(missing.changed).toBe(false);
    expect(missing).not.toHaveProperty("before");
    expect(preview.changes.find((entry) => entry.pageId === f.records[1].pageId)!.deleted).toBe(true);
    expect(f.domain()).toEqual(before);

    const operation = preparePropertyOperation(preview.command!);
    const result = commitPropertyOperation(f.store, operation);
    expect(result.status).toBe("applied");
    expect(result.commandKind).toBe("remove");
    expect(result.page!.revision).toBe(1);
    expect(result.database!.settings.properties.map((p) => p.id)).toEqual(["untouched"]);
    for (const old of beforeProjection.records) {
      const row = result.database!.records.find((record) => record.pageId === old.pageId)!;
      expect(row.revision).toBe(old.revision + 1);
      expect(row.deletedAt).toBe(old.deletedAt);
      expect(row.values).toEqual({ untouched: "keep" });
    }
    const rows = f.store.db
      .prepare("SELECT values_json FROM record_memberships WHERE database_page_id=?")
      .all(f.owner.id) as { values_json: string }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(JSON.parse(row.values_json)).toEqual({ untouched: "keep" });
    expect(f.store.db.prepare("SELECT count(*) AS n FROM record_value_versions").get()!.n).toBe(3);
    expect(result.backup?.verified).toBe(true);
    expect(createHash("sha256").update(readFileSync(result.backup!.path)).digest("hex")).toBe(result.backup!.sha256);
    expect(resolvePropertyOperation(f.store, operation)).toEqual(result);
  });

  it("blocks removal while filter, sort or group conditions reference the column", () => {
    const f = fixture();
    const settings = structuredClone(f.repository.databaseProjection(f.owner.id).settings);
    settings.views[0].filter.conditions = [
      { id: "filter", kind: "condition", propertyId: "subject", operator: "contains", value: "1" },
    ];
    settings.views[0].sorts = [{ id: "sort", propertyId: "subject", direction: "asc" }];
    settings.views[0].groupBy = { propertyId: "subject", direction: "asc" };
    settings.sort = "subject";
    expect(
      commitDatabaseOperation(f.store, {
        operationId: randomUUID(),
        sessionId: randomUUID(),
        seq: 1,
        command: { kind: "updateDatabase", databasePageId: f.owner.id, revision: 0, patch: {}, settings },
      }).status,
    ).toBe("applied");
    const before = f.domain();
    const preview = f.preview({ kind: "remove", propertyId: "subject" });
    expect(preview.ok).toBe(false);
    expect(preview.command).toBeUndefined();
    expect(preview.issues.length).toBeGreaterThanOrEqual(2);
    expect(preview.issues.every((issue) => issue.viewId === settings.activeViewId)).toBe(true);
    expect(f.domain()).toEqual(before);
  });

  it("blocks removal of implicit calendar and board grouping columns only", () => {
    const view = (id: string, name: string, type: DatabaseView["type"]): DatabaseView => ({
      id,
      name,
      type,
      filterText: "",
      filter: { kind: "group", id: id + "-filter", conjunction: "and", conditions: [] },
      sorts: [],
      groupBy: null,
    });
    const f = fixture({
      properties: [
        { id: "date", name: "期日", type: "date" },
        { id: "status", name: "状態", type: "select", options: ["A", "B"] },
        { id: "note", name: "メモ", type: "text" },
      ],
      views: [view("v-cal", "カレンダー", "calendar"), view("v-board", "ボード", "board")],
    });
    expect(f.preview({ kind: "remove", propertyId: "date" }).ok).toBe(false);
    expect(f.preview({ kind: "remove", propertyId: "status" }).ok).toBe(false);
    expect(f.preview({ kind: "remove", propertyId: "note" }).ok).toBe(true);
  });

  it("reports an unknown column as a preview issue", () => {
    const f = fixture();
    const preview = f.preview({ kind: "remove", propertyId: "missing" });
    expect(preview.ok).toBe(false);
    expect(preview.issues[0].message).toBe("変更対象の列がありません。");
  });
});

describe("property reorder", () => {
  it("previews and commits a new column order without touching record values", () => {
    const f = fixture();
    const preview = f.preview({ kind: "reorder", propertyIds: ["untouched", "subject"] });
    expect(preview).toMatchObject({ ok: true, requiresBackup: false, changes: [] });
    expect(preview.property).toBeUndefined();
    const operation = preparePropertyOperation(preview.command!);
    const result = commitPropertyOperation(f.store, operation);
    expect(result.status).toBe("applied");
    expect(result.commandKind).toBe("reorder");
    expect(result.backup).toBeUndefined();
    expect(result.database!.settings.properties.map((p) => p.id)).toEqual(["untouched", "subject"]);
    expect(result.page!.revision).toBe(1);
    for (const row of result.database!.records) {
      expect(row.revision).toBe(0);
      expect(row.values).toEqual(f.repository.projection(row.pageId).values);
    }
    expect(readdirSync(f.root).filter((name) => name.includes(".pre-r6-property-"))).toEqual([]);
    expect(resolvePropertyOperation(f.store, operation)).toEqual(result);
  });

  it.each([
    { propertyIds: ["subject"], label: "a missing id" },
    { propertyIds: ["subject", "subject"], label: "a duplicate id" },
    { propertyIds: ["subject", "untouched", "extra"], label: "an extra id" },
  ])("rejects a reorder with $label", ({ propertyIds }) => {
    const f = fixture();
    const before = f.domain();
    const preview = f.preview({ kind: "reorder", propertyIds });
    expect(preview.ok).toBe(false);
    expect(preview.issues[0].message).toContain("列の並び順が現在の列と一致しません");
    expect(f.domain()).toEqual(before);
  });

  it("rejects a reorder that changes nothing", () => {
    const f = fixture();
    const preview = f.preview({ kind: "reorder", propertyIds: ["subject", "untouched"] });
    expect(preview.ok).toBe(false);
    expect(preview.issues[0].message).toBe("列の並び順に変更がありません。");
  });
});

describe("property change schema and drafts", () => {
  it("accepts remove and reorder, rejecting extra keys and oversize orders", () => {
    expect(propertyChangeSchema.safeParse({ kind: "remove", propertyId: "p" }).success).toBe(true);
    expect(propertyChangeSchema.safeParse({ kind: "reorder", propertyIds: ["a", "b"] }).success).toBe(true);
    expect(propertyChangeSchema.safeParse({ kind: "remove", propertyId: "p", extra: 1 }).success).toBe(false);
    expect(propertyChangeSchema.safeParse({ kind: "reorder", propertyIds: Array(1001).fill("x") }).success).toBe(false);
    expect(propertyChangeRequiresBackup("remove")).toBe(true);
    expect(propertyChangeRequiresBackup("changeType")).toBe(true);
    expect(propertyChangeRequiresBackup("reorder")).toBe(false);
    expect(propertyChangeRequiresBackup("add")).toBe(false);
  });

  it("builds remove and accumulated reorder drafts", () => {
    const properties: Property[] = [
      { id: "a", name: "A列", type: "text" },
      { id: "b", name: "B列", type: "number" },
      { id: "c", name: "C列", type: "date" },
    ];
    expect(propertyChangeFromDraft(removePropertyDraft(properties[1]))).toEqual({ kind: "remove", propertyId: "b" });
    const moved = movePropertyDraft(properties, null, "b", -1)!;
    expect(moved.kind).toBe("reorder");
    expect(moved.order).toEqual(["b", "a", "c"]);
    expect(propertyChangeFromDraft(moved)).toEqual({ kind: "reorder", propertyIds: ["b", "a", "c"] });
    const movedAgain = movePropertyDraft(properties, moved, "c", -1)!;
    expect(movedAgain.order).toEqual(["b", "c", "a"]);
    expect(movePropertyDraft(properties, null, "a", -1)).toBeNull();
    expect(movePropertyDraft(properties, null, "c", 1)).toBeNull();
    expect(movePropertyDraft(properties, null, "unknown", 1)).toBeNull();
    expect(movePropertyDraft(properties, movedAgain, "b", -1)).toBeNull();
  });
});

describe("remove/reorder over the real request lane", () => {
  function structuralLane(f: { store: Store }) {
    const sent: Request[] = [];
    const handle = (request: Request): unknown => {
      switch (request.type) {
        case "property:preview":
          return previewPropertyOperation(f.store, request);
        case "property:commit":
          return commitPropertyOperation(f.store, request.operation);
        case "property:resolve":
          return resolvePropertyOperation(f.store, request.operation);
        default:
          throw new Error(`unexpected ${request.type}`);
      }
    };
    const preload = createPrivateRequestPreload(async (request) => {
      sent.push(request);
      try {
        return privateRequestSuccessReply({ value: handle(request), requestType: request.type });
      } catch (original) {
        return privateRequestFailureReply({ original, requestType: request.type });
      }
    });
    const bindings = createDesktopRootBindings({ requestDiagnostic: preload.requestDiagnostic });
    return { bindings, sent };
  }

  it("round-trips reorder then remove with their command kinds", async () => {
    const f = fixture();
    const { bindings, sent } = structuralLane(f);
    const owner = f.store.get(f.owner.id);
    const reorderPreview = await bindings.writable.structure.previewProperty(f.owner.id, owner.revision, {
      kind: "reorder",
      propertyIds: ["untouched", "subject"],
    });
    expect(reorderPreview.ok).toBe(true);
    const reorderOperation = preparePropertyOperation(reorderPreview.command!);
    const reordered = await bindings.writable.structure.commitProperty(reorderOperation);
    expect(reordered.status).toBe("applied");
    expect(reordered.commandKind).toBe("reorder");
    expect(await bindings.writable.structure.resolveProperty(reorderOperation)).toEqual(reordered);

    const removePreview = await bindings.writable.structure.previewProperty(f.owner.id, reordered.page!.revision, {
      kind: "remove",
      propertyId: "subject",
    });
    expect(removePreview.ok).toBe(true);
    expect(removePreview.requiresBackup).toBe(true);
    const removeOperation = preparePropertyOperation(removePreview.command!);
    const removed = await bindings.writable.structure.commitProperty(removeOperation);
    expect(removed.status).toBe("applied");
    expect(removed.commandKind).toBe("remove");
    expect(removed.backup?.verified).toBe(true);
    expect(await bindings.writable.structure.resolveProperty(removeOperation)).toEqual(removed);
    expect(sent.map((request) => request.type)).toEqual([
      "property:preview",
      "property:commit",
      "property:resolve",
      "property:preview",
      "property:commit",
      "property:resolve",
    ]);
  });
});

describe("PropertySchemaPanel remove/reorder markup", () => {
  const { rows: _rows, ...settings } = emptyDatabase();
  settings.properties = [
    { id: "a", name: "A列", type: "text" },
    { id: "b", name: "B列", type: "number" },
    { id: "c", name: "C列", type: "date" },
  ];
  const render = (draft: Parameters<typeof PropertySchemaPanel>[0]["draft"]) =>
    renderToStaticMarkup(
      createElement(PropertySchemaPanel, {
        settings,
        draft,
        status: "idle",
        onDraftChange: () => undefined,
        onPreview: () => undefined,
        onApply: () => undefined,
        onResolve: () => undefined,
      }),
    );

  it("renders up/down/remove controls per row with boundary disabling", () => {
    const html = render(null);
    for (const name of ["A列", "B列", "C列"]) {
      expect(html).toContain(`aria-label="列を上へ移動 ${name}"`);
      expect(html).toContain(`aria-label="列を下へ移動 ${name}"`);
      expect(html).toContain(`aria-label="列を削除 ${name}"`);
    }
    const upFirst = html.match(/<button[^>]*aria-label="列を上へ移動 A列"[^>]*>/)![0];
    const downLast = html.match(/<button[^>]*aria-label="列を下へ移動 C列"[^>]*>/)![0];
    expect(upFirst).toContain("disabled");
    expect(downLast).toContain("disabled");
    expect(html.match(/aria-label="列を上へ移動 B列"[^>]*>/)![0]).not.toContain("disabled");
    expect(html.match(/aria-label="列を下へ移動 B列"[^>]*>/)![0]).not.toContain("disabled");
  });

  it("shows the remove legend and hides the type inputs", () => {
    const html = render(removePropertyDraft(settings.properties[1]));
    expect(html).toContain("列を削除");
    expect(html).toContain("列「B列」を削除します");
    expect(html).not.toContain('aria-label="列の型"');
  });

  it("shows the accumulated draft order in the reorder form and list", () => {
    const draft = movePropertyDraft(settings.properties, null, "a", 1)!;
    expect(draft.order).toEqual(["b", "a", "c"]);
    const html = render(draft);
    expect(html).toContain("列の並び順を変更");
    expect(html).toContain("行の値は変更しません。");
    const listAt = html.indexOf("r6-property-list");
    const segment = html.slice(listAt);
    expect(segment.indexOf("B列")).toBeLessThan(segment.indexOf("A列"));
    expect(segment.indexOf("A列")).toBeLessThan(segment.indexOf("C列"));
    const formAt = html.indexOf("<ol>");
    expect(formAt).toBeGreaterThan(-1);
    const order = html.slice(formAt);
    expect(order.indexOf("B列")).toBeLessThan(order.indexOf("A列"));
    expect(order.indexOf("A列")).toBeLessThan(order.indexOf("C列"));
  });
});
