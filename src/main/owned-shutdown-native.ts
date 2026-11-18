import { WindowsRuntimePlatform } from "../platform/windows/runtime-platform";

export type ShutdownNativeDirectoryIdentity = Readonly<{canonicalPath: string; fileId: string; volumeId: string}>;
/** Actual native proof of the product data directory; proving the separate
 * monitor directory is insufficient. Configuration comes from installation,
 * not a request body. Construction never starts a GUI or opens a database. */
export function shutdownNativeDirectoryProof(env: NodeJS.ProcessEnv): ((path: string) => ShutdownNativeDirectoryIdentity) | undefined {
  if (process.platform !== "win32") return undefined;
  const probeExecutable = env.FOLIO_WINDOWS_NATIVE_PROBE, expectedHash = env.FOLIO_WINDOWS_NATIVE_SHA256;
  if (!probeExecutable || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) return undefined;
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  return path => {
    const native = new WindowsRuntimePlatform({root: path, probeExecutable, expectedHash, systemRoot});
    let failure: unknown;
    try {
      native.bind(path); native.assertRoot();
      const id = native.validatedDirectoryIdentity();
      return Object.freeze({canonicalPath: id.canonicalPath, fileId: id.directoryFileId, volumeId: id.directoryVolumeId});
    } catch (error) {failure = error; throw error;}
    finally {
      try {native.close();}
      catch (cleanup) {
        if (failure !== undefined) throw new AggregateError([failure, cleanup], "Native shutdown proof and cleanup failed");
        throw cleanup;
      }
    }
  };
}
