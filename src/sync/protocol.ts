import { createHash } from 'node:crypto';
import { parseAssetURL } from '../shared/assets';

/** Transport limits, not a promise that arbitrary Folio workspaces fit. */
export const MAX_CHECKPOINT_BYTES = 1024 * 1024;
export const MAX_WIRE_BYTES = 2 * MAX_CHECKPOINT_BYTES + 16_384;
export const MAX_SYNC_ASSET_BYTES = 20_000_000;
export const MAX_CHANGES = 1; // Each checkpoint can consume the full payload budget.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type AssetManifest = { id: string; sha256: string; bytes: number };
export type Checkpoint = {
  format: 'folio-checkpoint/v1';
  name: string;
  version: number;
  payload: JsonObject;
  assets: AssetManifest[];
};
export type Commit = {
  protocol: 1;
  workspaceId: string;
  clientId: string;
  operationId: string;
  serverEpoch: string;
  baseRevision: number;
  checkpointHash: string;
  checkpoint: Checkpoint;
};
export type CheckpointHead = {
  revision: number;
  checkpointHash: string | null;
  checkpoint: Checkpoint | null;
};
export type HeadResponse = {
  protocol: 1;
  workspaceId: string;
  serverEpoch: string;
  head: CheckpointHead;
};
type ResultIdentity = {
  protocol: 1;
  workspaceId: string;
  clientId: string;
  operationId: string;
  serverEpoch: string;
  fingerprint: string;
};
export type CommitResult = ResultIdentity & (
  | { status: 'applied'; revision: number; checkpointHash: string }
  | { status: 'conflict'; head: CheckpointHead }
);
export type Change = {
  revision: number;
  clientId: string;
  operationId: string;
  fingerprint: string;
  checkpointHash: string;
  checkpoint: Checkpoint;
};
export type ChangePage = {
  protocol: 1;
  workspaceId: string;
  serverEpoch: string;
  after: number;
  headRevision: number;
  changes: Change[];
};

export class SyncError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
    this.name = 'SyncError';
  }
}
export function requireCondition(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new SyncError(code, status);
}

/** Sorted object keys; rejects accessors, special prototypes and non-JSON values. */
export function canonicalJson(value: unknown, limit = MAX_WIRE_BYTES): string {
  let nodes = 0;
  let bytes = 0;
  const take = (fragment: string): string => {
    bytes += Buffer.byteLength(fragment);
    requireCondition(bytes <= limit, 'payload-too-large', 413);
    return fragment;
  };
  const encode = (item: unknown, depth: number): string => {
    requireCondition(++nodes <= 100_000 && depth <= 48, 'json-complexity');
    if (item === null || typeof item === 'boolean') return take(String(item));
    if (typeof item === 'string') {
      requireCondition(Buffer.byteLength(item) <= limit, 'payload-too-large', 413);
      return take(JSON.stringify(item));
    }
    if (typeof item === 'number') {
      requireCondition(Number.isFinite(item), 'invalid-number');
      return take(JSON.stringify(item));
    }
    requireCondition(typeof item === 'object' && item !== null, 'invalid-json');
    requireCondition(Object.getOwnPropertySymbols(item).length === 0, 'invalid-json');
    if (Array.isArray(item)) {
      requireCondition(Object.getPrototypeOf(item) === Array.prototype && Object.getOwnPropertyNames(item).length === item.length + 1, 'invalid-array');
      requireCondition(item.length <= 100_000, 'json-complexity');
      const parts: string[] = [take('[')];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        requireCondition(descriptor && 'value' in descriptor && descriptor.enumerable, 'invalid-array');
        if (index > 0) parts.push(take(','));
        parts.push(encode(descriptor.value, depth + 1));
      }
      parts.push(take(']'));
      return parts.join('');
    }
    requireCondition(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'invalid-object');
    const keys = Object.keys(item).sort();
    requireCondition(keys.length === Object.getOwnPropertyNames(item).length, 'invalid-object');
    const parts: string[] = [take('{')];
    keys.forEach((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      requireCondition('value' in descriptor, 'invalid-accessor');
      requireCondition(Buffer.byteLength(key) <= limit, 'payload-too-large', 413);
      if (index > 0) parts.push(take(','));
      parts.push(take(JSON.stringify(key)), take(':'), encode(descriptor.value, depth + 1));
    });
    parts.push(take('}'));
    return parts.join('');
  };
  return encode(value, 0);
}
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const hashCheckpoint = (value: Checkpoint): string => sha256(canonicalJson(value, MAX_CHECKPOINT_BYTES));
export const fingerprintCommit = (value: Commit): string => sha256(canonicalJson(value));

function object(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected-object');
  return value as Record<string, unknown>;
}
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  const result = object(value);
  requireCondition(Object.keys(result).length === keys.length && keys.every(key => Object.hasOwn(result, key)), 'unexpected-fields');
  return result;
}
export function identifier(value: unknown): string {
  requireCondition(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), 'invalid-identifier');
  return value;
}
function counter(value: unknown, minimum = 0): number {
  requireCondition(Number.isSafeInteger(value) && Number(value) >= minimum, 'invalid-revision');
  return value as number;
}
function hash(value: unknown): string {
  requireCondition(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'invalid-hash');
  return value;
}
function header(value: Record<string, unknown>): void {
  requireCondition(value.protocol === 1, 'unsupported-protocol');
  identifier(value.workspaceId);
  identifier(value.serverEpoch);
}
export function parseCheckpoint(value: unknown): Checkpoint {
  const v = shape(value, ['format', 'name', 'version', 'payload', 'assets']);
  requireCondition(v.format === 'folio-checkpoint/v1', 'unsupported-checkpoint');
  identifier(v.name);
  counter(v.version, 1);
  object(v.payload);
  // Detach before inspecting arrays so the same bounded bytes are validated and hashed.
  const checkpoint = JSON.parse(canonicalJson(v, MAX_CHECKPOINT_BYTES)) as Checkpoint;
  requireCondition(Array.isArray(checkpoint.assets), 'invalid-asset-manifest', 422);
  const ids = new Set<string>();
  for (const asset of checkpoint.assets) {
    requireCondition(asset !== null && typeof asset === 'object' &&
      Object.keys(asset).length === 3 &&
      typeof asset.id === 'string' && parseAssetURL('folio-asset://' + asset.id) === asset.id &&
      typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256) &&
      Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && asset.bytes <= MAX_SYNC_ASSET_BYTES,
    'invalid-asset-manifest', 422);
    const fileId = asset.id.toLowerCase();
    requireCondition(!ids.has(fileId), 'duplicate-asset-id', 422);
    ids.add(fileId);
  }
  return checkpoint;
}
export function parseCommit(value: unknown): Commit {
  const v = shape(value, ['protocol', 'workspaceId', 'clientId', 'operationId', 'serverEpoch', 'baseRevision', 'checkpointHash', 'checkpoint']);
  header(v);
  identifier(v.clientId);
  identifier(v.operationId);
  counter(v.baseRevision);
  hash(v.checkpointHash);
  const checkpoint = parseCheckpoint(v.checkpoint);
  requireCondition(hashCheckpoint(checkpoint) === v.checkpointHash, 'checkpoint-hash-mismatch');
  return { ...v, checkpoint } as Commit;
}
function parseHead(value: unknown): CheckpointHead {
  const v = shape(value, ['revision', 'checkpointHash', 'checkpoint']);
  const revision = counter(v.revision);
  if (revision === 0) {
    requireCondition(v.checkpointHash === null && v.checkpoint === null, 'invalid-empty-head');
    return { revision, checkpointHash: null, checkpoint: null };
  }
  const checkpoint = parseCheckpoint(v.checkpoint);
  requireCondition(hash(v.checkpointHash) === hashCheckpoint(checkpoint), 'checkpoint-hash-mismatch');
  return { revision, checkpointHash: v.checkpointHash, checkpoint } as CheckpointHead;
}
export function parseHeadResponse(value: unknown): HeadResponse {
  const v = shape(value, ['protocol', 'workspaceId', 'serverEpoch', 'head']);
  header(v);
  return { ...v, head: parseHead(v.head) } as HeadResponse;
}
export function parseResult(value: unknown): CommitResult {
  const identity = ['protocol', 'workspaceId', 'clientId', 'operationId', 'serverEpoch', 'fingerprint', 'status'];
  const input = object(value);
  requireCondition(input.status === 'applied' || input.status === 'conflict', 'invalid-result');
  const v = shape(input, [...identity, ...(input.status === 'applied' ? ['revision', 'checkpointHash'] : ['head'])]);
  header(v);
  identifier(v.clientId);
  identifier(v.operationId);
  hash(v.fingerprint);
  if (v.status === 'conflict') return { ...v, head: parseHead(v.head) } as CommitResult;
  counter(v.revision, 1);
  hash(v.checkpointHash);
  return v as CommitResult;
}
export function parseChangePage(value: unknown): ChangePage {
  const v = shape(value, ['protocol', 'workspaceId', 'serverEpoch', 'after', 'headRevision', 'changes']);
  header(v);
  const after = counter(v.after);
  const headRevision = counter(v.headRevision);
  requireCondition(after <= headRevision, 'cursor-ahead');
  requireCondition(Array.isArray(v.changes) && v.changes.length <= MAX_CHANGES, 'invalid-changes');
  const changes = v.changes.map((entry, index) => {
    const change = shape(entry, ['revision', 'clientId', 'operationId', 'fingerprint', 'checkpointHash', 'checkpoint']);
    requireCondition(counter(change.revision, 1) === after + index + 1 && Number(change.revision) <= headRevision, 'cursor-gap');
    identifier(change.clientId);
    identifier(change.operationId);
    hash(change.fingerprint);
    const checkpoint = parseCheckpoint(change.checkpoint);
    requireCondition(hash(change.checkpointHash) === hashCheckpoint(checkpoint), 'checkpoint-hash-mismatch');
    return { ...change, checkpoint } as Change;
  });
  requireCondition(changes.length > 0 || after === headRevision, 'cursor-gap');
  return { ...v, changes } as ChangePage;
}
