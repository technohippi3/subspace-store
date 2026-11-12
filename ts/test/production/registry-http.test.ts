import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { serveOperator } from "../../src/application/operator-http.ts";
import { servePending } from "../../src/application/pending-http.ts";
import { serve } from "../../src/application/http.ts";
import { DurableStore } from "../../src/storage/store.ts";
import { fixture, invoice, payment, setup, use } from "./application-fixture.ts";

const operator = "mock-operator-entry-credential".padEnd(48, "x"), subs = "mock-subs-entry-credential".padEnd(48, "y");
async function call(url: string, path: string, token: string, body?: string) {
  const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body }) });
  return { status: response.status, value: await response.json() };
}
test("O9: operator entry and subs pending have separate authenticated routes and strict request shapes", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* invoice(store); f.node.outputs = [payment(1)]; yield* store.observe();
    const op = yield* serveOperator(store, Effect.succeed(operator));
    const registry = yield* servePending(store, Effect.succeed(subs)), buyer = yield* serve(store);
    yield* Effect.promise(async () => {
      assert.equal((await call(registry.url, "/pending?space=%40space", operator)).status, 401);
      assert.equal((await call(op.url, "/operator/status", subs)).status, 401);
      assert.equal((await call(buyer.url, "/operator/issuing", operator, '{"oids":["o1"]}')).status, 404);
      assert.equal((await call(op.url, "/pending?space=%40space", operator)).status, 404);
      assert.equal((await call(registry.url, "/health", subs)).status, 200);
      for (const path of ["/pending", "/pending?space=%40space&space=%40space", "/pending?other=%40space", "/pending?space=space"])
        assert.equal((await call(registry.url, path, subs)).status, 400);
      for (const payload of ['{}', '{"oids":["o1"],"oids":["o1"]}', '{"oids":["o1"],"extra":true}', '{"oids":["o1","o1"]}'])
        assert.equal((await call(op.url, "/operator/pending", operator, payload)).status, 400);
      assert.equal((await call(op.url, "/operator/issuing", operator, '{"oids":["o1"]}')).status, 404);
      assert.deepEqual((await call(op.url, "/operator/orders?status=converted", operator)).value, { orders: ["o1"] });
      assert.equal((await call(op.url, "/operator/orders/o1/batch-entry", operator, '{"ignore":true}')).status, 400);
      assert.equal((await call(op.url, "/operator/pending", operator, '{"oids":["o1"]}')).status, 200);
      const pending = await call(registry.url, "/pending?space=%40space", subs);
      assert.deepEqual(pending.value, { handles: [{ handle: "n0@space", script_pubkey: "5120" + "1".padStart(64, "0") }] });
      const issuing = await call(op.url, "/operator/issuance-entries", operator,
        JSON.stringify({ entry: "1".repeat(32), root: "a".repeat(64), oids: ["o1"] }));
      assert.equal(issuing.status, 200);
      assert.deepEqual(issuing.value, { found: true, entry: "1".repeat(32), root: "a".repeat(64), oids: ["o1"], acknowledged: true, batchable: true });
      for (const path of ["/ack", "/committed", "/operator/issuing"])
        assert.equal((await call(registry.url, path, subs, "{}")).status, 404);
    });
  }));
});
test("O10: the Python runner and controller gate use current TypeScript journal evidence before a send", async (t) => {
  const f = fixture(t), file = join(f.root, "mock-operator-token"); writeFileSync(file, operator, { mode: 0o600 });
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* invoice(store); f.node.outputs = [payment(1)]; yield* store.observe();
    const op = yield* serveOperator(store, Effect.succeed(operator));
    const client = async (mode: string) => {
      const result = await promisify(execFile)("python3", ["test/production/runner-registry-client.py", mode, op.url, file,
        f.config.database, f.config.journalDirectory]);
      return JSON.parse(result.stdout) as { ok?: boolean; sent?: number; attempted?: number };
    };
    assert.equal((yield* Effect.promise(() => client("inspect"))).ok, true);
    assert.equal((yield* Effect.promise(() => client("controller-down"))).sent, 0);
    f.journal.down = true;
    assert.equal((yield* Effect.promise(() => client("store-down"))).sent, 0);
    assert.equal((yield* store.inspectionOrder("o1")).journaled_status, "issuing");
    f.journal.down = false;
    assert.deepEqual(yield* Effect.promise(() => client("send")), { sent: 1, attempted: 1 });
  }));
});
test("O11: malformed or foreign pending records refuse application startup without erasing the evidence", async (t) => {
  for (const bad of [{ version: 2, orders: [] }, { version: 1, orders: ["o999"] },
      { version: 1, orders: ["o1", "o1"] }, { version: 1, orders: [], extra: true }]) {
    const f = fixture(t); await use(f, store => Effect.gen(function* () { yield* setup(store); yield* invoice(store); }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config); yield* raw.commit([{ kind: "registry_pending", key: "global", value: bad }]);
    })));
    await assert.rejects(use(f, () => Effect.void), /invalid (?:pending|stored fields)/);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const raw = yield* DurableStore.open(f.config); assert.deepEqual((yield* raw.get("registry_pending", "global"))!.value, bad);
    })));
  }
});
