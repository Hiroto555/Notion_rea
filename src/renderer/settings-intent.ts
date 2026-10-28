import {
  deleteView,
  moveView,
  normalizeDatabaseData,
  setActiveView,
  updateView,
} from "../database/model";
import {
  requestSchema,
  type DatabaseData,
  type DatabaseSettings,
  type DatabaseView,
  type Property,
} from "../shared/types";

/** Semantic commands carry the exact values and identifiers the user observed.
 * Create receives a fully prepared view; it never generates IDs during replay. */
export type SettingsIntent =
  | {
      kind: "viewPatch";
      viewId: string;
      base: Partial<Omit<DatabaseView, "id">>;
      patch: Partial<Omit<DatabaseView, "id">>;
    }
  | { kind: "activeView"; base: string; viewId: string }
  | {
      kind: "createView";
      view: DatabaseView;
      baseOrder: string[];
      baseActive: string;
      afterViewId: string | null;
      source?: DatabaseView;
    }
  | { kind: "deleteView"; base: DatabaseView }
  | {
      kind: "moveView";
      viewId: string;
      baseOrder: string[];
      baseActive: string;
      delta: -1 | 1;
    }
  | { kind: "addProperty"; property: Property; basePropertyIds: string[] };

/** Structural equality disregards object key order, but not array order or values. */
export function sameSettingsValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameSettingsValue(v, b[i]))
    );
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.keys(a).sort(),
    right = Object.keys(b).sort();
  return (
    left.length === right.length &&
    left.every(
      (key, i) =>
        key === right[i] &&
        sameSettingsValue(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
}

/** Match Store's lossless input and normalization before issuing a write. */
export function canonicalSettings(value: DatabaseSettings): DatabaseSettings {
  const parsed = requestSchema.parse({
    type: "database:settings",
    databasePageId: "settings-validation",
    revision: 0,
    settings: value,
  });
  if (parsed.type !== "database:settings")
    throw new Error("Invalid database settings");
  const normalized = normalizeDatabaseData({ ...parsed.settings, rows: [] });
  if (!normalized.ok || normalized.data.rows.length)
    throw new Error("Invalid database settings");
  const { rows: _rows, ...settings } = normalized.data;
  return settings;
}

/** Apply one intent to a known canonical state, fail closed on a changed base. */
export function applySettingsIntent(
  input: DatabaseSettings,
  command: SettingsIntent,
): DatabaseSettings {
  const keysByKind: Record<string, readonly string[]> = {
    viewPatch: ["kind", "viewId", "base", "patch"],
    activeView: ["kind", "base", "viewId"],
    createView: [
      "kind",
      "view",
      "baseOrder",
      "baseActive",
      "afterViewId",
      "source",
    ],
    deleteView: ["kind", "base"],
    moveView: ["kind", "viewId", "baseOrder", "baseActive", "delta"],
    addProperty: ["kind", "property", "basePropertyIds"],
  };
  const allowed = command && keysByKind[command.kind];
  if (!allowed || Object.keys(command).some((key) => !allowed.includes(key)))
    throw new Error(
      "Unsupported settings intent fields; pending changes retained",
    );
  const settings = canonicalSettings(input);
  const data: DatabaseData = { ...settings, rows: [] };
  let next: DatabaseData;
  switch (command.kind) {
    case "viewPatch": {
      const view = settings.views.find((v) => v.id === command.viewId);
      const keys = Object.keys(command.patch);
      const allowed = [
        "name",
        "type",
        "filterText",
        "filter",
        "sorts",
        "groupBy",
      ];
      if (
        !view ||
        !keys.length ||
        keys.some((k) => !allowed.includes(k)) ||
        !sameSettingsValue(
          keys.slice().sort(),
          Object.keys(command.base).sort(),
        ) ||
        keys.some(
          (k) =>
            !sameSettingsValue(
              (view as unknown as Record<string, unknown>)[k],
              (command.base as Record<string, unknown>)[k],
            ),
        )
      )
        throw new Error("Settings view field conflict");
      next = updateView(data, command.viewId, command.patch);
      break;
    }
    case "activeView":
      if (settings.activeViewId !== command.base)
        throw new Error("Settings active view conflict");
      next = setActiveView(data, command.viewId);
      break;
    case "createView": {
      const order = settings.views.map((view) => view.id);
      if (
        !sameSettingsValue(order, command.baseOrder) ||
        settings.activeViewId !== command.baseActive ||
        settings.views.some((view) => view.id === command.view.id)
      )
        throw new Error("Settings create view conflict");
      if (
        command.source &&
        !sameSettingsValue(
          settings.views.find((view) => view.id === command.source!.id),
          command.source,
        )
      )
        throw new Error("Settings source view conflict");
      const index =
        command.afterViewId === null
          ? order.length
          : order.indexOf(command.afterViewId) + 1;
      if (command.afterViewId !== null && index === 0)
        throw new Error("Settings view position conflict");
      const views = [...settings.views];
      views.splice(index, 0, structuredClone(command.view));
      next = setActiveView(
        { ...data, views, activeViewId: command.view.id },
        command.view.id,
      );
      break;
    }
    case "deleteView": {
      const current = settings.views.find(
        (view) => view.id === command.base.id,
      );
      if (
        !current ||
        !sameSettingsValue(current, command.base) ||
        settings.views.length <= 1
      )
        throw new Error("Settings delete view conflict");
      next = deleteView(data, command.base.id);
      break;
    }
    case "moveView":
      if (
        !sameSettingsValue(
          settings.views.map((view) => view.id),
          command.baseOrder,
        ) ||
        settings.activeViewId !== command.baseActive ||
        ![-1, 1].includes(command.delta)
      )
        throw new Error("Settings view order conflict");
      next = moveView(data, command.viewId, command.delta);
      break;
    case "addProperty":
      if (
        !sameSettingsValue(
          settings.properties.map((property) => property.id),
          command.basePropertyIds,
        ) ||
        settings.properties.some(
          (property) => property.id === command.property.id,
        )
      )
        throw new Error("Settings property conflict");
      next = {
        ...data,
        properties: [...data.properties, structuredClone(command.property)],
      };
      break;
    default:
      throw new Error("Unsupported settings intent");
  }
  const { rows: _rows, ...result } = next;
  return canonicalSettings(result);
}
