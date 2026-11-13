import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { CoreRefundWallet } from "../../src/bitcoin/refunds.ts";
import type { RefundFeeTemplate } from "../../src/refunds/types.ts";
import { nodeFixture, type Call, type Reply } from "./core-fixture.ts";

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
const id = "1".repeat(64), script = "5120" + "2".repeat(64), outScript = "5120" + "3".repeat(64);
async function fixture(t: TestContext) {
  const f = await nodeFixture(t);
  const template: RefundFeeTemplate = { inputs: [{ outpoint: `${id}:0`, script, sats: 10000 }],
    outputs: [{ address: "buyer", script: outScript }], rate: 2001 };
  const data = { tx: { locktime: 0, vin: [{ txid: id, vout: 0, sequence: 0xffff_fffd }],
    vout: [{ n: 0, value: 0.00000001, scriptPubKey: { hex: outScript } }] },
    inputs: [{ witness_utxo: { amount: 0.00010000, scriptPubKey: { hex: script } } }] };
  const state = { mutate: null as ((call: Call) => Reply | undefined) | null };
  f.state.mutate = call => {
    const changed = state.mutate?.(call); if (changed) return changed;
    switch (call.method) {
      case "validateaddress": return { result: { isvalid: true, scriptPubKey: outScript } };
      case "createpsbt": return { result: "cHNidP8BAA==" };
      case "walletprocesspsbt": return { result: { psbt: call.params[0], complete: false } };
      case "decodepsbt": return { result: structuredClone(data) };
      case "analyzepsbt": return { result: { inputs: [{ has_utxo: true, is_final: false }], estimated_vsize: 111, next: "signer" } };
      default: return undefined;
    }
  };
  const wallet = await run(CoreRefundWallet.make(f.coreConfig));
  return { ...f, wallet, template, data, control: state };
}
test("Z48: unsigned Core size assessment rounds the fee and calls no signing, funding or address-allocation RPC", async (t) => {
  const f = await fixture(t), result = await run(f.wallet.estimateFee(f.template));
  assert.deepEqual(result, { vbytes: 111, fee: 223, tip: f.state.height, tipHash: f.state.hash });
  assert.deepEqual(f.calls.find(c => c.method === "walletprocesspsbt")!.params, ["cHNidP8BAA==", false, null, true, false]);
  assert.equal(f.calls.find(c => c.method === "walletprocesspsbt")!.path, "/wallet/merchant");
  assert.deepEqual(f.calls.find(c => c.method === "createpsbt")!.params,
    [[{ txid: id, vout: 0, sequence: 0xffff_fffd }], [{ buyer: "0.00000001" }], 0, true]);
  const allowed = new Set(["getnetworkinfo", "getblockchaininfo", "getmempoolinfo", "getwalletinfo", "validateaddress",
    "createpsbt", "walletprocesspsbt", "decodepsbt", "analyzepsbt"]);
  assert.equal(f.calls.filter(c => !allowed.has(c.method)).length, 0);
  assert.deepEqual(Object.keys(result).sort(), ["fee", "tip", "tipHash", "vbytes"]);
});
test("Z49: invalid templates refuse before Core and changed transaction/UTXO/signature metadata refuses", async (t) => {
  const f = await fixture(t);
  for (const change of [
    (r: RefundFeeTemplate) => { r.inputs = []; },
    (r: RefundFeeTemplate) => { r.inputs = [...r.inputs, ...r.inputs]; },
    (r: RefundFeeTemplate) => { r.outputs = [...r.outputs, ...r.outputs]; },
    (r: RefundFeeTemplate) => { r.rate = 0; },
  ]) {
    const r = structuredClone(f.template); change(r); const calls = f.calls.length;
    await assert.rejects(run(f.wallet.estimateFee(r))); assert.equal(f.calls.length, calls);
  }
  for (const mode of ["input", "script", "amount", "output", "signature", "final", "missing", "size", "overflow", "address", "tip", "rpc"]) {
    let ready = 0;
    f.control.mutate = call => {
      if (call.method === "decodepsbt") {
        const d = structuredClone(f.data);
        if (mode === "input") d.tx.vin[0]!.vout = 1;
        if (mode === "script") d.inputs[0]!.witness_utxo.scriptPubKey.hex = outScript;
        if (mode === "amount") d.inputs[0]!.witness_utxo.amount = 0.00020000;
        if (mode === "output") d.tx.vout[0]!.value = 0.00000002;
        if (mode === "signature") Object.assign(d.inputs[0]!, { taproot_key_path_sig: "aa" });
        return { result: d };
      }
      if (call.method === "walletprocesspsbt" && mode === "final") return { result: { complete: true, hex: "aa", psbt: call.params[0] } };
      if (call.method === "analyzepsbt" && mode === "missing") return { result: { inputs: [{ has_utxo: false, is_final: false }], next: "updater" } };
      if (call.method === "analyzepsbt" && mode === "size") return { result: { inputs: [{ has_utxo: true, is_final: false }], estimated_vsize: 0 } };
      if (call.method === "analyzepsbt" && mode === "overflow") return { result: { inputs: [{ has_utxo: true, is_final: false }], estimated_vsize: 100001 } };
      if (call.method === "validateaddress" && mode === "address") return { result: { isvalid: true, scriptPubKey: script } };
      if (call.method === "getblockchaininfo" && mode === "tip" && ++ready === 2) { f.state.hash = "e".repeat(64); f.state.walletTip = f.state.hash; }
      if (call.method === "walletprocesspsbt" && mode === "rpc") return { code: -28 };
      return undefined;
    };
    await assert.rejects(run(f.wallet.estimateFee(f.template)), /./, mode);
  }
});
test("Z48: legacy parent metadata must name the actual transaction and output", async (t) => {
  const f = await fixture(t);
  const parent = { txid: id, vout: [{ n: 0, value: 0.0001, scriptPubKey: { hex: script } }] };
  f.control.mutate = call => call.method === "decodepsbt" ? { result: { tx: f.data.tx, inputs: [{ non_witness_utxo: parent }] } } : undefined;
  assert.equal((await run(f.wallet.estimateFee(f.template))).fee, 223);
  parent.txid = "2".repeat(64); await assert.rejects(run(f.wallet.estimateFee(f.template)), /missing estimate input data/);
});
