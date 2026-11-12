import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { Effect, Exit, Scope } from "effect";
import { BitcoinRpc } from "../src/bitcoin/rpc.ts";
import { CoreAdapter } from "../src/bitcoin/core.ts";
import { CoreRefundWallet } from "../src/bitcoin/refunds.ts";
import { CoreRefundSender } from "../src/bitcoin/refund-sender.ts";
import { ApplicationError } from "../src/application/records.ts";
import { DatabaseSync } from "node:sqlite";
import { refundPolicy } from "../test/production/application-fixture.ts";
import { SalesStore } from "../src/application/store.ts";
import { serveOperator } from "../src/application/operator-http.ts";
import { servePending } from "../src/application/pending-http.ts";
import { object, hex, integer } from "../src/bitcoin/validation.ts";
import { entryLifecycle, entryLifecycleRestart } from "./entry-lifecycle.ts";
import { commitmentLifecycle, commitmentRestart } from "./commitments.ts";
import { certificateLifecycle, certificateRestart } from "./certificates.ts";
import { qualification } from "./qualification.ts";
import { fulfillmentLifecycle, fulfillmentRestart } from "./fulfillment.ts";
import { runtimeQualification } from "./runtime.ts";

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
  assert.match(execFileSync(binary, ["-conf=/dev/null", "-version"], { encoding: "utf8" }).split("\n")[0]!, /v31\.2\.0/);
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
      child = spawn(binary, ["-conf=/dev/null", `-datadir=${data}`, "-regtest", "-server", "-listen=0", "-connect=0", "-dnsseed=0",
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
  const refunds = await run(CoreRefundWallet.make({ ...config, wallet: "merchant", network: "regtest" }));
  const sender = await run(CoreRefundSender.make({ ...config, wallet: "merchant", network: "regtest" }));
  const feePool = await run(core.newDestination());
  await run(miner.call("sendtoaddress", feePool.address, "0.00010000"));
  await run(node.call("generatetoaddress", 6, minerAddress));
  let now = 0;
  const journalDirectory = join(root, "journal"); mkdirSync(journalDirectory);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let loseRefundReply = true, refundSends = 0, feeEstimateOverride: number | null = null;
    const open = () => SalesStore.open({ database: join(root, "store.db"), journalDirectory, riskBudgetSats: 100_000, refundPolicy, merchantDestinations: [feePool] },
      { clock: () => now, snapshot: destinations => core.snapshot(destinations), newDestination: core.newDestination(),
        certificateChain: checkpoint => core.containsBlock(checkpoint),
        refunds: { resolveAddress: address => refunds.resolveAddress(address), estimateRate: target => feeEstimateOverride === null ? refunds.estimateRate(target) : Effect.succeed(feeEstimateOverride),
          build: request => refunds.build(request), rebuildFunding: request => refunds.rebuildFunding(request), assessExcess: request => refunds.assessExcess(request),
          sender: { observe: transactions => sender.observe(transactions), broadcast: (tx, permission, expectedTip, replacement) => Effect.gen(function* () {
            yield* sender.broadcast(tx, permission, expectedTip, replacement); refundSends++;
            if (loseRefundReply) { loseRefundReply = false; return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "simulated lost send reply" })); }
          }) } } });
    const parentScope = yield* Effect.scope;
    let lifetime = yield* Scope.fork(parentScope), store = yield* Scope.provide(lifetime)(open());
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
    const inspectionScope = yield* Scope.fork(parentScope), credential = "mock-operator-qualification".padEnd(48, "x");
    const operator = yield* Scope.provide(inspectionScope)(serveOperator(store, Effect.succeed(credential)));
    yield* Effect.promise(async () => {
      const options = { headers: { Authorization: `Bearer ${credential}` } };
      const observed = await fetch(operator.url + "/operator/observe", { ...options, method: "POST" }); assert.equal(observed.status, 200);
      const response = await fetch(operator.url + "/operator/orders?status=converted", options); assert.equal(response.status, 200);
      const data = object(await response.json()); assert(Array.isArray(data.orders));
      assert.deepEqual(data.orders, ["o1"]);
      const row = object(await (await fetch(operator.url + "/operator/orders/o1", options)).json());
      assert.equal(row.oid, "o1"); assert.equal(row.journaled_status, "converted");
      assert.equal(row.batchable_sum, 1000); assert.equal(JSON.stringify(data).includes(order.token), false);
    });
    yield* Scope.close(inspectionScope, Exit.void);
    yield* node.call("invalidateblock", blocks[0]);
    view = yield* store.order(order.token); assert.equal(view.confirmed_sats, 0); assert.equal(view.status, "converted");
    assert.deepEqual(view.reconciling, ["issuance"]);
    yield* node.call("generateblock", minerAddress, []); yield* node.call("generateblock", minerAddress, []);
    yield* node.call("generatetoaddress", 3, minerAddress);
    view = yield* store.order(order.token); assert.equal(view.confirmed_sats, 1_000); assert.deepEqual(view.reconciling, []);
    const received = object(yield* merchant.call("gettransaction", txid, true, true));
    const decoded = object(received.decoded), vout = decoded.vout as { n: number; scriptPubKey: { address?: string } }[];
    const paid = vout.find(out => out.scriptPubKey.address === quote.address); assert(paid);
    const invoiceDestination = yield* refunds.resolveAddress(quote.address!);
    assert.equal(typeof txid, "string"); assert.equal(typeof buyerAddress, "string");
    const feeTemplate = { inputs: [{ outpoint: `${txid}:${paid.n}`, script: invoiceDestination.script, sats: 1000 }],
      outputs: [yield* refunds.resolveAddress(buyerAddress as string)], rate: 2001 };
    const walletBeforeEstimate = yield* merchant.call("getwalletinfo"), coinsBeforeEstimate = yield* merchant.call("listunspent");
    const locksBeforeEstimate = yield* merchant.call("listlockunspent");
    const estimated = yield* refunds.estimateFee(feeTemplate);
    assert.equal(estimated.fee, Math.ceil(estimated.vbytes * feeTemplate.rate / 1000));
    assert.deepEqual(yield* merchant.call("getwalletinfo"), walletBeforeEstimate);
    assert.deepEqual(yield* merchant.call("listunspent"), coinsBeforeEstimate);
    assert.deepEqual(yield* merchant.call("listlockunspent"), locksBeforeEstimate);
    const spend = yield* node.call("createrawtransaction", [{ txid, vout: paid.n }], [{ [buyerAddress as string]: "0.00000330" }]);
    const signed = object(yield* merchant.call("signrawtransactionwithwallet", spend)); assert.equal(signed.complete, true);
    const measuredSpend = object(yield* node.call("decoderawtransaction", signed.hex));
    assert(estimated.vbytes >= integer(measuredSpend.vsize)); assert(estimated.vbytes <= integer(measuredSpend.vsize) + 1);
    yield* node.call("sendrawtransaction", signed.hex); yield* node.call("generatetoaddress", 1, minerAddress);
    assert.equal(yield* node.call("gettxout", txid, paid.n), null);
    assert.equal((yield* store.order(order.token)).confirmed_sats, 1_000, "spent receipts are still receipts");
    const historicalEstimate = yield* refunds.estimateFee(feeTemplate);
    assert.equal(historicalEstimate.vbytes, estimated.vbytes, "spent wallet receipts remain measurable without new signing");
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
    // The application sends through its journal gate, with a lost first reply.
    yield* store.listName("refund@space", 10_000);
    const refundable = yield* store.request({ handle: "refund@space", script_pubkey: "5120" + "3".padStart(64, "0") });
    const refundInvoice = yield* store.quote(refundable.token); assert(refundInvoice.address);
    yield* buyer.call("sendtoaddress", refundInvoice.address, "0.00013000");
    yield* node.call("generatetoaddress", 6, minerAddress); yield* store.observe();
    assert.equal(typeof buyerAddress, "string");
    const feeCoins = yield* merchant.call("listunspent", 6); assert(Array.isArray(feeCoins));
    const feeLocks = feeCoins.map(object).filter(c => c.scriptPubKey === feePool.script).map(c => ({ txid: c.txid, vout: c.vout }));
    assert(feeLocks.length > 0); yield* merchant.call("lockunspent", false, feeLocks);
    const walletBeforeAdmission = yield* merchant.call("getwalletinfo");
    yield* store.setRefundDestination(refundable.token, buyerAddress as string);
    const admitted = yield* store.order(refundable.token), excessDue = admitted.refund_deadlines;
    assert.equal(excessDue.length, 1); assert.equal(excessDue[0]!.principal_sats, 3000); assert.equal(excessDue[0]!.started_at, 0);
    assert.equal(admitted.excess_assessment?.status, "eligible");
    assert(admitted.excess_assessment!.estimated_fee_sats! > admitted.buyer_refund_fee_ceiling_sats!);
    assert.deepEqual(yield* merchant.call("getwalletinfo"), walletBeforeAdmission);
    assert.deepEqual(yield* merchant.call("listlockunspent"), feeLocks);
    yield* merchant.call("lockunspent", true, feeLocks);
    const excess = yield* store.prepareRefund("o2", "excess", "buyer");
    assert.equal(excess.phase, "built"); assert.equal(excess.acknowledged, true); assert.equal(excess.charged_sats, 3000);
    assert.equal(excess.buyer_fee_sats, 200); assert(excess.merchant_fee_sats! > 0);
    const firstPool = yield* node.call("getrawmempool"); assert(Array.isArray(firstPool)); assert(!firstPool.includes(excess.txid));
    assert.equal((yield* store.broadcastRefund(excess.id)).status, "mempool");
    const oldDb = new DatabaseSync(join(root, "store.db"), { readOnly: true });
    const oldRow = oldDb.prepare("select value from records where kind='refund_group' and key=?").get(excess.id); oldDb.close(); assert(oldRow);
    const originalRefund = JSON.parse(oldRow.value as string) as { transaction: { raw: string } };
    const bumped = yield* store.bumpRefund(excess.id, 6000, undefined, true);
    assert.notEqual(bumped.txid, excess.txid); assert.equal(bumped.to_buyer_sats, excess.to_buyer_sats);
    assert.equal((yield* store.broadcastRefund(excess.id)).status, "mempool");
    const bumpedPool = yield* node.call("getrawmempool"); assert(Array.isArray(bumpedPool));
    assert(bumpedPool.includes(bumped.txid)); assert(!bumpedPool.includes(excess.txid));
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parentScope); store = yield* Scope.provide(lifetime)(open());
    assert.deepEqual(yield* store.reconcileRefunds(), []); assert.equal(refundSends, 2);
    const settledBlocks = yield* node.call("generatetoaddress", 6, minerAddress); assert(Array.isArray(settledBlocks));
    assert.equal((yield* store.order(refundable.token)).refunded_sats, 3000);
    yield* node.call("invalidateblock", settledBlocks.at(-1));
    assert.equal((yield* store.order(refundable.token)).reserved_refund_sats, 3000);
    yield* node.call("reconsiderblock", settledBlocks.at(-1));
    assert.equal((yield* store.order(refundable.token)).refunded_sats, 3000);
    yield* node.call("invalidateblock", settledBlocks[0]);
    for (let i = 0; i < 7; i++) yield* node.call("generateblock", minerAddress, []);
    const reopened = yield* store.order(refundable.token);
    assert.equal(reopened.refunded_sats, 0); assert.equal(reopened.reserved_refund_sats, 3000);
    yield* store.reconcileRefunds(); assert.equal(refundSends, 2);
    // Either signed member can win after a deep reorg. Mine the original,
    // which conflicts with the higher-fee member currently in the mempool.
    yield* node.call("generateblock", minerAddress, [originalRefund.transaction.raw]);
    yield* node.call("generatetoaddress", 5, minerAddress);
    assert.equal((yield* store.order(refundable.token)).refunded_sats, 3000);
    assert.equal((yield* store.order(refundable.token)).refund_groups[0]!.settled_txid, excess.txid);
    {
      now = 20;
      yield* store.cancel(refundable.token);
      const due = (yield* store.order(refundable.token)).refund_deadlines;
      assert.equal(due.length, 2); assert.equal(due[0]!.remaining_sats, 0);
      assert.equal(due[1]!.started_at, 20); assert.equal(due[1]!.remaining_sats, 10_000);
      const cancellation = yield* store.prepareRefund("o2", "cancellation", "buyer");
      assert.equal(cancellation.phase, "built"); assert.equal(cancellation.charged_sats, 10_000);
      const db = new DatabaseSync(join(root, "store.db"), { readOnly: true });
      const row = db.prepare("select value from records where kind='refund_group' and key=?").get(cancellation.id); db.close(); assert(row);
      const saved = JSON.parse(row.value as string) as { transaction: { raw: string } };
      const decodedRefund = object(yield* node.call("decoderawtransaction", saved.transaction.raw));
      assert(Array.isArray(decodedRefund.vin));
      assert(decodedRefund.vin.some(v => object(v).txid === excess.txid), "later refund uses proven order change");
      now = 21;
      yield* store.broadcastRefund(cancellation.id); yield* node.call("generatetoaddress", 6, minerAddress);
      const final = yield* store.order(refundable.token); assert.equal(final.refundable_sats, 0);
      assert.equal(final.refunded_sats, 13_000); assert.equal(final.reserved_refund_sats, 0); assert.equal(refundSends, 3);
      assert.equal(final.refund_deadlines[1]!.broadcast_at, 21); assert.equal(final.refund_deadlines[1]!.remaining_sats, 0);
      assert.equal(final.refund_deadlines[1]!.incident, false);
    }
    // A new obligation is rebuilt through a settled conflicting ancestor.
    yield* store.listName("rebuild@space", 1000);
    const recoverable = yield* store.request({ handle: "rebuild@space", script_pubkey: "5120" + "4".padStart(64, "0") });
    const recoverInvoice = yield* store.quote(recoverable.token); assert(recoverInvoice.address);
    const recoverPayment = yield* buyer.call("sendtoaddress", recoverInvoice.address, "0.00030000");
    yield* node.call("generatetoaddress", 6, minerAddress); yield* store.cancel(recoverable.token);
    yield* store.setRefundDestination(recoverable.token, buyerAddress as string);
    feeEstimateOverride = 1000; // Explicit regtest rate, giving a one-input refund.
    const recovery = yield* store.prepareRefund("o3", "cancellation", "buyer");
    const recoveryDb = new DatabaseSync(join(root, "store.db"), { readOnly: true });
    const recoveryRow = recoveryDb.prepare("select value from records where kind='refund_group' and key=?").get(recovery.id); recoveryDb.close(); assert(recoveryRow);
    const oldRecovery = JSON.parse(recoveryRow.value as string) as { transaction: { raw: string; inputs: { outpoint: string }[] } };
    assert.equal(oldRecovery.transaction.inputs.length, 1);
    const [sourceId, sourceIndex] = oldRecovery.transaction.inputs[0]!.outpoint.split(":"); assert.equal(sourceId, recoverPayment);
    const returnAddress = yield* merchant.call("getrawchangeaddress", "bech32m");
    const conflictRaw = yield* node.call("createrawtransaction", [{ txid: sourceId, vout: Number(sourceIndex) }], [{ [returnAddress as string]: "0.00029000" }]);
    const conflictSigned = object(yield* merchant.call("signrawtransactionwithwallet", conflictRaw)); assert.equal(conflictSigned.complete, true);
    const conflictId = yield* node.call("sendrawtransaction", conflictSigned.hex);
    const conflictBlocks = yield* node.call("generatetoaddress", 6, minerAddress); assert(Array.isArray(conflictBlocks));
    assert.equal((yield* store.order(recoverable.token)).refund_groups[0]!.status, "needs_rebuild");
    const rebuilt = yield* store.rebuildRefund(recovery.id, 1000, 28_000); assert.notEqual(rebuilt.txid, recovery.txid);
    assert.equal(rebuilt.charged_sats, 30_000); assert.equal(rebuilt.attempts[1]!.charged_sats, 28_000);
    const rebuiltDb = new DatabaseSync(join(root, "store.db"), { readOnly: true });
    const attemptRow = rebuiltDb.prepare("select value from records where kind='refund_attempt' and key=?").get(rebuilt.attempts[1]!.id); rebuiltDb.close(); assert(attemptRow);
    const attemptData = JSON.parse(attemptRow.value as string) as { transaction: { inputs: { outpoint: string }[] } };
    assert(attemptData.transaction.inputs.some(i => i.outpoint.startsWith(String(conflictId) + ":")));
    yield* store.broadcastRefund(recovery.id); yield* node.call("generatetoaddress", 6, minerAddress);
    assert.equal((yield* store.order(recoverable.token)).refunded_sats, 28_000);
    yield* node.call("invalidateblock", conflictBlocks[0]);
    yield* node.call("generateblock", minerAddress, [oldRecovery.transaction.raw]); yield* node.call("generatetoaddress", 5, minerAddress);
    const recoveredRefund = yield* store.order(recoverable.token);
    assert.equal(recoveredRefund.refunded_sats, 30_000); assert.equal(recoveredRefund.reserved_refund_sats, 0);
    assert.equal(recoveredRefund.refund_groups[0]!.settled_txid, recovery.txid);
    feeEstimateOverride = null;
    // K21: returning a partial payment closes that checkout. Late money
    // remains attributable to it and cannot qualify a replacement checkout.
    yield* store.listName("partial@space", 10_000);
    const old = yield* store.request({ handle: "partial@space", script_pubkey: "5120" + "6".padStart(64, "0") });
    const oldInvoice = yield* store.quote(old.token); assert(oldInvoice.address);
    yield* buyer.call("sendtoaddress", oldInvoice.address, "0.00006000"); yield* node.call("generatetoaddress", 6, minerAddress);
    assert.equal((yield* store.setRefundDestination(old.token, buyerAddress as string)).status, "quoted");
    yield* Effect.promise(() => assert.rejects(run(store.prepareRefund("o4", "excess", "buyer")), /cancel/));
    yield* store.cancel(old.token); const partialRefund = yield* store.prepareRefund("o4", "cancellation", "buyer");
    yield* store.broadcastRefund(partialRefund.id); yield* node.call("generatetoaddress", 6, minerAddress);
    assert.equal((yield* store.order(old.token)).refunded_sats, 6000);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parentScope); store = yield* Scope.provide(lifetime)(open());
    const fresh = yield* store.request({ handle: "partial@space", script_pubkey: "5120" + "6".padStart(64, "0") });
    const freshInvoice = yield* store.quote(fresh.token); assert(freshInvoice.address); assert.notEqual(freshInvoice.address, oldInvoice.address);
    yield* buyer.call("sendtoaddress", oldInvoice.address, "0.00010000"); yield* node.call("generatetoaddress", 6, minerAddress);
    const late = yield* store.order(old.token); assert.equal(late.status, "cancelled"); assert.equal(late.refundable_sats, 10_000);
    assert.equal((yield* store.order(fresh.token)).confirmed_sats, 0);
    yield* buyer.call("sendtoaddress", freshInvoice.address, "0.00010000");
    const entryBlocks = yield* node.call("generatetoaddress", 3, minerAddress); assert(Array.isArray(entryBlocks));
    assert.equal((yield* store.order(fresh.token)).status, "converted"); assert.equal((yield* store.order(old.token)).status, "cancelled");
    const entryScope = yield* Scope.fork(parentScope);
    const entryOperator = yield* Scope.provide(entryScope)(serveOperator(store, Effect.succeed(credential)));
    const subsCredential = "mock-subs-entry-qualification".padEnd(48, "y");
    const pendingServer = yield* Scope.provide(entryScope)(servePending(store, Effect.succeed(subsCredential)));
    yield* Effect.promise(async () => {
      const options = { method: "POST", headers: { Authorization: `Bearer ${credential}` }, body: '{"oids":["o1","o5"]}' };
      const frozen = await fetch(entryOperator.url + "/operator/pending", options); assert.equal(frozen.status, 200);
      assert.equal(object(await frozen.json()).acknowledged, true);
      const pending = await fetch(pendingServer.url + "/pending?space=%40space", { headers: { Authorization: `Bearer ${subsCredential}` } });
      const handles = object(await pending.json()).handles; assert(Array.isArray(handles));
      assert.deepEqual(handles.map(h => object(h).handle), ["one@space", "partial@space"]);
      const bound = { entry: "b".repeat(32), root: "c".repeat(64), oids: ["o1", "o5"] };
      const marked = await fetch(entryOperator.url + "/operator/issuance-entries", { ...options, body: JSON.stringify(bound) }); assert.equal(marked.status, 200);
      const receipt = object(await marked.json()); assert.equal(receipt.acknowledged, true); assert.deepEqual(receipt.oids, ["o1", "o5"]);
      const repeated = await fetch(entryOperator.url + "/operator/issuance-entries", { ...options, body: JSON.stringify(bound) });
      assert.deepEqual(await repeated.json(), receipt);
      const mismatch = await fetch(entryOperator.url + "/operator/issuance-entries/lookup", { ...options, body: JSON.stringify({ ...bound, root: "d".repeat(64) }) });
      assert.equal(mismatch.status, 409);
    });
    yield* Effect.promise(() => assert.rejects(run(store.cancel(fresh.token)), /once issuing/));
    assert.equal((yield* store.registry.entry("o5")).issuing_recheck, true);
    yield* node.call("invalidateblock", entryBlocks[0]);
    assert.equal((yield* store.registry.entry("o5")).issuing_recheck, false);
    assert.equal((yield* store.order(fresh.token)).status, "issuing");
    yield* node.call("reconsiderblock", entryBlocks[0]);
    assert.equal((yield* store.registry.entry("o5")).issuing_recheck, true);
    yield* store.registry.setPending([]); yield* Scope.close(entryScope, Exit.void);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parentScope); store = yield* Scope.provide(lifetime)(open());
    const restoredEntry = yield* store.registry.entries.find({ entry: "b".repeat(32), root: "c".repeat(64), oids: ["o1", "o5"] });
    assert.equal(restoredEntry.found, true); if (restoredEntry.found) assert.equal(restoredEntry.acknowledged, true);
    yield* entryLifecycle(store);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parentScope); store = yield* Scope.provide(lifetime)(open());
    yield* entryLifecycleRestart(store);
    yield* commitmentLifecycle(store, node, minerAddress as string);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parentScope); store = yield* Scope.provide(lifetime)(open());
    yield* commitmentRestart(store);
    yield* certificateLifecycle(store, node, minerAddress as string, order.token);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parentScope); store = yield* Scope.provide(lifetime)(open());
    yield* certificateRestart(store, order.token);
    yield* fulfillmentLifecycle(store, node, order.token);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parentScope); store = yield* Scope.provide(lifetime)(open());
    yield* fulfillmentRestart(store, order.token);
    yield* Effect.promise(() => runtimeQualification(repository, root, config, buyer, node, minerAddress as string, freePort));
    yield* store.listName("two@space", 1_000);
    const second = yield* store.request({ handle: "two@space", script_pubkey: "5120" + "2".padStart(64, "0") });
    const invoice = yield* store.quote(second.token); assert(invoice.address);
    let pending = yield* buyer.call("sendtoaddress", invoice.address, "0.00001000");
    assert.equal((yield* store.order(second.token)).detected_sats, 1_000);
    const replacement = object(yield* buyer.call("bumpfee", pending, { fee_rate: 50 }));
    pending = hex(replacement.txid);
    // The sender's bumpfee reply can precede the receiving wallet's mempool
    // notification. Establish discovery before asserting its replacement view.
    yield* Effect.promise(() => until(async () => {
      assert.equal(object(await run(merchant.call("gettransaction", pending))).txid, pending);
    }));
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
    now += 901;
    view = yield* store.order(second.token);
    assert.equal(view.detected_sats, 0); assert.equal(view.payment_history, "detected");
    yield* node.call("generatetoaddress", 7, minerAddress);
    view = yield* store.order(second.token); assert.equal(view.status, "unpaid"); assert.equal(view.confirmed_sats, 0);
    // This records Core's actual evidence; it does not adopt a hold-recovery rule.
    qualification(repository, root, name);
    t.diagnostic(`Core 31.2 passed; retained artifacts: regtest/.run/${name}`);
  })));
  await stop();
});
