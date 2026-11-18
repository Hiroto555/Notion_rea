import {createSharedRuntimeBridge} from "./shared-runtime-queue";
import {createPrivateRequestPreload} from "./private-request";
import {checkpointObservationConfigFromEnv} from "../shared/checkpoint-observation";
import { contextBridge, ipcRenderer } from "electron";
import type {SharedRuntimeRequest} from "../shared/shared-runtime-ipc";
import type { Request } from "../shared/types";
contextBridge.exposeInMainWorld("folio", {
  shared:createSharedRuntimeBridge((input)=>ipcRenderer.invoke("folio:shared",input)),
  request: (request: Request) => ipcRenderer.invoke("folio:request", request),
  ...createPrivateRequestPreload((request)=>ipcRenderer.invoke("folio:request:diagnostic-v1", request)),
});
// Observation config is exposed under a separate name only when both exact
// opt-ins and a bounded binding matching the declared data/credential dirs
// parse cleanly; absent or malformed input disables observation only.
try {
  const observationConfig = checkpointObservationConfigFromEnv(process.env);
  if (observationConfig) contextBridge.exposeInMainWorld("folioCheckpointObservationConfig", observationConfig);
} catch {
  // Observation stays unavailable; startup and saving are unaffected.
}
