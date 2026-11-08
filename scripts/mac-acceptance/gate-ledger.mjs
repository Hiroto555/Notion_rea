export const GATE_IDS = Object.freeze([
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

export const EVIDENCE_KINDS = Object.freeze([
  "NODE",
  "MAC_OS",
  "TWO_PHYSICAL_MACS",
]);

export const EVIDENCE_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "NOT_RUN",
  "INFRA_BLOCKED",
  "UNRESOLVED",
]);

const REQUIRED = {
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
};
for (const kinds of Object.values(REQUIRED)) Object.freeze(kinds);
export const REQUIRED_KINDS = Object.freeze(REQUIRED);

const STATUS_PRIORITY = Object.freeze({
  PASS: 0,
  NOT_RUN: 1,
  INFRA_BLOCKED: 2,
  UNRESOLVED: 3,
  FAIL: 4,
});

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isCandidate = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isValidRecord = (record) =>
  isObject(record) &&
  EVIDENCE_KINDS.includes(record.kind) &&
  EVIDENCE_STATUSES.includes(record.status) &&
  isCandidate(record.candidateSha256) &&
  typeof record.synthetic === "boolean";

const isSelectable = (record, kind) =>
  isValidRecord(record) &&
  record.kind === kind &&
  record.status === "PASS" &&
  (kind === "NODE" || record.synthetic === false);

const remainingEntry = (gateId, kind, reason, recordIndex, status) => ({
  gateId,
  kind,
  reason,
  recordIndex,
  status,
});

function selectableCandidates(byId) {
  const candidates = new Set();
  for (const id of GATE_IDS) {
    const occurrences = byId.get(id);
    if (!occurrences || occurrences.length !== 1) continue;
    const evidence = occurrences[0].evidence;
    if (!Array.isArray(evidence)) continue;
    for (const record of evidence) {
      if (!isSelectable(record, record?.kind)) continue;
      if (!REQUIRED_KINDS[id].includes(record.kind)) continue;
      candidates.add(record.candidateSha256);
    }
  }
  return candidates;
}

function summarizeRecord(raw, index) {
  return {
    index,
    kind: isObject(raw) && EVIDENCE_KINDS.includes(raw.kind) ? raw.kind : null,
    status:
      isObject(raw) && EVIDENCE_STATUSES.includes(raw.status)
        ? raw.status
        : null,
    candidateSha256:
      isObject(raw) && isCandidate(raw.candidateSha256)
        ? raw.candidateSha256
        : null,
    synthetic:
      isObject(raw) && typeof raw.synthetic === "boolean"
        ? raw.synthetic
        : null,
  };
}

export function evaluateGateLedger(input = {}) {
  const remaining = [];
  const inputIsObject = isObject(input);
  const inputError = !inputIsObject || !Array.isArray(input.gates);
  if (inputError)
    remaining.push(remainingEntry(null, null, "INVALID_INPUT", null, null));

  const sourceGates = inputError ? [] : input.gates;
  const byId = new Map();
  let unknownGateCount = 0;

  for (let index = 0; index < sourceGates.length; index++) {
    const gate = sourceGates[index];
    if (
      !isObject(gate) ||
      typeof gate.id !== "string" ||
      !GATE_IDS.includes(gate.id)
    ) {
      unknownGateCount++;
      remaining.push(
        remainingEntry(
          isObject(gate) && typeof gate.id === "string" ? gate.id : null,
          null,
          "UNKNOWN_GATE",
          index,
          null,
        ),
      );
      continue;
    }
    if (!byId.has(gate.id)) byId.set(gate.id, []);
    byId.get(gate.id).push({
      index,
      evidence: Array.isArray(gate.evidence) ? gate.evidence : null,
    });
  }

  let expectedCandidate = null;
  let expectedCandidateInvalid = false;
  if (
    inputIsObject &&
    Object.prototype.hasOwnProperty.call(input, "candidateSha256")
  ) {
    if (isCandidate(input.candidateSha256))
      expectedCandidate = input.candidateSha256;
    else {
      expectedCandidateInvalid = true;
      remaining.push(
        remainingEntry(null, null, "INVALID_EXPECTED_CANDIDATE", null, null),
      );
    }
  }

  const candidates = selectableCandidates(byId);
  let canonicalCandidate = expectedCandidate;
  let candidateAmbiguous = false;
  if (canonicalCandidate === null) {
    if (candidates.size === 1) canonicalCandidate = [...candidates][0];
    else if (candidates.size > 1) candidateAmbiguous = true;
  }

  let duplicateGateCount = 0;
  const gateResults = [];

  for (const id of GATE_IDS) {
    const requiredKinds = [...REQUIRED_KINDS[id]];
    const occurrences = byId.get(id) ?? [];
    const result = {
      id,
      requiredKinds,
      status: "NOT_RUN",
      satisfied: false,
      candidateSha256: canonicalCandidate,
      missingKinds: [],
      unsatisfiedKinds: [],
      evidence: [],
    };

    if (occurrences.length === 0) {
      result.missingKinds = [...requiredKinds];
      result.unsatisfiedKinds = [...requiredKinds];
      for (const kind of requiredKinds)
        remaining.push(
          remainingEntry(id, kind, "MISSING_EVIDENCE", null, null),
        );
      gateResults.push(result);
      continue;
    }

    if (occurrences.length > 1) {
      duplicateGateCount++;
      result.unsatisfiedKinds = [...requiredKinds];
      remaining.push(remainingEntry(id, null, "DUPLICATE_GATE", null, null));
      result.status = "UNRESOLVED";
      gateResults.push(result);
      continue;
    }

    const occurrence = occurrences[0];
    let gateStructuralError = false;
    let evidence = occurrence.evidence;
    if (!Array.isArray(evidence)) {
      gateStructuralError = true;
      evidence = [];
      remaining.push(
        remainingEntry(id, null, "INVALID_EVIDENCE", occurrence.index, null),
      );
    }

    const records = evidence.map((raw, index) => ({ raw, index }));
    let worstStatus = "PASS";
    const consider = (status) => {
      if (STATUS_PRIORITY[status] > STATUS_PRIORITY[worstStatus])
        worstStatus = status;
    };
    if (gateStructuralError) consider("UNRESOLVED");

    for (const { raw, index } of records) {
      result.evidence.push(summarizeRecord(raw, index));
      if (
        !isValidRecord(raw) &&
        (!isObject(raw) || !requiredKinds.includes(raw.kind))
      ) {
        gateStructuralError = true;
        consider("UNRESOLVED");
        remaining.push(
          remainingEntry(id, null, "INVALID_EVIDENCE", index, null),
        );
      }
    }

    for (const kind of requiredKinds) {
      const kindRecords = records.filter(
        ({ raw }) => isObject(raw) && raw.kind === kind,
      );
      if (kindRecords.length === 0) {
        result.missingKinds.push(kind);
        result.unsatisfiedKinds.push(kind);
        consider("NOT_RUN");
        remaining.push(
          remainingEntry(id, kind, "MISSING_EVIDENCE", null, null),
        );
        continue;
      }

      let kindSatisfied = true;
      for (const { raw, index } of kindRecords) {
        if (!isValidRecord(raw)) {
          kindSatisfied = false;
          consider("UNRESOLVED");
          remaining.push(
            remainingEntry(id, kind, "INVALID_EVIDENCE", index, null),
          );
          continue;
        }
        if (raw.status !== "PASS") {
          kindSatisfied = false;
          consider(raw.status);
          remaining.push(
            remainingEntry(id, kind, `STATUS_${raw.status}`, index, raw.status),
          );
          continue;
        }
        if (kind !== "NODE" && raw.synthetic) {
          kindSatisfied = false;
          consider("NOT_RUN");
          remaining.push(
            remainingEntry(id, kind, "SYNTHETIC", index, raw.status),
          );
        }
        if (candidateAmbiguous) {
          kindSatisfied = false;
          consider("NOT_RUN");
          remaining.push(
            remainingEntry(id, kind, "CANDIDATE_MISMATCH", index, raw.status),
          );
        } else if (
          canonicalCandidate !== null &&
          raw.candidateSha256 !== canonicalCandidate
        ) {
          kindSatisfied = false;
          consider("NOT_RUN");
          remaining.push(
            remainingEntry(id, kind, "CANDIDATE_MISMATCH", index, raw.status),
          );
        }
      }

      if (!kindSatisfied) result.unsatisfiedKinds.push(kind);
    }

    result.satisfied =
      !gateStructuralError &&
      result.unsatisfiedKinds.length === 0 &&
      result.missingKinds.length === 0;
    result.status = result.satisfied ? "PASS" : worstStatus;
    gateResults.push(result);
  }

  const eligibleForFinalReview =
    !inputError &&
    !expectedCandidateInvalid &&
    unknownGateCount === 0 &&
    duplicateGateCount === 0 &&
    !candidateAmbiguous &&
    canonicalCandidate !== null &&
    remaining.length === 0 &&
    gateResults.length === GATE_IDS.length &&
    gateResults.every((gate) => gate.satisfied);

  return {
    productResult: "NOT_RUN",
    eligibleForFinalReview,
    gates: gateResults,
    remaining,
  };
}
