import { type RuntimeStoreOptions, RuntimeStore } from "./store";

/**
 * Synchronous store seam for the shared runtime clients. The factory receives
 * the exact directory string and the same options reference the client was
 * given and must return one RuntimeStore it fully owns: never a store already
 * owned by another client, a closed store, or a store the factory closed
 * itself, and never wrapped with extra close, ownership transfer, or async
 * cleanup. A throw before return leaves any acquired store with the factory;
 * a returned store is owned by the client, which closes that exact store once
 * if later initialization fails.
 */
export type ClientStoreFactory = (
  directory: string,
  options: RuntimeStoreOptions,
) => RuntimeStore;

export const defaultClientStoreFactory: ClientStoreFactory = (
  directory,
  options,
) => new RuntimeStore(directory, options);

/** Optional host dependencies appended after the store options argument. */
export type ClientStoreHostDeps = {
  createStore?: ClientStoreFactory;
};
