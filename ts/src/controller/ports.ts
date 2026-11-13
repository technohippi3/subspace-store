import type { Effect } from "effect";
import type { ControllerError } from "./errors.ts";
import type { Batch } from "./records.ts";

export type Result<A> = Effect.Effect<A, ControllerError>;
export interface EntryReceipt {
  readonly found: true; readonly entry: string; readonly root: string; readonly oids: readonly string[];
  readonly phase: "open" | "closed" | "armed"; readonly delegate: string | null;
  readonly acknowledged: boolean; readonly batchable: boolean;
}
export type Lookup = EntryReceipt | { readonly found: false };
export interface ArmReceipt extends EntryReceipt { readonly granted: boolean }
export interface RegistryPort {
  /** Observe once, then check every current member using the requested status. */
  readonly failing: (batch: Batch, issuing: boolean) => Result<readonly string[]>;
  readonly lookup: (batch: Batch) => Result<Lookup>;
  readonly enter: (batch: Batch) => Result<EntryReceipt>;
  readonly arm: (batch: Batch) => Result<ArmReceipt>;
}
export interface BroadcastAnswer { readonly body: string; readonly status: number }
export interface CapturedTransaction {
  readonly txid: string; readonly raw: string; readonly ancestors: readonly (readonly [string, string])[];
}
/** Native/chain adapters must bind captured bytes and ancestors to their txids.
 * This slice composes those ports; it provides no wallet or native RPC setup. */
export interface ControllerPorts {
  readonly registry: RegistryPort;
  readonly delegate: (space: string) => Result<string>;
  readonly broadcast: (space: string, feeRate: number) => Result<BroadcastAnswer>;
  readonly capture: (batch: Batch) => Result<CapturedTransaction | null>;
}
