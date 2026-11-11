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
  readonly sender?: RefundSender;
}
export interface RefundSend {
  group: string; txid: string; firstIntentAt: number; lastIntentAt: number;
  calls: number; result: "uncertain" | "accepted";
}
export interface RefundFacts {
  txid: string; seen: "absent" | "mempool" | "mined"; confirmations: number;
  blockHash: string | null; inputsAvailable: boolean;
  conflicts: { txid: string; confirmations: number; mempool: boolean }[];
}
export interface RefundObservation extends RefundFacts {
  group: string; tip: number; tipHash: string; needsRebuild: boolean;
}
export interface RefundSnapshot { tip: number; tipHash: string; transactions: RefundFacts[] }
export interface RefundSender {
  readonly observe: (transactions: readonly PreparedRefund[]) => Effect.Effect<RefundSnapshot, ApplicationError>;
  /** Evaluate permission after preflight, immediately before the send RPC. */
  readonly broadcast: (transaction: PreparedRefund, permission: Effect.Effect<boolean, ApplicationError>,
    expectedTip: Pick<RefundSnapshot, "tip" | "tipHash">) => Effect.Effect<void, ApplicationError>;
}
