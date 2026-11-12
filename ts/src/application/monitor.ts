import { claims, fail, MAX_MONEY, postIssuance, sats, whole, type Order, type State } from "./records.ts";
import { total } from "./sales.ts";
import { members, reservation } from "../refunds/families.ts";
import { balance, settled } from "../refunds/observations.ts";

export const reasons = ["issuance", "post_issuance_deficit", "refunds"] as const;
export type Reason = typeof reasons[number];
export interface Deadline {
  id: number; principal: number; remaining: number; dueAt: number;
  completedAt: number | null; incident: boolean;
}
export interface OrderMonitor {
  order: string; losses: { [K in Reason]: number }; reasons: Reason[];
  deadlines: Deadline[]; serviced: { group: string; charged: number }[];
}
export interface BroadcastReceipt { group: string; txid: string; at: number }
export interface OperatorAlert {
  id: number; order: string; kind: Reason | "refund_deadline" | "refund_assessment" | "recipient_conflict"; amount: number; at: number; deadline: number | null;
}
export function monitor(state: State, order: string): OrderMonitor {
  let value = state.monitors.find(m => m.order === order);
  if (!value) {
    value = { order, losses: { issuance: 0, post_issuance_deficit: 0, refunds: 0 }, reasons: [], deadlines: [], serviced: [] };
    state.monitors.push(value);
  }
  return value;
}
export function deficits(state: State, order: Order): { [K in Reason]: number } {
  const shortage = claims(order) ? Math.max(0, order.price! - total(state, order, 3)) : 0;
  return { issuance: order.status === "converted" ? shortage : 0,
    post_issuance_deficit: postIssuance(order) ? shortage : 0, refunds: balance(state, order).exposure };
}
export function alert(state: State, order: string, kind: OperatorAlert["kind"], amount: number, deadline: number | null = null) {
  state.alerts.push({ id: (state.alerts.at(-1)?.id ?? 0) + 1, order, kind, amount, at: state.settings.lastTime, deadline });
}
export function advance(state: State, now: number) {
  whole(now);
  if (now < state.settings.lastTime) fail("clock moved backwards", "unavailable");
  state.settings.lastTime = now;
}
/** Tick uses persisted clocks only; no chain inference, signing or send. */
export function tick(state: State, now: number) {
  advance(state, now);
  for (const m of state.monitors) for (const d of m.deadlines) {
    if (d.remaining && !d.incident && now - d.dueAt > 86400) {
      d.incident = true; alert(state, m.order, "refund_deadline", d.remaining, d.id);
    }
  }
}
export function noteBroadcast(state: State, group: string, txid: string, at = state.settings.lastTime) {
  if (!state.broadcastReceipts.some(r => r.txid === txid))
    state.broadcastReceipts.push({ group, txid, at });
}
/** Called only with a fresh coherent chain observation, or after a mutation
 * using that observation. An uncertain intent never proves a broadcast. */
export function unserved(state: State, order: Order) {
  const m = state.monitors.find(m => m.order === order.id);
  const pending = state.groups.filter(g => g.order === order.id && g.phase !== "void" && !settled(state, g))
    .reduce((n, g) => n + Math.max(0, reservation(state, g) - (m?.serviced.find(s => s.group === g.id)?.charged ?? 0)), 0);
  return Math.max(0, balance(state, order).available + pending);
}
export function reconcile(state: State, eligibleExcess: ReadonlySet<string> = new Set(), observedAt = state.settings.lastTime) {
  for (const facts of state.refundObservations) if (facts.seen !== "absent") noteBroadcast(state, facts.group, facts.txid);
  for (const order of state.orders) {
    const m = monitor(state, order.id), values = deficits(state, order);
    for (const reason of reasons) {
      if (values[reason] > m.losses[reason]) {
        if (!m.reasons.includes(reason)) alert(state, order.id, reason, values[reason] - m.losses[reason]);
        if (!m.reasons.includes(reason)) m.reasons.push(reason);
      } else m.reasons = m.reasons.filter(r => r !== reason);
    }
    const outstanding = m.deadlines.reduce((n, d) => n + d.remaining, 0);
    const needed = unserved(state, order) - outstanding;
    if (needed > 0 && (["cancelled", "refund_due"].includes(order.status) || (claims(order) && eligibleExcess.has(order.id))) && state.accounts.find(a => a.order === order.id)?.destination) {
      const dueAt = claims(order) ? state.assessments.find(a => a.order === order.id)!.at : observedAt;
      m.deadlines.push({ id: (m.deadlines.at(-1)?.id ?? 0) + 1, principal: needed, remaining: needed,
        dueAt, completedAt: null, incident: false });
    }
  }
  for (const g of state.groups) {
    const m = monitor(state, g.order);
    for (const receipt of state.broadcastReceipts.filter(r => r.group === g.id).sort((a, b) => a.at - b.at)) {
      const amount = members(state, g).find(v => v.transaction?.txid === receipt.txid)!.charged;
      const previous = m.serviced.find(s => s.group === g.id);
      let credit = Math.max(0, amount - (previous?.charged ?? 0));
      if (!credit) continue;
      if (previous) previous.charged = amount; else m.serviced.push({ group: g.id, charged: amount });
      for (const d of m.deadlines) {
        const used = Math.min(d.remaining, credit), at = Math.max(d.dueAt, receipt.at);
        if (used && !d.incident && at - d.dueAt > 86400) {
          d.incident = true; alert(state, m.order, "refund_deadline", d.remaining, d.id);
        }
        d.remaining -= used; credit -= used;
        if (used && !d.remaining) d.completedAt = at;
      }
    }
  }
  tick(state, state.settings.lastTime);
}
export function recordLoss(state: State, id: string, reason: Reason) {
  const order = state.orders.find(o => o.id === id) ?? fail("no such order", "not_found");
  if (!reasons.includes(reason)) fail("unknown deficit reason", "invalid");
  const m = monitor(state, id), amount = deficits(state, order)[reason];
  if (amount <= m.losses[reason]) fail("no uncovered deficit to record");
  m.losses[reason] = amount; reconcile(state);
}

function fields(v: unknown, names: string): asserts v is { [key: string]: unknown } {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== names.split(",").sort().join()) fail("invalid monitoring fields");
}
export function decodeMonitor(value: unknown): asserts value is OrderMonitor {
  fields(value, "order,losses,reasons,deadlines,serviced");
  fields(value.losses, reasons.join());
  for (const r of reasons) { whole(value.losses[r]); if (value.losses[r] > 2_100_000_000_000_000) fail("invalid loss amount"); }
  if (typeof value.order !== "string" || !Array.isArray(value.reasons) || new Set(value.reasons).size !== value.reasons.length ||
      value.reasons.some(r => !reasons.includes(r)) || !Array.isArray(value.deadlines) || !Array.isArray(value.serviced)) fail("invalid order monitor");
  for (const [index, d] of value.deadlines.entries()) {
    fields(d, "id,principal,remaining,dueAt,completedAt,incident");
    sats(d.principal); whole(d.remaining); whole(d.dueAt);
    if (d.completedAt !== null) whole(d.completedAt);
    if (d.id !== index + 1 || d.remaining > d.principal || typeof d.incident !== "boolean" ||
        (d.remaining === 0) !== (d.completedAt !== null) || (d.completedAt !== null && d.completedAt < d.dueAt)) fail("invalid refund deadline");
  }
  const groups = new Set<string>();
  for (const s of value.serviced) {
    fields(s, "group,charged"); sats(s.charged);
    if (typeof s.group !== "string" || groups.has(s.group)) fail("invalid broadcast credit"); groups.add(s.group);
  }
}
export function decodeReceipt(value: unknown): asserts value is BroadcastReceipt {
  fields(value, "group,txid,at"); whole(value.at);
  if (typeof value.group !== "string" || typeof value.txid !== "string" || !/^[0-9a-f]{64}$/.test(value.txid)) fail("invalid broadcast receipt");
}
export function decodeAlert(value: unknown): asserts value is OperatorAlert {
  fields(value, "id,order,kind,amount,at,deadline"); whole(value.id, 1); whole(value.at);
  if (value.kind === "recipient_conflict") { if (value.amount !== 0) fail("invalid recipient alert amount"); }
  else sats(value.amount);
  if (typeof value.order !== "string" || ![...reasons, "refund_deadline", "refund_assessment", "recipient_conflict"].includes(String(value.kind)) ||
      (value.kind === "refund_deadline") !== (value.deadline !== null)) fail("invalid operator alert");
  if (value.deadline !== null) whole(value.deadline, 1);
}
export function validateMonitoring(state: State) {
  const receipts = new Set<string>();
  for (const r of state.broadcastReceipts) {
    const g = state.groups.find(g => g.id === r.group);
    if (!g || !members(state, g).some(m => m.transaction?.txid === r.txid) || receipts.has(r.txid) || r.at > state.settings.lastTime) fail("invalid broadcast receipt relationship");
    receipts.add(r.txid);
  }
  const orders = new Set<string>();
  for (const m of state.monitors) {
    if (!state.orders.some(o => o.id === m.order) || orders.has(m.order)) fail("invalid monitor relationship"); orders.add(m.order);
    let previous = 0;
    for (const d of m.deadlines) {
      if (d.dueAt < previous || d.dueAt > state.settings.lastTime || (d.completedAt ?? 0) > state.settings.lastTime ||
          d.dueAt > Number.MAX_SAFE_INTEGER - 86400 ||
          (d.completedAt !== null && d.completedAt - d.dueAt > 86400 && !d.incident)) fail("invalid deadline chronology");
      previous = d.dueAt;
    }
    if (m.deadlines.reduce((n, d) => n + d.remaining, 0) > MAX_MONEY) fail("deadline principal exceeds money supply");
    for (const s of m.serviced) {
      const g = state.groups.find(g => g.id === s.group && g.order === m.order);
      if (!g || s.charged !== Math.max(0, ...members(state, g).filter(v => receipts.has(v.transaction?.txid ?? "")).map(v => v.charged))) fail("broadcast credit differs from receipts");
    }
  }
  for (const [i, a] of state.alerts.entries()) {
    const m = state.monitors.find(m => m.order === a.order);
    if (!m || a.id !== i + 1 || a.at > state.settings.lastTime || (a.deadline !== null && !m.deadlines.some(d => d.id === a.deadline && d.incident))) fail("invalid alert relationship");
    if (a.deadline !== null) {
      const d = m.deadlines.find(d => d.id === a.deadline)!;
      if (a.at - d.dueAt <= 86400 || a.amount < d.remaining || a.amount > d.principal) fail("invalid deadline alert amount or time");
    }
  }
  for (const m of state.monitors) for (const d of m.deadlines) if (
    state.alerts.filter(a => a.order === m.order && a.deadline === d.id).length !== (d.incident ? 1 : 0)) fail("deadline incident differs from alerts");
}
