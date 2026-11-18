import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { expect, it } from "vitest";

it.each(["management", "recovery", "types"])("compiled IPC schemas survive %s-first module initialization", order => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-m3-schema-")));
  try {
    const imports = {
      management: `import {SyncManagementControl} from ${JSON.stringify(resolve("src/main/sync-management-control.ts"))}; export {SyncManagementControl};`,
      recovery: `import {emptyCrashRecoverySnapshot} from ${JSON.stringify(resolve("src/shared/crash-recovery.ts"))}; export {emptyCrashRecoverySnapshot};`,
      types: `import {requestSchema} from ${JSON.stringify(resolve("src/shared/types.ts"))}; export {requestSchema};`,
    };
    const entry = join(root, "entry.ts"), output = join(root, "schema.cjs");
    writeFileSync(entry, [imports[order as keyof typeof imports], ...Object.entries(imports).filter(([key]) => key !== order).map(([,text]) => text)].join("\n"));
    buildSync({entryPoints: [entry], outfile: output, bundle: true, platform: "node", format: "cjs", external: ["node:sqlite"], logLevel: "silent"});
    const child = spawnSync(process.execPath, ["-e", `
      const {requestSchema,emptyCrashRecoverySnapshot}=require(${JSON.stringify(output)});
      const snapshot=emptyCrashRecoverySnapshot();
      const good=requestSchema.safeParse({type:'recovery:write',expectedGeneration:0,snapshot}).success;
      const bad=requestSchema.safeParse({type:'recovery:write',expectedGeneration:0,snapshot:{...snapshot,pages:[{broken:true}]}}).success;
      const operation={operationId:'fixture',sessionId:'session',seq:1,pageId:'page',databasePageId:null,revision:0,patch:{title:'retained'}};
      const save=requestSchema.safeParse({type:'save:commit',operation}).success;
      const create=requestSchema.safeParse({type:'page:commit',operation:{operationId:'new',sessionId:'session',seq:1,command:{kind:'createPage',parentId:null,title:'new'}}}).success;
      console.log(JSON.stringify({good,bad,save,create}));
    `], {encoding: "utf8", timeout: 15_000});
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({good: true, bad: false, save: true, create: true});
  } finally {rmSync(root, {recursive: true, force: true});}
});
