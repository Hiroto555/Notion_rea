import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ed from './e2e/mac-trial-editor-cases';
import { seedMacTrial } from '../scripts/mac-trial-seed';
import { Store } from '../src/persistence/store';
import type { Doc } from '../src/shared/types';

const text = (s: string): ed.PmNode => ({ type: 'text', text: s });
const linkText = (s: string, href: string): ed.PmNode => {
  const marks: NonNullable<Doc['marks']> = [{ type: 'link', attrs: { href } }];
  return { type: 'text', text: s, marks };
};
const para = (id: string, s?: string): ed.PmNode =>
  s === undefined
    ? { type: 'paragraph', attrs: { id } }
    : { type: 'paragraph', attrs: { id }, content: [text(s)] };
const docOf = (content: ed.PmNode[]): ed.PmNode => ({ type: 'doc', schemaVersion: 1, content });

const seedPages = (): ed.SeedPage[] => [
  {
    id: 'p-guide',
    title: 'Guide',
    parentId: null,
    doc: docOf([
      para(ed.GUIDE_BLOCKS.heading, 'Welcome'),
      para(ed.GUIDE_BLOCKS.intro, 'Intro text'),
      {
        type: 'paragraph',
        attrs: { id: ed.GUIDE_BLOCKS.links },
        content: [linkText('Links', 'https://example.test/')],
      },
      para(ed.GUIDE_BLOCKS.blank),
    ]),
  },
  {
    id: 'p-check',
    title: 'Checklist',
    parentId: 'p-guide',
    doc: docOf([
      para('check-head', 'Tasks'),
      para('mac-trial-checklist-blank-1'),
      para('mac-trial-checklist-blank-2'),
    ]),
  },
  { id: 'p-notes', title: 'Notes', parentId: null, doc: docOf([para('mac-trial-notes-blank')]) },
  { id: 'p-log', title: 'Log', parentId: null, doc: docOf([para('mac-trial-emptylog-blank')]) },
];

const manifest = (): ed.TrialManifest => ({
  activePage: 'p-guide',
  database: { id: 'db-main' },
  records: [{ id: 'rec-1', doc: docOf([para('rec-block-1', 'record body')]) }],
  pages: seedPages(),
});

const snapshotAll = (m: ed.TrialManifest): ed.SnapshotPage[] => [
  ...(m.records ?? []).map((r) => ({ id: r.id, doc: ed.cloneJson(r.doc as ed.PmNode) })),
  { id: String(m.database?.id), doc: docOf([]) },
  ...m.pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) })),
];

const allIds = (m: ed.TrialManifest): Set<string> => ed.collectManifestBlockIds(m);
const guideDoc = (m: ed.TrialManifest): ed.PmNode => m.pages[0].doc;

describe('parseEditorRunId', () => {
  it('accepts every bound editor case', () => {
    for (const c of ed.EDITOR_CASES) {
      const p = ed.parseEditorRunId(`editor-${c}-20261118T120000Z-0a1b2c`);
      expect(p?.caseId).toBe(c);
      expect(p?.hex).toBe('0a1b2c');
    }
  });
  it('rejects malformed or unbound runIds', () => {
    for (const bad of [
      'editor-enter-20261118T120000Z-0A1B2C',
      'editor-enter-20261118T120000Z-0a1b2',
      'editor-enter-20261118T120000Z-0a1b2c7',
      'editor-fly-20261118T120000Z-0a1b2c',
      'xeditor-enter-20261118T120000Z-0a1b2c',
      'editor-enter-20261118T120000Z-0a1b2c-extra',
      'editor-enter-2026118T120000Z-0a1b2c',
      '',
      42,
      null,
      undefined,
    ]) {
      expect(ed.parseEditorRunId(bad)).toBeNull();
    }
  });
});

describe('assertManifestShape', () => {
  it('accepts the minimal manifest', () => {
    expect(() => ed.assertManifestShape(manifest())).not.toThrow();
  });
  it('rejects duplicate member ids and duplicate block ids', () => {
    const dup = manifest();
    dup.records = [{ id: 'p-guide', doc: docOf([para('x', 'y')]) }];
    expect(() => ed.assertManifestShape(dup)).toThrow(/duplicate manifest member id/);
    const dupBlock = manifest();
    dupBlock.pages[1].doc.content!.push(para(ed.GUIDE_BLOCKS.intro, 'dupe'));
    expect(() => ed.assertManifestShape(dupBlock)).toThrow(/duplicate block id/);
  });
  it('rejects a block without attrs.id and a wrong schemaVersion', () => {
    const badBlock = manifest();
    badBlock.pages[2].doc.content!.push({ type: 'paragraph' });
    expect(() => ed.assertManifestShape(badBlock)).toThrow(/attrs\.id/);
    const badDoc = manifest();
    badDoc.pages[0].doc.schemaVersion = 2;
    expect(() => ed.assertManifestShape(badDoc)).toThrow(/schemaVersion/);
  });
});

describe('projectOrdinaryPages', () => {
  it('projects the ordinary pages in manifest order regardless of snapshot order', () => {
    const m = manifest();
    const snap = snapshotAll(m).reverse();
    const v = ed.projectOrdinaryPages(snap, m);
    expect(v.ok).toBe(true);
    expect(v.pages?.map((p) => p.id)).toEqual(m.pages.map((p) => p.id));
  });
  it('rejects missing, duplicate and unknown members', () => {
    const m = manifest();
    const missing = snapshotAll(m).filter((p) => p.id !== 'p-notes');
    expect(ed.projectOrdinaryPages(missing, m).reason).toBe('missing-page');
    const dup = snapshotAll(m);
    dup.push({ id: 'p-notes', doc: docOf([para('mac-trial-notes-blank')]) });
    expect(ed.projectOrdinaryPages(dup, m).reason).toBe('duplicate-page');
    const unknown = snapshotAll(m);
    unknown.push({ id: 'stray', doc: docOf([]) });
    expect(ed.projectOrdinaryPages(unknown, m).reason).toBe('unknown-page');
  });
});

describe('editorEmitted oracle', () => {
  it('round-trips an expected doc into editor-emitted form', () => {
    const m = manifest();
    const emitted = ed.editorEmitted(guideDoc(m));
    expect(ed.deepEqual(emitted, guideDoc(m))).toBe(false);
    const markNode = emitted.content?.[2]?.content?.[0] as {
      marks?: NonNullable<Doc['marks']>;
    };
    const mark = markNode.marks?.[0];
    expect(mark?.attrs?.target).toBe('_blank');
    expect(String(mark?.attrs?.rel)).toContain('noopener');
  });
  it('accepts strict raw or emitted expected, rejecting extra marks and doc meta drift', () => {
    const m = manifest();
    const expected = ed.expectedAfterSoftbreak(guideDoc(m), ed.GUIDE_BLOCKS.blank);
    const emitted = ed.editorEmitted(expected);
    expect(ed.docsMatchExpected(expected, emitted)).toBe(true);
    expect(ed.docsMatchExpected(expected, ed.cloneJson(expected))).toBe(true);
    const metaDrift = ed.cloneJson(emitted);
    metaDrift.schemaVersion = 2;
    expect(ed.docsMatchExpected(expected, metaDrift)).toBe(false);
    const bolded = ed.cloneJson(emitted);
    const inline = bolded.content?.[3]?.content?.[0] as ed.PmNode;
    (inline as { marks?: NonNullable<Doc['marks']> }).marks = [{ type: 'bold' }];
    expect(ed.docsMatchExpected(expected, bolded)).toBe(false);
  });
});

describe('validateSoftbreakResult', () => {
  it('accepts a schema-round-tripped single-paragraph hardBreak', () => {
    const m = manifest();
    const expected = ed.expectedAfterSoftbreak(guideDoc(m), ed.GUIDE_BLOCKS.blank);
    const actual = ed.editorEmitted(expected);
    expect(ed.validateSoftbreakResult(guideDoc(m), actual, ed.GUIDE_BLOCKS.blank).ok).toBe(true);
  });
  it('rejects two paragraphs, changed meta, changed id and missing break', () => {
    const m = manifest();
    const twoParas = docOf([
      ...(guideDoc(m).content as ed.PmNode[]).slice(0, 3),
      para(ed.GUIDE_BLOCKS.blank, ed.TEXT_UPPER),
      para('blk-extra', ed.TEXT_LOWER),
    ]);
    expect(
      ed.validateSoftbreakResult(guideDoc(m), twoParas, ed.GUIDE_BLOCKS.blank).reason,
    ).toBe('block-count');
    const expected = ed.expectedAfterSoftbreak(guideDoc(m), ed.GUIDE_BLOCKS.blank);
    const metaDrift = ed.editorEmitted(expected);
    metaDrift.schemaVersion = 2;
    expect(ed.validateSoftbreakResult(guideDoc(m), metaDrift, ed.GUIDE_BLOCKS.blank).ok).toBe(false);
    const renamed = docOf([
      ...(guideDoc(m).content as ed.PmNode[]).slice(0, 3),
      {
        type: 'paragraph',
        attrs: { id: 'renamed' as string },
        content: [text(ed.TEXT_UPPER), { type: 'hardBreak' }, text(ed.TEXT_LOWER)],
      },
    ]);
    expect(
      ed.validateSoftbreakResult(guideDoc(m), renamed, ed.GUIDE_BLOCKS.blank).reason,
    ).toBe('block-order');
    const joined = ed.expectedAfterBlankEdit(guideDoc(m), ed.GUIDE_BLOCKS.blank, '上段下段');
    expect(ed.validateSoftbreakResult(guideDoc(m), joined, ed.GUIDE_BLOCKS.blank).ok).toBe(false);
  });
});

describe('validateEnterResult', () => {
  const actualEnter = (m: ed.TrialManifest, insertId: string): ed.PmNode =>
    ed.editorEmitted(ed.expectedAfterEnter(guideDoc(m), ed.GUIDE_BLOCKS.blank, insertId));
  it('accepts a committed split retaining the original id with a fresh inserted id', () => {
    const m = manifest();
    const v = ed.validateEnterResult(
      guideDoc(m),
      actualEnter(m, 'blk-new-1'),
      ed.GUIDE_BLOCKS.blank,
      allIds(m),
    );
    expect(v.ok).toBe(true);
    expect(v.insertedId).toBe('blk-new-1');
  });
  it('rejects inserted ids colliding with baseline or the target', () => {
    const m = manifest();
    for (const id of [ed.GUIDE_BLOCKS.links, ed.GUIDE_BLOCKS.blank]) {
      expect(
        ed.validateEnterResult(guideDoc(m), actualEnter(m, id), ed.GUIDE_BLOCKS.blank, allIds(m)).ok,
      ).toBe(false);
    }
  });
  it('rejects id drift, changed neighbours, wrong arity and non-paragraph inserts', () => {
    const m = manifest();
    const drift = actualEnter(m, 'blk-new-2');
    (drift.content as ed.PmNode[])[3].attrs = { id: 'something-else' };
    expect(
      ed.validateEnterResult(guideDoc(m), drift, ed.GUIDE_BLOCKS.blank, allIds(m)).reason,
    ).toBe('first-id-changed');
    const tampered = actualEnter(m, 'blk-new-3');
    (tampered.content as ed.PmNode[])[1] = para(ed.GUIDE_BLOCKS.intro, 'rewritten');
    expect(
      ed.validateEnterResult(guideDoc(m), tampered, ed.GUIDE_BLOCKS.blank, allIds(m)).ok,
    ).toBe(false);
    const tooMany = docOf([
      ...(actualEnter(m, 'blk-x').content as ed.PmNode[]),
      para('another', 'extra'),
    ]);
    expect(
      ed.validateEnterResult(guideDoc(m), tooMany, ed.GUIDE_BLOCKS.blank, allIds(m)).reason,
    ).toBe('insert-count');
    const headingInsert = docOf([
      ...(guideDoc(m).content as ed.PmNode[]).slice(0, 3),
      para(ed.GUIDE_BLOCKS.blank, ed.TEXT_UPPER),
      { type: 'heading', attrs: { id: 'blk-new-4' }, content: [text(ed.TEXT_LOWER)] },
    ]);
    expect(
      ed.validateEnterResult(guideDoc(m), headingInsert, ed.GUIDE_BLOCKS.blank, allIds(m)).reason,
    ).toBe('inserted-type');
  });
});

describe('undo oracle', () => {
  it('the committed edit, the baseline and the redo are mutually exclusive oracles', () => {
    const m = manifest();
    const edited = ed.expectedAfterBlankEdit(guideDoc(m), ed.GUIDE_BLOCKS.blank, ed.UNDO_WORD);
    const editedEmitted = ed.editorEmitted(edited);
    expect(
      ed.validateBlockEditResult(guideDoc(m), editedEmitted, ed.GUIDE_BLOCKS.blank, ed.UNDO_WORD).ok,
    ).toBe(true);
    expect(
      ed.validateBlockEditResult(guideDoc(m), guideDoc(m), ed.GUIDE_BLOCKS.blank, ed.UNDO_WORD).ok,
    ).toBe(false);
    expect(ed.validateSnapshotExact(guideDoc(m), ed.cloneJson(guideDoc(m)), 'undo').ok).toBe(true);
    expect(ed.validateSnapshotExact(edited, editedEmitted, 'redo').ok).toBe(true);
    expect(ed.validateSnapshotExact(edited, guideDoc(m), 'redo').ok).toBe(false);
    expect(ed.validateSnapshotExact(guideDoc(m), editedEmitted, 'undo').ok).toBe(false);
  });
  it('rejects an intermediate state whose block id drifted', () => {
    const m = manifest();
    const edited = ed.expectedAfterBlankEdit(guideDoc(m), ed.GUIDE_BLOCKS.blank, ed.UNDO_WORD);
    const drift = ed.cloneJson(edited);
    (drift.content as ed.PmNode[])[3].attrs = { id: 'drifted' };
    expect(ed.validateSnapshotExact(edited, drift, 'redo').ok).toBe(false);
  });
});

describe('validateManifestEdit', () => {
  const check1 = 'mac-trial-checklist-blank-1';
  const marker = ed.BLANK_CASE_TARGETS['blank-check1'].marker;
  const editedCurrent = (m: ed.TrialManifest, blockIdx: number, withMarker = marker) => {
    const cur = m.pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    cur[1].doc = ed.editorEmitted(
      ed.expectedAfterBlankEdit(m.pages[1].doc, String((m.pages[1].doc.content as ed.PmNode[])[blockIdx].attrs?.id), withMarker),
    );
    return cur;
  };
  it('accepts exactly the designated edit', () => {
    const m = manifest();
    expect(ed.validateManifestEdit(m.pages, editedCurrent(m, 1), 'p-check', check1, marker).ok).toBe(true);
  });
  it('rejects editing the wrong identical-looking empty paragraph', () => {
    const m = manifest();
    const v = ed.validateManifestEdit(m.pages, editedCurrent(m, 2), 'p-check', check1, marker);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('touched-doc-mismatch');
  });
  it('rejects edits on an untouched ordinary page and a missing marker', () => {
    const m = manifest();
    const cur = editedCurrent(m, 1);
    (cur[2].doc.content as ed.PmNode[])[0].content = [text('x')];
    expect(ed.validateManifestEdit(m.pages, cur, 'p-check', check1, marker).reason).toBe(
      'page-mismatch',
    );
    const unchanged = m.pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    expect(ed.validateManifestEdit(m.pages, unchanged, 'p-check', check1, marker).ok).toBe(false);
  });
});

describe('handle oracle', () => {
  const order = [
    ed.GUIDE_BLOCKS.heading,
    ed.GUIDE_BLOCKS.intro,
    ed.GUIDE_BLOCKS.links,
    ed.GUIDE_BLOCKS.blank,
  ];
  it('computes the expected post-drag order', () => {
    expect(ed.expectedHandleOrder(order, ed.GUIDE_BLOCKS.intro, ed.GUIDE_BLOCKS.blank)).toEqual([
      ed.GUIDE_BLOCKS.heading,
      ed.GUIDE_BLOCKS.links,
      ed.GUIDE_BLOCKS.intro,
      ed.GUIDE_BLOCKS.blank,
    ]);
  });
  it('accepts only the intro-before-blank exchange with untouched content', () => {
    const m = manifest();
    const good = ed.editorEmitted(
      ed.expectedAfterReorder(guideDoc(m), ed.GUIDE_BLOCKS.intro, ed.GUIDE_BLOCKS.blank),
    );
    expect(
      ed.validateHandleReorder(guideDoc(m), good, ed.GUIDE_BLOCKS.intro, ed.GUIDE_BLOCKS.blank).ok,
    ).toBe(true);
    const afterBlank = docOf([
      (guideDoc(m).content as ed.PmNode[])[0],
      (guideDoc(m).content as ed.PmNode[])[2],
      (guideDoc(m).content as ed.PmNode[])[3],
      (guideDoc(m).content as ed.PmNode[])[1],
    ]);
    expect(
      ed.validateHandleReorder(guideDoc(m), afterBlank, ed.GUIDE_BLOCKS.intro, ed.GUIDE_BLOCKS.blank)
        .reason,
    ).toBe('order');
    expect(
      ed.validateHandleReorder(guideDoc(m), guideDoc(m), ed.GUIDE_BLOCKS.intro, ed.GUIDE_BLOCKS.blank)
        .ok,
    ).toBe(false);
    const tweaked = ed.cloneJson(
      ed.expectedAfterReorder(guideDoc(m), ed.GUIDE_BLOCKS.intro, ed.GUIDE_BLOCKS.blank),
    );
    (tweaked.content as ed.PmNode[])[2].content = [text('Intro!')];
    expect(
      ed.validateHandleReorder(guideDoc(m), tweaked, ed.GUIDE_BLOCKS.intro, ed.GUIDE_BLOCKS.blank)
        .reason,
    ).toBe('doc-mismatch');
  });
  it('requires exactly one selected handle bound to the intro block', () => {
    const h = (blockId: string | null, selected: boolean): ed.HandleReading => ({
      blockId,
      selected,
    });
    expect(
      ed.validateSingleHandleSelection(
        [h(ed.GUIDE_BLOCKS.intro, true), h('other', false)],
        ed.GUIDE_BLOCKS.intro,
      ).ok,
    ).toBe(true);
    expect(ed.validateSingleHandleSelection([h('other', false)], ed.GUIDE_BLOCKS.intro).ok).toBe(
      false,
    );
    expect(
      ed.validateSingleHandleSelection(
        [h(ed.GUIDE_BLOCKS.intro, true), h('other', true)],
        ed.GUIDE_BLOCKS.intro,
      ).ok,
    ).toBe(false);
    expect(
      ed.validateSingleHandleSelection([h(ed.GUIDE_BLOCKS.links, true)], ed.GUIDE_BLOCKS.intro).ok,
    ).toBe(false);
  });
});

describe('reopen oracle', () => {
  it('matches identical page lists and rejects a post-reopen id drift', () => {
    const m = manifest();
    const same = m.pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    expect(ed.comparePagesExact(m.pages, same).ok).toBe(true);
    const drift = m.pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    (drift[1].doc.content as ed.PmNode[])[1].attrs = { id: 'reopened-different' };
    expect(ed.comparePagesExact(m.pages, drift).ok).toBe(false);
  });
});

describe('describePosition', () => {
  it('describes the target by page, order and neighbours without exposing ids', () => {
    const m = manifest();
    const pos = ed.describePosition(m.pages, ed.GUIDE_BLOCKS.blank);
    expect(pos.pageTitle).toBe('Guide');
    expect(pos.index).toBe(3);
    expect(pos.total).toBe(4);
    expect(pos.beforeText).toBe('Links');
    expect(pos.afterText).toBeNull();
    expect(pos.human).not.toContain(ed.GUIDE_BLOCKS.blank);
  });
  it('describes a sole block without neighbour claims', () => {
    const pos = ed.describePosition(manifest().pages, 'mac-trial-notes-blank');
    expect(pos.human).toBe('the only block on the page');
  });
});

describe('describePosition empty neighbours', () => {
  const five = (): ed.SeedPage[] => [
    {
      id: 'p-five',
      title: 'Five',
      parentId: null,
      doc: docOf([
        para('five-head', 'Head'),
        para('five-e1'),
        para('five-e2'),
        para('five-e3'),
        para('five-tail', 'Tail'),
      ]),
    },
  ];
  it('labels an empty before-neighbour without calling the block last', () => {
    const pos = ed.describePosition(five(), 'five-e2');
    expect(pos.index).toBe(2);
    expect(pos.human).toBe(
      'block 3 of 5, immediately after an empty paragraph (block 2 of 5), immediately before an empty paragraph (block 4 of 5)',
    );
  });
  it('labels an empty after-neighbour without calling the block first', () => {
    const pos = ed.describePosition(five(), 'five-e1');
    expect(pos.index).toBe(1);
    expect(pos.human).toBe(
      'block 2 of 5, immediately after 「Head」, immediately before an empty paragraph (block 3 of 5)',
    );
  });
});

describe('classifyPoll', () => {
  const s = (saved: boolean, match: boolean | null, active = true): ed.PollSample => ({
    saved,
    active,
    match,
    missKey: 'k',
  });
  it('holds on stale saved followed by pending observations', () => {
    expect(ed.classifyPoll([s(true, false), s(false, null)])).toBe('pending');
    expect(ed.classifyPoll([s(true, false), s(false, false)])).toBe('pending');
    expect(ed.classifyPoll([])).toBe('pending');
  });
  it('matches on a saved, active, matching sample', () => {
    expect(ed.classifyPoll([s(false, null), s(true, true)])).toBe('match');
  });
  it('mismatches on consistent saved wrong samples at the end', () => {
    expect(ed.classifyPoll([s(false, null), s(true, false), s(true, false)])).toBe('mismatch');
  });
  it('does not mismatch on a lone saved miss or on inactive samples', () => {
    expect(ed.classifyPoll([s(true, false)])).toBe('pending');
    expect(ed.classifyPoll([s(true, false, false), s(true, false, false)])).toBe('pending');
  });
  it('requires coherent same-observation misses for mismatch', () => {
    const miss = (missKey: string): ed.PollSample => ({
      saved: true,
      active: true,
      match: false,
      missKey,
    });
    expect(ed.classifyPoll([miss('a'), miss('a')])).toBe('mismatch');
    expect(ed.classifyPoll([miss('a'), miss('b')])).toBe('pending');
    expect(ed.classifyPoll([miss('a'), miss('b'), miss('b')])).toBe('mismatch');
  });
  it('holds on unidentifiable misses and shifting evidence, mismatches on a stable miss', () => {
    const pages = manifest().pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    const touched = pages[0].id;
    const driftX = pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    const driftY = pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    (driftX[1].doc.content as ed.PmNode[])[0].content = [text('x')];
    (driftY[2].doc.content as ed.PmNode[])[0].content = [text('y')];
    const vx: ed.Verdict = { ok: false, reason: 'page-mismatch', pageId: driftX[1].id };
    const vy: ed.Verdict = { ok: false, reason: 'page-mismatch', pageId: driftY[2].id };
    const miss = (
      ordinary: { id: string; doc: ed.PmNode }[],
      verdict: ed.Verdict,
    ): ed.PollSample => ({
      saved: true,
      active: true,
      match: false,
      missKey: ed.mismatchKeyOf(ordinary, touched, verdict),
    });
    expect(ed.classifyPoll([miss(driftX, vx), miss(driftY, vy)])).toBe('pending');
    expect(ed.classifyPoll([miss(driftX, vx), miss(driftY, vy), miss(driftY, vy)])).toBe('mismatch');
    const noKey = (): ed.PollSample => ({ saved: true, active: true, match: false });
    expect(ed.classifyPoll([noKey(), noKey()])).toBe('pending');
  });
});

describe('command freshness and miss keys', () => {
  it('rejects missing, nonfinite or earlier affirmatives', () => {
    expect(ed.isStaleAffirmative('2026-11-18T12:00:00.000Z', '2026-11-18T12:00:01.000Z')).toBe(false);
    expect(ed.isStaleAffirmative('2026-11-18T12:00:01.000Z', '2026-11-18T12:00:00.000Z')).toBe(true);
    expect(ed.isStaleAffirmative('2026-11-18T12:00:00.000Z', 'not-a-date')).toBe(true);
    expect(ed.isStaleAffirmative('2026-11-18T12:00:00.000Z', undefined)).toBe(true);
    expect(ed.isStaleAffirmative(undefined, '2026-11-18T12:00:01.000Z')).toBe(true);
  });
  it('keys misses by the observed touched doc', () => {
    const pages = manifest().pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    const again = pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    const a = ed.missKeyOf(pages, 'p-guide');
    expect(ed.missKeyOf(again, 'p-guide')).toBe(a);
    const drift = pages.map((p) => ({ id: p.id, doc: ed.cloneJson(p.doc) }));
    (drift[0].doc.content as ed.PmNode[])[3].content = [text('x')];
    expect(ed.missKeyOf(drift, 'p-guide')).not.toBe(a);
    expect(ed.missKeyOf(pages, 'p-absent')).toBe('missing:p-absent');
  });
});

describe('real bound seed fixture', () => {
  it('loads 31 raw pages and projects the manifest ordinary pages unchanged', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'unique-')), 'synthetic');
    const seeded = seedMacTrial(dir);
    const m: ed.TrialManifest = {
      activePage: seeded.activePage,
      database: seeded.database,
      records: [...seeded.records],
      pages: [...seeded.pages],
    };
    const store = new Store(seeded.databaseFile);
    let loadedPages: ed.SnapshotPage[] = [];
    try {
      loadedPages = (store.load().pages ?? []) as ed.SnapshotPage[];
    } finally {
      store.close();
    }
    expect(loadedPages).toHaveLength(31);
    expect(() => ed.assertManifestShape(m)).not.toThrow();
    const proj = ed.projectOrdinaryPages(loadedPages, m);
    expect(proj.ok).toBe(true);
    expect(proj.pages?.map((p) => p.id)).toEqual(m.pages.map((p) => p.id));
    expect(ed.comparePagesExact(m.pages, proj.pages ?? []).ok).toBe(true);
  });
});
