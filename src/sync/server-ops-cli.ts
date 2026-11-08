import { basename } from "node:path";
import {
  administerOperationalServer,
  initializeOperationalServer,
  issueOperationalCredential,
  safeServerOpsError,
  startOperationalServer,
} from "./operational-server";
import { acquireServerDirectoryLease } from "./server-directory-lease";
import { createServerFullBackup, restoreServerFullBackup } from "./server-full-backup";
import { inspectFullServerBackup } from "./server-full-inspection";
import type { ServerOpsConfig } from "./server-ops-config";

export type ServerOpsIo = {
  write(line: string): void;
  error(line: string): void;
};

type Command =
  | "init"
  | "serve"
  | "issue"
  | "revoke"
  | "backup"
  | "inspect"
  | "restore";

type Spec = {
  required: readonly string[];
  optional: readonly string[];
};

const SPECS: Record<Command, Spec> = {
  init: { required: ["directory", "workspace", "owner", "port"], optional: [] },
  serve: { required: ["directory"], optional: [] },
  issue: {
    required: ["directory", "client", "credential-file"],
    optional: ["reuse-credential"],
  },
  revoke: { required: ["directory", "client"], optional: [] },
  backup: { required: ["directory", "destination"], optional: [] },
  inspect: { required: ["backup"], optional: [] },
  restore: { required: ["backup", "destination", "port"], optional: [] },
};

class UsageError extends Error {}
function usage(): never {
  throw new UsageError();
}

type Parsed = {
  command: Command;
  values: Map<string, string>;
  flags: Set<string>;
};

function parse(args: string[]): Parsed {
  if (args.length === 0) usage();
  const command = args[0] as Command;
  const spec = Object.hasOwn(SPECS, command) ? SPECS[command] : undefined;
  if (!spec) usage();
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--") || argument === "--") usage();
    const name = argument.slice(2);
    if (name.length === 0 || values.has(name) || flags.has(name)) usage();
    if (name === "reuse-credential") {
      flags.add(name);
      continue;
    }
    if (!spec.required.includes(name) && !spec.optional.includes(name)) usage();
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) usage();
    if (value.length === 0 || value.includes("\0")) usage();
    values.set(name, value);
  }
  for (const flag of flags) {
    if (!spec.optional.includes(flag)) usage();
  }
  for (const required of spec.required) {
    if (!values.has(required)) usage();
  }
  return { command, values, flags };
}

function value(parsed: Parsed, name: string): string {
  const found = parsed.values.get(name);
  if (found === undefined) usage();
  return found;
}

function port(parsed: Parsed): number {
  const text = value(parsed, "port");
  if (!/^[1-9][0-9]{0,4}$/.test(text)) usage();
  const parsedPort = Number(text);
  if (!Number.isSafeInteger(parsedPort) || parsedPort > 65_535) usage();
  return parsedPort;
}

function emit(io: ServerOpsIo, output: Record<string, unknown>): void {
  io.write(JSON.stringify(output));
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

async function execute(parsed: Parsed, io: ServerOpsIo): Promise<number> {
  switch (parsed.command) {
    case "init": {
      const config: ServerOpsConfig = {
        format: "folio-server-config/v1",
        workspaceId: value(parsed, "workspace"),
        ownerId: value(parsed, "owner"),
        port: port(parsed),
      };
      const result = await initializeOperationalServer(
        value(parsed, "directory"),
        config,
      );
      emit(io, { ok: true, serverEpoch: result.serverEpoch });
      return 0;
    }
    case "serve": {
      const server = await startOperationalServer(value(parsed, "directory"));
      try {
        emit(io, {
          ok: true,
          event: "ready",
          url: server.url,
          serverEpoch: server.serverEpoch,
        });
        await waitForSignal();
      } finally {
        await server.close();
      }
      return 0;
    }
    case "issue": {
      const result = await issueOperationalCredential({
        directory: value(parsed, "directory"),
        clientId: value(parsed, "client"),
        credentialFile: value(parsed, "credential-file"),
        reuse: parsed.flags.has("reuse-credential"),
      });
      emit(io, {
        ok: true,
        clientId: result.clientId,
        baseUrl: result.baseUrl,
      });
      return 0;
    }
    case "revoke": {
      const directory = value(parsed, "directory");
      const clientId = value(parsed, "client");
      await administerOperationalServer(directory, (server, config) => {
        server.revokeDevice(config.workspaceId, clientId);
      });
      emit(io, { ok: true, clientId });
      return 0;
    }
    case "backup": {
      const lease = acquireServerDirectoryLease(value(parsed, "directory"));
      try {
        const result = createServerFullBackup({
          sourceDirectory: lease.directory,
          destination: value(parsed, "destination"),
          lease,
        });
        emit(io, {
          ok: true,
          serverEpoch: result.manifest.serverEpoch,
          counts: result.manifest.counts,
        });
      } finally {
        lease.close();
      }
      return 0;
    }
    case "inspect": {
      const manifest = inspectFullServerBackup(value(parsed, "backup"));
      emit(io, { ok: true, counts: manifest.counts });
      return 0;
    }
    case "restore": {
      const result = restoreServerFullBackup({
        backupDirectory: value(parsed, "backup"),
        destination: value(parsed, "destination"),
        port: port(parsed),
      });
      emit(io, {
        ok: true,
        previousEpoch: result.previousEpoch,
        serverEpoch: result.serverEpoch,
      });
      return 0;
    }
  }
}

export async function runServerOpsCli(
  args: string[],
  io: ServerOpsIo,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(args);
  } catch {
    io.error(JSON.stringify({ ok: false, error: "usage" }));
    return 2;
  }
  try {
    return await execute(parsed, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.error(JSON.stringify({ ok: false, error: "usage" }));
      return 2;
    }
    io.error(JSON.stringify({ ok: false, error: safeServerOpsError(error) }));
    return 1;
  }
}

const invokedAs = process.argv[1] ? basename(process.argv[1]) : "";
if (invokedAs === "server-ops.cjs" || invokedAs === "server-ops-cli.ts") {
  void runServerOpsCli(process.argv.slice(2), {
    write: (line) => {
      process.stdout.write(line + "\n");
    },
    error: (line) => {
      process.stderr.write(line + "\n");
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write(
        JSON.stringify({ ok: false, error: "server-operation-held" }) + "\n",
      );
      process.exitCode = 1;
    },
  );
}
