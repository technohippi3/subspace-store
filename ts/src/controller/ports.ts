import type { Effect } from "effect";
import type { ControllerError } from "./errors.ts";
import type { Batch } from "./records.ts";
import type { OrderStatus } from "../order.ts";

export type Result<A> = Effect.Effect<A, ControllerError>;
export interface EntryReceipt {
  readonly found: true; readonly entry: string; readonly root: string; readonly oids: readonly string[];
  readonly phase: "open" | "closed" | "armed"; readonly delegate: string | null;
  readonly acknowledged: boolean; readonly batchable: boolean;
}
export type Lookup = EntryReceipt | { readonly found: false };
export interface ArmReceipt extends EntryReceipt { readonly granted: boolean }
export interface OrderBinding { readonly oid: string; readonly name: string; readonly recipient_spk: string; readonly status: OrderStatus }
export interface RegistryPort {
  /** Observe once, then check every current member using the requested status. */
  readonly failing: (batch: Batch, issuing: boolean) => Result<readonly string[]>;
  readonly lookup: (batch: Batch) => Result<Lookup>;
  readonly enter: (batch: Batch) => Result<EntryReceipt>;
  readonly arm: (batch: Batch) => Result<ArmReceipt>;
  readonly close: (batch: Batch) => Result<EntryReceipt>;
  readonly order: (batch: Batch, oid: string) => Result<OrderBinding>;
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
  readonly height: () => Result<number>;
  readonly release?: ReleasePorts;
}
export interface NativeHandle {
  readonly script_pubkey: string; readonly commitment_root: string | null; readonly parked: boolean;
}
/** Trusted transport ports only. No process/wallet setup or implicit retries. */
export interface ReleasePorts {
  readonly handle: (space: string, label: string) => Result<NativeHandle>;
  readonly rollback: (space: string) => Result<void>;
  readonly park: (space: string, labels: readonly string[]) => Result<void>;
}
