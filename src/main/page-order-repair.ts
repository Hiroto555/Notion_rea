import {
  applyPageOrderRepair,
  previewPageOrderRepair,
} from "../persistence/page-order-repair";
import type { Store } from "../persistence/store";
import type { Request } from "../shared/types";

/** Shared by the IPC handler and Node boundary tests. Paths stay in main. */
export function handlePageOrderRepair(
  store: Store,
  request: Extract<Request, { type: "pageOrder:preview" | "pageOrder:apply" }>,
  beforeBackup: () => void,
) {
  if (request.type === "pageOrder:preview")
    return previewPageOrderRepair(store);
  return applyPageOrderRepair(store, request, { beforeBackup });
}
