import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkspaceState } from '../src/ui-state.mjs';

const SAVE_LABELS = {
  draft: '未保存',
  local: 'この端末に保存済み',
  server: 'サーバーに保存済み',
  peer: '相手端末への適用を確認',
  unknown: '保存結果を確認中',
  rejected: '保存が拒否されました',
};

const valid = (overrides = {}) => ({
  scope: 'private',
  stage: 'draft',
  connection: 'online',
  role: 'owner',
  conflict: false,
  pendingCount: 0,
  ...overrides,
});

test('draft/private/online/owner produces the full documented view', () => {
  assert.deepEqual(projectWorkspaceState(valid()), {
    ok: true,
    view: {
      saveLabel: '未保存',
      scopeLabel: '個人',
      canEdit: true,
      needsAttention: false,
      connectionLabel: '接続中',
      pendingCount: 0,
    },
  });
});

test('every stage maps to its exact saveLabel', () => {
  for (const [stage, label] of Object.entries(SAVE_LABELS)) {
    const result = projectWorkspaceState(valid({ stage }));
    assert.equal(result.ok, true, stage);
    assert.equal(result.view.saveLabel, label, stage);
  }
});

test('scopeLabel and connectionLabel map exactly', () => {
  assert.equal(projectWorkspaceState(valid({ scope: 'private' })).view.scopeLabel, '個人');
  assert.equal(projectWorkspaceState(valid({ scope: 'shared' })).view.scopeLabel, '共有');
  assert.equal(projectWorkspaceState(valid({ connection: 'online' })).view.connectionLabel, '接続中');
  assert.equal(projectWorkspaceState(valid({ connection: 'offline' })).view.connectionLabel, 'オフライン');
});

test('connection alone never promotes or demotes the stage', () => {
  for (const stage of Object.keys(SAVE_LABELS)) {
    const online = projectWorkspaceState(valid({ stage, connection: 'online' }));
    const offline = projectWorkspaceState(valid({ stage, connection: 'offline' }));
    assert.equal(online.view.saveLabel, SAVE_LABELS[stage], `${stage}/online`);
    assert.equal(offline.view.saveLabel, SAVE_LABELS[stage], `${stage}/offline`);
    assert.equal(online.view.connectionLabel, '接続中');
    assert.equal(offline.view.connectionLabel, 'オフライン');
  }
  assert.equal(projectWorkspaceState(valid({ stage: 'draft', connection: 'online' })).view.saveLabel, '未保存');
});

test('canEdit follows role and conflict rules', () => {
  const cases = [
    [{ role: 'owner' }, true],
    [{ role: 'editor' }, true],
    [{ role: 'viewer' }, false],
    [{ role: 'revoked' }, false],
    [{ role: 'owner', conflict: true }, false],
    [{ role: 'editor', conflict: true }, false],
    [{ role: 'viewer', conflict: true }, false],
    [{ role: 'revoked', conflict: true }, false],
  ];
  for (const [overrides, expected] of cases) {
    const result = projectWorkspaceState(valid(overrides));
    assert.equal(result.ok, true, JSON.stringify(overrides));
    assert.equal(result.view.canEdit, expected, JSON.stringify(overrides));
  }
});

test('rejected save still allows editing when role permits it', () => {
  for (const role of ['owner', 'editor']) {
    const result = projectWorkspaceState(valid({ stage: 'rejected', role }));
    assert.equal(result.view.canEdit, true, role);
    assert.equal(result.view.needsAttention, true, role);
  }
});

test('needsAttention follows conflict/stage/role rules', () => {
  const cases = [
    [{}, false],
    [{ stage: 'draft', role: 'viewer' }, false],
    [{ stage: 'local', role: 'editor' }, false],
    [{ conflict: true }, true],
    [{ stage: 'unknown' }, true],
    [{ stage: 'rejected' }, true],
    [{ role: 'revoked' }, true],
    [{ stage: 'server', role: 'revoked', conflict: false }, true],
  ];
  for (const [overrides, expected] of cases) {
    const result = projectWorkspaceState(valid(overrides));
    assert.equal(result.ok, true, JSON.stringify(overrides));
    assert.equal(result.view.needsAttention, expected, JSON.stringify(overrides));
  }
});

test('pendingCount is echoed unchanged for boundary safe integers', () => {
  for (const pendingCount of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
    const result = projectWorkspaceState(valid({ pendingCount }));
    assert.equal(result.ok, true, String(pendingCount));
    assert.equal(result.view.pendingCount, pendingCount);
  }
});

test('input is not mutated, repeated calls are stable, and frozen input is accepted', () => {
  const input = valid({ scope: 'shared', stage: 'server', connection: 'offline', role: 'editor', pendingCount: 3 });
  const snapshot = structuredClone(input);
  Object.freeze(input);

  const first = projectWorkspaceState(input);
  const second = projectWorkspaceState(input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(first, second);
  assert.deepEqual(first.view, {
    saveLabel: 'サーバーに保存済み',
    scopeLabel: '共有',
    canEdit: true,
    needsAttention: false,
    connectionLabel: 'オフライン',
    pendingCount: 3,
  });
});

test('combined shared/offline/revoked/conflict keeps each field independent', () => {
  assert.deepEqual(
    projectWorkspaceState(valid({
      scope: 'shared',
      stage: 'server',
      connection: 'offline',
      role: 'revoked',
      conflict: true,
      pendingCount: Number.MAX_SAFE_INTEGER,
    })),
    {
      ok: true,
      view: {
        saveLabel: 'サーバーに保存済み',
        scopeLabel: '共有',
        canEdit: false,
        needsAttention: true,
        connectionLabel: 'オフライン',
        pendingCount: Number.MAX_SAFE_INTEGER,
      },
    },
  );
});

test('rejects unknown or wrong-case enum values', () => {
  const cases = [
    { scope: 'team' },
    { scope: 'Private' },
    { stage: 'synced' },
    { stage: 'DRAFT' },
    { connection: 'connecting' },
    { role: 'admin' },
    { role: 'OWNER' },
  ];
  for (const overrides of cases) {
    const result = projectWorkspaceState(valid(overrides));
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.equal(result.code, 'INVALID', JSON.stringify(overrides));
  }
});

test('rejects missing or undefined required enum fields', () => {
  for (const key of ['scope', 'stage', 'connection', 'role']) {
    const missing = valid();
    delete missing[key];
    const undefinedField = valid({ [key]: undefined });

    for (const input of [missing, undefinedField]) {
      const result = projectWorkspaceState(input);
      assert.equal(result.ok, false, key);
      assert.equal(result.code, 'INVALID', key);
    }
  }
});

test('rejects non-boolean conflict values', () => {
  for (const conflict of ['false', 0, 1, null, undefined, NaN, {}, []]) {
    const result = projectWorkspaceState(valid({ conflict }));
    assert.equal(result.ok, false, String(conflict));
    assert.equal(result.code, 'INVALID', String(conflict));
  }
});

test('rejects negative, fractional, unsafe, or non-number pendingCount', () => {
  for (const pendingCount of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined]) {
    const result = projectWorkspaceState(valid({ pendingCount }));
    assert.equal(result.ok, false, String(pendingCount));
    assert.equal(result.code, 'INVALID', String(pendingCount));
  }
});

test('rejects non-object inputs', () => {
  for (const input of [null, undefined, 42, 'draft', true, [], () => {}]) {
    const result = projectWorkspaceState(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(result.code, 'INVALID', String(input));
  }
});
