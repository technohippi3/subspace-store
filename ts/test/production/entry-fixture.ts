import { Effect } from "effect";
import { fixture, invoice, payment, setup } from "./application-fixture.ts";
import type { SalesStore } from "../../src/application/store.ts";

export const entry = { entry: "1".repeat(32), root: "a".repeat(64), oids: ["o1", "o2"] };
export function paidPair(store: SalesStore, f: ReturnType<typeof fixture>) {
  return Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store);
    const two = yield* store.request({ handle: "n1@space", script_pubkey: "5120" + "2".padStart(64, "0") });
    yield* store.quote(two.token); f.node.outputs = [payment(1), payment(2)]; yield* store.observe();
    return [one.token, two.token];
  });
}
