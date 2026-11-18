import { types } from "node:util";
import type { RuntimeStorePlatform } from "./runtime-store-platform";

type Result = "void" | "string" | "buffer" | "object";
export type SynchronousContract = Readonly<Record<string, Readonly<{ result: Result; optional?: boolean; cleanup?: boolean }>>>;
const facades = new WeakMap<object, Map<object, object>>();

/** A data/durability seam cannot use TypeScript's permissive void assignability
 * as proof of completion. A deferred result poisons further proof; cleanup is
 * separate and a failed asynchronous cleanup never becomes a later success. */
export function synchronousPort<T extends object>(provider: T, contract: SynchronousContract, metadata: object = {}): T {
  if (!provider || typeof provider !== "object") throw new Error("SYNCHRONOUS_PORT_REQUIRED");
  const cached = facades.get(provider)?.get(contract);
  if (cached) return cached as T;
  const methods = Object.entries(contract);
  let failure: Error | undefined;
  let cleanupFailure: Error | undefined;
  const completedCleanup = new Set<string>();
  const callable = (name: string, optional: boolean | undefined): Function | undefined => {
    const value = Reflect.get(provider, name);
    if (value === undefined && optional) return undefined;
    if (typeof value !== "function" || types.isAsyncFunction(value) || types.isGeneratorFunction(value))
      throw new Error("SYNCHRONOUS_PORT_UNSUPPORTED");
    return value;
  };
  for (const [name, rule] of methods) callable(name, rule.optional);
  const facade: Record<string, unknown> = { ...metadata };
  for (const [name, rule] of methods) {
    if (rule.optional && callable(name, true) === undefined) continue;
    facade[name] = (...args: unknown[]) => {
      if (rule.cleanup) {
        if (cleanupFailure) throw cleanupFailure;
        if (completedCleanup.has(name)) return;
      } else {
        if (failure) throw failure;
        for (const [key, required] of methods) callable(key, required.optional);
      }
      const method = callable(name, rule.optional)!;
      const result: unknown = Reflect.apply(method, provider, args);
      let valid: boolean;
      try {
      const thenable = result !== null && (typeof result === "object" || typeof result === "function") && typeof Reflect.get(result, "then") === "function";
      valid = !thenable && (rule.result === "void" ? result === undefined
        : rule.result === "string" ? typeof result === "string" && result.length > 0
        : rule.result === "buffer" ? Buffer.isBuffer(result)
        : result !== null && typeof result === "object" && !Array.isArray(result));
      } catch (cause) {
        failure ??= new Error(`UNKNOWN: synchronous capability ${name} result is unavailable`, {cause});
        if (rule.cleanup) cleanupFailure = failure;
        throw failure;
      }
      if (!valid) {
        if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
        failure ??= new Error(`UNKNOWN: synchronous capability ${name} did not complete`);
        if (rule.cleanup) cleanupFailure = failure;
        throw failure;
      }
      if (rule.cleanup) completedCleanup.add(name);
      return result;
    };
  }
  const result = Object.freeze(facade) as T;
  let entries = facades.get(provider);
  if (!entries) { entries = new Map(); facades.set(provider, entries); }
  entries.set(contract, result);
  facades.set(result, new Map([[contract, result]]));
  return result;
}

const RUNTIME: SynchronousContract = {
  bind: { result: "string" }, assertRoot: { result: "void" },
  assertDatabase: { result: "void" }, syncCreatedDatabase: { result: "void" },
  createExclusiveDurably: { result: "void", optional: true },
  assertEmptyFile: { result: "void", optional: true },
  withHotJournalSnapshot: {result: "void", optional: true},
  close: { result: "void", cleanup: true },
};
export function synchronousRuntimeStorePlatform(platform: RuntimeStorePlatform): RuntimeStorePlatform {
  return synchronousPort(platform, RUNTIME);
}
