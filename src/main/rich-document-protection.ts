import { containsRichBlocks } from "../shared/rich-document";
import type { Request } from "../shared/types";

/** Main-process write guard, separated from Electron so the same routing and
 * fail-closed behavior can be verified with a temporary workspace in Node. */
export function createRichDocumentProtection(createBackup: () => unknown) {
  let completed = false;
  const protectValue = (value: unknown): void => {
    if (!completed && containsRichBlocks(value)) {
      createBackup();
      // A failed backup must not disable protection for the next attempt.
      completed = true;
    }
  };
  const protectRequest = (request: Request): void => {
    switch (request.type) {
      case "save:commit":
      case "update":
      case "record:pageUpdate":
      case "database:commit":
      case "recovery:copy":
      case "page:commit":
        protectValue(request);
    }
  };
  return { protectValue, protectRequest };
}
