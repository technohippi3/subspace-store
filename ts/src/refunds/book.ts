import { randomUUID } from "node:crypto";
import { claims, fail, type State, type RefundSettings } from "../application/records.ts";
import { rate } from "./policy.ts";
import { group as validateGroup } from "./records.ts";
import type { BuildRequest, PreparedRefund, RefundGroup } from "./types.ts";
import { balance } from "./observations.ts";

export function heldScripts(state: State): string[] {
  return [...state.orders.flatMap(o => o.destination ? [o.destination.script] : []),
    ...state.accounts.flatMap(a => a.destination ? [a.destination.script] : []),
    ...state.refunds.merchantDestinations.map(d => d.script),
    ...state.groups.flatMap(g => g.transaction?.outputs.filter(o => o.role !== "buyer").map(o => o.script) ?? [])];
}
export function configuration(settings: RefundSettings): RefundSettings {
  return { version: 1, policy: Object.fromEntries(Object.entries(settings.policy).sort(([a], [b]) => a.localeCompare(b))) as unknown as RefundSettings["policy"],
    merchantDestinations: settings.merchantDestinations.map(d => ({ address: d.address, script: d.script })).sort((a, b) => a.script.localeCompare(b.script)) };
}
export function available(state: State, id: string, except?: string): number {
  const order = state.orders.find(o => o.id === id) ?? fail("no such order", "not_found");
  return Math.max(0, balance(state, order, except).available);
}
export function reserve(state: State, id: string, kind: RefundGroup["kind"], cause: RefundGroup["cause"], estimate: number | null): RefundGroup {
  const order = state.orders.find(o => o.id === id) ?? fail("no such order", "not_found");
  const account = state.accounts.find(a => a.order === id)!;
  if (!["excess", "cancellation"].includes(kind) || !["buyer", "merchant"].includes(cause)) fail("invalid refund request", "invalid");
  // Unconverted excess needs full outgoing-spend accounting before it can
  // safely coexist with a later payment/conversion. That path is not enabled.
  if (kind === "excess" ? !claims(order) : !["cancelled", "refund_due"].includes(order.status)) fail("refund is not eligible in this preparation path");
  if (!account.destination || account.ceiling === null) fail("refund destination or invoice is missing");
  const charged = available(state, id), policy = { ...state.refunds.policy, buyerFeeCeiling: account.ceiling };
  if (!charged || charged > policy.maximumRefund) fail("no refundable credit within the hot-wallet limit");
  const result: RefundGroup = { id: `g-${randomUUID()}`, order: id, kind, cause, charged,
    createdAt: state.settings.lastTime, rate: rate(estimate, policy), policy,
    phase: "reserved", transaction: null };
  validateGroup(result); state.groups.push(result); return result;
}
export function buildRequest(state: State, g: RefundGroup): BuildRequest {
  if (g.phase !== "reserved" || available(state, g.order, g.id) < g.charged) fail("refund credit is unavailable");
  const order = state.orders.find(o => o.id === g.order)!, account = state.accounts.find(a => a.order === g.order)!;
  if (!account.destination || (g.kind === "cancellation" && !["cancelled", "refund_due"].includes(order.status))) fail("refund is no longer eligible");
  const orderCoins = state.payments.filter(p => p.active && p.confirmations >= 6 && p.script === order.destination!.script)
    .map(p => ({ outpoint: p.outpoint, script: p.script, sats: p.sats }));
  const merchantScripts = state.refunds.merchantDestinations.map(d => d.script);
  for (const prior of state.groups) for (const [index, out] of (prior.transaction?.outputs ?? []).entries()) {
    if (out.role === "merchant_change") merchantScripts.push(out.script);
    if (prior.order === g.order && out.role === "order_change") orderCoins.push({ outpoint: `${prior.transaction!.txid}:${index}`, script: out.script, sats: out.sats });
  }
  return { group: structuredClone(g), destination: { ...account.destination }, orderCoins, merchantScripts,
    forbiddenInputs: state.groups.flatMap(prior => prior.transaction?.inputs.map(c => c.outpoint) ?? []), forbiddenScripts: heldScripts(state) };
}
export function recordBuilt(g: RefundGroup, request: BuildRequest, transaction: PreparedRefund): void {
  validateGroup({ ...g, phase: "built", transaction });
  const buyer = transaction.outputs.find(o => o.role === "buyer")!;
  if (buyer.address !== request.destination.address || buyer.script !== request.destination.script) fail("builder changed refund destination", "unavailable");
  for (const c of transaction.inputs) {
    const claim = request.orderCoins.find(x => x.outpoint === c.outpoint);
    if (request.forbiddenInputs.includes(c.outpoint) || (c.owner === "order" ?
      !claim || claim.script !== c.script || claim.sats !== c.sats : !request.merchantScripts.includes(c.script)))
      fail("builder changed funding ownership", "unavailable");
  }
  const change = transaction.outputs.filter(o => o.role !== "buyer");
  if (change.some(o => request.forbiddenScripts.includes(o.script))) fail("builder reused change script", "unavailable");
  g.phase = "built"; g.transaction = structuredClone(transaction);
}
export function summary(g: RefundGroup, acknowledged: boolean) {
  return { id: g.id, order: g.order, kind: g.kind, cause: g.cause, phase: g.phase, acknowledged,
    charged_sats: g.charged, txid: g.transaction?.txid ?? null, to_buyer_sats: g.transaction?.toBuyer ?? null,
    fee_sats: g.transaction?.fee ?? null, buyer_fee_sats: g.transaction?.buyerFee ?? null,
    merchant_fee_sats: g.transaction?.merchantFee ?? null };
}
