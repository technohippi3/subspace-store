import { excessRefundable, fee, policy, split } from "./policy.ts";
import type { PreparedRefund, RefundAccount, RefundGroup } from "./types.ts";

function fields(value: unknown, names: string): asserts value is { [key: string]: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== names.split(",").sort().join()) throw Error("invalid refund record fields");
}
function whole(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw Error("invalid refund amount");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 256) throw Error("invalid refund text");
}
function address(value: unknown): void {
  fields(value, "address,script"); text(value.address);
  if (typeof value.script !== "string" || !/^(?:[0-9a-f]{2}){1,10000}$/.test(value.script)) throw Error("invalid refund script");
}
export function account(value: unknown): asserts value is RefundAccount {
  fields(value, "order,destination,ceiling"); text(value.order);
  if (value.destination !== null) address(value.destination);
  if (value.ceiling !== null) whole(value.ceiling);
}
export function prepared(value: unknown): asserts value is PreparedRefund {
  fields(value, "txid,raw,vbytes,inputs,outputs,fee,buyerFee,merchantFee,toBuyer");
  if (typeof value.txid !== "string" || !/^[0-9a-f]{64}$/.test(value.txid) ||
      typeof value.raw !== "string" || !/^(?:[0-9a-f]{2})+$/.test(value.raw) || value.raw.length > 800_000)
    throw Error("invalid signed refund transaction");
  whole(value.vbytes, 1);
  for (const key of ["fee", "buyerFee", "merchantFee", "toBuyer"]) whole(value[key]);
  if ((value.fee as number) !== (value.buyerFee as number) + (value.merchantFee as number)) throw Error("invalid fee split");
  if (!Array.isArray(value.inputs) || !value.inputs.length || !Array.isArray(value.outputs) || !value.outputs.length)
    throw Error("invalid refund inputs or outputs");
  const seen = new Set<string>(); let inputTotal = 0, outputTotal = 0;
  for (const input of value.inputs) {
    fields(input, "outpoint,script,sats,owner"); text(input.outpoint); whole(input.sats, 1);
    address({ address: "input", script: input.script });
    if (!/^[0-9a-f]{64}:[0-9]+$/.test(input.outpoint) || seen.has(input.outpoint) ||
        !["order", "merchant"].includes(String(input.owner))) throw Error("invalid refund input identity");
    const index = input.outpoint.split(":")[1]!;
    if (!Number.isSafeInteger(Number(index)) || Number(index) > 0xffff_ffff || String(Number(index)) !== index)
      throw Error("invalid refund output index");
    seen.add(input.outpoint); inputTotal += input.sats;
  }
  const roles = new Set<string>(), scripts = new Set<string>();
  for (const output of value.outputs) {
    fields(output, "address,script,sats,role"); address({ address: output.address, script: output.script }); whole(output.sats, 546);
    if (!["buyer", "order_change", "merchant_change"].includes(String(output.role)) ||
        roles.has(String(output.role)) || scripts.has(output.script as string)) throw Error("duplicate refund output");
    roles.add(String(output.role)); scripts.add(output.script as string); outputTotal += output.sats;
    if (output.role === "buyer" && output.sats !== value.toBuyer) throw Error("wrong buyer amount");
  }
  if (!roles.has("buyer") || inputTotal - outputTotal !== value.fee) throw Error("refund does not conserve value");
  if (!Number.isSafeInteger(inputTotal) || inputTotal > 2_100_000_000_000_000) throw Error("refund exceeds money supply");
}
export function group(value: unknown): asserts value is RefundGroup {
  fields(value, "id,order,kind,cause,charged,createdAt,rate,policy,phase,transaction"); text(value.id); text(value.order);
  if (!/^g-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.id) || !["excess", "cancellation"].includes(String(value.kind)) ||
      !["buyer", "merchant"].includes(String(value.cause)) || !["reserved", "built", "void"].includes(String(value.phase)))
    throw Error("invalid refund group");
  whole(value.charged, 1); whole(value.createdAt); whole(value.rate, 1); policy(value.policy);
  if (value.transaction !== null) {
    prepared(value.transaction);
    if (value.phase !== "built" || value.transaction.toBuyer + value.transaction.buyerFee !== value.charged)
      throw Error("invalid refund reservation charge");
    const tx = value.transaction, p = value.policy;
    const expected = split(value.charged, tx.fee, p.buyerFeeCeiling, value.cause === "merchant");
    if (tx.fee !== fee(tx.vbytes, value.rate) || tx.fee > p.maximumFee || value.charged > p.maximumRefund ||
        tx.buyerFee !== expected.buyerFee || tx.merchantFee !== expected.merchantFee ||
        (value.kind === "excess" && !excessRefundable(value.charged, tx.fee)))
      throw Error("refund exceeds its policy");
    for (const owner of ["order", "merchant"] as const) {
      const inputs = tx.inputs.filter(i => i.owner === owner).reduce((sum, i) => sum + i.sats, 0);
      const change = tx.outputs.find(o => o.role === `${owner}_change`)?.sats ?? 0;
      if (inputs - change !== (owner === "order" ? value.charged : tx.merchantFee))
        throw Error("refund changes funding ownership");
    }
  } else if (value.phase === "built") throw Error("built refund has no transaction");
  if (value.rate < value.policy.minimumRate || value.rate > value.policy.maximumRate || value.charged > value.policy.maximumRefund)
    throw Error("reservation exceeds refund policy");
}
