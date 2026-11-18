// Renderer-side observation wiring: validates the preload-exposed config,
// installs the frozen read-only window port and tracks the fresh renderer
// instance id plus the per-enableRecovery queue epoch. Every setup failure —
// invalid/absent binding, missing crypto UUID, a refused global install —
// disables observation only; startup and saving continue unchanged.
import {
  CHECKPOINT_OBSERVATION_READ_SCHEMA,
  isCheckpointObservationBinding,
  type CheckpointObservationBinding,
  type CheckpointObservationRead,
} from "../shared/checkpoint-observation";
import type {RecoveryCheckpoint} from "./recovery-checkpoint";

type ObservationGlobal = typeof globalThis & {
  folioCheckpointObservationConfig?: unknown;
  folioCheckpointObservation?: Readonly<{read: () => CheckpointObservationRead}>;
};

type ObservationState = {
  rendererInstanceId: string;
  queueEpoch: number;
  binding: CheckpointObservationBinding;
  getQueue: () => RecoveryCheckpoint | null;
};

let bindingCache: CheckpointObservationBinding | null | undefined;
let state: ObservationState | null = null;
let unavailable = false;

function observationBinding(): CheckpointObservationBinding | null {
  if (bindingCache === undefined) {
    try {
      const candidate = (globalThis as ObservationGlobal).folioCheckpointObservationConfig;
      bindingCache = isCheckpointObservationBinding(candidate) ? candidate : null;
    } catch {
      bindingCache = null;
    }
  }
  return bindingCache;
}

/** Arms observation for this enableRecovery epoch and lazily installs the
 * frozen read-only port (window.folioCheckpointObservation with read only).
 * Returns the literal option to pass to the new queue, or undefined when the
 * gate is absent/invalid/unavailable. */
export function beginCheckpointObservation(
  getQueue: () => RecoveryCheckpoint | null,
): {testObservation: "v1"} | undefined {
  const binding = observationBinding();
  if (unavailable || !binding) return undefined;
  try {
    if (!state) {
      const cryptoObject = globalThis.crypto;
      if (!cryptoObject || typeof cryptoObject.randomUUID !== "function") {
        unavailable = true;
        return undefined;
      }
      const next: ObservationState = {
        rendererInstanceId: cryptoObject.randomUUID(),
        queueEpoch: 0,
        binding,
        getQueue,
      };
      const read = (): CheckpointObservationRead => {
        try {
          return JSON.parse(JSON.stringify({
            schema: CHECKPOINT_OBSERVATION_READ_SCHEMA,
            rendererInstanceId: next.rendererInstanceId,
            queueEpoch: next.queueEpoch,
            binding: next.binding,
            observation: next.getQueue()?.getTestObservation() ?? null,
          })) as CheckpointObservationRead;
        } catch {
          // Any getter/serialization failure is contained as unavailable
          // observation evidence with the same type shape; it never throws
          // into startup or the save path.
          return {
            schema: CHECKPOINT_OBSERVATION_READ_SCHEMA,
            rendererInstanceId: next.rendererInstanceId,
            queueEpoch: next.queueEpoch,
            binding: next.binding,
            observation: null,
          };
        }
      };
      // Non-writable, non-configurable install: later code cannot replace or
      // silently mutate the read port for this renderer instance.
      Object.defineProperty(globalThis, "folioCheckpointObservation", {
        value: Object.freeze({read}),
        writable: false,
        enumerable: false,
        configurable: false,
      });
      state = next;
    } else {
      state.getQueue = getQueue;
    }
    state.queueEpoch += 1;
    return {testObservation: "v1"};
  } catch {
    state = null;
    unavailable = true;
    return undefined;
  }
}
