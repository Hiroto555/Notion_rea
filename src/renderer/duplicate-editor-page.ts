import type { Page } from "../shared/types";
import type { PageOperationCoordinator } from "./page-operation-coordinator";
import type { SaveTransport } from "./reliable-save";

/** Route the existing editor action without widening the ordinary Page protocol. */
export function duplicateEditorPage(
  page: Page,
  coordinator: PageOperationCoordinator,
  send: SaveTransport,
): Promise<Page> {
  if (page.kind === "page" && page.database === null)
    return coordinator.duplicate(page.id, page.revision);
  // Legacy databases retain their existing lifecycle path. Registered DBs
  // and records remain blocked by the editor and Store's ownership guards.
  return send({ type: "duplicate", id: page.id }) as Promise<Page>;
}
