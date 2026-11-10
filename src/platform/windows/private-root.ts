import {
  CollaborationError,
  wellFormed,
} from "../../collaboration/runtime/contract";
import {
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeExpectation,
} from "./path-policy";

export const WINDOWS_PROBE_PLATFORM = "win32" as const;
export const WINDOWS_PROBE_SCRIPT_NAME = "probe-private-root.ps1";
export const WINDOWS_PROBE_SYSTEM_ROOT = "C:\\Windows";
export const WINDOWS_PROBE_TIMEOUT_MS = 15_000;
export const WINDOWS_PROBE_MAX_OUTPUT_BYTES = 16_384;
export const WINDOWS_PROBE_TRUST_BOUNDARY =
  "Injected probe results are an untrusted contract check, not proof of Windows filesystem safety.";

export type WindowsProbe = (
  canonicalPath: string,
  canonicalRoot: string,
) => Promise<unknown>;
export type WindowsPrivateRootResult = Readonly<{
  canonical: string;
  relative: string;
}>;
export type WindowsPowerShellCommand = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
}>;
export type WindowsProbeCommandOptions = Readonly<{
  systemRoot: string;
  scriptPath: string;
}>;

const POWERSHELL_RELATIVE = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function fail(code: string): never {
  throw new CollaborationError(code);
}

function canonicalAbsolute(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    fail(code);
  const drive = /^[A-Za-z]:/.exec(value);
  if (!drive) fail(code);
  try {
    return validateWindowsPath(value, `${drive[0][0].toUpperCase()}:\\`)
      .canonical;
  } catch {
    fail(code);
  }
}

export class WindowsPrivateRoot {
  readonly #probe: WindowsProbe;

  constructor(probe: WindowsProbe) {
    if (typeof probe !== "function")
      throw new CollaborationError("PROBE_NOT_FUNCTION");
    this.#probe = probe;
  }

  async assert(path: string, root: string): Promise<WindowsPrivateRootResult> {
    const validated = validateWindowsPath(path, root);
    const canonicalRoot = validateWindowsPath(root, root).canonical;
    const expectation: WindowsProbeExpectation = Object.freeze({
      canonicalPath: validated.canonical,
      canonicalRoot,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probeResult: unknown;
    try {
      probeResult = await Promise.race([
        Promise.resolve().then(() =>
          this.#probe(expectation.canonicalPath, expectation.canonicalRoot),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CollaborationError("PROBE_TIMEOUT")),
            WINDOWS_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      assertWindowsProbe(probeResult, expectation);
    } catch (error) {
      if (error instanceof CollaborationError) throw error;
      throw new CollaborationError("PROBE_FAILED");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return Object.freeze({
      canonical: validated.canonical,
      relative: validated.relative,
    });
  }
}

export function windowsPowerShellCommand(
  path: string,
  root: string,
  options: WindowsProbeCommandOptions,
): WindowsPowerShellCommand {
  const target = validateWindowsPath(path, root);
  const base = validateWindowsPath(root, root);
  if (typeof options !== "object" || options === null)
    fail("PROBE_COMMAND_OPTIONS");
  const systemRoot = canonicalAbsolute(options.systemRoot, "PROBE_SYSTEM_ROOT");
  const scriptPath = canonicalAbsolute(options.scriptPath, "PROBE_SCRIPT_PATH");
  if (!/\\probe-private-root\.ps1$/i.test(scriptPath))
    fail("PROBE_SCRIPT_PATH");
  let powershell: string;
  try {
    powershell = validateWindowsPath(
      `${systemRoot}\\${POWERSHELL_RELATIVE}`,
      systemRoot,
    ).canonical;
  } catch {
    fail("PROBE_SYSTEM_ROOT");
  }
  return Object.freeze({
    command: powershell,
    cwd: systemRoot,
    args: Object.freeze([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      scriptPath,
      "-Path",
      target.canonical,
      "-Root",
      base.canonical,
    ]),
  });
}
