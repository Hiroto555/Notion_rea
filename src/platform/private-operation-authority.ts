import {AsyncLocalStorage} from "node:async_hooks";
import {types} from "node:util";
const authority = new AsyncLocalStorage<() => void>();
function check(current: () => void): void {
  if (typeof current !== "function" || types.isAsyncFunction(current) || types.isGeneratorFunction(current))
    throw new Error("Synchronous private operation authority is required");
  const result: unknown = current();
  if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
  if (result !== undefined) throw new Error("Private operation authority must return synchronous void");
}
export function assertPrivateOperationAuthority(): void {
  const current = authority.getStore(); if (current) check(current);
}
/** Carries the originating request fence across pickers/awaits. Native
 * mutation phases invoke it again; unrelated startup scopes inherit none. */
export function withPrivateOperationAuthority<T>(current: () => void, work: () => T): T {
  check(current); return authority.run(current, work);
}
