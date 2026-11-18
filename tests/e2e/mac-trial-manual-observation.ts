import type { ChildProcess } from 'node:child_process';

import { validateCrashRecoverySnapshot } from '../../src/shared/crash-recovery';

export type ObservationEventType = 'INIT' | 'OFFERED' | 'ACK_APPLIED';

export interface ObservationEvent {
  index: number;
  type: ObservationEventType;
  seq?: number;
  generation?: number;
  snapshotJson: string | null;
}

export interface ObservationStatus {
  savedSeq: number;
  offeredSeq: number;
  generation: number;
  state: string;
}

export interface CaptureBinding {
  runId: string;
  nonce: string;
  sourceCandidate: string;
  artifactSha256: string;
  fixtureSha256: string;
  dataDir: string;
  vaultDir: string;
}

export interface ObservationBody {
  incomplete: boolean;
  captureStopped: boolean;
  events: ObservationEvent[];
  status: ObservationStatus | null;
}

export interface ObservationRead {
  rendererInstanceId: string;
  queueEpoch: number;
  binding: CaptureBinding;
  observation: ObservationBody | null;
}

export const VALID_SAMPLE_VERDICT = 'VALID';

export interface ValidatedSample {
  verdict: string;
  read: ObservationRead | null;
}

export interface EventFact {
  index: number;
  type: ObservationEventType;
  seq: number | null;
  generation: number | null;
  snapshotJson: string | null;
}

export interface OutstandingOffer {
  offeredSeq: number;
  savedSeq: number;
}

export type RecoveryHoldReason =
  | 'SAMPLE_NOT_VALID'
  | 'SAMPLE_READ_MISSING'
  | 'BINDING_DRIFT'
  | 'RENDERER_OR_EPOCH_DRIFT'
  | 'OBSERVATION_NULL'
  | 'INCOMPLETE_CAPTURE'
  | 'TRUNCATED_HISTORY'
  | 'PREFIX_CHANGED'
  | 'STATUS_REGRESSED'
  | 'NO_TARGET'
  | 'TARGET_CHANGED'
  | 'TARGET_FACTS_MISSING'
  | 'NO_TERMINAL_ACK'
  | 'TERMINAL_ACK_FACTS_MISSING'
  | 'STATUS_MISMATCH'
  | 'CAPTURE_DRIFT';

export type RecoveryAckSelection =
  | {
      kind: 'READY';
      rendererInstanceId: string;
      queueEpoch: number;
      binding: CaptureBinding;
      target: EventFact;
      terminal: EventFact;
      intervening: EventFact[];
      subsequent: EventFact[];
      outstanding: OutstandingOffer | null;
      status: ObservationStatus;
    }
  | { kind: 'HOLD'; reason: RecoveryHoldReason; detail: string };

const hold = (reason: RecoveryHoldReason, detail: string): RecoveryAckSelection => ({
  kind: 'HOLD',
  reason,
  detail,
});

const toFact = (event: ObservationEvent): EventFact => ({
  index: event.index,
  type: event.type,
  seq: event.seq ?? null,
  generation: event.generation ?? null,
  snapshotJson: event.snapshotJson,
});

const sameEvent = (a: ObservationEvent, b: ObservationEvent): boolean =>
  a.index === b.index &&
  a.type === b.type &&
  (a.seq ?? null) === (b.seq ?? null) &&
  (a.generation ?? null) === (b.generation ?? null) &&
  a.snapshotJson === b.snapshotJson;

const BINDING_KEYS: readonly (keyof CaptureBinding)[] = [
  'runId',
  'nonce',
  'sourceCandidate',
  'artifactSha256',
  'fixtureSha256',
  'dataDir',
  'vaultDir',
];

const contiguous = (events: ObservationEvent[]): boolean =>
  events.every((event, i) => event.index === i);

export function selectRecoveryAcks(
  pre: ValidatedSample,
  final: ValidatedSample,
  targetPredicate: (event: ObservationEvent) => boolean,
): RecoveryAckSelection {
  if (pre.verdict !== VALID_SAMPLE_VERDICT) {
    return hold('SAMPLE_NOT_VALID', 'pre verdict ' + pre.verdict);
  }
  if (final.verdict !== VALID_SAMPLE_VERDICT) {
    return hold('SAMPLE_NOT_VALID', 'final verdict ' + final.verdict);
  }
  if (pre.read === null) return hold('SAMPLE_READ_MISSING', 'pre');
  if (final.read === null) return hold('SAMPLE_READ_MISSING', 'final');
  const a = pre.read;
  const b = final.read;
  for (const key of BINDING_KEYS) {
    if (a.binding[key] !== b.binding[key]) return hold('BINDING_DRIFT', key);
  }
  if (a.rendererInstanceId.length === 0 || a.rendererInstanceId !== b.rendererInstanceId) {
    return hold('RENDERER_OR_EPOCH_DRIFT', 'rendererInstanceId');
  }
  if (a.queueEpoch !== b.queueEpoch) return hold('RENDERER_OR_EPOCH_DRIFT', 'queueEpoch');
  const ao = a.observation;
  const bo = b.observation;
  if (ao === null) return hold('OBSERVATION_NULL', 'pre');
  if (bo === null) return hold('OBSERVATION_NULL', 'final');
  if (ao.incomplete || bo.incomplete) {
    return hold('INCOMPLETE_CAPTURE', ao.incomplete ? 'pre' : 'final');
  }
  if (ao.captureStopped || bo.captureStopped) {
    return hold('CAPTURE_DRIFT', ao.captureStopped ? 'pre' : 'final');
  }
  if (!contiguous(ao.events)) return hold('TRUNCATED_HISTORY', 'pre');
  if (!contiguous(bo.events)) return hold('TRUNCATED_HISTORY', 'final');
  if (bo.events.length < ao.events.length) {
    return hold('PREFIX_CHANGED', 'final shorter than pre');
  }
  for (let i = 0; i < ao.events.length; i += 1) {
    const pa = ao.events[i];
    const pb = bo.events[i];
    if (pa === undefined || pb === undefined || !sameEvent(pa, pb)) {
      return hold('PREFIX_CHANGED', 'event index ' + i);
    }
  }
  if (ao.status !== null) {
    const bs = bo.status;
    if (
      bs === null ||
      bs.savedSeq < ao.status.savedSeq ||
      bs.offeredSeq < ao.status.offeredSeq ||
      bs.generation < ao.status.generation
    ) {
      return hold('STATUS_REGRESSED', 'final status older than pre status');
    }
  }
  let target: ObservationEvent | undefined;
  for (const event of ao.events) {
    if (event.type === 'ACK_APPLIED' && targetPredicate(event)) target = event;
  }
  if (target === undefined) {
    return hold('NO_TARGET', 'predicate matched no ACK_APPLIED in pre');
  }
  if (target.seq === undefined || target.generation === undefined || target.snapshotJson === null) {
    return hold('TARGET_FACTS_MISSING', 'target ACK index ' + target.index);
  }
  let terminal: ObservationEvent | undefined;
  for (const event of bo.events) {
    if (event.type === 'ACK_APPLIED') terminal = event;
  }
  if (terminal === undefined) {
    return hold('NO_TERMINAL_ACK', 'final history has no ACK_APPLIED');
  }
  if (terminal.seq === undefined || terminal.generation === undefined || terminal.snapshotJson === null) {
    return hold('TERMINAL_ACK_FACTS_MISSING', 'terminal ACK index ' + terminal.index);
  }
  const fs = bo.status;
  if (fs === null || fs.savedSeq !== terminal.seq || fs.generation !== terminal.generation) {
    return hold('STATUS_MISMATCH', 'final status does not correspond to terminal ACK');
  }
  const targetEvent = target;
  const terminalEvent = terminal;
  const intervening = bo.events
    .filter((event) => event.index > targetEvent.index && event.index < terminalEvent.index)
    .map(toFact);
  const subsequent = bo.events.filter((event) => event.index > terminalEvent.index).map(toFact);
  const outstanding =
    fs.offeredSeq > fs.savedSeq ? { offeredSeq: fs.offeredSeq, savedSeq: fs.savedSeq } : null;
  return {
    kind: 'READY',
    rendererInstanceId: b.rendererInstanceId,
    queueEpoch: b.queueEpoch,
    binding: { ...b.binding },
    target: toFact(targetEvent),
    terminal: toFact(terminalEvent),
    intervening,
    subsequent,
    outstanding,
    status: { ...fs },
  };
}

export interface ExitFacts {
  code: number | null;
  signal: NodeJS.Signals | null;
}
export type HeldQuitAttempt = 'performed' | 'cancelled' | 'absent' | 'invalid' | 'unknown';

export interface HeldQuitArgs {
  attempt: HeldQuitAttempt;
  closeObserved: boolean;
  childExited: boolean | null;
  childExit: ExitFacts | null;
  windowOwnedAlive: boolean | null;
  saveState: string | null;
  preCheckpointValid: boolean;
}

export type HeldQuitHoldReason =
  | 'UNCERTAIN_ATTEMPT'
  | 'CHILD_STATE_UNKNOWN'
  | 'WINDOW_UNVERIFIED'
  | 'NO_PENDING_STATE'
  | 'NO_CLOSE_OBSERVED'
  | 'CHECKPOINT_INVALID';

export type HeldQuitDisposition =
  | { kind: 'NOT_RUN'; reason: 'ABSENT' | 'CANCELLED'; exit: ExitFacts | null }
  | { kind: 'HOLD'; reason: HeldQuitHoldReason; exit: ExitFacts | null }
  | { kind: 'FAIL'; reason: 'CHILD_EXITED_DURING_HOLD'; exit: ExitFacts | null }
  | { kind: 'INTERRUPT_ELIGIBLE' };

export function normalQuitReady(editAckObserved: boolean, mainSaveState: string | null): boolean {
  return editAckObserved && mainSaveState === 'saved';
}

export function heldQuitDisposition(args: HeldQuitArgs): HeldQuitDisposition {
  const exit = args.childExit;
  if (args.attempt === 'absent') return { kind: 'NOT_RUN', reason: 'ABSENT', exit };
  if (args.attempt === 'cancelled') return { kind: 'NOT_RUN', reason: 'CANCELLED', exit };
  if (args.attempt !== 'performed') return { kind: 'HOLD', reason: 'UNCERTAIN_ATTEMPT', exit };
  if (args.childExited === true) {
    // A flagged exit without any concrete code/signal is not a proven exit —
    // HOLD, never a definitive FAIL. Any real code (even 0) or signal fails.
    if (exit !== null && (exit.code !== null || exit.signal !== null)) {
      return { kind: 'FAIL', reason: 'CHILD_EXITED_DURING_HOLD', exit };
    }
    return { kind: 'HOLD', reason: 'CHILD_STATE_UNKNOWN', exit };
  }
  if (args.childExited === null) return { kind: 'HOLD', reason: 'CHILD_STATE_UNKNOWN', exit };
  if (!args.closeObserved) return { kind: 'HOLD', reason: 'NO_CLOSE_OBSERVED', exit };
  if (args.windowOwnedAlive !== true) return { kind: 'HOLD', reason: 'WINDOW_UNVERIFIED', exit };
  if (args.saveState !== 'pending' && args.saveState !== 'error') {
    return { kind: 'HOLD', reason: 'NO_PENDING_STATE', exit };
  }
  if (!args.preCheckpointValid) return { kind: 'HOLD', reason: 'CHECKPOINT_INVALID', exit };
  return { kind: 'INTERRUPT_ELIGIBLE' };
}

export interface RecoveryReadResult {
  status: string | null;
  generation: number | null;
  snapshotJson: string | null;
  raw?: unknown;
}

export type RecoveryComparison =
  | { kind: 'MATCH'; generation: number; snapshotJson: string }
  | {
      kind: 'FAIL';
      reason: 'SNAPSHOT_MISMATCH' | 'OLDER_GENERATION' | 'EMPTY_AFTER_ACK';
      terminal: EventFact;
      observed: { status: string | null; generation: number | null; snapshotJson: string | null };
    }
  | {
      kind: 'HOLD';
      reason: 'NEWER_GENERATION' | 'READ_INVALID' | 'READ_MALFORMED' | 'READ_BLOCKED';
      terminal: EventFact;
      observed: { status: string | null; generation: number | null; snapshotJson: string | null };
      raw?: unknown;
    };

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key]))
      .join(',') +
    '}'
  );
};

const snapshotStructurallyEqual = (a: string, b: string): boolean => {
  if (a === b) return true;
  try {
    return canonicalJson(JSON.parse(a)) === canonicalJson(JSON.parse(b));
  } catch {
    return false;
  }
};

export function compareRecoveryRead(terminal: EventFact, read: RecoveryReadResult): RecoveryComparison {
  const observed = {
    status: read.status,
    generation: read.generation,
    snapshotJson: read.snapshotJson,
  };
  const raw = read.raw;
  if (read.status === 'blocked') {
    return { kind: 'HOLD', reason: 'READ_BLOCKED', terminal, observed, raw };
  }
  if (read.status === 'empty') {
    if (
      read.generation === null ||
      !Number.isSafeInteger(read.generation) ||
      read.generation < 0
    ) {
      return { kind: 'HOLD', reason: 'READ_MALFORMED', terminal, observed, raw };
    }
    if (terminal.generation !== null && read.generation > terminal.generation) {
      return { kind: 'HOLD', reason: 'NEWER_GENERATION', terminal, observed, raw };
    }
    return { kind: 'FAIL', reason: 'EMPTY_AFTER_ACK', terminal, observed };
  }
  if (read.status !== 'ready') {
    return { kind: 'HOLD', reason: 'READ_INVALID', terminal, observed, raw };
  }
  if (
    read.generation === null ||
    !Number.isSafeInteger(read.generation) ||
    read.generation < 0 ||
    terminal.generation === null
  ) {
    return { kind: 'HOLD', reason: 'READ_MALFORMED', terminal, observed, raw };
  }
  if (read.generation > terminal.generation) {
    return { kind: 'HOLD', reason: 'NEWER_GENERATION', terminal, observed, raw };
  }
  if (read.snapshotJson === null) {
    return { kind: 'HOLD', reason: 'READ_MALFORMED', terminal, observed, raw };
  }
  try {
    validateCrashRecoverySnapshot(JSON.parse(read.snapshotJson));
  } catch {
    return { kind: 'HOLD', reason: 'READ_MALFORMED', terminal, observed, raw };
  }
  if (read.generation !== terminal.generation) {
    return { kind: 'FAIL', reason: 'OLDER_GENERATION', terminal, observed };
  }
  if (terminal.snapshotJson === null || !snapshotStructurallyEqual(terminal.snapshotJson, read.snapshotJson)) {
    return { kind: 'FAIL', reason: 'SNAPSHOT_MISMATCH', terminal, observed };
  }
  return { kind: 'MATCH', generation: read.generation, snapshotJson: read.snapshotJson };
}


type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export interface OwnedChildHandle {
  readonly pid: number | undefined;
  readonly killed?: boolean;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: ExitListener): unknown;
  removeListener(event: 'exit', listener: ExitListener): unknown;
}

export type OwnedChild = OwnedChildHandle | ChildProcess;

export type InterruptHoldReason =
  | 'BAD_TIMEOUT'
  | 'NO_POSITIVE_PID'
  | 'ALREADY_EXITED'
  | 'SIGNAL_REFUSED'
  | 'WRONG_TERMINATION'
  | 'TIMEOUT';

export type InterruptResult =
  | {
      kind: 'INTERRUPTED';
      reopenPermitted: true;
      pid: number;
      exit: { code: null; signal: 'SIGKILL' };
      issuedAt: number;
      exitedAt: number;
    }
  | {
      kind: 'HOLD';
      reopenPermitted: false;
      reason: InterruptHoldReason;
      pid: number | null;
      exit: ExitFacts | null;
      issuedAt: number | null;
      exitedAt: number | null;
      detail: string;
    };

export type OwnedChildExitWait =
  | { kind: 'EXITED'; pid: number | null; exit: ExitFacts; exitedAt: number }
  | { kind: 'TIMEOUT'; pid: number | null; waitedMs: number };

const positivePid = (child: OwnedChild): number | null => {
  const pid = child.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
};

const recordedExit = (child: OwnedChild): ExitFacts | null => {
  const code = child.exitCode ?? null;
  const signal = child.signalCode ?? null;
  return code === null && signal === null ? null : { code, signal };
};

export function interruptOwnedChild(
  original: OwnedChild,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<InterruptResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({
      kind: 'HOLD',
      reopenPermitted: false,
      reason: 'BAD_TIMEOUT',
      pid: positivePid(original),
      exit: null,
      issuedAt: null,
      exitedAt: null,
      detail: 'timeoutMs must be a positive finite number',
    });
  }
  const pid = positivePid(original);
  if (pid === null) {
    return Promise.resolve({
      kind: 'HOLD',
      reopenPermitted: false,
      reason: 'NO_POSITIVE_PID',
      pid: null,
      exit: null,
      issuedAt: null,
      exitedAt: null,
      detail: 'handle has no positive pid',
    });
  }
  const prior = recordedExit(original);
  if (prior !== null || original.killed === true) {
    return Promise.resolve({
      kind: 'HOLD',
      reopenPermitted: false,
      reason: 'ALREADY_EXITED',
      pid,
      exit: prior,
      issuedAt: null,
      exitedAt: null,
      detail: 'child already signalled or exited',
    });
  }
  const wait = Math.max(0, timeoutMs);
  return new Promise<InterruptResult>((resolve) => {
    let settled = false;
    const finish = (result: InterruptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      original.removeListener('exit', onExit);
      resolve(result);
    };
    const onExit: ExitListener = (code, signal) => {
      const exitedAt = now();
      if (code === null && signal === 'SIGKILL') {
        finish({
          kind: 'INTERRUPTED',
          reopenPermitted: true,
          pid,
          exit: { code: null, signal: 'SIGKILL' },
          issuedAt,
          exitedAt,
        });
      } else {
        finish({
          kind: 'HOLD',
          reopenPermitted: false,
          reason: 'WRONG_TERMINATION',
          pid,
          exit: { code, signal },
          issuedAt,
          exitedAt,
          detail: 'expected SIGKILL with null exit code',
        });
      }
    };
    const timer = setTimeout(() => {
      finish({
        kind: 'HOLD',
        reopenPermitted: false,
        reason: 'TIMEOUT',
        pid,
        exit: null,
        issuedAt,
        exitedAt: null,
        detail: 'no exit within ' + wait + 'ms',
      });
    }, wait);
    const issuedAt = now();
    original.once('exit', onExit);
    let sent = false;
    try {
      sent = original.kill('SIGKILL');
    } catch {
      sent = false;
    }
    if (!sent) {
      finish({
        kind: 'HOLD',
        reopenPermitted: false,
        reason: 'SIGNAL_REFUSED',
        pid,
        exit: null,
        issuedAt,
        exitedAt: null,
        detail: 'kill(SIGKILL) refused by handle',
      });
    }
  });
}

export function waitForOwnedChildExit(
  original: OwnedChild,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<OwnedChildExitWait> {
  const pid = positivePid(original);
  const prior = recordedExit(original);
  if (prior !== null) {
    return Promise.resolve({ kind: 'EXITED', pid, exit: prior, exitedAt: now() });
  }
  const wait = Math.max(0, timeoutMs);
  return new Promise<OwnedChildExitWait>((resolve) => {
    let settled = false;
    const finish = (result: OwnedChildExitWait): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      original.removeListener('exit', onExit);
      resolve(result);
    };
    const onExit: ExitListener = (code, signal) => {
      finish({ kind: 'EXITED', pid, exit: { code, signal }, exitedAt: now() });
    };
    const timer = setTimeout(() => {
      finish({ kind: 'TIMEOUT', pid, waitedMs: wait });
    }, wait);
    original.once('exit', onExit);
  });
}
