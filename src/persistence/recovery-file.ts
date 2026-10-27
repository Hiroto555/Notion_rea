import {
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { parseRecovery } from "../shared/recovery";
// Validate before opening any destination; a failed write leaves it unchanged.
export function writeRecoveryFile(path: string, content: string, checkDestination: () => void = () => {}) {
  parseRecovery(content);
  const temporary = path + ".folio-" + randomUUID() + ".tmp";
  try {
    checkDestination();
    writeFileSync(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (readFileSync(temporary, "utf8") !== content)
      throw new Error("退避ファイルの検証に失敗しました");
    checkDestination();
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
