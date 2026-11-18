import type { Doc } from "../shared/types";
import {
  sameSession,
  sharedSessionSchema,
  type SharedSession,
} from "./contract";
import { inspectSharedDocument } from "./document-input";

/** Headless preparation port. No IPC/network or private whole-page save callback.
 * A verified engine/provider must be attached explicitly after the adoption gate.
 * The display callback must carry REMOTE origin into any deferred editor update.
 */
export class SharedEditorPort {
  private active = true;
  private projecting = false;
  private sequence = -1;
  private readonly session: SharedSession;
  constructor(
    session: SharedSession,
    private readonly stage: (raw: string) => void,
    private readonly display: (doc: Doc, origin: "REMOTE") => void,
    private readonly writable = false,
  ) {
    this.session = sharedSessionSchema.parse(session);
  }
  local(
    raw: string,
    origin: "LOCAL_USER" | "REMOTE" | "SEED",
  ): "STAGED" | "REMOTE_ORIGIN" | "READ_ONLY" | "CLOSED" {
    if (!this.active) return "CLOSED";
    if (this.projecting || origin !== "LOCAL_USER") return "REMOTE_ORIGIN";
    if (!this.writable) return "READ_ONLY";
    // Raw drafts, including unsupported input, go to quarantine, not PM coercion.
    this.stage(raw);
    return "STAGED";
  }
  remote(envelope: {
    session: SharedSession;
    sequence: number;
    raw: string;
  }):
    | "APPLIED"
    | "REENTRANT"
    | "STALE_SESSION"
    | "STALE_SEQUENCE"
    | "UNSUPPORTED"
    | "CLOSED" {
    if (!this.active) return "CLOSED";
    if (this.projecting) return "REENTRANT";
    const parsed = sharedSessionSchema.safeParse(envelope.session);
    if (!parsed.success || !sameSession(parsed.data, this.session))
      return "STALE_SESSION";
    if (
      !Number.isSafeInteger(envelope.sequence) ||
      envelope.sequence < 0 ||
      envelope.sequence <= this.sequence
    )
      return "STALE_SEQUENCE";
    const input = inspectSharedDocument(envelope.raw);
    if (!input.ok) return "UNSUPPORTED";
    this.projecting = true;
    try {
      this.display(input.document, "REMOTE");
      this.sequence = envelope.sequence;
    } finally {
      this.projecting = false;
    }
    return "APPLIED";
  }
  close(): void {
    this.active = false;
  }
}
