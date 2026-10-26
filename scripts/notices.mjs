import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));let text='Folio — Third-party notices\n\nElectron includes its own LICENSE and Chromium notices in the application bundle.\nThe following installed production packages may contribute bundled code.\n\n';
for(const [dir,info] of Object.entries(lock.packages)){
 if(!dir||info.dev||!existsSync(join(dir,'package.json')))continue;
 const pkg=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
 text+='\n'+'='.repeat(72)+'\n'+pkg.name+' '+pkg.version+' — '+(pkg.license??'see package')+'\n';
 for(const name of readdirSync(dir).filter(n=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(n))){try{text+='\n'+readFileSync(join(dir,name),'utf8')+'\n'}catch{}}
}
writeFileSync('docs/THIRD_PARTY_NOTICES.txt',text);
