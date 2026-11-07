import { MemoryFixtureSecretStore, startFixtureSyncOps } from "./lv4-fixture-ops";
import { identifier, requireCondition, SyncError } from "./protocol";

export const LV4_GO_OPS_WORKSPACE_ID = "lv4-go-fixture-workspace";
export const LV4_GO_OPS_OWNER_ID = "lv4-go-fixture-owner";
export const LV4_GO_OPS_MAX_LINE_BYTES = 4_096;
const PROTOCOL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type Lv4GoOpsCommand =
  | { readonly id: string; readonly command: "status" }
  | { readonly id: string; readonly command: "register"; readonly clientId: string }
  | { readonly id: string; readonly command: "revoke"; readonly clientId: string };

export type Lv4GoOpsDeviceState = "active" | "revoked";
export type Lv4GoOpsDevice = {
  readonly clientId: string;
  readonly state: Lv4GoOpsDeviceState;
};
export type Lv4GoOpsStatus = {
  readonly workspaceId: string;
  readonly serverEpoch: string;
  readonly devices: readonly Lv4GoOpsDevice[];
};
export type Lv4GoOpsResult = Lv4GoOpsStatus | { readonly clientId: string };
export type Lv4GoOpsResponse =
  | { readonly id: string; readonly ok: true; readonly result: Lv4GoOpsResult }
  | { readonly id: string | null; readonly ok: false; readonly error: string };

/**
 * Test-only line protocol over an isolated fixture server.
 *
 * The session creates a fresh mkdtemp root and a real checkpoint server on
 * 127.0.0.1 only. Device tokens live in a memory-only fake secret store and are
 * never returned by status or any protocol response. There is deliberately no
 * backup/restore operation, no backup/restore epoch, and no OS secret store
 * adapter here: this seam cannot validate backup restoration or persist a
 * device credential across process lifetimes. Those require the separate
 * backup/restore epoch and OS secret-store adapters once they exist.
 */
export class Lv4GoOpsSession {
  private readonly ops: Awaited<ReturnType<typeof startFixtureSyncOps>>;
  private closed = false;

  private constructor(ops: Awaited<ReturnType<typeof startFixtureSyncOps>>) {
    this.ops = ops;
  }

  static async open(): Promise<Lv4GoOpsSession> {
    const ops = await startFixtureSyncOps({
      workspaceId: LV4_GO_OPS_WORKSPACE_ID,
      ownerId: LV4_GO_OPS_OWNER_ID,
      secrets: new MemoryFixtureSecretStore(),
    });
    try {
      requireLoopback(ops.url);
      return new Lv4GoOpsSession(ops);
    } catch (error) {
      try {
        await ops.close();
      } catch {
        // The original fixture error is the actionable one.
      }
      throw error;
    }
  }

  get url(): string {
    return this.ops.url;
  }

  status(): Lv4GoOpsStatus {
    requireCondition(!this.closed, "fixture-ops-closed", 409);
    return this.ops.status();
  }

  async handleLine(line: string): Promise<Lv4GoOpsResponse> {
    let id: string | null = null;
    try {
      requireCondition(
        typeof line === "string" &&
          Buffer.byteLength(line, "utf8") <= LV4_GO_OPS_MAX_LINE_BYTES,
        "line-too-large",
        413,
      );
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new SyncError("invalid-json");
      }
      id = responseId(value);
      return await this.execute(parseCommand(value));
    } catch (error) {
      return { id, ok: false, error: safeErrorCode(error) };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.ops.close();
    } catch (error) {
      this.closed = false;
      throw error;
    }
  }

  private async execute(
    command: Lv4GoOpsCommand,
  ): Promise<Lv4GoOpsResponse> {
    requireCondition(!this.closed, "fixture-ops-closed", 409);
    if (command.command === "status")
      return { id: command.id, ok: true, result: this.ops.status() };
    if (command.command === "register") {
      const result = await this.ops.register(command.clientId);
      return { id: command.id, ok: true, result };
    }
    await this.ops.revoke(command.clientId);
    return { id: command.id, ok: true, result: { clientId: command.clientId } };
  }
}

function requireLoopback(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SyncError("fixture-not-loopback");
  }
  requireCondition(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
    "fixture-not-loopback",
  );
}

function responseId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const candidate = (value as Record<string, unknown>).id;
  return typeof candidate === "string" && PROTOCOL_ID.test(candidate)
    ? candidate
    : null;
}

function exactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function parseCommand(value: unknown): Lv4GoOpsCommand {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected-object",
  );
  const input = value as Record<string, unknown>;
  const id = identifier(input.id);
  const command = input.command;
  if (command === "status") {
    requireCondition(
      exactFields(input, ["id", "command"]),
      "unexpected-fields",
    );
    return { id, command };
  }
  if (command === "register") {
    requireCondition(
      exactFields(input, ["id", "command", "clientId"]),
      "unexpected-fields",
    );
    return { id, command, clientId: identifier(input.clientId) };
  }
  if (command === "revoke") {
    requireCondition(
      exactFields(input, ["id", "command", "clientId"]),
      "unexpected-fields",
    );
    return { id, command, clientId: identifier(input.clientId) };
  }
  throw new SyncError("invalid-command");
}

function safeErrorCode(error: unknown): string {
  const allowed = new Set([
    "line-too-large", "invalid-json", "expected-object", "unexpected-fields",
    "invalid-identifier", "invalid-command", "fixture-ops-closed",
    "fixture-device-exists", "fixture-device-unavailable", "fixture-not-loopback",
    "fixture-ops-busy",
  ]);
  return error instanceof SyncError && allowed.has(error.code) ? error.code : "internal-error";
}
