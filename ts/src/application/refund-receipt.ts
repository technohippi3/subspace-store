import type { SalesStore } from "./store.ts";

type View = Awaited<import("effect").Effect.Success<ReturnType<SalesStore["inspectionRefund"]>>>;
/** Deliberately bounded operator receipt. Signed bytes and funding proofs stay local. */
export function refundReceipt(view: View) {
  return { gid: view.id, oid: view.order, kind: view.kind, cause: view.cause, phase: view.phase,
    acknowledged: view.acknowledged, txid: view.txid, refund_address: view.refund_address,
    charged_sats: view.selected_charge_sats, maximum_charge_sats: view.maximum_charge_sats,
    to_buyer_sats: view.to_buyer_sats, fee_sats: view.fee_sats,
    buyer_fee_sats: view.buyer_fee_sats, merchant_fee_sats: view.merchant_fee_sats,
    status: view.status, confirmations: view.confirmations, intent_acknowledged: view.intent_acknowledged,
    broadcast_intents: view.broadcast_intents, broadcast_result: view.broadcast_result };
}
