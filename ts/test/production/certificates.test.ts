import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { serve } from "../../src/application/http.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { CERTIFICATE_LIMIT, certificateHash } from "../../src/application/certificate-cache.ts";
import { DurableStore } from "../../src/storage/store.ts";
import { armed } from "./commitment-fixture.ts";
import { certificateFixture } from "./certificate-fixture.ts";
import { use } from "./application-fixture.ts";
import { credential } from "./entry-http-fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
test("O36: mismatched certificate binding, revision, root basis and encoding never create readiness", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const token = (yield* f.prepare(store))[0]!;
    for (const bad of [{ root: "f".repeat(64) }, { delegate: "e".repeat(64) + ":0" }, { oid: "o3" }, { revision: 0 },
      { revision: 2 }, { certificateRoot: "c".repeat(64) }, { certificateHeight: 100 }, { message_b64: "Zh==" }, { message_b64: "" }])
      yield* Effect.promise(() => assert.rejects(run(store.registry.certificates.accept({ ...f.packet(), ...bad }))));
    assert.equal((yield* store.order(token)).status, "issuing"); assert.equal((yield* store.order(token)).certificate_available, false);
  }));
});
test("O36: own and later-root certificate callbacks atomically bind readiness, cache hash and immutable order", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* f.prepare(store);
    for (const packet of [f.packet(), f.packet("o2", 1, "c".repeat(64), 55)]) {
      const receipt = yield* store.registry.certificates.accept(packet); assert.equal(receipt.acknowledged, true);
      assert.equal(receipt.hash, certificateHash(f.message)); assert.equal(receipt.length, f.message.length);
      assert.deepEqual(yield* store.registry.certificates.accept(packet), receipt);
    }
    for (const token of tokens) {
      const order = yield* store.order(token); assert.equal(order.status, "ready"); assert.equal(order.certificate_available, true);
      assert.deepEqual(yield* store.certificate(token), f.message);
      yield* Effect.promise(() => assert.rejects(run(store.cancel(token)), /once issuing/));
    }
    for (const oid of armed.oids) assert.equal((yield* store.inspectionOrder(oid)).price_reserve, 1000);
    assert.equal(JSON.stringify(f.journal.read()).includes(f.message.toString("base64")), false);
    assert.equal(statSync(join(f.config.database + ".certificates", certificateHash(f.message))).mode & 0o777, 0o600);
  }));
});
test("O37: readiness survives restart and ordinary descendant tips without repeated verification", async (t) => {
  const f = certificateFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () { token = (yield* f.prepare(store))[0]!; yield* store.registry.certificates.accept(f.packet()); }));
  f.node.tip = 211; f.chain.hash = "c".repeat(64);
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* store.order(token)).status, "ready"); assert.deepEqual(yield* store.certificate(token), f.message);
    yield* store.registry.commitments.observe({ ...armed, expectedRevision: 1, observation: f.facts(50, 50, 211) });
    assert.deepEqual(yield* store.certificate(token), f.message);
  }));
});
test("O37: startup without checkpoint verification or with an unavailable chain withholds readiness", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () { yield* f.prepare(store); yield* store.registry.certificates.accept(f.packet()); }));
  const chain = f.adapters.certificateChain!; delete f.adapters.certificateChain;
  await assert.rejects(use(f, () => Effect.void), /chain adapter is required/);
  f.adapters.certificateChain = chain; f.chainControl.down = true;
  await assert.rejects(use(f, () => Effect.void), /checkpoint unavailable/);
  f.chainControl.down = false;
  await use(f, store => Effect.gen(function* () { assert.equal((yield* store.inspectionOrder("o1")).status, "ready"); }));
});
test("O38: unacknowledged certificate readiness is withheld through outage and recovered with the same cache binding", async (t) => {
  const f = certificateFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    token = (yield* f.prepare(store))[0]!;
    const append = f.journal.append.bind(f.journal);
    f.journal.append = value => { if (value.changes.some(c => c.kind === "certificate")) f.journal.down = true; return append(value); };
    assert.equal((yield* store.registry.certificates.accept(f.packet())).acknowledged, false);
    assert.equal((yield* store.order(token)).certificate_available, false);
    yield* Effect.promise(() => assert.rejects(run(store.certificate(token)), /unavailable/));
    f.journal.append = append;
  }));
  await assert.rejects(use(f, () => Effect.void), /journal outage/); f.journal.down = false;
  await use(f, store => Effect.gen(function* () { assert.deepEqual(yield* store.certificate(token), f.message); }));
});
test("O39: checkpoint loss blocks old callbacks and cached certificates until a newer observation and re-verification", async (t) => {
  const f = certificateFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    token = (yield* f.prepare(store))[0]!; yield* store.registry.certificates.accept(f.packet());
    f.chain.hash = "c".repeat(64);
    assert.equal((yield* store.order(token)).status, "issuing");
    yield* Effect.promise(() => assert.rejects(run(store.certificate(token)), /unavailable/));
    f.chain.hash = "b".repeat(64);
    yield* Effect.promise(() => assert.rejects(run(store.registry.certificates.accept(f.packet())), /invalidated/));
    yield* store.registry.commitments.observe({ ...armed, expectedRevision: 1, observation: f.facts(50, 50, 210) });
    assert.equal((yield* store.order(token)).certificate_available, false);
    yield* store.registry.certificates.accept(f.packet("o1", 2)); assert.deepEqual(yield* store.certificate(token), f.message);
  }));
});
test("O40: reported finality or coverage loss invalidates readiness without releasing price or refund accounting", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* f.prepare(store); yield* store.registry.certificates.accept(f.packet()); f.node.outputs = [];
    assert.deepEqual((yield* store.order(tokens[0]!)).reconciling, ["post_issuance_deficit"]);
    yield* store.registry.commitments.observe({ ...armed, expectedRevision: 1, observation: f.facts(50, null, 210) });
    const order = yield* store.inspectionOrder("o1"); assert.equal(order.status, "issuing"); assert.equal(order.price_reserve, 1000);
    assert.equal((yield* store.order(tokens[0]!)).certificate_available, false);
    yield* Effect.promise(() => assert.rejects(run(store.registry.certificates.accept(f.packet("o1", 2))), /final and covered/));
    yield* Effect.promise(() => assert.rejects(run(store.cancel(tokens[0]!)), /once issuing/));
  }));
});
test("O41: authenticated certificate uploads and opaque-link binary downloads enforce separate bounds and no-store headers", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const tokens = yield* f.prepare(store), operator = yield* serveOperator(store, Effect.succeed(credential)), buyer = yield* serve(store);
    yield* Effect.promise(async () => {
      const send = (body: string, auth = credential) => fetch(operator.url + "/operator/certificates", { method: "POST", headers: { Authorization: `Bearer ${auth}` }, body });
      const raw = JSON.stringify(f.packet()); assert.equal((await send(raw, "wrong")).status, 401);
      for (const invalid of [raw.replace('"revision":1', '"revision":1,"revision":1'), raw.replace('"oid":', '"unknown":'),
        raw.replace('"revision":1', '"revis\\u0069on":1')]) assert.equal((await send(invalid)).status, 400);
      const large = Buffer.alloc(CERTIFICATE_LIMIT, 97);
      assert.equal((await send(JSON.stringify(f.packet("o1", 1, armed.root, 50, large)))).status, 200);
      const result = await fetch(buyer.url + `/orders/${tokens[0]}/certificate`);
      assert.equal(result.status, 200); assert.equal(result.headers.get("content-type"), "application/octet-stream");
      assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal(result.headers.get("referrer-policy"), "no-referrer");
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), large);
      assert.equal((await fetch(buyer.url + "/orders/o1/certificate")).status, 404);
      assert.equal((await send(JSON.stringify(f.packet("o2", 1, armed.root, 50, Buffer.alloc(CERTIFICATE_LIMIT + 1))))).status, 400);
      assert.equal((await fetch(buyer.url + "/requests", { method: "POST", body: "x".repeat(65_537) })).status, 400);
    });
  }));
});
test("O42: missing or corrupt local bytes are never served and exact verified redelivery heals the cache", async (t) => {
  const f = certificateFixture(t);
  await use(f, store => Effect.gen(function* () {
    const token = (yield* f.prepare(store))[0]!; yield* store.registry.certificates.accept(f.packet());
    const file = join(f.config.database + ".certificates", certificateHash(f.message));
    for (const missing of [false, true]) {
      if (missing) unlinkSync(file); else writeFileSync(file, "corrupt");
      assert.equal((yield* store.order(token)).certificate_available, false);
      yield* store.registry.certificates.accept(f.packet()); assert.deepEqual(readFileSync(file), f.message);
      assert.deepEqual(yield* store.certificate(token), f.message);
    }
  }));
});
test("O43: invalid certificate metadata refuses startup and retains its evidence", async (t) => {
  for (const fault of ["version", "entry", "revision", "hash", "blocked", "invalid-blocked"]) {
    const f = certificateFixture(t);
    await use(f, store => Effect.gen(function* () { yield* f.prepare(store); yield* store.registry.certificates.accept(f.packet()); }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config), record = (yield* raw.get("certificate", "o1"))!;
      const value = { ...(record.value as { [k: string]: import("../../src/storage/codec.ts").Json }) };
      if (fault === "version") value.version = 2; if (fault === "entry") value.entry = "9".repeat(32);
      if (fault === "revision") value.revision = 99; if (fault === "hash") value.hash = "invalid"; if (fault === "blocked") value.blockedThrough = 1;
      const changes: import("../../src/storage/codec.ts").Change[] = [{ kind: "certificate", key: "o1", value }];
      if (fault === "invalid-blocked") {
        value.valid = false;
        const order = (yield* raw.get("sales_order", "o1"))!.value as { [k: string]: import("../../src/storage/codec.ts").Json };
        order.status = "issuing"; changes.push({ kind: "sales_order", key: "o1", value: order });
      }
      yield* raw.commit(changes);
    })));
    await assert.rejects(use(f, () => Effect.void), /certificate/);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () { const raw = yield* DurableStore.open(f.config); assert(yield* raw.get("certificate", "o1")); })));
  }
});
