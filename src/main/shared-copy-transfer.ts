import { createHash } from "node:crypto";
import { canonical } from "../collaboration/runtime/canonical";
import { demand } from "../collaboration/runtime/contract";
import type { CopyPreview, SharedCopySource } from "../collaboration/runtime/copy";
import type { SharedCopyManifest } from "../collaboration/runtime/copy-staging";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Split by Unicode scalars, with headroom for JSON escaping in the 1MB wire. */
function chunks(raw: string): string[] {
  const parts: string[] = []; let part: string[] = [], size = 0;
  for (const scalar of raw) {
    const length = Buffer.byteLength(scalar);
    if (size + length > 384_000) { parts.push(part.join("")); part = []; size = 0; }
    part.push(scalar); size += length;
  }
  if (part.length) parts.push(part.join(""));
  return parts;
}
export function sharedCopyTransfer(sources: SharedCopySource[], preview: CopyPreview, copyId: string) {
  const parts: string[] = [];
  const manifests = preview.sourceIds.map(id => {
    const source = sources.find(s => s.id === id); demand(source, "COPY_SOURCE_MISSING");
    const assets = preview.assets.filter(a => a.sourceId === id);
    const raw = canonical({id, parentId: source.parentId, title: source.title ?? "共有ページ", raw: source.raw,
      assets: assets.map(a => ({hash: a.hash})), ...((source as SharedCopySource & {metadata?: unknown}).metadata === undefined ? {} : {metadata: (source as SharedCopySource & {metadata?: unknown}).metadata})}, 32 * 1024 * 1024);
    const split = chunks(raw); parts.push(...split);
    return {id, parts: split.length, assets: assets.map(a => ({hash: a.hash, size: a.bytes.length}))};
  });
  const manifest: SharedCopyManifest = {copyId, selectedIds: preview.sourceIds, allocatedIds: preview.scopes.map(s => s.documentId),
    fingerprint: preview.fingerprint, sources: manifests, parts: parts.map(raw => ({hash: hash(raw), size: Buffer.byteLength(raw)}))};
  demand(parts.length <= 100, "COPY_PART_LIMIT");
  return {manifest, manifestHash: hash(canonical(manifest)), parts};
}
