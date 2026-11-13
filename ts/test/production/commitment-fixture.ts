import { Effect } from "effect";
import type { TestContext } from "node:test";
import type { SalesStore } from "../../src/application/store.ts";
import { fixture } from "./application-fixture.ts";
import { entry, paidPair } from "./entry-fixture.ts";

export const armed = { ...entry, delegate: "d".repeat(64) + ":0" };
export function commitmentFixture(t: TestContext) {
  const f = fixture(t), chain = { hash: "b".repeat(64) };
  f.adapters.snapshot = () => Effect.sync(() => ({ tip: f.node.tip, tipHash: chain.hash, outputs: structuredClone(f.node.outputs) }));
  const facts = (minedHeight: number | null = null, rootHeight: number | null = minedHeight, anchorHeight: number | null = null) => ({
    txid: "a".repeat(64), tipHeight: f.node.tip, tipHash: chain.hash, minedHeight, rootHeight, anchorHeight });
  const prepare = (store: SalesStore) => Effect.gen(function* () {
    const tokens = yield* paidPair(store, f); yield* store.registry.entries.enter(entry);
    yield* store.registry.entries.arm(armed); return tokens;
  });
  return { ...f, chain, facts, prepare };
}
