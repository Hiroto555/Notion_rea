import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VALID_SAMPLE_VERDICT,
  compareRecoveryRead,
  heldQuitDisposition,
  interruptOwnedChild,
  normalQuitReady,
  selectRecoveryAcks,
  waitForOwnedChildExit,
} from './e2e/mac-trial-manual-observation';
import { emptyCrashRecoverySnapshot } from '../src/shared/crash-recovery';
import type {
  CaptureBinding,
  HeldQuitArgs,
  ObservationBody,
  ObservationEvent,
  ObservationEventType,
  ObservationRead,
  ObservationStatus,
  OwnedChildHandle,
  RecoveryAckSelection,
  RecoveryHoldReason,
  ValidatedSample,
} from './e2e/mac-trial-manual-observation';

class FakeChild extends EventEmitter implements OwnedChildHandle {
  pid: number | undefined;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killResult = true;
  readonly killCalls: NodeJS.Signals[] = [];

  constructor(...args: (number | undefined)[]) {
    super();
    this.pid = args.length === 0 ? 4242 : args[0];
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return this.killResult;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.killed = true;
    this.emit('exit', code, signal);
  }
}

const BINDING: CaptureBinding = {
  runId: 'run-7',
  nonce: 'nonce-xyz',
  sourceCandidate: 'candidate-hash',
  artifactSha256: 'a1'.repeat(32),
  fixtureSha256: 'b2'.repeat(32),
  dataDir: '/tmp/data',
  vaultDir: '/tmp/vault',
};

const ev = (
  index: number,
  type: ObservationEventType,
  seq?: number,
  generation?: number,
  snapshotJson: string | null = null,
): ObservationEvent => {
  const event: ObservationEvent = { index, type, snapshotJson };
  if (seq !== undefined) event.seq = seq;
  if (generation !== undefined) event.generation = generation;
  return event;
};

function mkRead(
  events: ObservationEvent[],
  status: ObservationStatus | null,
  over: {
    rendererInstanceId?: string;
    queueEpoch?: number;
    binding?: Partial<CaptureBinding>;
    observation?: Partial<Omit<ObservationBody, 'events' | 'status'>> | null;
  } = {},
): ObservationRead {
  const observation =
    over.observation === null
      ? null
      : { incomplete: false, captureStopped: false, ...(over.observation ?? {}), events, status };
  return {
    rendererInstanceId: over.rendererInstanceId ?? 'renderer-0001',
    queueEpoch: over.queueEpoch ?? 3,
    binding: { ...BINDING, ...(over.binding ?? {}) },
    observation,
  };
}

const valid = (read: ObservationRead | null): ValidatedSample => ({
  verdict: VALID_SAMPLE_VERDICT,
  read,
});

const preStatus: ObservationStatus = { savedSeq: 1, offeredSeq: 1, generation: 1, state: 'idle' };
const finalStatus: ObservationStatus = {
  savedSeq: 3,
  offeredSeq: 4,
  generation: 2,
  state: 'offered-pending',
};

const preEvents = (): ObservationEvent[] => [
  ev(0, 'INIT'),
  ev(1, 'OFFERED', 1, 1),
  ev(2, 'ACK_APPLIED', 1, 1, 'snap-edit-1'),
];

const finalEvents = (): ObservationEvent[] => [
  ...preEvents(),
  ev(3, 'OFFERED', 2, 2),
  ev(4, 'ACK_APPLIED', 3, 2, 'snap-edit-3'),
  ev(5, 'OFFERED', 4, 2),
];

const targetIsEditSeq1 = (e: ObservationEvent): boolean =>
  e.type === 'ACK_APPLIED' && e.seq === 1;

const readySelection = (): RecoveryAckSelection => {
  const r = selectRecoveryAcks(
    valid(mkRead(preEvents(), preStatus)),
    valid(mkRead(finalEvents(), finalStatus)),
    targetIsEditSeq1,
  );
  if (r.kind !== 'READY') throw new Error('fixture not READY: ' + JSON.stringify(r));
  return r;
};

describe('selectRecoveryAcks', () => {
  it('returns READY with exact target and terminal facts when tail differs', () => {
    const r = readySelection();
    expect(r.kind).toBe('READY');
    if (r.kind !== 'READY') return;
    expect(r.target).toEqual({
      index: 2,
      type: 'ACK_APPLIED',
      seq: 1,
      generation: 1,
      snapshotJson: 'snap-edit-1',
    });
    expect(r.terminal).toEqual({
      index: 4,
      type: 'ACK_APPLIED',
      seq: 3,
      generation: 2,
      snapshotJson: 'snap-edit-3',
    });
    expect(r.intervening).toEqual([
      { index: 3, type: 'OFFERED', seq: 2, generation: 2, snapshotJson: null },
    ]);
    expect(r.subsequent).toEqual([
      { index: 5, type: 'OFFERED', seq: 4, generation: 2, snapshotJson: null },
    ]);
    expect(r.outstanding).toEqual({ offeredSeq: 4, savedSeq: 3 });
    expect(r.status.savedSeq).toBe(3);
    expect(r.queueEpoch).toBe(3);
  });

  it('reports null outstanding when nothing is offered beyond saved', () => {
    const status: ObservationStatus = {
      savedSeq: 3,
      offeredSeq: 3,
      generation: 2,
      state: 'idle',
    };
    const r = selectRecoveryAcks(
      valid(mkRead(preEvents(), preStatus)),
      valid(mkRead(finalEvents(), status)),
      targetIsEditSeq1,
    );
    expect(r.kind).toBe('READY');
    if (r.kind === 'READY') expect(r.outstanding).toBeNull();
  });

  it('permits a later equally-matching ACK and a newer dissimilar terminal', () => {
    const events = [
      ...preEvents(),
      ev(3, 'ACK_APPLIED', 3, 2, 'snap-edit-1'),
      ev(4, 'ACK_APPLIED', 4, 3, 'snap-other'),
    ];
    const r = selectRecoveryAcks(
      valid(mkRead(preEvents(), preStatus)),
      valid(mkRead(events, { savedSeq: 4, offeredSeq: 4, generation: 3, state: 'idle' })),
      (e) => e.snapshotJson === 'snap-edit-1',
    );
    expect(r.kind).toBe('READY');
    if (r.kind !== 'READY') return;
    expect(r.target).toMatchObject({ index: 2, seq: 1 });
    expect(r.terminal).toMatchObject({ index: 4, seq: 4, snapshotJson: 'snap-other' });
  });

  const mutatedFinal = (): ObservationEvent[] => {
    const events = finalEvents();
    events[1] = ev(1, 'OFFERED', 9, 1);
    return events;
  };

  const holdCases: Array<{
    name: string;
    pre: ValidatedSample;
    final: ValidatedSample;
    reason: RecoveryHoldReason;
    pred?: (e: ObservationEvent) => boolean;
  }> = [
    {
      name: 'non-VALID pre verdict',
      pre: { verdict: 'INVALID', read: mkRead(preEvents(), preStatus) },
      final: valid(mkRead(finalEvents(), finalStatus)),
      reason: 'SAMPLE_NOT_VALID',
    },
    {
      name: 'null pre read',
      pre: { verdict: VALID_SAMPLE_VERDICT, read: null },
      final: valid(mkRead(finalEvents(), finalStatus)),
      reason: 'SAMPLE_READ_MISSING',
    },
    {
      name: 'null observation',
      pre: valid(mkRead(preEvents(), preStatus, { observation: null })),
      final: valid(mkRead(finalEvents(), finalStatus)),
      reason: 'OBSERVATION_NULL',
    },
    {
      name: 'binding drift',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(finalEvents(), finalStatus, { binding: { nonce: 'other' } })),
      reason: 'BINDING_DRIFT',
    },
    {
      name: 'renderer drift',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(finalEvents(), finalStatus, { rendererInstanceId: 'renderer-9999' })),
      reason: 'RENDERER_OR_EPOCH_DRIFT',
    },
    {
      name: 'epoch drift',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(finalEvents(), finalStatus, { queueEpoch: 4 })),
      reason: 'RENDERER_OR_EPOCH_DRIFT',
    },
    {
      name: 'incomplete capture',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(finalEvents(), finalStatus, { observation: { incomplete: true } })),
      reason: 'INCOMPLETE_CAPTURE',
    },
    {
      name: 'non-contiguous pre history',
      pre: valid(mkRead([ev(0, 'INIT'), ev(2, 'OFFERED', 1, 1)], preStatus)),
      final: valid(mkRead(finalEvents(), finalStatus)),
      reason: 'TRUNCATED_HISTORY',
    },
    {
      name: 'final shorter than pre',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(preEvents().slice(0, 2), preStatus)),
      reason: 'PREFIX_CHANGED',
    },
    {
      name: 'mutated prefix event',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(mutatedFinal(), finalStatus)),
      reason: 'PREFIX_CHANGED',
    },
    {
      name: 'regressed status',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(
        mkRead(finalEvents(), { savedSeq: 0, offeredSeq: 4, generation: 2, state: 'x' }),
      ),
      reason: 'STATUS_REGRESSED',
    },
    {
      name: 'init only history',
      pre: valid(mkRead([ev(0, 'INIT')], null)),
      final: valid(mkRead([ev(0, 'INIT')], null)),
      reason: 'NO_TARGET',
    },
    {
      name: 'no predicate target',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(finalEvents(), finalStatus)),
      reason: 'NO_TARGET',
      pred: () => false,
    },
    {
      name: 'stopped pre capture cannot grow in final',
      pre: valid(mkRead(preEvents(), preStatus, { observation: { captureStopped: true } })),
      final: valid(mkRead(finalEvents(), finalStatus)),
      reason: 'CAPTURE_DRIFT',
    },
    {
      name: 'predicate applies only to ACK_APPLIED',
      pre: valid(
        mkRead(
          [ev(0, 'INIT'), ev(1, 'OFFERED', 1, 1)],
          { savedSeq: 0, offeredSeq: 1, generation: 0, state: 'x' },
        ),
      ),
      final: valid(
        mkRead(
          [ev(0, 'INIT'), ev(1, 'OFFERED', 1, 1), ev(2, 'OFFERED', 2, 1)],
          { savedSeq: 0, offeredSeq: 2, generation: 1, state: 'x' },
        ),
      ),
      reason: 'NO_TARGET',
      pred: (e) => e.type === 'OFFERED' && e.seq === 1,
    },
    {
      name: 'target ack missing snapshot facts',
      pre: valid(
        mkRead(
          [ev(0, 'INIT'), ev(1, 'OFFERED', 1, 1), ev(2, 'ACK_APPLIED', 1, 1, null)],
          preStatus,
        ),
      ),
      final: valid(
        mkRead(
          [
            ev(0, 'INIT'),
            ev(1, 'OFFERED', 1, 1),
            ev(2, 'ACK_APPLIED', 1, 1, null),
            ev(3, 'ACK_APPLIED', 3, 2, 'snap-edit-3'),
          ],
          finalStatus,
        ),
      ),
      reason: 'TARGET_FACTS_MISSING',
    },
    {
      name: 'terminal ack missing snapshot',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(
        mkRead(
          [...preEvents(), ev(3, 'ACK_APPLIED', 3, 2, null)],
          { savedSeq: 3, offeredSeq: 3, generation: 2, state: 'x' },
        ),
      ),
      reason: 'TERMINAL_ACK_FACTS_MISSING',
    },
    {
      name: 'terminal ack missing facts',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(
        mkRead(
          [...preEvents(), ev(3, 'ACK_APPLIED', undefined, undefined, 'x')],
          { savedSeq: 1, offeredSeq: 1, generation: 1, state: 'x' },
        ),
      ),
      reason: 'TERMINAL_ACK_FACTS_MISSING',
    },
    {
      name: 'status does not correspond',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(
        mkRead(finalEvents(), { savedSeq: 9, offeredSeq: 4, generation: 2, state: 'x' }),
      ),
      reason: 'STATUS_MISMATCH',
    },
    {
      name: 'missing final status',
      pre: valid(mkRead(preEvents(), null)),
      final: valid(mkRead(finalEvents(), null)),
      reason: 'STATUS_MISMATCH',
    },
    {
      name: 'final capture stopped',
      pre: valid(mkRead(preEvents(), preStatus)),
      final: valid(mkRead(finalEvents(), finalStatus, { observation: { captureStopped: true } })),
      reason: 'CAPTURE_DRIFT',
    },
  ];

  it.each(holdCases)('HOLD: $name', ({ pre, final, reason, pred }) => {
    const r = selectRecoveryAcks(pre, final, pred ?? targetIsEditSeq1);
    expect(r.kind).toBe('HOLD');
    if (r.kind === 'HOLD') expect(r.reason).toBe(reason);
  });
});

describe('normalQuitReady', () => {
  it('is true only for a validated edit ack and saved data-state', () => {
    expect(normalQuitReady(true, 'saved')).toBe(true);
    expect(normalQuitReady(true, 'checkpoint')).toBe(false);
    expect(normalQuitReady(true, 'pending')).toBe(false);
    expect(normalQuitReady(true, null)).toBe(false);
    expect(normalQuitReady(false, 'saved')).toBe(false);
  });
});

describe('heldQuitDisposition', () => {
  const base: HeldQuitArgs = {
    closeObserved: true,
    attempt: 'performed',
    childExited: false,
    childExit: null,
    windowOwnedAlive: true,
    saveState: 'pending',
    preCheckpointValid: true,
  };

  it('confirmed held quit with pending window is interrupt eligible', () => {
    expect(heldQuitDisposition(base)).toEqual({ kind: 'INTERRUPT_ELIGIBLE' });
    expect(heldQuitDisposition({ ...base, saveState: 'error' })).toEqual({
      kind: 'INTERRUPT_ELIGIBLE',
    });
  });

  it('actual original-child exit after confirmed hold is FAIL including code0', () => {
    expect(
      heldQuitDisposition({ ...base, childExited: true, childExit: { code: 0, signal: null } }),
    ).toEqual({
      kind: 'FAIL',
      reason: 'CHILD_EXITED_DURING_HOLD',
      exit: { code: 0, signal: null },
    });
    expect(
      heldQuitDisposition({ ...base, childExited: true, childExit: { code: 1, signal: null } }),
    ).toMatchObject({ kind: 'FAIL', reason: 'CHILD_EXITED_DURING_HOLD' });
  });

  it('flagged exit without code or signal facts is HOLD, not a proven FAIL', () => {
    expect(
      heldQuitDisposition({
        ...base,
        childExited: true,
        childExit: { code: null, signal: null },
      }),
    ).toEqual({
      kind: 'HOLD',
      reason: 'CHILD_STATE_UNKNOWN',
      exit: { code: null, signal: null },
    });
    expect(
      heldQuitDisposition({
        ...base,
        childExited: true,
        childExit: { code: null, signal: 'SIGTERM' },
      }),
    ).toMatchObject({ kind: 'FAIL', reason: 'CHILD_EXITED_DURING_HOLD' });
  });

  it('cancelled attempt is NOT_RUN even if the child exited', () => {
    expect(
      heldQuitDisposition({
        ...base,
        attempt: 'cancelled',
        childExited: true,
        childExit: { code: 0, signal: null },
      }),
    ).toEqual({ kind: 'NOT_RUN', reason: 'CANCELLED', exit: { code: 0, signal: null } });
  });

  it('absent attempt is NOT_RUN retaining the raw exit', () => {
    expect(
      heldQuitDisposition({
        ...base,
        attempt: 'absent',
        childExited: true,
        childExit: { code: null, signal: 'SIGTERM' },
      }),
    ).toEqual({ kind: 'NOT_RUN', reason: 'ABSENT', exit: { code: null, signal: 'SIGTERM' } });
  });

  it('invalid or uncertain declaration holds', () => {
    expect(heldQuitDisposition({ ...base, attempt: 'invalid' })).toMatchObject({
      kind: 'HOLD',
      reason: 'UNCERTAIN_ATTEMPT',
    });
    expect(heldQuitDisposition({ ...base, attempt: 'unknown' })).toMatchObject({
      kind: 'HOLD',
      reason: 'UNCERTAIN_ATTEMPT',
    });
  });

  it('unobserved child state holds', () => {
    expect(heldQuitDisposition({ ...base, childExited: null })).toMatchObject({
      kind: 'HOLD',
      reason: 'CHILD_STATE_UNKNOWN',
    });
  });

  it('window, pending state and checkpoint gates hold', () => {
    expect(heldQuitDisposition({ ...base, windowOwnedAlive: null })).toMatchObject({
      kind: 'HOLD',
      reason: 'WINDOW_UNVERIFIED',
    });
    expect(heldQuitDisposition({ ...base, windowOwnedAlive: false })).toMatchObject({
      kind: 'HOLD',
      reason: 'WINDOW_UNVERIFIED',
    });
    expect(heldQuitDisposition({ ...base, saveState: 'saved' })).toMatchObject({
      kind: 'HOLD',
      reason: 'NO_PENDING_STATE',
    });
    expect(heldQuitDisposition({ ...base, saveState: null })).toMatchObject({
      kind: 'HOLD',
      reason: 'NO_PENDING_STATE',
    });
    expect(heldQuitDisposition({ ...base, preCheckpointValid: false })).toMatchObject({
      kind: 'HOLD',
      reason: 'CHECKPOINT_INVALID',
    });
  });
});

it('heldQuitDisposition: no observed close attempt holds', () => {
  expect(
    heldQuitDisposition({
      attempt: 'performed',
      closeObserved: false,
      childExited: false,
      childExit: null,
      windowOwnedAlive: true,
      saveState: 'pending',
      preCheckpointValid: true,
    }),
  ).toMatchObject({ kind: 'HOLD', reason: 'NO_CLOSE_OBSERVED' });
});

describe('compareRecoveryRead', () => {
  const validSnapshot = emptyCrashRecoverySnapshot();
  const terminal = {
    index: 4,
    type: 'ACK_APPLIED' as const,
    seq: 3,
    generation: 2,
    snapshotJson: JSON.stringify(validSnapshot),
  };

  it('matches same generation with structurally equal JSON despite key order', () => {
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(validSnapshot).reverse()),
    );
    const r = compareRecoveryRead(terminal, {
      status: 'ready',
      generation: 2,
      snapshotJson: reordered,
    });
    expect(r).toEqual({ kind: 'MATCH', generation: 2, snapshotJson: reordered });
  });

  it('same generation different snapshot is FAIL', () => {
    expect(
      compareRecoveryRead(terminal, {
        status: 'ready',
        generation: 2,
        snapshotJson: JSON.stringify({
          ...validSnapshot,
          rawDrafts: [{ scope: 'record', pageId: 'p', key: 'k', value: 'changed' }],
        }),
      }),
    ).toMatchObject({ kind: 'FAIL', reason: 'SNAPSHOT_MISMATCH' });
  });

  it('older generation ready read is FAIL', () => {
    expect(
      compareRecoveryRead(terminal, {
        status: 'ready',
        generation: 1,
        snapshotJson: JSON.stringify(validSnapshot),
      }),
    ).toMatchObject({ kind: 'FAIL', reason: 'OLDER_GENERATION' });
  });

  it('reliably known empty at same or older generation is FAIL', () => {
    expect(
      compareRecoveryRead(terminal, { status: 'empty', generation: 2, snapshotJson: null }),
    ).toMatchObject({ kind: 'FAIL', reason: 'EMPTY_AFTER_ACK' });
    expect(
      compareRecoveryRead(terminal, { status: 'empty', generation: 1, snapshotJson: null }),
    ).toMatchObject({ kind: 'FAIL', reason: 'EMPTY_AFTER_ACK' });
  });

  it('newer generation holds even when the read is empty', () => {
    expect(
      compareRecoveryRead(terminal, { status: 'empty', generation: 5, snapshotJson: null }),
    ).toMatchObject({ kind: 'HOLD', reason: 'NEWER_GENERATION' });
    expect(
      compareRecoveryRead(terminal, {
        status: 'ready',
        generation: 5,
        snapshotJson: JSON.stringify(validSnapshot),
      }),
    ).toMatchObject({ kind: 'HOLD', reason: 'NEWER_GENERATION' });
  });

  it('malformed empty generations hold instead of failing', () => {
    for (const generation of [null, -1, 1.5, Number.NaN]) {
      expect(
        compareRecoveryRead(terminal, { status: 'empty', generation, snapshotJson: null }),
      ).toMatchObject({ kind: 'HOLD', reason: 'READ_MALFORMED' });
    }
  });

  it('ready reads with missing or invalid JSON hold as malformed', () => {
    expect(
      compareRecoveryRead(terminal, { status: 'ready', generation: 2, snapshotJson: 'null' }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_MALFORMED' });
    expect(
      compareRecoveryRead(terminal, { status: 'ready', generation: 2, snapshotJson: '{broken' }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_MALFORMED' });
    expect(
      compareRecoveryRead(terminal, { status: 'ready', generation: 2, snapshotJson: '[]' }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_MALFORMED' });
    expect(
      compareRecoveryRead(terminal, { status: 'ready', generation: 2, snapshotJson: '{}' }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_MALFORMED' });
    expect(
      compareRecoveryRead(terminal, {
        status: 'ready',
        generation: -1,
        snapshotJson: JSON.stringify(validSnapshot),
      }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_MALFORMED' });
  });

  it('blocked and malformed reads hold with the raw reply retained', () => {
    expect(
      compareRecoveryRead(terminal, {
        status: 'blocked',
        generation: 2,
        snapshotJson: null,
        raw: { status: 'blocked' },
      }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_BLOCKED' });
    expect(
      compareRecoveryRead(terminal, { status: 'ready', generation: null, snapshotJson: null }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_MALFORMED' });
    expect(
      compareRecoveryRead(terminal, {
        status: null,
        generation: 2,
        snapshotJson: JSON.stringify(validSnapshot),
        raw: { unexpected: true },
      }),
    ).toMatchObject({ kind: 'HOLD', reason: 'READ_INVALID' });
  });
});


describe('interruptOwnedChild', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('permits reopen only after proven SIGKILL termination', async () => {
    const child = new FakeChild();
    let t = 1000;
    const now = () => t;
    const pending = interruptOwnedChild(child, 500, now);
    t = 1040;
    child.emitExit(null, 'SIGKILL');
    const r = await pending;
    expect(r).toEqual({
      kind: 'INTERRUPTED',
      reopenPermitted: true,
      pid: 4242,
      exit: { code: null, signal: 'SIGKILL' },
      issuedAt: 1000,
      exitedAt: 1040,
    });
    expect(child.killCalls).toEqual(['SIGKILL']);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('exit code present is wrong termination and never authorizes reopen', async () => {
    const child = new FakeChild();
    const pending = interruptOwnedChild(child, 500);
    child.emitExit(0, null);
    const r = await pending;
    expect(r.kind).toBe('HOLD');
    if (r.kind === 'HOLD') {
      expect(r.reason).toBe('WRONG_TERMINATION');
      expect(r.reopenPermitted).toBe(false);
      expect(r.exit).toEqual({ code: 0, signal: null });
    }
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('non-SIGKILL signal exit is wrong termination', async () => {
    const child = new FakeChild();
    const pending = interruptOwnedChild(child, 500);
    child.emitExit(null, 'SIGTERM');
    const r = await pending;
    expect(r).toMatchObject({
      kind: 'HOLD',
      reason: 'WRONG_TERMINATION',
      reopenPermitted: false,
      exit: { code: null, signal: 'SIGTERM' },
    });
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('refused signal holds without reopen', async () => {
    const child = new FakeChild();
    child.killResult = false;
    const r = await interruptOwnedChild(child, 500);
    expect(r).toMatchObject({ kind: 'HOLD', reason: 'SIGNAL_REFUSED', reopenPermitted: false });
    expect(child.killCalls).toEqual(['SIGKILL']);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('timeout holds and never authorizes reopen', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = interruptOwnedChild(child, 200);
    await vi.advanceTimersByTimeAsync(250);
    const r = await pending;
    expect(r).toMatchObject({ kind: 'HOLD', reason: 'TIMEOUT', reopenPermitted: false });
    expect(child.killCalls).toEqual(['SIGKILL']);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('missing pid holds before signalling', async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const r = await interruptOwnedChild(child, 100);
    expect(r).toMatchObject({ kind: 'HOLD', reason: 'NO_POSITIVE_PID', reopenPermitted: false });
    expect(child.killCalls).toEqual([]);
  });

  it('zero, negative or nonfinite timeout holds without any signal', async () => {
    const child = new FakeChild();
    for (const timeout of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await interruptOwnedChild(child, timeout);
      expect(r).toMatchObject({ kind: 'HOLD', reason: 'BAD_TIMEOUT', reopenPermitted: false });
    }
    expect(child.killCalls).toEqual([]);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('already exited child holds before signalling', async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    const r = await interruptOwnedChild(child, 100);
    expect(r).toMatchObject({ kind: 'HOLD', reason: 'ALREADY_EXITED', reopenPermitted: false });
    expect(child.killCalls).toEqual([]);
  });
});

describe('waitForOwnedChildExit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves EXITED on natural child exit without signalling', async () => {
    const child = new FakeChild();
    const pending = waitForOwnedChildExit(child, 500);
    child.emitExit(0, null);
    const r = await pending;
    expect(r.kind).toBe('EXITED');
    if (r.kind === 'EXITED') {
      expect(r.exit).toEqual({ code: 0, signal: null });
      expect(r.pid).toBe(4242);
    }
    expect(child.killCalls).toEqual([]);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('times out without signalling', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = waitForOwnedChildExit(child, 100);
    await vi.advanceTimersByTimeAsync(150);
    const r = await pending;
    expect(r).toEqual({ kind: 'TIMEOUT', pid: 4242, waitedMs: 100 });
    expect(child.killCalls).toEqual([]);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('returns prior exit facts immediately', async () => {
    const child = new FakeChild();
    child.exitCode = 0;
    const r = await waitForOwnedChildExit(child, 100);
    expect(r).toMatchObject({ kind: 'EXITED', exit: { code: 0, signal: null } });
    expect(child.killCalls).toEqual([]);
  });
});
