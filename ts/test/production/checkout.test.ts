import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { serve } from "../../src/application/http.ts";
import { SalesStore } from "../../src/application/store.ts";
import { DurableStore } from "../../src/storage/store.ts";
import { fixture, invoice, payment, script, setup, use } from "./application-fixture.ts";

async function post(url: string, value: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value) });
  return { code: response.status, value: await response.json() as { token: string; address: string | null;
    address_pending: boolean; cancellation: string | null; status: string; error?: string } };
}
test("V1: HTTP recipient requests create private links without claiming scripts", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const first = await post(listener.url + "/requests", { handle: "n0@space", script_pubkey: script });
      const second = await post(listener.url + "/requests", { handle: "n1@space", script_pubkey: script });
      assert.equal(first.code, 201); assert.equal(second.code, 201);
      assert.notEqual(first.value.token, second.value.token);
      const response = await fetch(`${listener.url}/orders/${first.value.token}`);
      const view = await response.json() as { handle: string; status: string; address: null };
      assert.equal(view.handle, "n0@space"); assert.equal(view.status, "requested"); assert.equal(view.address, null);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal((await fetch(`${listener.url}/orders/${"x".repeat(32)}`)).status, 404);
      for (const name of readdirSync(f.root, { recursive: true })) {
        const file = join(f.root, String(name));
        if (statSync(file).isFile()) assert.equal(readFileSync(file).includes(first.value.token), false);
      }
    });
  }));
});
test("V2: a request with an extra testing field is refused without persisting its value", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const before = f.journal.read().length, marker = randomUUID();
      const response = await post(listener.url + "/requests", { handle: "n0@space", script_pubkey: script,
        dev_private_key: marker });
      assert.equal(response.code, 400); assert.equal(f.journal.read().length, before);
      assert.equal(JSON.stringify(response.value).includes(marker), false);
      const db = new DatabaseSync(f.config.database, { readOnly: true });
      try { assert.equal(JSON.stringify(db.prepare("select * from records").all()).includes(marker), false); }
      finally { db.close(); }
    });
  }));
});
test("V3: HTTP rejects extra, missing, repeated, escaped repeated and non-string fields", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const before = f.journal.read().length;
      const bodies = [ { handle: "n0@space", script_pubkey: script, extra: true }, { handle: "n0@space" },
        { handle: "n0@space", script_pubkey: 7 }, `{"handle":"n0@space","handle":"n1@space"}`,
        `{"handle":"n0@space","\\u0068andle":"n1@space"}`, "[]", "null", "{", " ".repeat(65_537) ];
      for (const body of bodies) assert.equal((await post(listener.url + "/requests", body)).code, 400);
      assert.equal(f.journal.read().length, before); assert.equal(f.node.observations, 0); assert.equal(f.node.draws, 0);
    });
  }));
});
test("V4: HTTP refuses noncanonical handles without normalization or side effects", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const before = f.journal.read().length;
      for (const handle of ["N0@space", " n0@space", "n0@space\n", "-n0@space", "n0-@space", "@n0@space", "nø@space", "n0"])
        assert.equal((await post(listener.url + "/requests", { handle, script_pubkey: script })).code, 400);
      assert.equal(f.journal.read().length, before);
    });
  }));
});
test("V5: HTTP refuses unlisted handles without creating orders or journal entries", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const before = f.journal.read().length;
      const response = await post(listener.url + "/requests", { handle: "unlisted@space", script_pubkey: script });
      assert.equal(response.code, 409); assert.equal(response.value.error, "not for sale");
      assert.equal(f.journal.read().length, before);
    });
  }));
});
test("V6: HTTP accepts only the exact lowercase P2TR script shape", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const before = f.journal.read().length;
      for (const spk of ["0014" + "11".repeat(20), "6a00", script.slice(0, -2), script + "00", "5220" + script.slice(4),
        "5120" + "0C".padStart(64, "0")])
        assert.equal((await post(listener.url + "/requests", { handle: "n0@space", script_pubkey: spk })).code, 400);
      assert.equal(f.journal.read().length, before);
    });
  }));
});
test("V7: HTTP rejects P2TR keys off the curve or outside the field", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const before = f.journal.read().length;
      for (const key of ["5".padStart(64, "0"), "ff".repeat(32)])
        assert.equal((await post(listener.url + "/requests", { handle: "n0@space", script_pubkey: "5120" + key })).code, 400);
      assert.equal(f.journal.read().length, before);
    });
  }));
});
test("V8: a paid recipient blocks requests and earlier unquoted nominations for another handle", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store);
    const earlier = yield* store.request({ handle: "n1@space", script_pubkey: script });
    yield* invoice(store);
    f.node.outputs = [payment(1)]; yield* store.observe();
    const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const count = f.journal.read().length;
      const request = await post(listener.url + "/requests", { handle: "n2@space", script_pubkey: script });
      assert.equal(request.code, 409); assert.equal(request.value.error, "script already used");
      assert.equal(f.journal.read().length, count);
      const quote = await post(`${listener.url}/orders/${earlier.token}/quote`, {});
      assert.equal(quote.code, 409); assert.equal(quote.value.error, "script already used");
      assert.equal(f.node.draws, 1);
    });
  }));
});
test("V10: retrying the same public request returns a fresh link and preserves the original", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const input = { handle: "n0@space", script_pubkey: script };
      const first = await post(listener.url + "/requests", input), second = await post(listener.url + "/requests", input);
      assert.equal(first.code, 201); assert.equal(second.code, 201);
      assert.notEqual(first.value.token, second.value.token);
      assert.equal(JSON.stringify(second.value).includes(first.value.token), false);
      assert.equal((await fetch(`${listener.url}/orders/${first.value.token}`)).status, 200);
      assert.equal((await fetch(`${listener.url}/orders/${second.value.token}`)).status, 200);
    });
  }));
});
test("V11: a historical wallet destination cannot be nominated as a recipient", async (t) => {
  const f = fixture(t), walletScript = "5120" + "2".padStart(64, "0");
  f.adapters.newDestination = Effect.succeed({ address: "mock-wallet-address", script: walletScript });
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store); yield* store.cancel(first.token);
    const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      const count = f.journal.read().length;
      const response = await post(listener.url + "/requests", { handle: "n1@space", script_pubkey: walletScript });
      assert.equal(response.code, 409); assert.equal(response.value.error, "script already used");
      assert.equal(f.journal.read().length, count);
    });
  }));
});
test("Z11: HTTP withholds addresses and final cancellations until their journal acknowledgment", async (t) => {
  const f = fixture(t); let token = "", secondToken = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store);
    token = (yield* store.request({ handle: "n0@space", script_pubkey: script })).token;
    const listener = yield* serve(store);
    yield* Effect.promise(async () => {
      f.journal.down = true;
      assert.equal((await post(`${listener.url}/orders/${token}/quote`, {})).code, 503);
      assert.equal(f.node.draws, 0);
      f.journal.down = false;
      f.node.beforeDestination = async () => { f.journal.down = true; };
      const pending = await post(`${listener.url}/orders/${token}/quote`, {});
      assert.equal(pending.code, 503); assert.equal(pending.value.address, null);
      assert.equal((await (await fetch(`${listener.url}/orders/${token}`)).json() as { address: null }).address, null);
      f.journal.down = false; f.node.beforeDestination = null;
      const recovered = await post(`${listener.url}/orders/${token}/quote`, {});
      assert.equal(recovered.code, 200); assert.equal(recovered.value.address, "mock-address-1");
      assert.equal(f.node.draws, 1);
    });
    secondToken = (yield* invoice(store, 1)).token;
    f.node.outputs = [payment(1), payment(2)]; yield* store.observe();
    yield* Effect.promise(async () => {
      f.journal.down = true;
      for (let i = 0; i < 2; i++) {
        const response = await post(`${listener.url}/orders/${secondToken}/cancel`, {});
        assert.equal(response.code, 202); assert.equal(response.value.status, "converted");
        assert.equal(response.value.cancellation, "unconfirmed");
      }
    });
  }));
  f.journal.down = false;
  await use(f, store => Effect.gen(function* () {
    const result = yield* store.order(secondToken);
    assert.equal(result.status, "cancelled"); assert.equal(result.cancellation, "final");
    assert.equal((yield* store.order(token)).status, "converted");
  }));
});
test("Z12: wallet waits hold no SQLite transaction and interruption releases the application queue", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store);
    const link = yield* store.request({ handle: "n0@space", script_pubkey: script });
    yield* Effect.promise(async () => {
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      f.node.beforeDestination = async () => { entered(); await waiting; };
      const abort = new AbortController();
      const pending = Effect.runPromise(store.quote(link.token), { signal: abort.signal });
      await ready;
      const db = new DatabaseSync(f.config.database);
      try { db.exec("begin immediate; rollback;"); } finally { db.close(); }
      const cancelled = Effect.runPromise(store.cancel(link.token));
      abort.abort(); await assert.rejects(pending);
      const view = await cancelled;
      assert.equal(view.status, "cancelled"); assert.equal(view.cancellation, "final"); assert.equal(view.address, null);
      release(); f.node.beforeDestination = null;
      assert.equal((await Effect.runPromise(invoice(store, 1))).quote.address, "mock-address-2");
    });
  }));
});
test("Z10: application startup rejects foreign record kinds and releases ownership", async (t) => {
  const f = fixture(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const storage = yield* DurableStore.open(f.config);
    yield* storage.commit([{ kind: "unknown", key: "bad", value: { extra: true } }]);
  })));
  await assert.rejects(use(f, () => Effect.void), /unknown application record/);
  await Effect.runPromise(Effect.scoped(DurableStore.open(f.config)));
  await assert.rejects(Effect.runPromise(Effect.scoped(SalesStore.open({ ...f.config, riskBudgetSats: 0 }, f.adapters))), /invalid integer/);
  for (const mutation of ["unknown-field", "identity", "relationship"]) {
    const other = fixture(t);
    await use(other, store => Effect.gen(function* () { yield* setup(store); yield* invoice(store); }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const storage = yield* DurableStore.open(other.config);
      const order = (yield* storage.get("sales_order", "o1"))!.value as { [key: string]: import("../../src/storage/codec.ts").Json };
      if (mutation === "unknown-field") order.extra = true;
      if (mutation === "identity") order.id = "o999";
      if (mutation === "relationship") order.handle = "missing@space";
      yield* storage.commit([{ kind: "sales_order", key: "o1", value: order }]);
    })));
    await assert.rejects(use(other, () => Effect.void), /invalid/);
    await Effect.runPromise(Effect.scoped(DurableStore.open(other.config)));
  }
});
