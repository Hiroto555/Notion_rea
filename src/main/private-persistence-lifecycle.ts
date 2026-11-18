import {types} from "node:util";
import {startupRetainsNativeLease} from "../persistence/startup-connection-owner";

/** Main owns the original failure before Electron serializes it. A retained
 * reader stops further requests and vetoes quit before any outer Store,
 * workspace owner or factory can be released. Ordinary operation errors do
 * not latch this gate. There is no automatic close/operation retry. */
export function createPrivatePersistenceLifecycle() {
  let held = false, failure: unknown;
  const observe = (error: unknown): void => {
    if (!held && startupRetainsNativeLease(error)) {held = true; failure = error;}
  };
  const assertUsable = (): void => {
    if (held) throw new Error("Native SQLite reader closure is unconfirmed; workspace resources remain held", {cause: failure});
  };
  const run = <T>(work: () => T): T => {
    assertUsable();
    try {
      const value = work();
      if (types.isPromise(value)) return Promise.prototype.then.call(value, undefined, (error: unknown) => {
        observe(error); throw error;
      }) as T;
      return value;
    } catch (error) {observe(error); throw error;}
  };
  return Object.freeze({run, observe, assertUsable, isUsable: () => !held, retainedFailure: () => held ? failure : undefined});
}
