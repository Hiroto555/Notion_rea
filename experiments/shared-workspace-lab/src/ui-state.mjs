import { invalid } from './contracts.mjs';

const SCOPES = new Set(['private', 'shared']);
const STAGES = new Set(['draft', 'local', 'server', 'peer', 'unknown', 'rejected']);
const CONNECTIONS = new Set(['online', 'offline']);
const ROLES = new Set(['owner', 'editor', 'viewer', 'revoked']);

const SAVE_LABELS = {
  draft: '未保存',
  local: 'この端末に保存済み',
  server: 'サーバーに保存済み',
  peer: '相手端末への適用を確認',
  unknown: '保存結果を確認中',
  rejected: '保存が拒否されました',
};

const SCOPE_LABELS = { private: '個人', shared: '共有' };
const CONNECTION_LABELS = { online: '接続中', offline: 'オフライン' };

export function projectWorkspaceState(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid();

  const { scope, stage, connection, role, conflict, pendingCount } = input;

  if (!SCOPES.has(scope)) return invalid();
  if (!STAGES.has(stage)) return invalid();
  if (!CONNECTIONS.has(connection)) return invalid();
  if (!ROLES.has(role)) return invalid();
  if (typeof conflict !== 'boolean') return invalid();
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) return invalid();

  const canEdit = role !== 'viewer' && role !== 'revoked' && !conflict;
  const needsAttention =
    conflict || stage === 'unknown' || stage === 'rejected' || role === 'revoked';

  return {
    ok: true,
    view: {
      saveLabel: SAVE_LABELS[stage],
      scopeLabel: SCOPE_LABELS[scope],
      canEdit,
      needsAttention,
      connectionLabel: CONNECTION_LABELS[connection],
      pendingCount,
    },
  };
}
