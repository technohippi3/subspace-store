// Production payment/hold rules. No reference-model imports or shared reducers.
import { claims, fail, MAX_MONEY, sats, whole, type Grant, type Order, type Snapshot, type State } from "./records.ts";

export function total(state: State, order: Order, depth: number): number {
  return state.payments.filter(p => p.active && p.script === order.destination?.script && p.confirmations >= depth)
    .reduce((sum, p) => sum + p.sats, 0);
}
export function active(state: State, order: Order): boolean {
  const hold = order.grants.at(-1);
  if (order.status !== "quoted" || !hold || hold.released) return false;
  if (hold.acquiredHeight !== null)
    return state.settings.tip <= hold.acquiredHeight + 6 || total(state, order, 1) >= order.price!;
  return state.settings.lastTime < hold.until || (hold.seenHeight !== null &&
    (state.settings.tip <= hold.seenHeight + 6 || total(state, order, 1) >= order.price!));
}
export function owner(state: State, handle: string): Order | undefined {
  return state.orders.find(o => o.handle === handle && (claims(o) || active(state, o)));
}
export function grant(state: State, order: Order, acquired = false): void {
  order.grants.push({ at: state.settings.lastTime, until: state.settings.lastTime + 900,
    seenHeight: null, acquiredHeight: acquired ? state.settings.tip : null, released: false, converted: false });
}
function convert(state: State, order: Order): void {
  if (!active(state, order) || total(state, order, 3) < order.price!) return;
  order.status = "converted";
  order.grants.at(-1)!.converted = true;
  order.everConverted = true;
  if (!state.settings.conversions.includes(order.id)) {
    state.settings.conversions.push(order.id);
    if (state.settings.conversions.length === 10) state.settings.paused = true;
  }
}
function qualifiedBlock(state: State, order: Order, price: number): number {
  let amount = 0;
  const confirmed = state.payments.filter(p => p.active && p.script === order.destination?.script && p.confirmations >= 1)
    .sort((a, b) => b.confirmations - a.confirmations);
  for (const output of confirmed) {
    amount += output.sats;
    if (amount >= price) return state.settings.tip - output.confirmations + 1;
  }
  return Infinity;
}
function needed(state: State, order: Order): number {
  return state.settings.lastTime < order.quotedAt! + 900 ? order.quotedPrice! :
    state.listings.find(n => n.handle === order.handle)!.price;
}
export function refresh(state: State, now: number, snapshot: Snapshot): void {
  whole(now); whole(snapshot.tip);
  if (now < state.settings.lastTime) fail("clock moved backwards", "unavailable");
  if (!Array.isArray(snapshot.outputs)) fail("invalid chain snapshot", "unavailable");
  const ids = new Set<string>(); let amount = 0;
  for (const p of snapshot.outputs) {
    if (typeof p.outpoint !== "string" || !p.outpoint || p.outpoint.length > 256 ||
        typeof p.script !== "string" || ids.has(p.outpoint)) fail("invalid or duplicate outpoint", "unavailable");
    sats(p.sats); whole(p.confirmations);
    if (p.confirmations > snapshot.tip + 1) fail("impossible payment depth", "unavailable");
    amount += p.sats; ids.add(p.outpoint);
    if (amount > MAX_MONEY) fail("chain snapshot exceeds money supply", "unavailable");
    const old = state.payments.find(x => x.outpoint === p.outpoint);
    if (old && (old.script !== p.script || old.sats !== p.sats)) fail("outpoint contents changed", "unavailable");
  }
  state.settings.lastTime = now; state.settings.tip = snapshot.tip;
  for (const saved of state.payments) saved.active = false;
  for (const p of snapshot.outputs) {
    if (!state.orders.some(o => o.destination?.script === p.script)) continue;
    const old = state.payments.find(x => x.outpoint === p.outpoint);
    if (old) { old.active = true; old.confirmations = p.confirmations; }
    else state.payments.push({ ...p, active: true });
  }
  for (const o of state.orders) {
    if (total(state, o, 0) > 0) o.paymentHistory = "detected";
    const hold = o.grants.at(-1);
    if (o.status !== "quoted") continue;
    if (hold && !hold.released && hold.seenHeight === null && now < hold.until && total(state, o, 0) > 0)
      hold.seenHeight = snapshot.tip;
    if (hold && !active(state, o)) hold.released = true;
    convert(state, o);
    if (o.status === "quoted" && !active(state, o) && !o.payFirst) o.status = "unpaid";
  }
  const candidates = state.orders.filter(o => (o.status === "quoted" && !active(state, o) && o.payFirst) ||
    (o.status === "unpaid" && !o.lateEvaluated));
  candidates.sort((a, b) => qualifiedBlock(state, a, Math.min(needed(state, a), a.quotedPrice!)) -
    qualifiedBlock(state, b, Math.min(needed(state, b), b.quotedPrice!)) ||
    a.quotedAt! - b.quotedAt! || a.sequence - b.sequence);
  for (const o of candidates) {
    const required = needed(state, o), confirmed = total(state, o, 1);
    if (confirmed < Math.min(required, o.quotedPrice!)) {
      if (!o.payFirst && confirmed > 0) { o.status = "refund_due"; o.lateEvaluated = true; }
      continue;
    }
    o.lateEvaluated = true;
    if (required > o.quotedPrice! || owner(state, o.handle)) { o.status = "refund_due"; continue; }
    o.price = required; o.status = "quoted"; grant(state, o, true); convert(state, o);
  }
  // Check before a caller can commit. Status-derived ownership cannot drift
  // from a second independently persisted reservation table.
  const handles = new Set<string>();
  for (const o of state.orders.filter(o => claims(o) || active(state, o))) {
    if (handles.has(o.handle)) fail("multiple owners for one handle", "unavailable");
    handles.add(o.handle);
  }
}
export function admission(state: State, order: Order): boolean {
  if (state.settings.paused) fail("sales are paused");
  if (owner(state, order.handle)) fail("taken for now");
  const price = state.listings.find(n => n.handle === order.handle)!.price;
  const highest = state.listings.reduce((price, n) => Math.max(price, n.price), 0);
  const limit = Math.min(state.settings.riskBudget, 10 * highest);
  const confirmed = state.payments.filter(p => p.active && p.confirmations >= 1).reduce((n, p) => n + p.sats, 0);
  if (confirmed + price > limit) fail("sales are paused: the store is at its exposure limit");
  const held = state.orders.filter(o => active(state, o));
  const reserved = held.reduce((sum, o) => sum + Math.max(0, o.price! - total(state, o, 1)), 0);
  const counted = state.orders.filter(o => o.handle === order.handle).flatMap(o => o.grants)
    .filter(h => h.at > state.settings.lastTime - 86_400 && !h.converted).length;
  return counted >= 2 || held.length >= 10 || confirmed + reserved + price > limit;
}
export function release(order: Order): void {
  const hold: Grant | undefined = order.grants.at(-1);
  if (hold) hold.released = true;
}
