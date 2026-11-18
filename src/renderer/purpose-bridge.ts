import type { EditingPort, StructurePort } from "../shared/app-api";
import type { Request } from "../shared/types";
import { StorageFailureError, unclassifiedRequestFailure } from "./private-request";
import type { SaveTransport } from "./reliable-save";
import type { StructuralTransport } from "./structural-operation";

export type PurposeBridges = {
  readonly save: SaveTransport;
  readonly database: SaveTransport;
  readonly structural: StructuralTransport;
};

/** The transport-level bounded failure for a tag outside this bridge's
 * family. The actual received discriminant names the local E; nothing about
 * the operation is inspected and no port method is invoked. */
const refused = (request: Request): Promise<never> =>
  Promise.reject(
    new StorageFailureError(unclassifiedRequestFailure(request.type)),
  );

/** Synchronous tag → purpose map only. Each bridge admits exactly its own
 * family's canonical commit/resolve pair — a legitimate resolve is always
 * forwarded — and anything else invokes zero port methods. There is no await,
 * no fingerprint, no new timer and no pre-operation validation inside the
 * bridge: the returned promise is the port call itself, so the caller's
 * existing guard, retain and exchange timing is preserved exactly. */
export function saveBridge(editing: EditingPort): SaveTransport {
  return (request) =>
    request.type === "save:commit"
      ? editing.commitSave(request.operation)
      : request.type === "save:resolve"
        ? editing.resolveSave(request.operation)
        : refused(request);
}

export function databaseBridge(editing: EditingPort): SaveTransport {
  return (request) =>
    request.type === "database:commit"
      ? editing.commitDatabase(request.operation)
      : request.type === "database:resolve"
        ? editing.resolveDatabase(request.operation)
        : refused(request);
}

export function structuralBridge(structure: StructurePort): StructuralTransport {
  return (request) =>
    request.type === "migration:commit"
      ? structure.commitMigration(request.operation)
      : request.type === "migration:resolve"
        ? structure.resolveMigration(request.operation)
        : request.type === "property:commit"
          ? structure.commitProperty(request.operation)
          : request.type === "property:resolve"
            ? structure.resolveProperty(request.operation)
            : refused(request);
}

/** Build all three family bridges over one API surface. The bridges are
 * stateless views of the same ports; callers keep their own lifetime. */
export function createPurposeBridges(api: {
  readonly editing: EditingPort;
  readonly structure: StructurePort;
}): PurposeBridges {
  return {
    save: saveBridge(api.editing),
    database: databaseBridge(api.editing),
    structural: structuralBridge(api.structure),
  };
}
