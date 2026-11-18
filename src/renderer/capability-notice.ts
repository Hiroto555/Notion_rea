import type { DesktopCapabilities } from "../shared/desktop-capabilities";

/** Display-only capability notices. These strings never infer availability,
 * authorization, readiness or success from a binding, never gate an
 * operation and never expose the internal enum or level names. The actual
 * authorization and execution conditions stay with the caller's own busy/UI
 * state and the main-process checks. */

/** Short notice for the original-JSON file export. Three states are kept
 * distinct: the capability information itself is unobtainable, the export
 * feature is reported unconnected, or the feature is reported bound — in
 * which case the notice still only says its conditions are confirmed at
 * operation time. A bound binding is never read as available, authorized,
 * ready or successful. */
export function fileExportNotice(
  capabilities: DesktopCapabilities | null,
): string {
  if (capabilities === null) return "書き出し機能の情報を確認できません。";
  const row = capabilities.features.find(
    (feature) => feature.id === "fileExport",
  );
  if (row === undefined || row.binding !== "PROVIDED")
    return "書き出し画面の機能が未接続です。";
  return "書き出しの利用条件は操作時に確認してください。";
}

/** The raw salvage has no dedicated capability row, so no availability is
 * synthesized from other rows. The notice is a fixed guidance only. */
export function rawSalvageNotice(): string {
  return "救出の利用条件は操作時に確認してください。";
}
