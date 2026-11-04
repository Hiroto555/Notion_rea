import {buildSync} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdirSync, cpSync, existsSync, writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {_electron as electron,expect} from '@playwright/test';
const root=process.cwd(), output=resolve(process.argv[2] ?? 'output/r8-screens');
if(existsSync(output)) throw new Error('Use a new screenshot directory');
mkdirSync(output,{recursive:true});const require=createRequire(import.meta.url);
const seedBundle=join(output,'seed.cjs');buildSync({entryPoints:[join(root,'scripts/r7-demo-seed.ts')],outfile:seedBundle,bundle:true,platform:'node',format:'cjs'});
const source=join(output,'fixture');mkdirSync(source);const manifest=require(seedBundle).seedDemo(join(source,'workspace.sqlite'),undefined,join(root,'tests/fixtures/image.png'));
const records=[];
for(const [label,appRoot] of [['W1',resolve(root,'../Folio-r7-integration')],['W2',root]]){
 const data=join(output,label+'-data');cpSync(source,data,{recursive:true});const env={...process.env,FOLIO_DATA_DIR:data};delete env.FOLIO_DEV_URL;
 const app=await electron.launch({args:[join(appRoot,'dist/main.cjs')],cwd:appRoot,env});
 try{
  const page=await app.firstWindow();await expect(page.locator('.page-title')).toBeVisible();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,960));
  const open=async(title)=>{await page.getByTitle(title,{exact:true}).first().click();await expect(page.locator('.page-title')).toHaveValue(title);};
  const shot=async(name)=>{await page.waitForTimeout(200);const path=join(output,label+'-'+name+'.png');await page.screenshot({path});records.push({build:label,name,path});};
  const regular=manifest.pages.find(p=>p.role==='regular');await open(regular.title);await shot('backlinks');
  if(label==='W2'){
   await page.getByRole('group',{name:'ページの幅',exact:true}).getByRole('button',{name:'ワイド',exact:true}).click();await expect(page.locator('.document')).toHaveAttribute('data-page-width','wide');await expect(page.locator('.save-state')).toHaveText('保存済み');await shot('wide-page');
   await page.getByRole('button',{name:'ページメニュー',exact:true}).click();await page.getByRole('button',{name:'バックアップと復元',exact:true}).click();
   await page.getByRole('button',{name:'バックアップを作成',exact:true}).click();await expect(page.getByRole('button',{name:'新しいフォルダーへ復元',exact:true})).toBeVisible();await shot('backup-verified');
   const parent=join(output,'restored');mkdirSync(parent);await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},parent);
   await page.getByRole('button',{name:'新しいフォルダーへ復元',exact:true}).click();await expect(page.getByText('復元が完了しました',{exact:true})).toBeVisible();await shot('restore-complete');await page.getByRole('button',{name:'閉じる',exact:true}).click();
  }
  await open(manifest.database.title);await expect(page.getByRole('region',{name:'レコード一覧',exact:true})).toBeVisible();await shot('database');
  if(label==='W2'){
   await page.locator(`[data-record-open-id="${manifest.records[0].pageId}"]`).first().click();const record=page.locator('.r3-record-page');await expect(record).toBeVisible();await record.locator('.r4-record-mode').click();await record.getByRole('button',{name:'ワイド',exact:true}).click();await expect(record).toHaveAttribute('data-page-width','wide');await expect(page.locator('.save-state')).toHaveText('保存済み');await shot('record-wide');await record.getByRole('button',{name:'レコードを閉じる',exact:true}).click();
   await open(regular.title);await page.keyboard.press('Meta+Shift+l');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,760));await shot('dark-narrow');
  }
 }finally{await app.close();}
}
writeFileSync(join(output,'screens.json'),JSON.stringify(records,null,2));console.log(JSON.stringify(records,null,2));
