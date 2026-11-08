import { isId, invalid } from './contracts.mjs';

const FORMAT = 'folio-shared-lab-backup/1';
const MAX_PENDING_OPERATIONS = 10000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidBackup(backup) {
  return (
    isObject(backup) &&
    backup.format === FORMAT &&
    isId(backup.orgId) &&
    isId(backup.spaceId) &&
    isId(backup.epoch) &&
    Number.isSafeInteger(backup.sequence) &&
    backup.sequence >= 0 &&
    typeof backup.hash === 'string' &&
    HASH_PATTERN.test(backup.hash)
  );
}

function isValidPendingOperations(pendingOperations) {
  if (!Array.isArray(pendingOperations)) return false;
  if (pendingOperations.length > MAX_PENDING_OPERATIONS) return false;

  const seen = new Set();
  for (const operation of pendingOperations) {
    if (!isObject(operation)) return false;
    if (!isId(operation.opId) || !isId(operation.epoch)) return false;
    if (seen.has(operation.opId)) return false;
    seen.add(operation.opId);
  }
  return true;
}

export function planRestore(input = {}) {
  if (!isObject(input)) return invalid();
  const {
    backup,
    currentEpoch,
    expectedOrgId,
    expectedSpaceId,
    newEpoch,
    pendingOperations,
  } = input;

  if (!isValidBackup(backup)) return invalid();
  if (!isId(currentEpoch) || !isId(newEpoch) || currentEpoch === newEpoch) return invalid();
  if (!isId(expectedOrgId) || !isId(expectedSpaceId)) return invalid();
  if (!isValidPendingOperations(pendingOperations)) return invalid();
  if (newEpoch === backup.epoch) return invalid();

  if (backup.orgId !== expectedOrgId || backup.spaceId !== expectedSpaceId) {
    return invalid('SCOPE');
  }

  return {
    ok: true,
    plan: {
      orgId: backup.orgId,
      spaceId: backup.spaceId,
      newEpoch,
      backupSequence: backup.sequence,
      serverOutcome: 'UNKNOWN',
      preservedOperationIds: pendingOperations.map(operation => operation.opId),
      autoResend: false,
      requiresReauthorization: true,
    },
  };
}
