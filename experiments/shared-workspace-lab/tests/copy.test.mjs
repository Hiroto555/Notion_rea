import test from 'node:test';
import assert from 'node:assert/strict';
import { planSharedCopy } from '../src/copy.mjs';

const hex = ch => ch.repeat(64);
const mk = (id, extra = {}) => ({ id, parentId: null, links: [], assets: [], title: `Title ${id}`, ...extra });
const plan = (pages, selectedIds, idMap, targetSpaceId = 'space-1') => planSharedCopy({ pages, selectedIds, targetSpaceId, idMap });
const one = (extra = {}, idMap = { 'page-a': 'new-a' }) => plan([mk('page-a', extra)], ['page-a'], idMap);
const assertCode = (result, code) => { assert.equal(result && result.ok, false); assert.equal(result.code, code); };
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('plans pages in selectedIds order with mapped ids and parents', () => {
  const pages = [
    mk('page-a', { links: [{ targetId: 'page-b', label: 'to b' }], assets: [{ sha256: hex('a'), size: 10 }], title: 'Alpha' }),
    mk('page-b', { parentId: 'page-a', title: 'Beta' }),
    mk('page-c', { parentId: 'page-a', title: 'Gamma' })
  ];
  const result = plan(pages, ['page-b', 'page-a'], { 'page-a': 'new-a', 'page-b': 'new-b' });
  assert.equal(result.ok, true);
  assert.equal(result.plan.targetSpaceId, 'space-1');
  assert.deepEqual(result.plan.pages.map(p => p.id), ['new-b', 'new-a']);
  const [b, a] = result.plan.pages;
  assert.deepEqual([b.title, b.parentId], ['Beta', 'new-a']);
  assert.equal(a.title, 'Alpha');
  assert.equal(a.parentId, null);
  assert.deepEqual(a.links, [{ targetId: 'new-b', label: 'to b' }]);
  assert.equal(result.plan.unresolvedLinkCount, 0);
  assert.deepEqual(a.assets, [{ sha256: hex('a'), size: 10 }]);
});

test('parents outside the selection become null', () => {
  const result = plan([mk('page-parent'), mk('page-child', { parentId: 'page-parent' })], ['page-child'], { 'page-child': 'new-child' });
  assert.equal(result.ok, true);
  assert.deepEqual([result.plan.pages[0].id, result.plan.pages[0].parentId], ['new-child', null]);
});

test('internal links are mapped with labels while external links are removed and counted', () => {
  const pages = [
    mk('page-a', { title: 'Alpha', links: [{ targetId: 'page-x', label: 'SECRET-LABEL' }, { targetId: 'page-b', label: 'keep-me' }] }),
    mk('page-b', { title: 'Beta' })
  ];
  const result = plan(pages, ['page-a', 'page-b'], { 'page-a': 'new-a', 'page-b': 'new-b' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.pages[0].links, [{ targetId: 'new-b', label: 'keep-me' }]);
  assert.equal(result.plan.unresolvedLinkCount, 1);
  const text = JSON.stringify(result.plan);
  for (const secret of ['page-x', 'SECRET-LABEL', 'page-a', 'page-b']) assert.equal(text.includes(secret), false);
});

test('unselected pages and their metadata are excluded from output', () => {
  const pages = [
    mk('page-a'),
    mk('page-hidden', { title: 'Hidden Title', links: [{ targetId: 'page-a', label: 'hidden-link' }], assets: [{ sha256: hex('f'), size: 99 }] })
  ];
  const result = plan(pages, ['page-a'], { 'page-a': 'new-a' });
  assert.equal(result.ok, true);
  assert.equal(result.plan.pages.length, 1);
  assert.deepEqual(Object.keys(result.plan.pages[0]).sort(), ['assets', 'id', 'links', 'parentId', 'title']);
  const text = JSON.stringify(result.plan);
  for (const secret of ['page-hidden', 'Hidden Title', 'hidden-link', hex('f')]) assert.equal(text.includes(secret), false);
});

test('assets dedupe by hash within a page but not across pages', () => {
  const shaA = hex('a'), shaB = hex('b');
  const pages = [
    mk('page-a', { assets: [{ sha256: shaA, size: 10 }, { sha256: shaA, size: 10 }, { sha256: shaB, size: 5 }] }),
    mk('page-b', { assets: [{ sha256: shaA, size: 10 }] })
  ];
  const result = plan(pages, ['page-a', 'page-b'], { 'page-a': 'new-a', 'page-b': 'new-b' });
  assert.equal(result.ok, true);
  const [a, b] = result.plan.pages;
  assert.equal(a.assets.length, 2);
  assert.deepEqual(Object.fromEntries(a.assets.map(x => [x.sha256, x.size])), { [shaA]: 10, [shaB]: 5 });
  assert.deepEqual(b.assets, [{ sha256: shaA, size: 10 }]);
});

test('conflicting asset sizes for one hash in a page are invalid', () => {
  assertCode(one({ assets: [{ sha256: hex('a'), size: 10 }, { sha256: hex('a'), size: 11 }] }), 'INVALID');
});

test('duplicate page ids are invalid', () => {
  assertCode(plan([mk('dup-page'), mk('dup-page', { title: 'Other' })], ['dup-page'], { 'dup-page': 'new-dup' }), 'INVALID');
});

test('asset hashes must be lowercase 64-character hex', () => {
  assertCode(one({ assets: [{ sha256: 'A'.repeat(64), size: 1 }] }), 'INVALID');
  assertCode(one({ assets: [{ sha256: 'a'.repeat(63), size: 1 }] }), 'INVALID');
});

test('asset sizes must be safe nonnegative integers', () => {
  assertCode(one({ assets: [{ sha256: hex('a'), size: -1 }] }), 'INVALID');
  assertCode(one({ assets: [{ sha256: hex('a'), size: Number.MAX_SAFE_INTEGER + 1 }] }), 'INVALID');
});

test('titles are accepted at 1000 characters and rejected above it', () => {
  const ok = one({ title: 'x'.repeat(1000) });
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.pages[0].title.length, 1000);
  assertCode(one({ title: 'x'.repeat(1001) }), 'INVALID');
});

test('missing or empty selection reports MISSING', () => {
  const pages = [mk('page-a')];
  assertCode(planSharedCopy({ pages, targetSpaceId: 'space-1', idMap: {} }), 'MISSING');
  assertCode(plan(pages, [], {}), 'MISSING');
});

test('incomplete idMap reports MAPPING', () => {
  assertCode(plan([mk('page-a'), mk('page-b')], ['page-a', 'page-b'], { 'page-a': 'new-a' }), 'MAPPING');
});

test('colliding new ids in idMap report MAPPING', () => {
  assertCode(plan([mk('page-a'), mk('page-b')], ['page-a', 'page-b'], { 'page-a': 'same-id', 'page-b': 'same-id' }), 'MAPPING');
});

test('new ids may not equal any source page id, including unselected pages', () => {
  assertCode(plan([mk('page-a'), mk('page-b'), mk('page-c')], ['page-a', 'page-b'], { 'page-a': 'new-a', 'page-b': 'page-c' }), 'MAPPING');
});

test('does not mutate inputs', () => {
  const input = {
    pages: [mk('page-a', { links: [{ targetId: 'page-b', label: 'to b' }], assets: [{ sha256: hex('a'), size: 10 }] }), mk('page-b', { parentId: 'page-a' })],
    selectedIds: ['page-a', 'page-b'],
    targetSpaceId: 'space-1',
    idMap: { 'page-a': 'new-a', 'page-b': 'new-b' }
  };
  const snapshot = structuredClone(input);
  deepFreeze(input);
  assert.equal(planSharedCopy(input).ok, true);
  assert.deepEqual(input, snapshot);
});

test('more than 10000 pages are invalid', () => {
  const pages = Array.from({ length: 10001 }, (_, i) => mk(`page-${i}`));
  assertCode(plan(pages, ['page-0'], { 'page-0': 'new-0' }), 'INVALID');
});
