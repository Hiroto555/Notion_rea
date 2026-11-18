export type NativeObservationStatus =
  "PASS" | "FAIL" | "INFRA_BLOCKED" | "NOT_RUN";

export interface NativeObservationResult {
  status: NativeObservationStatus;
  reason: string;
  productResult: "NOT_RUN";
}

export type NativeScenario = "IME" | "REOPEN" | "RESERVATION_REDISPLAY";

export const NATIVE_SCENARIOS: readonly NativeScenario[];

interface NativeObservationCommon {
  executed: boolean;
  synthetic: boolean;
  trusted: boolean;
}

export interface ImeTrustedEvent {
  kind: "start" | "update" | "end";
  trusted: boolean;
}

export interface ImeNativeObservation extends NativeObservationCommon {
  scenario: "IME";
  routeEstablished: boolean;
  events?: ImeTrustedEvent[];
  committedText?: string;
  committedSha256?: string;
  persistedSha256?: string;
}

export interface DocumentSnapshot {
  documentId: string;
  revisionSha256: string;
  contentSha256: string;
}

export interface ReopenNativeObservation extends NativeObservationCommon {
  scenario: "REOPEN";
  trustedAction?: boolean;
  beforePid?: number;
  afterPid?: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  before?: DocumentSnapshot;
  after?: DocumentSnapshot;
}

export interface ReservationRedisplayNativeObservation extends NativeObservationCommon {
  scenario: "RESERVATION_REDISPLAY";
  trustedClose?: boolean;
  commitAttempted: boolean;
  commitSucceeded: boolean;
  beforePid?: number;
  afterPid?: number;
  inputPreserved?: boolean;
  reservationPreserved?: boolean;
}

export type NativeObservation =
  | ImeNativeObservation
  | ReopenNativeObservation
  | ReservationRedisplayNativeObservation;

export function assessNativeObservation(
  input: unknown,
): NativeObservationResult;
