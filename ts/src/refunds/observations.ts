import { claims, fail, whole, type Order, type State } from "../application/records.ts";
import { total } from "../application/sales.ts";
import type { RefundGroup, RefundObservation, RefundSend, RefundSnapshot } from "./types.ts";
import { allMembers, members, preferred, reservation } from "./families.ts";

function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("invalid refund observation hash");
}
export function observation(value: unknown): asserts value is RefundObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid refund observation");
  const v = value as RefundObservation;
  if (Object.keys(v).filter(k => k !== "chainInputsAvailable").sort().join() !== "blockHash,confirmations,conflicts,group,inputsAvailable,needsRebuild,seen,tip,tipHash,txid" ||
      typeof v.group !== "string" || !["absent", "mempool", "mined"].includes(v.seen) ||
      typeof v.inputsAvailable !== "boolean" || (v.chainInputsAvailable !== undefined && typeof v.chainInputsAvailable !== "boolean") ||
      typeof v.needsRebuild !== "boolean" || !Array.isArray(v.conflicts)) fail("invalid refund observation fields");
  hash(v.txid); hash(v.tipHash); whole(v.tip); whole(v.confirmations);
  if (v.blockHash !== null) hash(v.blockHash);
  if ((v.seen === "mined") !== (v.confirmations > 0) || (v.blockHash !== null) !== (v.seen === "mined") || v.confirmations > v.tip + 1)
    fail("invalid refund chain position");
  if (v.seen !== "absent" && (v.inputsAvailable || v.conflicts.length)) fail("live refund has conflicting input evidence");
  const ids = new Set<string>();
  for (const c of v.conflicts) {
    if (!c || Object.keys(c).sort().join() !== "confirmations,mempool,txid" || typeof c.mempool !== "boolean") fail("invalid refund conflict");
    hash(c.txid); whole(c.confirmations);
    if (c.txid === v.txid || ids.has(c.txid) || c.confirmations > v.tip + 1 || (c.confirmations > 0) === c.mempool) fail("invalid refund conflict position");
    ids.add(c.txid);
  }
}
export function sendRecord(value: unknown): asserts value is RefundSend {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid refund send record");
  const v = value as RefundSend;
  if (Object.keys(v).sort().join() !== "calls,firstIntentAt,group,lastIntentAt,result,txid" || typeof v.group !== "string" ||
      !["uncertain", "accepted"].includes(v.result)) fail("invalid refund send fields");
  hash(v.txid); whole(v.calls, 1); whole(v.firstIntentAt); whole(v.lastIntentAt);
  if (v.lastIntentAt < v.firstIntentAt) fail("refund intent time moved backwards");
}
export function applyObservations(state: State, snapshot: RefundSnapshot): void {
  whole(snapshot.tip); hash(snapshot.tipHash);
  if (!Array.isArray(snapshot.transactions)) fail("missing refund observations");
  const built = allMembers(state).filter(m => m.transaction), seen = new Set<string>();
  if (snapshot.transactions.length !== built.length) fail("incomplete refund observations");
  for (const facts of snapshot.transactions) {
    const m = built.find(m => m.transaction!.txid === facts.txid);
    if (!m || seen.has(facts.txid)) fail("foreign or duplicate refund observation"); seen.add(facts.txid);
    const peerIds = new Set(built.filter(p => p.group === m.group).map(p => p.transaction!.txid));
    const previous = state.refundObservations.find(o => o.txid === facts.txid);
    const value: RefundObservation = { ...structuredClone(facts), group: m.group, tip: snapshot.tip, tipHash: snapshot.tipHash,
      needsRebuild: !!previous?.needsRebuild || facts.conflicts.some(c => c.confirmations >= 6 && !peerIds.has(c.txid)) };
    observation(value);
    if (previous) Object.assign(previous, value); else state.refundObservations.push(value);
  }
  for (const g of state.groups) if (state.refundObservations.filter(o => o.group === g.id && o.confirmations > 0).length > 1)
    fail("multiple members of one refund mined on the same chain");
}
export function winner(state: State, g: RefundGroup) {
  return members(state, g).find(m => (state.refundObservations.find(o => o.txid === m.transaction?.txid)?.confirmations ?? 0) >= 6);
}
export function settled(state: State, g: RefundGroup): boolean {
  return !!winner(state, g);
}
export function refunded(state: State, order?: string): number {
  return state.groups.filter(g => !order || g.order === order).reduce((sum, g) => sum + (winner(state, g)?.charged ?? 0), 0);
}
export function balance(state: State, order: Order, except?: string) {
  const reserved = state.groups.filter(g => g.order === order.id && g.phase !== "void" && g.id !== except && !settled(state, g)).reduce((sum, g) => sum + reservation(state, g), 0);
  const price = claims(order) ? order.price! : 0, received = total(state, order, 6), paid = refunded(state, order.id);
  return { reserved, refunded: paid, price, settled: received, available: received - paid - reserved - price,
    exposure: Math.max(0, paid + reserved - Math.max(0, received - price)) };
}
export function sendable(state: State, g: RefundGroup, txid: string): boolean {
  const facts = state.refundObservations.find(o => o.txid === txid);
  if (state.refundPauses.some(p => p.group === g.id && p.active)) return false;
  if (!facts || facts.seen !== "absent" || facts.needsRebuild) return false;
  if (facts.inputsAvailable && !facts.conflicts.length) return true;
  const peers = new Set(members(state, g).flatMap(m => m.transaction ? [m.transaction.txid] : []));
  return facts.chainInputsAvailable === true && facts.conflicts.length > 0 && facts.conflicts.every(c => !c.confirmations && peers.has(c.txid));
}
export function refundStatus(state: State, g: RefundGroup, txid = preferred(state, g).transaction?.txid) {
  const facts = state.refundObservations.find(o => o.txid === txid), send = state.refundSends.find(s => s.txid === txid);
  return { status: settled(state, g) ? "settled" : facts?.needsRebuild ? "needs_rebuild" :
    facts?.seen === "mined" ? "confirming" : facts?.seen === "mempool" ? "mempool" : send ? "broadcast_unknown" : g.phase,
    confirmations: facts?.confirmations ?? 0, broadcast_intents: send?.calls ?? 0,
    broadcast_result: send?.result ?? null };
}
