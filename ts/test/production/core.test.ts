import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { BitcoinRpc, RpcError } from "../../src/bitcoin/rpc.ts";
import { CoreAdapter } from "../../src/bitcoin/core.ts";
import { amount } from "../../src/bitcoin/validation.ts";
import { SalesStore } from "../../src/application/store.ts";
import { nodeFixture, rpcFixture, recorded, script, hash, txid } from "./core-fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
test("Z13: RPC uses current local cookie credentials and rejects redirects and mismatched replies", async (t) => {
  const f = await rpcFixture(t, () => ({ result: true })), rpc = new BitcoinRpc(f.config);
  assert.equal(await run(rpc.call("getblockcount")), true);
  writeFileSync(f.config.cookiePath, `__cookie__:${randomUUID()}`, { mode: 0o600 });
  assert.equal(await run(rpc.call("getblockcount")), true);
  assert.deepEqual(f.authentication, [true, true]);
  const other = await rpcFixture(t, () => ({ result: true }));
  const redirect = await rpcFixture(t, () => ({ status: 302, location: other.config.url }));
  await assert.rejects(run(new BitcoinRpc(redirect.config).call("getblockcount")), /failed/);
  assert.equal(other.authentication.length, 0);
  const wrong = await rpcFixture(t, () => ({ result: true, id: "wrong" }));
  await assert.rejects(run(new BitcoinRpc(wrong.config).call("getblockcount")), /protocol/);
  const mixed = await rpcFixture(t, call => ({ raw: JSON.stringify({ id: call.id, result: true, error: { code: -5 } }) }));
  await assert.rejects(run(new BitcoinRpc(mixed.config).call("getmempoolentry")), /protocol/);
  const credentialUrl = new URL(f.config.url); credentialUrl.username = "operator"; credentialUrl.password = randomUUID();
  for (const url of ["http://example.invalid/", credentialUrl.href, f.config.url + "?credential=" + randomUUID()])
    assert.throws(() => new BitcoinRpc({ ...f.config, url }), /protocol/);
});
test("Z13: RPC bounds replies, timeouts and interruption without exposing node errors", async (t) => {
  const marker = randomUUID();
  const rejected = await rpcFixture(t, call => ({ raw: JSON.stringify({ id: call.id,
    error: { code: -28, message: marker } }) }));
  await assert.rejects(run(new BitcoinRpc(rejected.config).call("getblockcount")), error => {
    assert(error instanceof RpcError); assert.equal(error.rpcCode, -28);
    assert.equal(String(error).includes(marker), false); return true;
  });
  const large = await rpcFixture(t, () => ({ result: "x".repeat(1000) }));
  await assert.rejects(run(new BitcoinRpc({ ...large.config, maximumBytes: 100 }).call("getblockcount")), /protocol/);
  const slow = await rpcFixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 80)); return { result: true }; });
  await assert.rejects(run(new BitcoinRpc({ ...slow.config, timeoutMs: 10 }).call("getblockcount")), /transport/);
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const f = await rpcFixture(t, async call => {
    if (call.method === "wait") { entered(); await waiting; } return { result: true };
  });
  const controller = new AbortController(), rpc = new BitcoinRpc(f.config);
  const pending = Effect.runPromise(rpc.call("wait"), { signal: controller.signal });
  await ready; controller.abort(); await assert.rejects(pending); finish();
  assert.equal(await run(rpc.call("getblockcount")), true);
});
test("Z14: RPC preserves exact BTC output decimals before conversion to sats", async (t) => {
  for (const [decimal, expected] of [["0.00000001", 1], ["1e-8", 1], ["0.00000600", 600],
    ["20000000.00000001", 2_000_000_000_000_001], ["21000000.00000000", 2_100_000_000_000_000]] as const)
    assert.equal(amount(decimal), expected);
  for (const bad of ["0.000000001", "21000000.00000001", "-1", "NaN", "1e999999", "1.1e-8"])
    assert.throws(() => amount(bad));
  const f = await rpcFixture(t, call => ({ raw: `{"id":"${call.id}","result":{"value":20000000.000000001}}` }));
  const value = await run(new BitcoinRpc(f.config).call("gettransaction")) as { value: string };
  assert.equal(value.value, "20000000.000000001"); assert.throws(() => amount(value.value), /sub-satoshi/);
});
test("Z14: receipt history retains spent outputs and counts each vout once through reorgs", async (t) => {
  const f = await nodeFixture(t), core = await run(CoreAdapter.make(f.coreConfig));
  f.state.txids = [txid, txid];
  const first = await run(core.snapshot([recorded]));
  assert.deepEqual(first.outputs.map(o => [o.outpoint, o.sats, o.confirmations]), [[`${txid}:0`, 600, 2], [`${txid}:1`, 400, 2]]);
  f.state.conf = 0; assert.equal((await run(core.snapshot([recorded]))).outputs[0]!.confirmations, 0);
  f.state.mempool = false; assert.deepEqual((await run(core.snapshot([recorded]))).outputs, []);
  f.state.conf = 3; const reorg = await run(core.snapshot([recorded]));
  assert.equal(reorg.outputs.reduce((sum, o) => sum + o.sats, 0), 1000);
  assert.equal(reorg.outputs[0]!.outpoint, first.outputs[0]!.outpoint);
  for (const forbidden of ["listunspent", "listtransactions", "listreceivedbyaddress", "getrawtransaction", "sendrawtransaction", "signrawtransactionwithwallet"])
    assert.equal(f.calls.some(c => c.method === forbidden), false);
  assert(f.calls.some(c => c.method === "listsinceblock" && c.params[0] === null && c.params[4] === true));
});
test("Z15: unready or mismatched Core and wallet state blocks observations and address allocation", async (t) => {
  for (const mode of ["version", "network", "sync", "scan", "mempool", "wallet-tip", "wallet-name", "ownership"]) {
    const f = await nodeFixture(t), core = await run(CoreAdapter.make(f.coreConfig));
    switch (mode) {
      case "version": f.state.version = 310000; break;
      case "network": f.state.chain = "main"; break;
      case "sync": f.state.ibd = true; break;
      case "scan": f.state.scanning = true; break;
      case "mempool": f.state.loaded = false; break;
      case "wallet-tip": f.state.walletTip = "d".repeat(64); break;
      case "wallet-name": f.state.walletName = "other"; break;
      case "ownership": f.state.owned = false; break;
    }
    await assert.rejects(run(core.snapshot([recorded])));
    if (mode !== "ownership") {
      await assert.rejects(run(core.newDestination()));
      assert.equal(f.calls.some(c => c.method === "getnewaddress"), false);
    }
  }
});
test("Z16: changing relevant receipts or tips retries and never returns a partial observation", async (t) => {
  const f = await nodeFixture(t), core = await run(CoreAdapter.make(f.coreConfig));
  let count = 0;
  f.state.mutate = call => {
    if (call.method === "getblockchaininfo" && ++count === 2) { f.state.hash = "d".repeat(64); f.state.walletTip = f.state.hash; }
    return undefined;
  };
  assert.equal((await run(core.snapshot([recorded]))).outputs.length, 2);
  assert.equal(count, 4);
  let history = 0;
  f.state.mutate = call => call.method === "listsinceblock" ?
    { result: { lastblock: f.state.hash, transactions: ++history % 2 ? [{ address: recorded.address, txid }] : [] } } : undefined;
  await assert.rejects(run(core.snapshot([recorded])), /changed during payment observation/);
  assert.equal(history, 6);
  f.state.mutate = call => call.method === "getblockheader" ? { result: { hash: "b".repeat(64), height: 99, confirmations: -1 } } : undefined;
  await assert.rejects(run(core.snapshot([recorded])), /changed during payment observation/);
});
test("Z17: malformed receipt data and RPC failures cannot become empty payment history", async (t) => {
  const f = await nodeFixture(t), core = await run(CoreAdapter.make(f.coreConfig));
  for (const mode of ["history", "transaction", "vout", "amount"]) {
    f.state.mutate = call => {
      if (mode === "history" && call.method === "listsinceblock") return { result: { lastblock: hash, transactions: [{ address: recorded.address }] } };
      if (mode === "transaction" && call.method === "gettransaction") return { code: -28 };
      if (mode === "vout" && call.method === "gettransaction") return { result: { txid, confirmations: 0,
        decoded: { txid, vout: [{ n: 1, value: 0.00001, scriptPubKey: { hex: script } }] } } };
      if (mode === "amount" && call.method === "gettransaction") return { result: { txid, confirmations: 0,
        decoded: { txid, vout: [{ n: 0, value: 0.000000001, scriptPubKey: { hex: script } }] } } };
      return undefined;
    };
    await assert.rejects(run(core.snapshot([recorded])));
  }
  f.state.mutate = null; f.state.conf = 0; f.state.mempool = false; f.state.mempoolCode = -28;
  await assert.rejects(run(core.snapshot([recorded])), /getmempoolentry failed/);
  await assert.rejects(run(core.snapshot([recorded, recorded])), /duplicate recorded/);
});
test("Z18: the store passes historical destinations and retains prior state across failed Core reads", async (t) => {
  const f = await nodeFixture(t), core = await run(CoreAdapter.make(f.coreConfig));
  const directory = join(f.root, "journal"); mkdirSync(directory);
  const history = () => ({ result: { lastblock: hash, transactions: [{ address: "mock-new-address", txid }] } });
  f.state.mutate = call => call.method === "listsinceblock" ? history() : undefined;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* SalesStore.open({ database: join(f.root, "store.db"), journalDirectory: directory, riskBudgetSats: 100_000 },
      { clock: () => 0, snapshot: ds => core.snapshot(ds), newDestination: core.newDestination() });
    yield* store.listName("one@space", 1000); yield* store.pause(false);
    const order = yield* store.request({ handle: "one@space", script_pubkey: "5120" + "1".padStart(64, "0") });
    assert.equal((yield* store.quote(order.token)).address, "mock-new-address");
    f.state.conf = 3;
    assert.equal((yield* store.order(order.token)).status, "converted");
    yield* store.cancel(order.token);
    assert.equal((yield* store.order(order.token)).confirmed_sats, 1000);
    const position = f.calls.length;
    yield* store.observe(); assert(f.calls.slice(position).some(c => c.method === "getaddressinfo" && c.params[0] === "mock-new-address"));
    const saved = new DatabaseSync(join(f.root, "store.db"), { readOnly: true });
    const before = saved.prepare("select * from records order by kind,key").all(); saved.close();
    f.state.mutate = call => call.method === "gettransaction" ? { code: -28 } :
      call.method === "listsinceblock" ? history() : undefined;
    yield* Effect.promise(() => assert.rejects(run(store.observe()), /gettransaction failed/));
    const unchanged = new DatabaseSync(join(f.root, "store.db"), { readOnly: true });
    assert.deepEqual(unchanged.prepare("select * from records order by kind,key").all(), before); unchanged.close();
    f.state.mutate = call => call.method === "listsinceblock" ? history() : undefined;
    assert.equal((yield* store.order(order.token)).confirmed_sats, 1000);
  })));
  assert(f.calls.filter(c => c.method === "getblockchaininfo").every(c => c.path === "/"));
  assert(f.calls.filter(c => c.method === "getnewaddress").every(c => c.path === "/wallet/merchant"));
  assert.equal(f.state.hash, hash);
});
