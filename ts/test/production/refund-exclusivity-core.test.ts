import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { CoreRefundWallet } from "../../src/bitcoin/refunds.ts";
import { verifyReplacement } from "../../src/bitcoin/exclusivity.ts";
import { BitcoinRpc } from "../../src/bitcoin/rpc.ts";
import type { PreparedRefund, RebuildRequest, Replacement } from "../../src/refunds/types.ts";
import { nodeFixture, block, hash } from "./core-fixture.ts";

const run = <A, E>(work: Effect.Effect<A, E>) => Effect.runPromise(work);
const oldId = "1".repeat(64), inputId = "2".repeat(64), conflictId = "3".repeat(64), unknown = "4".repeat(64);
const oldScript = "0014" + "1".repeat(40), returnScript = "0014" + "2".repeat(40);
async function fixture(t: TestContext) {
  const f = await nodeFixture(t); f.state.conf = 6;
  const old: PreparedRefund = { txid: oldId, raw: "aa", vbytes: 100, fee: 200, buyerFee: 200, merchantFee: 0, toBuyer: 9800,
    inputs: [{ outpoint: inputId + ":0", script: oldScript, sats: 13_000, owner: "order" }],
    outputs: [{ address: "buyer", script: "0014" + "f".repeat(40), sats: 9800, role: "buyer" },
      { address: "change", script: "0014" + "e".repeat(40), sats: 3000, role: "order_change" }] };
  const state = { owned: true, unspent: true, mixed: false, depth: 6, wrongBytes: false, shared: false, conflictInput: inputId };
  f.state.mutate = call => {
    switch (call.method) {
      case "gettxout": return call.params[0] === unknown ? { result: null } : call.params[0] === inputId ? state.shared ? { result: { bestblock: hash, confirmations: 10, value: 0.00013, scriptPubKey: { hex: oldScript } } } : { result: null } :
        state.unspent ? { result: { bestblock: hash, confirmations: 6, value: 0.00012, scriptPubKey: { hex: returnScript } } } : { result: null };
      case "gettransaction": return { result: { txid: conflictId, hex: "cc", confirmations: state.depth, blockhash: block,
        decoded: { txid: conflictId, vin: [{ txid: state.conflictInput, vout: 0 }, ...(state.mixed ? [{ txid: unknown, vout: 0 }] : [])],
          vout: [{ n: 0, value: 0.00012, scriptPubKey: { hex: returnScript, address: "owned-return" } }] } } };
      case "getaddressinfo": return { result: { ismine: state.owned, scriptPubKey: returnScript } };
      case "decoderawtransaction": return call.params[0] === "aa" ? { result: { txid: oldId, vin: old.inputs.map(i => ({ txid: i.outpoint.split(":")[0], vout: Number(i.outpoint.split(":")[1]) })) } } :
        { result: { txid: conflictId, vin: [{ txid: state.wrongBytes ? unknown : state.conflictInput, vout: 0 }] } };
      default: return undefined;
    }
  };
  const request: RebuildRequest = { members: [old], orderCoins: [{ outpoint: inputId + ":0", script: oldScript, sats: 13_000 }],
    forbiddenInputs: [], conflicts: [conflictId], tip: 100, tipHash: hash };
  return { ...f, state, old, request, wallet: await run(CoreRefundWallet.make(f.coreConfig)), node: new BitcoinRpc(f.config) };
}
test("Z39: Core binds exclusive rebuild funding to a settled conflicting ancestor's actual inputs", async (t) => {
  const f = await fixture(t), funding = await run(f.wallet.rebuildFunding(f.request));
  assert.equal(funding.requiredInputs[0]!.outpoint, conflictId + ":0");
  assert.equal(funding.proofs[0]!.via!.txid, conflictId);
  const r: Replacement = { ...funding, members: [f.old], minimumFee: 0 };
  await run(verifyReplacement(f.node, r));
  f.state.wrongBytes = true;
  await assert.rejects(run(verifyReplacement(f.node, r)), /ancestor inputs differ/);
  assert.equal(f.calls.some(c => ["signrawtransactionwithwallet", "sendrawtransaction", "getnewaddress"].includes(c.method)), false);
});
test("Z40: spent, unowned, mixed-ownership or immature conflict outputs never become arbitrary refund funding", async (t) => {
  const f = await fixture(t);
  for (const mode of ["spent", "unowned", "mixed", "unsettled"]) {
    f.state.unspent = mode !== "spent"; f.state.owned = mode !== "unowned"; f.state.mixed = mode === "mixed";
    f.state.depth = mode === "unsettled" ? 5 : 6;
    await assert.rejects(run(f.wallet.rebuildFunding(f.request)), /exclusively funded|no longer settled/);
  }
});
test("Z41: Core can prove a rebuild from a surviving shared input while retaining explicit conflict evidence", async (t) => {
  const f = await fixture(t); f.state.shared = true; f.state.unspent = false;
  const extra = { outpoint: unknown + ":0", script: oldScript, sats: 1000, owner: "merchant" as const };
  f.old.inputs.push(extra); f.old.outputs.push({ address: "merchant", script: "0014" + "d".repeat(40), sats: 1000, role: "merchant_change" });
  f.state.conflictInput = unknown;
  const funding = await run(f.wallet.rebuildFunding(f.request));
  assert.equal(funding.requiredInputs.length, 1); assert.equal(funding.requiredInputs[0]!.outpoint, inputId + ":0");
  assert.equal(funding.proofs[0]!.via, null);
  await run(verifyReplacement(f.node, { ...funding, members: [f.old], minimumFee: 0 }));
});
