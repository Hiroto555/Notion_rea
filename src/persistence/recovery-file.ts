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
import { privatePersistencePort, type PrivatePersistenceOptions } from "../platform/private-persistence";
import { dirname } from "node:path";
import { parseRecovery } from "../shared/recovery";
// Validate before opening any destination; a failed write leaves it unchanged.
export function writeRecoveryFile(path: string, content: string, checkDestination: () => void = () => {},
  options?: PrivatePersistenceOptions) {
  parseRecovery(content);
  const native = privatePersistencePort(options);
  if (native) {
    checkDestination();
    // Fresh publication only. Existing originals are never overwritten, even
    // when a chooser previously approved the destination.
    native.writeNew(path, Buffer.from(content), 32 * 1024 * 1024 + 4096);
    checkDestination();
    return;
  }
  const temporary = path + ".folio-" + randomUUID() + ".tmp";
  let owned = false;
  try {
    checkDestination();
    const fd = openSync(temporary, "wx", 0o600);
    owned = true;
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (readFileSync(temporary, "utf8") !== content)
      throw new Error("退避ファイルの検証に失敗しました");
    checkDestination();
    renameSync(temporary, path);
    owned = false;
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (owned) {
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
}
