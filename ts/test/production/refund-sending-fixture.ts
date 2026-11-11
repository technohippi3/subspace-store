import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Effect } from "effect";
import { ApplicationError } from "../../src/application/records.ts";
import type { SalesStore } from "../../src/application/store.ts";
import type { PreparedRefund, RefundAdapters, RefundFacts } from "../../src/refunds/types.ts";
import { fixture, invoice, payment, setup } from "./application-fixture.ts";

export const tipHash = "d".repeat(64);
export const paymentId = "1".repeat(64) + ":0";
export function sendingFixture(t: TestContext, budget = 1_000_000) {
  const f = fixture(t, budget), observations = new Map<string, RefundFacts>(), sent: PreparedRefund[] = [];
  const state = { loseReply: false, failure: false, builds: 0, failRead: false, mismatch: false,
    beforePermission: null as (() => void) | null, afterPermission: null as (() => void) | null };
  f.adapters.snapshot = () => Effect.succeed({ tip: f.node.tip, tipHash, outputs: structuredClone(f.node.outputs) });
  const adapters: RefundAdapters = {
    resolveAddress: address => Effect.succeed({ address, script: "0014" + "f".repeat(40) }),
    estimateRate: () => Effect.succeed(2000),
    build: request => Effect.sync(() => {
      const coin = request.orderCoins.find(c => !request.forbiddenInputs.includes(c.outpoint)); assert(coin);
      const change = coin.sats - request.group.charged, toBuyer = request.group.charged - 200;
      return { txid: (++state.builds).toString(16).padStart(64, "a"), raw: "00", vbytes: 100,
        fee: 200, buyerFee: 200, merchantFee: 0, toBuyer, inputs: [{ ...coin, owner: "order" }],
        outputs: [{ ...request.destination, sats: toBuyer, role: "buyer" },
          ...(change ? [{ address: "change", script: "0014" + "e".repeat(40), sats: change, role: "order_change" as const }] : [])] };
    }),
    sender: {
      observe: transactions => Effect.gen(function* () {
        if (state.failRead) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "refund lookup failed" }));
        return { tip: f.node.tip, tipHash: state.mismatch ? "e".repeat(64) : tipHash,
          transactions: transactions.map(tx => structuredClone(observations.get(tx.txid) ?? { txid: tx.txid, seen: "absent",
            confirmations: 0, blockHash: null, inputsAvailable: true, conflicts: [] })) };
      }),
      broadcast: (transaction, permission) => Effect.gen(function* () {
        state.beforePermission?.();
        if (!(yield* permission)) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "journal unavailable" }));
        state.afterPermission?.();
        const db = new DatabaseSync(f.config.database, { readOnly: true });
        try {
          assert.equal(db.prepare("select count(*) as n from outbox where acknowledged=0").get()!.n, 0);
          const row = db.prepare("select value from records where kind='refund_send'").get(); assert(row);
          assert.equal((JSON.parse(row.value as string) as { result: string }).result, "uncertain");
        } finally { db.close(); }
        sent.push(structuredClone(transaction));
        if (!state.failure) observations.set(transaction.txid, { txid: transaction.txid, seen: "mempool", confirmations: 0,
          blockHash: null, inputsAvailable: false, conflicts: [] });
        if (state.loseReply || state.failure) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "send outcome unknown" }));
      }),
    },
  };
  f.adapters.refunds = adapters;
  return { ...f, observations, sent, senderState: state };
}
export async function settledRefund(store: SalesStore, f: ReturnType<typeof sendingFixture>, excess = false) {
  return Effect.runPromise(Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store);
    f.node.outputs = [{ ...payment(1, excess ? 13_000 : 10_000, 6), outpoint: paymentId }];
    yield* store.setRefundDestination(one.token, "buyer-refund");
    if (!excess) yield* store.cancel(one.token);
    const group = yield* store.prepareRefund("o1", excess ? "excess" : "cancellation", "buyer");
    return { ...one, group };
  }));
}
