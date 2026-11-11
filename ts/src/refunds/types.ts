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
/** Public inputs and existing destination templates only. No coin selection or authorization. */
export interface RefundFeeTemplate {
  inputs: readonly FundingClaim[]; outputs: readonly Destination[]; rate: number;
}
export interface ExcessFeeRequest {
  inputs: readonly FundingClaim[]; destination: Destination; principal: number; ceiling: number; rate: number;
}
export interface FeeAssessment { vbytes: number; fee: number; tip: number; tipHash: string }
export interface BuildRequest {
  group: RefundGroup; destination: Destination;
  orderCoins: readonly FundingClaim[]; merchantScripts: readonly string[];
  forbiddenInputs: readonly string[]; forbiddenScripts: readonly string[];
  replacement?: Replacement;
  expectedTip?: { tip: number; tipHash: string };
}
export interface ExclusiveProof { earlier: string; input: string;
  via: { txid: string; raw: string; inputs: string[] } | null }
export interface Replacement { requiredInputs: Coin[]; members: PreparedRefund[]; proofs: ExclusiveProof[]; minimumFee: number }
export interface RefundAttempt {
  id: string; group: string; ordinal: number; parent: string; mode: "bump" | "rebuild";
  charged: number; createdAt: number; rate: number; policy: RefundPolicy;
  phase: "reserved" | "built" | "void"; transaction: PreparedRefund | null; replacement: Replacement;
}
export interface RebuildRequest {
  members: PreparedRefund[]; orderCoins: FundingClaim[]; forbiddenInputs: string[];
  conflicts: string[]; tip: number; tipHash: string;
}
export interface RebuildFunding { requiredInputs: Coin[]; proofs: ExclusiveProof[] }
export interface RefundPause { group: string; firstAt: number; lastAt: number; active: boolean }
export interface RefundAdapters {
  readonly resolveAddress: (address: string) => Effect.Effect<Destination, ApplicationError>;
  readonly estimateRate: (target: number) => Effect.Effect<number | null, ApplicationError>;
  readonly assessExcess?: (request: ExcessFeeRequest) => Effect.Effect<FeeAssessment, ApplicationError>;
  readonly build: (request: BuildRequest) => Effect.Effect<PreparedRefund, ApplicationError>;
  readonly rebuildFunding?: (request: RebuildRequest) => Effect.Effect<RebuildFunding, ApplicationError>;
  readonly sender?: RefundSender;
}
export interface RefundSend {
  group: string; txid: string; firstIntentAt: number; lastIntentAt: number;
  calls: number; result: "uncertain" | "accepted";
}
export interface RefundFacts {
  txid: string; seen: "absent" | "mempool" | "mined"; confirmations: number;
  blockHash: string | null; inputsAvailable: boolean;
  chainInputsAvailable?: boolean;
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
    expectedTip: Pick<RefundSnapshot, "tip" | "tipHash">, replacement?: Replacement) => Effect.Effect<void, ApplicationError>;
}
