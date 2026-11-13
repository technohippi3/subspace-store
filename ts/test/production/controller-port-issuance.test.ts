import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { ControllerError } from "../../src/controller/errors.ts";
import { fixture, use } from "./application-fixture.ts";
import { paidPair } from "./entry-fixture.ts";
import { credential, faultProxy } from "./entry-http-fixture.ts";
import { kernel, local, txid, using } from "./controller-port-fixture.ts";

test("A25: TypeScript controller acknowledges identity before entry and recovers lost entry replies with one send", async (t) => {
  for (const boundary of ["before", "after"] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      yield* Effect.promise(async () => {
        const proxy = await faultProxy(t, listener.url), k = kernel(f.root, proxy.url);
        k.journal.down = true;
        await assert.rejects(using(k, controller => controller.issue("b1")), /journal/);
        assert.equal(proxy.control.lookups, 0); assert.equal(proxy.control.creates, 0); assert.equal(local(k.database).attempted, 0);
        k.journal.down = false; proxy.control[boundary] = true;
        await assert.rejects(using(k, controller => controller.issue("b1")), /registry response unavailable/);
        const key = local(k.database).entry_key; assert(key); assert.equal(k.calls.broadcasts, 0);
        assert.equal(k.journal.entries().at(-1)!.kind, "batch");
        const result = await using(k, controller => controller.issue("b1"));
        assert.equal(result.entry_key, key); assert.equal(result.state, "broadcast"); assert.equal(result.txid, txid);
        assert.equal(result.raw, "010203"); assert.equal(k.calls.broadcasts, 1); assert.equal(proxy.control.upstreamCreates, 1);
        await assert.rejects(using(k, controller => controller.send("b1")), /already attempted/);
      });
    }));
  }
});

test("A26: TypeScript controller checks the live intent before first arm and refuses a second send", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    yield* Effect.promise(async () => {
      const proxy = await faultProxy(t, listener.url), k = kernel(f.root, proxy.url);
      k.journal.afterAppend = b => { if (b.state === "issuing") k.journal.down = true; };
      await assert.rejects(using(k, controller => controller.issue("b1")), /journal/);
      assert.equal(local(k.database).state, "issuing"); assert.equal(local(k.database).attempted, 0);
      assert.equal(k.calls.broadcasts, 0); assert.equal(proxy.control.arms, 0);
      k.journal.down = false; k.journal.afterAppend = undefined;
      f.node.outputs[0]!.confirmations = 2;
      await assert.rejects(using(k, controller => controller.send("b1")), /locks/);
      assert.equal(local(k.database).attempted, 0); assert.equal(proxy.control.arms, 0);
      f.node.outputs[0]!.confirmations = 3;
      const result = await using(k, controller => Effect.gen(function* () {
        const result = yield* controller.resume("b1");
        yield* Effect.promise(() => assert.rejects(Effect.runPromise(controller.send("b1")), /already attempted/));
        return result;
      }));
      assert.equal(result.state, "broadcast"); assert.equal(k.calls.broadcasts, 1); assert.equal(proxy.control.arms, 1);
    });
  }));
});

test("A20: TypeScript controller makes every unusable broadcast answer uncertain and never repeats it", async (t) => {
  for (const [status, body] of [[200, ""], [200, "not-json"], [200, "{}"], [200, '{"txid":"short"}'],
    [200, '{"txid":"' + "f".repeat(64) + '"'], [503, "subs failed"], [500, JSON.stringify({ txid })],
    [200, '{"txid":"' + txid + '","txid":"' + txid + '"}'], [200, "z".repeat(2100)]] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      yield* Effect.promise(async () => {
        const k = kernel(f.root, listener.url); k.calls.answer = { status, body };
        const result = await using(k, controller => controller.issue("b1"));
        assert.equal(result.state, "broadcast_uncertain"); assert.equal(result.attempted, 1); assert.equal(k.calls.broadcasts, 1);
        if (body.length > 2000) assert.match(result.answer!, /cut: 2110 characters in all/);
        else assert.equal(result.answer, `HTTP ${status}: ${body}`);
        await using(k, controller => Effect.gen(function* () {
          assert.equal((yield* controller.alerts()).filter(alert => alert.kind === "broadcast_uncertain").length, 1);
          yield* Effect.promise(() => assert.rejects(Effect.runPromise(controller.resume("b1")), /unattempted/));
          yield* Effect.promise(() => assert.rejects(Effect.runPromise(controller.send("b1")), /already attempted/));
        }));
        assert.equal(k.calls.broadcasts, 1); assert.equal(k.calls.captures, 0);
      });
    }));
  }
});

test("O23: TypeScript controller loses arm replies conservatively and rechecks both journals after permission", async (t) => {
  for (const boundary of ["before", "after", "controller-down", "store-down", "arm-recheck-failure"] as const) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
      yield* Effect.promise(async () => {
        const proxy = await faultProxy(t, listener.url), k = kernel(f.root, proxy.url);
        if (boundary === "before") proxy.control.beforePath = "/operator/issuance-entries/arm";
        if (boundary === "after") proxy.control.afterPath = "/operator/issuance-entries/arm";
        if (boundary === "controller-down") k.calls.afterArm = () => { k.journal.down = true; };
        if (boundary === "store-down") k.calls.afterArm = () => { f.journal.down = true; };
        if (boundary === "arm-recheck-failure") k.calls.afterArm = () => { proxy.control.beforePath = "/operator/issuance-entries/lookup"; };
        k.calls.beforeArm = () => { assert.equal(local(k.database).attempted, 1); assert.equal(k.calls.broadcasts, 0); };
        await assert.rejects(using(k, controller => controller.issue("b1")), /uncertain|permission/);
        assert.equal(local(k.database).state, "broadcast_uncertain"); assert.equal(local(k.database).attempted, 1);
        assert.equal(k.calls.broadcasts, 0); assert.equal(proxy.control.arms, 1);
        k.journal.down = false; f.journal.down = false;
        await assert.rejects(using(k, controller => controller.resume("b1")), /unattempted/);
        assert.equal(proxy.control.arms, 1); assert.equal(k.calls.broadcasts, 0);
      });
    }));
  }
});

test("TypeScript controller retains known-unsent locks on failed members and records lost broadcast responses", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    yield* Effect.promise(async () => {
      const k = kernel(f.root, listener.url);
      f.node.outputs[0]!.confirmations = 2;
      await assert.rejects(using(k, controller => controller.issue("b1")), /failed/);
      assert.equal(local(k.database).entry_key, null); assert.equal(k.calls.broadcasts, 0);
      f.node.outputs[0]!.confirmations = 3; k.calls.broadcastError = true;
      const result = await using(k, controller => controller.issue("b1"));
      assert.equal(result.state, "broadcast_uncertain"); assert.equal(k.calls.broadcasts, 1);
    });
  }));
});

test("TypeScript controller serializes concurrent issue calls and preserves a known txid after capture failure", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* paidPair(store, f); const listener = yield* serveOperator(store, Effect.succeed(credential));
    yield* Effect.promise(async () => {
      const k = kernel(f.root, listener.url), broken = { ...k, ports: { ...k.ports,
        capture: () => Effect.fail(new ControllerError({ code: "unavailable", message: "capture unavailable" })) } };
      await using(broken, controller => Effect.promise(async () => {
        const results = await Promise.allSettled([Effect.runPromise(controller.issue("b1")), Effect.runPromise(controller.issue("b1"))]);
        assert.equal(results.filter(result => result.status === "rejected").length, 2);
        assert.equal(k.calls.broadcasts, 1); assert.equal(local(k.database).state, "broadcast"); assert.equal(local(k.database).txid, txid);
      }));
    });
  }));
});
