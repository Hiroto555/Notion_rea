import { it, expect } from 'vitest';
import { decodeStorageFailureV1, decodeRequestReplyV1, type StorageFailureV1 } from '../src/shared/private-storage-failure';

function base(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return {
    version: 1,
    kind: 'UNCLASSIFIED',
    family: 'REQUEST',
    stage: 'REQUEST',
    failureSubject: 'UNIDENTIFIED',
    mutationDispatch: 'UNPROVEN',
    proofOrigin: 'NONE',
    requestType: 'recovery:write',
    sourceOutcome: null,
    sourceCauseCodes: [],
    causeSummaryIncomplete: true,
    attemptId: null,
    precondition: null,
    operationProgress: 'PARTIAL_OR_UNKNOWN',
    retryAuthority: 'NONE',
    preserve: true,
    ...overrides,
  };
}

function cap(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return base({
    kind: 'PRE_DISPATCH_CAPACITY',
    family: 'CHECKPOINT',
    stage: 'RESERVE',
    failureSubject: 'CURRENT_ATTEMPT',
    mutationDispatch: 'NOT_DISPATCHED_PROVEN',
    proofOrigin: 'LOCAL_ADMISSION_GUARD',
    sourceCauseCodes: ['WINDOWS_RECOVERY_ARCHIVE_CAPACITY'],
    causeSummaryIncomplete: false,
    sourceOutcome: {
      source: 'RECOVERY_IO',
      contractVersion: 3,
      state: 'REJECTED',
      reason: 'PRIVATE_IO_V3_REJECTED',
    },
    ...overrides,
  });
}

function conflict(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return base({
    kind: 'GENERATION_CONFLICT',
    family: 'CHECKPOINT',
    stage: 'PRECONDITION',
    failureSubject: 'CURRENT_ATTEMPT',
    mutationDispatch: 'NOT_DISPATCHED_PROVEN',
    proofOrigin: 'VALIDATED_PRECONDITION',
    sourceCauseCodes: ['CHECKPOINT_PRECONDITION_MISMATCH'],
    causeSummaryIncomplete: false,
    precondition: {
      expectedGeneration: 64,
      observedActualGeneration: 65,
      mismatch: 'GENERATION',
    },
    ...overrides,
  });
}

it('decodes named valid samples losslessly', () => {
  const samples = [
    {name: 'capacity', input: cap()},
    {name: 'capacity K exception', input: cap({family: 'K', sourceOutcome: {source: 'K_EXCEPTION', state: 'UNKNOWN', reason: 'RESERVE'}, sourceCauseCodes: ['PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY']})},
    {name: 'generation conflict head token', input: conflict({precondition: {expectedGeneration: 64, observedActualGeneration: 64, mismatch: 'HEAD_TOKEN_OR_BYTES'}})},
    {name: 'dispatched outcome unknown', input: base({kind: 'OUTCOME_UNKNOWN', family: 'CHECKPOINT', stage: 'HEAD_CAS', failureSubject: 'CURRENT_ATTEMPT', mutationDispatch: 'DISPATCHED', proofOrigin: 'DISPATCH_OBSERVED', sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'PUBLISHED', reason: null}})},
    {name: 'prior attempt outcome unknown', input: base({kind: 'OUTCOME_UNKNOWN', family: 'CHECKPOINT', stage: 'PRIOR_ATTEMPT', failureSubject: 'PRIOR_ATTEMPT', mutationDispatch: 'UNPROVEN', proofOrigin: 'NONE'})},
    {name: 'unclassified checkpoint source', input: base({kind: 'UNCLASSIFIED', family: 'CHECKPOINT', sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'REJECTED', reason: 'CAPACITY'}})},
  ];
  for (const {name, input} of samples) {
    const decoded = decodeStorageFailureV1(input, 'recovery:write');
    expect(decoded, name).toEqual(input);
    expect(JSON.parse(JSON.stringify(decoded)), `${name} JSON roundtrip`).toEqual(input);
  }
});

it('accepts frozen and null-prototype failures without aliasing nested data', () => {
  const frozen = Object.freeze(cap());
  const nullProto = Object.assign(Object.create(null), cap());
  const decodedFrozen = decodeStorageFailureV1(frozen, 'recovery:write');
  const decodedNull = decodeStorageFailureV1(nullProto, 'recovery:write');
  expect(decodedFrozen, 'frozen input').toEqual(frozen);
  expect(decodedNull, 'null prototype input').toEqual(cap());
  expect(decodedFrozen!.sourceCauseCodes).not.toBe(frozen.sourceCauseCodes);
  expect(decodedFrozen!.sourceOutcome).not.toBe(frozen.sourceOutcome);
  decodedFrozen!.sourceCauseCodes.push('ADDED_CODE');
  Reflect.set(decodedFrozen!.sourceOutcome as object, 'reason', 'CHANGED');
  expect(frozen.sourceCauseCodes, 'original codes unchanged').toEqual(['WINDOWS_RECOVERY_ARCHIVE_CAPACITY']);
  expect(frozen.sourceOutcome, 'original source unchanged').toEqual({source: 'RECOVERY_IO', contractVersion: 3, state: 'REJECTED', reason: 'PRIVATE_IO_V3_REJECTED'});
});

it('rejects recognized and unknown expected types but accepts safe unrecognized mismatches', () => {
  expect(decodeStorageFailureV1(base(), 'save:commit'), 'recognized mismatch').toBeNull();
  expect(decodeStorageFailureV1(base(), 'not:a-request'), 'unknown expected type').toBeNull();
  expect(decodeStorageFailureV1(base({requestType: 'UNRECOGNIZED'}), 'recovery:write'), 'safe base unrecognized').toEqual(base({requestType: 'UNRECOGNIZED'}));
  const safeUnrecognized = base({requestType: 'UNRECOGNIZED', kind: 'UNCLASSIFIED', family: 'REQUEST', stage: 'REQUEST', failureSubject: 'UNIDENTIFIED', mutationDispatch: 'UNPROVEN', proofOrigin: 'NONE'});
  expect(decodeStorageFailureV1(safeUnrecognized, 'recovery:write'), 'safe unrecognized C/REQUEST/UNPROVEN/NONE').toEqual(safeUnrecognized);
});

it('decodes void and primitive success slots without coercion', () => {
  const slots = [
    { present: false },
    { present: true, value: null },
    { present: true, value: false },
    { present: true, value: 0 },
    { present: true, value: '' },
  ] as const;
  for (const valueSlot of slots) {
    const wire = { tag: 'folio-request-result', version: 1, ok: true, valueSlot };
    expect(decodeRequestReplyV1(wire)).toEqual(wire);
  }
  expect(decodeRequestReplyV1({ tag: 'folio-request-result', version: 1, ok: true, valueSlot: { present: true, value: undefined } })).toBeNull();
});

it('preserves opaque cyclic success values without invoking traps', () => {
  let getterCalls = 0;
  let toJSONCalls = 0;
  const payload: Record<string, unknown> = {
    text: 'x'.repeat(20000),
    toJSON() { toJSONCalls += 1; throw new Error('must not be called'); },
  };
  payload.self = payload;
  Object.defineProperty(payload, 'hostile', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('must not be called'); },
  });
  const reply = decodeRequestReplyV1({ tag: 'folio-request-result', version: 1, ok: true, valueSlot: { present: true, value: payload } });
  expect(reply).not.toBeNull();
  if (!reply || !reply.ok || !reply.valueSlot.present) throw new Error('expected success');
  expect(reply.valueSlot.value).toBe(payload);
  expect(getterCalls).toBe(0);
  expect(toJSONCalls).toBe(0);
});

it('roundtrips a K error envelope through JSON and detaches the failure', () => {
  const wire = JSON.parse(JSON.stringify({
    tag: 'folio-request-result', version: 1, ok: false,
    failure: cap({
      family: 'K',
      sourceOutcome: { source: 'K_EXCEPTION', state: 'UNKNOWN', reason: 'RESERVE' },
      sourceCauseCodes: ['PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY'],
    }),
  }));
  const decoded = decodeRequestReplyV1(wire, 'recovery:write');
  expect(decoded).toEqual(wire);
  if (!decoded || decoded.ok) throw new Error('expected failure reply');
  expect(decoded.failure.sourceOutcome).toMatchObject({ state: 'UNKNOWN', reason: 'RESERVE' });
  expect(decoded.failure.sourceCauseCodes).toContain('PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY');
  expect(decoded.failure).not.toBe(wire.failure);
});

it('recognizes requestSchema enum request types in base failures', () => {
  for (const type of ['record:trash', 'record:restore', 'record:duplicate']) {
    expect(decodeStorageFailureV1(base({ requestType: type }), type)).not.toBeNull();
  }
});

it('rejects invalid top-level descriptors', () => {
  const seed: Record<string, unknown> = { ...base() };
  const invalid: unknown[] = [null, undefined, [], new Error('e'), new Map(), new Date(), new (class {})()];
  const missing: Record<string, unknown> = { ...seed }; delete missing['version'];
  const extra: Record<string, unknown> = { ...seed, extra: 1 };
  const symbolic: Record<string, unknown> = { ...seed, [Symbol('s')]: 1 };
  const nonenum: Record<string, unknown> = { ...seed };
  Object.defineProperty(nonenum, 'hidden', { value: 1, enumerable: false });
  const bad: unknown[] = [missing, extra, symbolic, nonenum, { ...seed, version: 2 }, { ...seed, kind: 'UNKNOWN_ENUM' }, { ...seed, requestType: 'unknown-request' }, { ...seed, attemptId: 'A'.repeat(32) }, { ...seed, attemptId: 'abc' }, { ...seed, preserve: false }, { ...seed, retryAuthority: 'WRITE' }, { ...seed, operationProgress: 'COMPLETE' }];
  for (const value of [...invalid, ...bad]) expect(decodeStorageFailureV1(value)).toBeNull();
});

it('rejects invalid sourceCauseCodes', () => {
  const tokens = ['', 'A B', 'A/B', 'A\\B', 'A\nB', 'A'.repeat(129), 'A'.repeat(9000)];
  const items: unknown[] = [BigInt(1), NaN, Infinity, new Error('e'), new Map()];
  const self: unknown[] = []; self.push(self);
  const nine = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH', 'II'];
  for (const sourceCauseCodes of [...tokens.map((c) => [c]), ...items.map((i) => [i]), self, nine]) {
    expect(decodeStorageFailureV1({ ...base(), sourceCauseCodes })).toBeNull();
  }
});

it('rejects malformed nested sourceOutcome and precondition', () => {
  let getterCalls = 0;
  let toJSONCalls = 0;
  const malformed = (parent: Record<string, unknown>, key: string): unknown[] => {
    const valid = parent[key] as Record<string, unknown>;
    const missing = { ...valid }; delete missing[Object.keys(valid)[0]];
    const extra = { ...valid, extra: 1 };
    const symbolic = { ...valid, [Symbol('s')]: 1 };
    const nonenum = { ...valid };
    Object.defineProperty(nonenum, 'hidden', { value: 1, enumerable: false });
    const accessor = { ...valid };
    Object.defineProperty(accessor, Object.keys(valid)[0], { enumerable: true, get() { getterCalls++; return 1; } });
    const withToJSON = { ...valid, toJSON() { toJSONCalls++; return valid; } };
    const cycle: Record<string, unknown> = { ...valid }; cycle.self = cycle;
    return [missing, extra, symbolic, nonenum, accessor, withToJSON, cycle].map((nested) => ({ ...parent, [key]: nested }));
  };
  const capBase: Record<string, unknown> = { ...cap() };
  const conflictBase: Record<string, unknown> = { ...conflict() };
  for (const value of [...malformed(capBase, 'sourceOutcome'), ...malformed(conflictBase, 'precondition')]) {
    expect(decodeStorageFailureV1(value)).toBeNull();
  }
  const topGetter: Record<string, unknown> = { ...base() };
  Object.defineProperty(topGetter, 'version', { enumerable: true, get() { getterCalls++; return 1; } });
  const topToJSON = { ...base(), toJSON() { toJSONCalls++; return base(); } };
  expect(decodeStorageFailureV1(topGetter)).toBeNull();
  expect(decodeStorageFailureV1(topToJSON)).toBeNull();
  expect(getterCalls).toBe(0);
  expect(toJSONCalls).toBe(0);
});

it('returns null for throwing reflective proxies and ignores ordinary get traps', () => {
  const traps = ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const;
  for (const trap of traps) {
    const proxy = new Proxy({ ...base() }, { [trap]: () => { throw new Error(trap); } });
    expect(decodeStorageFailureV1(proxy)).toBeNull();
  }
  let getCalls = 0;
  const proxy = new Proxy({ ...base() }, { get() { getCalls++; throw new Error('ordinary get'); } });
  expect(decodeStorageFailureV1(proxy)).not.toBeNull();
  expect(getCalls).toBe(0);
});

it('rejects structurally malformed sourceCauseCodes arrays', () => {
  let getterCalls = 0;
  let toJSONCalls = 0;

  const hole = new Array(1);
  const extra = Object.assign(['CAPACITY'], { extra: true });
  const withSymbol = Object.assign(['CAPACITY'], { [Symbol('s')]: true });
  const hidden = ['CAPACITY'];
  Object.defineProperty(hidden, 0, { value: 'CAPACITY', enumerable: false, writable: true, configurable: true });
  const accessor = ['CAPACITY'];
  Object.defineProperty(accessor, 0, {
    enumerable: true,
    configurable: true,
    get() { getterCalls++; return 'CAPACITY'; },
  });
  const withToJSON = Object.assign(['CAPACITY'], {
    toJSON: () => { toJSONCalls++; return ['CAPACITY']; },
  });
  class Sub extends Array<string> {}
  const sub = new Sub();
  sub.push('CAPACITY');
  const self: unknown[] = ['CAPACITY'];
  self.push(self);
  const nine = Array.from({ length: 9 }, () => 'CAPACITY');

  const bads: unknown[] = [hole, extra, withSymbol, hidden, accessor, withToJSON, sub, self, nine];
  for (const bad of bads) {
    expect(decodeStorageFailureV1({ ...base(), sourceCauseCodes: bad })).toBeNull();
  }
  expect(getterCalls).toBe(0);
  expect(toJSONCalls).toBe(0);
});

it('accepts proxies and frozen arrays for sourceCauseCodes', () => {
  let getCalls = 0;
  const target = ['CAPACITY'];
  const proxy = new Proxy(target, {
    get() { getCalls++; throw new Error('ordinary get used'); },
  });

  const decoded = decodeStorageFailureV1({ ...base(), sourceCauseCodes: proxy });
  expect(decoded).not.toBeNull();
  expect(Object.is(decoded!.sourceCauseCodes, proxy)).toBe(false);
  expect(decoded!.sourceCauseCodes).not.toBe(target);
  expect(decoded!.sourceCauseCodes).toEqual(['CAPACITY']);
  expect(getCalls).toBe(0);

  const frozen = Object.freeze(['CAPACITY']);
  expect(decodeStorageFailureV1({ ...base(), sourceCauseCodes: frozen as string[] })).not.toBeNull();
});

it('rejects malformed reply envelopes', () => {
  const f = { tag: 'folio-request-result', version: 1, ok: false, failure: base() };
  const success = { tag: 'folio-request-result', version: 1, ok: true, valueSlot: { present: false } };
  class FakeSlot { present = false; }
  const sym = Symbol('s');
  const nonEnum = { ...success };
  Object.defineProperty(nonEnum, 'hidden', { value: 1, enumerable: false });
  const invalid: unknown[] = [
    { ...success, tag: 'other' },
    { ...success, version: 2 },
    { ...success, failure: f.failure },
    { ...f, valueSlot: { present: false } },
    { tag: 'folio-request-result', version: 1, ok: true },
    { tag: 'folio-request-result', version: 1, ok: false },
    { tag: 'folio-request-result', version: 1, ok: 'true', valueSlot: { present: false } },
    { tag: 'folio-request-result', version: 1, ok: true, valueSlot: { present: true } },
    { ...success, valueSlot: { present: true, value: undefined } },
    { ...success, valueSlot: { present: false, value: 0 } },
    { ...success, valueSlot: { present: false, extra: 1 } },
    { ...success, valueSlot: new FakeSlot() },
    { ...success, [sym]: 1 },
    nonEnum,
    { ...f, failure: { ...f.failure, version: 2 } },
  ];
  for (const x of invalid) expect(decodeRequestReplyV1(x)).toBeNull();
});

it('rejects accessor-backed envelopes without invoking getters', () => {
  let calls = 0;
  const okGetter: any = { tag: 'folio-request-result', version: 1, valueSlot: { present: false } };
  Object.defineProperty(okGetter, 'ok', { get() { calls++; return true; }, enumerable: true, configurable: true });
  expect(decodeRequestReplyV1(okGetter)).toBeNull();

  const presentGetter: any = { tag: 'folio-request-result', version: 1, ok: true, valueSlot: { present: false } };
  Object.defineProperty(presentGetter.valueSlot, 'present', { get() { calls++; return false; }, enumerable: true, configurable: true });
  expect(decodeRequestReplyV1(presentGetter)).toBeNull();

  const valueGetter: any = { tag: 'folio-request-result', version: 1, ok: true, valueSlot: { present: true } };
  Object.defineProperty(valueGetter.valueSlot, 'value', { get() { calls++; return 1; }, enumerable: true, configurable: true });
  expect(decodeRequestReplyV1(valueGetter)).toBeNull();

  const failureGetter = { tag: 'folio-request-result', version: 1, ok: false };
  Object.defineProperty(failureGetter, 'failure', { get() { calls++; return base(); }, enumerable: true, configurable: true });
  expect(decodeRequestReplyV1(failureGetter)).toBeNull();

  expect(calls).toBe(0);
  expect(decodeRequestReplyV1({ tag: 'folio-request-result', version: 1, ok: false, failure: base() }, 'sync:status')).toBeNull();
  expect(decodeRequestReplyV1({ tag: 'folio-request-result', version: 1, ok: true, valueSlot: { present: false } }, 'unknown')).toBeNull();
});

// Parent-authored regression supplements, separate from worker literal output.
it('accepts affirmative generation mismatches with or without an actual IO rejection', () => {
  for (const input of [conflict(), conflict({sourceOutcome: {
    source: 'RECOVERY_IO', contractVersion: 3, state: 'REJECTED', reason: 'PRECONDITION',
  }})]) expect(decodeStorageFailureV1(input)).toEqual(input);
});

it('keeps a safe unrecognized retained-owner outcome unknown', () => {
  const input = base({requestType: 'UNRECOGNIZED', kind: 'OUTCOME_UNKNOWN'});
  expect(decodeStorageFailureV1(input, 'recovery:write')).toEqual(input);
});

it('detaches precondition metadata from the source object', () => {
  const input = conflict();
  const output = decodeStorageFailureV1(input);
  expect(output?.precondition).not.toBe(input.precondition);
  expect(output?.precondition).toEqual(input.precondition);
  Reflect.set(output!.precondition!, 'observedActualGeneration', 99);
  expect(input.precondition!.observedActualGeneration).toBe(65);
});

it('accepts the declared cause-list count and individual-code length boundaries', () => {
  const input = base({sourceCauseCodes: Array.from({length: 8}, () => 'A'.repeat(128))});
  expect(decodeStorageFailureV1(input)?.sourceCauseCodes).toEqual(input.sourceCauseCodes);
});

// Parent replacement: worker13 used invented field aliases and was not adopted.
// Individually typed fields keep these cases about semantic contradictions.
const semanticContradictions: Array<[string, StorageFailureV1]> = [
  ['A with unproven dispatch', cap({mutationDispatch: 'UNPROVEN'})],
  ['A after observed dispatch', cap({mutationDispatch: 'DISPATCHED', proofOrigin: 'DISPATCH_OBSERVED'})],
  ['A at prepare stage', cap({stage: 'PREPARE'})],
  ['A refers to prior attempt', cap({failureSubject: 'PRIOR_ATTEMPT'})],
  ['A without a native family', cap({family: 'REQUEST', sourceOutcome: null})],
  ['A unrecognized request', cap({requestType: 'UNRECOGNIZED'})],
  ['A incomplete cause summary', cap({causeSummaryIncomplete: true})],
  ['A without stable cause code', cap({sourceCauseCodes: []})],
  ['A recovery UNKNOWN', cap({sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'UNKNOWN', reason: 'UNKNOWN'}})],
  ['A recovery EXISTS', cap({sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'EXISTS', reason: 'EXISTS'}})],
  ['A K reason is not reserve', cap({family: 'K', sourceOutcome: {source: 'K_EXCEPTION', state: 'UNKNOWN', reason: 'PREPARE'}})],
  ['A K native rejection is not the reserve wrapper', cap({family: 'K', sourceOutcome: {source: 'K_EXCEPTION', state: 'REJECTED', reason: 'RESERVE'}})],
  ['D lacks precondition', conflict({precondition: null})],
  ['D lacks validated origin', conflict({proofOrigin: 'NONE'})],
  ['D GENERATION has equal observed generation', conflict({precondition: {expectedGeneration: 64, observedActualGeneration: 64, mismatch: 'GENERATION'}})],
  ['D contains K outcome', conflict({sourceOutcome: {source: 'K_EXCEPTION', state: 'UNKNOWN', reason: 'RESERVE'}})],
  ['E has precondition', base({precondition: {expectedGeneration: 64, observedActualGeneration: 65, mismatch: 'GENERATION'}})],
  ['C claims non-dispatch proof', base({kind: 'OUTCOME_UNKNOWN', mutationDispatch: 'NOT_DISPATCHED_PROVEN', proofOrigin: 'LOCAL_ADMISSION_GUARD'})],
  ['C unproven yet observed', base({kind: 'OUTCOME_UNKNOWN', proofOrigin: 'DISPATCH_OBSERVED'})],
  ['C dispatched without observation', base({kind: 'OUTCOME_UNKNOWN', mutationDispatch: 'DISPATCHED'})],
  ['E claims observed dispatch', base({mutationDispatch: 'DISPATCHED', proofOrigin: 'DISPATCH_OBSERVED'})],
  ['prior subject with request stage', base({kind: 'OUTCOME_UNKNOWN', failureSubject: 'PRIOR_ATTEMPT'})],
  ['prior stage with current subject', base({kind: 'OUTCOME_UNKNOWN', stage: 'PRIOR_ATTEMPT', failureSubject: 'CURRENT_ATTEMPT'})],
  ['K carries recovery outcome', base({family: 'K', sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'REJECTED', reason: 'CAPACITY'}})],
  ['REQUEST carries K outcome', base({sourceOutcome: {source: 'K_EXCEPTION', state: 'UNKNOWN', reason: 'RESERVE'}})],
  ['published carries a rejection reason', base({kind: 'OUTCOME_UNKNOWN', family: 'CHECKPOINT', stage: 'HEAD_CAS', mutationDispatch: 'DISPATCHED', proofOrigin: 'DISPATCH_OBSERVED', sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'PUBLISHED', reason: 'REJECTED'}})],
  ['rejected source has no reason', base({family: 'CHECKPOINT', sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'REJECTED', reason: null}})],
  ['published treated as unclassified', base({family: 'CHECKPOINT', sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'PUBLISHED', reason: null}})],
  ...[-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((generation): [string, StorageFailureV1] => [
    `invalid precondition generation ${String(generation)}`,
    conflict({precondition: {expectedGeneration: generation, observedActualGeneration: 65, mismatch: 'GENERATION'}}),
  ]),
];
it.each(semanticContradictions)('rejects semantic contradiction: %s', (_name, input) => {
  expect(decodeStorageFailureV1(input)).toBeNull();
});

// Parent-authored supplement requested by the independent Codex review.
it('preserves genuine dispatched IO UNKNOWN and ordered causes through JSON', () => {
  const input = base({kind: 'OUTCOME_UNKNOWN', family: 'CHECKPOINT', stage: 'PREPARE',
    failureSubject: 'CURRENT_ATTEMPT', mutationDispatch: 'DISPATCHED', proofOrigin: 'DISPATCH_OBSERVED',
    sourceOutcome: {source: 'RECOVERY_IO', contractVersion: 3, state: 'UNKNOWN', reason: 'PRIVATE_IO_V3_UNKNOWN'},
    sourceCauseCodes: ['FLUSH_UNKNOWN', 'READBACK_UNAVAILABLE'], causeSummaryIncomplete: false,
  });
  const decoded = decodeStorageFailureV1(JSON.parse(JSON.stringify(input)), 'recovery:write');
  expect(decoded).toEqual(input);
  expect(decoded?.sourceOutcome).toEqual(input.sourceOutcome);
  expect(decoded?.sourceCauseCodes).toEqual(['FLUSH_UNKNOWN', 'READBACK_UNAVAILABLE']);
});

it('rejects the unrecognized mismatch exception outside the request family', () => {
  const input = base({kind: 'OUTCOME_UNKNOWN', family: 'CHECKPOINT', requestType: 'UNRECOGNIZED'});
  expect(decodeStorageFailureV1(input)).toEqual(input);
  expect(decodeStorageFailureV1(input, 'recovery:write')).toBeNull();
});
