/**
 * The order and name-hold state machine of a fixed-price sale
 * (docs/spec/PAYMENT-SPEC.md, "Fixed-price sales" and "Cancellation").
 *
 * It is a port of the order steps of `service/ledger.py`: `_step_order`,
 * `quote`, `cancel` and the status moves the controller makes. It is pure:
 * a transition takes the order, its name, one event and what the store
 * observed, and returns the next order and name or a refusal. It reads no
 * clock, no chain and no database, and it performs no effect. The store
 * runs it inside one database transaction, and evaluates every order before
 * and after each command, as `Ledger.observe` does.
 *
 * What it doesn't decide. Store-wide guards run before a quote and aren't
 * here: the recipient checks, the sales pause, the exposure limit and the
 * journal's availability. Neither are payment outputs, refund groups,
 * deficits and their reasons, alerts, or what the off-host journal has
 * acknowledged. The machine reads an order's reasons but never writes them.
 *
 * Every status change it can make is listed in `ORDER_EDGES`. `transition`
 * checks that the edges it reports are listed and lead from the status
 * before to the status after, and throws otherwise: a missing edge is a bug
 * here, never a refusal. The table is derived from `MOVES`, so it can't
 * catch a wrong target declared there; the tests' expected-outcome table
 * and the Python vectors do.
 */

// Depth thresholds, in conventional confirmations (PAYMENT-SPEC.md, "Terms").
export const CONFIRMED = 1;
export const BATCHABLE = 3;
export const SETTLED = 6;
export const EXTENSION_BLOCKS = 6;

export const ORDER_STATUSES = [
  "requested", "quoted", "converted", "issuing", "ready", "fulfilled",
  "cancelled", "refund_due", "unpaid",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Paid orders, from conversion on: the name is reserved for them. */
export const FULFILLABLE: readonly OrderStatus[] = ["converted", "issuing", "ready", "fulfilled"];
/** Orders whose commitment may have left the store: never cancellable. */
export const ISSUED: readonly OrderStatus[] = ["issuing", "ready", "fulfilled"];

export interface Destination {
  readonly address: string;
  readonly script: string;
}

/** The fields of an order this machine owns or reads. The store's order
 * record holds more (the recipient, the refund address, losses, the
 * incident), which no transition here touches. */
export interface Order {
  readonly oid: string;
  readonly name: string;
  readonly status: OrderStatus;
  /** Fixed by the quote; null until then. */
  readonly price: number | null;
  /** What conversion keeps back for issuance; 0 unless fulfillable. */
  readonly priceReserve: number;
  readonly lateEvaluated: boolean;
  readonly eligible: boolean;
  /** The order's `reconciling` reasons, kept by the deficit rules. */
  readonly reasons: readonly string[];
  readonly destination: Destination | null;
}

export interface Hold {
  readonly order: string;
  /** Store clock, in seconds. */
  readonly expiresAt: number;
  /** The tip when a payment was first seen while the hold lasted. */
  readonly seenHeight: number | null;
  /** Whether `confirmed` reached the price once the extension lapsed. */
  readonly latched: boolean | null;
}

/** A name is free, temporarily held by one quote, or reserved for one paid
 * order. Never both held and reserved: the type can't say it. */
export type Claim =
  | { readonly kind: "free" }
  | { readonly kind: "held"; readonly hold: Hold }
  | { readonly kind: "reserved"; readonly order: string };

export interface Name {
  readonly name: string;
  readonly price: number;
  readonly claim: Claim;
}

export interface OrderState {
  readonly order: Order;
  readonly name: Name;
}

/** What the store observed for this order at the start of the transition:
 * its clock and the chain position of the order's payment outputs. */
export interface Observation {
  /** Store clock, in seconds. */
  readonly now: number;
  /** Best-chain height. */
  readonly tip: number;
  /** Any output paying the order is mined on the best chain or in the
   * mempool. */
  readonly paymentSeen: boolean;
  /** Sats paying the order at `CONFIRMED` depth or deeper. */
  readonly confirmed: number;
  /** Sats paying the order at `BATCHABLE` depth or deeper. */
  readonly batchable: number;
}

export interface Policy {
  readonly holdSeconds: number;
}

export type OrderEvent =
  /** Re-evaluate against the observation: hold, extension, conversion, the
   * end of a hold, and a late payment. */
  | { readonly type: "evaluate" }
  /** Fix the price and take the name's temporary hold. The destination is
   * fresh from the payment wallet. */
  | { readonly type: "quote"; readonly destination: Destination }
  | { readonly type: "cancel" }
  /** Batch entry: the controller freezes the order into a batch. Whether
   * its recipient is blocked is the store's verdict (a script conflict
   * spans orders). */
  | { readonly type: "markIssuing"; readonly recipientBlocked: boolean }
  /** Restore only: the controller's journal shows a batch that may have
   * escaped, and the store's journal lagged. */
  | { readonly type: "restoreIssuing" }
  /** Paid again: safe supersession is proven, or the batch was rebuilt
   * because it was never sent. */
  | { readonly type: "unissue" }
  | { readonly type: "markReady" }
  /** The batch lost finality. */
  | { readonly type: "unready" }
  /** Delivery confirmed by a verified lookup. */
  | { readonly type: "markFulfilled" }
  | { readonly type: "invalidateEligibility" };

export type OrderEventType = OrderEvent["type"];

/** Refusals carry the service's own messages, which its API returns. */
export type Refusal =
  | "already quoted"
  | "taken for now"
  | "not cancellable once issuing"
  | "not converted"
  | "batch entry refused"
  | "not issuing"
  | "not ready";

export type Edge = readonly [from: OrderStatus, to: OrderStatus];

export type Outcome =
  | { readonly ok: true; readonly state: OrderState; readonly edges: readonly Edge[] }
  | { readonly ok: false; readonly refusal: Refusal };

// The commands that move an order's status, declared once. A command is
// refused, with its message, from any status not in `from`.
interface Move {
  readonly from: readonly OrderStatus[];
  readonly to: OrderStatus;
  readonly refused: Refusal;
}

const NOT_ISSUED = ORDER_STATUSES.filter((s) => !ISSUED.includes(s));

export const MOVES = {
  quote: { from: ["requested"], to: "quoted", refused: "already quoted" },
  cancel: { from: NOT_ISSUED, to: "cancelled", refused: "not cancellable once issuing" },
  markIssuing: { from: ["converted"], to: "issuing", refused: "not converted" },
  restoreIssuing: { from: ["converted"], to: "issuing", refused: "not converted" },
  unissue: { from: ["issuing"], to: "converted", refused: "not issuing" },
  markReady: { from: ["issuing"], to: "ready", refused: "not issuing" },
  unready: { from: ["ready"], to: "issuing", refused: "not ready" },
  markFulfilled: { from: ["ready"], to: "fulfilled", refused: "not ready" },
} as const satisfies Record<string, Move>;

/** What the chain moves an order through on `evaluate`. A late payment is
 * two edges in one evaluation: `unpaid` to `quoted`, then possibly on to
 * `converted`. */
export const EVALUATE_EDGES: readonly Edge[] = [
  ["quoted", "converted"],
  ["quoted", "unpaid"],
  ["quoted", "refund_due"],
  ["unpaid", "quoted"],
  ["unpaid", "refund_due"],
];

function edgesOf(m: Move): readonly Edge[] {
  return m.from.map((f): Edge => [f, m.to]);
}

/** Every status change, by the event that makes it. The type requires an
 * entry for every event. */
export const ORDER_EDGES: Readonly<Record<OrderEventType, readonly Edge[]>> = {
  evaluate: EVALUATE_EDGES,
  invalidateEligibility: [],
  quote: edgesOf(MOVES.quote),
  cancel: edgesOf(MOVES.cancel),
  markIssuing: edgesOf(MOVES.markIssuing),
  restoreIssuing: edgesOf(MOVES.restoreIssuing),
  unissue: edgesOf(MOVES.unissue),
  markReady: edgesOf(MOVES.markReady),
  unready: edgesOf(MOVES.unready),
  markFulfilled: edgesOf(MOVES.markFulfilled),
};

export class MachineError extends Error {
  override name = "MachineError";
}

function allowed(type: OrderEventType, edge: Edge): boolean {
  return ORDER_EDGES[type].some(([f, t]) => f === edge[0] && t === edge[1]);
}

function holdOf(name: Name, oid: string): Hold | null {
  return name.claim.kind === "held" && name.claim.hold.order === oid ? name.claim.hold : null;
}

function reservedFor(name: Name, oid: string): boolean {
  return name.claim.kind === "reserved" && name.claim.order === oid;
}

const FREE: Claim = { kind: "free" };

function quotedPrice(order: Order): number {
  if (order.price === null) {
    throw new MachineError(`order ${order.oid} is ${order.status} with no price`);
  }
  return order.price;
}

/** The binding batch-entry rule (PAYMENT-SPEC.md, "Batch entry and the
 * binding pre-broadcast check"). */
export function batchEntryOk(order: Order, obs: Observation, recipientBlocked: boolean): boolean {
  return (order.status === "converted" && order.eligible
    && !order.reasons.includes("issuance")
    && obs.batchable >= order.priceReserve
    && !recipientBlocked);
}

/** The same rule for a member already `issuing` whose batch was never sent. */
export function issuingRecheckOk(order: Order, obs: Observation, recipientBlocked: boolean): boolean {
  return (order.status === "issuing" && order.eligible
    && obs.batchable >= order.priceReserve
    && !recipientBlocked);
}

// evaluate

interface Stepped {
  readonly state: OrderState;
  readonly edges: Edge[];
}

function evaluate(state: OrderState, obs: Observation, policy: Policy): Stepped {
  const { order, name } = state;
  const hold = holdOf(name, order.oid);

  if (order.status === "quoted" && hold !== null) {
    const price = quotedPrice(order);
    let next = hold;
    let seen = hold.seenHeight;
    if (seen === null && obs.paymentSeen && obs.now < hold.expiresAt) {
      // Extension: the hold now lasts six blocks past this tip.
      seen = obs.tip;
      next = { ...next, seenHeight: seen };
    }
    let active: boolean;
    if (seen === null) {
      active = obs.now < hold.expiresAt;
    } else if (obs.tip <= seen + EXTENSION_BLOCKS) {
      active = true;
    } else {
      // The extension lapsed: the hold continues only while `confirmed`
      // stays at or above the price, once it reached it by then.
      let latched = hold.latched ?? obs.confirmed >= price;
      if (latched && obs.confirmed < price) latched = false;
      if (latched !== hold.latched) next = { ...next, latched };
      active = latched;
    }
    if (active && obs.batchable >= price) {
      return {
        state: {
          order: { ...order, status: "converted", priceReserve: price },
          name: { ...name, claim: { kind: "reserved", order: order.oid } },
        },
        edges: [["quoted", "converted"]],
      };
    }
    if (!active) {
      const to: OrderStatus = obs.confirmed > 0 ? "refund_due" : "unpaid";
      return {
        state: { order: { ...order, status: to }, name: { ...name, claim: FREE } },
        edges: [["quoted", to]],
      };
    }
    return next === hold
      ? { state, edges: [] }
      : { state: { order, name: { ...name, claim: { kind: "held", hold: next } } }, edges: [] };
  }

  if (order.status === "unpaid" && !order.lateEvaluated && obs.confirmed > 0) {
    // A late payment, evaluated once.
    const price = quotedPrice(order);
    if (name.claim.kind === "free" && name.price <= price) {
      const requoted: OrderState = {
        order: { ...order, lateEvaluated: true, price: name.price, status: "quoted" },
        name: {
          ...name,
          claim: {
            kind: "held",
            hold: { order: order.oid, expiresAt: obs.now + policy.holdSeconds,
                    seenHeight: obs.tip, latched: null },
          },
        },
      };
      const then = evaluate(requoted, obs, policy);
      return { state: then.state, edges: [["unpaid", "quoted"], ...then.edges] };
    }
    return {
      state: { order: { ...order, lateEvaluated: true, status: "refund_due" }, name },
      edges: [["unpaid", "refund_due"]],
    };
  }

  return { state, edges: [] };
}

// Commands

function move(state: OrderState, type: keyof typeof MOVES,
              effect: (s: OrderState) => OrderState): Outcome {
  const m: Move = MOVES[type];
  const from = state.order.status;
  if (!m.from.includes(from)) return { ok: false, refusal: m.refused };
  const next = effect(state);
  return {
    ok: true,
    state: { ...next, order: { ...next.order, status: m.to } },
    edges: [[from, m.to]],
  };
}

function command(state: OrderState, event: OrderEvent, obs: Observation, policy: Policy): Outcome {
  const { order, name } = state;
  switch (event.type) {
    case "evaluate": {
      const r = evaluate(state, obs, policy);
      return { ok: true, state: r.state, edges: r.edges };
    }
    case "quote":
      // Asking again returns the same quote while its hold lasts.
      if (order.status === "quoted" && holdOf(name, order.oid) !== null) {
        return { ok: true, state, edges: [] };
      }
      if (order.status !== "requested") return { ok: false, refusal: MOVES.quote.refused };
      if (name.claim.kind !== "free") return { ok: false, refusal: "taken for now" };
      return move(state, "quote", (s) => ({
        order: { ...s.order, price: s.name.price, destination: event.destination },
        name: {
          ...s.name,
          claim: {
            kind: "held",
            hold: { order: s.order.oid, expiresAt: obs.now + policy.holdSeconds,
                    seenHeight: null, latched: null },
          },
        },
      }));
    case "cancel":
      return move(state, "cancel", (s) => ({
        order: { ...s.order, priceReserve: 0 },
        name: holdOf(s.name, s.order.oid) !== null || reservedFor(s.name, s.order.oid)
          ? { ...s.name, claim: FREE }
          : s.name,
      }));
    case "markIssuing":
      if (order.status !== "converted") return { ok: false, refusal: MOVES.markIssuing.refused };
      if (!batchEntryOk(order, obs, event.recipientBlocked)) {
        return { ok: false, refusal: "batch entry refused" };
      }
      return move(state, "markIssuing", (s) => s);
    case "restoreIssuing":
    case "unissue":
    case "markReady":
    case "unready":
    case "markFulfilled":
      return move(state, event.type, (s) => s);
    case "invalidateEligibility":
      return { ok: true, state: { order: { ...order, eligible: false }, name }, edges: [] };
  }
}

/** The edges a transition reports must be listed for its event and form one
 * chain from the status before to the status after; no edges means no
 * change. A status change that skips this, reported or not, throws. */
function checkEdges(type: OrderEventType, before: OrderStatus, after: OrderStatus,
                    edges: readonly Edge[]): void {
  let at = before;
  for (const edge of edges) {
    if (edge[0] !== at) {
      throw new MachineError(`${type} reported ${edge[0]} -> ${edge[1]} from ${at}`);
    }
    if (!allowed(type, edge)) {
      throw new MachineError(`${type} made ${edge[0]} -> ${edge[1]}, `
        + "which ORDER_EDGES doesn't list");
    }
    at = edge[1];
  }
  if (at !== after) {
    throw new MachineError(`${type} moved ${before} -> ${after}, but its edges end at ${at}`);
  }
}

/** One transition. Refusals are outcomes; a status change outside
 * `ORDER_EDGES`, or an order paired with another order's name, throws. */
export function transition(state: OrderState, event: OrderEvent, obs: Observation,
                           policy: Policy): Outcome {
  if (state.order.name !== state.name.name) {
    throw new MachineError(`order ${state.order.oid} is for ${state.order.name}, `
      + `not ${state.name.name}`);
  }
  const out = command(state, event, obs, policy);
  if (out.ok) checkEdges(event.type, state.order.status, out.state.order.status, out.edges);
  return out;
}

/** The invariants every reachable order and name keep, as a list of what
 * fails. They hold for the pair; a name's claim by another order is that
 * order's to check. */
export function invariantViolations(state: OrderState): string[] {
  const { order, name } = state;
  const out: string[] = [];
  const fulfillable = FULFILLABLE.includes(order.status);
  if (order.name !== name.name) out.push("order and name differ");
  if (holdOf(name, order.oid) !== null && order.status !== "quoted") {
    out.push(`the name is held for a ${order.status} order`);
  }
  if (fulfillable !== reservedFor(name, order.oid)) {
    out.push(fulfillable
      ? `a ${order.status} order without the name's reservation`
      : `the name is reserved for a ${order.status} order`);
  }
  const reserve = fulfillable ? order.price : 0;
  if (order.priceReserve !== reserve) {
    out.push(`price reserve ${order.priceReserve} for a ${order.status} order priced ${order.price}`);
  }
  if (order.status === "requested" && (order.price !== null || order.destination !== null)) {
    out.push("a requested order with a price or destination");
  }
  if (order.status !== "requested" && order.status !== "cancelled"
      && (order.price === null || order.destination === null)) {
    out.push(`a ${order.status} order without a price or destination`);
  }
  return out;
}
