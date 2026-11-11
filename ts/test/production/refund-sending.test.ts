import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { Effect } from "effect";
import { invoice, payment, setup, use } from "./application-fixture.ts";
import { sendingFixture, settledRefund, tipHash } from "./refund-sending-fixture.ts";

test("R1: racing refund preparations serialize one reservation against the same settled credit", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store);
    f.node.outputs = [{ ...payment(1, 10_000, 6), outpoint: "1".repeat(64) + ":0" }];
    yield* store.setRefundDestination(one.token, "buyer-refund"); yield* store.cancel(one.token);
    const outcomes = yield* Effect.promise(() => Promise.allSettled([1, 2].map(() => Effect.runPromise(store.prepareRefund("o1", "cancellation", "buyer")))));
    assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(o => o.status === "rejected").length, 1);
    assert.equal((yield* store.order(one.token)).refund_groups.length, 1);
  }));
});

test("R2: a lost send reply is observed on restart without another payment or group", async (t) => {
  const f = sendingFixture(t); let token = "", id = "";
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); token = one.token; id = one.group.id;
    f.senderState.loseReply = true;
    const sent = yield* store.broadcastRefund(id); assert.equal(sent.status, "mempool"); assert.equal(sent.broadcast_result, "uncertain");
  }));
  await use(f, store => Effect.gen(function* () {
    assert.deepEqual(yield* store.reconcileRefunds(), []); assert.equal(f.sent.length, 1);
    assert.equal((yield* store.order(token)).reserved_refund_sats, 10_000);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "cancellation", "buyer")), /no refundable credit/));
    assert.equal((yield* store.broadcastRefund(id)).status, "mempool"); assert.equal(f.sent.length, 1);
  }));
});
test("R3: an absent uncertain send retries exactly the same signed transaction", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); f.senderState.failure = true;
    assert.equal((yield* store.broadcastRefund(one.group.id)).status, "broadcast_unknown");
    f.senderState.failure = false;
    const retried = yield* store.reconcileRefunds(); assert.equal(retried.length, 1);
    assert.deepEqual(f.sent[0], f.sent[1]); assert.equal(f.senderState.builds, 1);
    assert.equal((yield* store.order(one.token)).reserved_refund_sats, 10_000);
  }));
});
test("R4: eviction retains credit and rebroadcast uses the existing bytes", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); yield* store.broadcastRefund(one.group.id);
    f.observations.clear();
    assert.equal((yield* store.order(one.token)).reserved_refund_sats, 10_000);
    yield* store.reconcileRefunds(); assert.equal(f.sent.length, 2); assert.deepEqual(f.sent[0], f.sent[1]);
  }));
});
test("R16: settlement moves the charge once and a 6-to-5-to-6 change reopens then closes it", async (t) => {
  const f = sendingFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); token = one.token;
    yield* store.broadcastRefund(one.group.id);
    for (const depth of [6, 5, 6, 6]) {
      f.observations.set(one.group.txid!, { txid: one.group.txid!, seen: "mined", confirmations: depth, blockHash: tipHash,
        inputsAvailable: false, conflicts: [] });
      const view = yield* store.order(token); assert.equal(view.refunded_sats, depth >= 6 ? 10_000 : 0);
      assert.equal(view.reserved_refund_sats, depth >= 6 ? 0 : 10_000); assert.equal(view.refund_groups.length, 1);
    }
  }));
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* store.order(token)).refunded_sats, 10_000); assert.equal(f.sent.length, 1);
  }));
});
test("R6: a deep reorg reopens the same refund with exposure and blocks new allocation", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); yield* store.broadcastRefund(one.group.id);
    f.observations.set(one.group.txid!, { txid: one.group.txid!, seen: "mined", confirmations: 6, blockHash: tipHash, inputsAvailable: false, conflicts: [] });
    assert.equal((yield* store.order(one.token)).refunded_sats, 10_000);
    f.observations.clear(); f.node.outputs = [];
    const view = yield* store.order(one.token); assert.equal(view.refunded_sats, 0); assert.equal(view.reserved_refund_sats, 10_000);
    assert.deepEqual(view.reconciling, ["refunds"]); assert.equal(view.refund_exposure_sats, 10_000);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "cancellation", "buyer")), /no refundable credit/));
  }));
});
test("Z35: only settled refunds free admission capacity and loss of settlement restores the cap", async (t) => {
  const f = sendingFixture(t, 10_000);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f));
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(invoice(store, 1)), /exposure limit/));
    yield* store.broadcastRefund(one.group.id);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(invoice(store, 1)), /exposure limit/));
    f.observations.set(one.group.txid!, { txid: one.group.txid!, seen: "mined", confirmations: 6, blockHash: tipHash, inputsAvailable: false, conflicts: [] });
    assert.equal((yield* invoice(store, 1)).quote.pay_first, false);
    f.observations.set(one.group.txid!, { txid: one.group.txid!, seen: "mined", confirmations: 5, blockHash: tipHash, inputsAvailable: false, conflicts: [] });
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(invoice(store, 2)), /exposure limit/));
  }));
});
test("Z27: an unattempted refund losing settlement is refused before recording send intent", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); f.node.outputs[0]!.confirmations = 5;
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.broadcastRefund(one.group.id)), /no longer settled/));
    assert.equal(f.sent.length, 0); assert.equal((yield* store.order(one.token)).refund_groups[0]!.broadcast_intents, 0);
  }));
});
test("Z27: a journal outage before intent or during send preflight prevents transmission", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); f.journal.down = true;
    const pending = yield* store.broadcastRefund(one.group.id); assert.equal(f.sent.length, 0); assert.equal(pending.intent_acknowledged, false);
    f.journal.down = false; f.senderState.beforePermission = () => { f.journal.down = true; };
    yield* store.broadcastRefund(one.group.id); assert.equal(f.sent.length, 0);
    f.senderState.beforePermission = null; f.journal.down = false;
    yield* store.reconcileRefunds(); assert.equal(f.sent.length, 1);
  }));
});
test("Z28: confirmed conflict keeps its reservation and rebuild guard after conflict reorg", async (t) => {
  const f = sendingFixture(t); let token = "", id = "";
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); token = one.token; id = one.group.id;
    f.observations.set(one.group.txid!, { txid: one.group.txid!, seen: "absent", confirmations: 0, blockHash: null, inputsAvailable: false,
      conflicts: [{ txid: "c".repeat(64), confirmations: 6, mempool: false }] });
    assert.equal((yield* store.order(token)).refund_groups[0]!.status, "needs_rebuild");
    f.observations.clear();
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.broadcastRefund(id)), /needs rebuild/));
    assert.equal((yield* store.order(token)).reserved_refund_sats, 10_000);
  }));
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* store.order(token)).refund_groups[0]!.status, "needs_rebuild");
    assert.deepEqual(yield* store.reconcileRefunds(), []); assert.equal(f.sent.length, 0);
  }));
});
test("Z29: failed or inconsistent refund observations never overwrite persisted ledger facts", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* Effect.promise(() => settledRefund(store, f)); yield* store.observe();
    const db = new DatabaseSync(f.config.database, { readOnly: true });
    const before = db.prepare("select * from records order by kind,key").all(); db.close();
    for (const mode of ["failRead", "mismatch"] as const) {
      f.senderState[mode] = true;
      yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.observe())));
      const db = new DatabaseSync(f.config.database, { readOnly: true });
      assert.deepEqual(db.prepare("select * from records order by kind,key").all(), before); db.close(); f.senderState[mode] = false;
    }
  }));
});
test("Z34: process death after the acknowledged send gate leaves a durable uncertain intent", async (t) => {
  const f = sendingFixture(t); let token = "", id = "";
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); token = one.token; id = one.group.id;
  }));
  const storeUrl = new URL("../../src/application/store.ts", import.meta.url).href;
  const fixtureUrl = new URL("./application-fixture.ts", import.meta.url).href;
  const script = `
    import { Effect } from "effect";
    import { SalesStore } from ${JSON.stringify(storeUrl)};
    import { refundPolicy, payment } from ${JSON.stringify(fixtureUrl)};
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* SalesStore.open({ database: process.argv[1], journalDirectory: process.argv[2], riskBudgetSats: 1000000, refundPolicy }, {
        clock: () => 0, snapshot: () => Effect.succeed({ tip: 10, tipHash: "d".repeat(64), outputs: [{ ...payment(1, 10000, 6), outpoint: "1".repeat(64) + ":0" }] }),
        newDestination: Effect.die("unexpected address allocation"), refunds: {
          resolveAddress: () => Effect.die("unexpected address lookup"), estimateRate: () => Effect.die("unexpected fee lookup"), build: () => Effect.die("unexpected signing"),
          sender: {
            observe: txs => Effect.succeed({ tip: 10, tipHash: "d".repeat(64), transactions: txs.map(tx => ({ txid: tx.txid, seen: "absent", confirmations: 0, blockHash: null, inputsAvailable: true, conflicts: [] })) }),
            broadcast: (_, permission) => Effect.gen(function* () { if (!(yield* permission)) throw Error("journal gate failed"); process.kill(process.pid, "SIGKILL"); })
          }
        }
      });
      yield* store.broadcastRefund(process.argv[3]);
    })));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.config.database, f.config.journalDirectory, id],
    { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const db = new DatabaseSync(f.config.database, { readOnly: true });
  const row = db.prepare("select value from records where kind='refund_send'").get(); assert(row);
  assert.equal((JSON.parse(row.value as string) as { result: string }).result, "uncertain"); db.close();
  await use(f, store => Effect.gen(function* () {
    const view = yield* store.order(token); assert.equal(view.reserved_refund_sats, 10_000);
    assert.equal(view.refund_groups[0]!.status, "broadcast_unknown");
    yield* store.reconcileRefunds(); assert.equal(f.sent.length, 1); assert.equal(f.senderState.builds, 1);
  }));
});
