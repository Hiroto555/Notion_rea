import { _electron as electron, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

const root = process.cwd(), demo = resolve('output/r5-demo'), data = join(demo, 'data');
if (readFileSync(join(demo, 'SYNTHETIC-R5-DEMO'), 'utf8') !== 'Folio R5 synthetic demo\n')
  throw new Error('Expected the isolated R5 demo marker');
const launch = async () => {
  const env = {...process.env, FOLIO_DATA_DIR: data}; delete env.FOLIO_DEV_URL;
  const app = await electron.launch({args: [resolve('dist/main.cjs')], env});
  const window = await app.firstWindow();
  await window.setViewportSize({width: 1440, height: 900});
  expect(await app.evaluate(({app}) => app.getPath('userData'))).toBe(data);
  await expect(window.locator('.page-title')).toBeVisible();
  return {app, window};
};
let running = await launch(), app = running.app, window = running.window;
const saved = () => expect(window.locator('.save-state')).toHaveText('保存済み');
const snapshot = () => window.evaluate(() => window.folio.request({type: 'load'}));
const projection = (id) => window.evaluate((databasePageId) => window.folio.request({type: 'database:load', databasePageId}), id);
const settings = () => window.getByRole('region', {name: 'データベースの表示設定', exact: true});
try {
  const initial = await snapshot();
  if (initial.recordDatabaseIds?.length) throw new Error('Exercise requires the fresh v3 demo; existing demo left intact');
  const legacy = initial.pages.find(page => page.title === 'R5 旧DBの保持サンプル');
  await window.getByRole('button', {name: '新しいデータベース', exact: true}).click();
  const dialog = window.getByRole('dialog', {name: '新しいデータベース', exact: true});
  await dialog.getByLabel('データベース名', {exact: true}).fill('R5 合成タスクDB');
  await dialog.getByRole('button', {name: '作成', exact: true}).click();
  await expect(dialog).toBeHidden(); await saved();
  const owner = (await snapshot()).pages.find(page => page.title === 'R5 合成タスクDB');
  const created = [];
  for (const [title, note, estimate, done] of [
    ['募集資料を確認する', '資料の内容を整理する', '8', false],
    ['週次レビューをまとめる', '今週の確認内容', '5', false],
    ['打合せの記録を共有する', '合成データの完了タスク', '3', true],
  ]) {
    const previous = await projection(owner.id);
    await window.getByRole('button', {name: '新規行', exact: true}).click();
    await expect.poll(async () => (await projection(owner.id)).records.length).toBe(previous.records.length + 1);
    const record = (await projection(owner.id)).records.find(record => !previous.records.some(old => old.pageId === record.pageId));
    const row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await row.getByLabel('名前 無題', {exact: true}).fill(title);
    await row.getByLabel(`メモ ${title}`, {exact: true}).fill(note);
    await row.getByLabel(`見積 ${title}`, {exact: true}).fill(estimate);
    await row.getByLabel(`完了 ${title}`, {exact: true}).setChecked(done);
    await saved(); created.push({...record, title});
  }
  await settings().getByLabel('ビュー名', {exact: true}).fill('すべてのタスク');
  await settings().getByLabel('ビューを追加', {exact: true}).selectOption('table');
  await settings().getByLabel('ビュー名', {exact: true}).fill('未完了・見積順');
  await settings().getByText('フィルター・並べ替え・グループ', {exact: true}).click();
  await settings().getByRole('button', {name: '条件を追加 1', exact: true}).click();
  await settings().getByLabel('フィルター対象 1.1', {exact: true}).selectOption({label: '完了'});
  await settings().getByLabel('フィルター演算子 1.1', {exact: true}).selectOption('is_not_checked');
  await settings().getByRole('button', {name: '並べ替えを追加', exact: true}).click();
  await settings().getByLabel('並べ替え対象 1', {exact: true}).selectOption({label: '見積'});
  await settings().getByLabel('並べ替え方向 1', {exact: true}).selectOption('desc');
  await saved(); await expect(window.locator('tr[data-record-id]')).toHaveCount(2);
  await window.getByRole('button', {name: `開く ${created[0].title}`, exact: true}).click();
  const editor = window.locator('.r3-record-page .folio-editor');
  await editor.fill('R5の合成データです。新DBを作成し、行の本文と表示条件を実画面から保存しました。再起動後もこの文章が残ります。');
  await saved();
  const before = await projection(owner.id);
  const pageBefore = (await snapshot()).pages.find(page => page.id === created[0].pageId);
  await app.close();
  running = await launch(); app = running.app; window = running.window;
  // The stored active page may reopen the record; return to the database.
  const close = window.getByRole('button', {name: 'レコードを閉じる', exact: true});
  if (await close.isVisible()) await close.click();
  await window.getByTitle('R5 合成タスクDB', {exact: true}).click();
  await expect(settings()).toBeVisible(); await saved();
  const after = await projection(owner.id);
  expect(after).toEqual(before);
  const reloaded = await snapshot();
  expect(reloaded.pages.find(page => page.id === created[0].pageId)?.doc).toEqual(pageBefore.doc);
  expect(reloaded.pages.find(page => page.id === legacy.id)).toEqual(legacy);
  await expect(window.locator('tr[data-record-id]')).toHaveCount(2);
  await window.screenshot({path: join(demo, 'database.png')});
  await window.getByRole('button', {name: `開く ${created[0].title}`, exact: true}).click();
  await expect(window.locator('.r3-record-page .folio-editor')).toContainText('再起動後もこの文章が残ります。');
  await window.screenshot({path: join(demo, 'record.png')});
  const db = new DatabaseSync(join(data, 'workspace.sqlite'), {readOnly: true});
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const memberships = db.prepare('SELECT COUNT(*) AS count FROM record_memberships').get().count;
  db.close();
  expect(version).toBe(4); expect(memberships).toBe(3);
  writeFileSync(join(demo, 'demo-proof.json'), JSON.stringify({commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    observedAt: new Date().toISOString(), syntheticData: data, restartVerified: true, legacyUnchanged: true, version, memberships,
    projection: after, recordPage: pageBefore, screenshots: ['database.png', 'record.png']}, null, 2) + '\n');
  console.log('R5 demo verified through UI, restart and SQLite readback.');
  if (!process.argv.includes('--keep-open')) await app.close();
} catch (error) {
  await app.close().catch(() => {}); throw error;
}
