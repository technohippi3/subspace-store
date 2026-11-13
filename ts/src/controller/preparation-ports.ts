import type { OrderBinding, Result } from "./ports.ts";

/** Store and native transport facts, not proofs or boolean commit permission. */
export interface PreparationRegistry {
  readonly converted: () => Result<readonly string[]>;
  readonly inspect: (oid: string) => Result<OrderBinding>;
  readonly batchable: (oid: string) => Result<boolean>;
  readonly pending: (oids: readonly string[]) => Result<boolean>;
}
export interface PreparationNative {
  readonly pipeline: (space: string) => Result<unknown>;
  readonly page: (space: string, page: number, filter: "staged" | "committed") => Result<unknown>;
  readonly handle: (space: string, label: string) => Result<unknown>;
  readonly sync: () => Result<unknown>;
  readonly park: (space: string, labels: readonly string[], parked: boolean) => Result<unknown>;
  readonly commit: (space: string) => Result<unknown>;
}
export interface PreparationPorts {
  readonly registry: PreparationRegistry;
  readonly native: PreparationNative;
  /** A successful absence is null; RPC failure must fail the Effect. */
  readonly chainRoot: (space: string) => Result<string | null>;
}
