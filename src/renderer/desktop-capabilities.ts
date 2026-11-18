import { createDiagnosticRequest } from "./private-request";
import {
  parseDesktopCapabilities,
  type DesktopCapabilities,
} from "../shared/desktop-capabilities";
import type { Request } from "../shared/types";

/**
 * W09/O1 renderer purpose binding `readDesktopCapabilities()`.
 *
 * It takes no request, channel or path input: the query is the fixed empty
 * `desktop:capabilities` request sent once over the accepted U5 diagnostic
 * lane (`folio:request:diagnostic-v1`). The success value is re-validated
 * against the strict version-1 DTO before it is returned.
 *
 * A missing API, a transport rejection, a malformed/oversized/accessor/cycle
 * envelope, a failure reply or an invalid DTO all collapse to the fixed safe
 * `null` (unavailable) — never an all-features-provided table, never a fake
 * operation success, and never a legacy fallback or resend.
 */
export function createReadDesktopCapabilities(
  invoke: unknown,
): () => Promise<DesktopCapabilities | null> {
  const diagnostic = createDiagnosticRequest(invoke);
  return async function readDesktopCapabilities(): Promise<DesktopCapabilities | null> {
    const request: Request = { type: "desktop:capabilities" };
    try {
      const value = await diagnostic<unknown>(request);
      return parseDesktopCapabilities(value);
    } catch {
      return null;
    }
  };
}
