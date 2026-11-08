const INVALID_CODE = 'INVALID';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonNegativeSafeInt = value => Number.isSafeInteger(value) && value >= 0;
const isPositiveSafeInt = value => Number.isSafeInteger(value) && value > 0;

function reject(code = INVALID_CODE) {
  return { allowed: false, code };
}

export function assessBudget(input) {
  if (!isObject(input)) return reject();

  const { usedBytes, pendingCount, requestBytes, limits } = input;
  if (!isObject(limits)) return reject();

  const { maxBytes, maxPending, maxRequestBytes } = limits;

  if (
    !isNonNegativeSafeInt(usedBytes) ||
    !isNonNegativeSafeInt(pendingCount) ||
    !isNonNegativeSafeInt(requestBytes) ||
    !isPositiveSafeInt(maxBytes) ||
    !isPositiveSafeInt(maxPending) ||
    !isPositiveSafeInt(maxRequestBytes)
  ) {
    return reject();
  }

  const nextBytes = usedBytes + requestBytes;
  const nextPending = pendingCount + 1;
  if (!Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(nextPending)) return reject();

  if (requestBytes > maxRequestBytes) return reject('REQUEST_LIMIT');
  if (nextBytes > maxBytes) return reject('BYTE_LIMIT');
  if (nextPending > maxPending) return reject('PENDING_LIMIT');

  return { allowed: true, code: 'OK', nextBytes, nextPending };
}
