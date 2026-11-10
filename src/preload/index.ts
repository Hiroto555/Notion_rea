import {createSharedRuntimeBridge} from "./shared-runtime-queue";
import { contextBridge, ipcRenderer } from "electron";
import type {SharedRuntimeRequest} from "../shared/shared-runtime-ipc";
import type { Request } from "../shared/types";
contextBridge.exposeInMainWorld("folio", {
  shared:createSharedRuntimeBridge((input)=>ipcRenderer.invoke("folio:shared",input)),
  request: (request: Request) => ipcRenderer.invoke("folio:request", request),
});
