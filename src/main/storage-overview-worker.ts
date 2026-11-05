import { parentPort, workerData } from "node:worker_threads";
import { readWorkspaceOverview } from "../persistence/workspace-overview";

if (!parentPort || typeof workerData !== "string")
  throw new Error("Invalid workspace report request");
parentPort.postMessage(readWorkspaceOverview(workerData));
