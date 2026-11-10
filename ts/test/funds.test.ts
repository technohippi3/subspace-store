// The funds machine on its own: named scenarios from PAYMENT-SPEC.md's
// refund rules. These are tests of the TypeScript port, not model results
// and not regtest evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Funds, type FundsEvent, type FundsObservation, type FundsOutcome, type RefundTx,
  available, deficits, fundsTransition, fundsViolations, reserved,
} from "../src/funds.ts";

const POLICY = { excessMinimumOverFee: 546 };

function tx(txid: string, coin: string, value: number): RefundTx {
  return { txid, inputs: [[coin, 0]], outputs: [["refund-addr", value]], raw: null };
}

const OWN = "5120" + "cd".repeat(32);

/** A converted order priced 10,000, paid 13,000 at settled depth. */
function paid(status: Funds["order"]["status"] = "converted"): Funds {
  return { order: { oid: "o1", status, priceReserve: status === "converted" ? 10_000 : 0,
                    reasons: [], losses: {}, destinationScript: OWN, refundTo: null },
           groups: [] };
}

function obs(o: Partial<FundsObservation> = {}): FundsObservation {
  return { payments: [{ value: 10_000, conf: 6 }, { value: 3_000, conf: 6 }], txs: {},
           spenders: {}, ...o };
}

function run(f: Funds, e: FundsEvent, o: FundsObservation = obs()): FundsOutcome {
  const out = fundsTransition(f, e, o, POLICY);
  assert.deepEqual(fundsViolations(out.funds), []);
  return out;
}

const OPEN_TX = tx("a1", "pay2", 2_700);
const OPEN_EXCESS: FundsEvent = { type: "openGroup", gid: "g1", kind: "excess",
                                  tx: OPEN_TX, toBuyer: 2_700, fee: 300,
                                  charged: null };

test("only settled funds above the price reserve are available, less reservations", () => {
  const f = paid();
  assert.equal(available(f, obs()), 3_000);
  assert.equal(available(f, obs({ payments: [{ value: 13_000, conf: 5 }] })), -10_000);
  const opened = run(f, OPEN_EXCESS);
  assert.equal(opened.refusal, null);
  assert.deepEqual(opened.effects, [{ type: "authorize", gid: "g1", amount: 3_000,
                                      available: 3_000 }]);
  assert.equal(reserved(opened.funds), 3_000);
  assert.equal(available(opened.funds, obs()), 0);
});

test("opening a refund refuses what the rules refuse, and changes nothing", () => {
  const f = paid();
  const refusal = (e: Partial<Extract<FundsEvent, { type: "openGroup" }>>, fx = f) => {
    const out = run(fx, { ...OPEN_EXCESS, ...e } as FundsEvent);
    assert.deepEqual(out.funds, fx);
    return out.refusal;
  };
  assert.equal(refusal({ kind: "gift" }), "unknown refund kind");
  assert.equal(refusal({ kind: "cancellation" }), "order is not cancelled or refund due");
  assert.equal(refusal({ toBuyer: 2_800 }), "not enough settled funds");
  assert.equal(refusal({ fee: 2_500, toBuyer: 100 }), "excess below the refund minimum");
  // Available 3,000: a fee of 2,454 plus the 546 minimum is exactly enough.
  assert.equal(refusal({ fee: 2_455, toBuyer: 545 }), "excess below the refund minimum");
  assert.equal(run(f, { ...OPEN_EXCESS, fee: 2_454, toBuyer: 546 }).refusal, null);
  assert.equal(refusal({}, { ...f, order: { ...f.order, reasons: ["refunds"] } }),
               "refunds are reconciling");
  assert.equal(refusal({}, run(f, OPEN_EXCESS).funds), "group exists");
});

test("nothing leaves the store until the group's entry is acknowledged", () => {
  const opened = run(paid(), OPEN_EXCESS).funds;
  assert.equal(run(opened, { type: "beginBroadcast", gid: "g1", txid: "a1" }).refusal,
               "journal entry not acknowledged off-host");
  assert.equal(run(opened, { type: "exportPsbt", txid: "a1" }).refusal,
               "journal entry not acknowledged off-host");
  const journaled = run(opened, { type: "journaled", gids: ["g1"] }).funds;
  const begun = run(journaled, { type: "beginBroadcast", gid: "g1", txid: "a1" });
  assert.deepEqual(begun.effects, [{ type: "send", gid: "g1", tx: OPEN_TX }]);
  assert.equal(begun.funds.groups[0]?.attempts[0].attempted, true);
  // A lost answer leaves it attempted and unacknowledged.
  const lost = run(begun.funds, { type: "broadcastAnswered", txid: "a1", sent: false });
  assert.equal(lost.funds.groups[0]?.attempts[0].acknowledged, false);
  // After a restart, an attempted broadcast found nowhere is sent again; one
  // never attempted isn't.
  const nowhere = obs({ txs: { a1: { conf: 0, known: false } } });
  assert.deepEqual(run(journaled, { type: "reconcile" }, nowhere).effects, []);
  assert.deepEqual(run(lost.funds, { type: "reconcile" }, nowhere).effects,
                   [{ type: "rebroadcast", gid: "g1", tx: OPEN_TX }]);
  const seen = run(lost.funds, { type: "reconcile" }, obs({ txs: { a1: { conf: 1, known: true } } }));
  assert.deepEqual(seen.effects, []);
  assert.equal(seen.funds.groups[0]?.attempts[0].acknowledged, true);
});

test("a settled attempt closes its group; losing that depth reopens it", () => {
  const f = run(paid(), OPEN_EXCESS).funds;
  const settled = obs({ txs: { a1: { conf: 6, known: true } }, spenders: { "pay2:0": "a1" } });
  const closed = run(f, { type: "evaluate" }, settled).funds;
  assert.equal(closed.groups[0]?.closedBy, "a1");
  assert.equal(reserved(closed), 0);
  const shallow = obs({ txs: { a1: { conf: 5, known: true } }, spenders: { "pay2:0": "a1" } });
  assert.equal(run(closed, { type: "evaluate" }, shallow).funds.groups[0]?.closedBy, null);
});

test("a settled spend outside the group marks it for rebuilding", () => {
  const f = run(paid(), OPEN_EXCESS).funds;
  const conflict = obs({ txs: { a1: { conf: 0, known: false }, c1: { conf: 6, known: true } },
                         spenders: { "pay2:0": "c1" } });
  assert.equal(run(f, { type: "evaluate" }, conflict).funds.groups[0]?.needsRebuild, true);
});

test("a bump needs capacity only for its increase; a non-exclusive one pauses", () => {
  const f = run(paid(), OPEN_EXCESS).funds;
  const bump = (charged: number, exclusive: boolean) => run(f, {
    type: "addAttempt", gid: "g1", tx: tx("a2", "pay2", 2_400), toBuyer: 2_400, fee: 600,
    charged, exclusiveWith: { a1: exclusive } }, obs({ spenders: { "pay2:0": null } }));
  const same = bump(3_000, true);
  assert.deepEqual(same.effects, [{ type: "authorize", gid: "g1", amount: 0, available: 0 }]);
  assert.equal(same.funds.groups[0]?.attempts.length, 2);
  assert.equal(bump(3_001, true).refusal, "not enough settled funds for the increase");
  const paused = bump(3_000, false);
  assert.equal(paused.refusal, "not mutually exclusive with every attempt; paused");
  assert.equal(paused.funds.groups[0]?.paused, true);
  assert.deepEqual(paused.effects, [{ type: "alert", oid: "o1", kind: "refund_paused",
                                      detail: "g1" }]);
});

test("a deficit becomes a reason, alerted once, until recorded as a loss", () => {
  // Issued, but the payment fell below batchable depth.
  const f: Funds = { ...paid(), order: { ...paid().order, status: "issuing" } };
  const shallow = obs({ payments: [{ value: 10_000, conf: 2 }] });
  assert.deepEqual(deficits(f, shallow).post_issuance_deficit, 10_000);
  const first = run(f, { type: "evaluate" }, shallow);
  assert.deepEqual(first.funds.order.reasons, ["post_issuance_deficit"]);
  assert.equal(first.effects.length, 1);
  assert.deepEqual(run(first.funds, { type: "evaluate" }, shallow).effects, []);
  const lost = run(first.funds, { type: "recordLoss", reason: "post_issuance_deficit" }, shallow);
  assert.deepEqual(lost.funds.order.losses, { post_issuance_deficit: 10_000 });
  assert.deepEqual(run(lost.funds, { type: "evaluate" }, shallow).funds.order.reasons, []);
  assert.equal(run(f, { type: "recordLoss", reason: "issuance" }, shallow).refusal,
               "no deficit to record");
});

test("a refund goes to the buyer's destination, never a payment address, fixed once built", () => {
  const f = paid();
  const set = (fx: Funds, script: string, paymentAddressInUse = false) =>
    run(fx, { type: "setRefundAddress", address: "made-up", script, paymentAddressInUse });
  const refused = "a refund never goes to one of the store's payment addresses";
  assert.equal(set(f, OWN).refusal, refused);
  // Another order's payment address, which only the store can see.
  const other = set(f, "5120" + "ef".repeat(32), true);
  assert.equal(other.refusal, refused);
  assert.deepEqual(other.funds, f);
  const buyer = "0014" + "11".repeat(20);
  const given = set(f, buyer);
  assert.equal(given.refusal, null);
  assert.deepEqual(given.funds.order.refundTo, { address: "made-up", script: buyer });
  const changed = set(given.funds, "0014" + "22".repeat(20));
  assert.equal(changed.refusal, null);
  const built = run(changed.funds, OPEN_EXCESS).funds;
  const late = set(built, "0014" + "33".repeat(20));
  assert.equal(late.refusal, "a refund has been built; its destination is fixed");
  assert.deepEqual(late.funds, built);
});
