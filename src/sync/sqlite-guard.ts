import { DatabaseSync } from "node:sqlite";

/** Retains diagnostic causes locally; HTTP callers receive only the stable code. */
export class SyncStorageUnavailable extends AggregateError {
  readonly code = "sync-storage-unavailable";
  readonly status = 503;
  constructor(errors: unknown[], detail: string) {
    super(
      errors,
      `sync-storage-unavailable: ${detail}; close and reopen required`,
    );
    this.name = "SyncStorageUnavailable";
  }
}

/** No SQL is exposed after an uncertain transaction-control outcome. */
export class SyncSqliteGuard {
  private failure: SyncStorageUnavailable | undefined;
  private ownsTransaction = false;
  private closed = false;

  constructor(private readonly connection: DatabaseSync) {
    try {
      this.assertUsable();
    } catch (error) {
      try {
        this.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "SQLite initialization and close failed",
        );
      }
      throw error;
    }
  }

  private poison(errors: unknown[], detail: string): never {
    this.failure ??= new SyncStorageUnavailable(errors, detail);
    throw this.failure;
  }

  private transactionFlag(): boolean {
    if (typeof this.connection.isOpen !== "boolean" || !this.connection.isOpen)
      throw new Error("SQLite open state is unavailable or closed");
    const active: unknown = this.connection.isTransaction;
    if (typeof active !== "boolean")
      throw new Error("SQLite transaction state is unavailable");
    return active;
  }

  assertUsable(): void {
    if (this.failure) throw this.failure;
    if (this.closed)
      this.poison([new Error("SQLite connection closed")], "connection closed");
    try {
      if (this.transactionFlag() !== this.ownsTransaction)
        throw new Error("SQLite transaction ownership is unknown");
    } catch (error) {
      this.poison([error], "connection state unknown");
    }
  }

  get db(): DatabaseSync {
    this.assertUsable();
    return this.connection;
  }

  transaction<T>(work: () => T): T {
    this.assertUsable();
    if (this.ownsTransaction)
      this.poison(
        [new Error("Nested transaction refused")],
        "transaction ownership violation",
      );
    try {
      this.connection.exec("BEGIN IMMEDIATE");
      if (!this.transactionFlag())
        throw new Error("BEGIN did not start a transaction");
      this.ownsTransaction = true;
    } catch (error) {
      this.poison([error], "BEGIN outcome unknown");
    }

    let value: T;
    try {
      value = work();
    } catch (error) {
      // If a guarded access already found an unknown state, retain that failure.
      if (this.failure) throw this.failure;
      try {
        if (!this.transactionFlag())
          throw new Error("Transaction ended before rollback");
        this.connection.exec("ROLLBACK");
        if (this.transactionFlag())
          throw new Error("ROLLBACK did not end the transaction");
        this.ownsTransaction = false;
      } catch (rollbackError) {
        this.poison([error, rollbackError], "operation and ROLLBACK failed");
      }
      throw error;
    }

    try {
      if (!this.transactionFlag())
        throw new Error("Transaction ended before commit");
      this.connection.exec("COMMIT");
      if (this.transactionFlag())
        throw new Error("COMMIT did not end the transaction");
      this.ownsTransaction = false;
    } catch (error) {
      // COMMIT may have completed before an exception was reported. Reopen and
      // inspect the durable receipt instead of advertising an uncertain result.
      this.poison([error], "COMMIT outcome unknown");
    }
    return value;
  }

  /** Cleanup remains callable on poisoned connections, including repeated calls. */
  close(): void {
    if (this.closed) return;
    try {
      if (this.connection.isOpen === false) {
        this.closed = true;
        return;
      }
    } catch {
      /* An unavailable state API must not prevent a close attempt. */
    }
    try {
      this.connection.close();
      this.closed = true;
    } catch (closeError) {
      try {
        const open: unknown = this.connection.isOpen;
        if (open === false) this.closed = true;
        else if (typeof open !== "boolean")
          throw new Error("SQLite close outcome unknown");
      } catch (stateError) {
        throw new AggregateError(
          [closeError, stateError],
          "SQLite close and state check failed",
        );
      }
      throw closeError;
    }
  }
}
