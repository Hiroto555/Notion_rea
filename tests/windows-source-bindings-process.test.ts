import { buildSync } from "esbuild";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("uses retained SQLite binding across independent compiled Node processes (not Windows OS proof)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-source-process-")));
  chmodSync(root, 0o700);
  try {
    const executable = join(root, "binding-driver.cjs");
    buildSync({stdin: {contents: `
      import {WindowsSourceBindings} from './src/platform/windows/source-bindings';
      import {PosixPrivatePlatform} from './src/sync/private-platform';
      const [dir, operation, id] = process.argv.slice(2);
      const p = new PosixPrivatePlatform();
      // Explicitly labelled simulated native contract over real POSIX files.
      const port = {kind:'windows', bind:x=>p.bind(x), assertRoot:()=>p.assertRoot(),
        assertFile:x=>p.assertFile(x), assertSidecars:x=>p.assertSidecars(x),
        createExclusive:x=>p.createExclusive(x), assertEmptyFile:x=>p.assertEmptyFile(x), close:()=>p.close()};
      const b = new WindowsSourceBindings(dir, port);
      try { b[operation]({kind:'file', canonicalPath:'C:\\\\Folio\\\\source.sqlite', fileId:id.repeat(32), volumeId:'b'.repeat(16)}); }
      finally { b.close(); }
    `, resolveDir: resolve("."), sourcefile: "binding-driver.ts", loader: "ts"}, outfile: executable, bundle: true, platform: "node", format: "cjs", external: ["node:sqlite"]});
    const run = (operation: string, id: string) => spawnSync(process.execPath, [executable, root, operation, id], {encoding: "utf8", timeout: 10_000, env: {PATH: process.env.PATH, NODE_NO_WARNINGS: "1"}});
    expect(run("enroll", "a").status).toBe(0);
    expect(run("assert", "a").status).toBe(0);
    const changed = run("assert", "c");
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain("IDENTITY_CHANGED");
    expect(run("assert", "a").status).toBe(0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
