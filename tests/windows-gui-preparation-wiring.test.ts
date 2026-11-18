import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const prepareWindows=vi.hoisted(()=>vi.fn(({runRoot,workspace,env}: {runRoot:string;workspace:string;env:Record<string,string>})=>Object.freeze({...Object.fromEntries(Object.entries(env).filter(([key])=>!key.toUpperCase().startsWith('FOLIO_SYNC_')&&key.toUpperCase()!=='FOLIO_CREDENTIAL_DIR')),FOLIO_WINDOWS_GUI_BATCH:'1',FOLIO_WINDOWS_GUI_DATA_ROOT:runRoot,FOLIO_DATA_DIR:workspace})));
vi.mock('../scripts/windows-gui-batch-policy.mjs',()=>({prepareWindowsGuiBatch:prepareWindows}));
// @ts-ignore Import-safe JavaScript entry. No GUI/native process is executed.
import {prepareGuiOwnedShutdown} from '../scripts/gui-owned-shutdown.mjs';
const roots:string[]=[];
afterEach(()=>{vi.clearAllMocks();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
describe('actual owned GUI preparation to Windows isolation policy (mock policy, no GUI/native execution)',()=>{
 it('passes the owned fresh run/data root and preserves its shutdown request and helper pins',()=>{
  const bin=mkdtempSync(join(tmpdir(),'folio-gui-prep-wiring-'));roots.push(bin);
  const helper=join(bin,'OwnedNodeJob.exe'),probe=join(bin,'PrivateRootProbe.exe');writeFileSync(helper,'helper');writeFileSync(probe,'probe');
  const env={FOLIO_SYNC_ENABLED:'1',FOLIO_SYNC_SERVER_URL:'https://never-test.invalid',folio_sync_secret:'synthetic-must-not-forward',FOLIO_CREDENTIAL_DIR:join(bin,'existing-vault'),FOLIO_WINDOWS_OWNED_HELPER:helper,FOLIO_WINDOWS_OWNED_HELPER_SHA256:createHash('sha256').update('helper').digest('hex'),FOLIO_WINDOWS_NATIVE_PROBE:probe,FOLIO_WINDOWS_NATIVE_SHA256:createHash('sha256').update('probe').digest('hex')};
  const prepared=prepareGuiOwnedShutdown({env,untrustedTest:{platform:'win32'}});roots.push(prepared.runRoot);
  expect(prepareWindows).toHaveBeenCalledTimes(1);
  expect(prepareWindows.mock.calls[0][0]).toMatchObject({runRoot:prepared.runRoot,workspace:prepared.workspace,env:{...env,FOLIO_GUI_TEST_OPT_IN:'1'}});
  expect(prepared.env.FOLIO_SYNC_ENABLED).toBeUndefined();expect(prepared.env.FOLIO_SYNC_SERVER_URL).toBeUndefined();expect(prepared.env.folio_sync_secret).toBeUndefined();expect(prepared.env.FOLIO_CREDENTIAL_DIR).toBeUndefined();
  expect(prepared.env.FOLIO_WINDOWS_GUI_DATA_ROOT).toBe(prepared.runRoot);expect(prepared.env.FOLIO_WINDOWS_GUI_BATCH).toBe('1');
  expect(JSON.parse(prepared.env.FOLIO_OWNED_SHUTDOWN_REQUEST)).toMatchObject({runRoot:prepared.runRoot,windows:{helperPath:helper,helperSha256:env.FOLIO_WINDOWS_OWNED_HELPER_SHA256}});
 });
});
