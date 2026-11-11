import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Effect } from "effect";
import { ApplicationError } from "../../src/application/records.ts";
import type { BuildRequest, Coin, PreparedRefund, RebuildFunding, RefundAdapters } from "../../src/refunds/types.ts";
import { sendingFixture, tipHash } from "./refund-sending-fixture.ts";

export const feeCoin: Coin = { outpoint: "f".repeat(64) + ":0", script: "0014" + "c".repeat(40), sats: 100_000, owner: "merchant" };
export function familyFixture(t: TestContext) {
  const f = sendingFixture(t), original = f.adapters.refunds!, sent = f.sent;
  const control = { failBuild: false, requests: [] as BuildRequest[], rebuild: null as RebuildFunding | null, failFunding: true };
  const adapters: RefundAdapters = {
    ...original,
    build: request => Effect.gen(function* () {
      const db = new DatabaseSync(f.config.database, { readOnly: true });
      try { assert.equal(db.prepare("select count(*) as n from outbox where acknowledged=0").get()!.n, 0); } finally { db.close(); }
      control.requests.push(structuredClone(request));
      if (control.failBuild) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "signer interrupted" }));
      const coins = structuredClone(request.replacement?.requiredInputs ?? []);
      let own = coins.filter(c => c.owner === "order").reduce((sum, c) => sum + c.sats, 0);
      for (const c of request.orderCoins) {
        if (own >= request.group.charged && (own === request.group.charged || own - request.group.charged >= 546)) break;
        if (coins.some(v => v.outpoint === c.outpoint) || request.forbiddenInputs.includes(c.outpoint)) continue;
        coins.push({ ...c, owner: "order" }); own += c.sats;
      }
      assert(own >= request.group.charged);
      const fee = Math.ceil(request.group.rate / 10), buyerFee = Math.min(fee, request.group.policy.buyerFeeCeiling), merchantFee = fee - buyerFee;
      if (merchantFee && !coins.some(c => c.owner === "merchant")) coins.push({ ...feeCoin });
      const merchant = coins.filter(c => c.owner === "merchant").reduce((sum, c) => sum + c.sats, 0);
      const draw = ++f.senderState.builds, change = own - request.group.charged;
      const outputs: PreparedRefund["outputs"] = [{ ...request.destination, sats: request.group.charged - buyerFee, role: "buyer" }];
      if (change) outputs.push({ address: `change-${draw}`, script: "0014" + draw.toString(16).padStart(40, "1"), sats: change, role: "order_change" });
      if (merchant > merchantFee) outputs.push({ address: `fees-${draw}`, script: "0014" + draw.toString(16).padStart(40, "2"), sats: merchant - merchantFee, role: "merchant_change" });
      return { txid: draw.toString(16).padStart(64, "a"), raw: "ab" + draw.toString(16).padStart(2, "0"), vbytes: 100,
        inputs: coins, outputs, fee, buyerFee, merchantFee, toBuyer: request.group.charged - buyerFee };
    }),
    rebuildFunding: () => control.failFunding ? Effect.fail(new ApplicationError({ code: "refused", message: "no exclusively funded rebuild is available" })) :
      Effect.succeed(structuredClone(control.rebuild!)),
    sender: {
      observe: transactions => original.sender!.observe(transactions).pipe(Effect.map(snapshot => ({ ...snapshot,
        transactions: snapshot.transactions.map(facts => {
          if (f.observations.has(facts.txid)) return facts;
          const tx = transactions.find(t => t.txid === facts.txid)!;
          const conflicts = transactions.flatMap(peer => {
            const p = f.observations.get(peer.txid);
            return peer.txid !== tx.txid && p && p.seen !== "absent" && peer.inputs.some(c => tx.inputs.some(i => i.outpoint === c.outpoint)) ?
              [{ txid: peer.txid, confirmations: p.confirmations, mempool: p.seen === "mempool" }] : [];
          });
          return { ...facts, inputsAvailable: !conflicts.length, chainInputsAvailable: !conflicts.some(c => c.confirmations > 0), conflicts };
        }) }))),
      broadcast: (tx, permission) => Effect.gen(function* () {
        if (!(yield* permission)) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "journal unavailable" }));
        sent.push(structuredClone(tx));
        for (const [id, facts] of f.observations) if (facts.seen === "mempool") f.observations.delete(id);
        f.observations.set(tx.txid, { txid: tx.txid, seen: "mempool", confirmations: 0, blockHash: null, inputsAvailable: false, chainInputsAvailable: true, conflicts: [] });
      }),
    },
  };
  f.adapters.refunds = adapters;
  return { ...f, control, config: { ...f.config, merchantDestinations: [{ address: "fees", script: feeCoin.script }] } };
}
export function mine(f: ReturnType<typeof familyFixture>, txid: string, confirmations = 6): void {
  f.observations.clear(); f.observations.set(txid, { txid, seen: "mined", confirmations, blockHash: tipHash,
    inputsAvailable: false, chainInputsAvailable: false, conflicts: [] });
}
