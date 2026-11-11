import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Effect } from "effect";
import { serve } from "../../src/application/http.ts";
import { DurableStore } from "../../src/storage/store.ts";
import { ApplicationError } from "../../src/application/records.ts";
import { fee, rate, split, excessRefundable } from "../../src/refunds/policy.ts";
import type { BuildRequest, RefundAdapters } from "../../src/refunds/types.ts";
import { refundPlan } from "../../model/refunds.ts";
import { fixture, invoice, payment, refundPolicy, setup, use } from "./application-fixture.ts";

const destination = (n: number) => ({ address: `refund-${n}`, script: "0014" + n.toString(16).padStart(40, "f") });
function wallet() {
  const state = { builds: 0, fail: false, requests: [] as BuildRequest[], beforeBuild: null as (() => void) | null };
  const adapters: RefundAdapters = {
    resolveAddress: address => Effect.sync(() => ({ address, script: destination(Number(address.split("-").at(-1))).script })),
    estimateRate: () => Effect.succeed(2000),
    build: request => Effect.gen(function* () {
      state.builds++; state.requests.push(structuredClone(request)); state.beforeBuild?.();
      if (state.fail) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "signing unavailable" }));
      const p = split(request.group.charged, 200, request.group.policy.buyerFeeCeiling, request.group.cause === "merchant");
      const coin = request.orderCoins.find(c => !request.forbiddenInputs.includes(c.outpoint)); assert(coin);
      const change = coin.sats - request.group.charged;
      return { txid: "a".repeat(63) + state.builds.toString(16), raw: "00", vbytes: 100,
        fee: p.fee, buyerFee: p.buyerFee, merchantFee: p.merchantFee, toBuyer: p.toBuyer,
        inputs: [{ ...coin, owner: "order" }], outputs: [ { ...request.destination, sats: p.toBuyer, role: "buyer" },
          ...(change ? [{ ...destination(100 + state.builds), sats: change, role: "order_change" as const }] : []) ] };
    }),
  };
  return { state, adapters };
}
test("K13: production fee split matches the independent model and caps the buyer charge", () => {
  for (const vbytes of [100, 139, 140, 201]) for (const estimate of [1000, 2000, 2011]) {
    const expected = refundPlan(10_000, vbytes, estimate, false, refundPolicy);
    assert.deepEqual(split(10_000, fee(vbytes, rate(estimate, refundPolicy)), 200, false), expected);
  }
  assert.deepEqual(split(10_000, 280, 200, false), { fee: 280, buyerFee: 200, merchantFee: 80, toBuyer: 9800, chargedToOrder: 10_000 });
});
test("K15: production policy requires a bounded estimate or an explicitly configured fallback", () => {
  assert.equal(rate(null, refundPolicy), 2000); assert.equal(fee(141, 2001), 283);
  assert.throws(() => rate(null, { ...refundPolicy, fallbackRate: null }), /no fee estimate/);
  assert.throws(() => rate(100_001, refundPolicy), /operator limit/);
  assert.throws(() => rate(null, { ...refundPolicy, fallbackRate: 100_001 }), /fallback/);
});
test("K16: production excess minimum includes exactly 546 sats over the fee", () => {
  assert.equal(excessRefundable(845, 300), false); assert.equal(excessRefundable(846, 300), true);
});
test("T1: refund destinations reject every historical payment script including the same order", async (t) => {
  const f = fixture(t), w = wallet();
  await use(f, store => Effect.gen(function* () {
    // The resolver maps two textual aliases onto the same payment script.
    f.adapters.refunds = { ...w.adapters, resolveAddress: address => Effect.succeed({ address, script: payment(1).script }) };
    yield* setup(store); const one = yield* invoice(store), two = yield* store.request({ handle: "n1@space", script_pubkey: one.quote.recipient_script_pubkey });
    for (const token of [one.token, two.token]) yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.setRefundDestination(token, "alias")), /never goes/));
    assert.equal((yield* store.order(one.token)).refund_address, null);
  }));
});
test("T2: expired and cancelled invoices keep their payment destinations excluded from refunds", async (t) => {
  const f = fixture(t), w = wallet();
  await use(f, store => Effect.gen(function* () {
    f.adapters.refunds = { ...w.adapters, resolveAddress: address => Effect.succeed({ address, script: payment(Number(address)).script }) };
    yield* setup(store); const one = yield* invoice(store); f.node.now = 901; yield* store.order(one.token);
    const two = yield* invoice(store, 1); yield* store.cancel(two.token);
    const three = yield* store.request({ handle: "n2@space", script_pubkey: one.quote.recipient_script_pubkey });
    for (const address of ["1", "2"]) yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.setRefundDestination(three.token, address)), /never goes/));
  }));
});
test("Z26: a destination supplied before quoting is skipped globally by payment allocation", async (t) => {
  const f = fixture(t), w = wallet();
  await use(f, store => Effect.gen(function* () {
    f.adapters.refunds = { ...w.adapters, resolveAddress: address => Effect.succeed({ address, script: payment(1).script }) };
    yield* setup(store); const one = yield* store.request({ handle: "n0@space", script_pubkey: "5120" + "1".padStart(64, "0") });
    yield* store.setRefundDestination(one.token, "refund-before-quote");
    assert.equal((yield* store.quote(one.token)).address, "mock-address-2");
    f.node.draws = 0; const two = yield* invoice(store, 1); assert.equal(two.quote.address, "mock-address-3");
  }));
});
test("Z19: reservations precede signing, survive journal outage and retry without double allocation", async (t) => {
  const f = fixture(t), w = wallet(); f.adapters.refunds = w.adapters;
  let token = "", group = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); token = one.token;
    f.node.outputs = [{ ...payment(1, 13_000, 6), outpoint: "1".repeat(64) + ":0" }];
    yield* store.setRefundDestination(token, "refund-1"); yield* store.order(token);
    f.journal.down = true;
    const pending = yield* store.prepareRefund("o1", "excess", "buyer"); group = pending.id;
    assert.equal(pending.phase, "reserved"); assert.equal(pending.acknowledged, false); assert.equal(w.state.builds, 0);
    assert.equal((yield* store.order(token)).refundable_sats, 0);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "excess", "buyer")), /no refundable credit/));
  }));
  f.journal.down = false;
  await use(f, store => Effect.gen(function* () {
    w.state.beforeBuild = () => {
      const db = new DatabaseSync(join(f.root, "store.db"), { readOnly: true });
      try { assert.equal(db.prepare("select count(*) as n from outbox where acknowledged=0").get()!.n, 0); }
      finally { db.close(); }
    };
    const built = yield* store.buildRefund(group); assert.equal(built.phase, "built"); assert.equal(built.acknowledged, true);
    assert.equal(w.state.builds, 1); assert.equal(built.charged_sats, 12_000);
    assert.equal((yield* store.buildRefund(group)).txid, built.txid); assert.equal(w.state.builds, 1);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.discardUnbuiltRefund(group)), /only an unbuilt/));
    const view = yield* store.order(token); assert.equal(JSON.stringify(view).includes('"raw"'), false);
  }));
});
test("Z20: an underpaid invoice cannot prepare excess and a builder cannot substitute another order's input", async (t) => {
  const f = fixture(t), w = wallet(); f.adapters.refunds = w.adapters;
  const build = w.adapters.build;
  f.adapters.refunds = { ...w.adapters, build: request => build(request).pipe(Effect.map(tx => ({ ...tx,
    inputs: tx.inputs.map(c => ({ ...c, outpoint: "f".repeat(64) + ":0" })) }))) };
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store);
    f.node.outputs = [{ ...payment(1, 800, 6), outpoint: "3".repeat(64) + ":0" }];
    yield* store.setRefundDestination(one.token, "refund-1");
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "excess", "buyer")), /not eligible/));
    f.node.outputs[0]!.sats = 13_000;
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "excess", "buyer")), /outpoint contents changed/));
    // Real outpoints are immutable; a top-up is a separate receipt.
    f.node.outputs = [{ ...payment(1, 13_000, 6), outpoint: "4".repeat(64) + ":0" }];
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "excess", "buyer")), /funding ownership/));
    assert.equal((yield* store.order(one.token)).refund_groups[0]!.phase, "reserved");
  }));
});
test("T4: building a refund fixes its destination even while its journal acknowledgment is unavailable", async (t) => {
  const f = fixture(t), w = wallet(); f.adapters.refunds = w.adapters;
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store);
    f.node.outputs = [{ ...payment(1, 13_000, 6), outpoint: "2".repeat(64) + ":0" }];
    yield* store.setRefundDestination(one.token, "refund-1"); yield* store.order(one.token);
    w.state.beforeBuild = () => { f.journal.down = true; };
    const built = yield* store.prepareRefund("o1", "excess", "buyer"); assert.equal(built.phase, "built"); assert.equal(built.acknowledged, false);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.setRefundDestination(one.token, "refund-2")), /destination is fixed/));
    f.journal.down = false; assert.equal((yield* store.buildRefund(built.id)).acknowledged, true); assert.equal(w.state.builds, 1);
  }));
});
test("Z20: failed signing retains credit, unbuilt discard releases it, and reorgs block retry", async (t) => {
  const f = fixture(t), w = wallet(); f.adapters.refunds = w.adapters;
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); yield* store.cancel(one.token);
    f.node.outputs = [{ ...payment(1, 10_000, 6), outpoint: "3".repeat(64) + ":0" }];
    yield* store.setRefundDestination(one.token, "refund-1"); w.state.fail = true;
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "cancellation", "buyer")), /signing unavailable/));
    let view = yield* store.order(one.token), id = view.refund_groups[0]!.id;
    assert.equal(view.refundable_sats, 0); f.node.outputs[0]!.confirmations = 5;
    w.state.fail = false; yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.buildRefund(id)), /credit is unavailable/));
    assert.equal(w.state.builds, 1); yield* store.discardUnbuiltRefund(id); f.node.outputs[0]!.confirmations = 6;
    assert.equal((yield* store.order(one.token)).refundable_sats, 10_000);
    assert.equal((yield* store.prepareRefund("o1", "cancellation", "buyer")).phase, "built");
  }));
});
test("Z21: buyer refund-destination HTTP accepts one exact member and never exposes signed data", async (t) => {
  const f = fixture(t), w = wallet(); f.adapters.refunds = w.adapters;
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store), server = yield* serve(store);
    const url = server.url + one.order_link + "/refund-destination";
    for (const body of ['{"address":"refund-1","address":"refund-2"}', '{"address":1}', '{"address":"refund-1","extra":"x"}']) {
      const reply = yield* Effect.promise(() => fetch(url, { method: "POST", body })); assert.equal(reply.status, 400);
    }
    const reply = yield* Effect.promise(() => fetch(url, { method: "POST", body: '{"address":"refund-1"}' }));
    assert.equal(reply.status, 200); const view = (yield* Effect.promise(() => reply.json())) as { refund_address: string };
    assert.equal(view.refund_address, "refund-1");
    assert.equal((yield* store.order(one.token)).buyer_refund_fee_ceiling_sats, 200);
    assert.equal((yield* Effect.promise(() => fetch(server.url + "/operator/refunds", { method: "POST" }))).status, 404);
  }));
});
test("Z22: a changed policy or malformed journaled refund settings refuses startup", async (t) => {
  const f = fixture(t);
  await use(f, store => setup(store));
  f.config.refundPolicy = { ...refundPolicy, maximumFee: 9999 };
  await assert.rejects(use(f, () => Effect.void), /refund configuration differs/);
  f.config.refundPolicy = refundPolicy;
  const db = new DatabaseSync(join(f.root, "store.db"));
  db.prepare("update records set value=? where kind='refund_settings'").run(JSON.stringify({ version: 2 })); db.close();
  await use(f, () => Effect.void); // SQLite-only damage is repaired by journal replay.
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const storage = yield* DurableStore.open(f.config);
    yield* storage.commit([{ kind: "refund_settings", key: "global", value: { version: 2 } }]);
  })));
  await assert.rejects(use(f, () => Effect.void));
});
