import {describe, it, expect, afterEach} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-ignore JavaScript entry is deliberately import-safe and launches no GUI.
import {prepareGuiOwnedShutdown} from '../scripts/gui-owned-shutdown.mjs';
const hash = createHash('sha256').update('fixture helper').digest('hex');
const roots:string[]=[];
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
describe('Windows GUI preparation native root-probe configuration (no GUI execution)', () => {
  it.each([{}, {FOLIO_WINDOWS_NATIVE_PROBE:'C:\\Folio\\probe.exe'}, {FOLIO_WINDOWS_NATIVE_PROBE:'C:\\Folio\\probe.exe',FOLIO_WINDOWS_NATIVE_SHA256:'bad'}])('refuses a missing or unpinned directory probe before creating a run (case %#)', config => {
    const root=mkdtempSync(join(tmpdir(),'folio-root-probe-config-'));roots.push(root);
    const helper=join(root,'OwnedNodeJob.exe');writeFileSync(helper,'fixture helper');
    expect(() => prepareGuiOwnedShutdown({env:{FOLIO_WINDOWS_OWNED_HELPER:helper,FOLIO_WINDOWS_OWNED_HELPER_SHA256:hash,...config},untrustedTest:{platform:'win32'}})).toThrow(/WINDOWS_ROOT_PROBE_CONFIG/);
  });
});
