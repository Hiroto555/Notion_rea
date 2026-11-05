import { randomUUID } from 'node:crypto';
import {
  canonicalJson, fingerprintCommit, hashCheckpoint, identifier, MAX_WIRE_BYTES,
  parseChangePage, parseCheckpoint, parseHeadResponse, parseResult,
  requireCondition, SyncError, type ChangePage, type Checkpoint, type Commit,
  type CommitResult, type HeadResponse,
} from './protocol';
import { SyncTransportJournal } from './transport-journal';

export type CheckpointRemoteOptions = {
  baseUrl: string;
  workspaceId: string;
  token: string;
  timeoutMs?: number;
};

/**
 * Stateless transport client. It validates the loopback route, response
 * headers/size and every returned identity; it never applies checkpoints.
 */
export class CheckpointRemote {
  private readonly baseUrl: string;
  private readonly workspaceId: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: CheckpointRemoteOptions) {
    const url = new URL(options.baseUrl);
    requireCondition(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.username === '' && url.password === '' && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash, 'loopback-only');
    this.workspaceId = identifier(options.workspaceId);
    requireCondition(typeof options.token === 'string' && /^[A-Za-z0-9_-]{32,512}$/.test(options.token), 'invalid-capability');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    requireCondition(Number.isSafeInteger(this.timeoutMs) && this.timeoutMs > 0 && this.timeoutMs <= 60_000, 'invalid-timeout');
    this.baseUrl = url.origin;
    this.token = options.token;
  }

  private route(route: string): string {
    return `${this.baseUrl}/v1/workspaces/${this.workspaceId}/${route}`;
  }

  private async request(route: string, operation?: Commit, missingIsNull = false): Promise<unknown> {
    const response = await fetch(this.route(route), {
      method: operation ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json', ...(operation ? { 'Content-Type': 'application/json' } : {}) },
      body: operation ? canonicalJson(operation) : undefined,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (missingIsNull && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    requireCondition(contentType === 'application/json', 'invalid-response');
    const declared = response.headers.get('content-length');
    if (declared !== null) {
      requireCondition(/^(0|[1-9][0-9]*)$/.test(declared), 'invalid-response');
      const length = Number(declared);
      requireCondition(Number.isSafeInteger(length), 'invalid-response');
      requireCondition(length <= MAX_WIRE_BYTES, 'response-too-large', 413);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_WIRE_BYTES) {
            await reader.cancel();
            throw new SyncError('response-too-large', 413);
          }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SyncError('invalid-response'); }
    if (!response.ok) {
      const code = (value as { error?: unknown } | null)?.error;
      throw new SyncError(typeof code === 'string' && /^[a-z0-9-]{1,100}$/.test(code) ? code : 'http-error', response.status);
    }
    return value;
  }

  async head(): Promise<HeadResponse> {
    const response = parseHeadResponse(await this.request('head'));
    requireCondition(response.workspaceId === this.workspaceId, 'workspace-mismatch');
    return response;
  }

  async commit(operation: Commit): Promise<CommitResult> {
    requireCondition(operation.protocol === 1, 'unsupported-protocol');
    requireCondition(operation.workspaceId === this.workspaceId, 'workspace-mismatch');
    identifier(operation.clientId);
    identifier(operation.operationId);
    identifier(operation.serverEpoch);
    requireCondition(Number.isSafeInteger(operation.baseRevision) && operation.baseRevision >= 0, 'invalid-revision');
    requireCondition(typeof operation.checkpointHash === 'string' && /^[a-f0-9]{64}$/.test(operation.checkpointHash), 'invalid-hash');
    requireCondition(hashCheckpoint(operation.checkpoint) === operation.checkpointHash, 'checkpoint-hash-mismatch');
    const fingerprint = fingerprintCommit(operation);
    const result = parseResult(await this.request('commits', operation));
    requireCondition(result.workspaceId === this.workspaceId, 'workspace-mismatch');
    requireCondition(result.clientId === operation.clientId && result.operationId === operation.operationId, 'result-identity-mismatch');
    requireCondition(result.serverEpoch === operation.serverEpoch, 'server-epoch-mismatch');
    requireCondition(result.fingerprint === fingerprint, 'result-identity-mismatch');
    if (result.status === 'applied') {
      requireCondition(result.revision === operation.baseRevision + 1 && result.checkpointHash === operation.checkpointHash, 'result-identity-mismatch');
    } else {
      requireCondition(result.head.revision !== operation.baseRevision, 'result-identity-mismatch');
    }
    return result;
  }

  /** A 404 is an absent receipt result, never a new operation. */
  async lookup(clientId: string, operationId: string): Promise<CommitResult | null> {
    identifier(clientId);
    identifier(operationId);
    const value = await this.request(`operations/${clientId}/${operationId}`, undefined, true);
    if (value === null) return null;
    const result = parseResult(value);
    requireCondition(result.workspaceId === this.workspaceId, 'workspace-mismatch');
    requireCondition(result.clientId === clientId && result.operationId === operationId, 'result-identity-mismatch');
    return result;
  }

  async changes(after: number): Promise<ChangePage> {
    requireCondition(Number.isSafeInteger(after) && after >= 0, 'invalid-cursor');
    const page = parseChangePage(await this.request(`changes?after=${after}`));
    requireCondition(page.workspaceId === this.workspaceId, 'workspace-mismatch');
    requireCondition(page.after === after, 'cursor-mismatch');
    return page;
  }
}

export type CheckpointClientOptions = {
  baseUrl: string;
  token: string;
  journal: SyncTransportJournal;
  timeoutMs?: number;
};

/** Explicit one-step operations; no background task and no Store application path. */
export class CheckpointClient {
  private readonly remote: CheckpointRemote;
  readonly journal: SyncTransportJournal;

  constructor(options: CheckpointClientOptions) {
    this.journal = options.journal;
    this.remote = new CheckpointRemote({
      baseUrl: options.baseUrl,
      workspaceId: options.journal.workspaceId,
      token: options.token,
      timeoutMs: options.timeoutMs,
    });
  }

  async head(): Promise<HeadResponse> {
    const response = await this.remote.head();
    requireCondition(response.workspaceId === this.journal.workspaceId, 'workspace-mismatch');
    this.journal.bindServer(response.serverEpoch);
    return response;
  }

  /** Caller chooses the observed base revision. This never rebases a stale candidate. */
  prepare(checkpoint: Checkpoint, baseRevision: number, operationId = randomUUID()): Commit {
    const serverEpoch = this.journal.status().serverEpoch;
    requireCondition(serverEpoch !== null, 'server-not-bound');
    const detached = parseCheckpoint(checkpoint);
    const operation: Commit = {
      protocol: 1, workspaceId: this.journal.workspaceId, clientId: this.journal.clientId,
      operationId, serverEpoch, baseRevision, checkpointHash: hashCheckpoint(detached), checkpoint: detached,
    };
    this.journal.enqueue(operation);
    return operation;
  }

  async push(): Promise<CommitResult | null> {
    const pending = this.journal.pending()[0];
    if (!pending) return null;
    const result = await this.remote.commit(pending);
    this.journal.recordResult(result);
    return result;
  }

  /** A missing receipt does not discard or regenerate the pending envelope. */
  async recoverPending(): Promise<CommitResult | null> {
    const pending = this.journal.pending()[0];
    if (!pending) return null;
    const result = await this.remote.lookup(pending.clientId, pending.operationId);
    if (result === null) return null;
    this.journal.recordResult(result);
    return result;
  }

  async pull(): Promise<ChangePage> {
    if (this.journal.status().serverEpoch === null) await this.head();
    const cursor = this.journal.status().receivedCursor;
    const page = await this.remote.changes(cursor);
    requireCondition(page.after === cursor, 'cursor-mismatch');
    this.journal.stageChanges(page);
    return page;
  }
}
