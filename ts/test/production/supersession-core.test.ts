import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { rpcFixture } from "./core-fixture.ts";
import { conflictVerifier } from "../../src/bitcoin/supersession.ts";
import type { SupersessionCheck } from "../../src/application/supersession-records.ts";

test("O74: Core verifies both exact transactions and the settled checkpoint without signing and treats RPC failure as unknown", async (t) => {
  const root = "f".repeat(64), original = "a".repeat(64), conflict = "c".repeat(64), delegate = "d".repeat(64) + ":0";
  const tip = "e".repeat(64), checkpoint = "9".repeat(64), block = "b".repeat(64);
  const state = { oldDelegate: "d".repeat(64), oldRoot: root, oldId: original, conflictDelegate: "d".repeat(64),
    confirmations: 21, checkpoint: true, failure: false };
  const rpc = await rpcFixture(t, call => {
    if (state.failure) return { code: -28 };
    switch (call.method) {
      case "getblockchaininfo": return { result: { chain: "regtest", blocks: 100, headers: 100, initialblockdownload: false, bestblockhash: tip } };
      case "getblockhash": return { result: state.checkpoint ? checkpoint : "8".repeat(64) };
      case "decoderawtransaction": return { result: { txid: state.oldId, vin: [{ txid: state.oldDelegate, vout: 0 }],
        vout: [{ scriptPubKey: { hex: "6a20" + state.oldRoot } }] } };
      case "getblockheader": return { result: { hash: block, height: 80, confirmations: state.confirmations } };
      case "getrawtransaction": assert.deepEqual(call.params, [conflict, true, block]);
        return { result: { txid: conflict, blockhash: block, vin: [{ txid: state.conflictDelegate, vout: 0 }] } };
      default: throw Error("unexpected mutation/RPC");
    }
  });
  const verify = await Effect.runPromise(conflictVerifier({ ...rpc.config, network: "regtest", wallet: "merchant" }));
  const check: SupersessionCheck = { entry: "1".repeat(32), root, delegate, tipHash: tip,
    proof: { version: 1, entry: "1".repeat(32), revision: 1, txid: original, originalRaw: "00", conflictTxid: conflict,
      blockHash: block, height: 80, tipHeight: 90, tipHash: checkpoint, active: true } };
  assert.equal(await Effect.runPromise(verify(check)), true);
  for (const key of ["oldDelegate", "oldRoot", "oldId"] as const) {
    const saved = state[key]; state[key] = "7".repeat(64);
    assert.equal((await Effect.runPromise(Effect.result(verify(check))))._tag, "Failure"); state[key] = saved;
  }
  state.conflictDelegate = "7".repeat(64); assert.equal(await Effect.runPromise(verify(check)), false); state.conflictDelegate = "d".repeat(64);
  state.checkpoint = false; assert.equal(await Effect.runPromise(verify(check)), false); state.checkpoint = true;
  state.confirmations = 5; assert.equal(await Effect.runPromise(verify(check)), false);
  state.failure = true; assert.equal((await Effect.runPromise(Effect.result(verify(check))))._tag, "Failure");
  assert.equal(rpc.calls.some(c => /send|sign|fund|import|createwallet/.test(c.method)), false);
});
