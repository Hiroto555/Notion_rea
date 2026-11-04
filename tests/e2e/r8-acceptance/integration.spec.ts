import {test, expect, type ElectronApplication} from "@playwright/test";
import {r8Data, launchR8, disposeR8, openR8Database, openR8Record, openBackupSurface, r8PageWidth, r8Saved, findBackupManifests} from "./r8-fixture";

test("record width preserves numeric draft, Editor identity and focus across side/full mode, then persists restart",async()=>{
  const data=r8Data();let app:ElectronApplication|undefined;
  try {
    let running=await launchR8(data);app=running.app;let window=running.window;
    await openR8Database(window,data.owner.title);await openR8Record(window,data.records.alpha.title);
    const surface=window.locator(".r3-record-page");const number=surface.getByLabel("見積",{exact:true});
    await number.fill("-");
    await surface.locator(".folio-editor").evaluate(element=>{(window as any).__r8RecordEditor=element;});
    await surface.getByRole("button",{name:"ワイド",exact:true}).click();
    await expect(number).toHaveValue("-");await expect(number).toBeFocused();
    await expect.poll(()=>r8PageWidth(window,data.records.alpha.pageId)).toBe("wide");
    await expect(surface).toHaveAttribute("data-page-width","wide");
    await surface.locator(".r4-record-mode").click();
    expect(await window.evaluate(()=>(window as any).__r8RecordEditor===document.querySelector(".r3-record-page .folio-editor"))).toBe(true);
    await expect(number).toHaveValue("-");
    await number.fill("7");await r8Saved(window);await app.close();app=undefined;
    running=await launchR8(data);app=running.app;window=running.window;
    await openR8Database(window,data.owner.title);await openR8Record(window,data.records.alpha.title);
    await expect(window.locator(".r3-record-page")).toHaveAttribute("data-page-width","wide");
  } finally {await disposeR8(data,app);}
});

test("incomplete numeric input blocks complete backup without dropping the draft or publishing a snapshot",async()=>{
  const data=r8Data();let app:ElectronApplication|undefined;
  try {
    const running=await launchR8(data);app=running.app;const window=running.window;
    await openR8Database(window,data.owner.title);await openR8Record(window,data.records.alpha.title);
    await window.locator(".r3-record-page").getByLabel("見積",{exact:true}).fill("-");
    await window.getByRole("button",{name:"レコードを閉じる",exact:true}).click();
    const before=findBackupManifests(data.root).map(value=>value.root);
    await openBackupSurface(window);await window.getByRole("button",{name:"バックアップを作成",exact:true}).click();
    await expect(window.getByRole("dialog",{name:"バックアップと復元"}).getByRole("alert")).toContainText("未保存");
    expect(findBackupManifests(data.root).map(value=>value.root)).toEqual(before);
    await window.getByRole("button",{name:"閉じる",exact:true}).click();
    await openR8Record(window,data.records.alpha.title);
    const number=window.locator(".r3-record-page").getByLabel("見積",{exact:true});await expect(number).toHaveValue("-");
    await number.fill("7");await r8Saved(window);
  } finally {await disposeR8(data,app);}
});
