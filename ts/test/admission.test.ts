// Recipient checks and quote admission on their own. Tests of the
// TypeScript port, not model results and not regtest evidence.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AT_EXPOSURE_LIMIT, type Destination, type DestinationStep, JOURNAL_DOWN, ONLY_HELD,
  type QuoteContext, SALES_PAUSED, admitQuote, admitRequest, considerDestination, exposure,
  startDestinationSearch,
} from "../src/admission.ts";
import type { OrderStatus } from "../src/order.ts";
import {
  canonicalHandle, conflicting, recipientBlock, recipientProblem, validP2tr,
} from "../src/recipient.ts";
import type { OrderSummary, StoreView } from "../src/view.ts";

const key = (x: number) => "5120" + x.toString(16).padStart(64, "0");
const S = key(1);   // x = 1 lifts to a curve point
const S2 = key(2);

function order(oid: string, name: string, status: OrderStatus, o: Partial<OrderSummary> = {}):
    OrderSummary {
  const paid = status !== "requested";
  return { oid, seq: Number(oid.slice(1)), name, status, price: paid ? 10_000 : null,
           recipientScript: S, destinationScript: paid ? `dest-${oid}` : null,
           refundScript: null, recipientProblem: null, seen: 0, ...o };
}

function view(orders: OrderSummary[], holds: Record<string, string> = {},
              reserved: Record<string, string> = {}): StoreView {
  const names = Object.fromEntries(["one@space", "two@space", "three@space"].map((n) => [n, {
    name: n, price: 10_000, holdOrder: holds[n] ?? null, fulfillmentOrder: reserved[n] ?? null }]));
  return { orders, names, refundedTotal: 0 };
}

const OPEN: QuoteContext = { salesPaused: false, exposureLimit: null, exposureAlerted: false,
                             journalAvailable: true };

test("handles and scripts must be canonical, never corrected", () => {
  for (const h of ["one@space", "a-b@c-d", "0@x"]) assert.ok(canonicalHandle(h), h);
  for (const h of ["One@space", " one@space", "one@space\n", "-one@space", "one-@space",
                   "@one@space", "one", "oné@space", 7]) {
    assert.ok(!canonicalHandle(h), JSON.stringify(h));
  }
  assert.ok(validP2tr(S));
  assert.ok(validP2tr(key(0xc)));
  for (const s of [key(5), key(7), "5120" + "ff".repeat(32), key(0xc).toUpperCase(), S.slice(0, -2),
                   S + "00", "0014" + "11".repeat(20), "5220" + S.slice(4), null]) {
    assert.ok(!validP2tr(s), String(s));
  }
});

test("a request is refused for a payment script or a script a paid order claims", () => {
  const v = view([order("o1", "one@space", "converted"), order("o2", "two@space", "quoted",
                                                               { recipientScript: S2 })]);
  assert.deepEqual(admitRequest(v, "two@space", S), { kind: "refused", reason: "script already used" });
  assert.deepEqual(admitRequest(v, "one@space", S), { kind: "accepted" });  // a retry
  assert.deepEqual(admitRequest(v, "three@space", "dest-o2"),
                   { kind: "invalid", reason: "script_pubkey must be a 34-byte P2TR script with a valid key" });
  assert.deepEqual(admitRequest(v, "three@space", S2), { kind: "accepted" });  // an unpaid quote claims nothing
  assert.deepEqual(admitRequest(v, "four@space", S2), { kind: "refused", reason: "not for sale" });
  const cancelled = view([order("o1", "one@space", "cancelled")]);
  assert.deepEqual(admitRequest(cancelled, "two@space", S), { kind: "accepted" });
});

test("two paid orders for different handles on one script block each other", () => {
  const a = order("o1", "one@space", "converted");
  const b = order("o2", "two@space", "converted");
  const v = view([a, b]);
  assert.deepEqual(conflicting(v, a), ["o2"]);
  assert.equal(recipientBlock(v, a), "script conflict");
  // An issuing order yields only to another issuing one.
  const issuing = { ...a, status: "issuing" as const };
  assert.equal(recipientBlock(view([issuing, b]), issuing), null);
  assert.equal(recipientBlock(v, { ...a, recipientProblem: "invalid script" }), "invalid script");
});

test("a quote's guards run in the service's order", () => {
  const req = order("o1", "one@space", "requested");
  const v = view([req]);
  assert.deepEqual(admitQuote(v, "o1", OPEN), { kind: "proceed" });
  const refused = (reason: string, ctx: QuoteContext = OPEN, w: StoreView = v) => {
    const got = admitQuote(w, "o1", ctx);
    assert.equal(got.kind === "refused" ? got.reason : got.kind, reason);
  };
  refused("already quoted", OPEN, view([order("o1", "one@space", "unpaid")]));
  refused("recipient not accepted", OPEN, view([{ ...req, recipientProblem: "invalid script" }],
                                               { "one@space": "o9" }));
  refused("taken for now", { ...OPEN, salesPaused: true }, view([req], { "one@space": "o9" }));
  refused(SALES_PAUSED, { ...OPEN, salesPaused: true, journalAvailable: false });
  refused(JOURNAL_DOWN, { ...OPEN, journalAvailable: false });
  // The quote asked again while it holds its name: no pause or journal stops it.
  const held = view([order("o1", "one@space", "quoted")], { "one@space": "o1" });
  assert.deepEqual(admitQuote(held, "o1", { ...OPEN, salesPaused: true, journalAvailable: false }),
                   { kind: "requote" });
  // But the recipient checks still apply to it (V17).
  const claimed = view([order("o1", "one@space", "quoted"), order("o2", "two@space", "converted")],
                       { "one@space": "o1" }, { "two@space": "o2" });
  refused("script already used", OPEN, claimed);
});

test("the exposure limit counts unpaid invoices whole, and alerts once", () => {
  const v = view([order("o1", "one@space", "converted", { seen: 10_000 }),
                  order("o2", "two@space", "quoted", { seen: 1_000, recipientScript: S2 }),
                  order("o3", "three@space", "requested", { recipientScript: key(3) })],
                 { "two@space": "o2" }, { "one@space": "o1" });
  assert.equal(exposure(v), 10_000 + 1_000 + 9_000);
  const ctx = { ...OPEN, exposureLimit: 25_000 };
  const first = admitQuote(v, "o3", ctx);
  assert.deepEqual(first, { kind: "refused", reason: AT_EXPOSURE_LIMIT, exposureAlerted: true,
    alerts: [{ oid: "o3", kind: "exposure_limit",
               detail: { exposure_sats: 20_000, price_sats: 10_000, limit_sats: 25_000 } }] });
  const again = admitQuote(v, "o3", { ...ctx, exposureAlerted: true });
  assert.deepEqual(again.kind === "refused" && again.alerts, []);
  assert.deepEqual(admitQuote(v, "o3", { ...ctx, exposureLimit: 30_000 }), { kind: "proceed" });
});

/** The search driven as the store drives it, from a list of addresses the
 * wallet gives out in turn. */
function search(v: StoreView, oid: string, scripts: string[]): DestinationStep {
  let step = startDestinationSearch(v, oid);
  let i = 0;
  while (step.kind === "draw") {
    step = considerDestination(step.search, { address: `a${i}`, script: scripts[i] ?? "never" });
    i++;
  }
  return step;
}

test("a payment address is never one an order holds, for payment or refund", () => {
  const v = view([order("o1", "one@space", "quoted", { refundScript: "refund-o1" }),
                  order("o2", "two@space", "requested")]);
  assert.deepEqual(search(v, "o2", ["fresh"]), { kind: "chosen",
    destination: { address: "a0", script: "fresh" }, skipped: 0, alerts: [] });
  assert.deepEqual(search(v, "o2", ["dest-o1", "refund-o1", "fresh"]), { kind: "chosen",
    destination: { address: "a2", script: "fresh" }, skipped: 2,
    alerts: [{ oid: "o2", kind: "destination_held", detail: { skipped: 2 } }] });
  // Two addresses held, so three draws at most.
  assert.deepEqual(search(v, "o2", ["dest-o1", "refund-o1", "dest-o1", "fresh"]),
                   { kind: "refused", reason: ONLY_HELD });
});

test("the search waits on the wallet without the rules waiting on it", async () => {
  const v = view([order("o1", "one@space", "quoted"), order("o2", "two@space", "requested")]);
  const offers = ["dest-o1", "fresh"];
  // A wallet behind an asynchronous RPC.
  const wallet = async (): Promise<Destination> => {
    await Promise.resolve();
    return { address: "rpc", script: offers.shift() ?? "never" };
  };
  let step = startDestinationSearch(v, "o2");
  while (step.kind === "draw") step = considerDestination(step.search, await wallet());
  assert.equal(step.kind === "chosen" && step.destination.script, "fresh");
});

test("the start-up audit judges a stored recipient by today's rules", () => {
  const dests = new Set(["dest-o9"]);
  const judge = (name: string, recipientScript: string) =>
    recipientProblem({ name, recipientScript }, dests);
  assert.equal(judge("one@space", S), null);
  for (const name of ["One@space", "one@space\n", "one"]) assert.equal(judge(name, S), "invalid handle");
  for (const s of ["6a" + "00".repeat(33), key(5), "0014" + "11".repeat(20)]) {
    assert.equal(judge("one@space", s), "invalid script");
  }
  assert.equal(judge("one@space", key(3)), null);
  assert.equal(recipientProblem({ name: "one@space", recipientScript: key(3) }, new Set([key(3)])),
               "store destination script");
  // A malformed handle is reported before anything else.
  assert.equal(judge("One@space", "6a00"), "invalid handle");
});
