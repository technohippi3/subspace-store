import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Effect, type Scope } from "effect";
import { SalesStore } from "../../src/application/store.ts";
import { ApplicationError, type Output } from "../../src/application/records.ts";
import { FileJournal } from "../../src/storage/journal.ts";
import type { Entry } from "../../src/storage/codec.ts";

export const script = "5120" + "1".padStart(64, "0");
export class Journal extends FileJournal {
  down = false;
  override append(value: Entry): undefined {
    if (this.down) throw Error("simulated journal outage");
    return super.append(value);
  }
  override read() {
    if (this.down) throw Error("simulated journal outage");
    return super.read();
  }
}
export function fixture(t: TestContext, budget = 1_000_000) {
  const root = mkdtempSync(join(tmpdir(), "sales-application-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "journal"); mkdirSync(directory);
  const journal = new Journal(directory);
  const node = { now: 0, tip: 10, outputs: [] as Output[], draws: 0, observations: 0,
    beforeDestination: null as (() => Promise<void>) | null };
  const adapters = { clock: () => node.now,
    snapshot: Effect.sync(() => { node.observations++; return { tip: node.tip, outputs: structuredClone(node.outputs) }; }),
    newDestination: Effect.tryPromise({ try: async () => {
      const index = ++node.draws;
      await node.beforeDestination?.();
      return { address: `mock-address-${index}`, script: "0014" + index.toString(16).padStart(40, "0") };
    }, catch: () => new ApplicationError({ code: "unavailable", message: "wallet unavailable" }) }) };
  const config = { database: join(root, "store.db"), journalDirectory: directory,
    riskBudgetSats: budget, makeJournal: () => journal };
  return { root, node, journal, adapters, config };
}
export type Fixture = ReturnType<typeof fixture>;
export function use<A, E>(f: Fixture, work: (store: SalesStore) => Effect.Effect<A, E, Scope.Scope>) {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* SalesStore.open(f.config, f.adapters);
    return yield* work(store);
  })));
}
export function setup(store: SalesStore, count = 20) {
  return Effect.gen(function* () {
    for (let i = 0; i < count; i++) yield* store.listName(`n${i}@space`, 1_000);
    yield* store.pause(false);
  });
}
export function invoice(store: SalesStore, index = 0) {
  return Effect.gen(function* () {
    const link = yield* store.request({ handle: `n${index}@space`, script_pubkey: script });
    const quote = yield* store.quote(link.token);
    return { ...link, quote };
  });
}
export function payment(index: number, sats = 1_000, confirmations = 3): Output {
  return { outpoint: `mock-outpoint-${index}`, script: "0014" + index.toString(16).padStart(40, "0"), sats, confirmations };
}
export function fullHolds(store: SalesStore) {
  return Effect.gen(function* () { for (let i = 0; i < 10; i++) yield* invoice(store, i); });
}
