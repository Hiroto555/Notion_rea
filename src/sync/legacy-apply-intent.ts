import { lstatSync } from "node:fs";
import { join } from "node:path";
/** Existence or an uninspectable legacy name is never fresh consent. */
export function legacyApplyIntentPresent(directory: string): boolean {
  try {lstatSync(join(directory,".folio-sync-apply-intent"));return true;}
  catch (error) {return (error as NodeJS.ErrnoException).code !== "ENOENT";}
}
