import { createHash } from "node:crypto";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  safeCounter,
  type Cut,
  type Json,
} from "./contract";
import { canonical } from "./canonical";
import { digest } from "./digest";
import type { StoragePort } from "./storage-port";

const GENESIS_FORMAT = "folio.shared.genesis/2";
const META_NAMESPACE = "meta";
const HEAD_KEY = "head";
const GENESIS_KEY = "genesis";
const STATE_ROOT_KEY = "state-root";
const PREFIX_NAMESPACE = "authority.prefix";
const ASSET_NAMESPACE = "asset";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const AUTHORITATIVE_NAMESPACES: readonly string[] = [
  "asset",
  "authority.attempts",
  "authority.intents",
  "authority.undo",
  "databases",
  "copy.staging",
  "doclifecycles",
  "documents",
  "editor.states",
  "editor.versions",
  "identity.devices",
  "identity.invites",
  "identity.membership-generations",
  "identity.recovery",
  "identity.recovery-status",
  "identity.sessions",
  "identity.users",
  "operations.fences",
  "operations.upgrades",
  "operations.protocol",
  "organization",
  "page.titles",
  "pages",
  "records",
  "restoreSeeds",
  "workspace.roles",
  "workspaces",
];

const META_KEYS: ReadonlySet<string> = new Set([
  "role",
  "primary-org",
  "restore",
  "restore-authorization",
]);

type Genesis = {
  format: string;
  epoch: string;
  sourceHash: string | null;
  authorityStateHash: string;
};

type BlobEntry = { scope: string; hash: string; length: number };

function fail(code: string): never {
  throw new CollaborationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function safeLength(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    fail("CORRUPT_STATE_ROOT");
  return number;
}

function isCutShape(value: unknown): value is Cut {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(value, "epoch") ||
    !Object.hasOwn(value, "seq") ||
    !Object.hasOwn(value, "hash")
  )
    return false;
  return (
    typeof value.epoch === "string" &&
    typeof value.hash === "string" &&
    typeof value.seq === "number" &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0
  );
}

type RootCut = Pick<Cut, "epoch" | "seq"> | null;
function currentCut(store: StoragePort): RootCut {
  const value = store.get("meta", "head");
  return isRecord(value) &&
    typeof value.epoch === "string" &&
    Number.isSafeInteger(value.seq)
    ? { epoch: value.epoch, seq: Number(value.seq) }
    : null;
}
/** Only current commit pointers contain a hash cycle. Immutable bases and old
 * cuts retain their complete hash in the root. */
function normalizeRecord(
  namespace: string,
  value: unknown,
  cut: RootCut,
): Json {
  const copy = clone(value) as Json;
  const paths: Record<string, string[]> = {
    doclifecycles: ["cut"],
    "authority.attempts": ["receipt", "cut"],
    "authority.intents": ["accepted", "cut"],
    "authority.undo": ["cut"],
  };
  const path = paths[namespace];
  if (!path || !cut) return copy;
  let node: unknown = copy;
  for (const name of path) {
    if (!isRecord(node)) return copy;
    node = node[name];
  }
  if (isCutShape(node) && node.epoch === cut.epoch && node.seq === cut.seq)
    (node as { hash: string }).hash = "";
  return copy;
}

function compareKeys(
  left: { namespace: string; key: string },
  right: { namespace: string; key: string },
): number {
  if (left.namespace !== right.namespace)
    return left.namespace < right.namespace ? -1 : 1;
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
}

function recordEntries(
  store: StoragePort,
  cut: RootCut,
): { namespace: string; key: string; hash: string }[] {
  const entries: { namespace: string; key: string; hash: string }[] = [];
  const collect = (namespace: string, keys: ReadonlySet<string> | null) => {
    for (const row of store.all(namespace)) {
      if (keys !== null && !keys.has(row.key)) continue;
      canonical(row.value);
      entries.push({
        namespace,
        key: row.key,
        hash: digest(normalizeRecord(namespace, row.value, cut)),
      });
    }
  };
  for (const namespace of AUTHORITATIVE_NAMESPACES) collect(namespace, null);
  collect(META_NAMESPACE, META_KEYS);
  entries.sort(compareKeys);
  return entries;
}

function publishedRecord(value: unknown): { hash: string; bytes: number } {
  if (!isRecord(value)) fail("CORRUPT_ASSET_META");
  const hash = value.hash;
  const bytes = value.bytes;
  const uploads = value.uploads;
  if (!isHash(hash)) fail("CORRUPT_ASSET_META");
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)
    fail("CORRUPT_ASSET_META");
  if (
    !Array.isArray(uploads) ||
    !uploads.every((upload) => isIdentifier(upload))
  )
    fail("CORRUPT_ASSET_META");
  return { hash, bytes };
}

function blobLength(
  store: StoragePort,
  scope: string,
  hash: string,
): number | null {
  const row = store.db
    .prepare(
      "SELECT length(bytes) AS length FROM runtime_blobs WHERE scope=? AND hash=?",
    )
    .get(scope, hash) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return safeLength(row.length);
}

function blobEntries(store: StoragePort): BlobEntry[] {
  const entries: BlobEntry[] = [];
  for (const row of store.all(ASSET_NAMESPACE)) {
    const parts = row.key.split(":");
    const orgId = parts[0];
    const workspaceId = parts[1];
    const hash = parts[2];
    if (
      parts.length !== 3 ||
      !isIdentifier(orgId) ||
      !isIdentifier(workspaceId) ||
      !isHash(hash)
    )
      fail("CORRUPT_ASSET_META");
    const record = publishedRecord(row.value);
    if (record.hash !== hash) fail("CORRUPT_ASSET_META");
    const scope = orgId + ":" + workspaceId;
    const length = blobLength(store, scope, hash);
    if (length === null) fail("ASSET_MISSING");
    if (length !== record.bytes) fail("ASSET_TAMPERED");
    entries.push({ scope, hash, length });
  }
  entries.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope < right.scope ? -1 : 1;
    if (left.hash === right.hash) return 0;
    return left.hash < right.hash ? -1 : 1;
  });
  return entries;
}

function compute(
  store: StoragePort,
  cut: RootCut = currentCut(store),
): { root: string; blobs: BlobEntry[] } {
  const entries: Json[] = [];
  for (const entry of recordEntries(store, cut))
    entries.push(["record", entry.namespace, entry.key, entry.hash]);
  const blobs = blobEntries(store);
  for (const blob of blobs)
    entries.push(["blob", blob.scope, blob.hash, blob.length]);
  return { root: digest(entries), blobs };
}

function parseCut(value: unknown, code: string): Cut {
  if (!isRecord(value)) fail(code);
  const keys = Object.keys(value);
  const epochValue = value.epoch;
  const seqValue = value.seq;
  const hash = value.hash;
  if (
    keys.length !== 3 ||
    !Object.hasOwn(value, "epoch") ||
    !Object.hasOwn(value, "seq") ||
    !Object.hasOwn(value, "hash")
  )
    fail(code);
  let epoch: string;
  let seq: number;
  try {
    epoch = identifier(epochValue);
    seq = safeCounter(seqValue);
  } catch {
    return fail(code);
  }
  if (!isHash(hash)) fail(code);
  return { epoch, seq, hash };
}

function parseGenesis(value: unknown): Genesis {
  if (!isRecord(value)) fail("CORRUPT_GENESIS");
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !Object.hasOwn(value, "format") ||
    !Object.hasOwn(value, "epoch") ||
    !Object.hasOwn(value, "sourceHash") ||
    !Object.hasOwn(value, "authorityStateHash")
  )
    fail("CORRUPT_GENESIS");
  const epoch = value.epoch;
  const rawSourceHash = value.sourceHash;
  const authorityStateHash = value.authorityStateHash;
  if (value.format !== GENESIS_FORMAT) fail("CORRUPT_GENESIS");
  if (!isIdentifier(epoch)) fail("CORRUPT_GENESIS");
  let sourceHash: string | null;
  if (rawSourceHash === null) sourceHash = null;
  else if (isHash(rawSourceHash)) sourceHash = rawSourceHash;
  else return fail("CORRUPT_GENESIS");
  if (!isHash(authorityStateHash)) fail("CORRUPT_GENESIS");
  return {
    format: GENESIS_FORMAT,
    epoch,
    sourceHash,
    authorityStateHash,
  };
}

export function authorityStateRoot(
  store: StoragePort,
  cut: RootCut = currentCut(store),
): string {
  return compute(store, cut).root;
}

export function createRuntimeGenesis(
  store: StoragePort,
  epochInput: string,
  sourceHashInput: string | null,
): Cut {
  demand(store.db.isTransaction, "TRANSACTION_REQUIRED");
  let epoch: string;
  try {
    epoch = identifier(epochInput);
  } catch {
    return fail("INVALID_EPOCH");
  }
  if (sourceHashInput !== null && !isHash(sourceHashInput))
    fail("INVALID_SOURCE_HASH");
  const sourceHash = sourceHashInput;

  const rawHead = store.get(META_NAMESPACE, HEAD_KEY);
  if (rawHead !== null) {
    const head = parseCut(rawHead, "CORRUPT_HEAD");
    demand(head.epoch === epoch && head.seq === 0, "GENESIS_CONFLICT");
    const restore = store.get(META_NAMESPACE, "restore");
    demand(isRecord(restore) && restore.epoch === epoch, "GENESIS_CONFLICT");
  }

  const authorityStateHash = authorityStateRoot(store, { epoch, seq: 0 });
  const genesis: Genesis = {
    format: GENESIS_FORMAT,
    epoch,
    sourceHash,
    authorityStateHash,
  };
  const cut: Cut = { epoch, seq: 0, hash: digest(genesis) };
  store.set(META_NAMESPACE, GENESIS_KEY, genesis);
  store.set(META_NAMESPACE, HEAD_KEY, cut);
  store.set(PREFIX_NAMESPACE, epoch + ":0", cut);
  store.set(META_NAMESPACE, STATE_ROOT_KEY, authorityStateHash);
  return clone(cut);
}

export function assertRuntimeGenesis(store: StoragePort): Cut {
  const genesis = parseGenesis(store.get(META_NAMESPACE, GENESIS_KEY));
  const rawHead = store.get(META_NAMESPACE, HEAD_KEY);
  if (rawHead === null) fail("HEAD_MISSING");
  const head = parseCut(rawHead, "CORRUPT_HEAD");
  demand(
    head.epoch === genesis.epoch && head.seq === 0,
    "GENESIS_HEAD_MISMATCH",
  );
  demand(head.hash === digest(genesis), "GENESIS_HASH_MISMATCH");
  const rawProof = store.get(PREFIX_NAMESPACE, genesis.epoch + ":0");
  if (rawProof === null) fail("GENESIS_PREFIX_MISSING");
  const proof = parseCut(rawProof, "CORRUPT_GENESIS");
  demand(
    proof.epoch === head.epoch && proof.seq === 0 && proof.hash === head.hash,
    "GENESIS_PREFIX_MISMATCH",
  );
  return clone(head);
}

export function assertRuntimeStateRoot(
  store: StoragePort,
  expectedHash?: string,
): void {
  const { root, blobs } = compute(store);
  let expected: string;
  if (expectedHash === undefined) {
    const stored = store.get(META_NAMESPACE, STATE_ROOT_KEY);
    if (!isHash(stored)) fail("STATE_ROOT_MISSING");
    expected = stored;
  } else {
    if (!isHash(expectedHash)) fail("INVALID_STATE_ROOT");
    expected = expectedHash;
  }
  for (const blob of blobs) {
    const bytes = store.blobGet(blob.scope, blob.hash);
    if (bytes === null) fail("ASSET_MISSING");
    demand(bytes.byteLength === blob.length, "ASSET_TAMPERED");
    const actual = createHash("sha256").update(bytes).digest("hex");
    demand(actual === blob.hash, "ASSET_TAMPERED");
  }
  demand(root === expected, "STATE_ROOT_MISMATCH");
}
