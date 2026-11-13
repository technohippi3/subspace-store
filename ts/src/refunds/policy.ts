// Production policy. The independent model in ts/model is not imported.
export interface RefundPolicy {
  minimumRate: number; maximumRate: number; fallbackRate: number | null;
  buyerFeeCeiling: number; confirmationTarget: number; maximumFee: number; maximumRefund: number;
}
function whole(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw Error("invalid refund policy amount");
}
export function policy(value: unknown): asserts value is RefundPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !==
      "buyerFeeCeiling,confirmationTarget,fallbackRate,maximumFee,maximumRate,maximumRefund,minimumRate") throw Error("invalid refund policy");
  const p = value as RefundPolicy;
  whole(p.minimumRate, 1); whole(p.maximumRate, p.minimumRate); whole(p.buyerFeeCeiling);
  whole(p.confirmationTarget, 2); whole(p.maximumFee, 1); whole(p.maximumRefund, 1);
  if ([p.buyerFeeCeiling, p.maximumFee, p.maximumRefund].some(n => n > 2_100_000_000_000_000)) throw Error("refund policy exceeds money supply");
  if (p.confirmationTarget > 1008) throw Error("invalid fee confirmation target");
  if (p.fallbackRate !== null) { whole(p.fallbackRate, 1); if (p.fallbackRate > p.maximumRate) throw Error("fallback exceeds fee limit"); }
}
export function rate(estimate: number | null, p: RefundPolicy): number {
  policy(p);
  const value = estimate ?? p.fallbackRate;
  if (value === null) throw Error("no fee estimate or configured fallback");
  whole(value, 1);
  if (value > p.maximumRate) throw Error("fee rate exceeds operator limit");
  return Math.max(value, p.minimumRate);
}
export function fee(vbytes: number, feeRate: number): number {
  whole(vbytes, 1); whole(feeRate, 1);
  const result = Number((BigInt(vbytes) * BigInt(feeRate) + 999n) / 1000n);
  whole(result, 1); return result;
}
export function split(principal: number, networkFee: number, ceiling: number, merchant: boolean) {
  whole(principal, 1); whole(networkFee, 1); whole(ceiling);
  const buyerFee = merchant ? 0 : Math.min(networkFee, ceiling);
  if (principal <= buyerFee) throw Error("no positive refund output");
  return { fee: networkFee, buyerFee, merchantFee: networkFee - buyerFee,
    toBuyer: principal - buyerFee, chargedToOrder: principal };
}
export function excessRefundable(principal: number, networkFee: number): boolean {
  whole(principal); whole(networkFee); return principal >= networkFee + 546;
}
