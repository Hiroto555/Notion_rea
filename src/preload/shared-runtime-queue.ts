import type {
  SharedRuntimeAPI,
  SharedRuntimeRequest,
} from "../shared/shared-runtime-ipc";
/** Bounded FIFO across panels and IME drafts; a failed call never drops the next one. */
export function createSharedRuntimeBridge(
  invoke: (input: SharedRuntimeRequest) => Promise<unknown>,
): SharedRuntimeAPI {
  let tail: Promise<unknown> = Promise.resolve(),
    pending = 0;
  return {
    request<T>(input: SharedRuntimeRequest): Promise<T> {
      if (pending >= 64) return Promise.reject(new Error("SHARED_QUEUE_FULL"));
      const detached = structuredClone(input);
      pending++;
      const next = tail.then(() => invoke(detached));
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next.then(
        (value) => {
          pending--;
          return value as T;
        },
        (error) => {
          pending--;
          throw error;
        },
      );
    },
  };
}
