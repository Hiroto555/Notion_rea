import { documentSchema } from '../../src/shared/editor-schema';
import { versionDocument } from '../../src/shared/rich-document';
import type { Doc } from '../../src/shared/types';

export interface PmNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  [key: string]: unknown;
}

export interface SeedPage {
  id: string;
  title?: string;
  parentId?: string | null;
  doc: PmNode;
  [key: string]: unknown;
}

export interface SnapshotPage {
  id: string;
  doc: PmNode;
  [key: string]: unknown;
}

export interface TrialManifest {
  activePage?: string;
  database?: { id?: string; doc?: PmNode; [key: string]: unknown };
  records?: { id: string; doc?: PmNode; [key: string]: unknown }[];
  pages: SeedPage[];
  [key: string]: unknown;
}

export const EDITOR_CASES = [
  'enter',
  'softbreak',
  'undo',
  'blank-guide',
  'blank-check1',
  'blank-check2',
  'blank-notes',
  'blank-emptylog',
  'handle',
] as const;

export type EditorCase = (typeof EDITOR_CASES)[number];
export type BlankCase = Extract<EditorCase, `blank-${string}`>;

export const TEXT_UPPER = '上段';
export const TEXT_LOWER = '下段';
export const UNDO_WORD = '日本語';

export const GUIDE_BLOCKS = {
  heading: 'mac-trial-guide-heading',
  intro: 'mac-trial-guide-intro',
  links: 'mac-trial-guide-links',
  blank: 'mac-trial-guide-blank',
} as const;

export const KNOWN_EMPTY_BLOCK_IDS = [
  GUIDE_BLOCKS.blank,
  'mac-trial-checklist-blank-1',
  'mac-trial-checklist-blank-2',
  'mac-trial-notes-blank',
  'mac-trial-emptylog-blank',
] as const;

export const BLANK_CASE_TARGETS: Record<BlankCase, { blockId: string; marker: string }> = {
  'blank-guide': { blockId: GUIDE_BLOCKS.blank, marker: '案内記入' },
  'blank-check1': { blockId: 'mac-trial-checklist-blank-1', marker: '確認一記入' },
  'blank-check2': { blockId: 'mac-trial-checklist-blank-2', marker: '確認二記入' },
  'blank-notes': { blockId: 'mac-trial-notes-blank', marker: '備考記入' },
  'blank-emptylog': { blockId: 'mac-trial-emptylog-blank', marker: '空録記入' },
};

const RUN_ID_RE =
  /^editor-(enter|softbreak|undo|blank-guide|blank-check1|blank-check2|blank-notes|blank-emptylog|handle)-(\d{8}T\d{6}Z)-([0-9a-f]{6})$/;

export interface ParsedRunId {
  caseId: EditorCase;
  stamp: string;
  hex: string;
}

export function parseEditorRunId(runId: unknown): ParsedRunId | null {
  if (typeof runId !== 'string') return null;
  const m = RUN_ID_RE.exec(runId);
  return m ? { caseId: m[1] as EditorCase, stamp: m[2], hex: m[3] } : null;
}

export function isBlankCase(caseId: EditorCase): caseId is BlankCase {
  return caseId.startsWith('blank-');
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  return keys.length === Object.keys(rb).length && keys.every((k) => deepEqual(ra[k], rb[k]));
}

export interface Verdict {
  ok: boolean;
  reason?: string;
  [key: string]: unknown;
}

const pass = (extra: Record<string, unknown> = {}): Verdict => ({ ok: true, ...extra });
const fail = (reason: string, extra: Record<string, unknown> = {}): Verdict => ({
  ok: false,
  reason,
  ...extra,
});

export const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function editorEmitted(doc: PmNode): PmNode {
  return versionDocument(documentSchema.nodeFromJSON(doc).toJSON() as Doc) as unknown as PmNode;
}

export function docsMatchExpected(expected: PmNode, actual: PmNode): boolean {
  if (deepEqual(actual, expected)) return true;
  return deepEqual(actual, editorEmitted(expected));
}

export function blocksOf(doc: PmNode | undefined | null): PmNode[] {
  return doc && Array.isArray(doc.content) ? doc.content : [];
}

export function blockIdOf(block: PmNode | undefined | null): string | undefined {
  const id = block?.attrs?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function blockIdsOf(doc: PmNode): (string | undefined)[] {
  return blocksOf(doc).map(blockIdOf);
}

export function collectBlockIds(root: unknown, into: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(root)) {
    for (const v of root) collectBlockIds(v, into);
    return into;
  }
  if (root !== null && typeof root === 'object') {
    const o = root as Record<string, unknown>;
    const attrs = o.attrs;
    if (attrs && typeof attrs === 'object') {
      const id = (attrs as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) into.add(id);
    }
    for (const k of Object.keys(o)) if (k !== 'attrs') collectBlockIds(o[k], into);
  }
  return into;
}

function countId(root: unknown, id: string): number {
  let n = 0;
  if (Array.isArray(root)) {
    for (const v of root) n += countId(v, id);
    return n;
  }
  if (root !== null && typeof root === 'object') {
    const o = root as Record<string, unknown>;
    const attrs = o.attrs;
    if (attrs && typeof attrs === 'object' && (attrs as Record<string, unknown>).id === id) n += 1;
    for (const k of Object.keys(o)) if (k !== 'attrs') n += countId(o[k], id);
  }
  return n;
}

export function blockText(node: PmNode | undefined | null): string {
  if (!node) return '';
  let out = typeof node.text === 'string' ? node.text : '';
  for (const c of node.content ?? []) out += blockText(c);
  return out;
}

export function inlineSegments(node: PmNode): { segments: string[]; breaks: number } {
  const segments = [''];
  let breaks = 0;
  for (const c of node.content ?? []) {
    if (c.type === 'hardBreak') {
      breaks += 1;
      segments.push('');
    } else {
      segments[segments.length - 1] += blockText(c);
    }
  }
  return { segments, breaks };
}

export interface BlockOwner {
  page: SeedPage;
  block: PmNode;
  index: number;
}

export function findSingleOwner(pages: SeedPage[], targetId: string): BlockOwner {
  const hits: BlockOwner[] = [];
  for (const page of pages) {
    blocksOf(page.doc).forEach((block, index) => {
      if (blockIdOf(block) === targetId) hits.push({ page, block, index });
    });
  }
  if (hits.length !== 1) {
    throw new Error(`expected exactly one block ${targetId} across manifest, found ${hits.length}`);
  }
  return hits[0];
}

export function assertManifestShape(manifest: TrialManifest): void {
  if (!manifest || !Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error('manifest.pages missing or empty');
  }
  const memberIds = new Set<string>();
  const claim = (id: unknown, what: string): void => {
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${what} has no usable id`);
    if (memberIds.has(id)) throw new Error(`duplicate manifest member id ${id}`);
    memberIds.add(id);
  };
  const blockIds = new Set<string>();
  for (const page of manifest.pages) {
    claim(page?.id, 'page');
    const doc = page.doc;
    if (!doc || doc.type !== 'doc' || doc.schemaVersion !== 1) {
      throw new Error(`page ${page.id} doc must be {type:'doc', schemaVersion:1}`);
    }
    for (const block of blocksOf(doc)) {
      const id = blockIdOf(block);
      if (!id) throw new Error(`page ${page.id} contains a block without attrs.id`);
      if (blockIds.has(id)) throw new Error(`duplicate block id ${id}`);
      blockIds.add(id);
    }
  }
  for (const rec of manifest.records ?? []) claim(rec?.id, 'record');
  if (manifest.database && manifest.database.id !== undefined) claim(manifest.database.id, 'database');
}

export function collectManifestBlockIds(
  manifest: TrialManifest,
  into: Set<string> = new Set<string>(),
): Set<string> {
  for (const page of manifest.pages ?? []) collectBlockIds(page.doc, into);
  for (const rec of manifest.records ?? []) if (rec.doc) collectBlockIds(rec.doc, into);
  if (manifest.database?.doc) collectBlockIds(manifest.database.doc, into);
  return into;
}

export function projectOrdinaryPages(
  snapshotPages: SnapshotPage[],
  manifest: TrialManifest,
): Verdict & { pages?: SnapshotPage[] } {
  const members = new Set<string>();
  for (const page of manifest.pages) members.add(page.id);
  for (const rec of manifest.records ?? []) members.add(rec.id);
  if (manifest.database?.id) members.add(manifest.database.id);
  const seen = new Set<string>();
  for (const page of Array.isArray(snapshotPages) ? snapshotPages : []) {
    if (typeof page.id !== 'string' || !members.has(page.id)) {
      return fail('unknown-page', { id: page?.id });
    }
    if (seen.has(page.id)) return fail('duplicate-page', { id: page.id });
    seen.add(page.id);
  }
  for (const id of members) {
    if (!seen.has(id)) return fail('missing-page', { id });
  }
  const byId = new Map(snapshotPages.map((p) => [p.id, p]));
  return pass({ pages: manifest.pages.map((p) => byId.get(p.id) as SnapshotPage) });
}

const clip = (s: string, n = 40): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface Position {
  pageId: string;
  pageTitle: string;
  index: number;
  total: number;
  beforeText: string | null;
  afterText: string | null;
  human: string;
}

export function describePosition(pages: SeedPage[], blockId: string): Position {
  const owner = findSingleOwner(pages, blockId);
  const blocks = blocksOf(owner.page.doc);
  const beforeText = owner.index > 0 ? blockText(blocks[owner.index - 1]) : null;
  const afterText = owner.index < blocks.length - 1 ? blockText(blocks[owner.index + 1]) : null;
  const neighbor = (index: number): string => {
    const t = blockText(blocks[index]);
    return t ? `「${clip(t)}」` : `an empty paragraph (block ${index + 1} of ${blocks.length})`;
  };
  const parts: string[] = [];
  if (blocks.length === 1) {
    parts.push('the only block on the page');
  } else {
    parts.push(`block ${owner.index + 1} of ${blocks.length}`);
    parts.push(
      owner.index > 0
        ? `immediately after ${neighbor(owner.index - 1)}`
        : 'the first block on the page',
    );
    parts.push(
      owner.index < blocks.length - 1
        ? `immediately before ${neighbor(owner.index + 1)}`
        : 'the last block on the page',
    );
  }
  return {
    pageId: owner.page.id,
    pageTitle: String(owner.page.title ?? owner.page.id),
    index: owner.index,
    total: blocks.length,
    beforeText,
    afterText,
    human: parts.join(', '),
  };
}

const textNode = (text: string): PmNode => ({ type: 'text', text });

export function withBlockContent(doc: PmNode, blockId: string, content: PmNode[]): PmNode {
  const out = cloneJson(doc);
  const hit = blocksOf(out).find((b) => blockIdOf(b) === blockId);
  if (!hit) throw new Error(`block ${blockId} not in doc`);
  if (content.length === 0) delete hit.content;
  else hit.content = content;
  return out;
}

export function expectedAfterBlankEdit(doc: PmNode, blockId: string, marker: string): PmNode {
  return withBlockContent(doc, blockId, [textNode(marker)]);
}

export function expectedAfterSoftbreak(doc: PmNode, blockId: string): PmNode {
  return withBlockContent(doc, blockId, [
    textNode(TEXT_UPPER),
    { type: 'hardBreak' },
    textNode(TEXT_LOWER),
  ]);
}

export function expectedAfterEnter(doc: PmNode, blockId: string, newId: string): PmNode {
  const out = withBlockContent(doc, blockId, [textNode(TEXT_UPPER)]);
  const blocks = out.content as PmNode[];
  const idx = blocks.findIndex((b) => blockIdOf(b) === blockId);
  if (idx < 0) throw new Error(`block ${blockId} not in doc`);
  blocks.splice(idx + 1, 0, {
    type: 'paragraph',
    attrs: { id: newId },
    content: [textNode(TEXT_LOWER)],
  });
  return out;
}

export function expectedHandleOrder(
  ids: (string | undefined)[],
  moveId: string,
  beforeId: string,
): (string | undefined)[] {
  if (!ids.includes(moveId)) throw new Error(`move id ${moveId} not in baseline order`);
  const rest = ids.filter((i) => i !== moveId);
  const at = rest.indexOf(beforeId);
  if (at < 0) throw new Error(`before id ${beforeId} not in baseline order`);
  rest.splice(at, 0, moveId);
  return rest;
}

export function expectedAfterReorder(doc: PmNode, moveId: string, beforeId: string): PmNode {
  const out = cloneJson(doc);
  const blocks = blocksOf(out);
  const order = expectedHandleOrder(blocks.map(blockIdOf), moveId, beforeId);
  const byId = new Map(blocks.map((b) => [blockIdOf(b), b] as const));
  out.content = order.map((id) => byId.get(id) as PmNode);
  return out;
}

export function comparePagesExact(
  expectedPages: { id: string; doc: PmNode }[],
  currentPages: { id: string; doc: PmNode }[],
): Verdict {
  if (!Array.isArray(currentPages) || currentPages.length !== expectedPages.length) {
    return fail('page-count', {
      expected: expectedPages.length,
      actual: Array.isArray(currentPages) ? currentPages.length : -1,
    });
  }
  for (let i = 0; i < expectedPages.length; i += 1) {
    if (currentPages[i].id !== expectedPages[i].id) {
      return fail('page-order', { index: i, expected: expectedPages[i].id, actual: currentPages[i].id });
    }
    if (!deepEqual(currentPages[i].doc, expectedPages[i].doc)) {
      return fail('page-mismatch', { pageId: expectedPages[i].id });
    }
  }
  return pass();
}

export function compareProjection(
  seedPages: SeedPage[],
  currentPages: { id: string; doc: PmNode }[],
  touched: { pageId: string; expectedDoc: PmNode } | null,
): Verdict {
  if (!Array.isArray(currentPages) || currentPages.length !== seedPages.length) {
    return fail('page-count');
  }
  for (let i = 0; i < seedPages.length; i += 1) {
    if (currentPages[i].id !== seedPages[i].id) return fail('page-order', { index: i });
    if (touched && seedPages[i].id === touched.pageId) {
      if (!docsMatchExpected(touched.expectedDoc, currentPages[i].doc)) {
        return fail('touched-doc-mismatch', { pageId: touched.pageId });
      }
    } else if (!deepEqual(currentPages[i].doc, seedPages[i].doc)) {
      return fail('page-mismatch', { pageId: seedPages[i].id });
    }
  }
  return pass();
}

export function validateBlockEditResult(
  seedDoc: PmNode,
  actualDoc: PmNode,
  blockId: string,
  expectedText: string,
): Verdict {
  const bb = blocksOf(seedDoc);
  const cb = blocksOf(actualDoc);
  if (!blocksOf(seedDoc).some((b) => blockIdOf(b) === blockId)) {
    return fail('target-missing-in-baseline', { blockId });
  }
  if (cb.length !== bb.length) return fail('block-count', { baseline: bb.length, current: cb.length });
  for (let i = 0; i < bb.length; i += 1) {
    if (blockIdOf(cb[i]) !== blockIdOf(bb[i])) {
      return fail('block-order', { index: i, expected: blockIdOf(bb[i]), actual: blockIdOf(cb[i]) });
    }
  }
  const expected = expectedAfterBlankEdit(seedDoc, blockId, expectedText);
  if (!docsMatchExpected(expected, actualDoc)) return fail('target-doc-mismatch');
  return pass();
}

export function validateManifestEdit(
  seedPages: SeedPage[],
  currentPages: { id: string; doc: PmNode }[],
  pageId: string,
  blockId: string,
  marker: string,
): Verdict {
  const owner = seedPages.find((p) => p.id === pageId);
  if (!owner) return fail('page-missing-in-seed', { pageId });
  let expectedDoc: PmNode;
  try {
    expectedDoc = expectedAfterBlankEdit(owner.doc, blockId, marker);
  } catch {
    return fail('target-missing-in-baseline', { pageId, blockId });
  }
  return compareProjection(seedPages, currentPages, { pageId, expectedDoc });
}

export function validateEnterResult(
  seedDoc: PmNode,
  actualDoc: PmNode,
  blankId: string,
  baselineIds: Set<string>,
): Verdict {
  const bb = blocksOf(seedDoc);
  const cb = blocksOf(actualDoc);
  const ti = bb.findIndex((b) => blockIdOf(b) === blankId);
  if (ti < 0) return fail('target-missing-in-baseline', { blankId });
  if (cb.length !== bb.length + 1) {
    return fail('insert-count', { baseline: bb.length, current: cb.length });
  }
  for (let i = 0; i < bb.length; i += 1) {
    if (i === ti) continue;
    if (blockIdOf(cb[i < ti ? i : i + 1]) !== blockIdOf(bb[i])) {
      return fail('block-order', { index: i });
    }
  }
  const first = cb[ti];
  const second = cb[ti + 1];
  if (blockIdOf(first) !== blankId) return fail('first-id-changed', { actual: blockIdOf(first) });
  if (first.type !== 'paragraph') return fail('first-type', { type: first.type });
  if (!second || second.type !== 'paragraph') return fail('inserted-type', { type: second?.type });
  const newId = blockIdOf(second);
  if (!newId) return fail('inserted-id-missing');
  if (baselineIds.has(newId)) return fail('inserted-id-not-fresh', { id: newId });
  if (countId(actualDoc, newId) !== 1) return fail('inserted-id-duplicated', { id: newId });
  const expected = expectedAfterEnter(seedDoc, blankId, newId);
  if (!docsMatchExpected(expected, actualDoc)) return fail('doc-mismatch');
  return pass({ insertedId: newId, index: ti });
}

export function validateSoftbreakResult(
  seedDoc: PmNode,
  actualDoc: PmNode,
  blankId: string,
): Verdict {
  const bb = blocksOf(seedDoc);
  const cb = blocksOf(actualDoc);
  if (ti0(bb, blankId) < 0) return fail('target-missing-in-baseline', { blankId });
  if (cb.length !== bb.length) {
    return fail('block-count', { baseline: bb.length, current: cb.length });
  }
  for (let i = 0; i < bb.length; i += 1) {
    if (blockIdOf(cb[i]) !== blockIdOf(bb[i])) return fail('block-order', { index: i });
  }
  const expected = expectedAfterSoftbreak(seedDoc, blankId);
  if (!docsMatchExpected(expected, actualDoc)) return fail('doc-mismatch');
  return pass();
}

const ti0 = (blocks: PmNode[], id: string): number => blocks.findIndex((b) => blockIdOf(b) === id);

export function validateSnapshotExact(expectedDoc: PmNode, currentDoc: PmNode, what: string): Verdict {
  return docsMatchExpected(expectedDoc, currentDoc) ? pass() : fail(`${what}-doc-mismatch`);
}

export function validateHandleReorder(
  seedDoc: PmNode,
  actualDoc: PmNode,
  moveId: string,
  beforeId: string,
): Verdict {
  let expected: PmNode;
  try {
    expected = expectedAfterReorder(seedDoc, moveId, beforeId);
  } catch {
    return fail('target-missing-in-baseline', { moveId, beforeId });
  }
  if (blocksOf(actualDoc).length !== blocksOf(seedDoc).length) {
    return fail('block-count', { baseline: blocksOf(seedDoc).length, current: blocksOf(actualDoc).length });
  }
  const expectedIds = blockIdsOf(expected);
  const actualIds = blockIdsOf(actualDoc);
  if (!deepEqual(actualIds, expectedIds)) return fail('order', { expected: expectedIds, actual: actualIds });
  if (!docsMatchExpected(expected, actualDoc)) return fail('doc-mismatch');
  return pass({ order: expectedIds });
}

export interface HandleReading {
  blockId: string | null;
  selected: boolean;
}

export function validateSingleHandleSelection(
  handles: HandleReading[],
  expectedId: string,
): Verdict {
  const sel = handles.filter((h) => h.selected);
  if (sel.length !== 1) return fail('selection-count', { selected: sel.length });
  if (sel[0].blockId !== expectedId) {
    return fail('selection-target', { expected: expectedId, actual: sel[0].blockId });
  }
  return pass();
}

export interface PollSample {
  saved: boolean;
  active: boolean;
  match: boolean | null;
  missKey?: string;
}

export type PollClassification = 'match' | 'mismatch' | 'pending';

export function classifyPoll(samples: PollSample[]): PollClassification {
  if (samples.some((s) => s.saved && s.active && s.match === true)) return 'match';
  let tail = 0;
  let key: string | undefined;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i];
    if (!(s.saved && s.active && s.match === false)) break;
    const k = s.missKey ?? '';
    if (!k) break;
    if (tail === 0) key = k;
    else if (k !== key) break;
    tail += 1;
  }
  return tail >= 2 ? 'mismatch' : 'pending';
}

export function missKeyOf(ordinary: { id: string; doc: PmNode }[], pageId: string): string {
  const hit = ordinary.find((p) => p.id === pageId);
  return hit ? JSON.stringify(hit.doc) : `missing:${pageId}`;
}

export function mismatchKeyOf(
  ordinary: { id: string; doc: PmNode }[],
  touchedId: string,
  verdict: Verdict,
): string {
  const reason = typeof verdict.reason === 'string' ? verdict.reason : 'unknown';
  const pageId = typeof verdict.pageId === 'string' ? verdict.pageId : touchedId;
  return JSON.stringify({
    reason,
    pageId,
    ids: ordinary.map((p) => p.id),
    doc: missKeyOf(ordinary, pageId),
  });
}

export function isStaleAffirmative(
  stepAt: string | undefined | null,
  commandAt: string | undefined | null,
): boolean {
  const stepMs = Date.parse(String(stepAt ?? ''));
  const commandMs = Date.parse(String(commandAt ?? ''));
  if (!Number.isFinite(stepMs) || !Number.isFinite(commandMs)) return true;
  return commandMs < stepMs;
}
