// Run one validation command, preserving failures and source/build identity.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
const [label, command, ...args] = process.argv.slice(2);
if (!label || !command || !/^[a-z0-9-]+$/.test(label)) throw Error('label command args required');
const base = 'docs/validation/next-round', raw = 'output/next-round';
mkdirSync(base, {recursive:true}); mkdirSync(raw, {recursive:true});
if (existsSync(`${base}/${label}.json`)) throw Error('Do not overwrite an earlier run');
function files(dir) { return existsSync(dir) ? readdirSync(dir,{withFileTypes:true}).flatMap(x => x.isDirectory()?files(join(dir,x.name)):[join(dir,x.name)]) : []; }
function hash(paths) {return Object.fromEntries(paths.sort().map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));}
const source=hash([...files('src'),...files('tests'),...files('scripts'), 'package.json','package-lock.json','playwright.config.ts','vite.config.ts','tsconfig.json']);
const beforeBuild=hash(files('dist'));
const start=new Date().toISOString();
const startHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const dataDir=mkdtempSync(resolve(raw,`${label}-data-`));
const run=spawnSync(command,args,{env:{...process.env,FOLIO_DATA_DIR:dataDir},encoding:'utf8',maxBuffer:32*1024*1024});
const log=(run.stdout||'')+(run.stderr||'')+(run.error?String(run.error):'');
writeFileSync(`${raw}/${label}.txt`,log);
const clean=log.split(process.cwd()).join('<repo>').split(homedir()).join('<home>').replace(/\x1b\[[0-9;]*m/g,'');
writeFileSync(`${base}/${label}.txt`,clean);
const result={label,command:[command,...args],head:startHead,endHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),start,end:new Date().toISOString(),exitCode:run.status,signal:run.signal,status:run.status===0?'PASS':'FAIL',source,beforeBuild,afterBuild:hash(files('dist')),isolatedDataDir:true};
writeFileSync(`${base}/${label}.json`,JSON.stringify(result,null,2)+'\n');
process.stdout.write(clean);process.exitCode=run.status??1;
