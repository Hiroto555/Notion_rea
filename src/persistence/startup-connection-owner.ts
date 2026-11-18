import type {DatabaseSync} from "node:sqlite";
import type {NativePrivateSqliteLease} from "../platform/private-persistence";
import {sqliteOwnerRetainsPlatform} from "../sync/sqlite-connection-owner";

const unclosed = new WeakSet<object>();
const retained = new Set<Readonly<{connection?: DatabaseSync; owner?: object; lease: NativePrivateSqliteLease; error: Error}>>();
/** Bounded own-data walk shared by the conservative and positive queries.
 * Every descriptor read is an independent safe branch: a throwing trap or an
 * accessor marks uncertainty only and never aborts a sibling branch, so a
 * known brand stays discoverable and no getter is ever invoked. */
function scanRetained(error: unknown): {known: boolean; uncertain: boolean} {
  const queue: unknown[] = [error], seen = new Set<object>();
  let uncertain = false;
  while (queue.length) {
    const value = queue.pop();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    if (unclosed.has(value) || sqliteOwnerRetainsPlatform(value)) return {known: true, uncertain};
    if (seen.size >= 128) {uncertain = true; continue;} // uncertain ownership remains held
    seen.add(value);
    let errorsDesc: PropertyDescriptor | undefined;
    try {errorsDesc = Object.getOwnPropertyDescriptor(value, "errors");}
    catch {uncertain = true; errorsDesc = undefined;}
    if (errorsDesc !== undefined) {
      try {
        // An accessor errors property is ignored exactly like the original
        // walk; only a data array's unknown entries are held evidence.
        if ("value" in errorsDesc && Array.isArray(errorsDesc.value)) {
          const length = Object.getOwnPropertyDescriptor(errorsDesc.value, "length")?.value;
          if (!Number.isSafeInteger(length) || length > 128) uncertain = true;
          else for (let index = 0; index < length; index++) {
            try {
              const entry = Object.getOwnPropertyDescriptor(errorsDesc.value, String(index));
              if (!entry) continue;
              if (!("value" in entry)) {uncertain = true; continue;} // unknown cause stays held
              queue.push(entry.value);
            } catch {uncertain = true;}
          }
        }
      } catch {uncertain = true;}
    }
    let cause: PropertyDescriptor | undefined;
    try {cause = Object.getOwnPropertyDescriptor(value, "cause");}
    catch {uncertain = true; cause = undefined;}
    if (cause !== undefined) {
      try {
        // An accessor cause is ignored without ever invoking its getter.
        if ("value" in cause) queue.push(cause.value);
      } catch {uncertain = true;}
    }
  }
  return {known: false, uncertain};
}
export function startupRetainsNativeLease(error: unknown): boolean {
  // Outer cleanup may add its own cause. Follow only own data properties;
  // neither a foreign accessor nor a cyclic error graph can bypass the bound,
  // and a throwing descriptor trap now holds rather than replacing the
  // original failure observed by the lifecycle.
  const scan = scanRetained(error);
  return scan.known || scan.uncertain;
}
/** Positive source-owned proof only: the exact retained-owner brand found on
 * the object or its own data cause/errors entries. Accessor, oversize, cyclic
 * or throwing-trap uncertainty is never positive and never aborts the walk, so
 * an unknown sibling cannot hide a known brand. No getter is ever invoked. */
export function startupHasRetainedNativeLease(error: unknown): boolean {
  return scanRetained(error).known;
}
/** A protector whose cleanup is uncertain stays owned even if opening SQLite
 * failed, or SQLite closed before its helper did. */
export function retainStartupProtector(lease: NativePrivateSqliteLease, failures: readonly unknown[],
  connection?: DatabaseSync, owner?: object): never {
  const failure = new AggregateError(failures, "Native SQLite protector close outcome unknown; owner retained");
  unclosed.add(failure);
  retained.add(Object.freeze({connection, owner, lease, error: failure}));
  throw failure;
}
export function assertStartupOwnerCapacity(lease?: NativePrivateSqliteLease): void {
  if (lease) assertNativeReaderOwnerCapacity();
}
export function assertNativeReaderOwnerCapacity(): void {
  if (retained.size >= 64) throw new Error("Native Store unresolved-initialization capacity reached");
}
/** One close attempt per owned connection. An inaccessible live connection
 * retains its native lease and original causes, including preflight handles. */
export function closeStartupConnection(connection: DatabaseSync, lease?: NativePrivateSqliteLease, primary?: Readonly<{error: unknown}>): void {
  const failures: unknown[] = primary ? [primary.error] : [];
  try {connection.close();} catch (cleanup) {failures.push(cleanup);}
  let closed = false;
  try {closed = connection.isOpen === false;} catch (proof) {failures.push(proof);}
  if (!closed) {
    const failure = new AggregateError(failures, "Startup SQLite close outcome unknown; retain native lease");
    if (lease) {
      Object.defineProperties(failure, {retainedNativeLease: {value: lease}, retainedConnection: {value: connection}});
      unclosed.add(failure); retained.add(Object.freeze({connection, lease, error: failure}));
    }
    throw failure;
  }
  if (failures.length > 1) throw new AggregateError(failures, "Startup operation and SQLite close failed");
  if (failures.length) throw failures[0];
}
