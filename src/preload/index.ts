import { contextBridge, ipcRenderer } from "electron";
import type { Request } from "../shared/types";
contextBridge.exposeInMainWorld("folio", {
  request: (request: Request) => ipcRenderer.invoke("folio:request", request),
});
