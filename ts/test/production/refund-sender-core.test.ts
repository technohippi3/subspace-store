import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { CoreRefundSender } from "../../src/bitcoin/refund-sender.ts";
import type { PreparedRefund } from "../../src/refunds/types.ts";
import { nodeFixture, type Call, type Reply, block, hash } from "./core-fixture.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const id = "1".repeat(64), inputId = "2".repeat(64), conflictId = "3".repeat(64), script = "0014" + "1".repeat(40);
const tip = { tip: 100, tipHash: hash };
async function fixture(t: TestContext) {
  const f = await nodeFixture(t), tx: PreparedRefund = { txid: id, raw: "00", vbytes: 100, fee: 200, buyerFee: 200, merchantFee: 0, toBuyer: 9800,
    inputs: [{ outpoint: `${inputId}:0`, script, sats: 10_000, owner: "order" }],
    outputs: [{ address: "buyer", script: "0014" + "f".repeat(40), sats: 9800, role: "buyer" }] };
  const decoded = { txid: id, vsize: 100, locktime: 0, vin: [{ txid: inputId, vout: 0, sequence: 0xffff_fffd }],
    vout: [{ n: 0, value: 0.000098, scriptPubKey: { hex: tx.outputs[0]!.script } }] };
  const state = { depth: 0, pool: false, known: false, conflict: false, conflictDepth: 6, sends: 0,
    override: null as ((call: Call) => Reply | undefined) | null };
  f.state.mutate = call => {
    const changed = state.override?.(call); if (changed) return changed;
    switch (call.method) {
      case "listsinceblock": return { result: { lastblock: f.state.hash,
        transactions: [...(state.known ? [{ txid: id }] : []), ...(state.conflict ? [{ txid: conflictId }] : [])] } };
      case "gettransaction":
        if (call.params[0] === conflictId && state.conflict) return { result: { txid: conflictId, confirmations: state.conflictDepth, blockhash: block,
          decoded: { txid: conflictId, vin: [{ txid: inputId, vout: 0 }] } } };
        return state.known ? { result: { txid: id, confirmations: state.depth, blockhash: block, decoded } } : { code: -5 };
      case "getmempoolentry": return state.pool ? { result: { time: 1, height: 100 } } : { code: -5 };
      case "gettxout": return state.pool || state.depth > 0 || state.conflict ? { result: null } :
        { result: { bestblock: hash, confirmations: 10, value: 0.0001, scriptPubKey: { hex: script } } };
      case "decoderawtransaction": return { result: decoded };
      case "sendrawtransaction": state.sends++; state.known = true; state.pool = true; return { result: id };
      default: return undefined;
    }
  };
  const sender = await run(CoreRefundSender.make(f.coreConfig));
  return { ...f, sender, tx, state, nodeState: f.state };
}
test("Z30: Core observes absent, mempool, confirmed and settled-conflict refunds from complete wallet history", async (t) => {
  const f = await fixture(t);
  let facts = (await run(f.sender.observe([f.tx]))).transactions[0]!;
  assert.equal(facts.seen, "absent"); assert.equal(facts.inputsAvailable, true);
  await run(f.sender.broadcast(f.tx, Effect.succeed(true), tip));
  facts = (await run(f.sender.observe([f.tx]))).transactions[0]!; assert.equal(facts.seen, "mempool");
  f.state.pool = false; f.state.depth = 6; f.nodeState.conf = 6;
  facts = (await run(f.sender.observe([f.tx]))).transactions[0]!; assert.equal(facts.confirmations, 6);
  f.state.known = false; f.state.depth = 0; f.state.conflict = true;
  facts = (await run(f.sender.observe([f.tx]))).transactions[0]!;
  assert.equal(facts.seen, "absent"); assert.equal(facts.inputsAvailable, false);
  assert.deepEqual(facts.conflicts, [{ txid: conflictId, confirmations: 6, mempool: false }]);
  assert.equal(f.calls.some(c => c.method === "listtransactions" || c.method === "getrawtransaction"), false);
});
test("Z31: Core validates signed bytes and evaluates the live journal permission immediately before sending", async (t) => {
  const f = await fixture(t); let permitted = 0;
  await assert.rejects(run(f.sender.broadcast(f.tx, Effect.sync(() => { permitted++; return false; }), tip)), /journal/);
  assert.equal(f.state.sends, 0); assert.equal(permitted, 1);
  const before = f.calls.length;
  await run(f.sender.broadcast(f.tx, Effect.sync(() => {
    assert.equal(f.calls.at(-1)!.method, "getwalletinfo"); return true;
  }), tip));
  assert.deepEqual(f.calls.slice(before).map(c => c.method).slice(-2), ["getwalletinfo", "sendrawtransaction"]);
  f.state.override = call => call.method === "decoderawtransaction" ? { result: {} } : undefined;
  await assert.rejects(run(f.sender.broadcast(f.tx, Effect.succeed(true), tip)), /signed bytes/); assert.equal(f.state.sends, 1);
  f.state.override = null;
  await assert.rejects(run(f.sender.broadcast(f.tx, Effect.succeed(true), { ...tip, tipHash: "e".repeat(64) })), /tip changed/);
  let checks = 0;
  f.state.override = call => {
    if (call.method === "getblockchaininfo" && ++checks === 2) { f.nodeState.hash = "e".repeat(64); f.nodeState.walletTip = f.nodeState.hash; }
    return undefined;
  };
  await assert.rejects(run(f.sender.broadcast(f.tx, Effect.succeed(true), tip)), /tip changed/); assert.equal(f.state.sends, 1);
});
test("Z32: Core lookup failures, incomplete history and malformed spends fail closed", async (t) => {
  const f = await fixture(t);
  for (const method of ["gettransaction", "getmempoolentry", "gettxout", "listsinceblock"]) {
    f.state.known = true;
    f.state.override = call => call.method === method ? { code: -28 } : undefined;
    await assert.rejects(run(f.sender.observe([f.tx])), /failed/);
  }
  f.state.override = call => call.method === "gettransaction" ? { result: { txid: id, confirmations: 0, decoded: { txid: id, vin: [{}] } } } : undefined;
  await assert.rejects(run(f.sender.observe([f.tx])));
  f.state.known = false; f.state.override = call => call.method === "gettransaction" ? { code: -18 } : undefined;
  await assert.rejects(run(f.sender.observe([f.tx])), /failed/);
});
test("Z33: changing relevant wallet history retries bounded full refund reads", async (t) => {
  const f = await fixture(t); let history = 0;
  f.state.override = call => call.method === "listsinceblock" ? { result: { lastblock: hash, transactions: ++history % 2 ? [] : [{ txid: id }] } } : undefined;
  await assert.rejects(run(f.sender.observe([f.tx])), /changed during/); assert.equal(history, 6);
  let observations = 0; f.state.override = call => {
    if (call.method === "gettxout") return { result: ++observations % 2 ? { bestblock: hash, confirmations: 10, value: 0.0001, scriptPubKey: { hex: script } } : null };
    return undefined;
  };
  await assert.rejects(run(f.sender.observe([f.tx])), /changed during/); assert.equal(observations, 6);
});
