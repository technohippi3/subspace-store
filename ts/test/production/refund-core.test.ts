import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { CoreRefundWallet } from "../../src/bitcoin/refunds.ts";
import type { BuildRequest } from "../../src/refunds/types.ts";
import { nodeFixture, type Call, type Reply } from "./core-fixture.ts";
import { refundPolicy } from "./application-fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const script = (n: number) => "5120" + n.toString(16).padStart(64, "0");
const txid = (n: number) => n.toString(16).padStart(64, "0");
async function fixture(t: TestContext) {
  const f = await nodeFixture(t);
  const request: BuildRequest = { group: { id: "g-00000000-0000-4000-8000-000000000001", order: "o1", kind: "excess", cause: "buyer",
    charged: 3000, createdAt: 1, rate: 2000, policy: refundPolicy, phase: "reserved", transaction: null },
    destination: { address: "buyer", script: script(1) }, orderCoins: [{ outpoint: `${txid(1)}:0`, script: script(2), sats: 13_000 }],
    merchantScripts: [script(3)], forbiddenInputs: [], forbiddenScripts: [script(2), script(3)] };
  const coins = [{ txid: txid(1), vout: 0, scriptPubKey: script(2), amount: 0.00013, confirmations: 6, spendable: true, safe: true },
    { txid: txid(2), vout: 0, scriptPubKey: script(3), amount: 0.00001, confirmations: 6, spendable: true, safe: true },
    { txid: txid(3), vout: 0, scriptPubKey: script(99), amount: 1, confirmations: 6, spendable: true, safe: true }];
  let index = 10;
  const state = { mutate: null as ((call: Call) => Reply | undefined) | null, estimate: 0.00002 };
  const addressScript = (address: string) => address === "buyer" ? script(1) : script(Number(address.split("-").at(-1)));
  f.state.mutate = call => {
    const changed = state.mutate?.(call); if (changed) return changed;
    switch (call.method) {
      case "validateaddress": return { result: { isvalid: true, scriptPubKey: addressScript(call.params[0] as string) } };
      case "estimatesmartfee": return { result: { blocks: 6, feerate: state.estimate } };
      case "getrawchangeaddress": return { result: `change-${++index}` };
      case "getaddressinfo": return { result: { ismine: true, scriptPubKey: addressScript(call.params[0] as string) } };
      case "listunspent": return { result: coins };
      case "createrawtransaction": {
        const outputs = call.params[1] as { [key: string]: string }[];
        const decoded = { txid: txid(10), vsize: 140, locktime: 0, vin: call.params[0],
          vout: outputs.map((out, n) => { const [address, amount] = Object.entries(out)[0]!; return { n, value: Number(amount), scriptPubKey: { hex: addressScript(address) } }; }) };
        return { result: Buffer.from(JSON.stringify(decoded)).toString("hex") };
      }
      case "signrawtransactionwithwallet": return { result: { hex: call.params[0], complete: true } };
      case "decoderawtransaction": return { result: JSON.parse(Buffer.from(call.params[0] as string, "hex").toString()) as unknown };
      case "testmempoolaccept": return { result: [{ txid: txid(10), allowed: true }] };
      case "gettxout": { const c = coins.find(c => c.txid === call.params[0] && c.vout === call.params[1]);
        return { result: c ? { confirmations: c.confirmations, value: c.amount, scriptPubKey: { hex: c.scriptPubKey } } : null }; }
      default: return undefined;
    }
  };
  const wallet = await run(CoreRefundWallet.make(f.coreConfig));
  return { ...f, request, coins, wallet, state, nodeState: f.state };
}
test("Z23: Core builds explicit funding with exact fee allocation, separate change and no send RPC", async (t) => {
  const f = await fixture(t), tx = await run(f.wallet.build(f.request));
  assert.equal(tx.fee, 280); assert.equal(tx.buyerFee, 200); assert.equal(tx.merchantFee, 80); assert.equal(tx.toBuyer, 2800);
  assert.deepEqual(tx.inputs.map(c => c.outpoint), [`${txid(1)}:0`, `${txid(2)}:0`]);
  assert.deepEqual(tx.outputs.map(o => [o.role, o.sats]), [["buyer", 2800], ["order_change", 10_000], ["merchant_change", 920]]);
  assert.equal(f.calls.some(c => ["sendrawtransaction", "sendtoaddress", "fundrawtransaction", "walletcreatefundedpsbt"].includes(c.method)), false);
  assert.equal(await run(f.wallet.estimateRate(6)), 2000);
  f.state.mutate = call => call.method === "estimatesmartfee" ? { result: { blocks: -1, errors: ["no estimate"] } } : undefined;
  assert.equal(await run(f.wallet.estimateRate(6)), null);
  f.state.mutate = call => call.method === "estimatesmartfee" ? { code: -28 } : undefined;
  await assert.rejects(run(f.wallet.estimateRate(6)), /failed/);
});
test("K14: a merchant-caused refund preserves full principal and refuses missing fee funding", async (t) => {
  const f = await fixture(t); f.request.group.cause = "merchant";
  const tx = await run(f.wallet.build(f.request)); assert.equal(tx.toBuyer, 3000); assert.equal(tx.merchantFee, 280); assert.equal(tx.buyerFee, 0);
  f.coins.splice(1, 1);
  await assert.rejects(run(f.wallet.build(f.request)), /insufficient settled funding/);
});
test("Z24: unsettled, unsafe, reserved or unrelated funding cannot replace an order's coins", async (t) => {
  const f = await fixture(t);
  for (const mode of ["spent", "unsafe", "unsettled", "reserved", "script", "amount", "dust", "fee-cap"]) {
    const r = structuredClone(f.request), original = structuredClone(f.coins);
    switch (mode) {
      case "spent": f.coins.splice(0, 1); break;
      case "unsafe": f.coins[0]!.safe = false; break;
      case "unsettled": f.coins[0]!.confirmations = 5; break;
      case "reserved": r.forbiddenInputs = [r.orderCoins[0]!.outpoint]; break;
      case "script": f.coins[0]!.scriptPubKey = script(98); break;
      case "amount": f.coins[0]!.amount = 0.00014; break;
      case "dust": r.group.charged = 12_500; break;
      case "fee-cap": r.group.policy.maximumFee = 100; break;
    }
    await assert.rejects(run(f.wallet.build(r)), /./, mode); f.coins.splice(0, f.coins.length, ...original);
  }
});
test("Z25: partial signing, changed outputs, spend races and failed acceptance refuse signed export", async (t) => {
  const f = await fixture(t);
  for (const mode of ["sign", "decode", "accept", "spent", "tip"]) {
    let ready = 0;
    f.state.mutate = call => {
      if (mode === "sign" && call.method === "signrawtransactionwithwallet") return { result: { complete: false, hex: call.params[0] } };
      if (mode === "decode" && call.method === "decoderawtransaction") {
        const d = JSON.parse(Buffer.from(call.params[0] as string, "hex").toString()) as { vout: { value: number }[] };
        d.vout[0]!.value += 0.00000001; return { result: d };
      }
      if (mode === "accept" && call.method === "testmempoolaccept") return { result: [{ txid: txid(10), allowed: false }] };
      if (mode === "spent" && call.method === "gettxout") return { result: null };
      if (mode === "tip" && call.method === "getblockchaininfo" && ++ready === 4) { f.nodeState.hash = "d".repeat(64); f.nodeState.walletTip = f.nodeState.hash; }
      return undefined;
    };
    await assert.rejects(run(f.wallet.build(f.request)), /./, mode);
  }
});
