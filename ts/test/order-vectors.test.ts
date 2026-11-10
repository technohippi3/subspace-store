// Replays the Python service ledger's own order transitions through the
// order machine (tools/ledger_vectors.py --family order). Agreement is
// equivalence to the Python service: not a model result and not regtest
// evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Claim, type Destination, type OrderEvent, type OrderState, type OrderStatus,
  type Refusal, invariantViolations, transition,
} from "../src/order.ts";
import { describeSources, recordVectors } from "./ledger-vectors.ts";

interface PyOrder {
  oid: string; name: string; status: OrderStatus; price: number | null;
  price_reserve: number; late_evaluated: number; eligible: number; reasons: string[];
  dest_address: string | null; dest_script: string | null;
}
interface PyName {
  name: string; price: number; hold_order: string | null; hold_expires_at: number | null;
  hold_seen_height: number | null; hold_latched: number | null;
  fulfillment_order: string | null;
}
interface PyState { order: PyOrder; name: PyName }
interface Vector {
  kind: string;
  before: PyState;
  observation: { now: number; tip: number; payment_seen: boolean; confirmed: number;
                 batchable: number; recipient_blocked: boolean };
  event: { hold_seconds: number; destination?: Destination };
  outcome: { after: PyState | null; refusal: string | null };
  source: "directed" | "generated" | null;
}

const COMMAND_KINDS = ["quote", "cancel", "mark_issuing", "restore_issuing", "unissue",
                       "mark_ready", "unready", "mark_fulfilled", "invalidate_eligibility"];
const STATUSES: readonly OrderStatus[] = ["requested", "quoted", "converted", "issuing", "ready",
  "fulfilled", "cancelled", "refund_due", "unpaid"];

const MACHINE_REFUSALS: readonly string[] = [
  "already quoted", "taken for now", "not cancellable once issuing", "not converted",
  "batch entry refused", "not issuing", "not ready",
] satisfies readonly Refusal[];

// Store-wide guards that run before the machine's own (ts/src/order.ts).
const STORE_GUARDS: readonly string[] = [
  "the off-host journal is unavailable; no quote was made",
  "script already used", "recipient not accepted", "sales are paused",
  "sales are paused: the store is at its exposure limit",
];

/** The Python rows as the machine's state. Anything the machine's types
 * can't represent throws, so a difference can't hide in a field dropped
 * on the way. */
function toState(s: PyState): OrderState {
  const o = s.order;
  const n = s.name;
  if ((o.dest_address === null) !== (o.dest_script === null)) {
    throw new Error(`${o.oid}: an address without its script, or the reverse`);
  }
  let claim: Claim;
  if (n.hold_order !== null && n.fulfillment_order !== null) {
    throw new Error(`${n.name}: both held and reserved`);
  } else if (n.hold_order !== null) {
    if (n.hold_expires_at === null) throw new Error(`${n.name}: a hold without an expiry`);
    claim = { kind: "held", hold: {
      order: n.hold_order, expiresAt: n.hold_expires_at, seenHeight: n.hold_seen_height,
      latched: n.hold_latched === null ? null : n.hold_latched !== 0 } };
  } else {
    if (n.hold_expires_at !== null || n.hold_seen_height !== null || n.hold_latched !== null) {
      throw new Error(`${n.name}: hold fields left on a name with no hold`);
    }
    claim = n.fulfillment_order !== null
      ? { kind: "reserved", order: n.fulfillment_order } : { kind: "free" };
  }
  return {
    order: {
      oid: o.oid, name: o.name, status: o.status, price: o.price,
      priceReserve: o.price_reserve, lateEvaluated: o.late_evaluated !== 0,
      eligible: o.eligible !== 0, reasons: o.reasons,
      destination: o.dest_address === null || o.dest_script === null
        ? null : { address: o.dest_address, script: o.dest_script },
    },
    name: { name: n.name, price: n.price, claim },
  };
}

const UNUSED: Destination = { address: "unused-address", script: "unused-script" };

function toEvent(v: Vector): OrderEvent {
  switch (v.kind) {
    case "evaluate": return { type: "evaluate" };
    case "quote": return { type: "quote", destination: v.event.destination ?? UNUSED };
    case "cancel": return { type: "cancel" };
    case "mark_issuing":
      return { type: "markIssuing", recipientBlocked: v.observation.recipient_blocked };
    case "restore_issuing": return { type: "restoreIssuing" };
    case "unissue": return { type: "unissue" };
    case "mark_ready": return { type: "markReady" };
    case "unready": return { type: "unready" };
    case "mark_fulfilled": return { type: "markFulfilled" };
    case "invalidate_eligibility": return { type: "invalidateEligibility" };
    default: throw new Error(`unknown vector kind ${v.kind}`);
  }
}

test("the order machine makes the Python ledger's transitions", () => {
  const rec = recordVectors<Vector>("order");
  assert.deepEqual(rec.conflicts, [], "the ledger gave two outcomes for one vector");
  assert.ok(rec.vectors.length > 0, "no vectors recorded");
  // The directed runs reach every command from every status.
  const directed = new Set(rec.vectors.filter((v) => v.source === "directed")
    .map((v) => `${v.kind} from ${v.before.order.status}`));
  assert.deepEqual(COMMAND_KINDS.flatMap((k) => STATUSES.map((s) => `${k} from ${s}`))
    .filter((pair) => !directed.has(pair)), [], "commands the directed runs didn't reach");

  const failures: string[] = [];
  const fail = (v: Vector, why: string) => {
    if (failures.length < 5) failures.push(`${v.kind} ${v.before.order.oid}: ${why}\n`
      + JSON.stringify({ before: v.before, observation: v.observation, event: v.event,
                         outcome: v.outcome }));
    else failures.push("");
  };
  let replayed = 0;
  let storeGuarded = 0;

  for (const v of rec.vectors) {
    const before = toState(v.before);
    for (const bad of invariantViolations(before)) fail(v, `before: ${bad}`);
    const obs = { now: v.observation.now, tip: v.observation.tip,
                  paymentSeen: v.observation.payment_seen,
                  confirmed: v.observation.confirmed, batchable: v.observation.batchable };
    const got = transition(before, toEvent(v), obs, { holdSeconds: v.event.hold_seconds });
    const { after, refusal } = v.outcome;
    if (refusal !== null && !MACHINE_REFUSALS.includes(refusal)) {
      if (!STORE_GUARDS.includes(refusal)) fail(v, `unknown refusal ${JSON.stringify(refusal)}`);
      storeGuarded++;
      continue;
    }
    replayed++;
    if (refusal !== null) {
      if (got.ok) fail(v, `the ledger refused (${refusal}), the machine didn't`);
      else if (got.refusal !== refusal) fail(v, `refused ${got.refusal}, not ${refusal}`);
      continue;
    }
    if (!got.ok) { fail(v, `the machine refused (${got.refusal}), the ledger didn't`); continue; }
    if (after === null) { fail(v, "no state after an accepted command"); continue; }
    const expected = toState(after);
    try {
      assert.deepEqual(got.state, expected);
    } catch {
      fail(v, `state differs: machine ${JSON.stringify(got.state)}`);
    }
    for (const bad of invariantViolations(got.state)) fail(v, `after: ${bad}`);
  }

  console.log(describeSources(rec));
  console.log(`order vectors: ${rec.calls} transitions, ${rec.unique} unique, ${replayed} replayed, `
    + `${storeGuarded} refused by store-wide guards (not the machine's), `
    + `counts ${JSON.stringify(rec.counts)}`);
  assert.equal(failures.length, 0,
    `${failures.length} vectors disagree; the first:\n${failures.filter(Boolean).join("\n\n")}`);
});
