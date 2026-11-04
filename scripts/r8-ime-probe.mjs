import {buildSync} from 'esbuild';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {_electron as electron} from '@playwright/test';
const root=process.cwd(),out=resolve(process.argv[2]??'output/r8-ime');
if(existsSync(out)) throw new Error('Use a new IME probe directory');mkdirSync(out,{recursive:true});
const bundle=join(out,'store.cjs');buildSync({entryPoints:[join(root,'src/persistence/store.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs'});
const require=createRequire(import.meta.url);const data=join(out,'data');mkdirSync(data);const store=new (require(bundle).Store)(join(data,'workspace.sqlite'));
const page=store.create(null,'page','W2 実IME検収・専用データ');store.handle({type:'setting',key:'activePage',value:page.id});store.close();
const app=await electron.launch({args:[join(root,'dist/main.cjs')],env:{...process.env,FOLIO_DATA_DIR:data}});const window=await app.firstWindow();
await window.waitForLoadState('domcontentloaded');
await window.evaluate(()=>{globalThis.__r8IME=[];for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input'])document.addEventListener(type,event=>{globalThis.__r8IME.push({type:event.type,data:event.data,isComposing:event.isComposing,isTrusted:event.isTrusted,at:Date.now(),target:event.target?.className});},true);});
writeFileSync(join(out,'process.json'),JSON.stringify({pid:app.process().pid,data,pageId:page.id,binary:app.process().spawnfile},null,2));console.log('IME probe ready: '+out);
try{
 while(!existsSync(join(out,'STOP'))){
  const result=await window.evaluate(async id=>({events:globalThis.__r8IME,editor:document.querySelector('.folio-editor')?.textContent,width:document.querySelector('.document')?.getAttribute('data-page-width'),focused:document.activeElement?.className,snapshot:await window.folio.request({type:'load'})}),page.id);
  writeFileSync(join(out,'observation.json'),JSON.stringify(result,null,2));
  await new Promise(resolve=>setTimeout(resolve,300));
 }
 await window.screenshot({path:join(out,'final.png')});
}finally{await app.close();}
