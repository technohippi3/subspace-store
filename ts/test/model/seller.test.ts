import test from "node:test";
import assert from "node:assert/strict";
import { Seller, type Limits, type Order, type Payment, type Refund, type OwnerIntent, type OwnerContext } from "../../model/seller.ts";

// Fixture examples only. Every actual installation supplies explicit values.
const limits: Limits = { riskBudget: 1_000_000, requestWindowSeconds: 3600, requestsPerWindow: 120, maximumOrders: 1000 };
function fixture(overrides: Partial<Limits> = {}): Seller {
  const seller = new Seller({ ...limits, ...overrides });
  seller.setup("space"); seller.setup("other");
  for (let i = 0; i < 20; i++) { seller.list(`n${i}@space`, 1000); seller.list(`n${i}@other`, 1000); }
  seller.pause(false);
  return seller;
}
function invoice(s: Seller, handle = "n0@space", recipient?: string): Order {
  const request = s.request(handle, recipient ?? `recipient-${s.snapshot().nextOrder}`);
  return s.quote(request.id);
}
function payment(o: Order, confirmations = 3, sats = 1000): Payment {
  return { outpoint: `payment-${o.id}`, order: o.id, sats, confirmations };
}
function payFirst(s: Seller, handle = "n0@space"): Order {
  s.cancel(invoice(s, handle).id); s.cancel(invoice(s, handle).id);
  const order = invoice(s, handle); assert.equal(order.payFirst, true); assert.equal(s.active(order.id), false);
  return order;
}
function refundedFixture(): { seller: Seller; first: Order; second: Order; refunds: Refund[] } {
  const seller = fixture(), first = invoice(seller), second = invoice(seller, "n1@space");
  seller.observe(10, 20, [payment(first, 6), payment(second, 6)]);
  seller.cancel(first.id); seller.cancel(second.id);
  const refunds: Refund[] = [
    { group: "g1", order: first.id, txid: "transaction-one", bytes: "signed-one", principal: 1000,
      attempted: true, seen: "mined", confirmations: 6, reserved: 0, refunded: 1000, sendCalls: 1 },
    { group: "g2", order: second.id, txid: "transaction-two", bytes: "signed-two", principal: 1000,
      attempted: true, seen: "absent", confirmations: 0, reserved: 1000, refunded: 0, sendCalls: 1 },
  ];
  refunds.forEach(r => seller.recordRefund(r));
  return { seller, first, second, refunds };
}

test("K22: first and later space setup is repeatable and preserves existing policies and financial identifiers", () => {
  const s = new Seller(limits);
  assert.equal(s.snapshot().paused, true);
  assert.throws(() => s.list("first@space", 1000), /unknown space/);
  s.setup("space"); s.list("first@space", 1000); s.pause(false);
  const order = invoice(s, "first@space");
  s.observe(1, 10, [payment(order)]); s.beginIssuance(order.id); s.deliver(order.id, "certificate-one");
  s.pause(true, "space");
  const before = s.snapshot();
  s.setup("space"); assert.deepEqual(s.snapshot(), before);
  s.setup("later"); s.list("first@later", 2000);
  assert.deepEqual(s.order(order.id), before.orders[0]);
  assert.deepEqual(s.snapshot().payments, before.payments);
  assert.deepEqual(s.snapshot().conversions, before.conversions);
  assert.equal(s.snapshot().nextDestination, before.nextDestination);
  assert.equal(s.snapshot().spaces.find(v => v.space === "space")!.paused, true);
  assert.equal(invoice(s, "first@later").price, 2000);
  for (const space of ["UPPER", "@space", "a.b", " space", "space\n", "-space"])
    assert.throws(() => s.setup(space), /invalid space/);
});

test("K23: seller price changes preserve initial quotes and retain lower and higher late-price outcomes and the global formula", () => {
  const initial = fixture(), held = invoice(initial);
  initial.list(held.handle, 2000);
  assert.equal(initial.quote(held.id).quotedPrice, 1000);
  initial.observe(100, 10, [payment(held)]);
  assert.equal(initial.order(held.id).state, "converted"); assert.equal(initial.order(held.id).price, 1000);
  for (const price of [700, 2000]) {
    const s = fixture(), late = invoice(s);
    s.observe(900, 10, []); assert.equal(s.order(late.id).state, "unpaid");
    s.list(late.handle, price); s.observe(901, 11, [payment(late)]);
    assert.equal(s.order(late.id).state, price === 700 ? "converted" : "refund_due");
    assert.equal(s.order(late.id).price, price === 700 ? 700 : 1000);
    assert.equal(s.order(late.id).destination, late.destination);
  }
  const bounded = fixture({ riskBudget: 15_000 });
  assert.equal(bounded.exposureLimit(), 10_000);
  bounded.list("premium@other", 2000); assert.equal(bounded.exposureLimit(), 15_000);
  bounded.list("premium@other", 1200); assert.equal(bounded.exposureLimit(), 12_000);
  assert.throws(() => bounded.list("premium@other", 0), /invalid integer/);
});

test("K24: seller reservation blocks new invoices and unheld acquisition without revoking valid holds or fulfillment", () => {
  const s = fixture(), held = invoice(s), next = s.request(held.handle, "next-recipient");
  s.reserve(held.handle, true);
  const before = s.snapshot();
  assert.throws(() => s.quote(next.id), /name unavailable/); assert.deepEqual(s.snapshot(), before);
  s.observe(100, 10, [payment(held)]);
  assert.equal(s.order(held.id).state, "converted");
  s.beginIssuance(held.id); s.deliver(held.id, "certificate-held");
  s.reserve(held.handle, false);
  assert.throws(() => s.quote(next.id), /name taken/);
  assert.equal(s.order(held.id).certificate, "certificate-held");

  const late = fixture(), old = invoice(late);
  late.observe(900, 10, []); late.reserve(old.handle, true);
  late.observe(901, 11, [payment(old)]);
  assert.equal(late.order(old.id).state, "refund_due");
  late.reserve(old.handle, false); late.observe(902, 12, [payment(old, 4)]);
  assert.equal(late.order(old.id).state, "refund_due");
  assert.equal(invoice(late, old.handle).state, "quoted");
});

test("K25: withdrawal preserves active hold extensions and fulfilled commitments but expired invoices remain refund-only", () => {
  const s = fixture(), old = invoice(s);
  s.observe(100, 10, [payment(old, 0, 100)]); s.withdraw(old.handle, true);
  assert.equal(s.active(old.id), true);
  s.observe(900, 16, [payment(old, 0, 100)]); assert.equal(s.active(old.id), true);
  s.observe(901, 17, []); assert.equal(s.active(old.id), false); assert.equal(s.refundOnly(old.id), true);
  assert.throws(() => invoice(s, old.handle), /name unavailable/);
  s.withdraw(old.handle, false); s.observe(902, 18, [payment(old)]);
  assert.equal(s.order(old.id).state, "refund_due"); assert.equal(s.order(old.id).destination, old.destination);
  const fresh = invoice(s, old.handle); assert.notEqual(fresh.destination, old.destination);

  const fulfilled = fixture(), paid = invoice(fulfilled);
  fulfilled.observe(1, 10, [payment(paid)]); fulfilled.beginIssuance(paid.id); fulfilled.deliver(paid.id, "certificate-permanent");
  const commitment = fulfilled.order(paid.id);
  fulfilled.withdraw(paid.handle, true); fulfilled.withdraw(paid.handle, false);
  assert.deepEqual(fulfilled.order(paid.id), commitment);
  assert.throws(() => invoice(fulfilled, paid.handle), /name taken/);
});

test("K26: reopening before or after expiry never revives the original withdrawn invoice or another buyer's ownership", () => {
  for (const reopenedAt of [100, 900, 1000]) for (const anotherBuyer of [false, true]) {
    const s = fixture(), old = invoice(s);
    s.withdraw(old.handle, true); s.observe(reopenedAt, 10, []); s.withdraw(old.handle, false);
    s.observe(Math.max(900, reopenedAt), 11, []);
    const fresh = anotherBuyer ? invoice(s, old.handle) : null;
    const facts = [payment(old), ...(fresh ? [payment(fresh)] : [])];
    s.observe(Math.max(901, reopenedAt + 1), 12, facts);
    assert.equal(s.order(old.id).state, "refund_due");
    assert.equal(s.order(old.id).withdrawalAt, 0); assert.equal(s.order(old.id).destination, old.destination);
    if (fresh) assert.equal(s.order(fresh.id).state, "converted");
    else assert.equal(invoice(s, old.handle).state, "quoted");
  }
});

test("K27: withdrawal honors an existing pay-first invoice only through its original quote window and protects an acquired hold", () => {
  const within = fixture(), onTime = payFirst(within);
  within.withdraw(onTime.handle, true); within.observe(899, 10, [payment(onTime, 1)]);
  assert.equal(within.active(onTime.id), true); assert.equal(within.refundOnly(onTime.id), false);
  within.observe(1000, 12, [payment(onTime, 3)]);
  assert.equal(within.order(onTime.id).state, "converted");
  for (const reopen of [false, true]) for (const arrivesAt of [900, 901]) {
    const s = fixture(), old = payFirst(s);
    s.withdraw(old.handle, true); if (reopen) s.withdraw(old.handle, false);
    s.observe(arrivesAt, 10, [payment(old)]);
    assert.equal(s.order(old.id).state, "refund_due"); assert.equal(s.active(old.id), false);
    assert.equal(s.order(old.id).holds.length, 0);
    s.withdraw(old.handle, false); s.observe(arrivesAt + 1, 11, [payment(old, 4)]);
    assert.equal(s.order(old.id).state, "refund_due");
  }
  const partial = fixture(), short = payFirst(partial);
  partial.withdraw(short.handle, true); partial.observe(899, 10, [payment(short, 1, 100)]);
  assert.equal(partial.active(short.id), false);
  partial.observe(900, 11, [payment(short, 2, 100),
    { outpoint: "partial-top-up", order: short.id, sats: 900, confirmations: 1 }]);
  assert.equal(partial.order(short.id).state, "refund_due");
});

test("K28: per-space pauses isolate new admission while hold, exposure and conversion review limits stay global", () => {
  const isolated = fixture(), held = invoice(isolated);
  isolated.pause(true, "space");
  assert.throws(() => invoice(isolated, "n1@space"), /sales paused/);
  assert.equal(invoice(isolated, "n0@other").state, "quoted");
  isolated.observe(1, 10, [payment(held)]); assert.equal(isolated.order(held.id).state, "converted");
  isolated.pause(true); assert.throws(() => invoice(isolated, "n1@other"), /sales paused/);

  const global = fixture(); global.list("premium@space", 2000);
  const orders: Order[] = [];
  for (let i = 0; i < 11; i++) orders.push(invoice(global, `n${i}@${i % 2 ? "space" : "other"}`));
  assert.equal(orders.filter(o => !o.payFirst).length, 10); assert.equal(orders[10]!.payFirst, true);
  global.observe(1, 10, orders.map(o => payment(o)));
  assert.equal(global.snapshot().conversions.length, 11); assert.equal(global.snapshot().paused, true);
  global.pause(false);
  assert.equal(invoice(global, "n12@other").state, "quoted");
  global.observe(2, 11, orders.map(o => payment(o, 4)));
  assert.equal(global.snapshot().paused, false);

  const ration = fixture(); payFirst(ration, "n0@space");
  assert.equal(invoice(ration, "n0@other").payFirst, false);
  const exposure = fixture(), funded = invoice(exposure);
  exposure.observe(1, 10, [payment(funded, 1, 10_000)]);
  assert.throws(() => invoice(exposure, "n0@other"), /exposure limit/);
});

test("K29: restore forces global pause and preserves space flags, seller policies, restrictions and existing obligations", () => {
  const s = fixture(), held = invoice(s), withdrawn = invoice(s, "n1@other");
  s.pause(true, "space"); s.reserve("n2@space", true); s.withdraw(withdrawn.handle, true);
  s.withdraw(withdrawn.handle, false);
  const before = s.snapshot(), restored = Seller.restore(before), after = restored.snapshot();
  assert.equal(after.paused, true);
  for (const key of ["spaces", "names", "orders", "payments", "conversions", "requestWindow", "nextOrder", "nextDestination"] as const)
    assert.deepEqual(after[key], before[key]);
  assert.throws(() => invoice(restored, "n3@other"), /sales paused/);
  restored.observe(1, 10, [payment(held)]); assert.equal(restored.order(held.id).state, "converted");
  restored.pause(false); assert.throws(() => invoice(restored, "n3@space"), /sales paused/);
  restored.observe(900, 11, [payment(held, 4)]);
  restored.observe(901, 12, [payment(held, 5), payment(withdrawn)]);
  assert.equal(restored.order(withdrawn.id).state, "refund_due");
});

test("K30: anonymous requests have aggregate creation limits without script identity claims or retry link reuse", () => {
  const s = fixture({ requestsPerWindow: 3 });
  const first = s.request("n0@space", "public-nomination"), retry = s.request("n0@space", "public-nomination");
  const differentHandle = s.request("n0@other", "public-nomination");
  assert.notEqual(first.token, retry.token); assert.notEqual(first.id, retry.id);
  assert.equal(differentHandle.recipient, first.recipient);
  const before = s.snapshot();
  assert.throws(() => s.request("n1@other", "different-public-nomination"), /request rate exceeded/);
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.snapshot().nextDestination, 1);
  assert.equal(s.snapshot().orders.every(o => o.state === "requested" && !o.destination && !o.holds.length), true);
  assert.equal(s.order(first.id).token, first.token); assert.equal(s.order(retry.id).token, retry.token);
  s.observe(3599, 10, []); assert.throws(() => s.request("n1@space", "new-script"), /request rate exceeded/);
  s.observe(3600, 11, []);
  const admitted = s.request("n1@space", "public-nomination"); assert.equal(admitted.sequence, 4);
  assert.deepEqual(s.snapshot().requestWindow, { startedAt: 3600, created: 1 });
});

test("K31: restart cannot reset request limits or retained-order capacity and refusals allocate no state", () => {
  const limited = fixture({ requestsPerWindow: 2, maximumOrders: 10 });
  const first = limited.request("n0@space", "same-script"), second = limited.request("n0@space", "same-script");
  const restarted = Seller.restore(limited.snapshot()), before = restarted.snapshot();
  assert.throws(() => restarted.request("n0@other", "new-script"), /request rate exceeded/);
  assert.deepEqual(restarted.snapshot(), before);
  restarted.observe(3600, 10, []); assert.equal(restarted.request("n0@other", "same-script").sequence, 3);
  assert.equal(restarted.order(first.id).token, first.token); assert.equal(restarted.order(second.id).token, second.token);

  const capacity = fixture({ requestsPerWindow: 2, maximumOrders: 2 });
  capacity.request("n0@space", "a"); capacity.request("n1@space", "b");
  const full = Seller.restore(capacity.snapshot()); full.observe(7200, 10, []);
  const fullBefore = full.snapshot();
  assert.throws(() => full.request("n0@other", "c"), /request capacity reached/);
  assert.deepEqual(full.snapshot(), fullBefore);
  for (const value of [0, -1, 1.5, Number.NaN]) assert.throws(() => new Seller({ ...limits, maximumOrders: value }), /invalid integer/);
  assert.throws(() => new Seller({ riskBudget: 1000 } as Limits), /explicit limits required/);
});

test("K32: restored startup reconciles exact refund history without sending and unknown attempts require attended exact-byte retry", () => {
  const { seller, refunds } = refundedFixture(), restored = Seller.restore(seller.snapshot());
  const initial = restored.snapshot(); assert.equal(initial.refunds.every(r => r.seen === "unknown"), true);
  assert.throws(() => restored.startup([{ group: "g1", txid: "transaction-one", seen: "mined", confirmations: 6 }]), /incomplete/);
  assert.deepEqual(restored.snapshot(), initial);
  const facts = [{ group: "g1", txid: "transaction-one", seen: "mined" as const, confirmations: 6 },
    { group: "g2", txid: "transaction-two", seen: "absent" as const, confirmations: 0 }];
  assert.deepEqual(restored.startup(facts), { ready: true, pending: ["g2"] });
  assert.deepEqual(restored.snapshot().refunds, refunds);
  restored.startup(facts); assert.deepEqual(restored.snapshot().refunds, refunds);
  const beforeRetry = restored.snapshot();
  for (const attempt of [() => restored.retryRefund("g2", "transaction-two", "g1", true, true),
    () => restored.retryRefund("g2", "changed-transaction", "g2", true, true),
    () => restored.retryRefund("g2", "transaction-two", "g2", false, true),
    () => restored.retryRefund("g2", "transaction-two", "g2", true, false)]) {
    assert.throws(attempt); assert.deepEqual(restored.snapshot(), beforeRetry);
  }
  assert.deepEqual(restored.retryRefund("g2", "transaction-two", "g2", true, true), { sent: true, bytes: "signed-two" });
  assert.equal(restored.snapshot().refunds[1]!.sendCalls, 2);
  assert.equal(restored.snapshot().refunds[1]!.reserved, 1000);
  assert.throws(() => restored.retryRefund("g2", "transaction-two", "g2", true, true), /observation required/);
  restored.startup([facts[0]!, { ...facts[1]!, seen: "mempool" }]);
  assert.deepEqual(restored.retryRefund("g2", "transaction-two", "g2", true, true), { sent: false, bytes: "signed-two" });
  assert.equal(restored.snapshot().refunds[1]!.sendCalls, 2);
  const pending = Seller.restore(seller.snapshot());
  assert.equal(pending.startup([facts[0]!, { ...facts[1]!, seen: "unknown" }]).ready, false);
  assert.throws(() => pending.retryRefund("g2", "transaction-two", "g2", true, true), /observation required/);
  assert.equal(pending.snapshot().refunds[1]!.sendCalls, 1);
  const reorg = Seller.restore(seller.snapshot());
  reorg.startup([{ ...facts[0]!, confirmations: 1 }, facts[1]!]);
  assert.equal(reorg.snapshot().refunds[0]!.reserved, 1000);
  assert.equal(reorg.snapshot().refunds[0]!.refunded, 0);
  assert.deepEqual(reorg.retryRefund("g1", "transaction-one", "g1", true, true), { sent: false, bytes: "signed-one" });
  reorg.startup(facts); assert.equal(reorg.snapshot().refunds[0]!.refunded, 1000);
});

test("K33: seller edits and restart preserve issued names, invoice destinations, certificates, refund obligations and monotonic lineage", () => {
  const { seller: s, first, second } = refundedFixture();
  const fulfilled = invoice(s, "n2@space");
  s.observe(20, 30, [payment(first, 16), payment(second, 16), payment(fulfilled, 6)]);
  s.beginIssuance(fulfilled.id); s.deliver(fulfilled.id, "durable-certificate");
  const before = s.snapshot();
  s.setup("later"); s.list("fresh@later", 2000); s.list(first.handle, 3000);
  s.reserve(fulfilled.handle, true); s.withdraw(fulfilled.handle, true); s.withdraw(fulfilled.handle, false);
  s.pause(true); s.pause(true, "other");
  const restored = Seller.restore(s.snapshot()), after = restored.snapshot();
  assert.deepEqual(after.orders, before.orders); assert.deepEqual(after.payments, before.payments);
  assert.deepEqual(after.conversions, before.conversions);
  assert.equal(after.nextOrder, before.nextOrder); assert.equal(after.nextDestination, before.nextDestination);
  assert.deepEqual(after.refunds.map(({ seen, confirmations, ...r }) => r), before.refunds.map(({ seen, confirmations, ...r }) => r));
  assert.equal(restored.order(fulfilled.id).certificate, "durable-certificate");
  restored.pause(false);
  assert.throws(() => invoice(restored, fulfilled.handle), /name unavailable/);
  restored.reserve(fulfilled.handle, false); assert.throws(() => invoice(restored, fulfilled.handle), /name taken/);
  const fresh = invoice(restored, "fresh@later");
  assert.ok(fresh.id >= before.nextOrder); assert.ok(!before.orders.some(o => o.destination === fresh.destination));
  const external = restored.snapshot(); external.orders[0]!.destination = "changed-copy";
  assert.equal(restored.order(first.id).destination, first.destination);
});

test("K34: an attended exact-nomination owner invoice bypasses only seller reservation and retries reveal no bearer or duplicate invoice", () => {
  const context: OwnerContext = { authenticated: true, journalAcknowledged: true, recoveryReady: true, issuanceReady: true };
  const intent = (s: Seller, changes: Partial<OwnerIntent> = {}): OwnerIntent => ({ operation: "a".repeat(32),
    handle: "n0@space", recipient: "owner-recipient", confirm: "n0@space", expectedSequence: s.snapshot().revision, ...changes });
  const s = fixture(); s.reserve("n0@space", true);
  for (const key of ["authenticated", "journalAcknowledged", "recoveryReady", "issuanceReady"] as const) {
    const before = s.snapshot();
    assert.throws(() => s.ownerInvoice(intent(s), { ...context, [key]: false }));
    assert.deepEqual(s.snapshot(), before);
  }
  const stale = intent(s); s.list("n0@space", 1200);
  const beforeStale = s.snapshot(); assert.throws(() => s.ownerInvoice(stale, context), /stale owner preview/);
  assert.deepEqual(s.snapshot(), beforeStale);
  for (const bad of [intent(s, { confirm: "n1@space" }), intent(s, { operation: "too-short" })]) {
    assert.throws(() => s.ownerInvoice(bad, context), /exact owner nomination/);
    assert.deepEqual(s.snapshot(), beforeStale);
  }
  const chosen = intent(s); s.observe(1, 1, []);
  const created = s.ownerInvoice(chosen, context);
  assert.ok(created.created);
  const owner = created.invoice;
  assert.equal(owner.price, 1200); assert.equal(owner.quotedPrice, 1200); assert.equal(owner.state, "quoted");
  assert.equal(s.snapshot().names.find(n => n.handle === owner.handle)!.reserved, true);
  assert.equal(s.snapshot().conversions.length, 0); assert.throws(() => s.beginIssuance(owner.id), /not batchable/);
  const saved = s.snapshot();
  const repeated = s.ownerInvoice(chosen, context);
  assert.deepEqual(repeated, { created: false, order: owner.id, status: "quoted" });
  assert.deepEqual(s.snapshot(), saved);
  assert.equal(JSON.stringify(repeated).includes(owner.token), false);
  assert.equal(JSON.stringify(repeated).includes(owner.destination!), false);
  for (const changed of [{ recipient: "other-recipient" }, { handle: "n1@space", confirm: "n1@space" }, { expectedSequence: chosen.expectedSequence + 1 }]) {
    assert.throws(() => s.ownerInvoice({ ...chosen, ...changed }, context), /binding differs/);
    assert.deepEqual(s.snapshot(), saved);
  }
  const restored = Seller.restore(saved);
  assert.deepEqual(restored.ownerInvoice(chosen, context), repeated);
  assert.deepEqual(restored.snapshot().ownerAuthorizations, saved.ownerAuthorizations);
  assert.equal(restored.snapshot().nextOrder, saved.nextOrder); assert.equal(restored.snapshot().nextDestination, saved.nextDestination);
  s.observe(100, 10, [payment(owner, 0, 1200)]); assert.throws(() => s.beginIssuance(owner.id), /not batchable/);
  s.observe(200, 11, [payment(owner, 2, 1200)]); assert.throws(() => s.beginIssuance(owner.id), /not batchable/);
  s.observe(201, 12, [payment(owner, 3, 1200)]); assert.equal(s.order(owner.id).state, "converted");
  s.beginIssuance(owner.id); s.deliver(owner.id, "owner-certificate");
  assert.equal(s.order(owner.id).state, "fulfilled");
  assert.deepEqual(s.ownerInvoice(chosen, context), { created: false, order: owner.id, status: "fulfilled" });

  const blocked: ((v: Seller) => void)[] = [
    v => v.pause(true), v => v.pause(true, "space"), v => v.withdraw("n0@space", true),
    v => { invoice(v); v.reserve("n0@space", true); },
    v => { const held = invoice(v); v.observe(1, 10, [payment(held)]); v.beginIssuance(held.id); v.deliver(held.id, "issued"); v.reserve(held.handle, true); },
    v => { const held = invoice(v, "n1@space"); v.observe(1, 10, [payment(held, 1, 10_000)]); },
    v => { const held = invoice(v, "n1@space", "owner-recipient"); v.observe(1, 10, [payment(held)]); },
  ];
  for (const block of blocked) {
    const v = fixture(); block(v); v.reserve("n0@space", true);
    const before = v.snapshot(); assert.throws(() => v.ownerInvoice(intent(v), context));
    assert.deepEqual(v.snapshot(), before);
  }
  const cap = fixture(); cap.list("premium@space", 2000);
  for (let i = 0; i < 10; i++) invoice(cap, `n${i}@other`);
  cap.reserve("n0@space", true);
  const capped = cap.ownerInvoice(intent(cap), context); assert.ok(capped.created); assert.equal(capped.invoice.payFirst, true);

  const recipientRace = fixture(), publicInvoice = invoice(recipientRace, "n1@space", "owner-recipient");
  recipientRace.reserve("n0@space", true);
  const raced = recipientRace.ownerInvoice(intent(recipientRace), context); assert.ok(raced.created);
  recipientRace.observe(1, 10, [payment(publicInvoice), payment(raced.invoice)]);
  assert.throws(() => recipientRace.beginIssuance(raced.order), /script conflict/);
  assert.throws(() => recipientRace.beginIssuance(publicInvoice.id), /script conflict/);

  const late = fixture(); late.reserve("n0@space", true);
  const lateReceipt = late.ownerInvoice(intent(late), context); assert.ok(lateReceipt.created);
  const lateOwner = lateReceipt.invoice;
  late.observe(900, 10, []); assert.throws(() => late.beginIssuance(lateOwner.id), /not batchable/);
  late.observe(901, 11, [payment(lateOwner)]); assert.equal(late.order(lateOwner.id).state, "converted");
  const cancelled = fixture(); cancelled.reserve("n0@space", true);
  const cancelledReceipt = cancelled.ownerInvoice(intent(cancelled), context); assert.ok(cancelledReceipt.created);
  const partialOwner = cancelledReceipt.invoice;
  cancelled.observe(100, 10, [payment(partialOwner, 6, 100)]); cancelled.cancel(partialOwner.id);
  cancelled.recordRefund({ group: "owner-refund", order: partialOwner.id, txid: "owner-refund-transaction", bytes: "symbolic-signed-refund", principal: 100,
    attempted: false, seen: "absent", confirmations: 0, reserved: 100, refunded: 0, sendCalls: 0 });
  cancelled.observe(200, 11, [payment(partialOwner, 7, 100), { outpoint: "owner-late-top-up", order: partialOwner.id, sats: 900, confirmations: 6 }]);
  assert.equal(cancelled.order(partialOwner.id).state, "cancelled");
  assert.equal(cancelled.snapshot().refunds[0]!.reserved, 100);
  assert.equal(cancelled.snapshot().names.find(n => n.handle === partialOwner.handle)!.reserved, true);
  assert.throws(() => invoice(cancelled), /name unavailable/);
});
