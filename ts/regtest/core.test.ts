import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { BitcoinRpc } from "../src/bitcoin/rpc.ts";
import { CoreAdapter } from "../src/bitcoin/core.ts";
import { SalesStore } from "../src/application/store.ts";
import { object, hex, integer } from "../src/bitcoin/validation.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const repository = fileURLToPath(new URL("../../", import.meta.url));
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function until(work: () => Promise<void>): Promise<void> {
  const end = Date.now() + 30_000;
  for (;;) {
    try { await work(); return; } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
test("Core 31.2 regtest observes payments, reorgs, spent receipts and mempool reload without invented timing", async (t) => {
  assert.equal(process.env.SUBSPACE_CORE_REGTEST_ISOLATED, "1", "run through npm run test:core");
  const binary = resolve(process.env.SUBSPACE_BITCOIND ?? join(repository, "regtest/.cache/bin/bitcoind"));
  assert.match(execFileSync(binary, ["-version"], { encoding: "utf8" }).split("\n")[0]!, /v31\.2\.0/);
  const name = `core-adapter-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const root = join(repository, "regtest/.run", name); mkdirSync(root, { recursive: true, mode: 0o700 });
  const data = join(root, "bitcoin"); mkdirSync(data);
  const port = await freePort(), cookiePath = join(data, "regtest/.cookie"), url = `http://127.0.0.1:${port}/`;
  const config = { url, cookiePath, timeoutMs: 30_000 };
  const node = new BitcoinRpc(config), wallets = ["merchant", "buyer", "miner"];
  const wallet = (name: string) => new BitcoinRpc({ ...config, wallet: name });
  const merchant = wallet("merchant"), buyer = wallet("buyer"), miner = wallet("miner");
  let child: ChildProcess | undefined, mockTime = 0;
  async function start(persist = true) {
    const log = openSync(join(root, `core-${Date.now()}.log`), "a", 0o600);
    try {
      child = spawn(binary, [`-datadir=${data}`, "-regtest", "-server", "-listen=0", "-connect=0", "-dnsseed=0",
        "-discover=0", "-fallbackfee=0.0002", `-rpcport=${port}`, "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1",
        `-persistmempool=${persist ? 1 : 0}`, `-walletbroadcast=${persist ? 1 : 0}`, `-mocktime=${mockTime}`],
        { stdio: ["ignore", log, log] });
    } finally { closeSync(log); }
    await until(async () => { await run(node.call("getblockchaininfo")); });
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => child!.once("exit", () => resolve()));
    try { await run(node.call("stop")); } catch { child.kill("SIGTERM"); }
    await closed;
  }
  t.after(stop);
  await start();
  for (const name of wallets) await run(node.call("createwallet", name));
  const minerAddress = await run(miner.call("getnewaddress"));
  await run(node.call("generatetoaddress", 101, minerAddress));
  const buyerAddress = await run(buyer.call("getnewaddress", "", "bech32m"));
  await run(miner.call("sendtoaddress", buyerAddress, "1.00000000"));
  await run(node.call("generatetoaddress", 1, minerAddress));
  const core = await run(CoreAdapter.make({ ...config, wallet: "merchant", network: "regtest" }));
  let now = 0;
  const journalDirectory = join(root, "journal"); mkdirSync(journalDirectory);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* SalesStore.open({ database: join(root, "store.db"), journalDirectory, riskBudgetSats: 100_000 },
      { clock: () => now, snapshot: destinations => core.snapshot(destinations), newDestination: core.newDestination() });
    yield* store.listName("one@space", 1_000); yield* store.pause(false);
    const order = yield* store.request({ handle: "one@space", script_pubkey: "5120" + "1".padStart(64, "0") });
    const quote = yield* store.quote(order.token); assert(quote.address);
    const txid = yield* buyer.call("sendtoaddress", quote.address, "0.00001000");
    let view = yield* store.order(order.token);
    assert.equal(view.detected_sats, 1_000); assert.equal(view.confirmed_sats, 0); assert.equal(view.status, "quoted");
    const blocks = yield* node.call("generatetoaddress", 1, minerAddress); assert(Array.isArray(blocks));
    view = yield* store.order(order.token); assert.equal(view.confirmed_sats, 1_000); assert.equal(view.status, "quoted");
    yield* node.call("generatetoaddress", 2, minerAddress);
    view = yield* store.order(order.token); assert.equal(view.batchable_sats, 1_000); assert.equal(view.status, "converted");
    yield* node.call("invalidateblock", blocks[0]);
    view = yield* store.order(order.token); assert.equal(view.confirmed_sats, 0); assert.equal(view.status, "converted");
    assert.deepEqual(view.reconciling, ["issuance"]);
    yield* node.call("generateblock", minerAddress, []); yield* node.call("generateblock", minerAddress, []);
    yield* node.call("generatetoaddress", 3, minerAddress);
    view = yield* store.order(order.token); assert.equal(view.confirmed_sats, 1_000); assert.deepEqual(view.reconciling, []);
    const received = object(yield* merchant.call("gettransaction", txid, true, true));
    const decoded = object(received.decoded), vout = decoded.vout as { n: number; scriptPubKey: { address?: string } }[];
    const paid = vout.find(out => out.scriptPubKey.address === quote.address); assert(paid);
    const spend = yield* node.call("createrawtransaction", [{ txid, vout: paid.n }], [{ [buyerAddress as string]: "0.00000330" }]);
    const signed = object(yield* merchant.call("signrawtransactionwithwallet", spend)); assert.equal(signed.complete, true);
    yield* node.call("sendrawtransaction", signed.hex); yield* node.call("generatetoaddress", 1, minerAddress);
    assert.equal(yield* node.call("gettxout", txid, paid.n), null);
    assert.equal((yield* store.order(order.token)).confirmed_sats, 1_000, "spent receipts are still receipts");
    // Change addresses remain owned without address-book entries, including
    // after public descriptor recovery. The reader must not omit them.
    const unlabelled = yield* merchant.call("getrawchangeaddress", "bech32m");
    yield* buyer.call("sendtoaddress", unlabelled, "0.00001000");
    yield* node.call("generatetoaddress", 1, minerAddress);
    yield* node.call("createwallet", "recovered", true, true);
    const recovered = wallet("recovered"), descriptors = object(yield* merchant.call("listdescriptors"));
    assert(Array.isArray(descriptors.descriptors));
    const imported = yield* recovered.call("importdescriptors", descriptors.descriptors.map(raw => {
      const d = object(raw); return { desc: d.desc, timestamp: 0, active: d.active, internal: d.internal, range: [0, 20] };
    }));
    assert(Array.isArray(imported)); assert(imported.every(r => object(r).success === true));
    const addressInfo = object(yield* recovered.call("getaddressinfo", unlabelled));
    assert.equal(addressInfo.ismine, true); assert.deepEqual(addressInfo.labels, []);
    const addressBook = yield* recovered.call("listreceivedbyaddress", 0, true, true, unlabelled, true);
    assert.deepEqual(addressBook, []);
    const reader = yield* CoreAdapter.make({ ...config, wallet: "recovered", network: "regtest" });
    assert.equal(typeof unlabelled, "string");
    const found = yield* reader.snapshot([{ address: unlabelled as string, script: addressInfo.scriptPubKey as string }]);
    assert.equal(found.outputs.reduce((sum, o) => sum + o.sats, 0), 1_000);
    yield* store.listName("two@space", 1_000);
    const second = yield* store.request({ handle: "two@space", script_pubkey: "5120" + "2".padStart(64, "0") });
    const invoice = yield* store.quote(second.token); assert(invoice.address);
    let pending = yield* buyer.call("sendtoaddress", invoice.address, "0.00001000");
    assert.equal((yield* store.order(second.token)).detected_sats, 1_000);
    const replacement = object(yield* buyer.call("bumpfee", pending, { fee_rate: 50 }));
    pending = hex(replacement.txid);
    assert.equal((yield* store.order(second.token)).detected_sats, 1_000);
    const entry = object(yield* node.call("getmempoolentry", pending));
    yield* node.call("generateblock", minerAddress, []); yield* node.call("generateblock", minerAddress, []);
    const before = object(yield* node.call("getblockchaininfo"));
    mockTime = integer(entry.time) + 600; yield* node.call("setmocktime", mockTime);
    yield* Effect.promise(stop); yield* Effect.promise(() => start());
    for (const name of wallets) {
      const loaded = yield* node.call("listwallets"); assert(Array.isArray(loaded));
      if (!loaded.includes(name)) yield* node.call("loadwallet", name);
    }
    yield* Effect.promise(() => until(async () => { assert.equal(object(await run(node.call("getmempoolinfo"))).loaded, true); }));
    const reloaded = object(yield* node.call("getmempoolentry", pending));
    assert.equal(integer(reloaded.time), integer(entry.time));
    assert.equal(integer(reloaded.height), integer(before.blocks));
    assert(integer(reloaded.height) > integer(entry.height), "entry height is reconstructed at reload");
    assert.equal((yield* store.order(second.token)).detected_sats, 1_000);
    yield* Effect.promise(stop); yield* Effect.promise(() => start(false));
    for (const name of wallets) {
      const loaded = yield* node.call("listwallets"); assert(Array.isArray(loaded));
      if (!loaded.includes(name)) yield* node.call("loadwallet", name);
    }
    yield* Effect.promise(() => until(async () => { assert.equal(object(await run(node.call("getmempoolinfo"))).loaded, true); }));
    now = 901;
    view = yield* store.order(second.token);
    assert.equal(view.detected_sats, 0); assert.equal(view.payment_history, "detected");
    yield* node.call("generatetoaddress", 7, minerAddress);
    view = yield* store.order(second.token); assert.equal(view.status, "unpaid"); assert.equal(view.confirmed_sats, 0);
    // This records Core's actual evidence; it does not adopt a hold-recovery rule.
    const files = ["ts/src/bitcoin/rpc.ts", "ts/src/bitcoin/core.ts", "ts/src/bitcoin/validation.ts",
      "ts/src/application/store.ts", "ts/src/application/sales.ts", "ts/src/application/records.ts", "ts/regtest/core.test.ts"];
    writeFileSync(join(root, "qualification.json"), JSON.stringify({ network: "regtest", core: "31.2.0", run: name,
      files: Object.fromEntries(files.map(path => [path, createHash("sha256").update(readFileSync(join(repository, path))).digest("hex")])),
      checks: ["payment", "conversion", "reorg", "spent-receipt", "descriptor-recovery-without-address-book",
        "replacement", "mempool-entry-time-preserved", "mempool-entry-height-reconstructed", "missing-mempool-without-rebroadcast"] }, null, 2), { mode: 0o600 });
    t.diagnostic(`Core 31.2 passed; retained artifacts: regtest/.run/${name}`);
  })));
  await stop();
});
