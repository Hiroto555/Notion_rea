import { expect, test, type ElectronApplication } from '@playwright/test';
import { r4Data, launchR4, disposeR4, openR4Database, openR4Record, r4Saved } from './r4-fixture';
import { createR5Database, disposeR5, launchR5, openR7Settings, r5Data, r5Settings } from './r5-fixture';

const isMac = process.platform === 'darwin';
const modKey = isMac ? 'Meta' : 'Control';

test('DB popovers stay visible outside the scroller at desktop and narrow widths', async () => {
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data); app = running.app; const w = running.window;
    await createR5Database(w, 'R7 menu bounds');
    for (const width of [1440, 1200, 1024]) {
      await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setContentSize(width,900),width);
      await expect.poll(()=>w.evaluate(()=>innerWidth)).toBe(width);
      for (const name of ['filter','sort','view-options'] as const) {
        await openR7Settings(w,name);
        const panel = w.locator(`[data-settings-menu-panel="${name}"]`);
        await expect(panel).toBeVisible();
        await expect.poll(()=>panel.evaluate(el=>{
          const b=el.getBoundingClientRect();
          return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight &&
            [[b.left+10,b.top+10],[b.right-10,b.top+10],[b.left+10,b.bottom-10],[b.right-10,b.bottom-10]]
              .every(([x,y])=>el.contains(document.elementFromPoint(x,y)));
        })).toBe(true);
        await w.keyboard.press('Escape');
      }
    }
  } finally { await disposeR5(data, app); }
});

test('immediate link shortcut captures the visible range before delayed selectionchange', async () => {
  const data = r4Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data); app = running.app; const w = running.window;
    const body = w.locator('.folio-editor');
    await body.fill('リンク対象');
    await r4Saved(w);
    await body.evaluate((el, mac) => {
      const editor = (el as any).editor;
      editor.commands.setTextSelection(1);
      const text = el.querySelector('p')!.firstChild!;
      // Same task: native range is current but ProseMirror has not received
      // the browser's asynchronous selectionchange notification yet.
      getSelection()!.setBaseAndExtent(text, 0, text, 5);
      el.dispatchEvent(new KeyboardEvent('keydown',{key:'k',code:'KeyK',metaKey:mac,ctrlKey:!mac,bubbles:true,cancelable:true}));
    }, isMac);
    const link = w.getByRole('dialog',{name:'ページリンク',exact:true});
    await expect(link).toBeVisible();
    await w.keyboard.press('Escape');
    await expect(link).toBeHidden();
    await expect(body).toBeFocused();
    expect(await w.evaluate(()=>getSelection()?.toString())).toBe('リンク対象');
  } finally { await disposeR4(data, app); }
});

test('DB menu Escape survives removing its focused control and yields to search navigation', async () => {
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data); app = running.app; const w = running.window;
    await createR5Database(w, 'R7 menu navigation');
    await openR7Settings(w, 'filter');
    await r5Settings(w).getByRole('button', {name:'条件を追加 1',exact:true}).click();
    await r5Settings(w).getByRole('button', {name:'フィルター条件を削除 1.1',exact:true}).click();
    await w.keyboard.press('Escape');
    const trigger = w.locator('[data-settings-menu-trigger="filter"]');
    await expect(trigger).toHaveAttribute('aria-expanded','false');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await w.keyboard.press(`${modKey}+p`);
    const search = w.getByRole('dialog',{name:'ワークスペース検索',exact:true});
    await expect(search).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded','false');
    await w.keyboard.press('Escape');
    await expect(search).toBeHidden();
  } finally { await disposeR5(data, app); }
});

test('page menus close with Escape to their trigger and never follow search navigation', async () => {
  const data = r4Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data); app = running.app; const w = running.window;
    const trigger = w.getByRole('button', {name:'ページメニュー', exact:true});
    await trigger.click();
    await w.getByRole('button', {name:'Markdownを書き出す', exact:true}).focus();
    await w.keyboard.press('Escape');
    await expect(trigger).toBeFocused(); await expect(w.locator('.dropdown')).toHaveCount(0);
    const icon = w.getByRole('button', {name:'ページアイコン', exact:true});
    await icon.click(); await w.locator('.icon-picker button').first().focus();
    await w.keyboard.press('Escape'); await expect(icon).toBeFocused();
    await expect(w.locator('.icon-picker')).toHaveCount(0);
    await icon.click(); await trigger.click(); await expect(w.locator('.icon-picker')).toHaveCount(0);
    await w.keyboard.press('Escape');
    await w.keyboard.press(`${modKey}+p`); await w.getByLabel('検索キーワード').fill('R4 Alpha');
    await w.locator('.search-results button').first().click();
    await expect(w.getByLabel('レコードのタイトル', {exact:true})).toBeFocused();
    await expect(w.locator('.dropdown,.icon-picker')).toHaveCount(0);
    await w.getByRole('button', {name:'レコードを閉じる', exact:true}).click();
    await expect(w.getByRole('button', {name:'開く R4 Alpha',exact:true})).toBeFocused();
  } finally { await disposeR4(data, app); }
});

test('pointer layout changes retain editor focus, selection and incomplete number focus', async () => {
  const data = r4Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data); app = running.app; const w = running.window;
    await openR4Database(w); await openR4Record(w);
    const body = w.locator('.r3-record-page .folio-editor');
    await body.fill('入力した日本語をそのまま保持');
    const before = await body.evaluate((el) => {
      const editor = (el as any).editor;
      (globalThis as any).r7SameEditor = editor;
      editor.commands.setTextSelection({from:2,to:7});
      return {from:editor.state.selection.from,to:editor.state.selection.to};
    });
    await w.getByRole('button', {name:'全画面で開く',exact:true}).click();
    await expect(body).toBeFocused();
    expect(await body.evaluate((el) => { const e=(el as any).editor; return {same:e === (globalThis as any).r7SameEditor,from:e.state.selection.from,to:e.state.selection.to}; })).toEqual({same:true,...before});
    const number = w.getByLabel('見積', {exact:true});
    await number.fill('-');
    await w.getByRole('button', {name:'サイドピークで開く',exact:true}).click();
    await expect(number).toBeFocused(); await expect(number).toHaveValue('-');
    await number.fill('7'); await r4Saved(w);
  } finally { await disposeR4(data, app); }
});

test('app.quit is refused for incomplete raw input and communicates that the input is retained', async () => {
  const data = r4Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data); app = running.app; const w = running.window;
    await openR4Database(w); await openR4Record(w);
    await w.getByLabel('見積', {exact:true}).fill('-');
    await app.evaluate(({app}) => app.quit());
    await expect.poll(() => app!.evaluate(() => (globalThis as any).r4PreventedUnload)).toBeGreaterThan(0);
    await expect(w.getByLabel('見積', {exact:true})).toHaveValue('-');
    await expect(w.getByText('未保存の入力を保持しています。保存中の処理・保存結果・入力途中の数値を確認してから終了してください。', {exact:true})).toBeVisible();
    await w.getByLabel('見積', {exact:true}).fill('11'); await r4Saved(w);
  } finally { await disposeR4(data, app); }
});
