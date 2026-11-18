import {DatabaseSync as SQLite, type DatabaseSync} from "node:sqlite";
import type {NativePrivateFilesystemPort} from "../platform/private-persistence";
import {assertNativeReaderOwnerCapacity, closeStartupConnection, retainStartupProtector, startupRetainsNativeLease} from "./startup-connection-owner";

/** Keep each additional native-protected SQLite reader under its own lease.
 * A hidden failed close must not release a protector merely because the
 * caller's primary Store connection closed successfully. */
export function withNativeSqliteReader<T>(path: string, native: NativePrivateFilesystemPort | undefined,
  work: (db: DatabaseSync) => T): T {
  let lease: import("../platform/private-persistence").NativePrivateSqliteLease | undefined;
  if (native) {
    if (!native.acquireSqliteLease) throw new Error("Native raw-reader lease is required");
    assertNativeReaderOwnerCapacity();
    lease = native.acquireSqliteLease(path, native.inspectFileIdentity(path));
  }
  let reader: DatabaseSync;
  try {lease?.assertHeld(); reader = new SQLite(path, {readOnly: true});}
  catch (error) {
    try {lease?.close();} catch (cleanup) {retainStartupProtector(lease!, [error, cleanup]);}
    throw error;
  }
  let value!: T, failure: unknown, failed = false;
  try {lease?.assertHeld(); value = work(reader); lease?.assertHeld();}
  catch (error) {failure = error; failed = true;}
  try {closeStartupConnection(reader, lease, failed ? {error: failure} : undefined);}
  catch (error) {
    if (startupRetainsNativeLease(error)) throw error;
    failure = error; failed = true;
  }
  try {lease?.close();} catch (cleanup) {
    retainStartupProtector(lease!, failed ? [failure, cleanup] : [cleanup], reader);
  }
  if (failed) throw failure;
  return value;
}

