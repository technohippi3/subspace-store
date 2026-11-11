import type { Effect } from "effect";
import type { ApplicationError, Destination } from "../application/records.ts";
import type { RefundPolicy } from "./policy.ts";

export interface RefundAccount { order: string; destination: Destination | null; ceiling: number | null }
export interface Coin { outpoint: string; script: string; sats: number; owner: "order" | "merchant" }
export interface RefundOutput extends Destination { sats: number; role: "buyer" | "order_change" | "merchant_change" }
export interface PreparedRefund {
  txid: string; raw: string; vbytes: number; inputs: Coin[]; outputs: RefundOutput[];
  fee: number; buyerFee: number; merchantFee: number; toBuyer: number;
}
export interface RefundGroup {
  id: string; order: string; kind: "excess" | "cancellation"; cause: "buyer" | "merchant";
  charged: number; createdAt: number; rate: number; policy: RefundPolicy;
  phase: "reserved" | "built" | "void"; transaction: PreparedRefund | null;
}
export interface FundingClaim { outpoint: string; script: string; sats: number }
export interface BuildRequest {
  group: RefundGroup; destination: Destination;
  orderCoins: readonly FundingClaim[]; merchantScripts: readonly string[];
  forbiddenInputs: readonly string[]; forbiddenScripts: readonly string[];
}
export interface RefundAdapters {
  readonly resolveAddress: (address: string) => Effect.Effect<Destination, ApplicationError>;
  readonly estimateRate: (target: number) => Effect.Effect<number | null, ApplicationError>;
  readonly build: (request: BuildRequest) => Effect.Effect<PreparedRefund, ApplicationError>;
}
