import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type { StorageOverview } from "../shared/storage-overview";

/** Only a manual refresh starts a worker; simultaneous requests share that read. */
export function makeStorageOverviewReader(
  databasePath: string,
  workerPath = join(__dirname, "storage-overview-worker.cjs"),
) {
  let pending: Promise<StorageOverview> | undefined;
  return (): Promise<StorageOverview> => {
    if (pending) return pending;
    pending = new Promise<StorageOverview>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: databasePath });
      const fail = () =>
        reject(new Error("使用量を取得できませんでした。再計測してください。"));
      const timeout = setTimeout(() => {
        void worker.terminate();
        fail();
      }, 30_000);
      let result: StorageOverview | undefined;
      worker.once("message", (value) => {
        result = value;
      });
      worker.once("error", () => {
        clearTimeout(timeout);
        fail();
      });
      worker.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0 && result) resolve(result);
        else fail();
      });
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
