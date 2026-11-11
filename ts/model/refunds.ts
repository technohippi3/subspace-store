// Independent pilot refund policy. No wallet/RPC calls or production imports.
export interface FeePolicy {
  minimumRate: number; maximumRate: number; fallbackRate: number | null;
  buyerFeeCeiling: number;
}
export interface RefundPlan {
  fee: number; buyerFee: number; merchantFee: number; toBuyer: number;
  chargedToOrder: number;
}
function whole(n: number, minimum = 0): void {
  if (!Number.isSafeInteger(n) || n < minimum) throw Error("invalid whole amount");
}
export function refundPlan(amount: number, vbytes: number, estimate: number | null,
                           merchantCaused: boolean, policy: FeePolicy): RefundPlan {
  whole(amount, 1); whole(vbytes, 1);
  whole(policy.minimumRate, 1); whole(policy.maximumRate, policy.minimumRate);
  whole(policy.buyerFeeCeiling);
  const rate = estimate ?? policy.fallbackRate;
  if (rate === null) throw Error("no fee estimate or configured fallback");
  whole(rate, 1);
  if (rate > policy.maximumRate) throw Error("fee rate exceeds operator limit");
  const fee = Number((BigInt(vbytes) * BigInt(Math.max(policy.minimumRate, rate)) + 999n) / 1000n);
  whole(fee, 1);
  const buyerFee = merchantCaused ? 0 : Math.min(fee, policy.buyerFeeCeiling);
  if (amount <= buyerFee) throw Error("no positive refund output");
  return { fee, buyerFee, merchantFee: fee - buyerFee, toBuyer: amount - buyerFee,
    chargedToOrder: amount };
}
export function excessRefundable(amount: number, fee: number): boolean {
  whole(amount); whole(fee);
  return amount >= fee + 546;
}
export interface RefundClock {
  dueAt: number | null; broadcastAt: number | null; incident: boolean;
}
export function refundClock(state: RefundClock, now: number, eligible: boolean,
                            settled: boolean, destinationKnown: boolean,
                            broadcast = false): RefundClock {
  whole(now);
  const dueAt = state.dueAt ?? (eligible && settled && destinationKnown ? now : null);
  if (broadcast && (dueAt === null || !eligible || !settled || !destinationKnown))
    throw Error("refund is not currently eligible");
  const broadcastAt = state.broadcastAt ?? (broadcast ? now : null);
  // Missing the target is an incident even if a delayed broadcast now occurs.
  const late = dueAt !== null && (broadcastAt ?? now) > dueAt + 86400;
  return { dueAt, broadcastAt, incident: state.incident || late };
}
export interface Coin { id: string; sats: number; owner: string | null; spent: boolean }
export function fundRefund(order: string, credit: number, merchantBudget: number,
                           plan: RefundPlan, coins: readonly Coin[]): string[] {
  whole(credit); whole(merchantBudget);
  if (credit < plan.chargedToOrder || merchantBudget < plan.merchantFee)
    throw Error("insufficient order credit or merchant fee budget");
  const selected: string[] = [];
  let total = 0;
  for (const coin of [...coins].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    whole(coin.sats, 1);
    if (coin.spent || (coin.owner !== order && coin.owner !== null)) continue;
    if (selected.includes(coin.id)) throw Error("duplicate input");
    selected.push(coin.id);
    total += coin.sats;
    if (total >= plan.toBuyer + plan.fee) return selected;
  }
  throw Error("insufficient unspent funding");
}
