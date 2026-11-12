import { canonicalHandle, validP2tr } from "../recipient.ts";
import { claims, fail, postIssuance, type Order, type State } from "./records.ts";
import { alert, monitor } from "./monitor.ts";
import { total } from "./sales.ts";

export function recipientBlock(state: State, order: Order): string | null {
  if (!canonicalHandle(order.handle) || !validP2tr(order.recipient)) return "recipient not accepted";
  if (state.orders.some(o => o.destination?.script === order.recipient)) return "store destination script";
  if (claims(order) && state.orders.some(o => o.handle !== order.handle && o.recipient === order.recipient &&
      (postIssuance(order) ? postIssuance(o) : claims(o)))) return "script conflict";
  return null;
}
export function auditRecipients(state: State): void {
  for (const o of state.orders.filter(claims)) if (recipientBlock(state, o) &&
      !state.alerts.some(a => a.order === o.id && a.kind === "recipient_conflict")) {
    monitor(state, o.id); alert(state, o.id, "recipient_conflict", 0);
  }
}
export function entryOk(state: State, order: Order, issuing = false): boolean {
  return order.status === (issuing ? "issuing" : "converted") &&
    total(state, order, 3) >= order.price! && recipientBlock(state, order) === null;
}
export function orderById(state: State, id: string): Order {
  return state.orders.find(o => o.id === id) ?? fail("no such order", "not_found");
}
export function orderIds(value: unknown, empty = false): string[] {
  if (!Array.isArray(value) || value.length > 1000 || (!empty && value.length === 0) ||
      value.some(v => typeof v !== "string" || !/^o[1-9][0-9]{0,15}$/.test(v)) ||
      new Set(value).size !== value.length) fail("invalid batch members", "invalid");
  return [...value];
}
export function members(state: State, ids: readonly string[]): Order[] {
  const orders = ids.map(id => orderById(state, id));
  if (new Set(orders.map(o => o.space)).size > 1) fail("batch members must belong to one space", "invalid");
  return orders;
}
