import {test,expect,chromium,type ElectronApplication,type Browser} from '@playwright/test';
import {createServer} from 'node:net';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {r8Data,launchR8,disposeR8,installNativeDialogStub,setNativePaths,openBackupSurface} from './r8-fixture';

test('restore open starts the actual compiled child app on the restored workspace while the source app stays alive',async()=>{
 const data=r8Data();let app:ElectronApplication|undefined,childBrowser:Browser|undefined;
 const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
 try{
  const running=await launchR8(data);app=running.app;const window=running.window;
  await installNativeDialogStub(app);mkdirSync(data.restoreTarget);await setNativePaths(app,{open:data.restoreTarget});
  // Observe and retain the real child, adding only a loopback CDP port for read-only assertions.
  await app.evaluate((_electron,port)=>{
   const childProcess=process.getBuiltinModule('child_process');const original=childProcess.spawn;
   (globalThis as any).__r8RealChildren=[];(globalThis as any).__r8RealLaunches=[];
   childProcess.spawn=((executable:string,args:string[],options:any)=>{
    const child=original(executable,[`--remote-debugging-port=${port}`,...args],options);
    (globalThis as any).__r8RealChildren.push(child);
    (globalThis as any).__r8RealLaunches.push({pid:child.pid,args,directory:options.env.FOLIO_DATA_DIR});return child;
   }) as typeof childProcess.spawn;
  },port);
  await openBackupSurface(window);await window.getByRole('button',{name:'バックアップを作成',exact:true}).click();
  await window.getByRole('button',{name:'新しいフォルダーへ復元',exact:true}).click();
  await expect(window.getByText('復元が完了しました',{exact:true})).toBeVisible();
  await window.getByRole('button',{name:'復元先を開く',exact:true}).click();
  await expect.poll(async()=>{try{const response=await fetch(`http://127.0.0.1:${port}/json/version`);return response.ok;}catch{return false;}},{timeout:20000}).toBe(true);
  childBrowser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const childPage=childBrowser.contexts()[0].pages()[0];await expect(childPage.locator('.page-title')).toHaveValue(data.home.title);
  await expect(childPage.locator('.folio-editor')).toContainText('R8 home body');await expect(childPage.locator('.save-state')).toHaveText('保存済み');
  const launches=await app.evaluate(()=>(globalThis as any).__r8RealLaunches);
  expect(launches).toHaveLength(1);expect(launches[0].args).toEqual([resolve('dist/main.cjs')]);expect(launches[0].directory).toContain(data.restoreTarget);
  expect(app.process().exitCode).toBeNull();await expect(window.getByRole('dialog',{name:'バックアップと復元'})).toBeVisible();
 }finally{
  if(childBrowser) await childBrowser.close();
  if(app) await app.evaluate(async()=>{for(const child of (globalThis as any).__r8RealChildren??[]){if(child.exitCode===null&&child.signalCode===null){await new Promise<void>(done=>{child.once('exit',()=>done());child.kill('SIGTERM');});}}});
  await disposeR8(data,app);
 }
});
