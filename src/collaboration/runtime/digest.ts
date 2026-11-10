import { createHash } from "node:crypto";
import { canonical } from "./canonical";
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const derivedId = (...parts: string[]): string =>
  "s_" + digest(parts).slice(0, 60);
