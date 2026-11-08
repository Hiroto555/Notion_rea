import { isId } from './contracts.mjs';

const STAGES = new Set(['draft', 'local', 'server', 'peer', 'unknown', 'rejected']);
const EVENT_TYPES = new Set([
  'localSaved',
  'serverAccepted',
  'queryConfirmed',
  'peerApplied',
  'ackLost',
  'rejected',
]);
const SEQ_TYPES = new Set(['serverAccepted', 'queryConfirmed', 'peerApplied']);

const isObject = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const isPositiveSeq = value => Number.isSafeInteger(value) && value > 0;
const hasSeq = value =>
  Object.prototype.hasOwnProperty.call(value, 'serverSeq') &&
  value.serverSeq !== undefined;

const accepted = receipt => ({ ok: true, receipt });
const failed = code => ({ ok: false, code });

function makeReceipt(opId, stage, serverSeq) {
  const receipt = { opId, stage };
  if (serverSeq !== undefined) receipt.serverSeq = serverSeq;
  return receipt;
}

function preserve(current) {
  const { opId, stage, serverSeq } = current;
  return makeReceipt(opId, stage, serverSeq);
}

function transition(current, event) {
  const { stage } = current;
  const { type, serverSeq } = event;

  if (type === 'localSaved') {
    if (stage === 'draft' || stage === 'local') return makeReceipt(current.opId, 'local');
    return preserve(current);
  }

  if (type === 'ackLost') {
    if (stage === 'draft' || stage === 'local' || stage === 'unknown') {
      return makeReceipt(current.opId, 'unknown');
    }
    return preserve(current);
  }

  if (type === 'rejected') {
    if (stage === 'server' || stage === 'peer') return failed('CONFLICT');
    return makeReceipt(current.opId, 'rejected');
  }

  if (type === 'peerApplied') {
    if (stage !== 'server' && stage !== 'peer') return failed('ORDER');
    if (current.serverSeq !== serverSeq) return failed('CONFLICT');
    return makeReceipt(current.opId, 'peer', serverSeq);
  }

  if (stage === 'server' || stage === 'peer') {
    if (current.serverSeq !== serverSeq) return failed('CONFLICT');
    if (stage === 'peer') return preserve(current);
    return makeReceipt(current.opId, 'server', serverSeq);
  }

  if (stage === 'rejected') return failed('ORDER');
  if (stage === 'unknown' && type !== 'queryConfirmed') return failed('ORDER');
  return makeReceipt(current.opId, 'server', serverSeq);
}

export function transitionReceipt(current, event) {
  if (!isObject(event)) return failed('INVALID');
  if (!isId(event.opId) || !EVENT_TYPES.has(event.type)) return failed('INVALID');

  let working;
  if (current === null) {
    working = makeReceipt(event.opId, 'draft');
  } else {
    if (!isObject(current)) return failed('INVALID');
    if (!isId(current.opId) || !STAGES.has(current.stage)) return failed('INVALID');
    if (hasSeq(current) && !isPositiveSeq(current.serverSeq)) return failed('INVALID');
    if ((current.stage === 'server' || current.stage === 'peer') && !hasSeq(current)) {
      return failed('INVALID');
    }
    if (current.opId !== event.opId) return failed('OPERATION');
    working = hasSeq(current)
      ? makeReceipt(current.opId, current.stage, current.serverSeq)
      : makeReceipt(current.opId, current.stage);
  }

  if (SEQ_TYPES.has(event.type) && !isPositiveSeq(event.serverSeq)) return failed('ORDER');

  const result = transition(working, event);
  if (result.ok === false) return result;
  return accepted(result);
}
