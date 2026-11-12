import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { SalesStore } from "../../src/application/store.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { serve } from "../../src/application/http.ts";
import { servePending } from "../../src/application/pending-http.ts";
import { sendingFixture, paymentId } from "./refund-sending-fixture.ts";
import { familyFixture, mine } from "./refund-families-fixture.ts";
import { setup, invoice, payment, use } from "./application-fixture.ts";
import { credential, faultProxy } from "./entry-http-fixture.ts";

function paid(store: SalesStore, f: ReturnType<typeof sendingFixture>) {
  return Effect.gen(function* () {
    yield* setup(store); const order = yield* invoice(store);
    f.node.outputs = [{ ...payment(1, 10_000, 6), outpoint: paymentId }];
    yield* store.setRefundDestination(order.token, "buyer-refund"); yield* store.cancel(order.token);
    return order;
  });
}
async function api(url: string, path: string, value?: unknown, token = credential) {
  const response = await fetch(url + path, { method: value === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}` }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { code: response.status, value: await response.json() as { [key: string]: unknown } };
}
const prepare = { kind: "cancellation", cause: "buyer" };
test("O61: retrying interrupted refund preparation recovers one outstanding group and its signed transaction", async (t) => {
  for (const fault of ["before", "after"]) {
    const f = sendingFixture(t);
    await use(f, store => Effect.gen(function* () {
      const order = yield* paid(store, f), listener = yield* serveOperator(store, Effect.succeed(credential));
      const proxy = yield* Effect.promise(() => faultProxy(t, listener.url));
      proxy.control[fault === "before" ? "beforePath" : "afterPath"] = "/operator/orders/o1/refunds";
      yield* Effect.promise(() => assert.rejects(api(proxy.url, "/operator/orders/o1/refunds", prepare)));
      const first = yield* Effect.promise(() => api(proxy.url, "/operator/orders/o1/refunds", prepare));
      assert.equal(first.code, 200); assert.equal(first.value.phase, "built");
      f.node.outputs.push({ ...payment(1, 2000, 6), outpoint: "2".repeat(64) + ":0" });
      const again = yield* Effect.promise(() => api(proxy.url, "/operator/orders/o1/refunds", prepare));
      assert.equal(again.value.gid, first.value.gid); assert.equal(again.value.txid, first.value.txid);
      assert.equal((yield* store.order(order.token)).refund_groups.length, 1); assert.equal(f.senderState.builds, 1); assert.equal(f.sent.length, 0);
      assert.equal((yield* Effect.promise(() => api(listener.url, "/operator/orders/o1/refunds", { ...prepare, cause: "merchant" }))).code, 409);
    }));
  }
});
test("O62: financial routes require the operator role and exact bounded bodies before observation or signing", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paid(store, f);
    const op = yield* serveOperator(store, Effect.succeed(credential)), buyer = yield* serve(store), subs = yield* servePending(store, Effect.succeed("mock-subs".padEnd(48, "x")));
    yield* Effect.promise(async () => {
      const path = "/operator/orders/o1/refunds";
      assert.equal((await api(op.url, path, prepare, "incorrect")).code, 401);
      assert.equal((await api(buyer.url, path, prepare)).code, 404);
      assert.equal((await api(subs.url, path, prepare, "mock-subs".padEnd(48, "x"))).code, 404);
      for (const raw of ['{}', '{"kind":"cancellation","kind":"excess"}', '{"kind":"cancellation","cause":"buyer","extra":1}',
        '{"k\\u0069nd":"cancellation","cause":"buyer"}', '{"kind":"cancellation","cause":true}', " ".repeat(65_537)]) {
        const response = await fetch(op.url + path, { method: "POST", headers: { Authorization: `Bearer ${credential}` }, body: raw });
        assert.equal(response.status, 400);
      }
      assert.equal(f.senderState.builds, 0); assert.equal(f.sent.length, 0);
    });
  }));
});
test("O63: refund broadcast is bound to the exact reviewed group and current transaction", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paid(store, f); const op = yield* serveOperator(store, Effect.succeed(credential));
    const first = (yield* Effect.promise(() => api(op.url, "/operator/orders/o1/refunds", prepare))).value;
    const path = `/operator/refunds/${first.gid}/broadcast`;
    for (const body of [{ txid: first.txid }, { txid: first.txid, confirm: "g-" + "0".repeat(8) + "-0000-0000-0000-000000000000" },
      { txid: null, confirm: first.gid }, { txid: first.txid, confirm: first.gid, extra: true }])
      assert.equal((yield* Effect.promise(() => api(op.url, path, body))).code, 400);
    yield* store.bumpRefund(String(first.gid), 6000);
    assert.equal((yield* Effect.promise(() => api(op.url, path, { txid: first.txid, confirm: first.gid }))).code, 409);
    assert.equal(f.sent.length, 0);
    const current = (yield* Effect.promise(() => api(op.url, `/operator/refunds/${first.gid}`))).value;
    assert.notEqual(current.txid, first.txid);
    assert.equal((yield* Effect.promise(() => api(op.url, path, { txid: current.txid, confirm: current.gid }))).code, 200);
    assert.equal(f.sent.length, 1);
  }));
});
test("O64: journal outages and lost send responses retain one signed refund and never send during reads", async (t) => {
  const f = sendingFixture(t); let gid = "", txid = "", token = "";
  await use(f, store => Effect.gen(function* () {
    token = (yield* paid(store, f)).token;
    const op = yield* serveOperator(store, Effect.succeed(credential));
    f.journal.down = true;
    const pending = (yield* Effect.promise(() => api(op.url, "/operator/orders/o1/refunds", prepare))).value;
    assert.equal(pending.phase, "reserved"); assert.equal(pending.acknowledged, false); assert.equal(f.senderState.builds, 0);
    gid = String(pending.gid); f.journal.down = false;
    const built = (yield* Effect.promise(() => api(op.url, "/operator/orders/o1/refunds", prepare))).value;
    assert.equal(built.gid, gid); txid = String(built.txid);
    f.journal.down = true;
    const blocked = yield* Effect.promise(() => api(op.url, `/operator/refunds/${gid}/broadcast`, { txid, confirm: gid }));
    assert.equal(blocked.value.intent_acknowledged, false); assert.equal(f.sent.length, 0);
    f.journal.down = false; const proxy = yield* Effect.promise(() => faultProxy(t, op.url));
    proxy.control.afterPath = `/operator/refunds/${gid}/broadcast`;
    yield* Effect.promise(() => assert.rejects(api(proxy.url, `/operator/refunds/${gid}/broadcast`, { txid, confirm: gid })));
    assert.equal(f.sent.length, 1);
  }));
  await use(f, store => Effect.gen(function* () {
    const op = yield* serveOperator(store, Effect.succeed(credential));
    for (let i = 0; i < 3; i++) {
      const receipt = (yield* Effect.promise(() => api(op.url, `/operator/refunds/${gid}`))).value;
      assert.equal(receipt.txid, txid); assert.equal(receipt.status, "mempool");
      assert.equal(JSON.stringify(receipt).includes('"raw"'), false);
    }
    yield* Effect.promise(() => api(op.url, `/operator/refunds/${gid}/broadcast`, { txid, confirm: gid }));
    assert.equal(f.sent.length, 1); assert.equal(f.senderState.builds, 1);
    assert.equal((yield* store.order(token)).reserved_refund_sats, 10_000);
  }));
});
test("O65: a settled older family member reports its actual charge separately from the historical maximum", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paid(store, f); const first = yield* store.prepareOperatorRefund("o1", "cancellation", "buyer");
    f.node.outputs.push({ ...payment(1, 1000, 6), outpoint: "2".repeat(64) + ":0" });
    yield* store.bumpRefund(first.id, 6000, 11_000);
    mine(f, first.txid!, 6); const op = yield* serveOperator(store, Effect.succeed(credential));
    const receipt = (yield* Effect.promise(() => api(op.url, `/operator/refunds/${first.id}`))).value;
    assert.equal(receipt.txid, first.txid); assert.equal(receipt.charged_sats, 10_000); assert.equal(receipt.maximum_charge_sats, 11_000);
    assert.equal(receipt.status, "settled"); assert.equal(Number(receipt.to_buyer_sats) + Number(receipt.buyer_fee_sats), receipt.charged_sats);
  }));
});
test("O66: the shipped attended runner and TypeScript client recover dropped HTTP replies with explicit cause and transaction", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paid(store, f); const op = yield* serveOperator(store, Effect.succeed(credential));
    const proxy = yield* Effect.promise(() => faultProxy(t, op.url)), token = join(f.root, "operator-token"); writeFileSync(token, credential, { mode: 0o600 });
    const client = (mode: string, gid = "", txid = "") => promisify(execFile)("python3", ["test/production/refund-runner-client.py", mode, proxy.url, token,
      f.config.database, f.config.journalDirectory, gid, txid]);
    proxy.control.afterPath = "/operator/orders/o1/refunds";
    yield* Effect.promise(() => assert.rejects(client("prepare")));
    const prepared = JSON.parse((yield* Effect.promise(() => client("prepare"))).stdout) as { gid: string; txid: string };
    proxy.control.afterPath = `/operator/refunds/${prepared.gid}/broadcast`;
    yield* Effect.promise(() => assert.rejects(client("send", prepared.gid, prepared.txid)));
    const retry = JSON.parse((yield* Effect.promise(() => client("send", prepared.gid, prepared.txid))).stdout) as { status: string; txid: string };
    assert.equal(retry.txid, prepared.txid); assert.equal(retry.status, "mempool");
    assert.equal(f.senderState.builds, 1); assert.equal(f.sent.length, 1);
  }));
});
