import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Effect, Exit, Scope } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { serve } from "../../src/application/http.ts";
import { ApplicationError } from "../../src/application/records.ts";
import { fixture, invoice, payment, setup, use } from "./application-fixture.ts";

const secret = "mock-operator-credential".padEnd(48, "a");
const replacement = "mock-rotated-credential".padEnd(48, "b");
const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
async function call(url: string, path: string, token = secret, options: RequestInit = {}) {
  const response = await fetch(url + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  return { response, value: await response.json() as Record<string, any> };
}
test("O1: separate loopback operator auth rejects duplicates, reloads credentials and scrubs provider errors", async (t) => {
  const f = fixture(t); let value = secret, reads = 0, down = false, touched = 0;
  const credential = Effect.gen(function* () {
    reads++; if (down) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "sensitive-provider-value" })); return value;
  });
  await use(f, store => Effect.gen(function* () {
    const watched = new Proxy(store, { get(target, p, receiver) { const v = Reflect.get(target, p, receiver);
      if (["operatorStatus", "inspectionOrders", "inspectionOrder", "observe"].includes(String(p))) touched++;
      return typeof v === "function" ? v.bind(target) : v; } });
    const listener = yield* serveOperator(watched, credential), buyer = yield* serve(store);
    yield* Effect.promise(async () => {
      const start = reads;
      assert.equal((await fetch(listener.url + "/operator/status")).status, 401); assert.equal(reads, start);
      assert.equal((await call(listener.url, "/operator/status", "wrong".padEnd(48, "x"))).response.status, 401);
      assert.equal(touched, 0);
      const duplicate = await new Promise<number>(resolve => {
        const req = request(listener.url + "/operator/status", { headers: ["Host", new URL(listener.url).host, "Authorization", `Bearer ${secret}`, "authorization", `Bearer ${secret}`] }, r => { r.resume(); r.on("end", () => resolve(r.statusCode!)); }); req.end();
      }); assert.equal(duplicate, 401); assert.equal(touched, 0);
      assert.equal((await call(listener.url, "/operator/status")).response.status, 200);
      value = replacement;
      assert.equal((await call(listener.url, "/operator/status")).response.status, 401);
      assert.equal((await call(listener.url, "/operator/status", replacement)).response.status, 200);
      down = true; const failed = await call(listener.url, "/operator/status", replacement);
      assert.equal(failed.response.status, 503); assert.equal(JSON.stringify(failed.value).includes("sensitive-provider-value"), false);
      assert.equal((await call(buyer.url, "/operator/status")).response.status, 404);
    });
  }));
});
test("O2: operator order inspection preserves acknowledged status without exposing buyer tokens or signed data", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const old = yield* invoice(store); f.node.outputs = [payment(1, 1000, 3)]; yield* store.observe();
    const listener = yield* serveOperator(store, Effect.succeed(secret));
    yield* Effect.promise(async () => {
      const orders = await call(listener.url, "/operator/orders?status=converted"); assert.equal(orders.response.status, 200);
      assert.equal(orders.value.orders.length, 1);
      const row = (await call(listener.url, "/operator/orders/o1")).value;
      assert.equal(row.name, "n0@space"); assert.equal(row.journaled_status, "converted"); assert.equal(row.dest_address, old.quote.address);
      const encoded = JSON.stringify(orders.value);
      for (const forbidden of [old.token, "tokenHash", "order_link", "raw", secret]) assert.equal(encoded.includes(forbidden), false);
      assert.deepEqual((await call(listener.url, "/operator/orders?status=ready")).value, { orders: [] });
      assert.equal((await call(listener.url, "/operator/orders?status=invalid")).response.status, 400);
      assert.equal((await call(listener.url, "/operator/orders?status=converted&status=cancelled")).response.status, 400);
      assert.equal((await call(listener.url, "/operator/orders/o999")).response.status, 404);
      assert.equal(orders.response.headers.get("cache-control"), "no-store");
    });
    f.journal.down = true; yield* store.cancel(old.token);
    const pending = yield* Effect.promise(() => call(listener.url, "/operator/orders/o1"));
    assert.equal(pending.value.status, "cancelled"); assert.equal(pending.value.journaled_status, "converted");
    f.journal.down = false; const fresh = yield* store.request({ handle: "n1@space", script_pubkey: "5120" + "2".padStart(64, "0") });
    f.node.beforeDestination = async () => { f.journal.down = true; };
    const quote = yield* store.quote(fresh.token); assert.equal(quote.address, null);
    const unacknowledged = yield* Effect.promise(() => call(listener.url, "/operator/orders/o2"));
    assert.equal(unacknowledged.value.status, "quoted"); assert.equal(unacknowledged.value.journaled_status, "requested");
    assert.equal(unacknowledged.value.dest_address, null);
  }));
});
test("O3: observation has a strict empty body and unsupported write routes never sign or issue", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const old = yield* invoice(store); f.node.outputs = [payment(1, 1000, 3)];
    const listener = yield* serveOperator(store, Effect.succeed(secret));
    yield* Effect.promise(async () => {
      const before = f.node.observations;
      assert.equal((await call(listener.url, "/operator/observe", secret, { method: "POST", body: '{"ignore":true}' })).response.status, 400);
      assert.equal(f.node.observations, before);
      assert.equal((await call(listener.url, "/operator/observe", secret, { method: "POST", body: "{}" })).response.status, 200);
      assert.equal(f.node.observations, before + 1);
      for (const path of ["/operator/issuing", "/operator/pending", "/operator/orders/o1/refunds", "/operator/refunds/g1/broadcast", "/operator/orders/o1/certificate"])
        assert.equal((await call(listener.url, path, secret, { method: "POST", body: "{}" })).response.status, 404);
      assert.equal((await call(listener.url, "/operator/orders/o1")).value.status, "converted");
    });
    assert.equal((yield* store.order(old.token)).status, "converted");
  }));
});
test("O4: failed credential startup opens no listener and scoped shutdown releases the port", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    for (const invalid of ["", "too-short", "x".repeat(257), "x".repeat(40) + "\n"])
      yield* Effect.promise(() => assert.rejects(run(Effect.scoped(serveOperator(store, Effect.succeed(invalid)))), /credential unavailable/));
    const parent = yield* Effect.scope, lifetime = yield* Scope.fork(parent);
    const first = yield* Scope.provide(lifetime)(serveOperator(store, Effect.succeed(secret)));
    const port = Number(new URL(first.url).port); yield* Scope.close(lifetime, Exit.void);
    const second = yield* serveOperator(store, Effect.succeed(secret), port);
    assert.equal((yield* Effect.promise(() => call(second.url, "/operator/status"))).response.status, 200);
  }));
});
