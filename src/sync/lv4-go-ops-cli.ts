import { LV4_GO_OPS_MAX_LINE_BYTES, Lv4GoOpsSession } from "./lv4-go-ops";
import { once } from "node:events";

const DIAGNOSTIC_PREFIX = "lv4-go-ops-cli: ";

/** Read bounded byte fragments before parsing; an oversize line is discarded
 * through its newline so that a later valid request can still be handled. */
async function processInput(session: Lv4GoOpsSession): Promise<void> {
  let pieces: Buffer[] = [], size = 0, oversized = false;
  const finish = async () => {
    let response;
    if (oversized) response = {id: null, ok: false, error: "line-too-large"};
    else {
      let bytes = Buffer.concat(pieces, size);
      if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
      const line = bytes.toString("utf8");
      response = !Buffer.from(line, "utf8").equals(bytes)
        ? {id: null, ok: false, error: "invalid-json"}
        : await session.handleLine(line);
    }
    if (!process.stdout.write(JSON.stringify(response) + "\n"))
      await once(process.stdout, "drain");
    pieces = []; size = 0; oversized = false;
  };
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (!oversized && size + length <= LV4_GO_OPS_MAX_LINE_BYTES + 1) {
        if (length) pieces.push(Buffer.from(chunk.subarray(offset, end)));
        size += length;
      } else if (length || size > LV4_GO_OPS_MAX_LINE_BYTES + 1) {
        oversized = true; pieces = []; size = 0;
      }
      if (newline < 0) break;
      await finish();
      offset = newline + 1;
    }
  }
  if (size || oversized) await finish();
}

async function run(): Promise<number> {
  if (process.argv.length > 2) {
    process.stderr.write(`${DIAGNOSTIC_PREFIX}arguments are not accepted\n`);
    return 2;
  }
  let session: Lv4GoOpsSession | undefined;
  let exitCode = 0;
  try {
    session = await Lv4GoOpsSession.open();
    await processInput(session);
  } catch {
    process.stderr.write(`${DIAGNOSTIC_PREFIX}request processing failed\n`);
    exitCode = 1;
  } finally {
    if (session) {
      try {await session.close();}
      catch {process.stderr.write(`${DIAGNOSTIC_PREFIX}close failed\n`); exitCode = 1;}
    }
  }
  return exitCode;
}
void run().then((code) => {process.exitCode = code;}, () => {
  process.stderr.write(`${DIAGNOSTIC_PREFIX}startup failed\n`); process.exitCode = 1;
});
