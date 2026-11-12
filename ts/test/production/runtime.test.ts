import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { Effect, Exit, Scope } from "effect";
import { startRuntime } from "../../src/runtime/server.ts";
import { configuration } from "../../src/runtime/config.ts";
import { runtimeFixture, until } from "./runtime-fixture.ts";
import { fixture, use } from "./application-fixture.ts";
import { serveOperator } from "../../src/application/operator-http.ts";
import { credential } from "./entry-http-fixture.ts";

test("O55: strict regtest runtime configuration refuses unsafe or incomplete settings before opening storage", async (t) => {
  const f = await runtimeFixture(t);
  for (const bad of [{ network: "main" }, { version: 2 }, { unknown: true }, { database: "relative.db" },
    { core: { ...f.config.core, url: "https://example.invalid" } }, { riskBudgetSats: 0 }, { pollMilliseconds: 99 },
    { listen: { ...f.config.listen, subs: f.config.listen.operator } }, { merchantDestinations: [{ address: "x", script: "bad" }] },
    { database: join(f.config.journalDirectory, "store.db") }, { credentials: { operator: f.config.credentials.operator, subs: f.config.credentials.operator } }]) {
    const config = { ...f.config, ...bad };
    assert.throws(() => configuration(config), /invalid regtest runtime configuration/);
    const result = await Effect.runPromiseExit(Effect.scoped(startRuntime(config))); assert(Exit.isFailure(result));
    assert.equal(existsSync(f.config.database), false); assert.equal(f.calls.length, 0);
  }
});
test("O56: runtime separates loopback roles and rereads private injected credentials on every request", async (t) => {
  const f = await runtimeFixture(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runtime = yield* startRuntime(f.config);
    yield* Effect.promise(async () => {
      assert.equal((await f.api(runtime.operator, "/operator/status", f.operator)).value.paused, true);
      for (const [url, path, token] of [[runtime.buyer, "/operator/status", f.operator], [runtime.subs, "/operator/status", f.subs],
        [runtime.operator, "/pending?space=@space", f.operator]]) assert.equal((await f.api(url!, path!, token!)).status, 404);
      assert.equal((await f.api(runtime.operator, "/operator/status", f.subs)).status, 401);
      assert.equal((await f.api(runtime.subs, "/health", f.operator)).status, 401);
      const replacement = "mock-rotated-role-credential".padEnd(48, "x");
      writeFileSync(f.config.credentials.operator, replacement);
      assert.equal((await f.api(runtime.operator, "/operator/status", f.operator)).status, 401);
      assert.equal((await f.api(runtime.operator, "/operator/status", replacement)).status, 200);
      writeFileSync(f.config.credentials.subs, replacement);
      assert.equal((await f.api(runtime.operator, "/operator/status", replacement)).status, 503);
      writeFileSync(f.config.credentials.subs, f.subs); chmodSync(f.config.credentials.operator, 0o644);
      assert.equal((await f.api(runtime.operator, "/operator/status", replacement)).status, 503);
    });
  })));
});
test("O57: sequential runtime polling converts paid orders and recovers node outages without sending", async (t) => {
  const f = await runtimeFixture(t);
  let outage = false;
  f.state.mutate = call => {
    if (outage && call.method === "getblockchaininfo") return { code: -28 };
    if (call.method === "listsinceblock") return { result: { lastblock: f.state.hash,
      transactions: f.state.txids.map(txid => ({ address: "mock-new-address", txid })) } };
    return undefined;
  };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runtime = yield* startRuntime(f.config);
    yield* Effect.promise(async () => {
      await f.api(runtime.operator, "/operator/listings", f.operator, { handle: "one@space", price_sats: 1000 });
      await f.api(runtime.operator, "/operator/pause", f.operator, { paused: false });
      const order = await f.api(runtime.buyer, "/requests", undefined, { handle: "one@space", script_pubkey: "5120" + "1".padStart(64, "0") });
      assert.equal(order.status, 201);
      assert.equal((await f.api(runtime.buyer, String(order.value.order_link) + "/quote", undefined, {})).status, 200);
      f.state.conf = 3;
      await until(async () => assert.equal((await f.api(runtime.operator, "/operator/orders/o1", f.operator)).value.status, "converted"));
      outage = true;
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal((await f.api(runtime.operator, "/operator/status", f.operator)).value.chain, null);
      assert.equal((await f.api(runtime.operator, "/operator/orders/o1", f.operator)).value.confirmed_sum, 1000);
      outage = false; f.state.conf = 6;
      await until(async () => assert.equal((await f.api(runtime.operator, "/operator/orders/o1", f.operator)).value.settled_sum, 1000));
      assert.equal(f.calls.some(c => /send|sign|createwallet|import|fundraw/.test(c.method)), false);
    });
  })));
});
test("O58: operator network status uses live validated Core facts and never repeats cached chain evidence during failure", async (t) => {
  const f = await runtimeFixture(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runtime = yield* startRuntime(f.config);
    yield* Effect.promise(async () => {
      const status = () => f.api(runtime.operator, "/operator/status", f.operator);
      assert.deepEqual((await status()).value.chain, { network: "regtest", best_block_hash: f.state.hash, blocks: f.state.height });
      f.state.chain = "main"; assert.equal((await status()).value.chain, null);
      f.state.chain = "regtest"; f.state.walletTip = "b".repeat(64); assert.equal((await status()).value.chain, null);
      f.state.walletTip = f.state.hash; assert.notEqual((await status()).value.chain, null);
    });
  })));
});
test("O59: strict operator listing and pause commands require journal acknowledgment and never allocate addresses", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    const listener = yield* serveOperator(store, Effect.succeed(credential));
    const post = (path: string, raw: string) => fetch(listener.url + path, { method: "POST", headers: { Authorization: `Bearer ${credential}` }, body: raw });
    yield* Effect.promise(async () => {
      for (const raw of ['{"handle":"one@space","handle":"two@space"}', '{"handle":"one@space","price_sats":1,"price_sats":2}',
        '{"handle":"one@space","price_sats":1.5}', '{"h\\u0061ndle":"one@space","price_sats":1}'])
        assert.equal((await post("/operator/listings", raw)).status, 400);
      f.journal.down = true;
      assert.equal((await post("/operator/listings", '{"handle":"one@space","price_sats":1000}')).status, 503);
      assert.equal((await post("/operator/pause", '{"paused":false}')).status, 503);
      f.journal.down = false;
      const updated = await post("/operator/listings", '{"handle":"one@space","price_sats":2000}');
      assert.equal(updated.status, 200); assert.equal((await updated.json() as { acknowledged: boolean }).acknowledged, true);
      assert.equal((await post("/operator/pause", '{"paused":true,"paused":false}')).status, 400);
      assert.equal((await post("/operator/pause", '{"paused":true}')).status, 200);
      assert.equal(f.node.draws, 0);
    });
  }));
});
test("O60: standalone CLI refuses a second owner, scrubs failures and releases listeners and ownership on termination", async (t) => {
  const f = await runtimeFixture(t); f.config.pollMilliseconds = 60_000;
  const file = join(f.root, "runtime.json"); writeFileSync(file, JSON.stringify(f.config));
  const children: ChildProcess[] = [];
  const launch = () => {
    const child = spawn(process.execPath, ["src/main.ts", file], { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
    let output = "", error = ""; child.stdout!.on("data", data => { output += String(data); }); child.stderr!.on("data", data => { error += String(data); });
    return { child, output: () => output, error: () => error };
  };
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } });
  const first = launch(); await until(async () => { assert.equal(first.child.exitCode, null); assert.match(first.output(), /"event":"ready"/); });
  const files = () => readdirSync(f.config.journalDirectory).sort().map(n => [n, readFileSync(join(f.config.journalDirectory, n), "utf8")]);
  const before = files(), calls = f.calls.length, second = launch();
  const [code] = await once(second.child, "exit"); assert.equal(code, 1); assert.equal(second.output(), "");
  assert.equal(second.error().includes(f.root), false); assert.equal(second.error().includes(f.operator), false);
  assert.deepEqual(files(), before); assert.equal(f.calls.length, calls);
  const exited = once(first.child, "exit"); first.child.kill("SIGTERM"); assert.equal((await exited)[0], 0);
  const third = launch(); await until(async () => assert.match(third.output(), /"event":"ready"/));
  const ended = once(third.child, "exit"); third.child.kill("SIGTERM"); assert.equal((await ended)[0], 0);
  // Partial acquisition must close the already-open buyer port and release the store.
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(f.config.listen.operator, "127.0.0.1", resolve));
  try { assert(Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(startRuntime(f.config))))); }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  await Effect.runPromise(Effect.scoped(startRuntime(f.config)));
  // Explicit Scope closure also stops the observer, not just HTTP and SQLite.
  const scope = Scope.makeUnsafe(); await Effect.runPromise(Scope.provide(scope)(startRuntime(f.config)));
  await Effect.runPromise(Scope.close(scope, Exit.void)); const finalCalls = f.calls.length;
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(f.calls.length, finalCalls);
});
