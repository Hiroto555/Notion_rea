import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  auditOldOperationCalls,
  hasCompleteRecorderInterval,
  installRequestRecorder,
  manualCommandGate,
  readRequestCalls,
  readSessionAttempt,
} from './e2e/mac-trial-packaged-session';
import type {
  RecorderCoverage,
  RequestCallRecord,
  RequestCallsRead,
} from './e2e/mac-trial-packaged-session';

type Handler = (event: unknown, request: any) => any;

class FakeMain {
  readonly handlers = new Map<string, Handler>();
  windows: unknown[] = [];
  readonly ipcMain = { _invokeHandlers: this.handlers };
  readonly BrowserWindow = { getAllWindows: () => this.windows };
}

const fakeApp = (main: FakeMain) =>
  ({
    evaluate: async (fn: (ctx: unknown) => unknown) => fn(main),
  }) as unknown as Parameters<typeof installRequestRecorder>[0];

const call = (over: Partial<RequestCallRecord>): RequestCallRecord => ({
  channel: 'folio:request',
  type: null,
  operationId: null,
  arrivedAt: 't',
  outcome: 'fulfilled',
  status: null,
  settledAt: 't',
  request: null,
  ...over,
});

const readOf = (calls: RequestCallRecord[], available = true): RequestCallsRead => ({
  available,
  installedAt: 't0',
  readAt: 't1',
  calls,
});

beforeEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__folioRequestCalls;
  delete g.__folioRequestRecorderInstalledAt;
});

describe('installRequestRecorder', () => {
  it('stamps arrival before the original handler and marks it fulfilled', async () => {
    const main = new FakeMain();
    main.handlers.set('folio:request', async () => ({ status: 'applied' }));
    const coverage = await installRequestRecorder(fakeApp(main));
    expect(coverage.channelsWrapped).toContain('folio:request');
    const handler = main.handlers.get('folio:request')!;
    const result = await handler(
      {},
      { type: 'save:resolve', operation: { operationId: 'op-old' } },
    );
    expect(result).toEqual({ status: 'applied' });
    const read = await readRequestCalls(fakeApp(main));
    expect(read.available).toBe(true);
    expect(read.calls).toHaveLength(1);
    expect(read.calls[0]).toMatchObject({
      operationId: 'op-old',
      type: 'save:resolve',
      outcome: 'fulfilled',
      status: 'applied',
    });
  });

  it('keeps a pending entry while a deferred handler has not settled', async () => {
    const main = new FakeMain();
    let release: (value: unknown) => void = () => {};
    main.handlers.set(
      'folio:request',
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await installRequestRecorder(fakeApp(main));
    const handler = main.handlers.get('folio:request')!;
    const pending = handler(
      {},
      { type: 'save:commit', operation: { operationId: 'op-old' } },
    );
    const mid = await readRequestCalls(fakeApp(main));
    expect(mid.calls[0]).toMatchObject({ outcome: 'pending', type: 'save:commit' });
    release({ status: 'held' });
    await pending;
    const after = await readRequestCalls(fakeApp(main));
    expect(after.calls[0]).toMatchObject({ outcome: 'fulfilled', status: 'held' });
  });

  it('marks the entry rejected and rethrows the original error', async () => {
    const main = new FakeMain();
    main.handlers.set('folio:request', async () => {
      throw new Error('boom');
    });
    await installRequestRecorder(fakeApp(main));
    const handler = main.handlers.get('folio:request')!;
    await expect(
      handler({}, { type: 'save:commit', operation: { operationId: 'op-old' } }),
    ).rejects.toThrow('boom');
    const read = await readRequestCalls(fakeApp(main));
    expect(read.calls[0]).toMatchObject({ outcome: 'rejected', type: 'save:commit' });
  });

  it('invokes the original handler exactly once with its args', async () => {
    const main = new FakeMain();
    let count = 0;
    let seen: unknown;
    main.handlers.set('folio:request', async (_e: unknown, request: unknown) => {
      count += 1;
      seen = request;
      return { status: 'applied' };
    });
    await installRequestRecorder(fakeApp(main));
    const request = { type: 'save:resolve', operation: { operationId: 'op-9' }, extra: 1 };
    await main.handlers.get('folio:request')!({}, request);
    expect(count).toBe(1);
    expect(seen).toBe(request);
  });

  it('does not record untracked request types', async () => {
    const main = new FakeMain();
    main.handlers.set('folio:request', async () => ({ status: 'ok' }));
    await installRequestRecorder(fakeApp(main));
    await main.handlers.get('folio:request')!({}, { type: 'recovery:read' });
    const read = await readRequestCalls(fakeApp(main));
    expect(read.calls).toHaveLength(0);
  });

  it('reports missing channels instead of skipping them silently', async () => {
    const main = new FakeMain();
    const coverage = await installRequestRecorder(fakeApp(main));
    expect(coverage.channelsMissing).toEqual([
      'folio:request:diagnostic-v1',
      'folio:request',
    ]);
    expect(coverage.channelsWrapped).toEqual([]);
  });

  it('marks coverage late when a renderer already exists at install', async () => {
    const main = new FakeMain();
    main.handlers.set('folio:request', async () => ({ status: 'ok' }));
    main.windows.push({});
    const coverage = await installRequestRecorder(fakeApp(main));
    expect(coverage.rendererAlreadyPresent).toBe(true);
  });

  it('uninstalled reads report unavailable rather than empty', async () => {
    const main = new FakeMain();
    const read = await readRequestCalls(fakeApp(main));
    expect(read.available).toBe(false);
    expect(read.calls).toEqual([]);
  });
});

describe('auditOldOperationCalls', () => {
  it('passes on exactly one fulfilled applied old resolve and no old commit', () => {
    const audit = auditOldOperationCalls(
      readOf([
        call({ type: 'save:resolve', operationId: 'op-old', status: 'applied' }),
        call({ type: 'save:commit', operationId: 'op-other' }),
      ]),
      'op-old',
    );
    expect(audit.kind).toBe('OK');
  });

  it('fails on a conclusively arrived old recommit even while pending', () => {
    const audit = auditOldOperationCalls(
      readOf([call({ type: 'save:commit', operationId: 'op-old', outcome: 'pending' })]),
      'op-old',
    );
    expect(audit).toMatchObject({ kind: 'FAIL', reason: 'OLD_RECOMMIT_ARRIVED' });
  });

  it('holds on a pending old resolve', () => {
    const audit = auditOldOperationCalls(
      readOf([call({ type: 'save:resolve', operationId: 'op-old', outcome: 'pending' })]),
      'op-old',
    );
    expect(audit).toMatchObject({ kind: 'HOLD', reason: 'OLD_RESOLVE_PENDING' });
  });

  it('holds when no old resolve arrived', () => {
    const audit = auditOldOperationCalls(readOf([]), 'op-old');
    expect(audit).toMatchObject({ kind: 'HOLD', reason: 'OLD_RESOLVE_MISSING' });
  });

  it('holds on ambiguous duplicate applied resolves', () => {
    const audit = auditOldOperationCalls(
      readOf([
        call({ type: 'save:resolve', operationId: 'op-old', status: 'applied' }),
        call({ type: 'save:resolve', operationId: 'op-old', status: 'applied' }),
      ]),
      'op-old',
    );
    expect(audit).toMatchObject({ kind: 'HOLD', reason: 'OLD_RESOLVE_AMBIGUOUS' });
  });

  it('holds when the recorder boundary is unavailable', () => {
    const audit = auditOldOperationCalls(readOf([], false), 'op-old');
    expect(audit).toMatchObject({ kind: 'HOLD', reason: 'RECORDER_UNAVAILABLE' });
  });

  it('does not count a fulfilled non-applied resolve as applied', () => {
    const audit = auditOldOperationCalls(
      readOf([call({ type: 'save:resolve', operationId: 'op-old', status: 'skipped' })]),
      'op-old',
    );
    expect(audit).toMatchObject({ kind: 'HOLD', reason: 'OLD_RESOLVE_MISSING' });
  });
  it('holds when one applied resolve arrives alongside a rejected old resolve', () => {
    const audit = auditOldOperationCalls(
      readOf([
        call({ type: 'save:resolve', operationId: 'op-old', status: 'applied' }),
        call({ type: 'save:resolve', operationId: 'op-old', outcome: 'rejected' }),
      ]),
      'op-old',
    );
    expect(audit).toMatchObject({ kind: 'HOLD', reason: 'OLD_RESOLVE_AMBIGUOUS' });
  });

  it('a conclusively arrived old commit overrides a pending-resolve hold', () => {
    const audit = auditOldOperationCalls(
      readOf([
        call({ type: 'save:commit', operationId: 'op-old', outcome: 'pending' }),
        call({ type: 'save:resolve', operationId: 'op-old', outcome: 'pending' }),
      ]),
      'op-old',
    );
    expect(audit).toMatchObject({ kind: 'FAIL', reason: 'OLD_RECOMMIT_ARRIVED' });
  });
});

describe('readSessionAttempt', () => {
  const STARTED_AT = '2026-11-18T01:02:03.000Z';
  const seedSession = (
    root: string,
    name: string,
    over: { attempt?: Record<string, unknown>; intent?: Record<string, unknown> } = {},
  ): string => {
    const realRoot = realpathSync(root);
    const dir = join(realRoot, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'attempt.json'),
      JSON.stringify({
        runId: 'r1',
        sessionId: 'abc',
        nonce: 'monitor-nonce-1',
        startedAt: STARTED_AT,
        ...over.attempt,
      }),
    );
    writeFileSync(
      join(dir, 'intent.json'),
      JSON.stringify({
        runId: 'r1',
        nonce: 'monitor-nonce-1',
        sessionId: 'abc',
        runRoot: realRoot,
        tempRoot: dir,
        ...over.intent,
      }),
    );
    return dir;
  };

  it('binds a unique session across matching attempt and intent records', () => {
    const root = mkdtempSync(join(tmpdir(), 'runroot-'));
    try {
      const dir = seedSession(root, 'session-abc');
      const bound = readSessionAttempt(root, { expectedRunId: 'r1' });
      expect(bound).toMatchObject({
        status: 'ok',
        dir,
        sessionId: 'abc',
        runId: 'r1',
        nonce: 'monitor-nonce-1',
        intentNonce: 'monitor-nonce-1',
        intentSessionId: 'abc',
        startedAt: STARTED_AT,
        intentRunRoot: realpathSync(root),
        intentTempRoot: dir,
      });
      expect(bound.intentNonce).toBe(bound.nonce);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when intent.nonce is tampered with', () => {
    const root = mkdtempSync(join(tmpdir(), 'runroot-'));
    try {
      seedSession(root, 'session-abc', { intent: { nonce: 'forged-nonce' } });
      expect(readSessionAttempt(root, { expectedRunId: 'r1' }).status).toBe('invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects incomplete, mismatched or foreign-run identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'runroot-'));
    try {
      expect(readSessionAttempt(root, { expectedRunId: 'r1' }).status).toBe('missing');
      const dir = seedSession(root, 'session-abc');
      expect(readSessionAttempt(root, { expectedRunId: 'other' }).status).toBe('invalid');
      writeFileSync(
        join(dir, 'attempt.json'),
        JSON.stringify({
          runId: 'r1',
          sessionId: 'abc',
          nonce: 'monitor-nonce-1',
          startedAt: 'not-a-date',
        }),
      );
      expect(readSessionAttempt(root, { expectedRunId: 'r1' }).status).toBe('invalid');
      writeFileSync(
        join(dir, 'intent.json'),
        JSON.stringify({ runId: 'r1', runRoot: realpathSync(root), tempRoot: realpathSync(root) }),
      );
      expect(readSessionAttempt(root, { expectedRunId: 'r1' }).status).toBe('invalid');
      writeFileSync(
        join(dir, 'attempt.json'),
        JSON.stringify({
          runId: 'r1',
          sessionId: 'abc',
          nonce: 'monitor-nonce-1',
          startedAt: STARTED_AT,
        }),
      );
      expect(readSessionAttempt(root, { expectedRunId: 'r1' }).status).toBe('invalid');
      rmSync(join(dir, 'intent.json'));
      expect(readSessionAttempt(root, { expectedRunId: 'r1' }).status).toBe('invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ambiguous, excluded and nonexistent roots never upgrade silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'runroot-'));
    try {
      mkdirSync(join(root, 'session-a'));
      seedSession(root, 'session-b');
      expect(readSessionAttempt(root, { expectedRunId: 'r1' }).status).toBe('ambiguous');
      expect(
        readSessionAttempt(root, { expectedRunId: 'r1', excludeDir: 'session-a' }).status,
      ).toBe('ok');
      expect(
        readSessionAttempt(join(root, 'no-such'), { expectedRunId: 'r1' }).status,
      ).toBe('invalid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hasCompleteRecorderInterval', () => {
  const coverageOf = (over: Partial<RecorderCoverage>): RecorderCoverage => ({
    installedAt: '2026-11-18T01:00:00.000Z',
    channelsWrapped: ['folio:request', 'folio:request:diagnostic-v1'],
    channelsMissing: [],
    rendererAlreadyPresent: true,
    ...over,
  });
  const intervalRead = (over: Partial<RequestCallsRead>): RequestCallsRead => ({
    available: true,
    installedAt: '2026-11-18T01:00:00.000Z',
    readAt: '2026-11-18T01:00:05.000Z',
    calls: [],
    ...over,
  });

  it('accepts a complete measured interval regardless of rendererAlreadyPresent', () => {
    expect(hasCompleteRecorderInterval(coverageOf({}), intervalRead({}))).toBe(
      true,
    );
    expect(
      hasCompleteRecorderInterval(
        coverageOf({rendererAlreadyPresent: null}),
        intervalRead({}),
      ),
    ).toBe(true);
    expect(
      hasCompleteRecorderInterval(
        coverageOf({rendererAlreadyPresent: false}),
        intervalRead({}),
      ),
    ).toBe(true);
  });

  it('rejects missing coverage or read for an otherwise complete interval', () => {
    expect(hasCompleteRecorderInterval(undefined, intervalRead({}))).toBe(false);
    expect(hasCompleteRecorderInterval(coverageOf({}), null)).toBe(false);
  });

  it('rejects channel gaps, install-time mismatch, reversed reads and unavailable reads', () => {
    expect(
      hasCompleteRecorderInterval(
        coverageOf({
          channelsWrapped: ['folio:request'],
          channelsMissing: ['folio:request:diagnostic-v1'],
        }),
        intervalRead({}),
      ),
    ).toBe(false);
    expect(
      hasCompleteRecorderInterval(
        coverageOf({}),
        intervalRead({installedAt: '2026-11-18T01:00:01.000Z'}),
      ),
    ).toBe(false);
    expect(
      hasCompleteRecorderInterval(
        coverageOf({}),
        intervalRead({readAt: '2026-11-18T00:59:59.000Z'}),
      ),
    ).toBe(false);
    expect(
      hasCompleteRecorderInterval(
        coverageOf({}),
        intervalRead({available: false}),
      ),
    ).toBe(false);
  });
});

describe('manualCommandGate', () => {
  const stepAt = '2026-11-18T01:00:00.000Z';
  const now = Date.parse('2026-11-18T01:02:00.000Z');

  it('accepts a real ISO command issued at-or-after the step and unexpired', () => {
    expect(
      manualCommandGate(
        { at: '2026-11-18T01:01:59.000Z', expiresAt: '2026-11-18T01:05:00.000Z' },
        stepAt,
        now,
      ),
    ).toMatchObject({ kind: 'OK' });
    expect(
      manualCommandGate(
        { at: stepAt, expiresAt: '2026-11-18T01:05:00.000Z' },
        stepAt,
        now,
      ).kind,
    ).toBe('OK');
  });

  it('rejects stale, future-issued, expired and unparsable ISO stamps', () => {
    const cases: ReadonlyArray<Readonly<{ at: string; expiresAt: string }>> = [
      { at: '2026-11-18T00:59:59.000Z', expiresAt: '2026-11-18T01:05:00.000Z' },
      { at: '2026-11-18T01:03:00.000Z', expiresAt: '2026-11-18T01:05:00.000Z' },
      { at: '2026-11-18T01:01:00.000Z', expiresAt: '2026-11-18T01:01:30.000Z' },
      { at: 'not-a-date', expiresAt: '2026-11-18T01:05:00.000Z' },
      { at: '2026-11-18T01:01:00.000Z', expiresAt: 'NaN' },
    ];
    for (const command of cases) {
      expect(manualCommandGate(command, stepAt, now).kind).toBe('HOLD');
    }
  });
});
