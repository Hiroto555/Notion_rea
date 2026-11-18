import type { Json } from "../../collaboration/runtime/contract";

export const WINDOWS_PUBLICATION_MAX_BYTES = 1_048_576;
export const WINDOWS_PUBLICATION_MAX_WIRE_BYTES = 1_500_000;

export type PublicationPhase = "prepare" | "commit-prepared" | "read-private";
export type PublicationReservation = Readonly<{
  contractVersion: 2;
  attemptId: string;
  path: string;
  stagingPath: string;
  root: Readonly<{ canonicalPath: string; fileId: string; volumeId: string }>;
  directory: Readonly<{ canonicalPath: string; fileId: string; volumeId: string }>;
  byteLength: number;
  sha256: string;
}>;

/** Separate private SQLite authority. Every call is synchronous and durable
 * before it returns. It must not join the operator's rollback transaction.
 * Reservations and wire originals are immutable; UNKNOWN never permits replay. */
export interface DurablePublicationAuthority {
  reserve(reservation: PublicationReservation): void;
  recordDispatch(attemptId: string, phase: "prepare" | "commit-prepared", exactWire: string): void;
  recordPrepared(attemptId: string, evidence: Json): void;
  recordTerminal(attemptId: string, outcome: "PUBLISHED" | "UNKNOWN" | "REJECTED", evidence: Json): void;
}
