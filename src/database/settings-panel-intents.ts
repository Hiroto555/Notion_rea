import type {
  DatabaseSettings,
  DatabaseView,
  DatabaseViewType,
} from "../shared/types";
import type { SettingsIntent } from "../renderer/settings-intent";
import { addView, duplicateView } from "./model";

/** Create IDs at the input boundary once. The resulting intent is replayable
 * without regenerating a view, filter or sort identity. */
export function createViewIntent(
  settings: DatabaseSettings,
  type: DatabaseViewType,
): SettingsIntent {
  const next = addView({ ...settings, rows: [] }, type);
  return {
    kind: "createView",
    view: structuredClone(
      next.views.find((view) => view.id === next.activeViewId)!,
    ),
    baseOrder: settings.views.map((view) => view.id),
    baseActive: settings.activeViewId,
    afterViewId: null,
  };
}

export function duplicateViewIntent(
  settings: DatabaseSettings,
  sourceId: string,
): SettingsIntent {
  const source = settings.views.find((view) => view.id === sourceId);
  if (!source) throw new Error("複製するビューがありません。");
  const next = duplicateView({ ...settings, rows: [] }, sourceId);
  const copy = structuredClone(
    next.views.find((view) => view.id === next.activeViewId)!,
  );
  // The model's copy suffix must still fit the persisted 200-character name.
  if (copy.name.length > 200)
    copy.name = `${copy.name.slice(0, 190)}… のコピー`;
  return {
    kind: "createView",
    view: copy,
    baseOrder: settings.views.map((view) => view.id),
    baseActive: settings.activeViewId,
    afterViewId: sourceId,
    source: structuredClone(source),
  };
}

export function viewPatchIntent(
  view: DatabaseView,
  patch: Partial<Omit<DatabaseView, "id">>,
): SettingsIntent {
  const base = Object.fromEntries(
    Object.keys(patch).map((key) => [key, view[key as keyof typeof patch]]),
  );
  return {
    kind: "viewPatch",
    viewId: view.id,
    base: structuredClone(base),
    patch: structuredClone(patch),
  };
}
