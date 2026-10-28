import { describe, expect, it } from "vitest";
import {
  emptyDatabase,
  type DatabaseSettings,
  type FilterNode,
} from "../src/shared/types";
import { applySettingsIntent } from "../src/renderer/settings-intent";
import {
  createViewIntent,
  duplicateViewIntent,
  viewPatchIntent,
} from "../src/database/settings-panel-intents";

function fixture(): DatabaseSettings {
  const { rows: _rows, ...settings } = emptyDatabase();
  const view = settings.views[0];
  view.filter = {
    kind: "group",
    id: "outer",
    conjunction: "and",
    conditions: [
      {
        kind: "condition",
        id: "condition-a",
        propertyId: "title",
        operator: "contains",
        value: "Task",
      },
      {
        kind: "group",
        id: "inner",
        conjunction: "or",
        conditions: [
          {
            kind: "condition",
            id: "condition-b",
            propertyId: "title",
            operator: "starts_with",
            value: "A",
          },
        ],
      },
    ],
  };
  view.sorts = [{ id: "sort-a", propertyId: "title", direction: "desc" }];
  return settings;
}

function filterIds(node: FilterNode): string[] {
  return [
    node.id,
    ...(node.kind === "group" ? node.conditions.flatMap(filterIds) : []),
  ];
}

describe("settings panel intents", () => {
  it("prepares new view IDs once, then replay uses exactly those IDs", () => {
    const settings = fixture();
    const before = structuredClone(settings);
    const command = createViewIntent(settings, "gallery");
    if (command.kind !== "createView") throw new Error("Expected create");
    const first = applySettingsIntent(settings, command);
    const second = applySettingsIntent(settings, structuredClone(command));
    expect(first).toEqual(second);
    expect(first.activeViewId).toBe(command.view.id);
    expect(first.views.at(-1)).toEqual(command.view);
    expect(command.view.filter.conditions).toEqual([]);
    expect(command.view.sorts).toEqual([]);
    expect(settings).toEqual(before);
  });

  it("duplicates nested filters and sorts with fresh stable IDs without modifying the source", () => {
    const settings = fixture();
    const source = structuredClone(settings.views[0]);
    const command = duplicateViewIntent(settings, source.id);
    if (command.kind !== "createView") throw new Error("Expected create");
    const copied = command.view;
    expect(copied.id).not.toBe(source.id);
    expect(
      filterIds(copied.filter).every(
        (id) => !filterIds(source.filter).includes(id),
      ),
    ).toBe(true);
    expect(copied.sorts[0].id).not.toBe(source.sorts[0].id);
    expect(copied.sorts[0].propertyId).toBe(source.sorts[0].propertyId);
    expect(copied.sorts[0].direction).toBe("desc");
    const output = applySettingsIntent(settings, command);
    expect(output.views[1]).toEqual(copied);
    expect(output.views[0]).toEqual(source);
    expect(applySettingsIntent(settings, structuredClone(command))).toEqual(
      output,
    );
    expect(settings.views[0]).toEqual(source);
  });

  it("captures only displayed fields and rejects a concurrent change to that field", () => {
    const settings = fixture();
    const view = settings.views[0];
    const patch = { filterText: "updated" };
    const command = viewPatchIntent(view, patch);
    expect(command).toEqual({
      kind: "viewPatch",
      viewId: view.id,
      base: { filterText: view.filterText },
      patch,
    });
    patch.filterText = "changed after submission";
    expect(applySettingsIntent(settings, command).views[0].filterText).toBe(
      "updated",
    );
    const concurrent = structuredClone(settings);
    concurrent.views[0].filterText = "external";
    expect(() => applySettingsIntent(concurrent, command)).toThrow(/conflict/);
  });

  it("keeps a copied maximum-length view name inside the storage schema", () => {
    const settings = fixture();
    settings.views[0].name = "名".repeat(200);
    const command = duplicateViewIntent(settings, settings.views[0].id);
    if (command.kind !== "createView") throw new Error("Expected create");
    expect(command.view.name.length).toBeLessThanOrEqual(200);
    expect(command.view.name).toContain("コピー");
    expect(() => applySettingsIntent(settings, command)).not.toThrow();
  });
});
