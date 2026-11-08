import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { allocateMacSandbox, assertMacExecution } from "../policy/guard.mjs";

// PreparatIon only. This module never launches Electron or Playwright, never
// exposes a CLI, and never reads an injected host identity. The live guard is
// called before any sandbox allocation, and the imported allocator re-checks it.

const REQUIRED_CASES = Object.freeze(["MAC-H1"]);
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const BLOCKED_ENV_KEYS = new Set([
  "FOLIO_DEV_URL",
  "FOLIO_TEST_FORCE_READY_FAILURE",
  "FOLIO_EMPTY_WORKSPACE",
  "PWDEBUG",
  "PWTEST_WATCH",
  "FOLIO_LOCAL_GUI_BATCH",
  "FOLIO_LOCAL_GUI_DATA_ROOT",
  "FOLIO_LINUX_GUI_CI",
  "FOLIO_GUI_CI_DATA_ROOT",
  "FOLIO_GUI_CI_KEYRING",
]);

const ownedByCurrentUser = (stat) =>
  typeof process.getuid === "function" && stat.uid === process.getuid();

export function assertRemoteH1Selection(plan) {
  const caseIds = plan?.caseIds;
  if (
    !Array.isArray(caseIds) ||
    caseIds.length !== REQUIRED_CASES.length ||
    caseIds[0] !== REQUIRED_CASES[0]
  )
    throw new Error("Remote H1 preflight requires caseIds exactly ['MAC-H1']");
  return plan;
}

export function canonicalWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot))
    throw new Error("workspaceRoot must be an absolute path");
  const canonical = realpathSync(workspaceRoot);
  if (!isAbsolute(canonical) || !lstatSync(canonical).isDirectory())
    throw new Error("workspaceRoot must resolve to an absolute directory");
  return canonical;
}

export function validateRemoteH1Artifact(workspaceRoot, expectedSha256) {
  if (
    typeof expectedSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  )
    throw new Error("Remote H1 artifact provenance is not a sha256 value");

  const root = canonicalWorkspaceRoot(workspaceRoot);
  const artifactPath = join(root, "dist", "main.cjs");
  let linkStat;
  try {
    linkStat = lstatSync(artifactPath);
  } catch {
    throw new Error("Remote H1 artifact build is missing: dist/main.cjs");
  }
  if (
    !linkStat.isFile() ||
    linkStat.isSymbolicLink() ||
    linkStat.nlink !== 1 ||
    !ownedByCurrentUser(linkStat)
  )
    throw new Error(
      "Remote H1 artifact must be an owned, non-linked regular file",
    );
  if (realpathSync(artifactPath) !== artifactPath)
    throw new Error("Remote H1 artifact path is not canonical");

  let fd;
  try {
    fd = openSync(
      artifactPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new Error("Remote H1 artifact could not be opened without links");
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !ownedByCurrentUser(before))
      throw new Error(
        "Remote H1 artifact must be an owned, non-linked regular file",
      );
    if (before.size > MAX_ARTIFACT_BYTES)
      throw new Error("Remote H1 artifact exceeds the bounded size limit");

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > MAX_ARTIFACT_BYTES)
        throw new Error("Remote H1 artifact exceeds the bounded size limit");
      hash.update(buffer.subarray(0, read));
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      bytes !== after.size
    )
      throw new Error("Remote H1 artifact changed while reading");

    const actual = hash.digest("hex");
    if (actual !== expectedSha256)
      throw new Error("Remote H1 artifact hash does not match plan provenance");
    return { artifactPath, sha256: actual };
  } finally {
    closeSync(fd);
  }
}

export function remoteH1Environment(env, sandbox) {
  if (
    !sandbox ||
    typeof sandbox.data !== "string" ||
    typeof sandbox.vault !== "string"
  )
    throw new Error("Remote H1 isolated sandbox is incomplete");

  const child = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    if (key.startsWith("FOLIO_SYNC_") || BLOCKED_ENV_KEYS.has(key)) continue;
    child[key] = value;
  }
  child.FOLIO_DATA_DIR = sandbox.data;
  child.FOLIO_CREDENTIAL_DIR = sandbox.vault;
  return child;
}

export function prepareRemoteH1(
  planInput,
  { env = process.env, workspaceRoot = process.cwd() } = {},
) {
  const plan = assertMacExecution(planInput, env);
  assertRemoteH1Selection(plan);
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const { artifactPath } = validateRemoteH1Artifact(
    root,
    plan.provenance.artifactSha256,
  );

  // allocateMacSandbox performs the live guard again before creating any
  // directory. Nothing above allocates a data/vault/evidence area.
  const sandbox = allocateMacSandbox(plan, env);
  const electronEnv = remoteH1Environment(env, sandbox);

  return {
    plan,
    sandbox,
    artifactPath,
    electron: { args: [artifactPath], env: electronEnv },
  };
}
