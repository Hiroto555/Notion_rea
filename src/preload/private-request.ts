import type { FolioAPI, Request } from "../shared/types";

/** Plain pass-through for the folio:request:diagnostic-v1 lane. The preload
 * never validates, wraps, clones, retries or falls back to the legacy channel;
 * the reply envelope crosses the context bridge untouched and only the
 * renderer adapter decodes it. Injectable so the contract is testable in Node
 * without an Electron runtime. */
export function createPrivateRequestPreload(
  invoke: (request: Request) => Promise<unknown>,
): Pick<FolioAPI, "requestDiagnostic"> {
  return Object.freeze({
    requestDiagnostic: (request: Request) => invoke(request),
  });
}
