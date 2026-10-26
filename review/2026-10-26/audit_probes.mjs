/**
 * Folio source-logic audit probes; NOT the project's Vitest/Playwright suite.
 * Baseline: Hiroto555/Notion_rea @ abb1e3131d1b4cab6aee4560c6d8aa819859bc29.
 * Functions below were transcribed from the connector-read source, with TS types
 * erased. StoreExcerpt contains only the methods exercised here. No Electron,
 * React, Tiptap, Notion, native IME, or packaged app is launched by this script.
 * No user files, credentials, real workspaces, or clipboard are accessed.
 * Run: node audit_probes.mjs (Node supporting node:sqlite).
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { strict as assert } from 'node:assert';

const baseline = 'abb1e3131d1b4cab6aee4560c6d8aa819859bc29';
const results = [];
const source = path => `https://github.com/Hiroto555/Notion_rea/blob/${baseline}/${path}`;
const textOf = (node) => node.text ?? node.content?.map(textOf).join(' ') ?? '';
const blankDoc = () => ({ type: 'doc', content: [{type:'paragraph'}] });
function isDocument(value) {
  const types = new Set(['doc','text','paragraph','heading','bulletList','orderedList','listItem','taskList','taskItem','blockquote','codeBlock','horizontalRule','hardBreak','image','details','detailsSummary','detailsContent']);
  const marks = new Set(['bold','italic','strike','underline','code','link']);
  if (!value || typeof value !== 'object' || value.type !== 'doc') return false;
  const stack = [{ node: value, depth: 0 }]; let count = 0;
  while (stack.length) {
    const {node, depth} = stack.pop();
    if (++count > 100000 || depth > 100 || !node || typeof node !== 'object') return false;
    const n = node;
    if (!types.has(n.type) || (depth > 0 && n.type === 'doc')) return false;
    if (n.type === 'text' && (typeof n.text !== 'string' || !n.text.length)) return false;
    if (n.text !== undefined && typeof n.text !== 'string') return false;
    if (n.attrs !== undefined && (!n.attrs || typeof n.attrs !== 'object' || Array.isArray(n.attrs))) return false;
    if (n.marks && (!Array.isArray(n.marks) || n.marks.some(m => !m || !marks.has(m.type)))) return false;
    if (n.content !== undefined) {
      if (!Array.isArray(n.content)) return false;
      for (const child of n.content) stack.push({node:child,depth:depth+1});
    }
  }
  return true;
}
function packagedDataDir(execPath) {
  // Exact packaged branch of src/main/index.ts, with no FOLIO_DATA_DIR override.
  return resolve(join(dirname(execPath), '../../../..', '.folio-data'));
}
const downloadAttachmentPattern = /^folio-asset:\/\/[a-f0-9-]{36}\.[a-z0-9]{1,12}\/?$/;

class StoreExcerpt {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL);');
  }
  transaction(f) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const value=f();this.db.exec('COMMIT');return value;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  get(id) {
    const r = this.db.prepare('SELECT data FROM pages WHERE id=?').get(id);
    if (!r) throw new Error('ページが見つかりません');
    return JSON.parse(r.data);
  }
  write(p) {
    this.db.prepare('INSERT INTO pages(id,data,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,body=excluded.body')
    .run(p.id,JSON.stringify(p),[p.title,textOf(p.doc),...(p.database?.rows.map(r=>r.title+' '+Object.values(r.values).join(' '))??[])].join('\n'));
    return p;
  }
  update(id,revision,patch) {
    return this.transaction(()=>{
      const p=this.get(id);
      if(p.revision!==revision)throw new Error('保存の競合を検出しました。再読み込みして変更を確認してください。');
      if(patch.doc)this.recordVersion(p);
      return this.write({...p,...patch,updatedAt:Date.now(),revision:p.revision+1});
    });
  }
  recordVersion(p) {
    this.db.prepare('INSERT INTO versions(pageId,createdAt,title,doc) VALUES(?,?,?,?)').run(p.id,Date.now(),p.title,JSON.stringify(p.doc));
    this.db.prepare('DELETE FROM versions WHERE pageId=? AND id NOT IN(SELECT id FROM versions WHERE pageId=? ORDER BY id DESC LIMIT 100)').run(p.id,p.id);
  }
  versions(id) {return this.db.prepare('SELECT * FROM versions WHERE pageId=? ORDER BY id DESC').all(id).map(v=>({...v,doc:JSON.parse(v.doc)}));}
  close(){this.db.close();}
}
function probe(id,title,sourcePath,fn) {
  try { results.push({id,title,source:source(sourcePath),status:'observation_confirmed',...fn()}); }
  catch(error){results.push({id,title,source:source(sourcePath),status:'probe_failed',error:String(error)});process.exitCode=1;}
}
const paragraph = content => ({type:'doc',content:[{type:'paragraph',content}]});
probe('P01','Control: plain Japanese text','src/shared/types.ts',()=>{
  const actual=textOf(paragraph([{type:'text',text:'不動産'}]));assert.equal(actual,'不動産');return {classification:'control',actual};
});
probe('P02','Formatting splits a Japanese search term','src/shared/types.ts',()=>{
  const actual=textOf(paragraph([{type:'text',text:'不'},{type:'text',text:'動',marks:[{type:'bold'}]},{type:'text',text:'産'}]));
  assert.equal(actual,'不 動 産'); assert.equal(actual.includes('不動産'),false);
  return {classification:'defect',actual,required:'不動産',searchMatches:false};
});
probe('P03','Formatting splits an English word','src/shared/types.ts',()=>{
  const actual=textOf(paragraph([{type:'text',text:'soft'},{type:'text',text:'ware',marks:[{type:'bold'}]}]));
  assert.equal(actual,'soft ware');return {classification:'defect',actual,required:'software'};
});
probe('P04','Hard-break extraction does not preserve a newline','src/shared/types.ts',()=>{
  const actual=textOf(paragraph([{type:'text',text:'A'},{type:'hardBreak'},{type:'text',text:'B'}]));
  assert.equal(actual,'A  B');return {classification:'semantic_gap',actual,desired:'A\nB'};
});
probe('P05','Control: unknown node types are rejected','src/shared/types.ts',()=>{
  const actual=isDocument({type:'doc',content:[{type:'script'}]});assert.equal(actual,false);return {classification:'control',actual};
});
probe('P06','Inline text directly below doc is accepted by boundary validator','src/shared/types.ts',()=>{
  const actual=isDocument({type:'doc',content:[{type:'text',text:'not a block'}]});assert.equal(actual,true);
  return {classification:'validation_gap',actual,note:'Tiptap/ProseMirror schema check is not executed in this probe.'};
});
probe('P07','A paragraph directly below bulletList is accepted','src/shared/types.ts',()=>{
  const actual=isDocument({type:'doc',content:[{type:'bulletList',content:[{type:'paragraph'}]}]});assert.equal(actual,true);
  return {classification:'validation_gap',actual,note:'Only the repository boundary validator is exercised.'};
});
probe('P08','Standard macOS installation path maps to root data directory','src/main/index.ts',()=>{
  const actual=packagedDataDir('/Applications/Folio.app/Contents/MacOS/Folio');assert.equal(actual,'/.folio-data');
  return {classification:'defect',actual,note:'Path calculation only; no directory is created and macOS launch is not tested.'};
});
probe('P09','Control: current development package layout','src/main/index.ts',()=>{
  const actual=packagedDataDir('/project/release/Folio-darwin-arm64/Folio.app/Contents/MacOS/Folio');assert.equal(actual,'/project/release/.folio-data');
  return {classification:'control',actual};
});
probe('P10','An extensionless attachment ID cannot be downloaded','src/shared/types.ts',()=>{
  const url='folio-asset://'+randomUUID();const actual=downloadAttachmentPattern.test(url);assert.equal(actual,false);
  return {classification:'defect',actual,inputShape:'folio-asset://<uuid>',note:'attach() permits this ID when extname(file) is empty.'};
});
probe('P11','An attachment with a non-ASCII extension cannot be downloaded','src/shared/types.ts',()=>{
  const actual=downloadAttachmentPattern.test('folio-asset://'+randomUUID()+'.資料');assert.equal(actual,false);
  return {classification:'defect',actual,inputShape:'folio-asset://<uuid>.資料'};
});
probe('P12','Database row deletion leaves no page-version recovery entry','src/persistence/store.ts',()=>{
  const s=new StoreExcerpt(); try {
    const p={id:randomUUID(),parentId:null,title:'Database',icon:'',cover:'',position:0,doc:blankDoc(),kind:'database',database:{properties:[],rows:[{id:'row-a',title:'valuable row',values:{cost:100}}],view:'table',filter:'',sort:''},favorite:false,createdAt:0,updatedAt:0,revision:0,deletedAt:null};
    s.write(p);s.update(p.id,0,{database:{...p.database,rows:[]}});
    const actual={rowCount:s.get(p.id).database.rows.length,versionCount:s.versions(p.id).length};assert.deepEqual(actual,{rowCount:0,versionCount:0});
    return {classification:'recovery_gap',actual,note:'Excerpt of real SQLite methods; no UI or complete application test.'};
  } finally{s.close();}
});
probe('P13','Title-only updates create no version entry','src/persistence/store.ts',()=>{
  const s=new StoreExcerpt(); try {
    const p={id:randomUUID(),title:'before',doc:blankDoc(),database:null,revision:0};s.write(p);s.update(p.id,0,{title:'after'});
    const actual=s.versions(p.id).length;assert.equal(actual,0);return {classification:'documented_limitation',actual};
  } finally{s.close();}
});
probe('P14','Control: document updates do create version entries','src/persistence/store.ts',()=>{
  const s=new StoreExcerpt(); try {
    const p={id:randomUUID(),title:'before',doc:blankDoc(),database:null,revision:0};s.write(p);s.update(p.id,0,{doc:paragraph([{type:'text',text:'after'}])});
    const actual=s.versions(p.id).length;assert.equal(actual,1);return {classification:'control',actual};
  } finally{s.close();}
});
console.log(JSON.stringify({baseline,runtime:process.version,scope:'transcribed source-logic excerpts only; not npm test, Playwright, Electron or Notion verification',probes:results.length,confirmed:results.filter(r=>r.status==='observation_confirmed').length,results},null,2));
