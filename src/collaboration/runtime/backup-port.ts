import type { Cut } from "./contract";
export type BackupDownload = { raw: string; head: Cut; hash: string };
export type BackupExportResult =
  | { state: "EXPORTED"; path: string; head: Cut; hash: string }
  | { state: "CANCELLED" }
  | { state: "UNKNOWN"; path: string; head: Cut; hash: string };
