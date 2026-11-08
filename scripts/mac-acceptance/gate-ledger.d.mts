export type GateId =
  | "L4-01"
  | "L4-02"
  | "L4-03"
  | "L4-04"
  | "L4-05"
  | "L4-06"
  | "L4-07"
  | "L4-08"
  | "L4-09"
  | "L4-10"
  | "L4-11"
  | "L4-12";

export type EvidenceKind = "NODE" | "MAC_OS" | "TWO_PHYSICAL_MACS";

export type EvidenceStatus =
  "PASS" | "FAIL" | "NOT_RUN" | "INFRA_BLOCKED" | "UNRESOLVED";

export interface EvidenceRecord {
  kind: EvidenceKind;
  status: EvidenceStatus;
  candidateSha256: string;
  synthetic: boolean;
}

export interface GateInput {
  id: string;
  evidence?: readonly EvidenceRecord[];
}

export interface GateLedgerInput {
  gates?: readonly GateInput[];
  candidateSha256?: string;
}

export interface EvidenceSummary {
  index: number;
  kind: EvidenceKind | null;
  status: EvidenceStatus | null;
  candidateSha256: string | null;
  synthetic: boolean | null;
}

export interface GateEvaluation {
  id: GateId;
  requiredKinds: EvidenceKind[];
  status: EvidenceStatus;
  satisfied: boolean;
  candidateSha256: string | null;
  missingKinds: EvidenceKind[];
  unsatisfiedKinds: EvidenceKind[];
  evidence: EvidenceSummary[];
}

export interface RemainingItem {
  gateId: string | null;
  kind: EvidenceKind | null;
  reason: string;
  recordIndex: number | null;
  status: EvidenceStatus | null;
}

export interface GateLedgerResult {
  productResult: "NOT_RUN";
  eligibleForFinalReview: boolean;
  gates: GateEvaluation[];
  remaining: RemainingItem[];
}

export const GATE_IDS: readonly GateId[];
export const EVIDENCE_KINDS: readonly EvidenceKind[];
export const EVIDENCE_STATUSES: readonly EvidenceStatus[];
export const REQUIRED_KINDS: Readonly<Record<GateId, readonly EvidenceKind[]>>;

export function evaluateGateLedger(
  input?: GateLedgerInput | null,
): GateLedgerResult;
