import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync,readFileSync } from 'node:fs';
const root=resolve(import.meta.dirname,'../..');
const pkg=JSON.parse(readFileSync(resolve(import.meta.dirname,'node_modules/rea-agents/package.json'),'utf8'));
const entry=typeof pkg.bin==='string'?pkg.bin:pkg.bin.rea;
const transport=new StdioClientTransport({command:resolve(import.meta.dirname,'node_modules/node/bin/node'),args:[resolve(import.meta.dirname,'node_modules/rea-agents',entry),'mcp'],env:{...process.env,REA_HOME:resolve(root,'.cache/rea')},stderr:'pipe'});
let errors='';transport.stderr?.on('data',c=>errors+=c.toString());
const client=new Client({name:'codex-folio-research',version:'1.0.0'});
try {
 await client.connect(transport);
 const list=await client.listTools();
 writeFileSync(resolve(root,'research/evidence/rea-tools.json'),JSON.stringify(list,null,2));
 if(process.argv[2]){
  const name=process.argv[2],args=JSON.parse(process.argv[3]||'{}');
  const result=await client.callTool({name,arguments:args},undefined,{timeout:120000});
  writeFileSync(resolve(root,`research/evidence/rea-${name}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
 }else console.log(JSON.stringify(list.tools.map(({name,description})=>({name,description:description?.slice(0,180)})),null,2));
}finally {await client.close(); if(errors)writeFileSync(resolve(root,'research/evidence/rea-stderr.log'),errors);}
