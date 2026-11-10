// The order machine on its own: named scenarios from PAYMENT-SPEC.md's
// fixed-price rules, then every event over a bounded grid of states and
// observations. These are tests of the TypeScript port, not model results
// and not regtest evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Claim, type Edge, type Observation, type OrderEvent, type OrderEventType,
  type OrderState, type OrderStatus, type Refusal, FULFILLABLE, ORDER_EDGES, ORDER_STATUSES,
  invariantViolations, transition,
} from "../src/order.ts";

const POLICY = { holdSeconds: 900 };
const DEST = { address: "made-up-address", script: "5120" + "ab".repeat(32) };

function requested(namePrice = 1000): OrderState {
  return {
    order: { oid: "o1", name: "one@space", status: "requested", price: null, priceReserve: 0,
             lateEvaluated: false, eligible: true, reasons: [], destination: null },
    name: { name: "one@space", price: namePrice, claim: { kind: "free" } },
  };
}

function obs(o: Partial<Observation> = {}): Observation {
  return { now: 0, tip: 100, paymentSeen: false, confirmed: 0, batchable: 0, ...o };
}

function step(s: OrderState, e: OrderEvent, o: Observation = obs()): OrderState {
  const out = transition(s, e, o, POLICY);
  if (!out.ok) assert.fail(`refused: ${out.refusal}`);
  assert.deepEqual(invariantViolations(out.state), []);
  return out.state;
}

function refusal(s: OrderState, e: OrderEvent, o: Observation = obs()): string | null {
  const out = transition(s, e, o, POLICY);
  return out.ok ? null : out.refusal;
}

const quoted = () => step(requested(), { type: "quote", destination: DEST });

test("a quote fixes the price and takes the hold for 15 minutes", () => {
  const s = quoted();
  assert.equal(s.order.status, "quoted");
  assert.equal(s.order.price, 1000);
  assert.deepEqual(s.order.destination, DEST);
  assert.deepEqual(s.name.claim, { kind: "held",
    hold: { order: "o1", expiresAt: 900, seenHeight: null, latched: null } });
});

test("a held name is taken for now; its holder asking again changes nothing", () => {
  const s = quoted();
  assert.deepEqual(transition(s, { type: "quote", destination: DEST }, obs(), POLICY),
                   { ok: true, state: s, edges: [] });
  const other: OrderState = { ...requested(), order: { ...requested().order, oid: "o2" },
                              name: s.name };
  assert.equal(refusal(other, { type: "quote", destination: DEST }), "taken for now");
});

test("a hold with nothing seen ends at its expiry and the order is unpaid", () => {
  const s = quoted();
  assert.equal(step(s, { type: "evaluate" }, obs({ now: 899 })).order.status, "quoted");
  const ended = step(s, { type: "evaluate" }, obs({ now: 900 }));
  assert.equal(ended.order.status, "unpaid");
  assert.equal(ended.name.claim.kind, "free");
});

test("a payment seen before expiry extends the hold six blocks past it", () => {
  let s = step(quoted(), { type: "evaluate" }, obs({ now: 600, tip: 100, paymentSeen: true }));
  assert.equal(s.name.claim.kind === "held" && s.name.claim.hold.seenHeight, 100);
  s = step(s, { type: "evaluate" }, obs({ now: 5000, tip: 106, paymentSeen: true,
                                          confirmed: 1000 }));
  assert.equal(s.order.status, "quoted");
  s = step(s, { type: "evaluate" }, obs({ now: 5000, tip: 107, paymentSeen: true,
                                          confirmed: 1000, batchable: 1000 }));
  assert.equal(s.order.status, "converted");
  assert.equal(s.order.priceReserve, 1000);
  assert.deepEqual(s.name.claim, { kind: "reserved", order: "o1" });
});

test("after the extension, the hold lasts while confirmed stays at the price", () => {
  let s = step(quoted(), { type: "evaluate" }, obs({ now: 600, tip: 100, paymentSeen: true }));
  s = step(s, { type: "evaluate" }, obs({ now: 5000, tip: 107, paymentSeen: true,
                                          confirmed: 1000 }));
  assert.equal(s.name.claim.kind === "held" && s.name.claim.hold.latched, true);
  s = step(s, { type: "evaluate" }, obs({ now: 5000, tip: 108, paymentSeen: true,
                                          confirmed: 400 }));
  assert.equal(s.order.status, "refund_due");
  assert.equal(s.name.claim.kind, "free");
});

test("a late payment takes a new hold at a price no higher, once", () => {
  const unpaid = step(quoted(), { type: "evaluate" }, obs({ now: 900 }));
  const cheaper: OrderState = { ...unpaid, name: { ...unpaid.name, price: 800 } };
  const late = step(cheaper, { type: "evaluate" },
                    obs({ now: 2000, tip: 120, paymentSeen: true, confirmed: 500 }));
  assert.equal(late.order.status, "quoted");
  assert.equal(late.order.price, 800);
  assert.equal(late.order.lateEvaluated, true);
  assert.deepEqual(late.name.claim, { kind: "held",
    hold: { order: "o1", expiresAt: 2900, seenHeight: 120, latched: null } });

  const dearer: OrderState = { ...unpaid, name: { ...unpaid.name, price: 1200 } };
  const refused = step(dearer, { type: "evaluate" },
                       obs({ now: 2000, tip: 120, paymentSeen: true, confirmed: 500 }));
  assert.equal(refused.order.status, "refund_due");
});

test("a late payment at batchable depth converts in the same evaluation", () => {
  const unpaid = step(quoted(), { type: "evaluate" }, obs({ now: 900 }));
  const out = transition(unpaid, { type: "evaluate" },
    obs({ now: 2000, tip: 120, paymentSeen: true, confirmed: 1000, batchable: 1000 }), POLICY);
  assert.ok(out.ok);
  assert.deepEqual(out.edges, [["unpaid", "quoted"], ["quoted", "converted"]]);
});

test("cancellation frees the name, and is refused once issuing", () => {
  const paid = obs({ now: 10, paymentSeen: true, confirmed: 1000, batchable: 1000 });
  const converted = step(quoted(), { type: "evaluate" }, paid);
  const cancelled = step(converted, { type: "cancel" });
  assert.equal(cancelled.order.status, "cancelled");
  assert.equal(cancelled.order.priceReserve, 0);
  assert.equal(cancelled.name.claim.kind, "free");
  const issuing = step(converted, { type: "markIssuing", recipientBlocked: false }, paid);
  assert.equal(refusal(issuing, { type: "cancel" }), "not cancellable once issuing");
});

test("batch entry needs eligibility, no issuance deficit and a free recipient", () => {
  const paid = obs({ now: 10, paymentSeen: true, confirmed: 1000, batchable: 1000 });
  const c = step(quoted(), { type: "evaluate" }, paid);
  const enter = (s: OrderState, blocked = false) =>
    refusal(s, { type: "markIssuing", recipientBlocked: blocked }, paid);
  assert.equal(enter(c), null);
  assert.equal(enter(c, true), "batch entry refused");
  assert.equal(enter({ ...c, order: { ...c.order, eligible: false } }), "batch entry refused");
  assert.equal(enter({ ...c, order: { ...c.order, reasons: ["issuance"] } }),
               "batch entry refused");
  assert.equal(refusal(c, { type: "markIssuing", recipientBlocked: false },
                       obs({ ...paid, batchable: 999 })), "batch entry refused");
  assert.equal(enter(quoted()), "not converted");
});

// Every command from every status, written out by hand rather than derived
// from MOVES, so that a wrong target there fails here. Each entry is the
// status after, or the refusal. The order is paid in full and eligible,
// its recipient isn't blocked, and a quoted order holds its name.

type Expected = OrderStatus | Refusal;
const NOT_READY = "not ready";
const NOT_ISSUING = "not issuing";
const NOT_CONVERTED = "not converted";
const EXPECTED: Record<Exclude<OrderEventType, "evaluate">, Record<OrderStatus, Expected>> = {
  quote: { requested: "quoted", quoted: "quoted", converted: "already quoted",
           issuing: "already quoted", ready: "already quoted", fulfilled: "already quoted",
           cancelled: "already quoted", refund_due: "already quoted", unpaid: "already quoted" },
  cancel: { requested: "cancelled", quoted: "cancelled", converted: "cancelled",
            issuing: "not cancellable once issuing", ready: "not cancellable once issuing",
            fulfilled: "not cancellable once issuing", cancelled: "cancelled",
            refund_due: "cancelled", unpaid: "cancelled" },
  markIssuing: { requested: NOT_CONVERTED, quoted: NOT_CONVERTED, converted: "issuing",
                 issuing: NOT_CONVERTED, ready: NOT_CONVERTED, fulfilled: NOT_CONVERTED,
                 cancelled: NOT_CONVERTED, refund_due: NOT_CONVERTED, unpaid: NOT_CONVERTED },
  restoreIssuing: { requested: NOT_CONVERTED, quoted: NOT_CONVERTED, converted: "issuing",
                    issuing: NOT_CONVERTED, ready: NOT_CONVERTED, fulfilled: NOT_CONVERTED,
                    cancelled: NOT_CONVERTED, refund_due: NOT_CONVERTED, unpaid: NOT_CONVERTED },
  unissue: { requested: NOT_ISSUING, quoted: NOT_ISSUING, converted: NOT_ISSUING,
             issuing: "converted", ready: NOT_ISSUING, fulfilled: NOT_ISSUING,
             cancelled: NOT_ISSUING, refund_due: NOT_ISSUING, unpaid: NOT_ISSUING },
  markReady: { requested: NOT_ISSUING, quoted: NOT_ISSUING, converted: NOT_ISSUING,
               issuing: "ready", ready: NOT_ISSUING, fulfilled: NOT_ISSUING,
               cancelled: NOT_ISSUING, refund_due: NOT_ISSUING, unpaid: NOT_ISSUING },
  unready: { requested: NOT_READY, quoted: NOT_READY, converted: NOT_READY, issuing: NOT_READY,
             ready: "issuing", fulfilled: NOT_READY, cancelled: NOT_READY,
             refund_due: NOT_READY, unpaid: NOT_READY },
  markFulfilled: { requested: NOT_READY, quoted: NOT_READY, converted: NOT_READY,
                   issuing: NOT_READY, ready: "fulfilled", fulfilled: NOT_READY,
                   cancelled: NOT_READY, refund_due: NOT_READY, unpaid: NOT_READY },
  invalidateEligibility: { requested: "requested", quoted: "quoted", converted: "converted",
                           issuing: "issuing", ready: "ready", fulfilled: "fulfilled",
                           cancelled: "cancelled", refund_due: "refund_due", unpaid: "unpaid" },
};

/** One valid state per status. */
function at(status: OrderStatus): OrderState {
  const base = requested();
  if (status === "requested") return base;
  const paid = FULFILLABLE.includes(status);
  const claim: Claim = status === "quoted"
    ? { kind: "held", hold: { order: "o1", expiresAt: 900, seenHeight: null, latched: null } }
    : paid ? { kind: "reserved", order: "o1" } : { kind: "free" };
  return {
    order: { ...base.order, status, price: 1000, priceReserve: paid ? 1000 : 0,
             destination: DEST },
    name: { ...base.name, claim },
  };
}

const COMMAND_EVENTS: Record<keyof typeof EXPECTED, OrderEvent> = {
  quote: { type: "quote", destination: DEST }, cancel: { type: "cancel" },
  markIssuing: { type: "markIssuing", recipientBlocked: false },
  restoreIssuing: { type: "restoreIssuing" }, unissue: { type: "unissue" },
  markReady: { type: "markReady" }, unready: { type: "unready" },
  markFulfilled: { type: "markFulfilled" },
  invalidateEligibility: { type: "invalidateEligibility" },
};

test("every command from every status has its expected outcome", () => {
  const paid = obs({ now: 10, paymentSeen: true, confirmed: 1000, batchable: 1000 });
  const wrong: string[] = [];
  for (const [type, byStatus] of Object.entries(EXPECTED)) {
    for (const status of ORDER_STATUSES) {
      const s = at(status);
      assert.deepEqual(invariantViolations(s), []);
      const out = transition(s, COMMAND_EVENTS[type as keyof typeof EXPECTED], paid, POLICY);
      const got = out.ok ? out.state.order.status : out.refusal;
      if (got !== byStatus[status]) wrong.push(`${type} from ${status}: ${got}, expected `
        + byStatus[status]);
    }
  }
  assert.deepEqual(wrong, []);
});

// Every event over a bounded grid.

function claims(): Claim[] {
  const out: Claim[] = [{ kind: "free" }, { kind: "reserved", order: "o1" },
                        { kind: "reserved", order: "o2" },
                        { kind: "held", hold: { order: "o2", expiresAt: 900, seenHeight: null,
                                                latched: null } }];
  for (const seenHeight of [null, 10]) {
    for (const latched of [null, true, false]) {
      out.push({ kind: "held", hold: { order: "o1", expiresAt: 900, seenHeight, latched } });
    }
  }
  return out;
}

function states(): OrderState[] {
  const out: OrderState[] = [];
  for (const status of ORDER_STATUSES) {
    const prices = status === "requested" ? [null] : status === "cancelled" ? [null, 1000] : [1000];
    for (const price of prices) for (const claim of claims()) for (const namePrice of [800, 1000, 1200])
    for (const lateEvaluated of [false, true]) for (const eligible of [true, false])
    for (const reasons of [[], ["issuance"]]) {
      const s: OrderState = {
        order: { oid: "o1", name: "one@space", status, price, eligible, lateEvaluated, reasons,
                 priceReserve: FULFILLABLE.includes(status) && price !== null ? price : 0,
                 destination: price === null ? null : DEST },
        name: { name: "one@space", price: namePrice, claim },
      };
      if (invariantViolations(s).length === 0) out.push(s);
    }
  }
  return out;
}

function observations(): Observation[] {
  const out: Observation[] = [];
  for (const now of [0, 899, 900, 2000]) for (const tip of [10, 16, 17, 30])
  for (const paymentSeen of [false, true])
  for (const [confirmed, batchable] of [[0, 0], [500, 0], [1000, 0], [1000, 1000], [1500, 1500]] as const) {
    if (!paymentSeen && confirmed > 0) continue;
    out.push({ now, tip, paymentSeen, confirmed, batchable });
  }
  return out;
}

const EVENTS: OrderEvent[] = [
  { type: "evaluate" }, { type: "quote", destination: DEST }, { type: "cancel" },
  { type: "markIssuing", recipientBlocked: false }, { type: "markIssuing", recipientBlocked: true },
  { type: "restoreIssuing" }, { type: "unissue" }, { type: "markReady" }, { type: "unready" },
  { type: "markFulfilled" }, { type: "invalidateEligibility" },
];

const NAME_EVENTS: readonly OrderEventType[] = ["evaluate", "quote", "cancel"];

test("every event over the grid keeps the invariants and uses only listed edges", () => {
  const reached = new Set<string>();
  const key = (type: OrderEventType, [f, t]: Edge) => `${type}:${f}->${t}`;
  const problems: string[] = [];
  let transitions = 0;
  const grid = states();
  for (const s of grid) for (const o of observations()) for (const e of EVENTS) {
    const out = transition(s, e, o, POLICY);  // throws on an unlisted edge
    transitions++;
    if (!out.ok) continue;
    for (const edge of out.edges) reached.add(key(e.type, edge));
    for (const bad of invariantViolations(out.state)) {
      if (problems.length < 5) problems.push(`${e.type} from ${JSON.stringify(s)} at `
        + `${JSON.stringify(o)}: ${bad}`);
    }
    if (!NAME_EVENTS.includes(e.type)) assert.deepEqual(out.state.name, s.name);
    if (e.type === "evaluate") {
      // Evaluation reaches a fixed point at one observation: the store can
      // run it any number of times.
      const again = transition(out.state, e, o, POLICY);
      assert.ok(again.ok);
      if (JSON.stringify(again.state) !== JSON.stringify(out.state) && problems.length < 5) {
        problems.push(`evaluate isn't idempotent from ${JSON.stringify(s)} at ${JSON.stringify(o)}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  const listed = Object.entries(ORDER_EDGES).flatMap(
    ([type, edges]) => edges.map((edge) => key(type as OrderEventType, edge)));
  assert.deepEqual(listed.filter((k) => !reached.has(k)), [],
                   "ORDER_EDGES lists edges that no transition makes");
  console.log(`grid: ${grid.length} states, ${transitions} transitions, ${reached.size} edges`);
});

test("every status but requested is entered by some edge", () => {
  const entered = new Set<OrderStatus>(Object.values(ORDER_EDGES).flat().map(([, t]) => t));
  assert.deepEqual(ORDER_STATUSES.filter((s) => !entered.has(s)), ["requested"]);
});
