import { describe, expect, it } from "vitest";
import {
  EVIDENCE_KINDS,
  EVIDENCE_STATUSES,
  GATE_IDS,
  REQUIRED_KINDS,
  evaluateGateLedger,
} from "../../scripts/mac-acceptance/gate-ledger.mjs";
import type {
  EvidenceKind,
  EvidenceRecord,
  EvidenceStatus,
  GateInput,
} from "../../scripts/mac-acceptance/gate-ledger.mjs";

const CANDIDATE = "a".repeat(64);
const OTHER_CANDIDATE = "b".repeat(64);

function record(
  kind: EvidenceKind,
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    kind,
    status: "PASS",
    candidateSha256: CANDIDATE,
    synthetic: false,
    ...overrides,
  };
}

function completeGateMap(
  candidateSha256 = CANDIDATE,
): Record<string, EvidenceRecord[]> {
  return Object.fromEntries(
    GATE_IDS.map((id): [string, EvidenceRecord[]] => [
      id,
      REQUIRED_KINDS[id].map((kind) => record(kind, { candidateSha256 })),
    ]),
  );
}

function gatesFrom(
  map: Record<string, EvidenceRecord[]>,
  extra: GateInput[] = [],
): GateInput[] {
  return [
    ...Object.entries(map).map(([id, evidence]) => ({ id, evidence })),
    ...extra,
  ];
}

function evaluate(
  map: Record<string, EvidenceRecord[]> = completeGateMap(),
  extra: GateInput[] = [],
) {
  return evaluateGateLedger({ gates: gatesFrom(map, extra) });
}

function gate(result: ReturnType<typeof evaluateGateLedger>, id: string) {
  const found = result.gates.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing evaluated gate ${id}`);
  return found;
}

describe("Lv4 evidence gate ledger (pure evaluation, not certification)", () => {
  it("encodes the documented required evidence tiers exactly", () => {
    expect(GATE_IDS).toEqual([
      "L4-01",
      "L4-02",
      "L4-03",
      "L4-04",
      "L4-05",
      "L4-06",
      "L4-07",
      "L4-08",
      "L4-09",
      "L4-10",
      "L4-11",
      "L4-12",
    ]);
    expect(REQUIRED_KINDS).toEqual({
      "L4-01": ["NODE", "MAC_OS"],
      "L4-02": ["TWO_PHYSICAL_MACS"],
      "L4-03": ["NODE", "TWO_PHYSICAL_MACS"],
      "L4-04": ["NODE", "MAC_OS"],
      "L4-05": ["NODE", "MAC_OS"],
      "L4-06": ["NODE", "MAC_OS", "TWO_PHYSICAL_MACS"],
      "L4-07": ["NODE", "TWO_PHYSICAL_MACS"],
      "L4-08": ["NODE", "TWO_PHYSICAL_MACS"],
      "L4-09": ["NODE", "MAC_OS"],
      "L4-10": ["MAC_OS", "TWO_PHYSICAL_MACS"],
      "L4-11": ["MAC_OS", "TWO_PHYSICAL_MACS"],
      "L4-12": ["TWO_PHYSICAL_MACS"],
    });
    expect(EVIDENCE_KINDS).toEqual(["NODE", "MAC_OS", "TWO_PHYSICAL_MACS"]);
    expect(EVIDENCE_STATUSES).toEqual([
      "PASS",
      "FAIL",
      "NOT_RUN",
      "INFRA_BLOCKED",
      "UNRESOLVED",
    ]);
  });

  it("marks complete non-synthetic evidence as eligible for review but never as a product result", () => {
    const result = evaluate();
    expect(result.productResult).toBe("NOT_RUN");
    expect(result.eligibleForFinalReview).toBe(true);
    expect(result.remaining).toEqual([]);
    expect(result.gates.map((candidate) => candidate.id)).toEqual([
      ...GATE_IDS,
    ]);
    expect(
      result.gates.every(
        (candidate) => candidate.status === "PASS" && candidate.satisfied,
      ),
    ).toBe(true);
  });

  it("allows synthetic Node proof while still rejecting synthetic OS proof", () => {
    const withSyntheticNode = completeGateMap();
    withSyntheticNode["L4-01"][0] = record("NODE", {
      synthetic: true,
    });
    expect(evaluate(withSyntheticNode).eligibleForFinalReview).toBe(true);

    const withSyntheticMac = completeGateMap();
    withSyntheticMac["L4-01"][1] = record("MAC_OS", {
      synthetic: true,
    });
    const result = evaluate(withSyntheticMac);
    expect(result.eligibleForFinalReview).toBe(false);
    expect(result.productResult).toBe("NOT_RUN");
    expect(gate(result, "L4-01").satisfied).toBe(false);
    expect(gate(result, "L4-01").unsatisfiedKinds).toContain("MAC_OS");
    expect(result.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-01",
          kind: "MAC_OS",
          reason: "SYNTHETIC",
        }),
      ]),
    );
  });

  it("never lets synthetic evidence satisfy two-physical-Mac proof", () => {
    for (const id of ["L4-02", "L4-12"] as const) {
      const map = completeGateMap();
      const index = REQUIRED_KINDS[id].indexOf("TWO_PHYSICAL_MACS");
      map[id][index] = record("TWO_PHYSICAL_MACS", {
        synthetic: true,
      });
      const result = evaluate(map);
      expect(result.eligibleForFinalReview).toBe(false);
      expect(gate(result, id).status).not.toBe("PASS");
      expect(result.remaining).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            gateId: id,
            kind: "TWO_PHYSICAL_MACS",
            reason: "SYNTHETIC",
          }),
        ]),
      );
    }
  });

  it("lists missing gates and missing tiers without inventing a pass", () => {
    const missingGate = completeGateMap();
    delete missingGate["L4-12"];
    const missingGateResult = evaluate(missingGate);
    expect(missingGateResult.eligibleForFinalReview).toBe(false);
    expect(gate(missingGateResult, "L4-12").status).toBe("NOT_RUN");
    expect(gate(missingGateResult, "L4-12").missingKinds).toEqual([
      "TWO_PHYSICAL_MACS",
    ]);
    expect(missingGateResult.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-12",
          kind: "TWO_PHYSICAL_MACS",
          reason: "MISSING_EVIDENCE",
        }),
      ]),
    );

    const missingTier = completeGateMap();
    missingTier["L4-06"] = missingTier["L4-06"].filter(
      (entry) => entry.kind !== "TWO_PHYSICAL_MACS",
    );
    const missingTierResult = evaluate(missingTier);
    expect(missingTierResult.eligibleForFinalReview).toBe(false);
    expect(gate(missingTierResult, "L4-06").missingKinds).toEqual([
      "TWO_PHYSICAL_MACS",
    ]);
    expect(missingTierResult.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-06",
          kind: "TWO_PHYSICAL_MACS",
          reason: "MISSING_EVIDENCE",
        }),
      ]),
    );
  });

  it("rejects duplicate and unknown gate identities", () => {
    const duplicate = gatesFrom(completeGateMap());
    duplicate.push({ ...duplicate[0] });
    const duplicateResult = evaluateGateLedger({ gates: duplicate });
    expect(duplicateResult.eligibleForFinalReview).toBe(false);
    expect(gate(duplicateResult, "L4-01").satisfied).toBe(false);
    expect(duplicateResult.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-01",
          reason: "DUPLICATE_GATE",
        }),
      ]),
    );

    const unknown = evaluate(completeGateMap(), [
      { id: "L4-13", evidence: [] },
    ]);
    expect(unknown.eligibleForFinalReview).toBe(false);
    expect(unknown.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-13",
          reason: "UNKNOWN_GATE",
        }),
      ]),
    );
    expect(unknown.gates.every((candidate) => candidate.satisfied)).toBe(true);
  });

  it("requires one candidate across every selected proof", () => {
    const mixedWithinGate = completeGateMap();
    mixedWithinGate["L4-01"] = [
      record("NODE", { candidateSha256: CANDIDATE }),
      record("MAC_OS", { candidateSha256: OTHER_CANDIDATE }),
    ];
    const withinResult = evaluate(mixedWithinGate);
    expect(withinResult.eligibleForFinalReview).toBe(false);
    expect(gate(withinResult, "L4-01").satisfied).toBe(false);
    expect(withinResult.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-01",
          kind: "NODE",
          reason: "CANDIDATE_MISMATCH",
        }),
        expect.objectContaining({
          gateId: "L4-01",
          kind: "MAC_OS",
          reason: "CANDIDATE_MISMATCH",
        }),
      ]),
    );

    const mixedAcrossGates = completeGateMap();
    for (const entry of mixedAcrossGates["L4-02"])
      entry.candidateSha256 = OTHER_CANDIDATE;
    const acrossResult = evaluate(mixedAcrossGates);
    expect(acrossResult.eligibleForFinalReview).toBe(false);
    expect(acrossResult.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-02",
          kind: "TWO_PHYSICAL_MACS",
          reason: "CANDIDATE_MISMATCH",
        }),
      ]),
    );
  });

  it("accepts proof that matches an explicitly expected candidate", () => {
    const result = evaluateGateLedger({
      gates: gatesFrom(completeGateMap()),
      candidateSha256: CANDIDATE,
    });
    expect(result.eligibleForFinalReview).toBe(true);
    expect(result.productResult).toBe("NOT_RUN");
  });

  it("does not pass proof tied to a stale or unexpected candidate", () => {
    const stale = completeGateMap(OTHER_CANDIDATE);
    const staleResult = evaluateGateLedger({
      gates: gatesFrom(stale),
      candidateSha256: CANDIDATE,
    });
    expect(staleResult.eligibleForFinalReview).toBe(false);
    expect(staleResult.productResult).toBe("NOT_RUN");
    expect(staleResult.gates.every((candidate) => candidate.satisfied)).toBe(
      false,
    );
    expect(staleResult.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "CANDIDATE_MISMATCH" }),
      ]),
    );
  });

  const nonPassStatuses: EvidenceStatus[] = [
    "FAIL",
    "NOT_RUN",
    "INFRA_BLOCKED",
    "UNRESOLVED",
  ];
  it.each(nonPassStatuses)(
    "lists %s evidence without inflating the gate to PASS",
    (status) => {
      const map = completeGateMap();
      map["L4-01"][1] = record("MAC_OS", { status });
      const result = evaluate(map);
      expect(result.eligibleForFinalReview).toBe(false);
      expect(result.productResult).toBe("NOT_RUN");
      expect(gate(result, "L4-01").satisfied).toBe(false);
      expect(gate(result, "L4-01").status).toBe(status);
      expect(result.remaining).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            gateId: "L4-01",
            kind: "MAC_OS",
            reason: `STATUS_${status}`,
            status,
          }),
        ]),
      );
    },
  );

  it("does not let one passing record hide a failed record for the same tier", () => {
    const map = completeGateMap();
    map["L4-01"].push(record("MAC_OS", { status: "FAIL" }));
    const result = evaluate(map);
    expect(result.eligibleForFinalReview).toBe(false);
    expect(gate(result, "L4-01").status).toBe("FAIL");
    expect(result.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-01",
          kind: "MAC_OS",
          reason: "STATUS_FAIL",
        }),
      ]),
    );
  });

  const malformedEvidence: Array<[string, Record<string, unknown>]> = [
    ["unknown kind", { kind: "SCREENSHOT" }],
    ["unknown status", { status: "OK" }],
    ["empty candidate", { candidateSha256: "" }],
    ["non-hash candidate", { candidateSha256: "not-a-source-hash" }],
    ["uppercase candidate", { candidateSha256: "A".repeat(64) }],
    ["non-boolean synthetic flag", { synthetic: "no" }],
  ];
  it.each(malformedEvidence)(
    "rejects malformed evidence: %s",
    (_name, overrides) => {
      const map = completeGateMap();
      map["L4-01"][1] = {
        ...record("MAC_OS"),
        ...overrides,
      } as unknown as EvidenceRecord;
      const result = evaluate(map);
      expect(result.eligibleForFinalReview).toBe(false);
      expect(gate(result, "L4-01").satisfied).toBe(false);
      expect(result.remaining).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            gateId: "L4-01",
            reason: "INVALID_EVIDENCE",
          }),
        ]),
      );
    },
  );

  it("rejects a non-array gate payload and a non-array evidence list", () => {
    const badPayload = evaluateGateLedger({ gates: "not-an-array" } as any);
    expect(badPayload.eligibleForFinalReview).toBe(false);
    expect(badPayload.gates).toHaveLength(12);
    expect(badPayload.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "INVALID_INPUT" }),
      ]),
    );
    expect(
      badPayload.gates.every((candidate) => candidate.status === "NOT_RUN"),
    ).toBe(true);

    const map = completeGateMap();
    const badEvidence = gatesFrom(map);
    badEvidence[0] = { id: "L4-01", evidence: "not-an-array" } as any;
    const badEvidenceResult = evaluateGateLedger({ gates: badEvidence });
    expect(badEvidenceResult.eligibleForFinalReview).toBe(false);
    expect(gate(badEvidenceResult, "L4-01").status).toBe("UNRESOLVED");
    expect(badEvidenceResult.remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: "L4-01",
          reason: "INVALID_EVIDENCE",
        }),
      ]),
    );
  });

  it("returns canonical gate order and never mutates its input", () => {
    const gates = gatesFrom(completeGateMap()).reverse();
    const snapshot = structuredClone(gates);
    const result = evaluateGateLedger({ gates });
    expect(gates).toEqual(snapshot);
    expect(result.gates.map((candidate) => candidate.id)).toEqual([
      ...GATE_IDS,
    ]);
  });

  it("report gaps as a list without counts or percentages", () => {
    const result = evaluate({
      ...completeGateMap(),
      "L4-01": [
        record("NODE", { status: "NOT_RUN" }),
        record("MAC_OS", { status: "INFRA_BLOCKED" }),
      ],
    });
    expect(result.eligibleForFinalReview).toBe(false);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(
      /percent|percentage|ratio|achievement|completionrate/i,
    );
  });
});
