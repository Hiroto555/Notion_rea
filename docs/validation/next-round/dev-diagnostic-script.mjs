import { _electron as electron } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const events=[];
const app=await electron.launch({args:[resolve('dist/main.cjs')],env:{...process.env,FOLIO_DEV_URL:'http://127.0.0.1:54117/'}});
try {
 const page=await app.firstWindow();
 page.on('console',m=>events.push({console:m.text()}));
 page.on('pageerror',e=>events.push({error:String(e)}));
 page.on('requestfailed',r=>events.push({request:r.url(),error:r.failure()}));
 try { await page.waitForSelector('.page-title',{timeout:10000}); events.push({ready:true}); } catch(e) { events.push({ready:false,reason:String(e)}); }
 events.push({url:page.url(),html:await page.content()});
 writeFileSync('output/next-round/dev-debug.json',JSON.stringify(events,null,2));
 console.log(JSON.stringify(events.map(e=>e.html?{url:e.url,htmlLength:e.html.length}:e),null,2));
} finally {await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>w.destroy()));await app.close();}
