// Guard-expression probe, NOT an application/Electron/Vitest run.
// Source: Hiroto555/Notion_rea @ 7759906dbbc905a4dc79d01b97aaff6471e51eb3
// Limits transcribed from src/shared/types.ts, src/persistence/store.ts,
// and src/main/index.ts. No repository code or user data is modified.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const titleCases = [489, 490, 491, 500, 501].map(length => {
  const title = '題'.repeat(length);
  const normalTitleLengthAllows = title.length <= 500;
  const recoveryTitleGuardAllows = !(typeof title !== 'string' || title.length > 490);
  return { length, normalTitleLengthAllows, recoveryTitleGuardAllows };
});
assert.equal(titleCases.find(x=>x.length===491).normalTitleLengthAllows, true);
assert.equal(titleCases.find(x=>x.length===491).recoveryTitleGuardAllows, false);
const page = {
  id: '00000000-0000-4000-8000-000000000001', schemaVersion: 1,
  parentId: null, title: '原本', icon: '📄', cover: '', position: 1,
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{type:'text',text:'あ'.repeat(5_050_000)}]}]},
  kind: 'page', database: null, favorite: false, createdAt: 0,
  updatedAt: 0, revision: 0, deletedAt: null
};
const payload = {format: 'folio-recovery', schemaVersion: 1,
  pages: [{...page, title: '未保存'}], persistedPages: [page],
  pendingPatches: [{seq: 1, id: page.id, patch:{title:'未保存'}}]};
const content = JSON.stringify(payload, null, 2);
const request = {type:'export', name:'folio-unsaved-recovery', format:'json', content};
const byteCase = {
  contentUTF16Length: content.length,
  fileUTF8Bytes: Buffer.byteLength(content, 'utf8'),
  requestUTF8Bytes: Buffer.byteLength(JSON.stringify(request), 'utf8'),
  exportContentLengthAllows: content.length <= 30_000_000,
  exportRequestSizeAllows: Buffer.byteLength(JSON.stringify(request),'utf8') <= 32_000_000,
  recoveryFileSizeAllows: Buffer.byteLength(content,'utf8') <= 30_000_000,
};
assert.equal(byteCase.exportContentLengthAllows, true);
assert.equal(byteCase.exportRequestSizeAllows, true);
assert.equal(byteCase.recoveryFileSizeAllows, false);
const result = {
  targetCommit: '7759906dbbc905a4dc79d01b97aaff6471e51eb3',
  executionKind: 'transcribed guard-expression probe; not production-function test',
  runtime: process.version, platform: process.platform,
  limitations: ['No Electron run', 'No dependency installation', 'No full requestSchema or Store.recover execution', 'No Notion operation', 'No physical IME test'],
  titleCases, byteCase
};
const out = join(dirname(fileURLToPath(import.meta.url)), 'recovery-boundary-results.json');
writeFileSync(out, JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result, null, 2));
